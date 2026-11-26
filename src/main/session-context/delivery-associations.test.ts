import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { ArtifactStore } from '../continuum/artifact-store'
import { ContinuumService } from '../continuum/continuum-service'
import { storedLegacyArtifact, storedLegacyIdentity } from '../continuum/continuum-test-fixtures'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../continuum/agent-authority'
import { GitHubPullRequests, pullRequestDeliveryPage } from '../github/github-pull-requests'
import { GitService } from '../core/git-service'
import { createTempGitRepo, cleanupTempRepo, gitExec } from '../core/git-test-helpers'
import { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'
import { GitBranchInventory } from '../git-operations/git-branch-inventory'
import { GitOperationReceipts, gitReceiptFingerprint } from '../git-operations/git-operation-receipts'
import { executeGitOperationsTool } from '../git-operations/git-operations-mcp'
import { mkdirSync, writeFileSync } from 'node:fs'
import { GitOperationsService } from '../git-operations/git-operations-service'
import { GitLocalAdapter } from '../git-operations/local-adapter'
import { GitHubLocalAdapter } from '../github/local-adapter'
import { ValidationLedger } from '../validation-ledger/validation-ledger'
import { SessionStore, sessionStorePath } from './store'
import { registrySources, handoffTargets } from './registry-sources'
import { executeSessionTool } from './mcp'
import { nativeDigest, nativeGitIdentity, normalizeNativeHook, prepareNativeSpool, type NativeHookBinding } from './native-hooks'
import { correlateNativeArtifact } from './native-artifact-correlation'
import { startCaptureFixture } from './fixtures/native-capture-fixture'
import { nativeObservationBatch } from './native-hook-ingestion'
import { stampNativeCapture } from './native-capture-window'
import { correlateNativeGit } from './native-git-correlation'
import Database from 'better-sqlite3'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const root = await createTempGitRepo(); cleanup.push(() => cleanupTempRepo(root))
  await gitExec(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']); await gitExec(root, ['commit', '--allow-empty', '-m', 'base'])
  const git = new GitService(), identity = { repositoryId: 'fixture', isActive: () => active }
  let active = true
  const trees = new GitWorktreeRegistry(root, git, identity), reader = new GitBranchInventory(root, git, trees, identity)
  const tree = (await reader.inventory()).worktrees[0], observe = () => reader.executionSnapshot(tree.worktreeId, tree.generation)
  const store = new ArtifactStore(join(root, '.git', 'artifacts.db'), 'fixture'); cleanup.push(async () => store.close())
  const service = new ContinuumService(store, undefined, () => active)
  const plan = storedLegacyArtifact(store, '---\nname: Plan\ndescription: Delivery fixture\nkind: EXECUTABLE_PLAN\nexecutionId: execution-A\n---\nPRIVATE_PLAN')
  storedLegacyIdentity(join(root, '.git', 'artifacts.db'), plan, 'execution-A')
  const binding = await service.bindExecutionBranch('execution-A', plan.artifactId, observe)
  const request = { bindingArtifactId: binding.artifactId, bindingRevision: binding.revision, planArtifactId: plan.artifactId, planRevision: plan.revision, executionId: 'execution-A' }
  const authority = authorizeArtifactAgent(authenticatedAgentPrincipal('MCP', () => active), 'fixture', () => active, tree.worktreeId)
  const prepare = () => service.prepareDeliveryContext(authority, request, observe)
  return { root, git, service, store, plan, binding, request, authority, observe, prepare, switchContext: () => { active = false } }
}
it('requires canonical authenticated binding, exact revisions and scope; branch uniqueness grants nothing', async () => {
  const f = await fixture(), snapshot = await f.observe()
  await expect(f.service.prepareDeliveryContext(undefined, f.request, f.observe)).rejects.toThrow('AGENT_UNAUTHORIZED')
  await expect(f.service.prepareDeliveryContext({ ...f.authority }, f.request, f.observe)).rejects.toThrow('AGENT_UNAUTHORIZED')
  const fake = storedLegacyArtifact(f.store, '---\nname: Impostor\ndescription: Fixture\nkind: OBSERVATION\nbindingRole: EXECUTION_BRANCH\n---\nDeclaration')
  await expect(f.service.prepareDeliveryContext(f.authority, { ...f.request, bindingArtifactId: fake.artifactId }, f.observe)).rejects.toThrow()
  await expect(f.service.prepareDeliveryContext(f.authority, { ...f.request, planRevision: 2 }, f.observe)).rejects.toThrow('DELIVERY_CONTEXT_STALE')
  for (const key of ['worktreeId', 'worktreeGeneration', 'branchGeneration'] as const) await expect(f.service.prepareDeliveryContext(f.authority, f.request, async () => ({ ...snapshot, [key]: 'f'.repeat(64) }))).rejects.toThrow('DELIVERY_CONTEXT_STALE')
  const second = storedLegacyArtifact(f.store, '---\nname: Plan B\ndescription: Fixture\nkind: EXECUTABLE_PLAN\nexecutionId: execution-B\n---\nB')
  storedLegacyIdentity(join(f.root, '.git', 'artifacts.db'), second, 'execution-B')
  await f.service.bindExecutionBranch('execution-B', second.artifactId, f.observe)
  expect((await f.prepare()).executionId).toBe('execution-A')
  await expect(f.service.prepareDeliveryContext(f.authority, { ...f.request, executionId: 'execution-B' }, f.observe)).rejects.toThrow('DELIVERY_CONTEXT_INVALID')
}, 60000)
async function operation(f: Awaited<ReturnType<typeof fixture>>, operationId: string, drift?: () => Promise<void>) {
  const before = await f.observe()
  const mutate = async () => {
    await drift?.(); await gitExec(f.root, ['commit', '--allow-empty', '-m', 'delivery'])
    return { value: { sha: await f.git.getCurrentCommitHash(f.root), parent: before.head } }
  }
  const receipts = new GitOperationReceipts(f.root, f.git)
  const result = await receipts.executeResult(operationId, 'commit_git_changes', { deliveryContext: f.request }, mutate, f.prepare)
  return { result, receipt: (await f.git.readOperationReceipt(f.root, operationId))!.receipt, replay: () => receipts.executeResult(operationId, 'commit_git_changes', { deliveryContext: f.request }, async () => { throw new Error('REPEATED_MUTATION') }, f.prepare) }
}
it('seals completed operation context, survives restart/replay and never upgrades it to session authorship', async () => {
  const f = await fixture(), op = await operation(f, 'complete')
  expect(op.receipt.deliveryVerified).toBe(true)
  f.switchContext()
  expect((await op.replay()).value).toMatchObject({ replayed: true, sha: op.result.value.sha })
  expect((await f.git.readOperationReceipt(f.root, 'complete'))!.receipt.deliveryContext).toEqual(op.receipt.deliveryContext)
}, 60000)
it.each(['branch', 'plan', 'context'])('retains Git receipt but refuses association on %s drift around mutation', async scenario => {
  const f = await fixture()
  const op = await operation(f, 'drift', async () => {
    if (scenario === 'branch') await gitExec(f.root, ['switch', '-c', 'other'])
    if (scenario === 'plan') f.service.update(f.plan.artifactId, 1, f.service.get(f.plan.artifactId)!.rawMarkdown.replace('PRIVATE_PLAN', 'Updated'))
    if (scenario === 'context') f.switchContext()
  })
  expect(op.receipt.status).toBe('COMPLETED'); expect(op.receipt.deliveryVerified).toBe(false)
}, 60000)
it('projects governed delivery and GitHub membership bidirectionally through MCP and SQLite after restart', async () => {
  const f = await fixture(), op = await operation(f, 'graph'), sha = String(op.result.value.sha)
  const handoff = f.service.publish('---\nname: Handoff\ndescription: Fixture\nkind: IMPLEMENTATION_HANDOFF\nrelations:\n  - artifactId: ' + f.plan.artifactId + '\n    kind: implements\n---\nPRIVATE_HANDOFF')
  let sessions = new SessionStore(sessionStorePath(f.root, 'fixture'), 'fixture'); cleanup.push(async () => sessions.close())
  const ledger = new ValidationLedger(join(f.root, '.git', 'validation.db')); cleanup.push(async () => ledger.close())
  const proof = ledger.recordProof({ kind: 'TARGETED_TEST', producer: 'IMPLEMENTER', status: 'PASSED',
    startedAt: '2026-11-03T22:00:00Z', finishedAt: '2026-11-03T22:00:01Z', durationMs: 1000, scope: ['fixture'], summary: 'fixture', evidenceFor: [f.plan.artifactId] })
  const receiptDirectory = join(f.root, '.git', 'pr-receipts'), repository = 'owner/repo', context = { repositoryId: 'fixture', repository }
  const before = await f.observe()
  let created = false, member = true, head = sha, merge = false, fork = false
  const mergeCommit = '3'.repeat(40)
  const pr = () => ({ number: 111, url: 'https://github.com/owner/repo/pull/111', title: 'Fixture', state: merge ? 'closed' as const : 'open' as const, draft: false,
    head: { ref: 'main', repository: fork ? 'fork/repo' : repository, sha: head }, base: { ref: 'release', repository, sha: 'e'.repeat(40) }, mergeability: 'UNKNOWN' as const, mergedAt: merge ? '2026-11-04T22:00:00Z' : null, ...(merge ? { lifecycle: 'MERGED' as const, mergeCommitSha: mergeCommit } : {}), observedAt: new Date().toISOString() })
  const api = { getPullRequestPermissions: async () => ({ create: true }), getBranchSha: async () => sha,
    listPullRequests: async () => ({ pullRequests: created ? [pr()] : [] }), getPullRequest: async () => pr(),
    createPullRequest: async () => { created = true; return pr() } }
  const onDeliveryObserved = vi.fn()
  const pullRequests = new GitHubPullRequests(api as any, async () => context, { receiptDirectory, approve: async () => true, onDeliveryObserved })
  await pullRequests.create({ headBranch: 'main', baseBranch: 'release', expectedHeadSha: sha, title: 'Fixture', body: 'PRIVATE_PR_BODY', operationId: 'create-pr-111', worktreeId: before.worktreeId, deliveryContext: f.request },
    { isActive: () => true, inspectWorktree: async () => ({ branch: 'main', head: sha }), prepareDelivery: request => f.service.prepareDeliveryContext(f.authority, request, f.observe) })
  expect(pullRequestDeliveryPage(receiptDirectory, 'fixture').observations).toHaveLength(1)
  expect(onDeliveryObserved).toHaveBeenCalledExactlyOnceWith('fixture')
  const github = { deliveryRepository: async () => 'owner/repo', commitPullRequests: async () => [111],
    getPullRequest: async () => ({ ...context, pullRequest: pr() }),
    deliveryProjectionPage: (id: string, cursor?: string) => pullRequestDeliveryPage(receiptDirectory, id, cursor),
    pullRequestCommits: async () => ({ repositoryId: 'fixture', repository: 'owner/repo', headSha: head, commits: member ? [{ sha }] : [], nextPage: null }) }
  const read = registrySources({ repositoryId: 'fixture', root: f.root, continuum: () => f.service, ledger, github: github as any, networkAllowed: () => true, assertCurrent: () => {} })
  const refreshFor = async (selector: { kind: 'ARTIFACT' | 'PR'; id: string }) => sessions.registry.applyAll(await read({ selector, neighbors: [], cursors: sessions.registry.cursors() }), () => {})
  const refresh = async () => { await refreshFor({ kind: 'ARTIFACT', id: handoff.artifactId }); await refreshFor({ kind: 'PR', id: '111' }) }
  const query = async (selector: object) => {
    const edges: any[] = [], paths: any[] = [], nodes: any[] = []
    let cursor: string | undefined
    for (let page = 0; page < 24; page++) {
      const response = await executeSessionTool(sessions, { refresh: vi.fn() }, 'discover_execution_context', { selector, depth: 4, mode: 'RELATION_DETAIL', limit: 24, ...(cursor ? { cursor } : {}) }, () => {}, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, true)
      expect(response.isError, response.content[0].text).toBeFalsy()
      const result = JSON.parse(response.content[0].text)
      edges.push(...result.edges); paths.push(...result.paths); nodes.push(...result.nodes)
      cursor = result.nextCursor
      if (!cursor) return { edges, paths, nodes, delivery: result.delivery }
    }
    throw new Error('UNBOUNDED_FIXTURE_PAGINATION')
  }
  await refresh()
  const forward = await query({ type: 'ARTIFACT', id: handoff.artifactId, revision: 1 })
  expect(forward.edges).toEqual(expect.arrayContaining([expect.objectContaining({ evidenceKind: 'GITHUB_COMMIT_LIST' })]))
  expect(forward.paths.some((p: any) => p.target.endsWith(sha) && p.evidenceClass === 'DERIVED' && p.weakestLink === 'DECLARED' && p.links.some((e: any) => e.source === 'DELIVERY_PR') && p.links.some((e: any) => e.evidenceKind === 'GITHUB_COMMIT_LIST'))).toBe(true)
  expect(forward.edges.some((e: any) => e.confidenceClass === 'VERIFIED_CAUSAL')).toBe(false)
  expect(forward.nodes.some((n: any) => n.id === proof.proofId)).toBe(true)
  expect(JSON.stringify(forward)).not.toContain('PRIVATE_')
  sessions.close(); sessions = new SessionStore(sessionStorePath(f.root, 'fixture'), 'fixture')
  const backward = await query({ type: 'COMMIT', id: sha })
  expect(backward.paths.some((p: any) => p.target.endsWith(handoff.artifactId + ':1') && p.weakestLink === 'DECLARED')).toBe(true)
  expect(backward.edges.some((e: any) => e.evidenceKind === 'OPERATION_EXECUTION_CONTEXT')).toBe(true)
  expect(backward.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: handoff.artifactId, title: 'Handoff', artifactKind: 'IMPLEMENTATION_HANDOFF' }),
    expect.objectContaining({ id: f.plan.artifactId, title: 'Plan', artifactKind: 'EXECUTABLE_PLAN' })]))
  const declared = (name: string, metadata: string) => f.service.publish('---\nname: ' + name + '\ndescription: Fixture\nkind: IMPLEMENTATION_HANDOFF\n' + metadata + '\n---\nMention PR #111.')
  const shaDeclared = declared('SHA declaration', 'headCommit: ' + sha + '\nsha: ' + sha)
  const prDeclared = declared('PR declaration', 'prNumber: 111\nprUrl: https://github.com/owner/repo/pull/111')
  const documented = f.service.publish('---\nname: Declared delivery\ndescription: Explicit delivery rationale\nkind: IMPLEMENTATION_HANDOFF\npullRequest: 111\nrelations:\n  - artifactId: ' + f.plan.artifactId + '\n    kind: implements\n---\nPRIVATE_DECLARED')
  const noPrMetadata = declared('Historical PR mention', '')
  const wrongRepo = declared('Foreign declaration', 'repository: fork/repo\ncommitSha: ' + sha + '\nprNumber: 111')
  for (const artifact of [shaDeclared, prDeclared, wrongRepo, documented, noPrMetadata]) await refreshFor({ kind: 'ARTIFACT', id: artifact.artifactId })
  const otherPlan = storedLegacyArtifact(f.store, '---\nname: Other plan\ndescription: Fixture\nkind: EXECUTABLE_PLAN\nexecutionId: execution-A\n---\nOther candidate')
  const unrelatedHandoff = f.service.publish('---\nname: Other handoff\ndescription: Fixture\nkind: IMPLEMENTATION_HANDOFF\nrelations:\n  - artifactId: ' + otherPlan.artifactId + '\n    kind: implements\n---\nOther candidate')
  await refreshFor({ kind: 'ARTIFACT', id: unrelatedHandoff.artifactId })
  const unrelated = await query({ type: 'ARTIFACT', id: unrelatedHandoff.artifactId, revision: 1 })
  expect(unrelated.delivery.state).not.toBe('DOCUMENTED')
  expect(unrelated.paths.some((path: any) => path.target.startsWith('PR:') && path.resolution === 'EVIDENCE_PATH')).toBe(false)
  const explicitSha = await query({ type: 'ARTIFACT', id: shaDeclared.artifactId, revision: 1 })
  expect(explicitSha.paths.some((p: any) => p.target === 'PR:fixture:111' && p.evidenceClass === 'DERIVED' && p.weakestLink === 'DECLARED')).toBe(true)
  const explicitPr = await query({ type: 'ARTIFACT', id: prDeclared.artifactId, revision: 1 })
  expect(explicitPr.edges).toEqual(expect.arrayContaining([expect.objectContaining({ evidenceKind: 'HANDOFF_DECLARED', to: 'PR:fixture:111' })]))
  const declaredChain = await query({ type: 'PR', id: '111' })
  expect(declaredChain.edges).toEqual(expect.arrayContaining([expect.objectContaining({ evidenceKind: 'GITHUB_COMMIT_LIST', from: 'COMMIT:fixture:' + sha }),
    expect.objectContaining({ evidenceKind: 'HANDOFF_DECLARED', from: 'ARTIFACT:fixture:' + documented.artifactId + ':1' }),
    expect.objectContaining({ evidenceKind: 'CONTINUUM_TYPED_RELATION', relation: 'implements', from: 'ARTIFACT:fixture:' + documented.artifactId + ':1' }),
    expect.objectContaining({ evidenceKind: 'LEDGER_EVIDENCE_FOR', to: 'PROOF:fixture:' + proof.proofId })]))
  expect(declaredChain.nodes.some((n: any) => n.id === noPrMetadata.artifactId)).toBe(false)
  expect(declaredChain.edges.some((e: any) => e.confidenceClass === 'VERIFIED_CAUSAL')).toBe(false)
  const foreign = await query({ type: 'ARTIFACT', id: wrongRepo.artifactId, revision: 1 })
  expect(foreign.edges.some((e: any) => e.evidenceKind === 'HANDOFF_DECLARED')).toBe(false)
  member = false; head = 'f'.repeat(40); merge = true; await refresh()
  const changed = await query({ type: 'PR', id: '111' })
  expect(changed.edges).toEqual(expect.arrayContaining([expect.objectContaining({ evidenceKind: 'GITHUB_COMMIT_LIST', state: 'STALE' }),
    expect.objectContaining({ evidenceKind: 'GITHUB_PR_MERGE', to: 'COMMIT:fixture:' + mergeCommit })]))
  expect(changed.edges.some((e: any) => e.evidenceKind === 'GITHUB_COMMIT_LIST' && e.from.endsWith(mergeCommit))).toBe(false)
  fork = true; await refresh()
  const forked = await query({ type: 'ARTIFACT', id: prDeclared.artifactId, revision: 1 })
  expect(forked.delivery.state).not.toBe('DOCUMENTED')
  expect(forked.edges).toEqual(expect.arrayContaining([expect.objectContaining({ evidenceKind: 'HANDOFF_DECLARED', state: 'UNKNOWN' })]))
}, 60000)
it('normalizes only semantically explicit nonconflicting Handoff fields', () => {
  const sha = 'a'.repeat(40)
  expect(handoffTargets({ commitSha: sha, headCommit: sha, sha, prNumber: 111, prUrl: 'https://github.com/owner/repo/pull/111' }, 'owner/repo')).toEqual([{ kind: 'COMMIT', id: sha }, { kind: 'PR', id: '111' }])
  for (const metadata of [{ sha }, { commit: sha }, { sourceCommit: sha }, { mergeCommit: sha }, { commitSha: [sha] }, { commitSha: sha, headCommit: 'b'.repeat(40) }, { commitSha: sha, commit: { sha } }]) expect(handoffTargets(metadata)).toEqual([])
  for (const metadata of [{ prNumber: 111, prUrl: 'https://github.com/foreign/repo/pull/111' }, { pullRequest: 111, prNumber: 112 }, { prNumber: '111' }, { prUrl: '#111' }, { prNumber: 111, repository: 'other/repo' }]) expect(handoffTargets(metadata, 'owner/repo')).toEqual([])
  expect(handoffTargets({ prNumber: 111 })).toEqual([])
  expect(handoffTargets({ commitSha: sha, repository: 'foreign/repo' }, 'owner/repo')).toEqual([])
})

it('accepts opt-in only through authenticated callback and preserves all arguments in the real governed Git receipt', async () => {
  const f = await fixture()
  const checkout = join(f.root, 'delivery-worktree')
  await gitExec(f.root, ['worktree', 'add', '-b', 'fixture-delivery', checkout])
  writeFileSync(join(checkout, 'change.txt'), 'fixture')
  await gitExec(checkout, ['add', 'change.txt'])
  const identity = { repositoryId: 'fixture', isActive: () => true }
  const trees = new GitWorktreeRegistry(f.root, f.git, identity)
  const tree = (await trees.discover()).worktrees.find(value => value.path === checkout)!
  const inventory = new GitBranchInventory(f.root, f.git, trees, identity)
  const observe = () => inventory.executionSnapshot(tree.worktreeId, tree.generation)
  const linked = await f.service.bindExecutionBranch(f.request.executionId, f.plan.artifactId, observe)
  const authority = authorizeArtifactAgent(f.authority.principal, 'fixture', () => true, tree.worktreeId)
  const operations = new GitOperationsService(checkout, f.git, {} as any, identity)
  const state = await operations.getState()
  const args = { operationId: 'mcp-commit', message: 'fixture', expectedHead: state.head, expectedIndexRevision: state.indexRevision, deliveryContext: { ...f.request, bindingArtifactId: linked.artifactId, bindingRevision: linked.revision } }
  expect((await executeGitOperationsTool(operations, 'commit_git_changes', args)).isError).toBe(true)
  expect(await f.git.readOperationReceipt(f.root, args.operationId)).toBeNull()
  const result = await executeGitOperationsTool(operations, 'commit_git_changes', args, request => f.service.prepareDeliveryContext(authority, request, observe))
  expect(result.isError, result.content[0].text).toBeFalsy()
  const receipt = (await f.git.readOperationReceipt(f.root, args.operationId))!.receipt
  expect(receipt.deliveryVerified).toBe(true)
  const { operationId: _operationId, ...fingerprintArgs } = args
  expect(receipt.argumentFingerprint).toBe(gitReceiptFingerprint('commit_git_changes', fingerprintArgs))
  expect((await operations.deliveryProjectionPage()).observations).toHaveLength(1)

  const snapshot = await observe(), spool = join(checkout, '.code-awareness/native-hooks/spool')
  prepareNativeSpool(spool)
  const binding: NativeHookBinding = { schema: 1, enabled: true, repositoryId: 'fixture', worktreeId: snapshot.worktreeId,
    generation: snapshot.worktreeGeneration, ...nativeGitIdentity(checkout), spool, gitCommitTool: 'mcp__code_awareness_local__commit_git_changes' }
  const path = sessionStorePath(join(f.root, '.git'), 'fixture')
  let sessions = new SessionStore(path, 'fixture')
  try {
    const session = 'governed-delivery-fixture', sessionId = nativeDigest(JSON.stringify(['fixture', 'codex', session]))
    const stamp = startCaptureFixture(sessions.registry, binding, sessionId)
    const payload = { session_id: session, cwd: checkout, tool_name: binding.gitCommitTool, tool_use_id: 'governed-call', tool_input: args }
    const pre = stamp(normalizeNativeHook({ ...payload, hook_event_name: 'PreToolUse' }, binding))
    const post = stamp(normalizeNativeHook({ ...payload, hook_event_name: 'PostToolUse', tool_response: result }, binding))
    expect(pre.git?.fingerprint).toBe(receipt.argumentFingerprint)
    expect(post.git).toMatchObject({ sha: await f.git.getCurrentCommitHash(checkout), replayed: false, fingerprint: receipt.argumentFingerprint })
    const invocationId = pre.invocationId!, sha = post.git!.sha!
    sessions.registry.apply(nativeObservationBatch(pre), undefined)
    expect(await correlateNativeGit(sessions.registry, binding, invocationId, f.git, () => {})).toBe('INVOCATION_INCOMPLETE')
    sessions.registry.apply(nativeObservationBatch(post), undefined)
    expect(await correlateNativeGit(sessions.registry, binding, invocationId, f.git, () => {})).toBe('VERIFIED')
    const pr = { kind: 'PR' as const, id: '89' }
    const membership = { repositoryId: 'fixture', revision: sha, status: 'COMPLETE', edges: [] }
    sessions.registry.applyAll([
      { ...membership, source: 'GITHUB:PR:89:1', edges: [
        { from: { kind: 'COMMIT', id: sha }, to: pr, relation: 'member-of', evidenceKind: 'GITHUB_COMMIT_LIST',
          evidenceRef: 'PR:89:' + sha + ':1', digest: nativeDigest(sha), freshness: 'OBSERVED_SNAPSHOT' }
      ] },
      { ...membership, source: 'GITHUB:PR:89' }
    ], () => {})
    startCaptureFixture(sessions.registry, { ...binding, worktreeId: 'b'.repeat(64) }, 'b'.repeat(64))
    const provider = { refresh: vi.fn() }
    const list = async (filter: object) => {
      const result = await executeSessionTool(sessions, provider, 'list_agent_sessions', { source: 'NATIVE_HOOK', ...filter }, () => {})
      expect(result.isError, result.content[0].text).toBeFalsy()
      return JSON.parse(result.content[0].text)
    }
    for (const restart of [false, true]) {
      if (restart) {
        sessions.close()
        await gitExec(f.root, ['worktree', 'remove', '--force', checkout])
        sessions = new SessionStore(path, 'fixture')
      }
      for (const selector of [{ commitSha: sha }, { pullRequest: 89 }]) {
        const result = await list(selector)
        expect(result.sessions.map((session: { providerSessionId: string }) => session.providerSessionId)).toEqual([sessionId])
        expect(result.sessions[0].evidence.native).toMatchObject({ state: 'VERIFIED_CAUSAL', commitSha: sha })
        if ('pullRequest' in selector) expect(result.sessions[0].evidence.membership).toMatchObject({ kind: 'GITHUB_COMMIT_LIST', state: 'VERIFIED' })
        expect(JSON.stringify(result)).not.toContain(checkout)
      }
      expect((await list({ pullRequest: 90 })).reason).toBe('NO_VERIFIED_NATIVE_ASSOCIATION_OBSERVED')
    }
    expect(provider.refresh).not.toHaveBeenCalled()
    for (const selector of [{ type: 'SESSION', provider: 'codex-native', id: sessionId }, { type: 'COMMIT', id: sha }]) {
      const graph = await executeSessionTool(sessions, { refresh: vi.fn() }, 'discover_execution_context', { selector, mode: 'RELATION_DETAIL', depth: 1 }, () => {})
      expect(graph.isError, graph.content[0].text).toBeFalsy()
      expect(JSON.parse(graph.content[0].text).edges).toContainEqual(expect.objectContaining({ evidenceKind: 'NATIVE_GIT_CAUSAL', confidenceClass: 'VERIFIED_CAUSAL', relation: selector.type === 'SESSION' ? 'invoked' : 'committed' }))
    }
    const reference = sessions.registry.contextGraph({ kind: 'COMMIT', id: sha }).edges.find(edge => edge.relation === 'committed' && edge.evidenceKind === 'NATIVE_GIT_CAUSAL')!.evidenceRef
    for (const selector of [{ type: 'PR', id: '89' }, { type: 'COMMIT', id: sha }]) {
      const queried = await executeSessionTool(sessions, provider, 'discover_execution_context', { selector, view: 'WORK' }, () => {},
        undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, true)
      expect(queried.isError, queried.content[0].text).toBeFalsy()
      expect(JSON.parse(queried.content[0].text)).toMatchObject({ authorship: 'NOT_INFERRED', causalSession: { state: 'VERIFIED_CAUSAL', evidenceRefs: [reference] } })
    }
    const db = new Database(path, { readonly: true })
    try {
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.prepare('SELECT state FROM registry_edges WHERE source=? ORDER BY id').all('NATIVE_GIT:' + invocationId)).toEqual([{ state: 'OBSERVED' }, { state: 'OBSERVED' }])
    } finally { db.close() }
  } finally { sessions.close() }
}, 60000)

it('keeps a binding on a shared branch contextual and rejects a delivery observation', async () => {
  const f = await fixture(), operations = new GitOperationsService(f.root, f.git, {} as any, { repositoryId: 'fixture', isActive: () => true })
  await gitExec(f.root, ['worktree', 'add', '--force', join(f.root, 'shared'), 'main'])
  await expect(operations.deliverySnapshot()).rejects.toThrow('DELIVERY_CONTEXT_STALE')
  expect(f.service.get(f.binding.artifactId)?.provenance.executionBranchBinding).toBe(true)
}, 60000)

it('returns deliveryContext from bindExecutionBranch and projects Continuum publications and Ledger proofs with delivery anchors', async () => {
  const f = await fixture()
  expect(f.binding).toMatchObject({
    planArtifactId: f.plan.artifactId,
    planRevision: 1,
    deliveryContext: f.request
  })
  const anchor = await f.prepare()
  const sessions = new SessionStore(sessionStorePath(f.root, 'fixture'), 'fixture'); cleanup.push(async () => sessions.close())
  const ledger = new ValidationLedger(join(f.root, '.git', 'validation.db')); cleanup.push(async () => ledger.close())
  const published = f.service.publish('---\nname: Execution Note\ndescription: Linked publication\nkind: TECHNICAL_SPEC\n---\nBody', {}, f.authority, anchor)
  expect(published.publicationReceipt?.deliveryContext).toEqual(anchor)
  expect(f.service.get(published.artifactId)?.metadata).not.toHaveProperty('deliveryContext')
  expect(f.service.publicationDeliveryPage().observations).toMatchObject([{ operation: 'PUBLISH_ARTIFACT', artifactId: published.artifactId, artifactRevision: 1, anchor }])
  const proof = ledger.recordProof({
    kind: 'TARGETED_TEST', producer: 'IMPLEMENTER', status: 'PASSED', startedAt: '2026-11-19T00:00:00Z', finishedAt: '2026-11-19T00:00:01Z',
    durationMs: 100, scope: ['unit'], summary: 'ok', evidenceFor: [f.plan.artifactId],
    commandProfile: { command: 'vitest', deliveryContext: anchor }
  })
  const read = registrySources({ repositoryId: 'fixture', root: f.root, continuum: () => f.service, ledger, github: { commitPullRequests: async () => [], getPullRequest: async () => ({}) as any, pullRequestCommits: async () => ({}) as any } as any, networkAllowed: () => false, assertCurrent: () => {} })
  sessions.registry.applyAll(await read({ cursors: sessions.registry.cursors() }), () => {})
  const graph = sessions.registry.contextGraph({ kind: 'ARTIFACT', id: f.plan.artifactId + ':' + f.plan.revision }, undefined, 3)
  expect(graph.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ evidenceKind: 'OPERATION_EXECUTION_CONTEXT', evidenceRef: published.artifactId + ':1' }),
    expect.objectContaining({ evidenceKind: 'OPERATION_EXECUTION_CONTEXT', evidenceRef: proof.proofId })
  ]))
}, 60000)

it('propagates active execution identity automatically through LocalChannel Git, GitHub and Continuum adapters without manual deliveryContext', async () => {
  const f = await fixture()
  const rawPlan = '---\nname: U2 Local Plan\ndescription: U2 E2E fixture\nkind: EXECUTABLE_PLAN\n---\nPRIVATE_U2_PLAN'
  const u2Plan = f.service.publish(rawPlan)
  const booted = await f.service.bootstrapExecution({ planArtifactId: u2Plan.artifactId, expectedPlanRevision: 1 }, f.observe)
  expect(booted.executionId).toMatch(/^exec-/)

  const operations = new GitOperationsService(f.root, f.git, {} as any, { repositoryId: 'fixture', isActive: () => true })
  const session = {
    getActiveService: () => f.service,
    getActiveSession: () => ({ repositoryId: 'fixture', repositoryPath: f.root })
  } as any
  const principal = authenticatedAgentPrincipal('LOCAL_AGENT_CHANNEL', () => true)
  const context = { connected: () => true, principal }

  const treeSnapshot = await f.observe()
  writeFileSync(join(f.root, 'feature.txt'), 'u2 delivery')
  const gitAdapter = new GitLocalAdapter(() => ({ repositoryId: 'fixture', repositoryPath: f.root, service: operations, isCurrent: () => true }), session)
  await gitAdapter.operations.stage.execute({
    repositoryId: 'fixture', worktreeId: treeSnapshot.worktreeId, operationId: 'u2-stage-1',
    mode: 'STAGE', paths: ['feature.txt'], expectedIndexRevision: (await operations.getState()).indexRevision,
    expectedWorktreeRevision: (await operations.getState()).worktreeRevision
  }, context)
  const committed = await gitAdapter.operations.commit.execute({
    repositoryId: 'fixture', worktreeId: treeSnapshot.worktreeId, operationId: 'u2-commit-1',
    message: 'u2 governed commit', expectedHead: (await operations.getState()).head,
    expectedIndexRevision: (await operations.getState()).indexRevision
  }, context) as { sha: string }

  const commitReceipt = (await f.git.readOperationReceipt(f.root, 'u2-commit-1'))!.receipt
  expect(commitReceipt.deliveryVerified).toBe(true)
  expect(commitReceipt.deliveryContext?.executionId).toBe(booted.executionId)
  expect(commitReceipt.deliveryContext?.planArtifactId).toBe(u2Plan.artifactId)

  const receiptDirectory = join(f.root, '.git', 'pr-receipts-u2')
  const prSummary = {
    number: 202, url: 'https://github.com/owner/repo/pull/202', title: 'U2 PR', state: 'open' as const, draft: false,
    head: { ref: 'main', repository: 'owner/repo', sha: committed.sha },
    base: { ref: 'release', repository: 'owner/repo', sha: 'e'.repeat(40) },
    mergeability: 'UNKNOWN' as const, mergedAt: null, observedAt: new Date().toISOString()
  }
  let prCreated = false
  const ghIntegration = {
    getPullRequestAccess: async () => ({ state: 'READY' }),
    getPullRequestOperation: async () => ({ status: 'CREATED' }),
    createPullRequest: async (_repoPath: string, prInput: any, execCtx: any) => {
      const api = {
        getPullRequestPermissions: async () => ({ create: true }),
        getBranchSha: async (_repo: string, ref: string) => ref === 'main' ? committed.sha : 'e'.repeat(40),
        listPullRequests: async () => ({ pullRequests: prCreated ? [prSummary] : [] }),
        getPullRequest: async () => prSummary,
        createPullRequest: async () => { prCreated = true; return prSummary }
      }
      return new GitHubPullRequests(api as any, async () => ({ repositoryId: 'fixture', repository: 'owner/repo' }), { receiptDirectory, approve: async () => true }).create(prInput, execCtx)
    }
  } as any
  const ghAdapter = new GitHubLocalAdapter(() => ({ repositoryId: 'fixture', repositoryPath: f.root, integration: ghIntegration, gitOperations: operations, isCurrent: () => true }), session)
  const prRes = await ghAdapter.operations.create_pr.execute({
    repositoryId: 'fixture', worktreeId: treeSnapshot.worktreeId, operationId: 'u2-pr-1',
    headBranch: 'main', baseBranch: 'release', expectedHeadSha: committed.sha, title: 'U2 PR', body: 'PRIVATE_U2_PR'
  }, context) as { status: string }
  expect(prRes.status).toBe('CREATED')
  expect(pullRequestDeliveryPage(receiptDirectory, 'fixture').observations).toMatchObject([{
    operationId: 'u2-pr-1', pullRequest: 202, headSha: committed.sha, anchor: { executionId: booted.executionId, planArtifactId: u2Plan.artifactId }
  }])

  const authority = authorizeArtifactAgent(principal, 'fixture', () => true, treeSnapshot.worktreeId)
  const resolved = await f.service.resolveExecutionContext(authority, undefined, () => operations.deliverySnapshot(treeSnapshot.worktreeId))
  const handoff = f.service.publish(`---\nname: U2 Handoff\ndescription: U2 handoff\nkind: IMPLEMENTATION_HANDOFF\nrelations:\n  - artifactId: ${u2Plan.artifactId}\n    kind: implements\n---\nBody`, {}, authority, resolved.anchor)
  expect(handoff.publicationReceipt?.deliveryContext?.executionId).toBe(booted.executionId)

  const sessions = new SessionStore(sessionStorePath(f.root, 'fixture'), 'fixture'); cleanup.push(async () => sessions.close())
  const ledger = new ValidationLedger(join(f.root, '.git', 'validation-u2.db')); cleanup.push(async () => ledger.close())
  const read = registrySources({
    repositoryId: 'fixture',
    root: f.root,
    continuum: () => f.service,
    ledger,
    gitDeliveries: cursor => operations.deliveryProjectionPage(cursor),
    github: {
      deliveryRepository: async () => 'owner/repo',
      commitPullRequests: async () => [202],
      getPullRequest: async () => ({ repositoryId: 'fixture', repository: 'owner/repo', pullRequest: prSummary }),
      deliveryProjectionPage: (id: string, cursor?: string) => pullRequestDeliveryPage(receiptDirectory, id, cursor),
      pullRequestCommits: async () => ({ repositoryId: 'fixture', repository: 'owner/repo', headSha: committed.sha, commits: [{ sha: committed.sha }], nextPage: null })
    } as any,
    networkAllowed: () => true,
    assertCurrent: () => {}
  })
  sessions.registry.applyAll(await read({ cursors: sessions.registry.cursors() }), () => {})
  const planGraph = sessions.registry.contextGraph({ kind: 'ARTIFACT', id: `${u2Plan.artifactId}:1` }, undefined, 4)
  expect(planGraph.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ relation: 'delivery-context', to: `COMMIT:fixture:${committed.sha}` }),
    expect.objectContaining({ relation: 'delivery-context', to: 'PR:fixture:202' }),
    expect.objectContaining({ relation: 'delivery-context', to: `ARTIFACT:fixture:${handoff.artifactId}:1` })
  ]))
  const commitGraph = sessions.registry.contextGraph({ kind: 'COMMIT', id: committed.sha }, undefined, 4)
  expect(commitGraph.nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'ARTIFACT', id: u2Plan.artifactId, revision: 1, key: `ARTIFACT:fixture:${u2Plan.artifactId}:1` }),
    expect.objectContaining({ type: 'PR', id: '202', key: 'PR:fixture:202' })
  ]))
}, 120000)

it('separates Antigravity contextual activation from verified causal proof, handles multi-session & delegated lineage, and enforces producerWitness', async () => {
  const f = await fixture()
  const agPlan = f.service.publish('---\nname: U3 Plan\ndescription: U3 Antigravity fixture\nkind: EXECUTABLE_PLAN\n---\nPRIVATE_U3')
  const booted = await f.service.bootstrapExecution({ planArtifactId: agPlan.artifactId, expectedPlanRevision: 1 }, f.observe)
  const snapshot = await f.observe()
  const activation = {
    activationId: booted.activationId!,
    revision: booted.activationRevision!,
    executionId: booted.executionId,
    planArtifactId: agPlan.artifactId,
    planRevision: 1,
    bindingArtifactId: booted.artifactId,
    bindingRevision: booted.revision,
    scope: 'CHECKOUT_OBSERVED' as const
  }

  const spool = join(f.root, '.code-awareness/native-hooks/antigravity/spool')
  prepareNativeSpool(spool)
  const agBinding: NativeHookBinding = {
    schema: 1, provider: 'antigravity', enabled: true, repositoryId: 'fixture',
    worktreeId: snapshot.worktreeId, generation: snapshot.worktreeGeneration,
    ...nativeGitIdentity(f.root), spool, gitCommitTool: 'mcp__code_awareness_local__commit_git_changes'
  }
  mkdirSync(join(f.root, '.agents'), { recursive: true })
  writeFileSync(join(f.root, '.agents/hooks.json'), '{}')
  writeFileSync(join(f.root, '.code-awareness/native-hooks/antigravity/binding.json'), JSON.stringify(agBinding))

  const path = sessionStorePath(join(f.root, '.git'), 'fixture')
  const sessions = new SessionStore(path, 'fixture'); cleanup.push(async () => sessions.close())

  const s1Raw = 'ag-session-1', s2Raw = 'ag-session-2'
  const s1Id = nativeDigest(JSON.stringify(['fixture', 'antigravity', s1Raw]))
  const s2Id = nativeDigest(JSON.stringify(['fixture', 'antigravity', s2Raw]))
  const stamp = (ev: ReturnType<typeof normalizeNativeHook>) => stampNativeCapture(ev, agBinding)

  const passiveStart = stamp(normalizeNativeHook({ conversationId: s1Raw, workspacePaths: [f.root], hookEventName: 'SessionStart' }, agBinding, new Date(), { activation }))
  const passivePre = stamp(normalizeNativeHook({ conversationId: s1Raw, workspacePaths: [f.root], hookEventName: 'PreToolUse', toolCall: { id: 'call-passive', name: agBinding.gitCommitTool, input: { operationId: 'op-passive' } } }, agBinding, new Date(), { activation }))
  const passivePost = stamp(normalizeNativeHook({ conversationId: s1Raw, workspacePaths: [f.root], hookEventName: 'PostToolUse', toolCall: { id: 'call-passive', name: agBinding.gitCommitTool } }, agBinding, new Date(), { activation }))
  for (const ev of [passiveStart, passivePre, passivePost]) sessions.registry.apply(nativeObservationBatch(ev), undefined)

  expect(await correlateNativeGit(sessions.registry, agBinding, passivePre.invocationId!, f.git, () => {})).toBe('ANTIGRAVITY_CAUSAL_UNSUPPORTED')
  expect(await correlateNativeArtifact(sessions.registry, agBinding, passivePre.invocationId!, { readReceipt: async () => null, associate: async () => ({ state: 'VERIFIED', conflictingInvocationIds: [] }), invalidate: async () => {} } as any, () => {})).toBe('ANTIGRAVITY_CAUSAL_UNSUPPORTED')

  const execGraphPassive = sessions.registry.contextGraph({ kind: 'EXECUTION', id: booted.executionId }, undefined, 2)
  expect(execGraphPassive.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ relation: 'observed-in-execution', evidenceKind: 'EXECUTION_CONTEXT_OBSERVED', confidenceClass: 'OBSERVED' })
  ]))
  expect(execGraphPassive.edges.some(e => e.confidenceClass === 'VERIFIED_CAUSAL')).toBe(false)

  const delegatedStart = stamp(normalizeNativeHook({ conversationId: s2Raw, workspacePaths: [f.root], hookEventName: 'SessionStart' }, agBinding, new Date(), {
    activation: { ...activation, scope: 'DELEGATED', parentSessionId: s1Id }
  }))
  sessions.registry.apply(nativeObservationBatch(delegatedStart), undefined)
  const s2Graph = sessions.registry.contextGraph({ kind: 'SESSION', id: `antigravity-native:${s2Id}` }, undefined, 2)
  expect(s2Graph.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ relation: 'delegated-from', evidenceKind: 'DELEGATED_SESSION_LINEAGE', to: `SESSION:fixture:antigravity-native:${s1Id}` }),
    expect.objectContaining({ relation: 'observed-in-execution', to: `EXECUTION:fixture:${booted.executionId}` })
  ]))

  const ops = new GitOperationsService(f.root, f.git, {} as any, { repositoryId: 'fixture', isActive: () => true })
  writeFileSync(join(f.root, 'ag-managed.txt'), 'managed u3 commit')
  const authorityNoHeaderSpoof = authorizeArtifactAgent(authenticatedAgentPrincipal('LOCAL_AGENT_CHANNEL', () => true), 'fixture', () => true, snapshot.worktreeId, {
    sessionWitness: { provider: 'antigravity', sessionId: s2Raw, invocationId: 'call-managed' }
  })
  const st0 = await ops.getState()
  const stageRes = await executeGitOperationsTool(ops, 'stage_git_changes', {
    operationId: 'ag-stage-1', mode: 'STAGE', paths: ['ag-managed.txt'], expectedIndexRevision: st0.indexRevision, expectedWorktreeRevision: st0.worktreeRevision
  }, undefined, authorityNoHeaderSpoof)
  expect(stageRes.isError).toBeFalsy()
  const st = await ops.getState()
  const commitArgs = { operationId: 'ag-managed-1', message: 'ag commit', expectedHead: st.head, expectedIndexRevision: st.indexRevision }
  const commitRes = await executeGitOperationsTool(ops, 'commit_git_changes', commitArgs, req => f.service.prepareDeliveryContext(authorityNoHeaderSpoof, req, f.observe), authorityNoHeaderSpoof, () => f.observe().then(() => f.service.resolveExecutionContext(authorityNoHeaderSpoof, undefined, f.observe).then(r => r.anchor)))
  expect(commitRes.isError).toBeFalsy()

  const s2PreSpoof = stamp(normalizeNativeHook({
    conversationId: s2Raw, workspacePaths: [f.root], hookEventName: 'PreToolUse',
    toolCall: { id: 'call-unverified', name: agBinding.gitCommitTool, input: commitArgs }
  }, agBinding, new Date(), { activation }))
  sessions.registry.apply(nativeObservationBatch(s2PreSpoof), undefined)
  expect(await correlateNativeGit(sessions.registry, agBinding, s2PreSpoof.invocationId!, f.git, () => {})).toBe('ANTIGRAVITY_CAUSAL_UNSUPPORTED')

  const witness = { verifiedBy: 'MANAGED_RUNTIME' as const, sessionId: s2Id }
  const s2PreManaged = stamp(normalizeNativeHook({
    conversationId: s2Raw, workspacePaths: [f.root], hookEventName: 'PreToolUse',
    toolCall: { id: 'call-managed', name: agBinding.gitCommitTool, input: commitArgs }
  }, agBinding, new Date(), { activation, producerWitness: witness }))
  const s2PostManaged = stamp(normalizeNativeHook({
    conversationId: s2Raw, workspacePaths: [f.root], hookEventName: 'PostToolUse',
    toolCall: { id: 'call-managed', name: agBinding.gitCommitTool, input: commitArgs, response: commitRes }
  }, agBinding, new Date(), { activation, producerWitness: witness }))
  sessions.registry.apply(nativeObservationBatch(s2PreManaged), undefined)
  sessions.registry.apply(nativeObservationBatch(s2PostManaged), undefined)
  expect(await correlateNativeGit(sessions.registry, agBinding, s2PreManaged.invocationId!, f.git, () => {})).toBe('VERIFIED')
}, 60000)

it('batches receipt paging cleanly, isolates malformed blobs, avoids EOF wrap-around, protects global completeness on focal refresh and recovers alternative exact evidence without backfill', async () => {
  const f = await fixture()
  await f.service.bootstrapExecution({ planArtifactId: f.plan.artifactId, expectedPlanRevision: f.plan.revision }, f.observe)
  const snapshot = await f.observe()
  const operations = new GitOperationsService(f.root, f.git, {} as any, { repositoryId: 'fixture', isActive: () => true })
  const authority = authorizeArtifactAgent(authenticatedAgentPrincipal('LOCAL_AGENT_CHANNEL', () => true), 'fixture', () => true, snapshot.worktreeId)

  const badPath = join(f.root, '.git', 'corrupt-receipt.json')
  writeFileSync(badPath, '{malformed-json')
  const corruptBlob = (await gitExec(f.root, ['hash-object', '-w', badPath])).trim()
  await gitExec(f.root, ['update-ref', 'refs/code-awareness/operation-receipts/000-corrupt', corruptBlob])

  const committedShas: string[] = []
  for (const opId of ['u4-op-01', 'u4-op-02']) {
    writeFileSync(join(f.root, `${opId}.txt`), opId)
    const s0 = await operations.getState()
    await executeGitOperationsTool(operations, 'stage_git_changes', {
      operationId: `${opId}-stage`, mode: 'STAGE', paths: [`${opId}.txt`], expectedIndexRevision: s0.indexRevision, expectedWorktreeRevision: s0.worktreeRevision
    }, undefined, authority)
    const s1 = await operations.getState()
    const res = await executeGitOperationsTool(operations, 'commit_git_changes', {
      operationId: opId, message: opId, expectedHead: s1.head, expectedIndexRevision: s1.indexRevision
    }, undefined, authority, () => f.observe().then(() => f.service.resolveExecutionContext(authority, undefined, f.observe).then(r => r.anchor)))
    expect(res.isError).toBeFalsy()
    committedShas.push(JSON.parse(res.content[0].text).sha)
  }

  const page1 = await f.git.operationReceiptPage(f.root, '', 2)
  expect(page1.nextCursor).toBe('u4-op-01')
  const page2 = await f.git.operationReceiptPage(f.root, page1.nextCursor)
  expect(page2.receipts.map(r => r.receipt.operationId)).toEqual(expect.arrayContaining(['u4-op-01-stage', 'u4-op-02', 'u4-op-02-stage']))

  const deliveries = await operations.deliveryProjectionPage()
  expect(deliveries.observations.map(o => o.operationId)).toEqual(['u4-op-01', 'u4-op-02'])
  expect(await operations.deliveryProjectionPage('zzz-after-tail')).toEqual({ observations: [], nextCursor: undefined })

  await gitExec(f.root, ['commit', '--allow-empty', '-m', 'untracked historical commit'])
  const externalSha = (await f.git.getCurrentCommitHash(f.root))!
  const histPlan = f.service.publish('---\nname: Historical Plan\ndescription: Historical fixture\nkind: EXECUTABLE_PLAN\n---\nPlan body')
  const histHandoff = f.service.publish(`---\nname: Historical Handoff\ndescription: Historical handoff\nkind: IMPLEMENTATION_HANDOFF\ncommitSha: ${externalSha}\nrelations:\n  - artifactId: ${histPlan.artifactId}\n    kind: implements\n---\nHandoff body`)
  const ledger = new ValidationLedger(join(f.root, '.git', 'validation-u4.db')); cleanup.push(async () => ledger.close())
  const proof = ledger.recordProof({
    kind: 'TARGETED_TEST', producer: 'IMPLEMENTER', status: 'PASSED',
    startedAt: '2026-11-20T10:00:00Z', finishedAt: '2026-11-20T10:00:01Z', durationMs: 1000,
    scope: ['u4'], summary: 'u4 proof', evidenceFor: [histPlan.artifactId]
  })

  const sessions = new SessionStore(sessionStorePath(f.root, 'fixture'), 'fixture'); cleanup.push(async () => sessions.close())
  let gitPageCalls = 0
  const read = registrySources({
    repositoryId: 'fixture',
    root: f.root,
    continuum: () => f.service,
    ledger,
    gitDeliveries: async () => {
      gitPageCalls++
      return gitPageCalls === 1
        ? { observations: [deliveries.observations[0]], nextCursor: 'u4-op-01' }
        : { observations: [], nextCursor: undefined }
    },
    github: {
      deliveryRepository: async () => 'owner/repo',
      commitPullRequests: async (_root: string, sha: string) => sha === externalSha ? [162] : [],
      getPullRequest: async () => ({
        repositoryId: 'fixture', repository: 'owner/repo',
        pullRequest: {
          number: 162, url: 'https://github.com/owner/repo/pull/162', title: 'External PR #162', state: 'closed',
          draft: false, head: { ref: 'feat', repository: 'owner/repo', sha: externalSha },
          base: { ref: 'main', repository: 'owner/repo', sha: 'a'.repeat(40) }, mergeability: 'UNKNOWN',
          mergedAt: '2026-11-20T09:00:00Z', lifecycle: 'MERGED', mergeCommitSha: externalSha, observedAt: '2026-11-20T09:01:00Z'
        }
      }),
      pullRequestCommits: async () => ({ repositoryId: 'fixture', repository: 'owner/repo', headSha: externalSha, commits: [{ sha: externalSha }], nextPage: null })
    } as any,
    networkAllowed: () => true,
    assertCurrent: () => {}
  })

  sessions.registry.applyAll(await read({ cursors: sessions.registry.cursors() }), () => {})
  expect(sessions.registry.source('DELIVERY_GIT')?.status).toBe('PARTIAL')
  expect(sessions.registry.source('DELIVERY_GIT')?.cursor).toBe('u4-op-01')

  sessions.registry.applyAll(await read({ selector: { kind: 'COMMIT', id: externalSha }, cursors: sessions.registry.cursors() }), () => {})
  expect(sessions.registry.source('DELIVERY_GIT')?.status).toBe('PARTIAL')
  expect(sessions.registry.source('DELIVERY_GIT')?.cursor).toBe('u4-op-01')

  const recovered = sessions.registry.contextGraph({ kind: 'COMMIT', id: externalSha }, undefined, 4)
  expect(recovered.nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'PR', id: '162' }),
    expect.objectContaining({ type: 'ARTIFACT', id: histHandoff.artifactId }),
    expect.objectContaining({ type: 'ARTIFACT', id: histPlan.artifactId }),
    expect.objectContaining({ type: 'PROOF', id: proof.proofId })
  ]))
  expect(recovered.edges.some(e => e.evidenceKind === 'OPERATION_EXECUTION_CONTEXT' && (e.from.endsWith(externalSha) || e.to.endsWith(externalSha)))).toBe(false)
}, 120000)

it('U1: recovers EXECUTION -> COMMIT by both EXECUTION and COMMIT selectors, verifies Git object/parents, and rejects forged receipts', async () => {
  const f = await fixture()
  const operations = new GitOperationsService(f.root, f.git, { fetch: async () => {}, push: async () => {} } as any, { repositoryId: 'fixture', isActive: () => true })
  writeFileSync(join(f.root, 'u1.txt'), 'u1-content')
  const s0 = await operations.getState()
  const stageRes = await executeGitOperationsTool(operations, 'stage_git_changes', {
    operationId: 'u1-stage-1', mode: 'STAGE', paths: ['u1.txt'], expectedIndexRevision: s0.indexRevision, expectedWorktreeRevision: s0.worktreeRevision
  })
  expect(stageRes.isError, stageRes.content[0].text).toBeUndefined()
  const s1 = await operations.getState()
  const commitRes = await executeGitOperationsTool(operations, 'commit_git_changes', {
    operationId: 'u1-commit-1',
    message: 'u1 governed commit',
    expectedHead: s1.head,
    expectedIndexRevision: s1.indexRevision,
    deliveryContext: f.request
  }, (req, worktreeId) => f.service.prepareDeliveryContext(f.authority, req, f.observe, { worktreeId }), f.authority)
  expect(commitRes.isError, commitRes.content[0].text).toBeUndefined()
  const committed = JSON.parse(commitRes.content[0].text) as { sha: string }
  expect(committed.sha).toMatch(/^[a-f0-9]{40}$/)

  const replayRes = await executeGitOperationsTool(operations, 'commit_git_changes', {
    operationId: 'u1-commit-1',
    message: 'u1 governed commit',
    expectedHead: s1.head,
    expectedIndexRevision: s1.indexRevision,
    deliveryContext: f.request
  }, (req, worktreeId) => f.service.prepareDeliveryContext(f.authority, req, f.observe, { worktreeId }), f.authority)
  expect(JSON.parse(replayRes.content[0].text)).toMatchObject({ sha: committed.sha, replayed: true })

  // Forge a receipt whose commit SHA does not exist in Git and another whose parent mismatches anchor head.
  const anchor = await f.prepare()
  const forgedMissingSha = 'f'.repeat(40)
  await f.git.prepareOperationReceipt(f.root, {
    operationId: 'u1-forged-missing',
    operation: 'commit_git_changes',
    argumentFingerprint: 'a'.repeat(64),
    status: 'COMPLETED' as const,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    deliveryContext: anchor,
    deliveryVerified: true,
    result: { content: [{ type: 'text' as const, text: JSON.stringify({ sha: forgedMissingSha, parent: anchor.snapshot.head }) }] }
  })
  const forgedWrongParent = {
    operationId: 'u1-forged-parent',
    operation: 'commit_git_changes',
    argumentFingerprint: 'b'.repeat(64),
    status: 'COMPLETED' as const,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    deliveryContext: { ...anchor, snapshot: { ...anchor.snapshot, head: '0'.repeat(40) } },
    deliveryVerified: true,
    result: { content: [{ type: 'text' as const, text: JSON.stringify({ sha: committed.sha, parent: '0'.repeat(40) }) }] }
  }
  await f.git.prepareOperationReceipt(f.root, forgedWrongParent)

  const deliveries = await operations.deliveryProjectionPage()
  expect(deliveries.observations.map(o => o.operationId)).toEqual(['u1-commit-1'])
  expect(deliveries.observations[0].commitSha).toBe(committed.sha)

  const sessions = new SessionStore(sessionStorePath(f.root, 'fixture'), 'fixture'); cleanup.push(async () => sessions.close())
  const ledger = new ValidationLedger(join(f.root, '.git', 'validation-u1.db')); cleanup.push(async () => ledger.close())
  const read = registrySources({
    repositoryId: 'fixture',
    root: f.root,
    continuum: () => f.service,
    ledger,
    gitDeliveries: cursor => operations.deliveryProjectionPage(cursor),
    github: { deliveryRepository: async () => 'owner/repo', commitPullRequests: async () => [], getPullRequest: async () => { throw new Error('UNEXPECTED') }, pullRequestCommits: async () => { throw new Error('UNEXPECTED') } } as any,
    networkAllowed: () => false,
    assertCurrent: () => {}
  })
  sessions.registry.applyAll(await read({ cursors: sessions.registry.cursors() }), () => {})

  const byExecution = await executeSessionTool(sessions, { refresh: vi.fn() }, 'discover_execution_context', {
    selector: { type: 'EXECUTION', id: 'execution-A' }, view: 'WORK', depth: 4
  }, () => {}, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, true)
  const execWork = JSON.parse(byExecution.content[0].text)
  expect(execWork.workLink).toMatchObject({ state: 'FOUND', weakestLink: 'OBSERVED' })
  expect(execWork.related.COMMIT).toEqual(expect.arrayContaining([expect.objectContaining({ id: committed.sha })]))

  const byCommit = await executeSessionTool(sessions, { refresh: vi.fn() }, 'discover_execution_context', {
    selector: { type: 'COMMIT', id: committed.sha }, view: 'WORK', depth: 4
  }, () => {}, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, true)
  const commitWork = JSON.parse(byCommit.content[0].text)
  expect(commitWork.workLink).toMatchObject({ state: 'FOUND', weakestLink: 'OBSERVED' })
  expect(commitWork.work).toEqual(expect.arrayContaining([expect.objectContaining({ artifactId: f.plan.artifactId, role: 'PLAN' })]))
}, 120000)

it('U1/U2 (artifact-9d7ea305): propagates filters with honest focal pagination and resolves PR -> Commits -> Receipts -> Execution -> Plan bidirectionally', async () => {
  const f = await fixture()
  const operations = new GitOperationsService(f.root, f.git, { fetch: async () => {}, push: async () => {} } as any, { repositoryId: 'fixture', isActive: () => true })

  // Create >20 receipts so the target governed commit sits beyond the first page (20 per page).
  for (let i = 0; i < 21; i++) {
    const opId = `00-pad-${String(i).padStart(2, '0')}`
    await f.git.prepareOperationReceipt(f.root, {
      operationId: `${opId}-stage`,
      operation: 'stage_git_changes',
      argumentFingerprint: String(i).padStart(64, '0'),
      status: 'COMPLETED',
      createdAt: '2026-11-23T14:00:00Z',
      completedAt: '2026-11-23T14:00:01Z',
      deliveryStatus: 'UNBOUND',
      result: { content: [{ type: 'text', text: '{}' }] }
    })
  }

  const commitWithContext = async (opId: string, file: string) => {
    writeFileSync(join(f.root, file), opId)
    const st0 = await operations.getState()
    await executeGitOperationsTool(operations, 'stage_git_changes', {
      operationId: `${opId}-stage`, mode: 'STAGE', paths: [file], expectedIndexRevision: st0.indexRevision, expectedWorktreeRevision: st0.worktreeRevision
    })
    const st1 = await operations.getState()
    const res = await executeGitOperationsTool(operations, 'commit_git_changes', {
      operationId: opId, message: opId, expectedHead: st1.head, expectedIndexRevision: st1.indexRevision, deliveryContext: f.request
    }, (req, worktreeId) => f.service.prepareDeliveryContext(f.authority, req, f.observe, { worktreeId }), f.authority)
    expect(res.isError, res.content[0].text).toBeUndefined()
    return JSON.parse(res.content[0].text).sha as string
  }

  const sha1 = await commitWithContext('zz-u2-commit-1', 'u2-a.txt')
  const sha2 = await commitWithContext('zz-u2-commit-2', 'u2-b.txt')

  // External shell commit (no receipt) for standalone PR #201.
  writeFileSync(join(f.root, 'ext.txt'), 'ext')
  await gitExec(f.root, ['add', 'ext.txt'])
  await gitExec(f.root, ['commit', '-m', 'external shell commit'])
  const externalSha = (await f.git.getCurrentCommitHash(f.root))!

  // Handoff implementing the plan without prNumber or commitSha metadata.
  const handoff = f.service.publish(`---\nname: U2 Handoff\ndescription: Handoff without PR metadata\nkind: IMPLEMENTATION_HANDOFF\nrelations:\n  - artifactId: ${f.plan.artifactId}\n    kind: implements\n---\nHandoff body`)

  const sessions = new SessionStore(sessionStorePath(f.root, 'fixture'), 'fixture'); cleanup.push(async () => sessions.close())
  const ledger = new ValidationLedger(join(f.root, '.git', 'validation-u2.db')); cleanup.push(async () => ledger.close())

  // Preserve global partial cursor to verify focal queries do not clobber it.
  sessions.registry.apply({ repositoryId: 'fixture', source: 'DELIVERY_GIT', revision: 'global-r1', cursor: '00-pad-05-stage', status: 'PARTIAL', edges: [] }, undefined)

  const pullRequestCommits = vi.fn(async (_root: string, prNumber: number) => ({
    repositoryId: 'fixture',
    repository: 'owner/repo',
    headSha: prNumber === 200 ? sha2 : externalSha,
    commits: prNumber === 200 ? [{ sha: sha1 }, { sha: sha2 }] : [{ sha: externalSha }],
    nextPage: null
  }))
  const read = registrySources({
    repositoryId: 'fixture',
    root: f.root,
    continuum: () => f.service,
    ledger,
    gitDeliveries: (cursor, filter) => operations.deliveryProjectionPage(cursor, filter),
    github: {
      deliveryRepository: async () => 'owner/repo',
      commitPullRequests: async (_root: string, sha: string) => [sha1, sha2].includes(sha) ? [200] : sha === externalSha ? [201] : [],
      getPullRequest: async (_root: string, prNumber: number) => ({
        repositoryId: 'fixture',
        repository: 'owner/repo',
        pullRequest: {
          number: prNumber, url: `https://github.com/owner/repo/pull/${prNumber}`, title: `PR #${prNumber}`, state: 'open', draft: false,
          head: { ref: 'feat', repository: 'owner/repo', sha: prNumber === 200 ? sha2 : externalSha },
          base: { ref: 'main', repository: 'owner/repo', sha: 'e'.repeat(40) },
          mergeability: 'UNKNOWN', mergedAt: null, observedAt: '2026-11-23T15:00:00Z'
        }
      }),
      pullRequestCommits
    } as any,
    networkAllowed: () => true,
    assertCurrent: () => {}
  })

  // 1) Focal PR #200 query resolves PR -> Commits -> Receipts -> Execution -> Plan + Handoff.
  const pr200Selector = { kind: 'PR' as const, id: '200' }
  const neighbors200 = sessions.registry.contextGraph(pr200Selector, undefined, 2).nodes
    .filter(n => n.type === 'ARTIFACT' || n.type === 'COMMIT')
    .map(n => ({ kind: n.type as 'ARTIFACT' | 'COMMIT', id: n.id }))
  sessions.registry.applyAll(await read({ selector: pr200Selector, neighbors: neighbors200, cursors: sessions.registry.cursors() }), () => {})
  expect(pullRequestCommits).toHaveBeenCalledTimes(1)
  expect(sessions.registry.source('DELIVERY_GIT')?.cursor).toBe('00-pad-05-stage')

  const prWork = JSON.parse((await executeSessionTool(sessions, { refresh: vi.fn() }, 'discover_execution_context', {
    selector: { type: 'PR', id: '200' }, view: 'WORK', depth: 4
  }, () => {}, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, true)).content[0].text)
  expect(prWork.workLink.state).toBe('FOUND')
  expect(['OBSERVED', 'DECLARED']).toContain(prWork.workLink.weakestLink)
  expect(prWork.executionCommit).toMatchObject({ state: 'FOUND' })
  expect(prWork.deliveryLink).toMatchObject({ state: 'VERIFIED' })
  expect(prWork.work).toEqual(expect.arrayContaining([
    expect.objectContaining({ artifactId: f.plan.artifactId, role: 'PLAN' }),
    expect.objectContaining({ artifactId: handoff.artifactId, role: 'HANDOFF' })
  ]))
  expect(prWork.related.COMMIT).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: sha1 }),
    expect.objectContaining({ id: sha2 })
  ]))

  // 2) Second PR #200 query reuses cached GITHUB:PR:200 without re-fetching pullRequestCommits.
  const neighbors200Cached = sessions.registry.contextGraph(pr200Selector, undefined, 2).nodes
    .filter(n => n.type === 'ARTIFACT' || n.type === 'COMMIT')
    .map(n => ({ kind: n.type as 'ARTIFACT' | 'COMMIT', id: n.id }))
  sessions.registry.applyAll(await read({ selector: pr200Selector, neighbors: neighbors200Cached, cursors: sessions.registry.cursors() }), () => {})
  expect(pullRequestCommits).toHaveBeenCalledTimes(1)

  // 3) Reverse selectors COMMIT and EXECUTION resolve the same chain.
  const commitWork = JSON.parse((await executeSessionTool(sessions, { refresh: vi.fn() }, 'discover_execution_context', {
    selector: { type: 'COMMIT', id: sha1 }, view: 'WORK', depth: 4
  }, () => {}, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, true)).content[0].text)
  expect(commitWork.workLink).toMatchObject({ state: 'FOUND' })
  expect(commitWork.related.PR).toEqual(expect.arrayContaining([expect.objectContaining({ id: '200' })]))

  const execWork = JSON.parse((await executeSessionTool(sessions, { refresh: vi.fn() }, 'discover_execution_context', {
    selector: { type: 'EXECUTION', id: 'execution-A' }, view: 'WORK', depth: 4
  }, () => {}, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, true)).content[0].text)
  expect(execWork.workLink).toMatchObject({ state: 'FOUND' })
  expect(execWork.related.COMMIT).toEqual(expect.arrayContaining([expect.objectContaining({ id: sha1 }), expect.objectContaining({ id: sha2 })]))

  // 4) External PR #201 (shell commit without receipt) keeps COMMIT->PR verified but EXECUTION->COMMIT unresolved.
  sessions.registry.applyAll(await read({ selector: { kind: 'PR', id: '201' }, neighbors: [], cursors: sessions.registry.cursors() }), () => {})
  const extWork = JSON.parse((await executeSessionTool(sessions, { refresh: vi.fn() }, 'discover_execution_context', {
    selector: { type: 'PR', id: '201' }, view: 'WORK', depth: 4
  }, () => {}, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, true)).content[0].text)
  expect(extWork.deliveryLink).toMatchObject({ state: 'VERIFIED' })
  expect(extWork.executionCommit.state).not.toBe('FOUND')
  expect(extWork.workLink.state).not.toBe('FOUND')
}, 120000)
