import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fixture, markdown, withFixtureDatabase } from '../continuum/continuum-test-fixtures'
import { SessionStore, sessionStorePath } from './store'
import { ValidationLedger } from '../validation-ledger/validation-ledger'
import { registrySources } from './registry-sources'
import { nativeGitIdentity, normalizeNativeHook, prepareNativeSpool, type NativeHookBinding } from './native-hooks'
import { nativeObservationBatch } from './native-hook-ingestion'
import { correlateNativeArtifact } from './native-artifact-correlation'
import { executeSessionTool } from './mcp'
import { correlateNativeGit } from './native-git-correlation'
import { nativeDigest, type NativeHookEnvelope } from './native-hooks'
import { recordNativeGap } from './native-hooks'
import { persistNativeCapture } from './native-hook-diagnostics'
import { startCaptureFixture } from './fixtures/native-capture-fixture'
const closes: (() => void)[] = []
afterEach(() => { closes.splice(0).reverse().forEach(close => close()) })
function setup(repositoryId = 'repo') {
  const f = fixture(repositoryId); closes.push(f.close)
  mkdirSync(join(f.dir, '.git'))
  const spool = join(f.dir, '.code-awareness/native-hooks/spool'); prepareNativeSpool(spool)
  const binding: NativeHookBinding = { schema: 1, enabled: true, repositoryId, worktreeId: '1'.repeat(64), generation: '2'.repeat(64), ...nativeGitIdentity(f.dir), spool }
  let sessions = new SessionStore(sessionStorePath(f.dir, repositoryId), repositoryId); closes.push(() => sessions.close())
  const ledger = new ValidationLedger(join(f.dir, 'ledger.sqlite')); closes.push(() => ledger.close())
  const github = { commitPullRequests: vi.fn(async () => []), getPullRequest: vi.fn(), pullRequestCommits: vi.fn() }
  const read = registrySources({ repositoryId, root: f.dir, continuum: () => f.service, ledger, github, networkAllowed: () => false, assertCurrent: () => {} })
  const refresh = async (id: string) => sessions.registry.applyAll(await read({ selector: { kind: 'ARTIFACT', id }, cursors: sessions.registry.cursors() }), () => {})
  const publish = async (rawMarkdown: string, call = 'call', session = 'session', selectedBinding = binding) => {
    const receipt = f.service.publish(rawMarkdown)
    const stamp = startCaptureFixture(sessions.registry, selectedBinding, nativeDigest(JSON.stringify([repositoryId, 'codex', session])))
    for (const hook_event_name of ['PreToolUse','PostToolUse']) {
      const event = normalizeNativeHook({ hook_event_name, session_id: session, tool_use_id: call, tool_name: 'mcp__code_awareness_local__publish_artifact', cwd: selectedBinding.root, tool_input: { rawMarkdown },
        ...(hook_event_name === 'PostToolUse' ? { tool_response: { content: [{ type: 'text', text: JSON.stringify(receipt) }] } } : {}) }, selectedBinding)
      sessions.registry.apply(nativeObservationBatch(stamp(event)), undefined)
      await correlateNativeArtifact(sessions.registry, selectedBinding, event.invocationId!, {
        readReceipt: async id => f.service.readPublicationReceipt(id), associate: async value => f.service.associatePublication(value), invalidate: async (id, state) => { f.service.invalidatePublication(id, state) }
      }, () => {})
    }
    return receipt
  }
  const query = async (selector: object, extra = {}) => {
    const result = await executeSessionTool(sessions, { refresh: vi.fn() }, 'discover_execution_context', { selector, mode: 'RELATION_DETAIL', ...extra }, () => {})
    expect(result.isError).toBeFalsy(); return JSON.parse(result.content[0].text)
  }
  return { ...f, get sessions() { return sessions }, ledger, read, refresh, publish, query, binding,
    restart: () => { sessions.close(); sessions = new SessionStore(sessionStorePath(f.dir, repositoryId), repositoryId) } }
}
it('U1 composes exact publication, declared and derived relationships without copying documents or granting causal commit links', async () => {
  const f = setup(), plan = f.service.publish(markdown('Plan'))
  const raw = markdown('Handoff', `executionId: run\nrelations:\n  - artifactId: ${plan.artifactId}\n    kind: implements\n`, `See ${plan.artifactId}. PRIVATE_BODY`)
  const receipt = await f.publish(raw)
  await f.refresh(receipt.artifactId + ':1')
  const graph = await f.query({ type: 'ARTIFACT', id: receipt.artifactId, revision: 1 })
  expect(graph.edges.some((e: any) => e.confidenceClass === 'VERIFIED_CAUSAL' && e.relation === 'published')).toBe(true)
  expect(graph.edges.some((e: any) => e.confidenceClass === 'DECLARED' && e.relation === 'implements')).toBe(true)
  expect(graph.edges.some((e: any) => e.confidenceClass === 'DERIVED' && e.relation === 'references')).toBe(true)
  expect(graph.edges.some((e: any) => e.evidenceKind === 'EXECUTION_MEMBERSHIP')).toBe(true)
  expect(JSON.stringify(graph)).not.toContain('PRIVATE_BODY')
  expect(graph.edges.some((e: any) => e.from.startsWith('ARTIFACT:') && e.to.startsWith('COMMIT:'))).toBe(false)
  expect(f.service.get(receipt.artifactId)!.rawMarkdown).toBe(raw)
})
async function commit(f: ReturnType<typeof setup>, session = 'session', sha = 'a'.repeat(40), binding = f.binding) {
  const invocationId = nativeDigest(sha), fingerprint = nativeDigest('args'), parent = 'b'.repeat(40)
  const stamp = startCaptureFixture(f.sessions.registry, binding, nativeDigest(JSON.stringify(['repo', 'codex', session])))
  for (const event of ['PreToolUse','PostToolUse'] as const) {
    const envelope: NativeHookEnvelope = { schema: 1, source: 'CODEX_NATIVE_HOOK', repositoryId: 'repo', worktreeId: binding.worktreeId, generation: binding.generation,
      sessionId: nativeDigest(JSON.stringify(['repo','codex',session])), event, invocationId, observedAt: new Date().toISOString(), eventId: nativeDigest(event + sha), digest: nativeDigest(event + sha + 'safe'),
      git: { operationId: 'git-proof-' + sha, fingerprint, expectedHead: parent, ...(event === 'PostToolUse' ? { sha, parent, replayed: false } : {}) } }
    f.sessions.registry.apply(nativeObservationBatch(stamp(envelope)), undefined)
  }
  const git = { readOperationReceipt: async () => ({ sha: 'c'.repeat(40), receipt: { operationId: 'git-proof-' + sha, operation: 'commit_git_changes', argumentFingerprint: fingerprint, status: 'COMPLETED' as const,
    createdAt: new Date().toISOString(), result: { content: [{ type: 'text' as const, text: JSON.stringify({ sha, parent }) }] } } }), getCommitOperationObjects: async () => [{ sha, parents: [parent], title: 'PRIVATE_TITLE' }] }
  expect(await correlateNativeGit(f.sessions.registry, binding, invocationId, git, () => {})).toBe('VERIFIED')
  return sha
}
it('F2 preserves separate native and Entire identities without an independently verified alias', async () => {
  const f = setup(), receipt = await f.publish(markdown('Separate providers'), 'call', 'same-session-label')
  f.sessions.ingest({ provider: 'entire', providerSessionId: 'same-session-label', providerVersion: 'fixture', agent: 'codex',
    state: 'UNKNOWN', coverage: 'PARTIAL', importState: 'METADATA_ONLY', sourceDigest: nativeDigest('fixture'), sourceBytes: 0 }, [])
  const native = f.sessions.registry.nativeSessions(0, 20)
  expect(native).toHaveLength(1)
  expect(native[0].aliasState).toBe('NOT_RECONCILED')
  const graph = await pages(f, { type: 'ARTIFACT', id: receipt.artifactId, revision: 1 })
  expect(graph.edges.some(edge => edge.from.endsWith('entire:same-session-label') || edge.to.endsWith('entire:same-session-label'))).toBe(false)
  expect(f.sessions.registry.contextGraph({ kind: 'SESSION', id: 'entire:same-session-label' }).nodes).toHaveLength(1)
})
async function pages(f: ReturnType<typeof setup>, selector: object, extra = {}) {
  const edges: any[] = [], paths: any[] = []
  let cursor: string | undefined
  for (let page = 0; page < 40; page++) {
    const result = await f.query(selector, { ...extra, ...(cursor ? { cursor } : {}) })
    edges.push(...result.edges); paths.push(...result.paths)
    if (!result.nextCursor) return { edges, paths }
    cursor = result.nextCursor
  }
  throw new Error('PAGE_LIMIT')
}
it('U2 navigates Handoff → publication → session → commit and back as contextual paths, never direct causal implementation', async () => {
  const f = setup(), receipt = await f.publish(markdown('Handoff'))
  const sha = await commit(f)
  const otherCommit = await commit(f, 'session', 'd'.repeat(40))
  await f.refresh(receipt.artifactId + ':1')
  const outward = await pages(f, { type: 'ARTIFACT', id: receipt.artifactId, revision: 1 }, { limit: 2 })
  const toCommit = outward.paths.find(path => path.target.endsWith(sha))
  expect(toCommit).toMatchObject({ confidenceClass: 'CONTEXTUAL', meaning: 'EXECUTION_CONTEXT_NOT_IMPLEMENTATION_PROOF' })
  expect(outward.edges.some(edge => edge.from.startsWith('ARTIFACT:') && edge.to.startsWith('COMMIT:'))).toBe(false)
  const reverse = await pages(f, { type: 'COMMIT', id: sha }, { limit: 2 })
  expect(reverse.paths.find(path => path.target.endsWith(receipt.artifactId + ':1'))?.confidenceClass).toBe('CONTEXTUAL')
  expect(reverse.paths.find(path => path.target.endsWith(otherCommit))?.confidenceClass).toBe('CONTEXTUAL')
  expect(new Set(outward.edges.map(edge => edge.id)).size).toBe(outward.edges.length)
  const one = await f.query({ type: 'ARTIFACT', id: receipt.artifactId, revision: 1 }, { depth: 1 })
  expect(one.paths.every((path: any) => path.edges.length === 1)).toBe(true)
  expect(one.nodes.some((node: any) => node.type === 'COMMIT')).toBe(false)
  const invocation = one.nodes.find((node: any) => node.type === 'EXECUTION' && node.id.startsWith('native-invocation:'))
  expect((await f.query({ type: 'INVOCATION', id: invocation.id.slice(18) }, { depth: 1 })).edges.length).toBeGreaterThan(0)
  const scope = await f.query({ type: 'WORKTREE', id: f.binding.worktreeId, generation: f.binding.generation }, { depth: 1 })
  expect(scope.nodes.find((node: any) => node.type === 'WORKTREE').generation).toBe(f.binding.generation)
})
it('U2 projects a Ledger proof in both directions only through evidenceFor, with selected-scope reads and stable pagination', async () => {
  const f = setup(), receipt = f.service.publish(markdown('Plan'))
  const proof = f.ledger.recordProof({ kind: 'TARGETED_TEST', producer: 'IMPLEMENTER', status: 'PASSED', startedAt: '2026-11-05T00:00:00Z', finishedAt: '2026-11-05T00:00:01Z', durationMs: 1000, summary: 'safe', scope: ['fixture'], evidenceFor: [receipt.artifactId] })
  const unrelated = f.ledger.recordProof({ kind: 'TARGETED_TEST', producer: 'IMPLEMENTER', status: 'PASSED', startedAt: '2026-11-05T00:00:00Z', finishedAt: '2026-11-05T00:00:01Z', durationMs: 1000, summary: 'unrelated', scope: ['fixture'], evidenceFor: [] })
  const inventory = vi.spyOn(f.ledger, 'projectionPage')
  f.sessions.registry.applyAll(await f.read({ selector: { kind: 'PROOF', id: proof.proofId }, cursors: {} }), () => {})
  expect(inventory).not.toHaveBeenCalled()
  const byProof = await pages(f, { type: 'PROOF', id: proof.proofId }, { depth: 1, limit: 1 })
  expect(byProof.edges).toHaveLength(1)
  expect(byProof.edges[0]).toMatchObject({ evidenceKind: 'LEDGER_EVIDENCE_FOR', revisionScope: 'ARTIFACT_IDENTITY_ONLY', confidenceClass: 'OBSERVED' })
  const byArtifact = await pages(f, { type: 'ARTIFACT', id: receipt.artifactId }, { depth: 1, limit: 1 })
  expect(byArtifact.edges.some(edge => edge.evidenceRef === proof.proofId)).toBe(true)
  expect(byArtifact.edges.some(edge => edge.evidenceRef === unrelated.proofId)).toBe(false)
})
it('U3 preserves revision history, rejects stale cursors, and does not transfer publication evidence to a new revision after restart', async () => {
  const f = setup(), raw = markdown('Original'), receipt = await f.publish(raw)
  await f.refresh(receipt.artifactId)
  const oldPage = await f.query({ type: 'ARTIFACT', id: receipt.artifactId }, { limit: 1 })
  expect(oldPage.nextCursor).toBeTruthy()
  const original = f.service.provenanceSnapshot(receipt.artifactId, 1)!
  f.service.update(receipt.artifactId, 1, 'New literal body')
  await f.refresh(receipt.artifactId)
  const stale = await executeSessionTool(f.sessions, { refresh: vi.fn() }, 'discover_execution_context', { selector: { type: 'ARTIFACT', id: receipt.artifactId }, mode: 'RELATION_DETAIL', limit: 1, cursor: oldPage.nextCursor }, () => {})
  expect(stale.isError).toBe(true); expect(JSON.parse(stale.content[0].text).code).toBe('CURSOR_STALE')
  f.restart()
  const current = await pages(f, { type: 'ARTIFACT', id: receipt.artifactId, revision: 2 })
  expect(current.edges.filter(edge => edge.evidenceKind === 'NATIVE_ARTIFACT_CAUSAL')).toEqual([])
  await f.refresh(receipt.artifactId + ':1')
  const historical = await pages(f, { type: 'ARTIFACT', id: receipt.artifactId, revision: 1 })
  expect(historical.edges.some(edge => edge.confidenceClass === 'VERIFIED_CAUSAL')).toBe(true)
  expect(f.service.provenanceSnapshot(receipt.artifactId, 1)!.contentHash).toBe(original.contentHash)
  expect(f.service.provenanceSnapshot(receipt.artifactId, 1)!.rawMarkdown).toBe(raw)
  withFixtureDatabase(f.path, db => { expect(JSON.parse((db.prepare('SELECT snapshot_json FROM artifact_revisions WHERE artifact_id=? AND revision=1').get(receipt.artifactId) as { snapshot_json: string }).snapshot_json).rawMarkdown).toBe(raw) })
})
it('U3 keeps two sessions, commits and proofs separate and leaves suggestions outside confirmed edges', async () => {
  const f = setup()
  const root = join(f.dir, 'other-worktree'); mkdirSync(root); mkdirSync(join(root, '.git'))
  const spool = join(root, '.code-awareness/native-hooks/spool'); prepareNativeSpool(spool)
  const otherBinding = { ...f.binding, ...nativeGitIdentity(root), worktreeId: '3'.repeat(64), generation: '4'.repeat(64), spool }
  const first = await f.publish(markdown('Development provenance alpha', 'executionId: shared-run\n'), 'first', 'first-session')
  const second = await f.publish(markdown('Development provenance beta', 'executionId: shared-run\n'), 'second', 'second-session', otherBinding)
  const firstCommit = await commit(f, 'first-session', 'a'.repeat(40)), secondCommit = await commit(f, 'second-session', 'd'.repeat(40), otherBinding)
  const proofs = [first, second].map(receipt => f.ledger.recordProof({ kind: 'TARGETED_TEST', producer: 'IMPLEMENTER', status: 'PASSED', startedAt: '2026-11-05T00:00:00Z', finishedAt: '2026-11-05T00:00:01Z', durationMs: 1000, summary: 'fixture', scope: ['fixture'], evidenceFor: [receipt.artifactId] }))
  const list = vi.spyOn(f.service, 'list'), inventory = vi.spyOn(f.ledger, 'projectionPage')
  await f.refresh(first.artifactId)
  await f.refresh(second.artifactId)
  expect(list.mock.calls.every(([filter]) => !!filter?.metadata || !!filter?.relatedToArtifactId)).toBe(true)
  expect(inventory).not.toHaveBeenCalled()
  for (const [index, receipt] of [first, second].entries()) {
    const graph = await pages(f, { type: 'ARTIFACT', id: receipt.artifactId }, { depth: 1 })
    expect(graph.edges.filter(edge => edge.evidenceKind === 'LEDGER_EVIDENCE_FOR').map(edge => edge.evidenceRef)).toEqual([proofs[index].proofId])
  }
  const graph = await pages(f, { type: 'COMMIT', id: firstCommit })
  expect(graph.paths.find(path => path.target.endsWith(first.artifactId + ':1'))?.confidenceClass).toBe('CONTEXTUAL')
  expect(graph.edges.some(edge => edge.to.endsWith(secondCommit) && edge.confidenceClass === 'VERIFIED_CAUSAL')).toBe(false)
  expect(f.service.suggestions({ artifactId: first.artifactId }).suggestions.some(item => item.targetArtifactId === second.artifactId && item.origin === 'SUGGESTED')).toBe(true)
  expect(graph.edges.some(edge => edge.confidenceClass === 'SUGGESTED')).toBe(false)
  const other = setup('other')
  const foreign = await other.query({ type: 'ARTIFACT', id: first.artifactId })
  expect(foreign.edges).toEqual([]); expect(foreign.coverage.state).toBe('UNKNOWN')
})
it('U3 reports capture gaps as PARTIAL, isolated Artifacts as UNKNOWN, and bounds high-degree neighborhoods', async () => {
  const f = setup(), receipt = await f.publish(markdown())
  await f.refresh(receipt.artifactId)
  recordNativeGap(f.binding.spool, 'SPOOL_FULL', 'WRITE', 'PostToolUse')
  persistNativeCapture(f.sessions.registry, f.binding, { ingested: 0, rejected: 0, expired: 0, pending: false }, () => {})
  const gap = await f.query({ type: 'ARTIFACT', id: receipt.artifactId, revision: 1 })
  expect(gap.coverage).toMatchObject({ state: 'PARTIAL', reasons: expect.arrayContaining(['NATIVE_CAPTURE_HISTORICALLY_PARTIAL']), negativeInference: 'NOT_AUTHORIZED' })
  const isolated = f.service.publish(markdown('Isolated'))
  await f.refresh(isolated.artifactId)
  const alone = await f.query({ type: 'ARTIFACT', id: isolated.artifactId }, { depth: 1 })
  expect(alone.coverage).toMatchObject({ state: 'UNKNOWN', reasons: expect.arrayContaining(['PROVENANCE_NOT_OBSERVED']) })
  const members = Array.from({ length: 50 }, (_, index) => f.service.publish(markdown('Member ' + index)).artifactId)
  const hub = f.service.publish(markdown('Hub', 'relations:\n' + members.map(id => `  - artifactId: ${id}\n    kind: related-to\n`).join('')))
  await f.refresh(hub.artifactId)
  const bounded = await f.query({ type: 'ARTIFACT', id: hub.artifactId, revision: 1 }, { depth: 1, limit: 3 })
  expect(bounded.edges.length).toBeLessThanOrEqual(3)
  expect(bounded.nextCursor).toBeTruthy(); expect(bounded.coverage.state).toBe('PARTIAL')
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(16384)
})
it('U1 rechecks authoritative association revocation and refuses a foreign repository service', async () => {
  const f = setup(), receipt = await f.publish(markdown())
  await f.refresh(receipt.artifactId + ':1')
  const before = await f.query({ type: 'ARTIFACT', id: receipt.artifactId, revision: 1 })
  const invocation = before.nodes.find((n: any) => n.type === 'EXECUTION' && n.id.startsWith('native-invocation:')).id.slice('native-invocation:'.length)
  f.service.invalidatePublication(invocation, 'AMBIGUOUS')
  await f.refresh(receipt.artifactId + ':1')
  const after = await f.query({ type: 'ARTIFACT', id: receipt.artifactId, revision: 1 })
  expect(after.edges.filter((e: any) => e.evidenceKind === 'NATIVE_ARTIFACT_CAUSAL').every((e: any) => e.confidenceClass !== 'VERIFIED_CAUSAL')).toBe(true)
  const foreign = registrySources({ repositoryId: 'foreign', root: f.dir, continuum: () => f.service, ledger: f.ledger, github: {} as any, networkAllowed: () => false, assertCurrent: () => {} })
  await expect(foreign({ selector: { kind: 'ARTIFACT', id: receipt.artifactId }, cursors: {} })).rejects.toThrow('REPOSITORY_CONTEXT_CHANGED')
})
