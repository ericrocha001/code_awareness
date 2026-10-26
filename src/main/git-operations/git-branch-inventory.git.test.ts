import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { GitService } from '../core/git-service'
import { cleanupTempRepo, commit, createTempGitRepo, gitExec, stageAll, writeFile } from '../core/git-test-helpers'
import { GitWorktreeRegistry } from './git-worktree-registry'
import { GitBranchInventory } from './git-branch-inventory'
import { GitOperationsService } from './git-operations-service'
import { GitHubGitTransport } from '../github/github-git-transport'

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
    await expect(service.verifyRuntimePreviewTarget({ ...expected, generation: 'replaced' })).rejects.toThrow('WORKTREE_STALE')
    await expect(service.verifyRuntimePreviewTarget({ ...expected, path: root })).rejects.toThrow('WORKTREE_STALE')
    await gitExec(path, ['update-ref', '-d', branch.ref]); await gitExec(path, ['update-ref', branch.ref, branch.head])
    await expect(service.verifyRuntimePreviewTarget(expected)).rejects.toThrow('BRANCH_CHANGED')
    const updated = (await service.getBranchInventory()).branches.find(value => value.ref === branch.ref)!
    await gitExec(path, ['commit', '--allow-empty', '-m', 'drift'])
    await expect(service.verifyRuntimePreviewTarget({ ...expected, branchGeneration: updated.generation })).rejects.toThrow('WORKTREE_STALE')
    await gitExec(path, ['switch', '--detach'])
    await expect(service.verifyRuntimePreviewTarget(expected)).rejects.toThrow('WORKTREE_STALE')
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
