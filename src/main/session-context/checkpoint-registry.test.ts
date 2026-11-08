import { afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore, sessionStorePath } from './store'
import { digest } from './privacy'
import { legacyStoreFixture } from './fixtures/legacy-store-fixture'
import { REGISTRY_SCHEMA, type RegistryBatch } from './checkpoint-registry'
import { reconcileRegistry } from './registry-reconciliation'
import { registrySources } from './registry-sources'
import { executeSessionTool } from './mcp'
import type { CommandRunner } from './entire-provider'
import { ValidationLedger } from '../validation-ledger/validation-ledger'
import { runReadOnly } from './entire-provider'
import { buildSync } from 'esbuild'
import { SessionContextClient } from './client'
import { GitHubApiClient } from '../github/github-api-client'
import { handoffSessionCoverage } from './handoff'
import { GitHubIntegrationService } from '../github/github-integration-service'
import { nativeObservationBatch } from './native-hook-ingestion'
import { correlateNativeGit } from './native-git-correlation'
import { recordNativeGap, type NativeHookBinding, type NativeHookEnvelope } from './native-hooks'
import { startCaptureFixture } from './fixtures/native-capture-fixture'
import { fixture as continuumFixture, markdown } from '../continuum/continuum-test-fixtures'
import { SessionProjectionCoordinator } from './projection-coordinator'
import type { SessionTargetResolver } from './target'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'

const cleanup: (() => void)[] = []
afterEach(() => { for (const f of cleanup.reverse()) f(); cleanup.length = 0 })
function fixture(withLegacy = false) {
  const base = mkdtempSync(join(tmpdir(), 'checkpoint-registry-')), path = sessionStorePath(base, 'repo')
  if (withLegacy) {
    const legacy = legacyStoreFixture(path, 'repo', base)
    legacy.ingest({ providerSessionId: 'legacy', providerVersion: 'fixture', agent: 'codex', state: 'ENDED', endedAt: '2026-01-01T00:00:00Z', coverage: 'COMPLETE', sourceDigest: digest('old'), sourceBytes: 8, importState: 'TRANSCRIPT_IMPORTED' }, [{ type: 'INPUT', sourcePosition: 1, text: 'private 🧪 payload' }])
    legacy.close()
  }
  let store = new SessionStore(path, 'repo')
  cleanup.push(() => { store.close(); rmSync(base, { recursive: true, force: true }) })
  return { base, path, store: () => store, restart: () => { store.close(); store = new SessionStore(path, 'repo') } }
}
const commit = 'e9343e7998b877682604bb772a7ecb31bb8b81e5', checkpoint = '01M6EGW7096RMXJE1VPD76NDSQ'
it('F2 projects an Artifact readable by the real Continuum service through the initial registry inventory', async () => {
  const f = fixture(), continuum = continuumFixture('repo'), source = sources(f, false)
  cleanup.push(continuum.close)
  const receipt = continuum.service.publish(markdown('Projection'))
  expect(continuum.service.get(receipt.artifactId)?.revision).toBe(1)
  const read = registrySources({ repositoryId: 'repo', root: f.base, continuum: () => continuum.service, ledger: source.ledger,
    github: source.github as any, networkAllowed: () => false, assertCurrent: () => {} })
  const batches = await read({ cursors: {} })
  expect(batches.find(batch => batch.source === 'CONTINUUM')?.status).toBe('COMPLETE')
  expect(batches.some(batch => batch.source === 'CONTINUUM:' + receipt.artifactId + ':1')).toBe(true)
  f.store().registry.applyAll(batches, () => {})
  continuum.service.update(receipt.artifactId, 1, markdown('Updated'))
  f.store().registry.applyAll(await read({ selector: { kind: 'ARTIFACT', id: receipt.artifactId }, cursors: f.store().registry.cursors() }), () => {})
  expect(f.store().registry.map({ kind: 'ARTIFACT', id: receipt.artifactId }).edges.some(edge => edge.to.id === receipt.artifactId + ':1' && edge.state === 'SUPERSEDED')).toBe(true)
  expect(f.store().registry.source('CONTINUUM_CURRENT:' + receipt.artifactId)?.revision.startsWith('2:')).toBe(true)
  const unavailable = registrySources({ repositoryId: 'repo', root: f.base, continuum: () => null, ledger: source.ledger,
    github: source.github as any, networkAllowed: () => false, assertCurrent: () => {} })
  f.store().registry.applyAll(await unavailable({ cursors: f.store().registry.cursors() }), () => {})
  expect(f.store().registry.contextGraph({ kind: 'ARTIFACT', id: receipt.artifactId }).edges.filter(edge => edge.source === 'CONTINUUM').every(edge => edge.state === 'STALE')).toBe(true)
  expect(f.store().registry.source('CONTINUUM_CURRENT:' + receipt.artifactId)?.revision.startsWith('2:')).toBe(true)
})
it('F2 distinguishes stale inventory cursors from failed readback and retains the known projection', async () => {
  const f = fixture(), continuum = continuumFixture('repo'), source = sources(f, false)
  cleanup.push(continuum.close)
  const receipt = continuum.service.publish(markdown('Cursor'))
  const read = registrySources({ repositoryId: 'repo', root: f.base, continuum: () => continuum.service, ledger: source.ledger,
    github: source.github as any, networkAllowed: () => false, assertCurrent: () => {} })
  const stale = await read({ cursors: { CONTINUUM: JSON.stringify({ after: '2020-01-01T00:00:00.000Z', cursor: 'obsolete' }) } })
  expect(stale.find(batch => batch.source === 'CONTINUUM')?.status).toBe('PARTIAL')
  expect(JSON.parse(stale.find(batch => batch.source === 'CONTINUUM:DIAGNOSTIC')!.cursor!)).toMatchObject({ reasonCode: 'CURSOR_STALE' })
  const malformed = await read({ cursors: { CONTINUUM: 'null' } })
  expect(JSON.parse(malformed.find(batch => batch.source === 'CONTINUUM:DIAGNOSTIC')!.cursor!)).toEqual({ reasonCode: 'CURSOR_STALE', stage: 'INVENTORY_CURSOR' })
  f.store().registry.applyAll(stale, () => {})
  f.restart()
  f.store().registry.applyAll(await read({ cursors: f.store().registry.cursors() }), () => {})
  expect(f.store().registry.source('CONTINUUM_CURRENT:' + receipt.artifactId)).toBeDefined()
  const failure = vi.spyOn(continuum.service, 'provenanceSnapshot').mockImplementation(() => { throw new Error('PRIVATE_READBACK_FAILURE') })
  const failed = await read({ cursors: {} })
  expect(JSON.parse(failed.find(batch => batch.source === 'CONTINUUM:DIAGNOSTIC')!.cursor!)).toEqual({ reasonCode: 'PROJECTION_ERROR', stage: 'ARTIFACT_READBACK' })
  expect(JSON.stringify(failed)).not.toContain('PRIVATE_READBACK_FAILURE')
  f.store().registry.applyAll(failed, () => {})
  expect(f.store().registry.source('CONTINUUM_CURRENT:' + receipt.artifactId)).toBeDefined()
  failure.mockRestore()
})
it('F2 leaves unauthorized PR work pending while converging local sources without network', async () => {
  const f = fixture(), continuum = continuumFixture('repo'), source = sources(f, false)
  cleanup.push(continuum.close)
  const receipt = continuum.service.publish(markdown('Pending', 'pullRequest: 101\n').replace('kind: DECISION', 'kind: IMPLEMENTATION_HANDOFF'))
  const read = registrySources({ repositoryId: 'repo', root: f.base, continuum: () => continuum.service, ledger: source.ledger,
    github: source.github as any, networkAllowed: () => false, assertCurrent: () => {} })
  const result = await reconcileRegistry(f.store(), absent, f.base, undefined, () => {}, read)
  expect(result).toMatchObject({ backlog: { pending: true, drainable: false, blockedSources: ['GITHUB'] } })
  expect(source.github.getPullRequest).not.toHaveBeenCalled()
  expect(f.store().registry.source('CONTINUUM_CURRENT:' + receipt.artifactId)).toBeDefined()
  expect(f.store().registry.contextGraph({ kind: 'PR', id: '101' }).edges.some(edge => edge.confidenceClass === 'VERIFIED_CAUSAL')).toBe(false)
  let allowed = true
  source.github.getPullRequest.mockImplementation(async () => { allowed = false; return { pullRequest: { head: { sha: 'd'.repeat(40) } } } })
  const revoked = registrySources({ repositoryId: 'repo', root: f.base, continuum: () => continuum.service, ledger: source.ledger,
    github: source.github as any, networkAllowed: () => allowed, assertCurrent: () => {} })
  const batches = await revoked({ selector: { kind: 'PR', id: '101' }, cursors: f.store().registry.cursors() })
  expect(source.github.pullRequestCommits).not.toHaveBeenCalled()
  expect(batches.find(batch => batch.source === 'GITHUB')?.status).toBe('NETWORK_NOT_AUTHORIZED')
})
it('F2 drains more than one quota of Artifacts, PRs, commits and proofs across edits and restart', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = fixture(), continuum = continuumFixture('repo'), source = sources(f, false)
  cleanup.push(continuum.close)
  const artifacts = Array.from({ length: 27 }, (_, index) => continuum.service.publish(markdown('Item' + index, 'pullRequest: ' + (100 + index % 4) + '\n').replace('kind: DECISION', 'kind: IMPLEMENTATION_HANDOFF')))
  const proofs = Array.from({ length: 23 }, (_, index) => source.ledger.recordProof({ kind: 'TARGETED_TEST', producer: 'IMPLEMENTER', status: 'PASSED',
    startedAt: '2026-11-03T22:00:00Z', finishedAt: '2026-11-03T22:00:01Z', durationMs: 1000, scope: ['fixture'], summary: 'fixture', evidenceFor: [artifacts[0].artifactId], deduplicationKey: String(index) }))
  const commits = Array.from({ length: 12 }, (_, index) => (index + 1).toString(16).padStart(40, '0'))
  let remoteChanged = false
  const github = { commitPullRequests: vi.fn(async () => []), getPullRequest: vi.fn(async (_root: string, number: number) => ({ pullRequest: { head: { sha: (remoteChanged && number === 100 ? 'e' : 'd').repeat(40) } } })),
    pullRequestCommits: vi.fn(async (_root: string, number: number) => ({ repositoryId: 'repo', commits: [...commits.slice((number - 100) * 3, (number - 99) * 3), ...(remoteChanged && number === 100 ? ['f'.repeat(40)] : [])].map(sha => ({ sha })), nextPage: null })) }
  const readSource = registrySources({ repositoryId: 'repo', root: f.base, continuum: () => continuum.service, ledger: source.ledger, github: github as any, networkAllowed: () => true, assertCurrent: () => {} })
  let rounds = 0
  const errors: string[] = []
  const coordinator = new SessionProjectionCoordinator(async () => {
    try {
    const result = await reconcileRegistry(f.store(), absent, f.base, undefined, () => {}, async request => {
      const batches = await readSource(request)
      if (rounds === 0) await Promise.all([0, 1].map(index => Promise.resolve(continuum.service.update(artifacts[index].artifactId, 1,
        markdown('Edited' + index, 'pullRequest: ' + (100 + index % 4) + '\n').replace('kind: DECISION', 'kind: IMPLEMENTATION_HANDOFF')))))
      return batches
    })
    if (++rounds === 1) f.restart()
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (error) { errors.push(error instanceof Error ? error.message : 'UNKNOWN'); throw error }
  }, () => true)
  const unsubscribe = continuum.service.onChanged(coordinator.request)
  try {
    coordinator.request(); await vi.runAllTimersAsync()
    expect(errors).toEqual([])
    expect(rounds).toBeGreaterThan(2); expect(rounds).toBeLessThan(15)
    for (const artifact of artifacts) expect(f.store().registry.source('CONTINUUM_CURRENT:' + artifact.artifactId)).toBeDefined()
    for (const artifact of artifacts.slice(0, 2)) expect(f.store().registry.source('CONTINUUM_CURRENT:' + artifact.artifactId)?.revision.startsWith('2:')).toBe(true)
    for (const sha of commits) expect(f.store().registry.source('GIT:' + sha)).toBeDefined()
    for (const number of [100, 101, 102, 103]) expect(f.store().registry.source('GITHUB:PR:' + number)?.status).toBe('COMPLETE')
    for (const proof of proofs) expect(f.store().registry.source('LEDGER:' + proof.proofId)).toBeDefined()
    expect(f.store().registry.reconciliationBacklog()).toMatchObject({ pending: false, drainable: false })
    const before = f.store().registry.contextGraph({ kind: 'ARTIFACT', id: artifacts[0].artifactId }).edges.map(edge => edge.id).sort()
    await reconcileRegistry(f.store(), absent, f.base, undefined, () => {}, readSource)
    expect(f.store().registry.contextGraph({ kind: 'ARTIFACT', id: artifacts[0].artifactId }).edges.map(edge => edge.id).sort()).toEqual(before)
    remoteChanged = true
    coordinator.request(); await vi.runAllTimersAsync()
    expect(f.store().registry.source('GITHUB:PR:100')?.revision).toBe('e'.repeat(40))
    expect(f.store().registry.source('GIT:' + 'f'.repeat(40))).toBeDefined()
  } finally { coordinator.stop(); unsubscribe(); vi.useRealTimers() }
}, 20000)
it('F2 serves depth one through the Channel and worker without target fanout and reports the blocked source phase', async () => {
  const f = fixture(), workerPath = join(f.base, 'worker.cjs')
  const code = buildSync({ entryPoints: ['src/main/session-context/worker.ts'], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
  writeFileSync(workerPath, `require = require('node:module').createRequire(${JSON.stringify(join(process.cwd(), 'package.json'))});\n` + code)
  const resolve: SessionTargetResolver = async () => { throw new Error('TARGET_MUST_NOT_RESOLVE') }
  resolve.discover = vi.fn(async () => { throw new Error('INVENTORY_MUST_NOT_RUN') })
  let entered!: () => void, release!: (batches: RegistryBatch[]) => void
  const waiting = new Promise<void>(ready => { entered = ready })
  const read = vi.fn(() => { entered(); return new Promise<RegistryBatch[]>(ready => { release = ready }) })
  f.store().registry.apply({ repositoryId: 'repo', source: 'FIXTURE', revision: '1', status: 'COMPLETE', edges: [{ from: { kind: 'COMMIT', id: commit }, to: { kind: 'PR', id: '90' },
    relation: 'member-of', evidenceKind: 'GITHUB_COMMIT_LIST', evidenceRef: 'fixture', digest: digest('fixture'), freshness: 'OBSERVED_SNAPSHOT' }] }, undefined)
  const client = new SessionContextClient(f.base, 'repo', f.base, () => true, workerPath, resolve, 5000, undefined, read)
  const adapter = new ChannelMcpAdapter({ projectId: 'repo', repoRoot: f.base, navigation: {} as any, sessionContext: client })
  try {
    const result = await adapter.callTool('discover_execution_context', { selector: { type: 'PR', id: '90' }, depth: 1 })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse((result.content[0] as { text: string }).text).discovery.depth).toBe(1)
    expect(resolve.discover).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled()
    const blocked = client.reconcileProjection()
    await waiting
    const timeout = await blocked
    expect(JSON.parse((timeout.content[0] as { text: string }).text)).toEqual({ code: 'SESSION_CONTEXT_TIMEOUT', phase: 'registry-source-read' })
    release([batch('late')])
    await new Promise<void>(ready => setImmediate(ready))
    expect(f.store().registry.source('CONTINUUM:handoff')).toBeUndefined()
    expect(resolve.discover).not.toHaveBeenCalled()
  } finally { await client.dispose() }
}, 20000)
it('requires matching native invocation, fresh Git receipt and exact object before causal promotion', async () => {
  const f = fixture(), registry = f.store().registry
  const binding: NativeHookBinding = { schema: 1, enabled: true, repositoryId: 'repo', worktreeId: '1'.repeat(64), generation: '2'.repeat(64), root: f.base, commonDirectory: f.base, directoryIdentity: '3'.repeat(64), spool: f.base }
  const invocationId = '4'.repeat(64), fingerprint = '5'.repeat(64), parent = '6'.repeat(40), sessionId = '7'.repeat(64)
  const stamp = startCaptureFixture(registry, binding, sessionId)
  const observe = (event: 'PreToolUse' | 'PostToolUse', replayed = false) => {
    const envelope: NativeHookEnvelope = { schema: 1, source: 'CODEX_NATIVE_HOOK', repositoryId: 'repo', worktreeId: binding.worktreeId, generation: binding.generation,
      sessionId, event, invocationId, observedAt: new Date().toISOString(), eventId: digest(event + replayed), digest: digest('payload' + event + replayed),
      git: { operationId: 'commit-proof', fingerprint, expectedHead: parent, ...(event === 'PostToolUse' ? { sha: commit, parent, replayed } : {}) } }
    const batch = nativeObservationBatch(stamp(envelope)); registry.apply(batch, undefined)
  }
  let receiptFingerprint = fingerprint
  const git = { readOperationReceipt: async () => ({ sha: '8'.repeat(40), receipt: { operationId: 'commit-proof', operation: 'commit_git_changes', argumentFingerprint: receiptFingerprint,
    status: 'COMPLETED' as const, createdAt: new Date().toISOString(), result: { content: [{ type: 'text' as const, text: JSON.stringify({ sha: commit, parent }) }] } } }),
    getCommitOperationObjects: async () => [{ sha: commit, parents: [parent], title: 'not persisted' }] }
  observe('PostToolUse')
  expect(await correlateNativeGit(registry, binding, invocationId, git, () => {})).toBe('INVOCATION_INCOMPLETE')
  observe('PreToolUse')
  expect(await correlateNativeGit(registry, binding, invocationId, git, () => {})).toBe('VERIFIED')
  const first = registry.map({ kind: 'COMMIT', id: commit }).edges.filter(edge => edge.evidenceKind === 'NATIVE_GIT_CAUSAL')
  expect(first).toHaveLength(2)
  f.restart()
  expect(await correlateNativeGit(f.store().registry, binding, invocationId, git, () => {})).toBe('VERIFIED')
  expect(f.store().registry.map({ kind: 'COMMIT', id: commit }).edges.filter(edge => edge.evidenceKind === 'NATIVE_GIT_CAUSAL')).toHaveLength(2)
  receiptFingerprint = '0'.repeat(64)
  expect(await correlateNativeGit(f.store().registry, binding, invocationId, git, () => {})).toBe('RECEIPT_UNVERIFIED')
  expect(f.store().registry.map({ kind: 'COMMIT', id: commit }).edges.filter(edge => edge.evidenceKind === 'NATIVE_GIT_CAUSAL').every(edge => edge.state === 'CONFLICT')).toBe(true)
  const otherBinding = { ...binding, worktreeId: '9'.repeat(64) }
  expect(await correlateNativeGit(f.store().registry, otherBinding, invocationId, git, () => {})).toBe('INVOCATION_AMBIGUOUS')
  receiptFingerprint = fingerprint
  recordNativeGap(binding.spool, 'SPOOL_FULL')
  expect(await correlateNativeGit(f.store().registry, binding, invocationId, git, () => {})).toBe('CAPTURE_PARTIAL')
  expect(f.store().registry.map({ kind: 'COMMIT', id: commit }).edges.filter(edge => edge.evidenceKind === 'NATIVE_GIT_CAUSAL').every(edge => edge.state !== 'VERIFIED')).toBe(true)
})
const runner: CommandRunner = async (_exe, args) => {
  const text = args.includes('log') ? 'Subject\nEntire-Checkpoint: ' + checkpoint : args.includes('rev-parse') ? 'a'.repeat(40) : args.some(a => a.endsWith(':metadata.json')) ? JSON.stringify({ checkpoint_id: checkpoint, cli_version: '0.12.2', sessions: [{}, {}] }) : args.some(a => a.endsWith(':0/metadata.json')) ? JSON.stringify({ checkpoint_id: checkpoint, agent: 'codex', session_id: 'session-one' }) : args.some(a => a.endsWith(':1/metadata.json')) ? JSON.stringify({ checkpoint_id: checkpoint, agent: 'antigravity', session_id: 'session-two' }) : ''
  return { text, code: 0, limited: false }
}
const absent: CommandRunner = async (_exe, args) => ({ text: args.includes('log') ? 'No checkpoint' : 'a'.repeat(40), code: 0, limited: false })
function batch(revision = '1'): RegistryBatch {
  return { repositoryId: 'repo', source: 'CONTINUUM:handoff', revision, status: 'COMPLETE', edges: [{ from: { kind: 'ARTIFACT', id: 'handoff' }, relation: 'implements', to: { kind: 'ARTIFACT', id: 'plan' }, evidenceKind: 'CONTINUUM_TYPED_RELATION', evidenceRef: 'handoff', digest: digest('artifact'), freshness: 'OBSERVED_SNAPSHOT' }] }
}
it('migrates v4 without changing event bytes, ids or cursors; rejects future schemas and foreign namespaces', () => {
  const f = fixture(true), s = f.store(), result = { sessionId: s.byProvider('legacy')!.id }
  const event = s.events(result.sessionId, {}, 0, 1)[0], before = s.event(result.sessionId, event.id), cursor = s.cursor({ old: true }, 1)
  const db = new Database(f.path)
  for (const table of ['checkpoint_registry', 'registry_sources', 'registry_edges', 'registry_entities']) db.exec('DROP TABLE ' + table)
  db.pragma('user_version=4'); db.close(); f.restart()
  expect(f.store().event(result.sessionId, event.id)).toEqual(before)
  expect(f.store().offset(cursor, { old: true })).toBe(1)
  expect(() => f.store().registry.apply({ ...batch(), repositoryId: 'foreign' }, undefined)).toThrow('REPOSITORY_MISMATCH')
  expect(() => new SessionStore(f.path, 'foreign')).toThrow('REPOSITORY_MISMATCH')
  const future = new Database(f.path); future.pragma('user_version=999'); future.close()
  expect(() => new SessionStore(f.path, 'repo')).toThrow('SCHEMA_UNSUPPORTED')
})
it('rolls back invalid batches and CAS changes; preserves superseded edges and detects tampering', () => {
  const f = fixture(), r = f.store().registry
  r.apply(batch(), undefined)
  expect(() => r.apply(batch('2'), undefined)).toThrow('REVISION_CONFLICT')
  expect(() => r.apply({ ...batch('2'), edges: [...batch().edges, { ...batch().edges[0], digest: 'bad' }] }, '1')).toThrow('INVALID_REGISTRY_EVIDENCE')
  expect(r.source(batch().source)?.revision).toBe('1')
  expect(() => r.applyAll([{ repositoryId: 'repo', source: 'LEDGER', revision: 'advanced', cursor: 'future', status: 'COMPLETE', edges: [] }, { ...batch('2'), repositoryId: 'foreign' }], () => {})).toThrow('REPOSITORY_MISMATCH')
  expect(r.source('LEDGER')).toBeUndefined()
  r.apply(batch('2'), '1'); f.restart()
  expect(f.store().registry.map({ kind: 'ARTIFACT', id: 'plan' }).edges.map((e: any) => e.state).sort()).toEqual(['OBSERVED', 'SUPERSEDED'])
  f.store().registry.apply({ ...batch('3'), status: 'CONFLICT', edges: [] }, '2')
  expect(f.store().registry.map({ kind: 'ARTIFACT', id: 'plan' }).edges.some(e => e.state === 'CONFLICT')).toBe(true)
  const db = new Database(f.path); db.prepare('UPDATE registry_edges SET payload=?').run('{}'); db.close()
  expect(() => f.store().registry.map({ kind: 'ARTIFACT', id: 'plan' })).toThrow('REGISTRY_INTEGRITY_FAILED')
})
it('discovers checkpoint original identity and two sessions without import or manual session links; replay/restart is idempotent', async () => {
  const f = fixture()
  await reconcileRegistry(f.store(), runner, '/fixture', { kind: 'COMMIT', id: commit }, () => {})
  f.restart()
  const map = await reconcileRegistry(f.store(), runner, '/fixture', { kind: 'COMMIT', id: commit }, () => {}) as any
  expect(map.edges).toHaveLength(3)
  expect(map.edges.filter((e: any) => e.to.kind === 'SESSION').map((e: any) => e.to.id).sort()).toEqual(['entire-agent:antigravity:session-two', 'entire:session-one'])
  expect(map.edges.some((e: any) => e.evidenceKind === 'CHECKPOINT_VERIFIED')).toBe(true)
  expect(f.store().count()).toBe(0)
  const pending = await reconcileRegistry(f.store(), runner, '/fixture', { kind: 'CHECKPOINT', id: checkpoint }, () => {}) as any
  expect(pending.edges.filter((e: any) => e.from.kind === 'CHECKPOINT')).toHaveLength(2)
  expect(pending.edges.filter((e: any) => e.from.kind === 'COMMIT')).toHaveLength(1)
})
it('missing checkpoint and unavailable GitHub preserve other relations, without claiming capture or authorship', async () => {
  const f = fixture()
  const map = await reconcileRegistry(f.store(), absent, '/fixture', { kind: 'COMMIT', id: 'b'.repeat(40) }, () => {}, async () => [{ repositoryId: 'repo', source: 'GITHUB', revision: 'offline', status: 'UNAVAILABLE', edges: [] }]) as any
  expect(map.reason).toBe('CHECKPOINT_NOT_OBSERVED')
  expect(map.edges).toEqual([])
  expect(map.authorship).toBe('NOT_INFERRED')
})
it('projects legacy declarations with their original evidence and preserves identity after eviction', () => {
  const f = fixture(), s = f.store()
  const row = s.ingest({ providerSessionId: 'legacy-session', providerVersion: 'fixture', agent: 'codex', state: 'ENDED', endedAt: '2026-01-01T00:00:00Z', coverage: 'COMPLETE', sourceDigest: digest('legacy'), sourceBytes: 0 }, [])
  s.recordAssociation({ repositoryId: 'repo', sessionId: row.sessionId, providerSessionId: 'legacy-session', provider: 'entire', worktreeId: 'a'.repeat(64), generation: 'b'.repeat(64), sourceArtifactId: 'handoff', artifactId: 'plan', evidence: 'HANDOFF_DECLARED', origin: 'CONTINUUM_HANDOFF' }, s.catalogRevision())
  s.registry.legacy(() => {})
  const db = new Database(f.path); db.prepare('DELETE FROM sessions WHERE id=?').run(row.sessionId); db.close(); f.restart()
  expect(f.store().registry.map({ kind: 'ARTIFACT', id: 'plan' }).edges.every(e => e.evidenceKind === 'HANDOFF_DECLARED')).toBe(true)
  expect(() => f.store().session(row.sessionId)).toThrow('SESSION_EVICTED')
})
function sources(f: ReturnType<typeof fixture>, allowed = true) {
  const ledger = new ValidationLedger(join(f.base, 'ledger.sqlite')); cleanup.push(() => ledger.close())
  const now = '2026-11-03T22:00:00.000Z'
  const artifacts: Record<string, any> = {
    handoff: { artifactId: 'handoff', revision: 1, contentHash: digest('handoff'), metadata: { kind: 'IMPLEMENTATION_HANDOFF', pullRequest: 90, relations: [{ artifactId: 'plan', kind: 'implements' }] }, updatedAt: now },
    plan: { artifactId: 'plan', revision: 1, contentHash: digest('plan'), metadata: { kind: 'EXECUTABLE_PLAN' }, updatedAt: now }
  }
  const continuum = { assertRepository: () => {}, get: (id: string) => artifacts[id] ?? null, provenanceSnapshot: (id: string, revision?: number) => artifacts[id] && (revision === undefined || artifacts[id].revision === revision) ? artifacts[id] : null, list: () => ({ artifacts: Object.values(artifacts) }) }
  const github = { commitPullRequests: vi.fn(async () => [90]), getPullRequest: vi.fn(async () => ({ pullRequest: { head: { sha: 'd'.repeat(40) } } })), pullRequestCommits: vi.fn(async () => ({ repositoryId: 'repo', commits: [{ sha: commit }], nextPage: null })) }
  const read = registrySources({ repositoryId: 'repo', root: '/fixture', continuum: () => continuum as any, ledger, github: github as any, networkAllowed: () => allowed, assertCurrent: () => {} })
  return { ledger, read, github, artifacts }
}
it('automatically composes PR → real member → checkpoint → two sessions and Handoff → Plan → UNVERIFIABLE proof without sessionLinks', async () => {
  const f = fixture(), source = sources(f)
  source.ledger.recordProof({ kind: 'TARGETED_TEST', producer: 'IMPLEMENTER', status: 'PASSED', startedAt: '2026-11-03T22:00:00Z', finishedAt: '2026-11-03T22:00:01Z', durationMs: 1000, scope: ['fixture'], summary: 'fixture', evidenceFor: ['plan'] })
  const map = await reconcileRegistry(f.store(), runner, '/fixture', { kind: 'PR', id: '90' }, () => {}, source.read) as any
  expect(map.edges.some((e: any) => e.to.kind === 'PROOF' && e.freshness === 'UNVERIFIABLE')).toBe(true)
  expect(map.edges.some((e: any) => e.from.id === 'handoff:1' && e.evidenceKind === 'HANDOFF_DECLARED')).toBe(true)
  expect(map.edges.filter((e: any) => e.to.kind === 'SESSION')).toHaveLength(2)
  expect(map.edges.some((e: any) => e.from.kind === 'COMMIT' && e.from.id === 'd'.repeat(40))).toBe(false)
  f.restart()
  const again = await reconcileRegistry(f.store(), runner, '/fixture', { kind: 'PR', id: '90' }, () => {}, source.read) as any
  expect(again.edges.length).toBe(map.edges.length)
  expect(f.store().count()).toBe(0)
  const byPlan = await reconcileRegistry(f.store(), runner, '/fixture', { kind: 'ARTIFACT', id: 'plan' }, () => {}, source.read) as any
  expect(byPlan.edges.filter((e: any) => e.to.kind === 'SESSION')).toHaveLength(2)
})
it('respects network policy, Ledger repository provenance and project changes; list tool exposes bounded paths', async () => {
  const f = fixture(), source = sources(f, false)
  const result = await executeSessionTool(f.store(), { refresh: async () => ({}) }, 'list_agent_sessions', { artifactId: 'plan' }, () => {}, undefined, [], absent, '/fixture', undefined, source.read)
  expect(result.isError).toBeFalsy()
  const data = JSON.parse((result.content[0] as any).text)
  expect(data.contextMap.authorship).toBe('NOT_INFERRED')
  expect(source.github.getPullRequest).not.toHaveBeenCalled()
  expect(JSON.stringify(data)).not.toContain('rawMarkdown')
  let current = true
  const reader = registrySources({ repositoryId: 'repo', root: '/fixture', continuum: () => null, ledger: source.ledger, github: source.github as any, networkAllowed: () => false, assertCurrent: () => { if (!current) throw new Error('PROJECT_CONTEXT_CHANGED') } })
  current = false
  await expect(reader({ cursors: {} })).rejects.toThrow('PROJECT_CONTEXT_CHANGED')
})

it('rolls back a malformed v4 migration without changing the schema version', () => {
  const f = fixture(), db = new Database(f.path)
  db.exec('DROP TABLE registry_edges; DROP TABLE registry_sources; CREATE TABLE registry_edges(id TEXT PRIMARY KEY)')
  db.pragma('user_version=4')
  expect(() => new SessionStore(f.path, 'repo')).toThrow()
  expect(db.pragma('user_version', { simple: true })).toBe(4)
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='registry_sources'").get()).toBeUndefined()
  db.close()
})
it('reuses verified immutable checkpoint metadata after restart and preserves local facts before an unavailable remote reader', async () => {
  const f = fixture(), run = vi.fn(runner)
  await reconcileRegistry(f.store(), run, '/fixture', { kind: 'COMMIT', id: commit }, () => {})
  f.restart(); run.mockClear()
  await reconcileRegistry(f.store(), run, '/fixture', { kind: 'COMMIT', id: commit }, () => {})
  expect(run.mock.calls.some(call => call[1].includes('cat-file'))).toBe(false)
  await expect(reconcileRegistry(f.store(), run, '/fixture', { kind: 'COMMIT', id: commit }, () => {}, async () => { throw new Error('OFFLINE') })).rejects.toThrow('OFFLINE')
  expect(f.store().registry.map({ kind: 'COMMIT', id: commit }).edges).toHaveLength(3)
})
it('reads canonical sources through the existing worker boundary and returns a compact map', async () => {
  const f = fixture(), workerPath = join(f.base, 'worker.cjs'), root = process.cwd()
  const code = buildSync({ entryPoints: ['src/main/session-context/worker.ts'], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
  writeFileSync(workerPath, `require = require('node:module').createRequire(${JSON.stringify(join(root, 'package.json'))});\n` + code)
  const read = vi.fn(async () => [batch()])
  const client = new SessionContextClient(f.base, 'repo', root, () => true, workerPath, undefined, undefined, undefined, read)
  try {
    const result = await client.call('list_agent_sessions', { artifactId: 'plan' })
    expect(result.isError).toBeFalsy()
    expect(read).toHaveBeenCalledOnce()
    expect(JSON.parse((result.content[0] as any).text).contextMap.edges[0].relation).toBe('implements')
  } finally { await client.dispose() }
}, 20000)
it.skipIf(process.env.CHECKPOINT_REGISTRY_REAL !== '1')('accepts the authorized existing real checkpoint through read-only Git metadata without transcript import', async () => {
  const f = fixture()
  const map = await reconcileRegistry(f.store(), runReadOnly, process.cwd(), { kind: 'COMMIT', id: commit }, () => {}) as any
  expect(map.edges.filter((e: any) => e.to.kind === 'SESSION')).toHaveLength(2)
  expect(map.edges.some((e: any) => e.to.kind === 'CHECKPOINT' && e.to.id === checkpoint)).toBe(true)
  expect(f.store().count()).toBe(0)
}, 20000)
it('advances durable Ledger cursors and excludes a foreign checkout even when it names a local Artifact', async () => {
  const f = fixture(), source = sources(f, false)
  const input = { kind: 'TARGETED_TEST' as const, producer: 'IMPLEMENTER' as const, status: 'PASSED' as const, startedAt: '2026-11-03T22:00:00Z', finishedAt: '2026-11-03T22:00:01Z', durationMs: 1000, scope: ['fixture'], summary: 'fixture', evidenceFor: ['plan'] }
  const foreign = source.ledger.recordProof({ ...input, commandProfile: { command: 'fixture', checkout: { repositoryId: 'foreign', worktreeId: 'a'.repeat(64), generation: 'b'.repeat(64), head: commit, issuer: 'VALIDATION_EXECUTION', runId: 'fixture' } } })
  for (let index = 0; index < 21; index++) source.ledger.recordProof({ ...input, deduplicationKey: String(index) })
  const first = await source.ledger.projectionPage()
  expect(first.proofs).toHaveLength(20)
  expect(first.more).toBe(true)
  const second = await source.ledger.projectionPage(first.cursor)
  expect(second.proofs).toHaveLength(2)
  expect(second.more).toBe(false)
  const batches = await source.read({ cursors: {} })
  expect(batches.some(b => b.source === 'LEDGER:' + foreign.proofId)).toBe(false)
  expect(batches.find(b => b.source === 'LEDGER')?.status).toBe('PARTIAL')
})
it('bounds ref inventory, accepts a checkpoint without a commit and separates observed worktree generations', async () => {
  const f = fixture(), run: CommandRunner = async (exe, args, ...rest) => args.includes('for-each-ref') ? { code: 0, limited: false, text: `refs/entire/checkpoints/SQ/${checkpoint}\n` } : args.includes('log') ? { code: 0, limited: false, text: 'No trailer' } : runner(exe, args, ...rest)
  await reconcileRegistry(f.store(), run, '/fixture', undefined, () => {})
  const map = f.store().registry.map({ kind: 'CHECKPOINT', id: checkpoint })
  expect(map.edges).toHaveLength(2)
  expect(map.edges.some(e => e.from.kind === 'COMMIT')).toBe(false)
  expect(f.store().registry.source('GIT:' + checkpoint)?.status).toBe('PENDING_COMMIT_ASSOCIATION')
  const capture = (generation: string) => ({ worktreeId: 'a'.repeat(64), generation, sourceFingerprint: 'source', policyDigest: 'policy', configurationDigest: 'config', capture: { state: 'OBSERVED', providerSessionId: 'original-session' }, checkpoint: {}, head: '' }) as any
  await reconcileRegistry(f.store(), run, '/fixture', undefined, () => {}, undefined, capture('b'.repeat(64)))
  await reconcileRegistry(f.store(), run, '/fixture', undefined, () => {}, undefined, capture('c'.repeat(64)))
  expect(f.store().registry.map({ kind: 'SESSION', id: 'entire:original-session' }).edges.filter(e => e.from.kind === 'WORKTREE')).toHaveLength(2)
})
it('uses the existing GitHub client for bounded candidate discovery, then requires the PR commit list', async () => {
  const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify([{ number: 90 }]), { status: 200 }))
  const api = new GitHubApiClient(async () => 'fixture-token', fetcher)
  expect(await api.getCommitPullRequests('owner/repo', commit)).toEqual([90])
  expect(String(fetcher.mock.calls[0]?.[0])).toContain('/repos/owner/repo/commits/' + commit + '/pulls?per_page=5')
  await expect(api.getCommitPullRequests('owner/repo', '../foreign')).rejects.toThrow()
})
it('requests automatic reconciliation for a Handoff without sessionLinks without blocking publication or issuing manual associations', async () => {
  const call = vi.fn(() => new Promise<any>(() => {}))
  const result = await handoffSessionCoverage({ call }, { artifactId: 'handoff', metadata: { kind: 'IMPLEMENTATION_HANDOFF' } } as any, { worktreeId: 'a'.repeat(64), generation: 'b'.repeat(64) })
  expect(result).toMatchObject({ code: 'RECONCILIATION_REQUESTED', coverage: 'PENDING', transcriptImported: false })
  expect(call).toHaveBeenCalledExactlyOnceWith('reconcile_checkpoint_registry', { artifactId: 'handoff' })
})
it('rejects PR composition if the authorized GitHub origin changes during the read', async () => {
  let remote = 'https://github.com/owner/repo.git'
  const api = { getPullRequestCatalogRecord: async () => ({ head: { sha: commit }, base: { repository: 'owner/repo' }, updatedAt: 'stable' }), getPullRequestCommits: async () => { remote = 'https://github.com/other/repo.git'; return { commits: [{ sha: commit }], nextPage: null } } }
  const service = new GitHubIntegrationService({ clientId: 'fixture', appSlug: 'fixture' }, {} as any, { hasCredentials: () => true } as any, api as any, { findByPath: () => ({ id: 'repo' }) } as any, { getRemoteUrl: async () => remote } as any, {} as any)
  await expect(service.pullRequestCommits('/fixture', 90, commit)).rejects.toThrow('REMOTE_CONTEXT_CHANGED')
})
