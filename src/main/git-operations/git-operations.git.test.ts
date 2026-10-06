import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { GitService } from '../core/git-service'
import { createTempGitRepo, cleanupTempRepo, gitExec, writeFile, stageAll, commit } from '../core/git-test-helpers'
import { GitHubGitTransport } from '../github/github-git-transport'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { McpLifecycle } from '../mcp/mcp-lifecycle'
import { createMcpHttpServer } from '../mcp/mcp-http-server'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import { GitOperationsService } from './git-operations-service'
import { executeGitOperationsTool, GIT_OPERATIONS_TOOLS } from './git-operations-mcp'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await cleanupTempRepo(root) })
async function fixture() {
  const root = await createTempGitRepo(); roots.push(root)
  await gitExec(root, ['config', 'core.autocrlf', 'false'])
  await gitExec(root, ['branch', '-m', 'main'])
  writeFile(root, 'file.txt', 'baseline\n'); await stageAll(root); await commit(root, 'baseline')
  const git = new GitService()
  const service = new GitOperationsService(root, git, new GitHubGitTransport(null, git))
  return { root, git, service }
}

describe('project-scoped Git operations with real Git', () => {
  it('sets current-branch upstream through receipted Git Operations without network or content changes', async () => {
    const { root, git, service } = await fixture()
    const bare = await createTempGitRepo(); roots.push(bare)
    await gitExec(bare, ['config', 'core.bare', 'true'])
    await git.addRemote(root, 'origin', bare)
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await executeGitOperationsTool(service, name, args)
      return { ...JSON.parse(result.content[0].text), isError: result.isError }
    }
    const initial = await call('get_git_state')
    expect(initial.upstream).toBeNull()
    expect(await call('sync_git_remote', { action: 'PUSH', expectedHead: initial.head, operationId: randomUUID() })).toMatchObject({ pushedHead: initial.head })
    expect((await call('get_git_state')).upstream).toBeNull()
    expect(await call('sync_git_remote', { action: 'FETCH' })).toMatchObject({ result: 'FETCHED' })
    writeFile(root, 'file.txt', 'staged local content\n')
    await service.stage({ mode: 'STAGE', paths: ['file.txt'] })
    writeFile(root, 'untracked.txt', 'untracked content\n')
    const before = await call('get_git_state')
    const network = [vi.spyOn(git, 'push'), vi.spyOn(git, 'fetchRemote'), vi.spyOn(git, 'pullFastForward')]
    const configure = vi.spyOn(git, 'setBranchUpstream')
    const args = { action: 'SET_UPSTREAM', branch: 'main', remote: 'origin', remoteBranch: 'main', expectedHead: initial.head, operationId: randomUUID() }
    expect(await call('manage_git_branch', args)).toMatchObject({ branch: 'main', head: initial.head, upstream: 'origin/main', ahead: 0, behind: 0, replayed: false, indexRevision: before.indexRevision, worktreeRevision: before.worktreeRevision })
    expect(await call('manage_git_branch', args)).toMatchObject({ upstream: 'origin/main', replayed: true })
    expect(configure).toHaveBeenCalledTimes(1)
    expect(await call('get_git_state')).toMatchObject({ upstream: 'origin/main', ahead: 0, behind: 0, stagedCount: 1, untrackedCount: 1 })
    expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('staged local content\n')
    expect(readFileSync(join(root, 'untracked.txt'), 'utf8')).toBe('untracked content\n')
    for (const spy of network) expect(spy).not.toHaveBeenCalled()
    await call('commit_git_changes', { message: 'ahead', expectedHead: initial.head, expectedIndexRevision: before.indexRevision, operationId: randomUUID() })
    const ahead = await call('get_git_state')
    expect(ahead).toMatchObject({ upstream: 'origin/main', ahead: 1, behind: 0 })
    const config = await gitExec(root, ['config', '--get-regexp', '^branch.main.'])
    for (const [override, code] of [
      [{ expectedHead: initial.head }, 'GIT_STATE_CHANGED'],
      [{ remote: 'missing' }, 'REMOTE_NOT_FOUND'],
      [{ remoteBranch: 'missing' }, 'BRANCH_NOT_FOUND'],
      [{ branch: 'other' }, 'GIT_STATE_CHANGED'],
      [{ remote: '--origin' }, 'REMOTE_NOT_FOUND'],
      [{ remoteBranch: 'main:other' }, 'INVALID_REF']
    ] as const) {
      expect(await call('manage_git_branch', { ...args, ...override, expectedHead: 'expectedHead' in override ? override.expectedHead : ahead.head, operationId: randomUUID() })).toMatchObject({ code, isError: true })
      expect(await gitExec(root, ['config', '--get-regexp', '^branch.main.'])).toBe(config)
    }
    expect(await call('manage_git_branch', { ...args, remoteBranch: 'missing' })).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    writeFileSync(join(root, '.git', 'MERGE_HEAD'), ahead.head + '\n')
    expect(await call('manage_git_branch', { ...args, expectedHead: ahead.head, operationId: randomUUID() })).toMatchObject({ code: 'GIT_OPERATION_IN_PROGRESS' })
    expect(configure).toHaveBeenCalledTimes(1)
    expect(await gitExec(root, ['config', '--get-regexp', '^branch.main.'])).toBe(config)
  }, 60000)

  it.each(['branch', 'head'])('rejects a %s race after remote-tracking validation', async (race) => {
    const { root, git, service } = await fixture()
    const bare = await createTempGitRepo(); roots.push(bare)
    await gitExec(bare, ['config', 'core.bare', 'true'])
    await git.addRemote(root, 'origin', bare)
    const head = (await service.getState()).head
    await service.sync({ action: 'PUSH', expectedHead: head })
    await service.sync({ action: 'FETCH' })
    await service.manageBranch({ action: 'CREATE', branch: 'other', expectedHead: head })
    const resolve = git.resolveCommit.bind(git)
    vi.spyOn(git, 'resolveCommit').mockImplementation(async (repo, ref) => {
      const value = await resolve(repo, ref)
      if (ref === 'refs/remotes/origin/main') {
        if (race === 'branch') await gitExec(root, ['switch', 'other'])
        else await gitExec(root, ['commit', '--allow-empty', '-m', 'concurrent actor'])
      }
      return value
    })
    await expect(service.manageBranch({ action: 'SET_UPSTREAM', branch: 'main', remote: 'origin', remoteBranch: 'main', expectedHead: head })).rejects.toThrow('GIT_STATE_CHANGED')
    expect((await service.getState()).upstream).toBeNull()
    expect(await gitExec(root, ['config', '--get-regexp', '^branch.main.'], { allowExitOne: true })).toBe('')
    expect(await gitExec(root, ['config', '--get-regexp', '^branch.other.'], { allowExitOne: true })).toBe('')
  }, 60000)

  it('detects all required Git operations, validates refs and rejects empty commits', async () => {
    const { root, service } = await fixture()
    const state = await service.getState()
    await expect(service.commit({ message: 'empty', expectedHead: state.head, expectedIndexRevision: state.indexRevision })).rejects.toThrow('NOTHING_TO_COMMIT')
    await expect(service.manageBranch({ action: 'CREATE', branch: '--force', expectedHead: state.head })).rejects.toThrow('INVALID_REF')
    for (const [marker, operation] of [['MERGE_HEAD', 'MERGE'], ['CHERRY_PICK_HEAD', 'CHERRY_PICK'], ['REVERT_HEAD', 'REVERT'], ['rebase-merge', 'REBASE']] as const) {
      const markerPath = join(root, '.git', marker)
      if (operation === 'REBASE') mkdirSync(markerPath)
      else writeFileSync(markerPath, `${state.head}\n`)
      expect((await service.getState()).operation).toBe(operation)
      await expect(service.manageBranch({ action: 'CREATE', branch: 'blocked', expectedHead: state.head })).rejects.toThrow('GIT_OPERATION_IN_PROGRESS')
      rmSync(markerPath, { recursive: operation === 'REBASE' })
    }
  }, 30000)

  it('inspects, stages, unstages without content loss, commits only staged content, branches, merges and reverts', async () => {
    const { root, service } = await fixture()
    writeFile(root, 'file.txt', 'staged\n')
    writeFile(root, 'novo espaço ç.txt', 'untracked\n')
    expect(await service.getState()).toMatchObject({ stagedCount: 0, unstagedCount: 1, untrackedCount: 1 })
    await service.stage({ mode: 'STAGE', paths: ['file.txt'] })
    writeFile(root, 'file.txt', 'staged\nunstaged\n')
    expect((await service.getChanges())[0]).toMatchObject({ stagedState: 'M', unstagedState: 'M' })
    expect((await service.getDiff({ paths: ['file.txt'], mode: 'STAGED' })).patch).toContain('+staged')
    const state = await service.getState()
    const created = await service.commit({ message: 'inspected', expectedHead: state.head, expectedIndexRevision: state.indexRevision })
    expect(await gitExec(root, ['show', 'HEAD:file.txt'])).toBe('staged\n')
    expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('staged\nunstaged\n')
    await service.stage({ mode: 'STAGE', paths: ['file.txt', 'novo espaço ç.txt'] })
    await service.stage({ mode: 'UNSTAGE', paths: ['novo espaço ç.txt'] })
    expect(readFileSync(join(root, 'novo espaço ç.txt'), 'utf8')).toBe('untracked\n')
    await service.stage({ mode: 'STAGE', paths: ['novo espaço ç.txt'] })
    const next = await service.getState()
    await service.commit({ message: 'remaining', expectedHead: next.head, expectedIndexRevision: next.indexRevision })
    await service.manageBranch({ action: 'CREATE', branch: 'feature', expectedHead: (await service.getState()).head })
    await service.manageBranch({ action: 'SWITCH', branch: 'feature' })
    writeFile(root, 'feature.txt', 'feature\n'); await service.stage({ mode: 'STAGE', paths: ['feature.txt'] })
    const featureState = await service.getState()
    const feature = await service.commit({ message: 'feature', expectedHead: featureState.head, expectedIndexRevision: featureState.indexRevision })
    await service.manageBranch({ action: 'SWITCH', branch: 'main' })
    expect(await service.merge({ action: 'MERGE', source: 'feature', expectedHead: (await service.getState()).head })).toMatchObject({ result: 'FAST_FORWARDED' })
    expect(await service.revert({ commit: feature.sha, expectedHead: feature.sha })).toMatchObject({ result: 'REVERTED' })
    expect((await service.getHistory({ limit: 2 }))).toHaveLength(2)
    expect((await service.getHistory({ path: 'file.txt' })).map((c) => c.sha)).toContain(created.sha)
    await service.manageBranch({ action: 'RENAME', branch: 'feature', newBranch: 'renamed' })
    await service.manageBranch({ action: 'DELETE', branch: 'renamed' })
  }, 60000)

  it('rejects stale index and HEAD without mutating history', async () => {
    const { root, service } = await fixture()
    writeFile(root, 'file.txt', 'first\n'); await service.stage({ mode: 'STAGE', paths: ['file.txt'] })
    const observed = await service.getState()
    writeFile(root, 'file.txt', 'other actor\n'); await gitExec(root, ['add', 'file.txt'])
    await expect(service.commit({ message: 'stale', expectedHead: observed.head, expectedIndexRevision: observed.indexRevision })).rejects.toThrow('GIT_STATE_CHANGED')
    expect((await service.getState()).head).toBe(observed.head)
    await commit(root, 'other actor')
    await expect(service.merge({ action: 'MERGE', source: 'main', expectedHead: observed.head })).rejects.toThrow('GIT_STATE_CHANGED')
    await expect(service.manageBranch({ action: 'CREATE', branch: 'stale', expectedHead: observed.head })).rejects.toThrow('GIT_STATE_CHANGED')
  }, 30000)

  it('returns conflicts and permits abort while blocking incompatible mutations', async () => {
    const { root, service } = await fixture()
    const baseline = (await service.getState()).head
    await service.manageBranch({ action: 'CREATE', branch: 'feature', expectedHead: baseline })
    await service.manageBranch({ action: 'SWITCH', branch: 'feature' })
    writeFile(root, 'file.txt', 'feature\n'); await stageAll(root); await commit(root, 'feature')
    await service.manageBranch({ action: 'SWITCH', branch: 'main' })
    writeFile(root, 'file.txt', 'main\n'); await stageAll(root); await commit(root, 'main')
    const head = (await service.getState()).head
    expect(await service.merge({ action: 'MERGE', source: 'feature', expectedHead: head, mode: 'MERGE' })).toEqual({ result: 'CONFLICTS', paths: ['file.txt'] })
    expect(await service.getState()).toMatchObject({ conflictCount: 1, operation: 'MERGE' })
    await expect(service.manageBranch({ action: 'SWITCH', branch: 'feature' })).rejects.toThrow('GIT_OPERATION_IN_PROGRESS')
    expect(await service.merge({ action: 'ABORT' })).toMatchObject({ result: 'ABORTED', head })
    expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('main\n')
    await service.merge({ action: 'MERGE', source: 'feature', expectedHead: head, mode: 'MERGE' })
    writeFile(root, 'file.txt', 'resolved\n')
    await service.stage({ mode: 'STAGE', paths: ['file.txt'] })
    const resolved = await service.getState()
    const mergeCommit = await service.commit({ message: 'resolve merge', expectedHead: resolved.head, expectedIndexRevision: resolved.indexRevision })
    expect((await service.getHistory({ limit: 1 }))[0].parents).toHaveLength(2)
    expect(await service.getState()).toMatchObject({ head: mergeCommit.sha, operation: null, conflictCount: 0 })
  }, 30000)

  it('bounds diffs, invalidates changed cursors, detects binaries and rejects unsafe paths and schema fields', async () => {
    const { root, service } = await fixture()
    writeFile(root, 'file.txt', Array.from({ length: 10000 }, (_, i) => `line ${i}`).join('\n'))
    const page = await service.getDiff({ paths: ['file.txt'], mode: 'WORKTREE' })
    expect(page.truncated).toBe(true); expect(page.patch.length).toBeLessThanOrEqual(24000)
    const next = await service.getDiff({ paths: ['file.txt'], mode: 'WORKTREE', cursor: page.nextCursor! })
    expect(next.revision).toBe(page.revision)
    writeFile(root, 'file.txt', 'changed\n')
    await expect(service.getDiff({ paths: ['file.txt'], mode: 'WORKTREE', cursor: page.nextCursor! })).rejects.toThrow('GIT_STATE_CHANGED')
    for (const path of ['../outside', '/absolute', 'C:\\absolute', '.git/config', '.git./config', '.', ':(glob)**']) {
      await expect(service.stage({ mode: 'STAGE', paths: [path] })).rejects.toThrow('PATH_OUTSIDE_REPOSITORY')
    }
    for (const field of ['repoPath', 'cwd', 'command', 'credential', 'force']) {
      expect((await executeGitOperationsTool(service, 'get_git_state', { [field]: 'value' })).isError).toBe(true)
    }
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
    await service.stage({ mode: 'STAGE', paths: ['binary.bin'] })
    expect(await service.getDiff({ mode: 'STAGED', paths: ['binary.bin'] })).toMatchObject({ binary: true })
    expect(JSON.stringify(GIT_OPERATIONS_TOOLS)).not.toMatch(/repoPath|credential|cwd/)
    writeFile(root, 'literal[1].txt', 'literal\n')
    await service.stage({ mode: 'STAGE', paths: ['literal[1].txt'] })
    expect((await service.getChanges('STAGED')).map((change) => change.path)).toContain('literal[1].txt')
    const outside = await fixture()
    symlinkSync(outside.root, join(root, 'outside-link'), 'junction')
    await expect(service.stage({ mode: 'STAGE', paths: ['outside-link/file.txt'] })).rejects.toThrow('PATH_OUTSIDE_REPOSITORY')
    expect((await service.getDiff({ mode: 'WORKTREE', paths: ['novo.txt'] })).patch).toBe('')
    writeFile(root, 'novo.txt', 'novo\n')
    expect((await service.getDiff({ mode: 'WORKTREE', paths: ['novo.txt'] })).patch).toContain('+novo')
  }, 30000)

  it('switches MCP project authority and rejects attempts to select another repository', async () => {
    const a = await fixture(), b = await fixture()
    writeFile(a.root, 'only-a.txt', 'a'); writeFile(b.root, 'only-b.txt', 'b')
    const navigation = {} as ProjectContextNavigation
    const adapterA = new ChannelMcpAdapter({ projectId: 'a', repoRoot: a.root, navigation, gitOperations: a.service })
    const adapterB = new ChannelMcpAdapter({ projectId: 'b', repoRoot: b.root, navigation, gitOperations: b.service })
    expect(adapterB.listTools().filter((tool) => GIT_OPERATIONS_TOOLS.some((gitTool) => gitTool.name === tool.name))).toHaveLength(15)
    expect((await adapterA.callTool('get_git_changes', {})).content[0].text).toContain('only-a')
    expect((await adapterB.callTool('get_git_changes', {})).content[0].text).not.toContain('only-a')
    expect((await adapterB.callTool('stage_git_changes', { paths: ['only-a.txt'], mode: 'STAGE', repoPath: a.root })).isError).toBe(true)
    expect((await a.service.getState()).untrackedCount).toBe(1)
    const lifecycle = new McpLifecycle({ createContextServer: (context) => createMcpHttpServer(new ChannelMcpAdapter(context), () => {}), log: () => {} })
    try {
      await lifecycle.activateContext({ projectId: 'a', repoRoot: a.root, navigation, gitOperations: a.service })
      await lifecycle.activateContext({ projectId: 'b', repoRoot: b.root, navigation, gitOperations: b.service })
      const state = lifecycle.getState()
      if (state.status !== 'RUNNING') throw new Error('MCP unavailable')
      const response = await fetch(state.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_git_changes', arguments: {} } }) })
      const reply = await response.json()
      expect(reply.result.content[0].text).toContain('only-b')
      expect(reply.result.content[0].text).not.toContain('only-a')
    } finally { await lifecycle.dispose() }
  }, 30000)

  it('fetches, pushes, pulls FF only and rejects diverged and stale pushes on a bare remote', async () => {
    const a = await fixture(), b = await fixture()
    const bare = await createTempGitRepo(); roots.push(bare)
    await gitExec(bare, ['config', 'core.bare', 'true'])
    await a.git.addRemote(a.root, 'origin', bare)
    await b.git.addRemote(b.root, 'origin', bare)
    const firstHead = (await a.service.getState()).head
    expect(await a.service.sync({ action: 'PUSH', expectedHead: firstHead })).toMatchObject({ pushedHead: firstHead })
    await b.service.sync({ action: 'FETCH' })
    // The independent fixture has unrelated history; use the fetched baseline for the second actor.
    await gitExec(b.root, ['reset', '--hard', 'origin/main'])
    writeFile(b.root, 'remote.txt', 'remote'); await stageAll(b.root); await commit(b.root, 'remote update')
    await b.service.sync({ action: 'PUSH', expectedHead: (await b.service.getState()).head })
    expect(await a.service.sync({ action: 'PULL_FF_ONLY', expectedHead: firstHead })).toMatchObject({ head: (await b.service.getState()).head })
    await expect(a.service.sync({ action: 'PUSH', expectedHead: firstHead })).rejects.toThrow('GIT_STATE_CHANGED')
    writeFile(a.root, 'local.txt', 'local'); await stageAll(a.root); await commit(a.root, 'local')
    writeFile(b.root, 'other.txt', 'other'); await stageAll(b.root); await commit(b.root, 'other')
    await b.service.sync({ action: 'PUSH', expectedHead: (await b.service.getState()).head })
    const localHead = (await a.service.getState()).head
    await expect(a.service.sync({ action: 'PULL_FF_ONLY', expectedHead: localHead })).rejects.toThrow('NON_FAST_FORWARD')
    await expect(a.service.sync({ action: 'PUSH', expectedHead: localHead })).rejects.toThrow('NON_FAST_FORWARD')
    expect((await a.service.getState()).head).toBe(localHead)
  }, 60000)
})
