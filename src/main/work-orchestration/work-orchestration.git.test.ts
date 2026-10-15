import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GitService } from '../core/git-service'
import { createTempGitRepo, cleanupTempRepo, gitExec, stageAll, commit } from '../core/git-test-helpers'
import { GitOperationsService } from '../git-operations/git-operations-service'
import { GitHubGitTransport } from '../github/github-git-transport'
import { WorkOrchestrationService } from './work-orchestration-service'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await cleanupTempRepo(root) })
it('keeps individual worktree inspection read-only without exposing or invoking manual pairs', async () => {
  const root = await createTempGitRepo(), parent = mkdtempSync(join(tmpdir(), 'orchestration-')); roots.push(root, parent)
  writeFileSync(join(root, 'file.txt'), 'base\n'); await stageAll(root); await commit(root, 'base')
  const detached = join(parent, 'detached'); await gitExec(root, ['worktree', 'add', '--detach', detached])
  writeFileSync(join(detached, 'file.txt'), 'staged\n'); await gitExec(detached, ['add', 'file.txt'])
  writeFileSync(join(detached, 'file.txt'), 'unstaged\n'); writeFileSync(join(detached, 'new.txt'), 'new\n')
  const git = new GitService(), reader = new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'orchestration', isActive: () => true })
  const service = new WorkOrchestrationService(reader), comparisons = vi.spyOn(reader, 'getCoordinationCommitPaths')
  const before = await git.captureWorktreeReadSnapshot(detached), inventory = await service.inventory()
  expect('pairs' in inventory || 'relationsCoverage' in inventory || 'pair' in service).toBe(false)
  const record = inventory.worktrees.find(w => w.path === detached)!
  expect((await service.observe(record.worktreeId)).worktree).toMatchObject({ detached: true, observation: 'VERIFIED', stagedCount: 1, unstagedCount: 1, untrackedCount: 1 })
  expect(await git.captureWorktreeReadSnapshot(detached)).toEqual(before)
  expect(comparisons).not.toHaveBeenCalled()
  await expect(service.observe('unknown')).rejects.toThrow('WORKTREE_NOT_DISCOVERED')
}, 30000)
