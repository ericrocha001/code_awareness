import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { GitService } from '../core/git-service'
import { cleanupTempRepo, commit, createTempGitRepo, gitExec, stageAll, writeFile } from '../core/git-test-helpers'
import { GitOperationsService } from './git-operations-service'
import { GitHubGitTransport } from '../github/github-git-transport'
import type { BranchDiscardRemoteReader } from '../../shared/types/branch-discard-types'

describe('protected manual branch discard with real Git', () => {
  let root = ''
  const git = new GitService()
  afterEach(async () => { if (root) await cleanupTempRepo(root) })
  const remote: BranchDiscardRemoteReader = async inventory => ({ repositoryId: inventory.repositoryId, coverage: 'COMPLETE', observedAt: new Date().toISOString(), revision: 'remote-one', defaultBranch: 'main', protected: false, openPullRequests: [], knownPullRequests: [], reason: null })
  async function setup() {
    root = await createTempGitRepo(); await gitExec(root, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    writeFile(root, 'base', 'base'); await stageAll(root); await commit(root, 'base')
    await gitExec(root, ['switch', '-c', 'abandoned'])
    writeFile(root, 'own', 'exclusive'); await stageAll(root); await commit(root, 'exclusive')
    await gitExec(root, ['switch', 'main'])
    return new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'fixture', isActive: () => true })
  }
  async function prepare(service: GitOperationsService, name = 'abandoned', reader = remote) {
    const branch = (await service.getBranchInventory()).branches.find(b => b.name === name)!
    return service.prepareBranchDiscard(branch.ref, branch.revision, 'refs/heads/main', reader)
  }
  it('requires destructive consent, preserves exclusive SHA durably, replays receipt and recovers bytes', async () => {
    const service = await setup(), preview = await prepare(service)
    expect(preview).toMatchObject({ blockers: [], integrated: false, exclusiveCount: 1, recoveryRequired: true })
    const rejected = await service.executeBranchDiscard({ previewId: preview.previewId, operationId: 'no-consent', confirmed: true, preserveExclusive: false }, remote, () => {})
    expect(rejected).toMatchObject({ isError: true, value: { code: 'BRANCH_PRESERVATION_CONSENT_REQUIRED' } })
    const request = { previewId: preview.previewId, operationId: 'discard-once', confirmed: true as const, preserveExclusive: true }
    const result = await service.executeBranchDiscard(request, remote, () => {})
    expect(result.isError).toBeUndefined()
    expect(result.value).toMatchObject({ result: 'BRANCH_DISCARDED', head: preview.branch.head, recoveryHead: preview.branch.head })
    expect((await service.getBranchInventory()).branches.some(b => b.name === 'abandoned')).toBe(false)
    await gitExec(root, ['branch', 'recovered', String(result.value.recoveryRef)])
    expect((await gitExec(root, ['show', 'recovered:own'])).trim()).toBe('exclusive')
    expect(await service.executeBranchDiscard(request, remote, () => {})).toMatchObject({ value: { replayed: true, recoveryHead: preview.branch.head } })
  }, 60000)
  it('allows integrated branches, preserving origin even for squash integration', async () => {
    const service = await setup()
    await gitExec(root, ['merge', '--squash', 'abandoned']); await commit(root, 'squash')
    const squash = await prepare(service)
    expect(squash.recoveryRequired).toBe(true)
    await gitExec(root, ['branch', 'integrated', 'main'])
    const integrated = await prepare(service, 'integrated')
    expect(integrated).toMatchObject({ integrated: true, exclusiveCount: 0, blockers: [] })
  }, 60000)
  it.each(['open', 'unavailable', 'protected', 'wrong-repository'])('blocks %s evidence without deleting the branch', async kind => {
    const service = await setup()
    const reader: BranchDiscardRemoteReader = async inventory => ({ ...await remote(inventory, {} as any), ...(kind === 'open' ? { openPullRequests: [7] } : kind === 'unavailable' ? { coverage: 'UNAVAILABLE' as const } : kind === 'protected' ? { protected: true } : { repositoryId: 'other' }) })
    if (kind === 'wrong-repository') await expect(prepare(service, 'abandoned', reader)).rejects.toThrow('REPOSITORY_CONTEXT_CHANGED')
    else expect((await prepare(service, 'abandoned', reader)).blockers.length).toBeGreaterThan(0)
    expect(await git.resolveCommit(root, 'refs/heads/abandoned')).toBeTruthy()
  }, 60000)
  it('blocks checkout in another worktree including dirty and ignored content, and main', async () => {
    const service = await setup()
    const checkout = join(root, 'external')
    await gitExec(root, ['worktree', 'add', checkout, 'abandoned'])
    writeFile(checkout, 'own', 'dirty')
    const occupied = await prepare(service)
    expect(occupied.blockers).toContain('WORKTREE_BRANCH_OCCUPIED')
    const result = await service.executeBranchDiscard({ previewId: occupied.previewId, operationId: 'occupied', confirmed: true, preserveExclusive: true }, remote, () => {})
    expect(result.isError).toBe(true)
    const main = (await service.getBranchInventory()).branches.find(b => b.name === 'main')!
    expect((await service.prepareBranchDiscard(main.ref, main.revision, 'refs/heads/abandoned', remote)).blockers).toContain('BRANCH_PROTECTED')
  }, 60000)
  it.each(['rename', 'recreate', 'force-update', 'checkout', 'remote-drift'])('revalidates %s between prepare and execute', async change => {
    const service = await setup(), preview = await prepare(service)
    if (change === 'rename') await gitExec(root, ['branch', '-m', 'abandoned', 'renamed'])
    if (change === 'recreate') { await gitExec(root, ['branch', '-D', 'abandoned']); await gitExec(root, ['branch', 'abandoned', preview.branch.head]) }
    if (change === 'force-update') await gitExec(root, ['update-ref', 'refs/heads/abandoned', 'HEAD'])
    if (change === 'checkout') await gitExec(root, ['worktree', 'add', join(root, 'late-checkout'), 'abandoned'])
    const result = await service.executeBranchDiscard({ previewId: preview.previewId, operationId: 'drift', confirmed: true, preserveExclusive: true }, change === 'remote-drift' ? async (inventory, branch) => ({ ...await remote(inventory, branch), revision: 'changed' }) : remote, () => {})
    expect(result.isError).toBe(true)
    expect((await service.getBranchInventory()).branches.some(b => b.name === (change === 'rename' ? 'renamed' : 'abandoned'))).toBe(true)
  }, 60000)
  it('does not steal transaction locks and allows the same operation after contention clears', async () => {
    const service = await setup(), preview = await prepare(service)
    const file = join(root, '.git', 'code-awareness-worktrees.lock')
    writeFileSync(file, 'another writer')
    const request = { previewId: preview.previewId, operationId: 'contended', confirmed: true as const, preserveExclusive: true }
    await expect(service.executeBranchDiscard(request, remote, () => {})).rejects.toThrow('WORKTREE_TRANSACTION_BUSY')
    expect(readFileSync(file, 'utf8')).toBe('another writer')
    unlinkSync(file)
    expect(await service.executeBranchDiscard(request, remote, () => {})).toMatchObject({ value: { result: 'BRANCH_DISCARDED' } })
  }, 60000)
  it('removes only a released clean fixture worktree, retains branch and rejects ignored files', async () => {
    const service = await setup(), checkout = join(root, 'fixture-checkout')
    await gitExec(root, ['worktree', 'add', checkout, 'abandoned'])
    const tree = (await service.getBranchInventory()).worktrees.find(w => w.branch === 'abandoned')!
    writeFile(checkout, 'own', 'dirty')
    expect((await service.prepareWorktreeRemoval(tree.worktreeId, tree.generation)).blockers).toContain('DIRTY_WORKTREE')
    await gitExec(checkout, ['restore', 'own'])
    writeFileSync(join(root, '.git', 'info', 'exclude'), 'ignored\n')
    writeFile(checkout, 'ignored', 'preserve')
    expect((await service.prepareWorktreeRemoval(tree.worktreeId, tree.generation)).blockers).toContain('WORKTREE_IGNORED_CONTENT')
    unlinkSync(join(checkout, 'ignored'))
    const preview = await service.prepareWorktreeRemoval(tree.worktreeId, tree.generation)
    expect(preview.blockers).toEqual([])
    const request = { previewId: preview.previewId, operationId: 'remove-fixture', releasedByUser: true as const }
    expect(await service.executeWorktreeRemoval({ ...request, operationId: 'release-denied' }, async () => false, () => {})).toMatchObject({ isError: true, value: { code: 'WORKTREE_RELEASE_NOT_CONFIRMED' } })
    expect(await service.executeWorktreeRemoval(request, async () => true, () => {})).toMatchObject({ value: { result: 'WORKTREE_REMOVED', preservationHead: tree.head } })
    expect(await git.resolveCommit(root, 'refs/heads/abandoned')).toBe(tree.head)
  }, 60000)
  it.each(['assume-unchanged', 'skip-worktree', 'index-lock', 'submodule'])('blocks hidden or unsafe checkout state: %s', async mode => {
    const service = await setup(), checkout = join(root, 'unsafe-checkout')
    await gitExec(root, ['worktree', 'add', checkout, 'abandoned'])
    const tree = (await service.getBranchInventory()).worktrees.find(w => w.branch === 'abandoned')!
    if (mode === 'assume-unchanged' || mode === 'skip-worktree') {
      await gitExec(checkout, ['update-index', `--${mode}`, 'own'])
      writeFile(checkout, 'own', 'hidden content must survive')
    } else if (mode === 'submodule') {
      await gitExec(checkout, ['update-index', '--add', '--cacheinfo', `160000,${tree.head},nested`])
    } else writeFileSync(join(await git.getWorktreeDirectory(checkout), 'index.lock'), 'another writer')
    const preview = await service.prepareWorktreeRemoval(tree.worktreeId, tree.generation)
    expect(preview.blockers).toContain(mode === 'submodule' ? 'WORKTREE_SUBMODULE_NOT_ALLOWED' : mode === 'index-lock' ? 'GIT_OPERATION_IN_PROGRESS' : 'WORKTREE_HIDDEN_INDEX_FLAGS')
    expect(await git.resolveCommit(root, 'refs/heads/abandoned')).toBe(tree.head)
  }, 60000)
})
