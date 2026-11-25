import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitService } from '../core/git-service'
import { cleanupTempRepo, commit, createTempDir, createTempGitRepo, gitExec, stageAll } from '../core/git-test-helpers'
import { GitHubGitTransport } from '../github/github-git-transport'
import { GitOperationsService } from './git-operations-service'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import type { GitDeliveryMode, GitDeliveryPolicy } from '../../shared/types/git-delivery-policy-types'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../continuum/agent-authority'
import { GitHubPullRequests } from '../github/github-pull-requests'
import { GitHubPrIntegration } from '../github/github-pr-integration'
import type { GitHubIntegrationService } from '../github/github-integration-service'
import type { PullRequestSummary } from '../../shared/types/github-pr-types'
import { evaluatePullRequestPolicy } from '../github/github-pr-evidence'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await cleanupTempRepo(root)
})

async function createAutonomousFixture() {
  const root = await createTempGitRepo()
  roots.push(root)
  const bareRemote = createTempDir('bare-remote-')
  roots.push(bareRemote)
  await gitExec(bareRemote, ['init', '--bare'])
  await gitExec(root, ['remote', 'add', 'origin', bareRemote])

  const git = new GitService()
  writeFileSync(join(root, 'app.txt'), 'baseline\n')
  await stageAll(root)
  await commit(root, 'baseline')
  await gitExec(root, ['branch', '-M', 'main'])
  const mainHead = await git.resolveCommit(root, 'HEAD')
  await gitExec(root, ['push', '-u', 'origin', 'HEAD:main'])

  const siblingDir = createTempDir('sibling-wt-')
  roots.push(siblingDir)
  const siblingPath = join(siblingDir, 'sibling')
  await gitExec(root, ['worktree', 'add', '-b', 'sibling-branch', siblingPath])

  let active = true
  let policyMode: GitDeliveryMode = 'AUTONOMOUS'
  let allowedRemotes = ['origin']
  const getDeliveryPolicy = (): GitDeliveryPolicy => ({
    mode: policyMode,
    revision: `rev-${policyMode}`,
    rule: policyMode === 'AUTONOMOUS' ? 'local-repository-git-delivery-trust' : 'native-operation-consent',
    allowedRemotes: policyMode === 'AUTONOMOUS' ? allowedRemotes : []
  })

  const approval = vi.fn(async () => {
    throw new Error('UNEXPECTED_HUMAN_APPROVAL_POPUP')
  })

  const service = new GitOperationsService(
    root,
    git,
    new GitHubGitTransport(null, git),
    { repositoryId: 'repo-1', isActive: () => active },
    false,
    approval
  )
  service.bindGitDeliveryPolicy(() => getDeliveryPolicy())

  const receiptDirectory = mkdtempSync(join(tmpdir(), 'pr-auto-'))
  roots.push(receiptDirectory)
  const prApprove = vi.fn(async () => {
    throw new Error('UNEXPECTED_PR_APPROVAL_POPUP')
  })
  const prApproveMutation = vi.fn(async () => {
    throw new Error('UNEXPECTED_PR_MUTATION_POPUP')
  })

  const prs = new Map<number, PullRequestSummary>()
  const branchShas = new Map<string, string>([['main', mainHead!]])
  let nextPrNumber = 10
  let prMerged = false
  const api = {
    getRepository: vi.fn(async () => ({ repositoryId: 1, fullName: 'owner/repo' })),
    getPullRequestPermissions: vi.fn(async () => ({ create: true })),
    getPullRequestEndpointPermissions: vi.fn(async () => ({ read: true, close: true, merge: true, checks: true, statuses: true })),
    getBranchSha: vi.fn(async (_repo: string, ref: string) => branchShas.get(ref) ?? null),
    listPullRequests: vi.fn(async (_repo: string, query: { headBranch?: string; baseBranch?: string; state?: string }) => ({
      pullRequests: [...prs.values()].filter(p =>
        (!query.headBranch || p.head.ref === query.headBranch) &&
        (!query.baseBranch || p.base.ref === query.baseBranch) &&
        (!query.state || query.state === 'all' || p.state === query.state)
      ),
      nextCursor: null
    })),
    createPullRequest: vi.fn(async (_repo: string, input: { headBranch: string; baseBranch: string; expectedHeadSha: string; title: string; body: string }, beforeSend?: () => void) => {
      beforeSend?.()
      const num = nextPrNumber++
      const created: PullRequestSummary = {
        number: num,
        url: `https://github.com/owner/repo/pull/${num}`,
        title: input.title,
        state: 'open',
        draft: false,
        head: { ref: input.headBranch, sha: input.expectedHeadSha, repository: 'owner/repo' },
        base: { ref: input.baseBranch, sha: mainHead!, repository: 'owner/repo' },
        mergedAt: null,
        mergeability: 'MERGEABLE',
        stack: 'NONE',
        observedAt: new Date().toISOString()
      }
      prs.set(num, created)
      return created
    }),
    getPullRequest: vi.fn(async (_repo: string, number: number) => {
      const found = prs.get(number)
      if (!found) throw new Error('NOT_FOUND')
      return prMerged ? { ...found, state: 'closed' as const, mergedAt: new Date().toISOString(), mergeCommitSha: 'c'.repeat(40) } : found
    }),
    getPullRequestReviews: vi.fn(async (_repo: string, number: number) => ({
      headSha: prs.get(number)!.head.sha,
      completeness: 'COMPLETE' as const,
      decision: 'APPROVED' as const,
      approvalCount: 1
    })),
    getPullRequestChecks: vi.fn(async (_repo: string, number: number) => ({
      headSha: prs.get(number)!.head.sha,
      completeness: 'COMPLETE' as const,
      checks: [{ name: 'ci', state: 'PASSED' as const, required: true }]
    })),
    getPullRequestPolicy: vi.fn(async () => evaluatePullRequestPolicy([], null, { allow_merge_commit: true })),
    getPullRequestStackEvidence: vi.fn(async () => ({ state: 'NONE' as const })),
    requestPullRequestMerge: vi.fn(async (_repo: string, _num: number, headSha: string, _queue: boolean, beforeSend: () => Promise<void>) => {
      await beforeSend()
      prMerged = true
      return {
        httpStatus: 202,
        value: {
          status: 'pending',
          details: { uuid: '11111111-1111-4111-8111-111111111111', expected_head_sha: headSha, bypass_rules: false, merge_action: 'default', merge_method: 'merge' }
        }
      }
    }),
    getPullRequestMergeRequest: vi.fn(async () => ({
      response: { status: 200 },
      value: { status: prMerged ? 'merged' : 'pending' }
    })),
    closePullRequest: vi.fn()
  }

  const prContext = async () => ({ repositoryId: 'repo-1', repository: 'owner/repo' })
  const prDeps = {
    receiptDirectory,
    approve: prApprove,
    approveMutation: prApproveMutation,
    getDeliveryPolicy: () => getDeliveryPolicy()
  }
  const prService = new GitHubPullRequests(api as any, prContext, prDeps)
  const prIntegration = new GitHubPrIntegration(api as any, prContext, prDeps)
  const githubIntegration = {
    canCreatePullRequests: () => true,
    canIntegratePullRequests: () => true,
    createPullRequest: (_repoPath: string, input: any, execution: any) => prService.create(input, execution),
    mutatePullRequest: (_repoPath: string, op: any, input: any, execution: any) => prIntegration.mutate(op, input, execution),
    getPullRequestOperation: (_repoPath: string, operationId: string) => prIntegration.status(operationId),
    getPullRequest: (_repoPath: string, num: number) => api.getPullRequest('owner/repo', num),
    getPullRequestAccess: vi.fn(),
    listPullRequests: vi.fn(),
    getPullRequestReviews: vi.fn(),
    getPullRequestChecks: vi.fn()
  } as unknown as GitHubIntegrationService

  const navigation = { dispose: () => {}, getProjectId: () => 'repo-1' } as unknown as ProjectContextNavigation
  const adapter = new ChannelMcpAdapter({
    projectId: 'repo-1',
    navigation,
    repoRoot: root,
    gitOperations: service,
    githubIntegration,
    githubPrIsActive: () => active
  })

  const principal = authenticatedAgentPrincipal('MCP', () => active)
  const authority = authorizeArtifactAgent(principal, 'repo-1', () => active, undefined, {
    sessionWitness: { provider: 'codex', sessionId: 'sess-1' }
  })

  const callTool = async (name: string, args: Record<string, unknown>, auth = authority) => {
    const res = await adapter.callTool(name, args, undefined, auth)
    return { isError: Boolean(res.isError), data: JSON.parse(res.content[0].type === 'text' ? res.content[0].text : '{}') }
  }

  return {
    root,
    bareRemote,
    siblingPath,
    mainHead: mainHead!,
    git,
    service,
    adapter,
    authority,
    principal,
    approval,
    prApprove,
    prApproveMutation,
    branchShas,
    setPolicyMode: (mode: GitDeliveryMode) => { policyMode = mode },
    setAllowedRemotes: (remotes: string[]) => { allowedRemotes = remotes },
    deactivate: () => { active = false },
    callTool
  }
}

describe('Autonomous Git & PR delivery via ChannelMcpAdapter', () => {
  it('completes CREATE -> EDIT -> STAGE -> COMMIT -> PUSH -> PR -> MERGE -> RECONCILE without human approval popups', async () => {
    const f = await createAutonomousFixture()
    const discovered = await f.callTool('discover_worktrees', {})
    const mainWt = discovered.data.worktrees.find((w: any) => w.branch === 'main')
    const mainInspect = await f.callTool('inspect_worktree', { worktreeId: mainWt.worktreeId })

    // 1. CREATE worktree without lease
    const created = await f.callTool('manage_worktree', {
      action: 'CREATE',
      worktreeId: mainWt.worktreeId,
      operationId: 'op-create-1',
      branch: 'feat/auto-delivery',
      startPoint: f.mainHead,
      snapshot: {
        branch: mainInspect.data.branch,
        head: mainInspect.data.head,
        indexRevision: mainInspect.data.indexRevision,
        worktreeRevision: mainInspect.data.worktreeRevision,
        operation: mainInspect.data.operation
      }
    })
    expect(created.isError).toBe(false)
    expect(created.data.result).toBe('CREATED')
    expect(created.data.managed).toBe(true)
    const wt = created.data.worktree

    // 2. EDIT text autonomously
    const wtInspect1 = await f.callTool('inspect_worktree', { worktreeId: wt.worktreeId })
    const fileRead = await f.callTool('read_worktree_file', { worktreeId: wt.worktreeId, path: 'app.txt', startLine: 1, endLine: 1 })
    expect(fileRead.isError).toBe(false)
    const edited = await f.callTool('edit_worktree_text', {
      worktreeId: wt.worktreeId,
      generation: wt.generation,
      operationId: 'op-edit-1',
      snapshot: {
        branch: wtInspect1.data.branch,
        head: wtInspect1.data.head,
        indexRevision: wtInspect1.data.indexRevision,
        worktreeRevision: wtInspect1.data.worktreeRevision,
        operation: wtInspect1.data.operation
      },
      intent: { description: 'Update app.txt autonomously' },
      changes: [{
        operation: 'EDIT',
        path: 'app.txt',
        expectedSha256: fileRead.data.fileRevision,
        replacements: [{ oldText: 'baseline', newText: 'autonomous-v2' }]
      }]
    })
    expect(edited.isError).toBe(false)
    expect(edited.data.state).toBe('APPLIED')

    // 3. STAGE without lease
    const wtInspect2 = await f.callTool('inspect_worktree', { worktreeId: wt.worktreeId })
    const staged = await f.callTool('mutate_worktree', {
      action: 'STAGE',
      worktreeId: wt.worktreeId,
      operationId: 'op-stage-1',
      paths: ['app.txt'],
      snapshot: {
        branch: wtInspect2.data.branch,
        head: wtInspect2.data.head,
        indexRevision: wtInspect2.data.indexRevision,
        worktreeRevision: wtInspect2.data.worktreeRevision,
        operation: wtInspect2.data.operation
      }
    })
    expect(staged.isError).toBe(false)

    // 4. COMMIT without lease
    const wtInspect3 = await f.callTool('inspect_worktree', { worktreeId: wt.worktreeId })
    const committed = await f.callTool('mutate_worktree', {
      action: 'COMMIT',
      worktreeId: wt.worktreeId,
      operationId: 'op-commit-1',
      message: 'feat: autonomous delivery',
      snapshot: {
        branch: wtInspect3.data.branch,
        head: wtInspect3.data.head,
        indexRevision: wtInspect3.data.indexRevision,
        worktreeRevision: wtInspect3.data.worktreeRevision,
        operation: wtInspect3.data.operation
      }
    })
    expect(committed.isError).toBe(false)
    const headSha = committed.data.sha
    expect(headSha).toMatch(/^[a-f0-9]{40}$/)
    f.branchShas.set('feat/auto-delivery', headSha)

    // 5. PUSH without lease
    const wtInspect4 = await f.callTool('inspect_worktree', { worktreeId: wt.worktreeId })
    const pushed = await f.callTool('publish_worktree', {
      worktreeId: wt.worktreeId,
      operationId: 'op-push-1',
      branch: 'feat/auto-delivery',
      remote: 'origin',
      snapshot: {
        branch: wtInspect4.data.branch,
        head: wtInspect4.data.head,
        indexRevision: wtInspect4.data.indexRevision,
        worktreeRevision: wtInspect4.data.worktreeRevision,
        operation: wtInspect4.data.operation
      }
    })
    expect(pushed.isError).toBe(false)
    expect(pushed.data).toMatchObject({ result: 'PUBLISHED', branch: 'feat/auto-delivery', pushedHead: headSha })

    // 6. CREATE PR without popup
    const prCreated = await f.callTool('create_pull_request', {
      headBranch: 'feat/auto-delivery',
      baseBranch: 'main',
      expectedHeadSha: headSha,
      title: 'feat: autonomous delivery',
      body: 'Autonomous PR body',
      operationId: 'op-pr-create-1',
      worktreeId: wt.worktreeId
    })
    expect(prCreated.isError).toBe(false)
    expect(prCreated.data.status).toBe('CREATED')
    const prNumber = prCreated.data.pullRequest.number

    // 7. MERGE PR without popup
    const prMerged = await f.callTool('merge_pull_request', {
      prNumber,
      operationId: 'op-pr-merge-1',
      expectedHeadSha: headSha,
      expectedBaseSha: f.mainHead
    })
    expect(prMerged.isError).toBe(false)
    expect(prMerged.data.status).toBe('MERGED')

    // 8. Reconcile by operationId
    const prReconciled = await f.callTool('get_pull_request_operation', { operationId: 'op-pr-merge-1' })
    expect(prReconciled.isError).toBe(false)
    expect(prReconciled.data.status).toBe('MERGED')

    // Main and sibling remained untouched, and zero human approval callbacks were invoked
    expect(readFileSync(join(f.root, 'app.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('baseline\n')
    expect(readFileSync(join(f.siblingPath, 'app.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('baseline\n')
    expect(f.approval).not.toHaveBeenCalled()
    expect(f.prApprove).not.toHaveBeenCalled()
    expect(f.prApproveMutation).not.toHaveBeenCalled()
  }, 90000)

  it('enforces negative boundaries: revoked trust, main protection, CLOSE requires lease, partial lease pair rejected, close_pull_request requires approval', async () => {
    const f = await createAutonomousFixture()
    const discovered = await f.callTool('discover_worktrees', {})
    const mainWt = discovered.data.worktrees.find((w: any) => w.branch === 'main')
    const siblingWt = discovered.data.worktrees.find((w: any) => w.branch === 'sibling-branch')
    const mainInspect = await f.callTool('inspect_worktree', { worktreeId: mainWt.worktreeId })
    const mainSnap = {
      branch: mainInspect.data.branch,
      head: mainInspect.data.head,
      indexRevision: mainInspect.data.indexRevision,
      worktreeRevision: mainInspect.data.worktreeRevision,
      operation: mainInspect.data.operation
    }

    // Protected branch main cannot be created
    const mainBranchRes = await f.callTool('manage_worktree', {
      action: 'CREATE', worktreeId: mainWt.worktreeId, operationId: 'neg-main', branch: 'main', startPoint: f.mainHead, snapshot: mainSnap
    })
    expect(mainBranchRes.isError).toBe(true)
    expect(mainBranchRes.data.code).toBe('WORKTREE_BRANCH_PROTECTED')

    // Partial lease pair rejected (never falls back to autonomous)
    const partialLease = await f.callTool('manage_worktree', {
      action: 'CREATE', worktreeId: mainWt.worktreeId, leaseId: 'lease-only', operationId: 'neg-partial', branch: 'feat/ok', startPoint: f.mainHead, snapshot: mainSnap
    })
    expect(partialLease.isError).toBe(true)
    expect(partialLease.data.code).toBe('INVALID_ARGUMENT')

    // CLOSE without lease is rejected
    const closeNoLease = await f.callTool('manage_worktree', {
      action: 'CLOSE', worktreeId: siblingWt.worktreeId, operationId: 'neg-close', preservedBranch: 'main', snapshot: mainSnap
    })
    expect(closeNoLease.isError).toBe(true)
    expect(closeNoLease.data.code).toBe('WORKTREE_OWNERSHIP_REQUIRED')

    // External unmanaged worktree (sibling) cannot be mutated autonomously
    const siblingInspect = await f.callTool('inspect_worktree', { worktreeId: siblingWt.worktreeId })
    const siblingMutate = await f.callTool('mutate_worktree', {
      action: 'STAGE', worktreeId: siblingWt.worktreeId, operationId: 'neg-unmanaged', paths: ['app.txt'],
      snapshot: {
        branch: siblingInspect.data.branch,
        head: siblingInspect.data.head,
        indexRevision: siblingInspect.data.indexRevision,
        worktreeRevision: siblingInspect.data.worktreeRevision,
        operation: siblingInspect.data.operation
      }
    })
    expect(siblingMutate.isError).toBe(true)
    expect(siblingMutate.data.code).toBe('WORKTREE_NOT_MANAGED')

    // Revoking trust blocks CREATE immediately without calling approval popup
    f.setPolicyMode('SUPERVISED')
    const revokedCreate = await f.callTool('manage_worktree', {
      action: 'CREATE', worktreeId: mainWt.worktreeId, operationId: 'neg-revoked', branch: 'feat/revoked', startPoint: f.mainHead, snapshot: mainSnap
    })
    expect(revokedCreate.isError).toBe(true)
    expect(revokedCreate.data.code).toBe('WORKTREE_OWNERSHIP_REQUIRED')
    expect(f.approval).not.toHaveBeenCalled()

    // Different repositoryId in authority is rejected
    f.setPolicyMode('AUTONOMOUS')
    const otherAuth = authorizeArtifactAgent(f.principal, 'repo-other', () => true)
    const wrongRepo = await f.callTool('manage_worktree', {
      action: 'CREATE', worktreeId: mainWt.worktreeId, operationId: 'neg-repo', branch: 'feat/wrong-repo', startPoint: f.mainHead, snapshot: mainSnap
    }, otherAuth)
    expect(wrongRepo.isError).toBe(true)
    expect(wrongRepo.data.code).toBe('REPOSITORY_MISMATCH')
  }, 30000)
})
