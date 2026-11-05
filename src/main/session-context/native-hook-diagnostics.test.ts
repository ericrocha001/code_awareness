import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { receiptDigest } from '../../shared/validation/test-output-receipt.cjs'
import { SessionStore, sessionStorePath } from './store'
import { ingestNativeHooks } from './native-hook-ingestion'
import { nativeDigest, nativeGitIdentity, normalizeNativeHook, prepareNativeSpool, readNativeBinding, recordNativeGap, spoolNativeHook, type NativeHookBinding } from './native-hooks'
import { acknowledgeCheckoutGaps, acknowledgeNativeGaps, nativeCaptureDiagnostics, nativeDiagnosticSource, readNativeGapHistory } from './native-hook-diagnostics'
import { correlateNativeGit } from './native-git-correlation'
import { GitService } from '../core/git-service'
import type { RegistryEdge } from './checkpoint-registry'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'native-diagnostics-')), root = join(base, 'repo')
  mkdirSync(root); mkdirSync(join(root, '.git'))
  cleanup.push(() => rmSync(base, { recursive: true, force: true, maxRetries: 5 }))
  const spool = join(root, '.code-awareness/native-hooks/spool'); prepareNativeSpool(spool)
  const binding: NativeHookBinding = { schema: 1, enabled: true, repositoryId: 'repository', worktreeId: '1'.repeat(64), generation: '2'.repeat(64), ...nativeGitIdentity(root), spool }
  writeFileSync(join(root, '.code-awareness/native-hooks/binding.json'), JSON.stringify(binding))
  const path = sessionStorePath(base, binding.repositoryId)
  let store = new SessionStore(path, binding.repositoryId)
  cleanup.push(() => store.close())
  const payload = { hook_event_name: 'PreToolUse', session_id: 'private-session', tool_use_id: 'one', cwd: root }
  const ingest = () => ingestNativeHooks(store.registry, binding, async () => ({ root, fingerprint: '', validate: async () => {} }), () => {})
  return { base, root, spool, binding, payload, ingest, store: () => store, restart: () => { store.close(); store = new SessionStore(path, binding.repositoryId) } }
}

function proof(reason: string, startedAt = new Date(Date.now() + 1000).toISOString()) {
  const value = { version: 1, state: 'PASS', exitCode: 0, startedAt, finishedAt: startedAt,
    command: ['vitest', 'run', 'src/main/session-context/native-hook-diagnostics.test.ts', '--testNamePattern', `^native-gap-recovery:${reason}$`],
    validation: { state: 'SUFFICIENT', runs: [{ passed: 1, failed: 0 }] } }
  return JSON.stringify({ ...value, digest: receiptDigest(value) })
}

test('native-gap-recovery:INVOCATION_ID_MISSING', async () => {
  const f = fixture()
  expect(() => normalizeNativeHook({ ...f.payload, tool_use_id: null }, f.binding)).toThrow('INVOCATION_ID_MISSING')
  recordNativeGap(f.spool, 'INVOCATION_ID_MISSING', 'NORMALIZE', 'PreToolUse')
  writeFileSync(join(f.spool, 'gap.json'), JSON.stringify({ schema: 1, state: 'PARTIAL', reason: 'INVALID_PAYLOAD', observedAt: '2026-11-05T14:26:50.402Z' }))
  await f.ingest()
  expect(nativeCaptureDiagnostics(f.store().registry, f.root)).toMatchObject({ currentOperationalCapture: { state: 'DEGRADED' }, historicalCoverage: { state: 'PARTIAL', count: 2 } })
  spoolNativeHook(normalizeNativeHook(f.payload, f.binding), f.spool)
  expect(await f.ingest()).toMatchObject({ state: 'PARTIAL', ingested: 1 })
  const current = nativeCaptureDiagnostics(f.store().registry, f.root)
  expect(current).toMatchObject({ currentOperationalCapture: { state: 'OBSERVED' }, historicalCoverage: { state: 'PARTIAL', count: 2, resolution: 'UNACKNOWLEDGED', recoveredEvents: false,
    diagnostics: expect.arrayContaining([{ schema: 2, reasonCode: 'LEGACY_UNTYPED', phase: 'UNKNOWN', eventType: 'UNKNOWN', observedAt: '2026-11-05T14:26:50.402Z', revision: expect.any(String), acknowledged: false }]) } })
  f.restart(); await f.ingest()
  expect(nativeCaptureDiagnostics(f.store().registry, f.root)).toEqual(current)
  const history = readNativeGapHistory(f.spool)
  const ack = acknowledgeNativeGaps(f.spool, history.revision, 'INVOCATION_ID_MISSING', proof('INVOCATION_ID_MISSING'), true)
  expect(ack.acknowledged).toBe(1)
  expect(acknowledgeNativeGaps(f.spool, history.revision, 'INVOCATION_ID_MISSING', proof('INVOCATION_ID_MISSING'), true)).toEqual(ack)
  await f.ingest(); f.restart(); await f.ingest()
  expect(nativeCaptureDiagnostics(f.store().registry, f.root)).toMatchObject({ currentOperationalCapture: { state: 'OBSERVED' }, historicalCoverage: { state: 'PARTIAL', acknowledgedCount: 1, count: 2 } })
  const publicText = JSON.stringify(nativeCaptureDiagnostics(f.store().registry, f.root))
  expect(publicText).not.toContain('private-session'); expect(publicText).not.toContain(f.root); expect(publicText.length).toBeLessThan(3000)
})

test('requires authorization, exact gap revision and fresh discriminative proof; preserves the original loss', async () => {
  const f = fixture()
  recordNativeGap(f.spool, 'INVOCATION_ID_MISSING', 'NORMALIZE', 'PreToolUse')
  const history = readNativeGapHistory(f.spool), original = readFileSync(join(f.spool, 'gap-0.json'), 'utf8')
  const accept = (revision: string, text: string, authorized = true) => acknowledgeNativeGaps(f.spool, revision, 'INVOCATION_ID_MISSING', text, authorized)
  expect(() => accept(history.revision, proof('INVOCATION_ID_MISSING'), false)).toThrow('HOOK_AUTHORIZATION_REQUIRED')
  expect(() => accept('0'.repeat(64), proof('INVOCATION_ID_MISSING'))).toThrow('REVISION_CONFLICT')
  expect(() => accept(history.revision, proof('INVOCATION_ID_MISSING', new Date(0).toISOString()))).toThrow('RECOVERY_PROOF_REQUIRED')
  expect(() => accept(history.revision, proof('JSON_SYNTAX'))).toThrow('RECOVERY_PROOF_REQUIRED')
  expect(() => accept(history.revision, 'PRIVATE_PROOF_JSON')).toThrow('RECOVERY_PROOF_REQUIRED')
  expect(() => accept(history.revision, proof('INVOCATION_ID_MISSING').replace('SUFFICIENT', 'INSUFFICIENT'))).toThrow('RECOVERY_PROOF_REQUIRED')
  accept(history.revision, proof('INVOCATION_ID_MISSING'))
  expect(readFileSync(join(f.spool, 'gap-0.json'), 'utf8')).toBe(original)
  await f.ingest()
  expect(nativeCaptureDiagnostics(f.store().registry, f.root)).toMatchObject({ historicalCoverage: { state: 'PARTIAL', resolution: 'ACKNOWLEDGED', recoveredEvents: false } })
  recordNativeGap(f.spool, 'IO_FAILURE', 'WRITE', 'Stop'); await f.ingest()
  expect(nativeCaptureDiagnostics(f.store().registry, f.root)).toMatchObject({ currentOperationalCapture: { state: 'DEGRADED' }, historicalCoverage: { count: 2, acknowledgedCount: 1, resolution: 'UNACKNOWLEDGED' } })
})

test('acknowledgement is bound to the authorized checkout identity', () => {
  const f = fixture()
  recordNativeGap(f.spool, 'INVOCATION_ID_MISSING', 'NORMALIZE', 'PreToolUse')
  const history = readNativeGapHistory(f.spool), proofPath = join(f.base, 'proof.json')
  writeFileSync(proofPath, proof('INVOCATION_ID_MISSING'))
  const target = { repositoryId: f.binding.repositoryId, worktreeId: f.binding.worktreeId, generation: f.binding.generation }
  expect(() => acknowledgeCheckoutGaps(f.root, { ...target, generation: '3'.repeat(64) }, history.revision, 'INVOCATION_ID_MISSING', proofPath, true)).toThrow('WORKTREE_STALE')
  expect(() => acknowledgeCheckoutGaps(f.root, target, history.revision, 'INVOCATION_ID_MISSING', proofPath, false)).toThrow('HOOK_AUTHORIZATION_REQUIRED')
  expect(acknowledgeCheckoutGaps(f.root, target, history.revision, 'INVOCATION_ID_MISSING', proofPath, true).acknowledged).toBe(1)
})

test('bounds diagnostics, reports overflow honestly and refuses stale checkout identity', async () => {
  const f = fixture()
  for (let i = 0; i < 50; i++) recordNativeGap(f.spool, 'IO_FAILURE', 'WRITE')
  await f.ingest()
  const value = nativeCaptureDiagnostics(f.store().registry, f.root)
  expect(value).toMatchObject({ historicalCoverage: { count: 33, countCoverage: 'LOWER_BOUND', omittedDiagnostics: 25 } })
  expect(JSON.stringify(value).length).toBeLessThan(4096)
  const binding = { ...f.binding, directoryIdentity: '0'.repeat(64) }
  writeFileSync(join(f.root, '.code-awareness/native-hooks/binding.json'), JSON.stringify(binding))
  expect(nativeCaptureDiagnostics(f.store().registry, f.root)).toMatchObject({ currentOperationalCapture: { state: 'UNAVAILABLE', reasonCode: 'WORKTREE_STALE' } })
})

test('classifies corrupted envelopes during ingestion without creating a native session', async () => {
  const f = fixture(), envelope = normalizeNativeHook(f.payload, f.binding)
  writeFileSync(join(f.spool, '1.json'), JSON.stringify({ ...envelope, digest: nativeDigest('forged') }))
  expect(await f.ingest()).toMatchObject({ rejected: 1, state: 'PARTIAL' })
  expect(f.store().registry.nativeSessions(0, 10)).toHaveLength(0)
  expect(readNativeGapHistory(f.spool).entries).toEqual([expect.objectContaining({ reasonCode: 'ENVELOPE_INTEGRITY', phase: 'INGEST', eventType: 'UNKNOWN' })])
  expect(f.store().registry.source(nativeDiagnosticSource(f.binding))?.status).toBe('DEGRADED')
})

test.skipIf(!process.env.NATIVE_GIT_BASELINE_ROOT)('preserves the real 481bf891 causal receipt and refuses its incomplete control without writing to the source', async () => {
  const root = process.env.NATIVE_GIT_BASELINE_ROOT!
  const binding = readNativeBinding(join(root, '.code-awareness/native-hooks/binding.json'))
  const sourcePath = sessionStorePath(join(process.env.APPDATA!, 'code-awareness/continuum'), binding.repositoryId)
  const source = new Database(sourcePath, { readonly: true })
  cleanup.push(() => source.close())
  const invocation = '0a04e3cba0918de5d632987f8762ba65e599756e802b7199c43f94c3a1195f3e'
  const incomplete = '46ccb5a42a18be7c283acf7bb04d24dfc56193d07c2e41da4f90472c2ede7171'
  const commit = '481bf891a723877ec34ae2856fb6673d1984de98'
  const base = mkdtempSync(join(tmpdir(), 'native-real-receipt-'))
  cleanup.push(() => rmSync(base, { recursive: true, force: true, maxRetries: 5 }))
  let store = new SessionStore(sessionStorePath(base, binding.repositoryId), binding.repositoryId)
  cleanup.push(() => store.close())
  const rows = source.prepare("SELECT source,payload,integrity FROM registry_edges WHERE source=? OR json_extract(payload,'$.from.id') IN (?,?) ORDER BY id")
    .all(`NATIVE_GIT:${invocation}`, `native-invocation:${invocation}`, `native-invocation:${incomplete}`) as { source: string; payload: string; integrity: string }[]
  expect(rows.length).toBeGreaterThan(2)
  for (const name of new Set(rows.map(row => row.source))) {
    const metadata = source.prepare('SELECT revision,status,cursor FROM registry_sources WHERE source=?').get(name) as { revision: string; status: string; cursor?: string }
    const edges = rows.filter(row => row.source === name).map(row => { expect(nativeDigest(row.payload)).toBe(row.integrity); return JSON.parse(row.payload) as RegistryEdge })
    store.registry.apply({ repositoryId: binding.repositoryId, source: name, ...metadata, edges }, undefined)
  }
  const git = new GitService()
  expect(await correlateNativeGit(store.registry, binding, invocation, git, () => {})).toBe('VERIFIED')
  expect(await correlateNativeGit(store.registry, binding, incomplete, git, () => {})).toBe('INVOCATION_INCOMPLETE')
  const causal = () => store.registry.contextGraph({ kind: 'COMMIT', id: commit }).edges.filter(edge => edge.evidenceKind === 'NATIVE_GIT_CAUSAL')
  expect(causal().map(edge => [edge.relation, edge.state]).sort()).toEqual([['committed', 'VERIFIED'], ['invoked', 'VERIFIED']])
  const before = causal()
  store.close(); store = new SessionStore(sessionStorePath(base, binding.repositoryId), binding.repositoryId)
  expect(causal()).toEqual(before)
  expect(await correlateNativeGit(store.registry, binding, invocation, git, () => {})).toBe('VERIFIED')
}, 30000)
