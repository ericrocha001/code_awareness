import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { GitService } from '../core/git-service'
import { createTempGitRepo, cleanupTempRepo, gitExec, stageAll, commit } from '../core/git-test-helpers'
import { GitOperationsService } from '../git-operations/git-operations-service'
import { GitHubGitTransport } from './github-git-transport'
import { GitHubPullRequests } from './github-pull-requests'
import { GitHubPrIntegration } from './github-pr-integration'
import { evaluatePullRequestPolicy } from './github-pr-evidence'

it('verifies the source using the real worktree registry while preserving Desktop main, index and files', async () => {
  const root = await createTempGitRepo()
  const external = mkdtempSync(join(tmpdir(), 'pr-worktree-proof-'))
  try {
    writeFileSync(join(root, 'file.txt'), 'baseline\n')
    await stageAll(root); await commit(root, 'baseline')
    await gitExec(root, ['branch', '-M', 'main'])
    const source = join(external, 'cline')
    await gitExec(root, ['worktree', 'add', '-b', 'cline/proof', source])
    writeFileSync(join(source, 'file.txt'), 'feature\n')
    await stageAll(source); await commit(source, 'feature')
    const git = new GitService()
    const operations = new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'proof-repository', isActive: () => true })
    const worktree = (await operations.discoverWorktrees()).worktrees.find(item => item.branch === 'cline/proof')!
    expect(worktree).toBeDefined()
    const mainSha = await git.getCurrentCommitHash(root), headSha = await git.getCurrentCommitHash(source)
    expect(headSha).not.toBe(mainSha)
    const before = await gitExec(root, ['status', '--porcelain=v1'])
    let created = false
    const pr = { number: 23, url: 'https://github.com/owner/repo/pull/23', title: 'Proof', state: 'open', draft: false, head: { ref: 'cline/proof', sha: headSha, repository: 'owner/repo' }, base: { ref: 'main', sha: mainSha, repository: 'owner/repo' }, mergedAt: null, mergeability: 'UNKNOWN', observedAt: new Date().toISOString() }
    const api = { getPullRequestPermissions: async () => ({ read: true, create: true }), getBranchSha: async (_repo: string, branch: string) => branch === 'main' ? mainSha : headSha,
      listPullRequests: async () => ({ pullRequests: created ? [pr] : [] }), getPullRequest: async () => pr,
      createPullRequest: vi.fn(async () => { created = true; return pr }) }
    const service = new GitHubPullRequests(api as any, async () => ({ repositoryId: 'proof-repository', repository: 'owner/repo' }), { receiptDirectory: join(external, 'receipts'), approve: async () => true })
    const execution = { isActive: () => true, inspectWorktree: (id: string) => operations.inspectWorktree(id) }
    const input = { headBranch: 'cline/proof', baseBranch: 'main', expectedHeadSha: headSha!, title: 'Proof', body: 'Registry integration proof', operationId: 'worktree-proof', worktreeId: worktree.worktreeId }
    expect(await service.create(input, execution)).toMatchObject({ status: 'CREATED' })
    expect(await git.getCurrentBranch(root)).toBe('main')
    expect(await git.getCurrentCommitHash(root)).toBe(mainSha)
    expect(await gitExec(root, ['status', '--porcelain=v1'])).toEqual(before)
    const mutationApi = {
      getPullRequestEndpointPermissions: async () => ({ read: true, merge: true, close: true, checks: true, statuses: true }),
      getPullRequest: async () => ({ ...pr, stack: 'NONE' }),
      getBranchSha: api.getBranchSha,
      getPullRequestPolicy: async () => evaluatePullRequestPolicy([], null, { allow_merge_commit: true }),
      getPullRequestReviews: async () => ({ headSha, completeness: 'COMPLETE', decision: 'NO_APPROVAL', approvalCount: 0 }),
      getPullRequestChecks: async () => ({ headSha, completeness: 'COMPLETE', checks: [] }),
      requestPullRequestMerge: async (_repo: string, _number: number, _head: string, _queue: boolean, beforeSend: () => Promise<void>) => { await beforeSend(); return { httpStatus: 200, value: { status: 'enqueued' } } }
    }
    const integration = new GitHubPrIntegration(mutationApi as any, async () => ({ repositoryId: 'proof-repository', repository: 'owner/repo' }), { receiptDirectory: join(external, 'receipts'), approve: async () => true, approveMutation: async () => true })
    const sourceBefore = await gitExec(source, ['status', '--porcelain=v1'])
    expect(await integration.mutate('MERGE_PULL_REQUEST', { prNumber: 23, operationId: 'merge-worktree-proof', expectedHeadSha: headSha!, expectedBaseSha: mainSha! }, execution)).toMatchObject({ status: 'ENQUEUED', localGitChanged: false })
    expect(await git.getCurrentCommitHash(root)).toBe(mainSha)
    expect(await git.getCurrentBranch(root)).toBe('main')
    expect(await git.getCurrentCommitHash(source)).toBe(headSha)
    expect(await gitExec(root, ['status', '--porcelain=v1'])).toEqual(before)
    expect(await gitExec(source, ['status', '--porcelain=v1'])).toEqual(sourceBefore)
    await gitExec(source, ['branch', '-m', 'cline/renamed'])
    await expect(service.create(input, execution)).rejects.toMatchObject({ code: 'WORKTREE_DRIFT' })
    expect(api.createPullRequest).toHaveBeenCalledTimes(1)
  } finally { await cleanupTempRepo(root); await cleanupTempRepo(external) }
}, 300000)
