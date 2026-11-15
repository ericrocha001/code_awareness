import { existsSync, lstatSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { CheckpointRegistry } from './checkpoint-registry'
import { receiptDigest } from '../../shared/validation/test-output-receipt.cjs'
import { boundedFile, nativeDigest, nativeGapReasons, nativeGitIdentity, nativeHookEvents, nativeHookProviders, readNativeBinding, type NativeGap, type NativeGapReason, type NativeHookBinding, type NativeHookProvider } from './native-hooks'

interface GapObservation extends Omit<NativeGap, 'phase' | 'observedAt'> { phase: NativeGap['phase'] | 'UNKNOWN'; observedAt: string | null; revision: string }
interface GapAck { revision: string; proofDigest: string; qualifiedReason: NativeGapReason; verifiedAt: string }
interface GapHistory { revision: string; entries: GapObservation[]; acknowledgements: GapAck[]; overflow: boolean }
const phases = ['READ', 'PARSE', 'NORMALIZE', 'WRITE', 'INGEST']
const hash = /^[a-f0-9]{64}$/
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))

export function readNativeGapHistory(spool: string): GapHistory {
  const entries: GapObservation[] = []
  const files = ['gap.json', ...Array.from({ length: 32 }, (_, slot) => `gap-${slot}.json`), 'gap-overflow.json']
  for (const name of files) {
    const path = join(spool, name)
    try {
      const stat = lstatSync(path)
      const value = JSON.parse(boundedFile(path, 512))
      let entry: Omit<GapObservation, 'revision'>
      if (name === 'gap.json' && value.schema === 1 && timestamp(value.observedAt)) {
        entry = { schema: 2, reasonCode: 'LEGACY_UNTYPED', phase: 'UNKNOWN', eventType: 'UNKNOWN', observedAt: value.observedAt }
      } else {
        if (!value || value.schema !== 2 || !nativeGapReasons.includes(value.reasonCode) || !phases.includes(value.phase) ||
          !(value.eventType === 'UNKNOWN' || nativeHookEvents.includes(value.eventType)) || !timestamp(value.observedAt) ||
          Object.keys(value).some(key => !['schema', 'reasonCode', 'phase', 'eventType', 'observedAt'].includes(key))) throw new Error('DIAGNOSTIC_INVALID')
        entry = { schema: 2, reasonCode: value.reasonCode, phase: value.phase, eventType: value.eventType,
          observedAt: name === 'gap-overflow.json' ? new Date(stat.mtimeMs).toISOString() : value.observedAt }
      }
      entries.push({ ...entry, revision: nativeDigest(JSON.stringify([name, entry])) })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      entries.push({ schema: 2, reasonCode: error instanceof SyntaxError || (error as Error).message === 'DIAGNOSTIC_INVALID' ? 'DIAGNOSTIC_INVALID' : 'IO_FAILURE',
        phase: 'INGEST', eventType: 'UNKNOWN', observedAt: null, revision: nativeDigest(name + ':UNREADABLE') })
    }
  }
  entries.sort((a, b) => (a.observedAt ?? '').localeCompare(b.observedAt ?? '') || a.revision.localeCompare(b.revision))
  const revision = nativeDigest(JSON.stringify(entries))
  let acknowledgements: GapAck[] = []
  try {
    const value = JSON.parse(boundedFile(join(spool, 'gap-ack.json'), 16384))
    if (value.version !== 1 || !Array.isArray(value.acknowledgements) || value.acknowledgements.length > 34) throw new Error('ACK_INVALID')
    acknowledgements = [...new Map<string, GapAck>(value.acknowledgements.filter((ack: GapAck) => ack && hash.test(ack.revision) && hash.test(ack.proofDigest) &&
      nativeGapReasons.includes(ack.qualifiedReason) && timestamp(ack.verifiedAt) && entries.some(entry => entry.revision === ack.revision && entry.reasonCode === ack.qualifiedReason))
      .map((ack: GapAck) => [ack.revision, { revision: ack.revision, proofDigest: ack.proofDigest, qualifiedReason: ack.qualifiedReason, verifiedAt: ack.verifiedAt }])).values()]
  } catch {}
  return { revision, entries, acknowledgements, overflow: existsSync(join(spool, 'gap-overflow.json')) }
}

export function acknowledgeNativeGaps(spool: string, expectedRevision: string, qualifiedReason: NativeGapReason, proofReceipt: string, authorized: boolean): { revision: string; acknowledged: number; proofDigest: string } {
  if (!authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED')
  if (lstatSync(spool).isSymbolicLink() || realpathSync(spool) !== resolve(spool)) throw new Error('UNSAFE_SPOOL')
  const history = readNativeGapHistory(spool)
  if (history.revision !== expectedRevision) throw new Error('REVISION_CONFLICT')
  const matched = history.entries.filter(entry => entry.reasonCode === qualifiedReason)
  const existing = matched.map(entry => history.acknowledgements.find(ack => ack.revision === entry.revision))
  if (matched.length && existing.every(ack => ack !== undefined)) return { revision: expectedRevision, acknowledged: history.acknowledgements.length, proofDigest: existing[0]!.proofDigest }
  let receipt
  try { receipt = JSON.parse(proofReceipt) } catch { throw new Error('RECOVERY_PROOF_REQUIRED') }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('RECOVERY_PROOF_REQUIRED')
  const marker = `native-gap-recovery:${qualifiedReason}`
  const selected = receipt.command?.indexOf('--testNamePattern')
  if (!matched.length || matched.some(entry => entry.observedAt === null) || ['LEGACY_UNTYPED', 'DIAGNOSTIC_LIMIT'].includes(qualifiedReason) || receipt.state !== 'PASS' || receipt.exitCode !== 0 ||
    receipt.validation?.state !== 'SUFFICIENT' || !Array.isArray(receipt.command) || !receipt.command.includes('src/main/session-context/native-hook-diagnostics.test.ts') ||
    !timestamp(receipt.startedAt) || !timestamp(receipt.finishedAt) || Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt) || Date.parse(receipt.finishedAt) > Date.now() + 60000 ||
    Date.parse(receipt.startedAt) <= Math.max(...matched.map(entry => Date.parse(entry.observedAt!))) ||
    selected < 0 || receipt.command[selected + 1] !== `^${marker}$` || !Array.isArray(receipt.validation.runs) ||
    receipt.validation.runs.length !== 1 || receipt.validation.runs[0].passed !== 1 || receipt.validation.runs[0].failed !== 0 ||
    receipt.digest !== receiptDigest(receipt)) throw new Error('RECOVERY_PROOF_REQUIRED')
  const proofDigest = nativeDigest(proofReceipt)
  const acknowledgements = history.entries.flatMap(entry => {
    const existing = history.acknowledgements.find(ack => ack.revision === entry.revision)
    if (existing) return [existing]
    return entry.reasonCode === qualifiedReason ? [{ revision: entry.revision, qualifiedReason, proofDigest, verifiedAt: receipt.finishedAt }] : []
  })
  const path = join(spool, 'gap-ack.json'), pending = path + '.pending'
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('UNSAFE_FILE')
  writeFileSync(pending, JSON.stringify({ version: 1, acknowledgements }), { flag: 'wx', mode: 0o600 })
  try {
    if (readNativeGapHistory(spool).revision !== expectedRevision) throw new Error('REVISION_CONFLICT')
    renameSync(pending, path)
  } finally { if (existsSync(pending)) unlinkSync(pending) }
  return { revision: expectedRevision, acknowledged: acknowledgements.length, proofDigest }
}

export function nativeDiagnosticSource(binding: Pick<NativeHookBinding, 'provider' | 'worktreeId' | 'generation'>): string {
  return binding.provider === 'antigravity' ? `NATIVE_CAPTURE:antigravity:${binding.worktreeId}:${binding.generation}` : `NATIVE_CAPTURE:${binding.worktreeId}:${binding.generation}`
}

const nativeBindingPath = (root: string, provider: NativeHookProvider = 'codex') =>
  join(root, provider === 'antigravity' ? '.code-awareness/native-hooks/antigravity/binding.json' : '.code-awareness/native-hooks/binding.json')

export function acknowledgeCheckoutGaps(root: string, target: { repositoryId: string; worktreeId: string; generation: string }, revision: string, reason: NativeGapReason, proof: string, authorized: boolean, provider: NativeHookProvider = 'codex') {
  if (!authorized) throw new Error('HOOK_AUTHORIZATION_REQUIRED')
  const binding = readNativeBinding(nativeBindingPath(root, provider)), identity = nativeGitIdentity(root)
  if ((binding.provider ?? 'codex') !== provider || binding.repositoryId !== target.repositoryId || binding.worktreeId !== target.worktreeId || binding.generation !== target.generation ||
    identity.root !== binding.root || identity.directoryIdentity !== binding.directoryIdentity || identity.commonDirectory !== binding.commonDirectory) throw new Error('WORKTREE_STALE')
  return acknowledgeNativeGaps(binding.spool, revision, reason, boundedFile(proof, 65536), authorized)
}

export function persistNativeCapture(registry: CheckpointRegistry, binding: NativeHookBinding,
  receipt: { ingested: number; rejected: number; expired: number; pending: boolean; deduplicated?: number }, assertCurrent: () => void) {
  const history = readNativeGapHistory(binding.spool), source = nativeDiagnosticSource(binding), previous = registry.source(source)
  let prior: { gapRevision?: string; currentOperationalCapture?: { state: string; observedAt?: string }; pipeline?: { ingress: number; accepted: number; rejected: number; expired: number; deduplicated: number } } = {}
  try { prior = JSON.parse(previous?.cursor ?? '{}') } catch {}
  const currentOperationalCapture = receipt.rejected || receipt.expired || receipt.pending ? { state: 'DEGRADED' } : receipt.ingested ? { state: 'OBSERVED', observedAt: new Date().toISOString() } :
    prior.gapRevision === history.revision && prior.currentOperationalCapture ? prior.currentOperationalCapture : { state: history.entries.length ? 'DEGRADED' : 'UNOBSERVED' }
  const historicalCoverage = { state: history.entries.length ? 'PARTIAL' : 'NO_GAPS_OBSERVED', revision: history.revision,
    count: history.entries.length, countCoverage: history.overflow ? 'LOWER_BOUND' : 'RETAINED_RECEIPTS', acknowledgedCount: history.acknowledgements.length,
    resolution: history.entries.length && history.acknowledgements.length === history.entries.length ? 'ACKNOWLEDGED' : history.entries.length ? 'UNACKNOWLEDGED' : 'NOT_APPLICABLE',
    recoveredEvents: false, diagnostics: history.entries.slice(-8).map(entry => ({ ...entry, acknowledged: history.acknowledgements.some(ack => ack.revision === entry.revision) })),
    omittedDiagnostics: Math.max(0, history.entries.length - 8) }
  const previousCounts = prior.pipeline ?? { ingress: 0, accepted: 0, rejected: 0, expired: 0, deduplicated: 0 }
  const pipeline = { ingress: previousCounts.ingress + receipt.ingested + receipt.rejected + receipt.expired,
    accepted: previousCounts.accepted + receipt.ingested - (receipt.deduplicated ?? 0), rejected: previousCounts.rejected + receipt.rejected,
    expired: previousCounts.expired + receipt.expired, deduplicated: previousCounts.deduplicated + (receipt.deduplicated ?? 0), pending: receipt.pending }
  const cursor = JSON.stringify({ version: 1, gapRevision: history.revision, currentOperationalCapture, historicalCoverage, pipeline })
  if (previous?.cursor !== cursor) registry.apply({ repositoryId: registry.repositoryId, source, revision: nativeDigest(cursor), status: currentOperationalCapture.state, cursor, edges: [] }, previous?.revision, assertCurrent)
  return { currentOperationalCapture, historicalCoverage }
}

export function nativeCaptureDiagnostics(registry: CheckpointRegistry, root?: string, provider?: NativeHookProvider): object {
  try {
    if (!root) return {}
    const order: readonly NativeHookProvider[] = provider ? [provider] : nativeHookProviders
    let binding: NativeHookBinding | undefined
    for (const candidate of order) {
      try { binding = readNativeBinding(nativeBindingPath(root, candidate)); break }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || provider) throw error }
    }
    if (!binding || binding.repositoryId !== registry.repositoryId) return {}
    if (!binding.enabled) return { currentOperationalCapture: { state: 'DISABLED' } }
    const identity = nativeGitIdentity(root)
    if (identity.directoryIdentity !== binding.directoryIdentity || identity.root !== binding.root || identity.commonDirectory !== binding.commonDirectory) return { currentOperationalCapture: { state: 'UNAVAILABLE', reasonCode: 'WORKTREE_STALE' } }
    const value = JSON.parse(registry.source(nativeDiagnosticSource(binding))?.cursor ?? '{}')
    return value.version === 1 ? { currentOperationalCapture: value.currentOperationalCapture, historicalCoverage: value.historicalCoverage,
      pipeline: { ...value.pipeline, expected: null, coverage: 'COVERAGE_UNKNOWN', scope: 'INGEST_ATTEMPTS', countCoverage: 'COMPLETED_ROUNDS', lostBeforeIngest: 'UNKNOWN' },
      windows: registry.nativeCaptureWindows(binding.worktreeId, binding.generation).map(window => ({ ...window,
        integrity: window.gapRevision === value.gapRevision ? 'NO_NEW_GAPS_OBSERVED' : 'PARTIAL',
        unresolvedGaps: window.gapRevision === value.gapRevision ? 0 : null, lossAttribution: 'UNASSIGNED_LOSSES_REMAIN_UNKNOWN' })) } : {}
  } catch { return {} }
}

const correlationConflictReasons = [
  'INVOCATION_INCOMPLETE', 'INVOCATION_AMBIGUOUS', 'INVOCATION_ORDER_INVALID',
  'CAPTURE_CONFIGURATION_CHANGED', 'CAPTURE_ENVELOPE_UNPROVEN', 'CAPTURE_PARTIAL', 'CAPTURE_WINDOW_UNPROVEN',
  'RECEIPT_AMBIGUOUS', 'RECEIPT_MISMATCH', 'RECEIPT_UNAVAILABLE', 'RECEIPT_UNVERIFIED',
  'REPLAY_NOT_AUTHORSHIP', 'REPLAY_NOT_CAUSAL', 'RESULT_UNCONFIRMED', 'GIT_OBJECT_UNVERIFIED'
] as const

export function nativeCorrelationSourceCoverage(registry: Pick<CheckpointRegistry, 'source'>, visibleInvocationIds: readonly string[]) {
  const ids = [...new Set(visibleInvocationIds.filter(id => hash.test(id)))].slice(0, 2)
  return ids.flatMap(id => ['NATIVE_GIT', 'NATIVE_ARTIFACT'].flatMap(kind => {
    const source = kind + ':' + id, state = registry.source(source)
    if (state?.status !== 'COMPLETE' && state?.status !== 'CONFLICT') return []
    const reasonCode = state.status === 'CONFLICT'
      ? correlationConflictReasons.find(reason => reason === state.cursor) ?? 'NATIVE_CONFLICT_UNCLASSIFIED'
      : undefined
    return [{ source, scope: 'VISIBLE_NATIVE_INVOCATION' as const, status: state.status, observedAt: state.observedAt,
      ...(reasonCode ? { reasonCode } : {}), pending: reasonCode === 'INVOCATION_INCOMPLETE' || reasonCode === 'RECEIPT_UNAVAILABLE' }]
  }))
}
