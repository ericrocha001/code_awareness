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
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../continuum/agent-authority'
import { GitHubPullRequests } from '../github/github-pull-requests'
import { GitHubPrIntegration } from '../github/github-pr-integration'
import type { GitHubIntegrationService } from '../github/github-integration-service'
import type { PullRequestSummary } from '../../shared/types/github-pr-types'
import { evaluatePullRequestPolicy } from '../github/github-pr-evidence'
import { SettingsService } from '../core/settings-service'
import { GitDeliveryTrustPolicy } from './git-delivery-trust-policy'
import { GitWorktreeValidation } from './git-worktree-validation'
import { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'
import type { ValidationLedger } from '../validation-ledger/validation-ledger'
import type { RecordProofInput, ValidationProof } from '../validation-ledger/validation-ledger-types'

const local = vi.hoisted(() => ({ profile: '' }))
vi.mock('electron', () => ({ app: { getPath: () => local.profile } }))

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await cleanupTempRepo(root)
})

function createMemoryLedger(): ValidationLedger {
  const proofs = new Map<string, ValidationProof>()
  let seq = 0
  return {
    recordProof(input: RecordProofInput): ValidationProof {
      const proofId = `proof-${++seq}`
      const proof = {
        proofId,
        recordedAt: new Date().toISOString(),
        ...input
      } as ValidationProof
      proofs.set(proofId, proof)
      return proof
    },
    getProof(proofId: string): ValidationProof | null {
      return proofs.get(proofId) ?? null
    },
    listProofs: () => [...proofs.values()]
  } as unknown as ValidationLedger
}

async function createAutonomousFixture() {
  const userData = mkdtempSync(join(tmpdir(), 'git-auto-userdata-'))
  roots.push(userData)
  local.profile = userData

  const root = await createTempGitRepo()
  roots.push(root)
  const bareRemote = createTempDir('bare-remote-')
  roots.push(bareRemote)
  await gitExec(bareRemote, ['init', '--bare'])
  await gitExec(root, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'])
  await gitExec(root, ['remote', 'set-url', '--push', 'origin', bareRemote])

  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'fixture-repo',
    scripts: { typecheck: 'node -e "process.exit(0)"' }
  }, null, 2))
  writeFileSync(join(root, 'app.txt'), 'baseline\n')
  await stageAll(root)
  await commit(root, 'baseline')
  await gitExec(root, ['branch', '-M', 'main'])
  const git = new GitService()
  const mainHead = await git.resolveCommit(root, 'HEAD')
  await gitExec(root, ['push', '-u', 'origin', 'HEAD:main'])

  const siblingDir = createTempDir('sibling-wt-')
  roots.push(siblingDir)
  const siblingPath = join(siblingDir, 'sibling')
  await gitExec(root, ['worktree', 'add', '-b', 'sibling-branch', siblingPath])

  let active = true
  // Real SettingsService + real GitDeliveryTrustPolicy with NO gitDeliveryAutonomy grant!
  const settings = new SettingsService()
  expect(settings.loadSettings().gitDeliveryAutonomy).toBeUndefined()
  const trustPolicy = new GitDeliveryTrustPolicy(
    settings,
    () => (active ? { repositoryId: 'repo-1', path: root, revision: 1 } : null)
  )

  const approval = vi.fn(async () => {
    throw new Error('UNEXPECTED_HUMAN_APPROVAL_POPUP')
  })

  const runtime = new RuntimeIdentityProvider()
  const ledger = createMemoryLedger()
  const worktreeValidation = new GitWorktreeValidation(
    root,
    git,
    { repositoryId: 'repo-1', isActive: () => active },
    ledger,
    runtime
  )

  const service = new GitOperationsService(
    root,
    git,
    new GitHubGitTransport(null, git),
    { repositoryId: 'repo-1', isActive: () => active },
    false,
    approval,
    false,
    worktreeValidation
  )
  service.bindGitDeliveryPolicy(targetPath => trustPolicy.getPolicy({ repositoryId: 'repo-1', path: targetPath }))

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
    getDeliveryPolicy: (repositoryId: string) => trustPolicy.getPolicy({ repositoryId, path: root })
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
    trustPolicy,
    worktreeValidation,
    adapter,
    authority,
    principal,
    approval,
    prApprove,
    prApproveMutation,
    branchShas,
    prs,
    deactivate: () => { active = false },
    callTool
  }
}

describe('Autonomous Git & PR delivery via ChannelMcpAdapter (default policy, no manual opt-in)', () => {
  it('completes CREATE -> EDIT -> STAGE -> COMMIT -> VALIDATE -> PUSH -> PR -> MERGE -> RECONCILE without opt-in or human popups, and preserves replay after revocation', async () => {
    const f = await createAutonomousFixture()
    try {
    const discovered = await f.callTool('discover_worktrees', {})
    const mainWt = discovered.data.worktrees.find((w: any) => w.branch === 'main')
    const mainInspect = await f.callTool('inspect_worktree', { worktreeId: mainWt.worktreeId })

    // 1. CREATE worktree without lease or any gitDeliveryAutonomy setting
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

    // 3. STAGE + COMMIT checkpoint without lease
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

    // 4. REAL start_worktree_validation on clean checkpoint + observe PASSED/CURRENT
    const wtInspectVal = await f.callTool('inspect_worktree', { worktreeId: wt.worktreeId })
    const valStarted = await f.callTool('start_worktree_validation', {
      worktreeId: wt.worktreeId,
      operationId: 'op-validate-1',
      profileId: 'typecheck',
      snapshot: {
        branch: wtInspectVal.data.branch,
        head: wtInspectVal.data.head,
        indexRevision: wtInspectVal.data.indexRevision,
        worktreeRevision: wtInspectVal.data.worktreeRevision,
        operation: wtInspectVal.data.operation
      }
    })
    expect(valStarted.isError).toBe(false)
    let valResult: any
    for (let i = 0; i < 400; i++) {
      valResult = await f.callTool('get_worktree_validation', { runId: valStarted.data.runId })
      if (valResult.data.status !== 'RUNNING') break
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    expect(valResult.data.status).toBe('PASSED')
    expect(valResult.data.freshness).toBe('CURRENT')
    expect(valResult.data.proofId).toBeTruthy()

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

    // 6. CREATE PR without passing worktreeId (resolved from registry) and without popup
    const prCreated = await f.callTool('create_pull_request', {
      headBranch: 'feat/auto-delivery',
      baseBranch: 'main',
      expectedHeadSha: headSha,
      title: 'feat: autonomous delivery',
      body: 'Autonomous PR body',
      operationId: 'op-pr-create-1'
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

    // 8. Reconcile by operationId even AFTER explicit revocation to SUPERVISED
    await f.trustPolicy.choose('SUPERVISED')
    const prReconciled = await f.callTool('get_pull_request_operation', { operationId: 'op-pr-merge-1' })
    expect(prReconciled.isError).toBe(false)
    expect(prReconciled.data.status).toBe('MERGED')
    const gitReplay = await f.callTool('mutate_worktree', {
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
    expect(gitReplay.isError).toBe(false)
    expect(gitReplay.data.sha).toBe(headSha)

    // Main and sibling remained untouched, and zero human approval callbacks were invoked
    expect(readFileSync(join(f.root, 'app.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('baseline\n')
    expect(readFileSync(join(f.siblingPath, 'app.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('baseline\n')
    expect(f.approval).not.toHaveBeenCalled()
    expect(f.prApprove).not.toHaveBeenCalled()
    expect(f.prApproveMutation).not.toHaveBeenCalled()
    } finally {
      await f.worktreeValidation.shutdown()
    }
  }, 150000)

  it('enforces isolation, PR scope, and revocation without popup fallback', async () => {
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

    // Create a session-bound autonomous worktree
    const created = await f.callTool('manage_worktree', {
      action: 'CREATE', worktreeId: mainWt.worktreeId, operationId: 'iso-create', branch: 'feat/isolated', startPoint: f.mainHead, snapshot: mainSnap
    })
    expect(created.isError).toBe(false)
    const wt = created.data.worktree
    const wtInspect = await f.callTool('inspect_worktree', { worktreeId: wt.worktreeId })
    const wtSnap = {
      branch: wtInspect.data.branch,
      head: wtInspect.data.head,
      indexRevision: wtInspect.data.indexRevision,
      worktreeRevision: wtInspect.data.worktreeRevision,
      operation: wtInspect.data.operation
    }

    // Un-witnessed authority MUST NOT bypass sessionId isolation (neither mutate_worktree nor edit_worktree_text)
    const unwitnessed = authorizeArtifactAgent(f.principal, 'repo-1', () => true)
    const bypassMutate = await f.callTool('mutate_worktree', {
      action: 'STAGE', worktreeId: wt.worktreeId, operationId: 'iso-bypass-stage', paths: ['app.txt'], snapshot: wtSnap
    }, unwitnessed)
    expect(bypassMutate.isError).toBe(true)
    expect(bypassMutate.data.code).toBe('WORKTREE_OWNERSHIP_REQUIRED')

    const fileRead = await f.callTool('read_worktree_file', { worktreeId: wt.worktreeId, path: 'app.txt', startLine: 1, endLine: 1 })
    const bypassEdit = await f.callTool('edit_worktree_text', {
      worktreeId: wt.worktreeId, generation: wt.generation, operationId: 'iso-bypass-edit', snapshot: wtSnap,
      intent: { description: 'Unauthorized edit' },
      changes: [{ operation: 'EDIT', path: 'app.txt', expectedSha256: fileRead.data.fileRevision, replacements: [{ oldText: 'baseline', newText: 'hijack' }] }]
    }, unwitnessed)
    expect(bypassEdit.isError).toBe(true)
    expect(bypassEdit.data.code).toBe('WORKTREE_OWNERSHIP_REQUIRED')

    // External unmanaged worktree (sibling) cannot be mutated or turned into an autonomous PR
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

    f.branchShas.set('sibling-branch', f.mainHead)
    const externalPr = await f.callTool('create_pull_request', {
      headBranch: 'sibling-branch', baseBranch: 'main', expectedHeadSha: f.mainHead,
      title: 'External PR', body: 'Should fail', operationId: 'neg-ext-pr'
    })
    expect(externalPr.isError).toBe(true)
    expect(externalPr.data.code).toBe('WORKTREE_DRIFT')

    // Non-default base branch rejected in autonomous PR
    f.branchShas.set('feat/isolated', f.mainHead)
    const badBasePr = await f.callTool('create_pull_request', {
      headBranch: 'feat/isolated', baseBranch: 'release', expectedHeadSha: f.mainHead,
      title: 'Bad base', body: 'Should fail', operationId: 'neg-bad-base'
    })
    expect(badBasePr.isError).toBe(true)
    expect(badBasePr.data.code).toBe('POLICY_BLOCKED')

    // Explicit SUPERVISED revocation blocks both Git and PR without calling popups
    await f.trustPolicy.choose('SUPERVISED')
    const revokedCreate = await f.callTool('manage_worktree', {
      action: 'CREATE', worktreeId: mainWt.worktreeId, operationId: 'neg-revoked', branch: 'feat/revoked', startPoint: f.mainHead, snapshot: mainSnap
    })
    expect(revokedCreate.isError).toBe(true)
    expect(revokedCreate.data.code).toBe('WORKTREE_OWNERSHIP_REQUIRED')

    const revokedPr = await f.callTool('create_pull_request', {
      headBranch: 'feat/isolated', baseBranch: 'main', expectedHeadSha: f.mainHead,
      title: 'Revoked PR', body: 'Should fail', operationId: 'neg-revoked-pr'
    })
    expect(revokedPr.isError).toBe(true)
    expect(revokedPr.data.code).toBe('AUTHORIZATION_DENIED')

    expect(f.approval).not.toHaveBeenCalled()
    expect(f.prApprove).not.toHaveBeenCalled()
    expect(f.prApproveMutation).not.toHaveBeenCalled()
  }, 60000)
})
