import { CatalogPreviewLaunchAuthority } from '../work-orchestration/runtime-preview/runner'
import { bytesFingerprint, previewFingerprint } from '../work-orchestration/preview-profile'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { rmSync, readFileSync, writeFileSync, watch, symlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { GitService } from '../core/git-service'
import { cleanupTempRepo, commit, createTempGitRepo, gitExec, stageAll, writeFile } from '../core/git-test-helpers'
import { GitWorktreeRegistry } from './git-worktree-registry'
import { GitBranchInventory } from './git-branch-inventory'
import { GitOperationsService } from './git-operations-service'
import { GitHubGitTransport } from '../github/github-git-transport'

vi.mock('node:fs', async original => { const actual = await original<typeof import('node:fs')>(); return { ...actual, watch: vi.fn(actual.watch) } })

describe('branch inventory with real Git', () => {
  let root = ''
  const git = new GitService()
  afterEach(async () => { if (root) await cleanupTempRepo(root) })
  async function setup() {
    root = await createTempGitRepo()
    await gitExec(root, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    writeFile(root, 'a', 'inherited')
    await stageAll(root); await commit(root, 'inherited')
    const identity = { repositoryId: 'fixture', isActive: () => true }
    const registry = new GitWorktreeRegistry(root, git, identity)
    return new GitBranchInventory(root, git, registry, identity)
  }
  it('verifies only the launch target and refuses ref recreation, HEAD drift and changed checkout selection', async () => {
    await setup()
    await gitExec(root, ['branch', 'preview-target'])
    const path = join(root, 'preview'); await gitExec(root, ['worktree', 'add', path, 'preview-target'])
    const service = new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'fixture', isActive: () => true })
    const inventory = await service.getBranchInventory(), branch = inventory.branches.find(value => value.name === 'preview-target')!
    const tree = inventory.worktrees.find(value => value.path === path)!
    const expected = { worktreeId: tree.worktreeId, generation: tree.generation, path, ref: branch.ref, branchGeneration: branch.generation, head: branch.head }
    await expect(service.verifyRuntimePreviewTarget(expected)).resolves.toBeUndefined()
    writeFile(path, '.gitignore', 'generated/\n.code-awareness/\n')
    writeFile(path, 'generated/index.db', 'derived')
    const ignored = await service.classifyRuntimePreviewChanges(tree.worktreeId, ['generated/index.db', '.gitignore'])
    expect([...ignored]).toEqual(['generated/index.db'])
    await expect(service.classifyRuntimePreviewChanges(tree.worktreeId, ['../outside'])).rejects.toThrow('PREVIEW_CHANGE_COVERAGE_UNVERIFIABLE')
    await expect(service.verifyRuntimePreviewTarget({ ...expected, generation: 'replaced' })).rejects.toThrow('WORKTREE_STALE')
    await expect(service.verifyRuntimePreviewTarget({ ...expected, path: root })).rejects.toThrow('WORKTREE_STALE')
    let invalidated = false
    let dispose = await service.watchRuntimePreviewTarget(expected, () => { invalidated = true })
    try {
      await expect(dispose.assertCurrent()).resolves.toBeUndefined()
      writeFile(path, '.gitignore', 'changed/\n')
      await expect(dispose.assertCurrent()).rejects.toThrow('PREPARED_GIT_METADATA_CHANGED')
      dispose.close()
      writeFile(path, '.gitignore', 'generated/\n.code-awareness/\n')
      dispose = await service.watchRuntimePreviewTarget(expected, () => { invalidated = true })
      await expect(dispose.assertCurrent()).resolves.toBeUndefined()
      const admin = await git.getWorktreeDirectory(path), indexFile = join(admin, 'index'), originalIndex = readFileSync(indexFile)
      const semantic = await git.getRuntimePreviewIndexRevision(path), refreshed = Buffer.from(originalIndex)
      refreshed.writeUInt32BE((refreshed.readUInt32BE(24) + 1) >>> 0, 24)
      createHash('sha1').update(refreshed.subarray(0, -20)).digest().copy(refreshed, refreshed.length - 20)
      writeFileSync(indexFile, refreshed)
      await vi.waitFor(() => expect(dispose.state).toBe('SUSPECT'))
      expect(await git.getRuntimePreviewIndexRevision(path)).toBe(semantic)
      await expect(dispose.assertCurrent()).resolves.toBeUndefined()
      expect(dispose.state).toBe('CURRENT')
      writeFile(path, '.code-awareness/tracked.txt', 'tracked')
      await gitExec(path, ['add', '--force', '.code-awareness/tracked.txt'])
      await expect(dispose.assertCurrent()).rejects.toThrow('PREPARED_INDEX_ENTRIES_CHANGED')
      await gitExec(path, ['reset', '--', '.code-awareness/tracked.txt'])
      dispose.close()
      dispose = await service.watchRuntimePreviewTarget(expected, () => { invalidated = true })
      invalidated = false
      await gitExec(path, ['update-ref', '-d', branch.ref]); await gitExec(path, ['update-ref', branch.ref, branch.head])
      await vi.waitFor(() => expect(invalidated).toBe(true))
      await expect(dispose.assertCurrent()).rejects.toThrow('PREPARED_GIT_METADATA_CHANGED')
    } finally { dispose.close() }
    await expect(service.verifyRuntimePreviewTarget(expected)).rejects.toThrow('BRANCH_CHANGED')
    const updated = (await service.getBranchInventory()).branches.find(value => value.ref === branch.ref)!
    await gitExec(path, ['commit', '--allow-empty', '-m', 'drift'])
    await expect(service.verifyRuntimePreviewTarget({ ...expected, branchGeneration: updated.generation })).rejects.toThrow('WORKTREE_STALE')
    await gitExec(path, ['switch', '--detach'])
    await expect(service.verifyRuntimePreviewTarget(expected)).rejects.toThrow('WORKTREE_STALE')
  }, 60000)
  it('verifies source materiality, protecting loaded ignored files and dependencies', async () => {
    await setup()
    writeFile(root, '.gitignore', '.code-awareness\nout\ncode_awareness\n.code-awareness-other/\nignored/\nnode_modules/\n')
    writeFile(root, 'ignored/loaded.js', 'loaded')
    writeFile(root, 'feature.ts', 'original source')
    writeFile(root, '.code-awareness/tracked.ts', 'tracked source')
    await gitExec(root, ['add', '-f', '.code-awareness/tracked.ts'])
    await stageAll(root); await commit(root, 'preview policy')
    const service = new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'fixture', isActive: () => true })
    const inventory = await service.getBranchInventory(), tree = inventory.worktrees.find(value => value.path === root)!
    const source = await service.getCoordinationSnapshot(tree.worktreeId)
    const profile = { profileId: 'profile', repositoryId: 'fixture', revision: 1,
      command: { inputs: [{ path: 'ignored/loaded.js', fingerprint: bytesFingerprint('loaded') }] },
      dependencies: { manifest: 'a', manifestHash: bytesFingerprint('inherited'), lockfile: 'a', lockfileHash: bytesFingerprint('inherited'), materialization: 'derived/materialization.json' },
      adapter: { artifacts: [{ component: 'ELECTRON_MAIN', path: 'a' }] } }
    const selection = { repositoryId: 'fixture', worktreeId: tree.worktreeId, generation: tree.generation, profileId: 'profile', fingerprint: previewFingerprint(profile) }
    const snapshot = { ...source.snapshot, dirty: false }
    const authority = new CatalogPreviewLaunchAuthority({ open: async () => ({ guard() {}, git: service }) } as any,
      { profiles: async () => [profile], approved: async () => true, trusted: async () => ({}) } as any,
      { check: async () => ({ status: 'SUPPORTED', snapshot }), canReuse: () => false } as any)
    const prepared = await authority.prepare(selection)
    writeFile(root, '.code-awareness/output.js', 'generated')
    await expect(prepared.verifySourceChanges!(['derived/output.js'])).resolves.toBeUndefined()
    for (const directory of ['.code-awareness', 'out', 'code_awareness']) {
      writeFile(root, directory + '/generated.txt', 'derived output')
      await expect(prepared.verifySourceChanges!([directory])).resolves.toBeUndefined()
      await expect(prepared.verifySourceChanges!([directory + '/generated.txt'])).resolves.toBeUndefined()
    }
    await expect(prepared.verifySourceChanges!(['a'])).resolves.toBeUndefined()
    await expect(prepared.verifySourceChanges!(['feature.ts'])).resolves.toBeUndefined()
    await expect(prepared.verifySourceChanges!(['.code-awareness/missing.txt'])).rejects.toMatchObject({ path: '.code-awareness/missing.txt', condition: 'DERIVED_PATH_UNVERIFIABLE', protection: 'UNKNOWN_IGNORED' })
    writeFile(root, '.code-awareness-other/generated.txt', 'not a derived namespace')
    await expect(prepared.verifySourceChanges!(['.code-awareness-other'])).rejects.toMatchObject({ path: '.code-awareness-other', condition: 'IGNORED_OUTSIDE_DERIVED_NAMESPACE' })
    for (const directory of ['.code-awareness', 'out', 'code_awareness']) {
      rmSync(join(root, directory), { recursive: true })
      writeFile(root, directory, 'an ignored file is not a derived directory')
      await expect(prepared.verifySourceChanges!([directory])).rejects.toMatchObject({ path: directory, condition: directory === '.code-awareness' ? 'SOURCE_SNAPSHOT_MISMATCH' : 'DERIVED_ROOT_NOT_DIRECTORY' })
      rmSync(join(root, directory))
      await expect(prepared.verifySourceChanges!([directory])).rejects.toMatchObject({ path: directory, condition: directory === '.code-awareness' ? 'SOURCE_SNAPSHOT_MISMATCH' : 'DERIVED_PATH_UNVERIFIABLE' })
      if (directory === 'out') {
        symlinkSync(join(root, 'ignored'), join(root, directory), 'junction')
        await expect(prepared.verifySourceChanges!([directory])).rejects.toMatchObject({ condition: 'DERIVED_ROOT_NOT_DIRECTORY' })
        rmSync(join(root, directory))
      }
      writeFile(root, directory + '/loaded.js', 'loaded executable')
      if (directory === '.code-awareness') writeFile(root, '.code-awareness/tracked.ts', 'tracked source')
      profile.adapter.artifacts.push({ component: 'ELECTRON_MAIN', path: directory + '/loaded.js' })
      await expect(prepared.verifySourceChanges!([directory])).rejects.toMatchObject({ path: directory, protection: 'LOADED_CODE' })
      await expect(prepared.verifySourceChanges!([directory + '/loaded.js'])).rejects.toMatchObject({ path: directory + '/loaded.js', condition: 'LOADED_CONTENT_NOT_REATTESTED' })
      profile.adapter.artifacts.pop()
      if (directory === 'out') {
        ;(profile.adapter as any).runtimeExecutable = 'out/loaded.js'
        await expect(prepared.verifySourceChanges!(['out'])).rejects.toMatchObject({ protection: 'LOADED_CODE' })
        await expect(prepared.verifySourceChanges!(['out/loaded.js'])).rejects.toMatchObject({ protection: 'LOADED_CODE' })
        delete (profile.adapter as any).runtimeExecutable
      }
      writeFile(root, directory + '/input.js', 'pinned')
      profile.command.inputs.push({ path: directory + '/input.js', fingerprint: bytesFingerprint('pinned') })
      await expect(prepared.verifySourceChanges!([directory])).resolves.toBeUndefined()
      writeFile(root, directory + '/input.js', 'changed')
      await expect(prepared.verifySourceChanges!([directory])).rejects.toMatchObject({ path: directory, condition: 'INPUT_DIGEST_CHANGED', protection: 'PROFILE_INPUT' })
      profile.command.inputs.pop()
    }
    await expect(prepared.verifySourceChanges!(['node_modules'])).rejects.toMatchObject({ path: 'node_modules', protection: 'DEPENDENCY' })
    writeFile(root, '.code-awareness/tracked.ts', 'changed tracked source')
    await expect(prepared.verifySourceChanges!(['.code-awareness'])).rejects.toMatchObject({ path: '.code-awareness', condition: 'SOURCE_SNAPSHOT_MISMATCH', protection: 'TRACKED_SOURCE' })
    writeFile(root, '.code-awareness/tracked.ts', 'tracked source')
    profile.adapter.artifacts.push({ component: 'ELECTRON_MAIN', path: 'feature.ts' })
    await expect(prepared.verifySourceChanges!(['feature.ts'])).resolves.toBeUndefined()
    writeFile(root, 'feature.ts', 'changed source')
    await expect(prepared.verifySourceChanges!(['feature.ts'])).rejects.toThrow('PREPARED_SOURCE_BYTES_CHANGED')
    writeFile(root, 'a', 'changed')
    await expect(prepared.verifySourceChanges!(['a'])).rejects.toThrow('PREPARED_INPUT_BYTES_CHANGED')
    writeFile(root, 'ignored/loaded.js', 'changed ignored source')
    await expect(prepared.verifySourceChanges!(['ignored/loaded.js'])).rejects.toThrow('PREPARED_INPUT_BYTES_CHANGED')
    writeFile(root, 'ignored/untracked.js', 'unknown loaded code')
    await expect(prepared.verifySourceChanges!(['ignored/untracked.js'])).rejects.toMatchObject({ message: 'PREPARED_IGNORED_SOURCE_UNVERIFIABLE', path: 'ignored/untracked.js', condition: 'IGNORED_OUTSIDE_DERIVED_NAMESPACE', protection: 'UNKNOWN_IGNORED' })
    writeFile(root, 'node_modules/dependency/index.js', 'unproved')
    await expect(prepared.verifySourceChanges!(['node_modules/dependency/index.js'])).rejects.toThrow('PREPARED_DEPENDENCY_UNVERIFIABLE')
  }, 60000)
  it.each(['lock', 'watcher error', 'watcher closed', 'hidden flags', 'event during verification'])('keeps Git proof closed on %s', async kind => {
    await setup()
    const service = new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'fixture', isActive: () => true })
    const inventory = await service.getBranchInventory(), branch = inventory.branches.find(value => value.name === 'main')!, tree = inventory.worktrees.find(value => value.path === root)!
    const expected = { worktreeId: tree.worktreeId, generation: tree.generation, path: root, ref: branch.ref, branchGeneration: branch.generation, head: branch.head }
    const observation = await service.watchRuntimePreviewTarget(expected, () => {})
    const admin = await git.getWorktreeDirectory(root)
    try {
      if (kind === 'lock') {
        writeFileSync(join(admin, 'index.lock'), '')
        await expect(observation.assertCurrent()).rejects.toThrow('PREPARED_GIT_OPERATION_IN_PROGRESS')
        rmSync(join(admin, 'index.lock'))
      } else if (kind === 'hidden flags') {
        await gitExec(root, ['update-index', '--assume-unchanged', 'a'])
        await expect(observation.assertCurrent()).rejects.toThrow('PREPARED_INDEX_HIDDEN_FLAGS')
        await gitExec(root, ['update-index', '--no-assume-unchanged', 'a'])
      } else if (kind === 'watcher closed') {
        vi.mocked(watch).mock.results.at(-1)!.value.emit('close')
        await expect(observation.assertCurrent()).rejects.toThrow('PREPARED_GIT_OBSERVER_LOST')
      } else if (kind === 'watcher error') {
        vi.mocked(watch).mock.results.at(-1)!.value.emit('error', new Error('fixture loss'))
        await expect(observation.assertCurrent()).rejects.toThrow('PREPARED_GIT_OBSERVER_LOST')
      } else {
        const index = join(admin, 'index'), bytes = readFileSync(index)
        bytes.writeUInt32BE((bytes.readUInt32BE(24) + 1) >>> 0, 24)
        createHash('sha1').update(bytes.subarray(0, -20)).digest().copy(bytes, bytes.length - 20); writeFileSync(index, bytes)
        const read = git.getRuntimePreviewIndexRevision.bind(git)
        const spy = vi.spyOn(git, 'getRuntimePreviewIndexRevision').mockImplementationOnce(async (...args) => {
          const call = (vi.mocked(watch).mock.calls as unknown as Array<[string, unknown, (event: string, path: string) => void]>).slice().reverse().find(args => String(args[0]).replaceAll('\\', '/').toLowerCase() === admin.replaceAll('\\', '/').toLowerCase())!
          ;(call[2] as any)('change', 'index')
          return read(...args)
        })
        await observation.assertCurrent()
        expect(observation.state).toBe('SUSPECT')
        spy.mockRestore()
        await vi.waitFor(async () => { await observation.assertCurrent(); expect(observation.state).toBe('CURRENT') })
      }
    } finally { observation.close() }
  }, 60000)
  it('includes branches without checkout, tracking refs and detached worktrees; invalidates drift', async () => {
    const reader = await setup()
    await gitExec(root, ['branch', 'topic'])
    await gitExec(root, ['update-ref', 'refs/remotes/origin/topic', 'HEAD'])
    await gitExec(root, ['worktree', 'add', join(root, 'checkout'), 'topic'])
    const before = await reader.inventory(), topic = before.branches.find(b => b.name === 'topic')!
    expect(topic.worktrees).toHaveLength(1)
    expect(before.branches.find(b => b.ref === 'refs/remotes/origin/topic')!.worktrees).toEqual([])
    await gitExec(join(root, 'checkout'), ['switch', '--detach'])
    const detached = await reader.inventory()
    expect(detached.branches.find(b => b.name === 'topic')!.worktrees).toEqual([])
    expect(detached.unassignedWorktrees).toHaveLength(1)
    await expect(reader.history({ ref: topic.ref, revision: topic.revision, mode: 'REACHABLE' })).rejects.toThrow('GIT_STATE_CHANGED')
    await gitExec(root, ['branch', '-m', 'topic', 'renamed'])
    expect((await reader.inventory()).branches.some(b => b.name === 'topic')).toBe(false)
    await gitExec(root, ['branch', '-D', 'renamed'])
    await gitExec(root, ['branch', 'topic'])
    expect((await reader.inventory()).branches.find(b => b.name === 'topic')!.generation).not.toBe(topic.generation)
  }, 60000)
  it('separates reachable ancestors and exclusive commits, rejects cursors after HEAD drift', async () => {
    const reader = await setup()
    await gitExec(root, ['switch', '-c', 'topic'])
    writeFile(root, 'b', 'own'); await stageAll(root); await commit(root, 'own')
    const topic = (await reader.inventory()).branches.find(b => b.name === 'topic')!
    const reachable = await reader.history({ ref: topic.ref, revision: topic.revision, mode: 'REACHABLE' })
    expect(reachable.commits.map(c => c.title)).toEqual(['own', 'inherited'])
    const exclusive = await reader.history({ ref: topic.ref, revision: topic.revision, mode: 'EXCLUSIVE', baseRef: 'refs/heads/main' })
    expect(exclusive.commits.map(c => c.title)).toEqual(['own'])
    expect(exclusive.base!.ref).toBe('refs/heads/main')
    await gitExec(root, ['switch', 'main']); await gitExec(root, ['merge', '--squash', 'topic']); await commit(root, 'squashed')
    const current = (await reader.inventory()).branches.find(b => b.name === 'topic')!
    expect((await reader.history({ ref: current.ref, revision: current.revision, mode: 'EXCLUSIVE', baseRef: 'refs/heads/main' })).commits.map(c => c.title)).toEqual(['own'])
  }, 60000)
  it('never substitutes commit timestamps for missing or expired branch creation history', async () => {
    const reader = await setup()
    await gitExec(root, ['branch', 'topic'])
    const prior = (await reader.inventory()).branches.find(b => b.name === 'topic')!
    expect(prior.creation.source).toBe('LOCAL_REFLOG')
    await gitExec(root, ['reflog', 'expire', '--expire=all', '--all'])
    const expired = (await reader.inventory()).branches.find(b => b.name === 'topic')!
    expect(expired.creation).toEqual({ at: null, source: 'UNKNOWN' })
    expect(expired.lastCommitAt).toBeTruthy()
    rmSync(join(root, '.git', 'logs', 'refs', 'heads', 'topic'))
    expect((await reader.inventory()).branches.find(b => b.name === 'topic')!.creation.at).toBeNull()
  }, 60000)
  it('records app-controlled creation and leaves history unknown after that generation is deleted', async () => {
    const reader = await setup()
    const service = new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'fixture', isActive: () => true })
    await gitExec(root, ['config', 'core.logAllRefUpdates', 'false'])
    await service.manageBranch({ action: 'CREATE', branch: 'app-topic', expectedHead: await git.getCurrentCommitHash(root) })
    const branch = (await reader.inventory()).branches.find(b => b.name === 'app-topic')!
    expect(branch.creation.source).toBe('APP_RECEIPT')
    await gitExec(root, ['branch', '-D', 'app-topic'])
    await gitExec(root, ['config', 'core.logAllRefUpdates', 'true'])
    await gitExec(root, ['branch', 'app-topic'])
    expect((await reader.inventory()).branches.find(b => b.name === 'app-topic')!.creation.source).toBe('LOCAL_REFLOG')
  }, 60000)
  it('paginates history and rejects a cursor when the explicit base changes', async () => {
    const reader = await setup()
    await gitExec(root, ['switch', '-c', 'long-topic'])
    for (let i = 0; i < 51; i++) await gitExec(root, ['commit', '--allow-empty', '-m', `work-${i}`])
    const branch = (await reader.inventory()).branches.find(b => b.name === 'long-topic')!
    const query = { ref: branch.ref, revision: branch.revision, mode: 'EXCLUSIVE' as const, baseRef: 'refs/heads/main' }
    const first = await reader.history(query)
    expect(first.commits).toHaveLength(50); expect(first.nextCursor).toBeTruthy()
    const second = await reader.history({ ...query, cursor: first.nextCursor! })
    expect(second.commits.map(c => c.title)).toEqual(['work-0']); expect(second.nextCursor).toBeNull()
    await gitExec(root, ['update-ref', 'refs/heads/main', 'HEAD~1'])
    await expect(reader.history({ ...query, cursor: first.nextCursor! })).rejects.toThrow('CURSOR_STALE')
  }, 90000)
})
