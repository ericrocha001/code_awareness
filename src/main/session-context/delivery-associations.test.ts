import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { ArtifactStore } from '../continuum/artifact-store'
import { ContinuumService } from '../continuum/continuum-service'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../continuum/agent-authority'
import { GitHubPullRequests, pullRequestDeliveryPage } from '../github/github-pull-requests'
import { GitService } from '../core/git-service'
import { createTempGitRepo, cleanupTempRepo, gitExec } from '../core/git-test-helpers'
import { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'
import { GitBranchInventory } from '../git-operations/git-branch-inventory'
import { GitOperationReceipts, gitReceiptFingerprint } from '../git-operations/git-operation-receipts'
import { executeGitOperationsTool } from '../git-operations/git-operations-mcp'
import { writeFileSync } from 'node:fs'
import { GitOperationsService } from '../git-operations/git-operations-service'
import { ValidationLedger } from '../validation-ledger/validation-ledger'
import { SessionStore, sessionStorePath } from './store'
import { registrySources, handoffTargets } from './registry-sources'
import { executeSessionTool } from './mcp'
import { nativeDigest, nativeGitIdentity, normalizeNativeHook, prepareNativeSpool, type NativeHookBinding } from './native-hooks'
import { startCaptureFixture } from './fixtures/native-capture-fixture'
import { nativeObservationBatch } from './native-hook-ingestion'
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
  const plan = service.publish('---\nname: Plan\ndescription: Delivery fixture\nkind: EXECUTABLE_PLAN\nexecutionId: execution-A\n---\nPRIVATE_PLAN')
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
  const fake = f.service.publish('---\nname: Impostor\ndescription: Fixture\nkind: OBSERVATION\nbindingRole: EXECUTION_BRANCH\n---\nDeclaration')
  await expect(f.service.prepareDeliveryContext(f.authority, { ...f.request, bindingArtifactId: fake.artifactId }, f.observe)).rejects.toThrow()
  await expect(f.service.prepareDeliveryContext(f.authority, { ...f.request, planRevision: 2 }, f.observe)).rejects.toThrow('DELIVERY_CONTEXT_STALE')
  for (const key of ['worktreeId', 'worktreeGeneration', 'branchGeneration'] as const) await expect(f.service.prepareDeliveryContext(f.authority, f.request, async () => ({ ...snapshot, [key]: 'f'.repeat(64) }))).rejects.toThrow('DELIVERY_CONTEXT_STALE')
  const second = f.service.publish('---\nname: Plan B\ndescription: Fixture\nkind: EXECUTABLE_PLAN\nexecutionId: execution-B\n---\nB')
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
  const pullRequests = new GitHubPullRequests(api as any, async () => context, { receiptDirectory, approve: async () => true })
  await pullRequests.create({ headBranch: 'main', baseBranch: 'release', expectedHeadSha: sha, title: 'Fixture', body: 'PRIVATE_PR_BODY', operationId: 'create-pr-111', worktreeId: before.worktreeId, deliveryContext: f.request },
    { isActive: () => true, inspectWorktree: async () => ({ branch: 'main', head: sha }), prepareDelivery: request => f.service.prepareDeliveryContext(f.authority, request, f.observe) })
  expect(pullRequestDeliveryPage(receiptDirectory, 'fixture').observations).toHaveLength(1)
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
      const response = await executeSessionTool(sessions, { refresh: vi.fn() }, 'discover_execution_context', { selector, depth: 4, mode: 'RELATION_DETAIL', limit: 24, ...(cursor ? { cursor } : {}) }, () => {})
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
  const declared = (name: string, metadata: string) => f.service.publish('---\nname: ' + name + '\ndescription: Fixture\nkind: IMPLEMENTATION_HANDOFF\n' + metadata + '\n---\nMention PR #111.')
  const shaDeclared = declared('SHA declaration', 'headCommit: ' + sha + '\nsha: ' + sha)
  const prDeclared = declared('PR declaration', 'prNumber: 111\nprUrl: https://github.com/owner/repo/pull/111')
  const wrongRepo = declared('Foreign declaration', 'repository: fork/repo\ncommitSha: ' + sha + '\nprNumber: 111')
  for (const artifact of [shaDeclared, prDeclared, wrongRepo]) await refreshFor({ kind: 'ARTIFACT', id: artifact.artifactId })
  const otherPlan = f.service.publish('---\nname: Other plan\ndescription: Fixture\nkind: EXECUTABLE_PLAN\nexecutionId: execution-A\n---\nOther candidate')
  const unrelatedHandoff = f.service.publish('---\nname: Other handoff\ndescription: Fixture\nkind: IMPLEMENTATION_HANDOFF\nrelations:\n  - artifactId: ' + otherPlan.artifactId + '\n    kind: implements\n---\nOther candidate')
  await refreshFor({ kind: 'ARTIFACT', id: unrelatedHandoff.artifactId })
  const unrelated = await query({ type: 'ARTIFACT', id: unrelatedHandoff.artifactId, revision: 1 })
  expect(unrelated.delivery.state).not.toBe('DOCUMENTED')
  expect(unrelated.paths.some((path: any) => path.target.startsWith('PR:') && path.resolution === 'EVIDENCE_PATH')).toBe(false)
  const explicitSha = await query({ type: 'ARTIFACT', id: shaDeclared.artifactId, revision: 1 })
  expect(explicitSha.paths.some((p: any) => p.target === 'PR:fixture:111' && p.evidenceClass === 'DERIVED' && p.weakestLink === 'DECLARED')).toBe(true)
  const explicitPr = await query({ type: 'ARTIFACT', id: prDeclared.artifactId, revision: 1 })
  expect(explicitPr.edges).toEqual(expect.arrayContaining([expect.objectContaining({ evidenceKind: 'HANDOFF_DECLARED', to: 'PR:fixture:111' })]))
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
  const f = await fixture(), operations = new GitOperationsService(f.root, f.git, {} as any, { repositoryId: 'fixture', isActive: () => true })
  writeFileSync(join(f.root, 'change.txt'), 'fixture'); await gitExec(f.root, ['add', 'change.txt'])
  const state = await operations.getState()
  const args = { operationId: 'mcp-commit', message: 'fixture', expectedHead: state.head, expectedIndexRevision: state.indexRevision, deliveryContext: f.request }
  expect((await executeGitOperationsTool(operations, 'commit_git_changes', args)).isError).toBe(true)
  expect(await f.git.readOperationReceipt(f.root, args.operationId)).toBeNull()
  const result = await executeGitOperationsTool(operations, 'commit_git_changes', args, request => f.service.prepareDeliveryContext(f.authority, request, f.observe))
  expect(result.isError, result.content[0].text).toBeFalsy()
  const receipt = (await f.git.readOperationReceipt(f.root, args.operationId))!.receipt
  expect(receipt.deliveryVerified).toBe(true)
  const { operationId: _operationId, ...fingerprintArgs } = args
  expect(receipt.argumentFingerprint).toBe(gitReceiptFingerprint('commit_git_changes', fingerprintArgs))
  expect((await operations.deliveryProjectionPage()).observations).toHaveLength(1)

  const snapshot = await f.observe(), spool = join(f.root, '.code-awareness/native-hooks/spool')
  prepareNativeSpool(spool)
  const binding: NativeHookBinding = { schema: 1, enabled: true, repositoryId: 'fixture', worktreeId: snapshot.worktreeId,
    generation: snapshot.worktreeGeneration, ...nativeGitIdentity(f.root), spool, gitCommitTool: 'mcp__code_awareness_local__commit_git_changes' }
  const path = sessionStorePath(join(f.root, '.git'), 'fixture')
  let sessions = new SessionStore(path, 'fixture')
  try {
    const session = 'governed-delivery-fixture', sessionId = nativeDigest(JSON.stringify(['fixture', 'codex', session]))
    const stamp = startCaptureFixture(sessions.registry, binding, sessionId)
    const payload = { session_id: session, cwd: f.root, tool_name: binding.gitCommitTool, tool_use_id: 'governed-call', tool_input: args }
    const pre = stamp(normalizeNativeHook({ ...payload, hook_event_name: 'PreToolUse' }, binding))
    const post = stamp(normalizeNativeHook({ ...payload, hook_event_name: 'PostToolUse', tool_response: result }, binding))
    expect(pre.git?.fingerprint).toBe(receipt.argumentFingerprint)
    expect(post.git).toMatchObject({ sha: await f.git.getCurrentCommitHash(f.root), replayed: false, fingerprint: receipt.argumentFingerprint })
    const invocationId = pre.invocationId!, sha = post.git!.sha!
    sessions.registry.apply(nativeObservationBatch(pre), undefined)
    expect(await correlateNativeGit(sessions.registry, binding, invocationId, f.git, () => {})).toBe('INVOCATION_INCOMPLETE')
    sessions.registry.apply(nativeObservationBatch(post), undefined)
    expect(await correlateNativeGit(sessions.registry, binding, invocationId, f.git, () => {})).toBe('VERIFIED')
    sessions.close(); sessions = new SessionStore(path, 'fixture')
    for (const selector of [{ type: 'INVOCATION', id: invocationId }, { type: 'COMMIT', id: sha }]) {
      const graph = await executeSessionTool(sessions, { refresh: vi.fn() }, 'discover_execution_context', { selector, mode: 'RELATION_DETAIL', depth: 1 }, () => {})
      expect(graph.isError, graph.content[0].text).toBeFalsy()
      expect(JSON.parse(graph.content[0].text).edges).toContainEqual(expect.objectContaining({ evidenceKind: 'NATIVE_GIT_CAUSAL', confidenceClass: 'VERIFIED_CAUSAL', relation: 'committed' }))
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
