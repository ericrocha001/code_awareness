import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { GitService } from '../core/git-service'
import { createTempGitRepo, cleanupTempRepo, gitExec, stageAll, commit } from '../core/git-test-helpers'
import { GitOperationsService } from '../git-operations/git-operations-service'
import { GitHubGitTransport } from '../github/github-git-transport'
import { WorkOrchestrationService } from './work-orchestration-service'
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await cleanupTempRepo(root) })
it('observes distinct local paths, exact flags, external changes, safe pages and a fresh restart without mutating Git', async () => {
  const root = await createTempGitRepo(); roots.push(root)
  for (const path of ['modified.txt', 'deleted.txt', 'rename.txt']) writeFileSync(join(root, path), 'base\n')
  await stageAll(root); await commit(root, 'base')
  const git = new GitService(), reader = new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'signals', isActive: () => true })
  const service = new WorkOrchestrationService(reader)
  const inventory = await service.inventory(), id = inventory.worktrees[0].worktreeId
  const discovery = vi.spyOn(reader, 'discoverCoordinationWorktrees')
  expect((await service.observe(id)).worktree.localChanges?.total).toBe(0)
  writeFileSync(join(root, 'added.txt'), 'staged\n'); await gitExec(root, ['add', 'added.txt'])
  writeFileSync(join(root, 'added.txt'), 'unstaged\n')
  writeFileSync(join(root, 'modified.txt'), 'modified\n'); unlinkSync(join(root, 'deleted.txt'))
  await gitExec(root, ['mv', 'rename.txt', 'renamed.txt'])
  for (let i = 0; i < 53; i++) writeFileSync(join(root, `untracked-${i}.txt`), 'new\n')
  const index = readFileSync(join(root, '.git/index')).toString('hex'), refs = await gitExec(root, ['show-ref'])
  const observed = (await service.observe(id)).worktree
  expect(observed.localChanges).toEqual({ total: 57, categories: { added: 1, modified: 2, deleted: 1, renamed: 1, untracked: 53, conflicted: 0 } })
  expect(observed).toMatchObject({ stagedCount: 2, unstagedCount: 3, untrackedCount: 53, observation: 'VERIFIED' })
  expect(discovery).not.toHaveBeenCalled()
  const request = { worktreeId: id, generation: observed.generation, snapshotRevision: observed.snapshotRevision! }
  const first = await service.changes(request)
  expect(first.changes).toHaveLength(50); expect(first.totalCount).toBe(57)
  expect(first.changes.find(change => change.path === 'added.txt')).toMatchObject({ stagedState: 'A', unstagedState: 'M', untracked: false })
  expect(first.changes.find(change => change.path === 'renamed.txt')?.previousPath).toBe('rename.txt')
  expect((await service.changes({ ...request, cursor: first.nextCursor! })).changes).toHaveLength(7)
  expect((await service.changes({ ...request, pathPrefix: 'added.txt' })).totalCount).toBe(1)
  expect(readFileSync(join(root, '.git/index')).toString('hex')).toBe(index); expect(await gitExec(root, ['show-ref'])).toBe(refs)
  writeFileSync(join(root, 'external.txt'), 'external\n')
  await expect(service.changes({ ...request, cursor: first.nextCursor! })).rejects.toThrow('GIT_STATE_CHANGED')
  expect((await service.observe(id)).worktree.localChanges?.total).toBe(58)
  await gitExec(root, ['reset', '--', 'added.txt'])
  expect((await service.observe(id)).worktree.untrackedCount).toBe(55)
  await stageAll(root); await commit(root, 'all')
  expect((await service.observe(id)).worktree.localChanges?.total).toBe(0)
  const restarted = new WorkOrchestrationService(reader)
  expect((await restarted.inventory()).worktrees[0].observation).toBe('NOT_OBSERVED')
  expect((await restarted.observe(id)).worktree.localChanges?.total).toBe(0)
}, 90000)

it('counts an unresolved conflict once and preserves its exact index/worktree flags', async () => {
  const root = await createTempGitRepo(); roots.push(root)
  writeFileSync(join(root, 'conflict.txt'), 'base\n'); await stageAll(root); await commit(root, 'base')
  await gitExec(root, ['checkout', '-b', 'side']); writeFileSync(join(root, 'conflict.txt'), 'side\n'); await stageAll(root); await commit(root, 'side')
  await gitExec(root, ['checkout', '-']); writeFileSync(join(root, 'conflict.txt'), 'main\n'); await stageAll(root); await commit(root, 'main')
  await expect(gitExec(root, ['merge', 'side'])).rejects.toThrow()
  const git = new GitService(), reader = new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'conflicts', isActive: () => true })
  const service = new WorkOrchestrationService(reader), tree = (await service.inventory()).worktrees[0]
  const observed = (await service.observe(tree.worktreeId)).worktree
  expect(observed.localChanges).toEqual({ total: 1, categories: { added: 0, modified: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 1 } })
  const page = await service.changes({ worktreeId: tree.worktreeId, generation: tree.generation, snapshotRevision: observed.snapshotRevision! })
  expect(page.changes[0]).toMatchObject({ path: 'conflict.txt', conflicted: true, stagedState: 'U', unstagedState: 'U' })
}, 30000)
