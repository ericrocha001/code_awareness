import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore, sessionStorePath } from './store'
import { digest } from './privacy'
import { executeSessionTool, SESSION_CONTEXT_TOOLS } from './mcp'
import type { RegistryEdge, RegistryEntity } from './checkpoint-registry'
import { executionContextQuery } from './execution-context'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { reconcileRegistry } from './registry-reconciliation'
import { runReadOnly } from './entire-provider'

const closes: (() => void)[] = []
afterEach(() => { for (const close of closes.reverse()) close(); closes.length = 0 })
const commit = 'e9343e7998b877682604bb772a7ecb31bb8b81e5', checkpoint = '01M6EGW7096RMXJE1VPD76NDSQ'
const handoff = 'artifact-11111111-1111-4111-8111-111111111111', plan1 = 'artifact-22222222-2222-4222-8222-222222222222', plan2 = 'artifact-33333333-3333-4333-8333-333333333333'
const proof1 = 'proof-44444444-4444-4444-8444-444444444444', proof2 = 'proof-55555555-5555-4555-8555-555555555555'
const entity = (kind: RegistryEntity['kind'], id: string): RegistryEntity => ({ kind, id })
function fixture(repositoryId = 'repo') {
  const base = mkdtempSync(join(tmpdir(), 'execution-context-')), store = new SessionStore(sessionStorePath(base, repositoryId), repositoryId)
  closes.push(() => { store.close(); rmSync(base, { recursive: true, force: true }) })
  const runner = vi.fn(async () => { throw new Error('READ_MUST_NOT_RUN_GIT') }), read = vi.fn(async () => { throw new Error('READ_MUST_NOT_RECONCILE') }), provider = { refresh: vi.fn(async () => { throw new Error('READ_MUST_NOT_RUN_ENTIRE') }) }
  const call = (args: unknown, accountHash?: string) => executeSessionTool(store, provider, 'discover_execution_context', args, () => {}, undefined, [], runner, process.cwd(), undefined, read, accountHash)
  const add = (edges: RegistryEdge[], source = 'FIXTURE', revision = '1') => store.registry.apply({ repositoryId, source, revision, status: 'COMPLETE', edges }, store.registry.source(source)?.revision)
  return { store, call, runner, read, provider, add }
}
function edge(from: RegistryEntity, to: RegistryEntity, evidenceKind: string, relation = 'fixture'): RegistryEdge {
  return { from, to, evidenceKind, relation, evidenceRef: from.id, digest: digest('fixture evidence'), freshness: evidenceKind === 'LEDGER_EVIDENCE_FOR' ? 'UNVERIFIABLE' : 'OBSERVED_SNAPSHOT' }
}
function composite(f: ReturnType<typeof fixture>) {
  f.add([
    edge(entity('COMMIT', commit), entity('PR', '91'), 'GITHUB_COMMIT_LIST'),
    edge(entity('COMMIT', commit), entity('CHECKPOINT', checkpoint), 'CHECKPOINT_VERIFIED'),
    edge(entity('CHECKPOINT', checkpoint), entity('SESSION', 'entire:session-one'), 'CHECKPOINT_SESSION_METADATA'),
    edge(entity('CHECKPOINT', checkpoint), entity('SESSION', 'entire:session-two'), 'CHECKPOINT_SESSION_METADATA'),
    edge(entity('ARTIFACT', handoff), entity('PR', '91'), 'HANDOFF_DECLARED'),
    edge(entity('ARTIFACT', handoff), entity('ARTIFACT', plan1), 'CONTINUUM_TYPED_RELATION', 'implements'),
    edge(entity('ARTIFACT', handoff), entity('ARTIFACT', plan2), 'CONTINUUM_TYPED_RELATION', 'implements'),
    edge(entity('ARTIFACT', plan1), entity('PROOF', proof1), 'LEDGER_EVIDENCE_FOR'),
    edge(entity('ARTIFACT', plan2), entity('PROOF', proof2), 'LEDGER_EVIDENCE_FOR')
  ])
}
const data = (result: { content: readonly unknown[] }) => JSON.parse((result.content[0] as { text: string }).text)
it('returns both complete chains in one compact index-only MAP without importing or claiming authorship', async () => {
  const f = fixture(); composite(f)
  const result = await f.call({ selector: { type: 'PR', id: '91' } }), map = data(result)
  expect(result.isError).toBeFalsy()
  expect(map.counts).toMatchObject({ SESSION: 2, ARTIFACT: 3, PROOF: 2, COMMIT: 1, CHECKPOINT: 1 })
  expect(map.edges).toHaveLength(9)
  expect(map.paths.filter((p: any) => p.target.includes(':SESSION:') || p.target.startsWith('SESSION:'))).toHaveLength(2)
  expect(map.paths.every((p: any) => p.edges.length <= 4)).toBe(true)
  expect(map.edges.find((e: any) => e.evidenceKind === 'HANDOFF_DECLARED').state).toBe('DECLARED')
  expect(map.edges.filter((e: any) => e.evidenceKind === 'LEDGER_EVIDENCE_FOR').every((e: any) => e.freshness === 'UNVERIFIABLE')).toBe(true)
  expect(map.authorship).toBe('NOT_INFERRED')
  expect(f.store.count()).toBe(0)
  expect(f.runner).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(f.provider.refresh).not.toHaveBeenCalled()
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(16384)
  expect(map.nodes.some((n: any) => n.deepen?.tool === 'get_validation_proof')).toBe(true)
})
it('keeps PR relations and explicit capture gap when no checkpoint exists, including offline last-known sources', async () => {
  const f = fixture()
  f.add([edge(entity('COMMIT', commit), entity('PR', '91'), 'GITHUB_COMMIT_LIST'), edge(entity('ARTIFACT', handoff), entity('PR', '91'), 'HANDOFF_DECLARED')])
  f.store.registry.apply({ repositoryId: 'repo', source: 'GITHUB', revision: 'offline', status: 'UNAVAILABLE', edges: [] }, undefined)
  const map = data(await f.call({ selector: { type: 'PR', id: '91' } }))
  expect(map.edges).toHaveLength(2)
  expect(map.captureCoverage).toBe('CHECKPOINT_NOT_OBSERVED')
  expect(map.sourceCoverage).toContainEqual(expect.objectContaining({ source: 'GITHUB', status: 'UNAVAILABLE', observedAt: expect.any(String) }))
  expect(map.freshness).toBe('LAST_KNOWN_NOT_RECHECKED')
})
it('rejects noncanonical selectors and foreign repository or account fields without source calls', async () => {
  const f = fixture()
  for (const selector of [{ type: 'COMMIT', id: '../private' }, { type: 'PR', id: '0' }, { type: 'ARTIFACT', id: 'untyped' }, { type: 'SESSION', id: 'session', provider: 'other' }, { type: 'PROOF', id: proof1, repositoryId: 'other' }]) {
    expect(data(await f.call({ selector })).code).toBe('INVALID_ARGUMENT')
  }
  expect(data(await f.call({ selector: { type: 'PR', id: '91' }, repositoryId: 'other' })).code).toBe('INVALID_ARGUMENT')
  expect(f.runner).not.toHaveBeenCalled()
})
it('paginates deterministically without losing identities and rejects stale or cross-repository cursors', async () => {
  const f = fixture(); composite(f)
  const args = { selector: { type: 'PR', id: '91' }, limit: 2 }, ids: string[] = []
  let cursor: string | undefined, firstCursor = ''
  do {
    const page = data(await f.call({ ...args, ...(cursor ? { cursor } : {}) }))
    ids.push(...page.edges.map((e: any) => e.id)); cursor = page.nextCursor
    firstCursor ||= cursor ?? ''
  } while (cursor)
  expect(ids).toHaveLength(9); expect(new Set(ids).size).toBe(9)
  const foreign = fixture('other')
  expect(data(await foreign.call({ ...args, cursor: firstCursor })).code).toBe('CURSOR_STALE')
  f.add([edge(entity('PR', '91'), entity('EXECUTION', 'new-execution'), 'HANDOFF_DECLARED')], 'NEW')
  expect(data(await f.call({ ...args, cursor: firstCursor })).code).toBe('CURSOR_STALE')
})
it('returns metadata evidence only in RELATION_DETAIL and bounds unrelated Continuum traversal', async () => {
  const f = fixture(); composite(f)
  f.add([edge(entity('ARTIFACT', plan1), entity('ARTIFACT', 'artifact-66666666-6666-4666-8666-666666666666'), 'CONTINUUM_TYPED_RELATION', 'related-to')], 'UNRELATED')
  const detail = data(await f.call({ selector: { type: 'ARTIFACT', id: plan1 }, mode: 'RELATION_DETAIL' }))
  expect(detail.edges.every((e: any) => typeof e.digest === 'string' && e.observedAt && e.sourceRevision)).toBe(true)
  expect(detail.nodes.some((n: any) => n.id.includes('66666666'))).toBe(false)
  const serialized = JSON.stringify(detail)
  for (const field of ['transcript', 'rawMarkdown', 'stdout', 'cwd', 'sourceCode', 'tokenUsage']) expect(serialized).not.toContain('"' + field + '"')
})
it('retains historical session references through local UUID or exact provider identity without quota eviction', async () => {
  const f = fixture()
  const session = f.store.ingest({ providerSessionId: 'session-one', providerVersion: 'fixture', agent: 'codex', state: 'ENDED', endedAt: '2026-01-01T00:00:00Z', coverage: 'COMPLETE', sourceDigest: digest('fixture'), sourceBytes: 0 }, [])
  composite(f)
  const before = data(await f.call({ selector: { type: 'SESSION', id: session.sessionId } }))
  expect(before.nodes.some((n: any) => n.payloadState === 'IMPORTED')).toBe(true)
  for (let i = 0; i < 500; i++) f.store.ingest({ providerSessionId: 'retention-' + i, providerVersion: 'fixture', agent: 'codex', state: 'ENDED', endedAt: '2026-02-01T00:00:00Z', coverage: 'COMPLETE', sourceDigest: digest(String(i)), sourceBytes: 0 }, [])
  const after = data(await f.call({ selector: { type: 'SESSION', provider: 'entire', id: 'session-one' } }))
  expect(after.nodes.some((n: any) => n.payloadState === 'IMPORTED')).toBe(true)
  expect(f.store.session(session.sessionId).eventCount).toBe(0)
})
it('hides Codex identity and paths from other accounts while preserving authorized Entire relations', async () => {
  const f = fixture()
  const session = f.store.ingest({ provider: 'codex', providerSessionId: 'archived-one', providerVersion: 'fixture', agent: 'codex', state: 'UNKNOWN', coverage: 'PARTIAL', sourceDigest: digest('archive'), sourceBytes: 0 }, [])
  f.store.recordAssociation({ repositoryId: 'repo', sessionId: session.sessionId, provider: 'codex', providerSessionId: 'archived-one', worktreeId: 'a'.repeat(64), generation: 'b'.repeat(64), origin: 'CODEX_APP_SERVER', evidence: 'WORKTREE_VERIFIED', providerAccountHash: digest('account-A'), archived: true }, f.store.catalogRevision())
  f.add([edge(entity('SESSION', 'codex:archived-one'), entity('EXECUTION', 'execution'), 'WORKTREE_VERIFIED')])
  const selector = { type: 'EXECUTION', id: 'execution' }
  expect(data(await f.call({ selector }, digest('account-A'))).nodes.some((n: any) => n.id === 'archived-one')).toBe(true)
  expect(JSON.stringify(data(await f.call({ selector }, digest('account-B'))))).not.toContain('archived-one')
  expect(JSON.stringify(data(await f.call({ selector })))).not.toContain('archived-one')
})
it('advertises one discovery capability and explicit refresh on the existing Channel with strict arguments', async () => {
  const f = fixture(); composite(f)
  const adapter = new ChannelMcpAdapter({ projectId: 'repo', repoRoot: '/fixture', navigation: {} as any, sessionContext: { call: (name, args) => name === 'discover_execution_context' ? f.call(args) : Promise.resolve({ content: [] }) } })
  expect(adapter.listTools().filter(t => t.name === 'discover_execution_context')).toHaveLength(1)
  const result = await adapter.callTool('discover_execution_context', { selector: { type: 'PR', id: '91' } })
  expect(data(result).edges).toHaveLength(9)
  expect(SESSION_CONTEXT_TOOLS.find(t => t.name === 'refresh_agent_sessions')?.inputSchema.properties).toHaveProperty('contextSelector')
  expect(executionContextQuery.safeParse({ selector: { type: 'PR', id: '91' }, limit: 25 }).success).toBe(false)
})
it('returns reconciliation guidance for an unknown ID without fabricating index entities', async () => {
  const f = fixture(), map = data(await f.call({ selector: { type: 'COMMIT', id: commit } }))
  expect(map.state).toBe('RECONCILIATION_PENDING'); expect(map.nodes).toEqual([]); expect(map.edges).toEqual([])
  expect(map.reconciliation.arguments).toEqual({ contextSelector: { type: 'COMMIT', id: commit } })
})
it('keeps the approved response ceiling and original cursor scope when a bounded PR group requires smaller pages', async () => {
  const f = fixture()
  f.add(Array.from({ length: 30 }, (_, index) => edge(entity('COMMIT', index.toString(16).padStart(40, '0')), entity('PR', '91'), 'GITHUB_COMMIT_LIST')))
  for (const mode of ['MAP', 'RELATION_DETAIL']) {
    const ids = new Set<string>(); let cursor: string | undefined
    do {
      const result = await f.call({ selector: { type: 'PR', id: '91' }, mode, limit: 24, ...(cursor ? { cursor } : {}) })
      expect(result.isError).toBeFalsy(); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(16384)
      const page = data(result); for (const edge of page.edges) ids.add(edge.id); cursor = page.nextCursor
    } while (cursor)
    expect(ids.size).toBe(30)
  }
})
it('reconciles only after an explicit selector refresh without entering the transcript import branch', async () => {
  const f = fixture()
  const read = vi.fn(async () => [{ repositoryId: 'repo', source: 'CONTINUUM:' + handoff, revision: '1', status: 'COMPLETE', edges: [edge(entity('ARTIFACT', handoff), entity('ARTIFACT', plan1), 'CONTINUUM_TYPED_RELATION', 'implements')] }])
  const request = { contextSelector: { type: 'ARTIFACT', id: plan1 } }
  const refreshed = await executeSessionTool(f.store, f.provider, 'refresh_agent_sessions', request, () => {}, undefined, [], f.runner, process.cwd(), undefined, read)
  expect(data(refreshed)).toMatchObject({ state: 'RECONCILED', transcriptImported: false })
  expect(read).toHaveBeenCalledOnce(); expect(f.provider.refresh).not.toHaveBeenCalled(); expect(f.runner).not.toHaveBeenCalled()
  expect(data(await f.call({ selector: request.contextSelector })).nodes).toHaveLength(2)
  const invalid = await executeSessionTool(f.store, f.provider, 'refresh_agent_sessions', { ...request, sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, () => {})
  expect(data(invalid).code).toBe('INVALID_ARGUMENT')
})
it.skipIf(process.env.EXECUTION_CONTEXT_REAL !== '1')('accepts an actual repository checkpoint chain after explicit read-only reconciliation', async () => {
  const f = fixture('e1c8a999-6d73-4f56-83a3-fbcd78c9c19d')
  await reconcileRegistry(f.store, runReadOnly, process.cwd(), { kind: 'COMMIT', id: commit }, () => {})
  const result = await f.call({ selector: { type: 'COMMIT', id: commit } }), map = data(result)
  expect(result.isError).toBeFalsy(); expect(map.counts.SESSION).toBe(2); expect(map.counts.CHECKPOINT).toBe(1)
  expect(f.store.count()).toBe(0)
}, 20000)
