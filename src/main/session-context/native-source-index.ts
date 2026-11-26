import Database from 'better-sqlite3'
import { closeSync, fstatSync, lstatSync, openSync, readSync, constants, type BigIntStats } from 'node:fs'
import { digest, sanitize, utf8Prefix } from './privacy'
import {
  invalidateZstdStreamCache,
  readZstdLogicalRange,
  streamZstdJsonlChunk
} from './native-zstd-jsonl'
import {
  toNativeEventMeta,
  type NativeAttemptSummary,
  type NativeEventFilter,
  type NativeIndexedDiagnosticRef,
  type NativeIndexedEventRow,
  type NativeSessionReferences,
  type NativeSourceRecordSummary,
  type OpaqueRecordBreakdown
} from './native-session-references'
import type { NativeSourceEventType } from './native-source-events'
import type { CanonicalSkillTool, CompactSkillCallArgs } from './skill-intelligence-extractor'
import type { SkillEventInput } from './skill-intelligence-store'

export interface OpenSkillCallEntry extends CompactSkillCallArgs {
  canonicalTool: CanonicalSkillTool
  callEventId: string
  ordinal: number
  timestamp?: string
  turnId?: string
}

export const NATIVE_LINE_MAX_BYTES = 512 * 1024
export const NATIVE_IO_CHUNK_BYTES = 64 * 1024
export const DEFAULT_NATIVE_STEP_BYTES = 2 * 1024 * 1024
export const DEFAULT_NATIVE_STEP_LINES = 10_000
export const DEFAULT_NATIVE_ONDEMAND_BYTES = 512 * 1024

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

export interface NativeStepBudget {
  maxBytes?: number
  maxLines?: number
  deadlineMs?: number
  stepMs?: number
  onDemandMaxBytes?: number
}

export interface NativeIndexerState {
  ordinal: number
  seq: number
  typedEvents: number
  typedRecords: number
  opaqueRecords: number
  unavailableRecords: number
  opaqueBreakdown: OpaqueRecordBreakdown
  omittedRecords: number
  currentTurnId?: string
  typeCounts: Record<string, number>
  toolStats: Record<string, number>
  attemptCounts: { total: number; success: number; failure: number; refusal: number; dangling: number; unknown: number }
  attemptCoverage: string
  errors: NativeIndexedDiagnosticRef[]
  totalErrors: number
  openCalls: Record<string, NativeIndexedDiagnosticRef>
  openSkillCalls?: Record<string, OpenSkillCallEntry>
  unmatchedDangling: NativeIndexedDiagnosticRef[]
  turns: Record<string, { ordinal: number; id: string; firstObserved: string; lastObserved: string; eventCount: number }>
  turnOrder: number
  timestampedEvents: number
  missingTimestamps: number
}

export function createInitialIndexerState(attemptCoverage: string): NativeIndexerState {
  return {
    ordinal: 0,
    seq: 0,
    typedEvents: 0,
    typedRecords: 0,
    opaqueRecords: 0,
    unavailableRecords: 0,
    opaqueBreakdown: { protocolMetadata: 0, unrecognizedFormat: 0, unqualifiedContent: 0, unavailable: 0 },
    omittedRecords: 0,
    typeCounts: {},
    toolStats: {},
    attemptCounts: { total: 0, success: 0, failure: 0, refusal: 0, dangling: 0, unknown: 0 },
    attemptCoverage,
    errors: [],
    totalErrors: 0,
    openCalls: {},
    unmatchedDangling: [],
    turns: {},
    turnOrder: 0,
    timestampedEvents: 0,
    missingTimestamps: 0
  }
}

export function fileIdentityOf(s: BigIntStats): string {
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':')
}

export function openNoFollowReadOnly(filePath: string): number {
  return openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
}

export function readFdExactRange(fd: number, start: number, length: number, staleError = 'SOURCE_REVISION_CHANGED'): Buffer {
  if (length < 0 || length > NATIVE_LINE_MAX_BYTES + 16) throw new Error('SOURCE_LIMIT_REACHED')
  if (length === 0) return Buffer.alloc(0)
  const buf = Buffer.allocUnsafe(length)
  let filled = 0
  while (filled < length) {
    const read = readSync(fd, buf, filled, length - filled, start + filled)
    if (read <= 0) throw new Error(staleError)
    filled += read
  }
  return buf
}

export interface StepAccumulator {
  state: NativeIndexerState
  events: NativeIndexedEventRow[]
  pairUpdates: Array<{ eventId: string; status: string; pairing: string }>
  skillEvents: SkillEventInput[]
  dirtyTurns: Set<string>
  makeEventId: (ordinal: number, part: number, payloadDigest: string) => string
}

export function emitIndexedEvent(
  acc: StepAccumulator,
  input: {
    ordinal: number
    part: number
    type: NativeSourceEventType
    rawText: string
    timestamp?: string
    tool?: string
    turnId?: string
    status?: string
    pairing?: string
    errorKind?: string
    lineStart: number
    lineEnd: number
  }
): NativeIndexedEventRow {
  const content = sanitize(input.rawText)
  const payloadDigest = digest(content)
  const eventId = acc.makeEventId(input.ordinal, input.part, payloadDigest)
  const ts = input.timestamp
  const tsMs = ts ? Date.parse(ts) : NaN
  const row: NativeIndexedEventRow = {
    seq: acc.state.seq++,
    ordinal: input.ordinal,
    eventId,
    type: input.type,
    ...(ts ? { timestamp: ts, ...(Number.isFinite(tsMs) ? { timestampMs: tsMs } : {}) } : {}),
    ...(input.tool ? { tool: input.tool } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.pairing ? { pairing: input.pairing } : {}),
    ...(input.errorKind ? { errorKind: input.errorKind } : {}),
    bytes: Buffer.byteLength(content),
    payloadDigest,
    sanitized: content !== input.rawText,
    lineStart: input.lineStart,
    lineEnd: input.lineEnd,
    partIndex: input.part,
    text: content
  }
  acc.events.push(row)
  acc.state.typedEvents++
  acc.state.typeCounts[row.type] = (acc.state.typeCounts[row.type] ?? 0) + 1
  if (row.tool) acc.state.toolStats[row.tool] = (acc.state.toolStats[row.tool] ?? 0) + 1
  if (ts) {
    acc.state.timestampedEvents++
    if (row.turnId) {
      const prev = acc.state.turns[row.turnId]
      if (!prev) {
        acc.state.turns[row.turnId] = {
          ordinal: acc.state.turnOrder++,
          id: row.turnId,
          firstObserved: ts,
          lastObserved: ts,
          eventCount: 1
        }
      } else {
        if (!prev.firstObserved || ts < prev.firstObserved) prev.firstObserved = ts
        if (!prev.lastObserved || ts > prev.lastObserved) prev.lastObserved = ts
        prev.eventCount++
      }
      acc.dirtyTurns.add(row.turnId)
    }
  } else {
    acc.state.missingTimestamps++
    if (row.turnId) {
      const prev = acc.state.turns[row.turnId]
      if (!prev) {
        acc.state.turns[row.turnId] = {
          ordinal: acc.state.turnOrder++,
          id: row.turnId,
          firstObserved: '',
          lastObserved: '',
          eventCount: 1
        }
      } else {
        prev.eventCount++
      }
      acc.dirtyTurns.add(row.turnId)
    }
  }
  if (row.type === 'ERROR') {
    acc.state.totalErrors++
    if (acc.state.errors.length < 5) {
      acc.state.errors.push({
        eventId: row.eventId,
        ordinal: row.ordinal,
        ...(row.timestamp ? { timestamp: row.timestamp } : {}),
        ...(row.tool ? { tool: row.tool } : {}),
        ...(row.turnId ? { turnId: row.turnId } : {}),
        ...(row.status ? { status: row.status } : {}),
        ...(row.errorKind ? { errorKind: row.errorKind } : {})
      })
    }
  }
  return row
}

export function extractOpaqueSafeMetadata(rawRecord: unknown): Record<string, string | number> {
  const rec = rawRecord as Record<string, unknown> | null
  if (!rec || typeof rec !== 'object') return {}
  const out: Record<string, string | number> = {}
  if (typeof rec.type === 'string') out.type = sanitize(rec.type).slice(0, 80)
  if (typeof rec.source === 'string') out.source = sanitize(rec.source).slice(0, 80)
  if (Number.isSafeInteger(rec.step_index)) out.step_index = rec.step_index as number
  const ts = typeof rec.created_at === 'string' ? rec.created_at : typeof rec.timestamp === 'string' ? rec.timestamp : undefined
  if (ts && Number.isFinite(Date.parse(ts))) out.timestamp = ts
  return out
}

export function emitOpaqueRecord(
  acc: StepAccumulator,
  input: {
    ordinal: number
    rawRecord: unknown
    timestamp?: string
    limitation: string
    lineStart: number
    lineEnd: number
  }
): NativeIndexedEventRow {
  const safeMeta = extractOpaqueSafeMetadata(input.rawRecord)
  const payloadDigest = digest(JSON.stringify(safeMeta))
  const eventId = acc.makeEventId(input.ordinal, 0, payloadDigest)
  const ts = input.timestamp
  const tsMs = ts ? Date.parse(ts) : NaN
  const row: NativeIndexedEventRow = {
    seq: acc.state.seq++,
    ordinal: input.ordinal,
    eventId,
    type: 'OPAQUE',
    ...(ts ? { timestamp: ts, ...(Number.isFinite(tsMs) ? { timestampMs: tsMs } : {}) } : {}),
    errorKind: input.limitation,
    bytes: 0,
    payloadDigest,
    sanitized: true,
    lineStart: input.lineStart,
    lineEnd: input.lineEnd,
    partIndex: 0
  }
  acc.events.push(row)
  acc.state.opaqueRecords++
  if (!acc.state.opaqueBreakdown) acc.state.opaqueBreakdown = { protocolMetadata: 0, unrecognizedFormat: 0, unqualifiedContent: 0, unavailable: 0 }
  if (input.limitation === 'PROTOCOL_METADATA') acc.state.opaqueBreakdown.protocolMetadata++
  else if (input.limitation === 'UNQUALIFIED_CONTENT' || input.limitation === 'EMPTY_RECORD') acc.state.opaqueBreakdown.unqualifiedContent++
  else acc.state.opaqueBreakdown.unrecognizedFormat++
  return row
}

export function emitUnavailableRecord(
  acc: StepAccumulator,
  input: {
    ordinal: number
    limitation: string
    lineStart: number
    lineEnd: number
  }
): NativeIndexedEventRow {
  const payloadDigest = digest(JSON.stringify(['UNAVAILABLE', input.limitation, input.lineStart, input.lineEnd]))
  const eventId = acc.makeEventId(input.ordinal, 0, payloadDigest)
  const row: NativeIndexedEventRow = {
    seq: acc.state.seq++,
    ordinal: input.ordinal,
    eventId,
    type: 'UNAVAILABLE',
    errorKind: input.limitation,
    bytes: 0,
    payloadDigest,
    sanitized: false,
    lineStart: input.lineStart,
    lineEnd: input.lineEnd,
    partIndex: 0
  }
  acc.events.push(row)
  acc.state.unavailableRecords++
  if (!acc.state.opaqueBreakdown) acc.state.opaqueBreakdown = { protocolMetadata: 0, unrecognizedFormat: 0, unqualifiedContent: 0, unavailable: 0 }
  acc.state.opaqueBreakdown.unavailable++
  acc.state.omittedRecords++
  return row
}

export function applyAttemptOutcome(counts: NativeIndexerState['attemptCounts'], status: string): void {
  if (status === 'SUCCESS') counts.success++
  else if (status === 'FAILURE') counts.failure++
  else if (status === 'REFUSAL') counts.refusal++
  else if (status === 'DANGLING') counts.dangling++
  else counts.unknown++
}

export function buildSummaryFromState(meta: {
  nativeKey: string
  provider: 'codex' | 'antigravity'
  repositoryId: string
  worktreeId: string
  generation: string
  sourceSessionId: string
  locatorHash: string
  normalizer: string
  revision: number
  fileIdentity: string
  prefixDigest: string
  tailOffset: number
  tailDigest: string
  sourceBytes: number
  sourceCoverage: string
  sourceVariant?: string
  coexistingVariants?: string[]
}, state: NativeIndexerState): NativeSourceRecordSummary {
  const typedRecords = state.typedRecords ?? 0
  const opaqueRecords = state.opaqueRecords ?? 0
  const unavailableRecords = state.unavailableRecords ?? 0
  const recordsTotal = typedRecords + opaqueRecords + unavailableRecords
  const recordsAddressable = typedRecords + opaqueRecords + unavailableRecords
  const sourceTypeCounts = (Object.entries(state.typeCounts) as Array<[NativeSourceEventType, number]>)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => ({ type, count }))
  const sourceTools = Object.entries(state.toolStats)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([tool, count]) => ({ tool, count }))
  const openDangling = Object.values(state.openCalls).sort((a, b) => a.ordinal - b.ordinal)
  const combinedDangling = [...state.unmatchedDangling, ...openDangling]
    .sort((a, b) => a.ordinal - b.ordinal)
  const totalDangling = state.unmatchedDangling.length + openDangling.length
  const attemptSummary: NativeAttemptSummary = {
    ...state.attemptCounts,
    attemptCoverage: state.attemptCoverage
  }
  return {
    nativeKey: meta.nativeKey,
    provider: meta.provider,
    repositoryId: meta.repositoryId,
    worktreeId: meta.worktreeId,
    generation: meta.generation,
    sourceSessionId: meta.sourceSessionId,
    locatorHash: meta.locatorHash,
    normalizer: meta.normalizer,
    revision: meta.revision,
    fileIdentity: meta.fileIdentity,
    prefixDigest: meta.prefixDigest,
    tailOffset: meta.tailOffset,
    tailDigest: meta.tailDigest,
    sourceBytes: meta.sourceBytes,
    indexedBytes: meta.tailOffset,
    eventCount: state.typedEvents,
    omittedRecords: state.omittedRecords,
    recordsTotal,
    recordsAddressable,
    typedRecords,
    opaqueRecords,
    unavailableRecords,
    opaqueBreakdown: state.opaqueBreakdown ?? {
      protocolMetadata: 0,
      unrecognizedFormat: opaqueRecords,
      unqualifiedContent: 0,
      unavailable: unavailableRecords
    },
    ...(meta.sourceVariant ? { sourceVariant: meta.sourceVariant } : {}),
    ...(meta.coexistingVariants?.length ? { coexistingVariants: meta.coexistingVariants } : {}),
    sourceCoverage: meta.sourceCoverage,
    attemptCoverage: state.attemptCoverage,
    timeCoverage: { timestampedEvents: state.timestampedEvents, missingTimestamps: state.missingTimestamps },
    sourceTools,
    sourceTypeCounts,
    attemptSummary,
    errors: state.errors.slice(0, 5),
    omittedErrors: Math.max(0, state.totalErrors - 5),
    danglingCalls: combinedDangling.slice(0, 5),
    omittedDanglingCalls: Math.max(0, totalDangling - 5),
    turnCount: Object.keys(state.turns).length,
    lastOrdinal: state.ordinal,
    ...(state.currentTurnId ? { currentTurnId: state.currentTurnId } : {}),
    openCallsJson: JSON.stringify(state.openCalls),
    updatedAt: new Date().toISOString()
  }
}

export interface NativeIndexedSourceHandle {
  fd: number
  path: string
  profile: string
  identity: string
  sizeBytes: number
  locatorHash: string
  liveFingerprint: string
  configUnchanged: () => boolean
  assertPath: () => void
  verifyAfterClose?: () => void
  allowLexicalIndex?: boolean
  compressed?: boolean
  sourceVariant?: string
  coexistingVariants?: string[]
}

export type NativeReferenceStepResult =
  | {
      status: 'READY'
      nativeKey: string
      summary: NativeSourceRecordSummary
      liveFingerprint: string
      sourcePhysicalBytes: number
    }
  | {
      status: 'INDEXING_PENDING'
      nativeKey: string
      indexedBytes: number
      totalBytes: number | null
      sourcePhysicalBytes: number
      indexedEvents: number
      liveFingerprint: string
      reason: 'STEP_BUDGET_REACHED' | 'SOURCE_REQUIRES_INDEXING' | 'READ_ONLY_STORE'
    }

export function runNativeReferenceStep(options: {
  refs: NativeSessionReferences
  nativeKey: string
  provider: 'codex' | 'antigravity'
  repositoryId: string
  worktreeId: string
  generation: string
  sourceSessionId: string
  normalizer: string
  sourceCoverage: string
  attemptCoverage: string
  formatError: string
  staleError: string
  mode: 'READ_ONLY' | 'ON_DEMAND' | 'STEP'
  stepBudget?: NativeStepBudget
  assertCurrent: () => void
  openHandle: () => NativeIndexedSourceHandle
  processRecord: (record: unknown, lineStart: number, lineEnd: number, acc: StepAccumulator) => void
  onUnavailableRecord?: (lineStart: number, lineEnd: number, limitation: 'RECORD_TOO_LARGE' | 'INVALID_RECORD_FORMAT', acc: StepAccumulator) => void
  onFinalizeSkillCalls?: (acc: StepAccumulator) => void
  makeEventId: (ordinal: number, part: number, payloadDigest: string, snapshotIdentity: string) => string
  onReady?: (ready: { summary: NativeSourceRecordSummary; nativeKey: string; liveFingerprint: string; fd: number }) => void
}, preopenedHandle?: NativeIndexedSourceHandle): NativeReferenceStepResult {
  const {
    refs, nativeKey, provider, repositoryId, worktreeId, generation, sourceSessionId,
    normalizer, sourceCoverage, attemptCoverage, formatError, staleError,
    mode, stepBudget, assertCurrent, openHandle, processRecord, onUnavailableRecord, makeEventId, onReady
  } = options
  let handle: NativeIndexedSourceHandle
  if (preopenedHandle) {
    handle = preopenedHandle
  } else {
    try {
      handle = openHandle()
    } catch (error) {
      if (!refs.isReadOnly && error instanceof Error && [
        'SOURCE_NOT_AUTHORIZED', 'SOURCE_NOT_FOUND', 'SOURCE_UNAVAILABLE', 'PROFILE_UNAVAILABLE',
        'IDENTITY_MISMATCH', 'ORIGIN_UNVERIFIED', 'SOURCE_IDENTITY_CONFLICT',
        'SOURCE_FORMAT_UNSUPPORTED', 'FORMAT_UNSUPPORTED', 'SOURCE_PATH_ESCAPE'
      ].includes(error.message)) {
        refs.invalidate(nativeKey)
      }
      throw error
    }
  }
  let closed = false
  const closeOnce = () => { if (!closed) { closed = true; closeSync(handle.fd) } }
  try {
    const existing = refs.getSummary(nativeKey)
    const existingExact = !!(
      existing &&
      existing.locatorHash === handle.locatorHash &&
      existing.normalizer === normalizer &&
      existing.fileIdentity === handle.identity &&
      existing.sourceBytes === handle.sizeBytes
    )
    if (existingExact && existing) {
      if (onReady) {
        onReady({ summary: existing, nativeKey, liveFingerprint: handle.liveFingerprint, fd: handle.fd })
      }
      verifyStaticSourceBeforeClose(handle.fd, handle.path, handle.identity, handle.assertPath, handle.configUnchanged, assertCurrent, staleError)
      closeOnce()
      handle.verifyAfterClose?.()
      return { status: 'READY', nativeKey, summary: existing, liveFingerprint: handle.liveFingerprint, sourcePhysicalBytes: existing.sourceBytes }
    }

    if (mode === 'READ_ONLY') {
      const cp = refs.getCheckpoint(nativeKey)
      const checkpointExact = !!(
        cp &&
        cp.locatorHash === handle.locatorHash &&
        cp.normalizer === normalizer &&
        cp.fileIdentity === handle.identity &&
        cp.sourceBytes === handle.sizeBytes &&
        cp.nextOffset <= handle.sizeBytes
      )
      return {
        status: 'INDEXING_PENDING',
        nativeKey,
        indexedBytes: checkpointExact ? cp!.nextOffset : 0,
        totalBytes: handle.sizeBytes,
        sourcePhysicalBytes: handle.sizeBytes,
        indexedEvents: checkpointExact ? (JSON.parse(cp!.stateJson) as NativeIndexerState).typedEvents ?? 0 : 0,
        liveFingerprint: handle.liveFingerprint,
        reason: 'READ_ONLY_STORE'
      }
    }

    if (existing) {
      refs.invalidate(nativeKey)
    }

    let checkpoint = refs.getCheckpoint(nativeKey)
    const checkpointValid = !!(
      checkpoint &&
      checkpoint.locatorHash === handle.locatorHash &&
      checkpoint.normalizer === normalizer &&
      checkpoint.fileIdentity === handle.identity &&
      checkpoint.sourceBytes === handle.sizeBytes &&
      checkpoint.nextOffset <= handle.sizeBytes
    )
    if (checkpoint && !checkpointValid) {
      refs.invalidate(nativeKey)
      checkpoint = undefined
    }

    const remainingBytes = checkpoint ? handle.sizeBytes - checkpoint.nextOffset : handle.sizeBytes
    const onDemandCap = stepBudget?.onDemandMaxBytes ?? DEFAULT_NATIVE_ONDEMAND_BYTES
    if (mode === 'ON_DEMAND' && remainingBytes > onDemandCap) {
      return {
        status: 'INDEXING_PENDING',
        nativeKey,
        indexedBytes: checkpoint ? checkpoint.nextOffset : 0,
        totalBytes: handle.sizeBytes,
        sourcePhysicalBytes: handle.sizeBytes,
        indexedEvents: checkpoint ? (JSON.parse(checkpoint.stateJson) as NativeIndexerState).typedEvents ?? 0 : 0,
        liveFingerprint: handle.liveFingerprint,
        reason: 'SOURCE_REQUIRES_INDEXING'
      }
    }

    if (!checkpoint) {
      checkpoint = refs.startFreshCheckpoint({
        nativeKey,
        locatorHash: handle.locatorHash,
        normalizer,
        fileIdentity: handle.identity,
        prefixDigest: '',
        sourceBytes: handle.sizeBytes,
        stateJson: JSON.stringify(createInitialIndexerState(attemptCoverage))
      })
    }

    const state = JSON.parse(checkpoint.stateJson) as NativeIndexerState
    state.turns = {}
    const acc: StepAccumulator = {
      state,
      events: [],
      pairUpdates: [],
      skillEvents: [],
      dirtyTurns: new Set<string>(),
      makeEventId: (ordinal, part, payloadDigest) => makeEventId(ordinal, part, payloadDigest, handle.identity)
    }

    const streamDeadline = stepBudget?.stepMs !== undefined
      ? (stepBudget.deadlineMs !== undefined ? Math.min(stepBudget.deadlineMs, Date.now() + stepBudget.stepMs) : Date.now() + stepBudget.stepMs)
      : stepBudget?.deadlineMs
    const effectiveStepBudget: NativeStepBudget = {
      maxBytes: stepBudget?.maxBytes ?? (mode === 'ON_DEMAND' ? Math.max(onDemandCap, DEFAULT_NATIVE_STEP_BYTES) : DEFAULT_NATIVE_STEP_BYTES),
      maxLines: stepBudget?.maxLines ?? DEFAULT_NATIVE_STEP_LINES,
      ...(streamDeadline !== undefined ? { deadlineMs: streamDeadline } : {})
    }

    let stepOut: { done: boolean; nextOffset: number; processedBytes: number; processedLines: number }
    try {
      stepOut = streamNativeJsonlChunk({
        fd: handle.fd,
        startOffset: checkpoint.nextOffset,
        fileSize: handle.sizeBytes,
        formatError,
        stepBudget: effectiveStepBudget,
        assertCurrent,
        onRecord: (record, lineStart, lineEnd) => processRecord(record, lineStart, lineEnd, acc),
        ...(onUnavailableRecord
          ? {
              onUnavailableRecord: (lineStart, lineEnd, limitation) =>
                onUnavailableRecord(lineStart, lineEnd, limitation, acc)
            }
          : {})
      })
      verifyStaticSourceBeforeClose(handle.fd, handle.path, handle.identity, handle.assertPath, handle.configUnchanged, assertCurrent, staleError)
      handle.verifyAfterClose?.()
    } catch (error) {
      refs.invalidate(nativeKey)
      throw error
    }

    if (stepOut.done && (!state.ordinal || (state.typedRecords === 0 && state.opaqueRecords === 0))) {
      closeOnce()
      handle.verifyAfterClose?.()
      refs.invalidate(nativeKey)
      throw new Error(state.ordinal ? 'SOURCE_CONTENT_UNAVAILABLE' : formatError)
    }

    if (stepOut.done) {
      options.onFinalizeSkillCalls?.(acc)
    }

    const turnRows = [...acc.dirtyTurns].map(id => {
      const t = state.turns[id]!
      return {
        ordinal: t.ordinal,
        turnId: t.id,
        firstTime: t.firstObserved || undefined,
        lastTime: t.lastObserved || undefined,
        eventCount: t.eventCount,
        typesJson: '{}'
      }
    })
    state.turns = {}

    try {
      refs.saveChunk({
        nativeKey,
        revision: checkpoint.revision,
        events: acc.events,
        pairUpdates: acc.pairUpdates,
        skillEvents: acc.skillEvents,
        turns: turnRows,
        nextOffset: stepOut.nextOffset,
        tailDigest: '',
        sourceBytes: handle.sizeBytes,
        fileIdentity: handle.identity,
        stateJson: JSON.stringify(state),
        allowLexicalIndex: handle.allowLexicalIndex
      })

      if (!stepOut.done) {
        verifyStaticSourceBeforeClose(handle.fd, handle.path, handle.identity, handle.assertPath, handle.configUnchanged, assertCurrent, staleError)
        closeOnce()
        handle.verifyAfterClose?.()
        return {
          status: 'INDEXING_PENDING',
          nativeKey,
          indexedBytes: stepOut.nextOffset,
          totalBytes: handle.sizeBytes,
          sourcePhysicalBytes: handle.sizeBytes,
          indexedEvents: state.typedEvents,
          liveFingerprint: handle.liveFingerprint,
          reason: 'STEP_BUDGET_REACHED'
        }
      }

      verifyStaticSourceBeforeClose(handle.fd, handle.path, handle.identity, handle.assertPath, handle.configUnchanged, assertCurrent, staleError)
      handle.verifyAfterClose?.()

      const summary = refs.promote(buildSummaryFromState({
        nativeKey,
        provider,
        repositoryId,
        worktreeId,
        generation,
        sourceSessionId,
        locatorHash: handle.locatorHash,
        normalizer,
        revision: checkpoint.revision,
        fileIdentity: handle.identity,
        prefixDigest: '',
        tailOffset: stepOut.nextOffset,
        tailDigest: '',
        sourceBytes: handle.sizeBytes,
        sourceCoverage,
        ...(handle.sourceVariant ? { sourceVariant: handle.sourceVariant } : {}),
        ...(handle.coexistingVariants?.length ? { coexistingVariants: handle.coexistingVariants } : {})
      }, state))
      onReady?.({ summary, nativeKey, liveFingerprint: handle.liveFingerprint, fd: handle.fd })
      verifyStaticSourceBeforeClose(handle.fd, handle.path, handle.identity, handle.assertPath, handle.configUnchanged, assertCurrent, staleError)
      closeOnce()
      handle.verifyAfterClose?.()
      return { status: 'READY', nativeKey, summary, liveFingerprint: handle.liveFingerprint, sourcePhysicalBytes: summary.sourceBytes }
    } catch (error) {
      refs.invalidate(nativeKey)
      invalidateZstdStreamCache(nativeKey)
      throw error
    }
  } finally {
    closeOnce()
  }
}

export async function runNativeReferenceStepAsync(options: Parameters<typeof runNativeReferenceStep>[0]): Promise<NativeReferenceStepResult> {
  const {
    refs, nativeKey, provider, repositoryId, worktreeId, generation, sourceSessionId,
    normalizer, sourceCoverage, attemptCoverage, formatError, staleError,
    mode, stepBudget, assertCurrent, openHandle, processRecord, onUnavailableRecord, makeEventId, onReady
  } = options
  let handle: NativeIndexedSourceHandle
  try {
    handle = openHandle()
  } catch (error) {
    if (!refs.isReadOnly && error instanceof Error && [
      'SOURCE_NOT_AUTHORIZED', 'SOURCE_NOT_FOUND', 'SOURCE_UNAVAILABLE', 'PROFILE_UNAVAILABLE',
      'IDENTITY_MISMATCH', 'ORIGIN_UNVERIFIED', 'SOURCE_IDENTITY_CONFLICT', 'IDENTITY_UNVERIFIED',
      'SOURCE_FORMAT_UNSUPPORTED', 'FORMAT_UNSUPPORTED', 'SOURCE_PATH_ESCAPE'
    ].includes(error.message)) {
      refs.invalidate(nativeKey)
      invalidateZstdStreamCache(nativeKey)
    }
    throw error
  }
  if (!handle.compressed) {
    return runNativeReferenceStep(options, handle)
  }
  let closed = false
  const closeOnce = () => { if (!closed) { closed = true; closeSync(handle.fd) } }
  try {
    const existing = refs.getSummary(nativeKey)
    const existingExact = !!(
      existing &&
      existing.locatorHash === handle.locatorHash &&
      existing.normalizer === normalizer &&
      existing.fileIdentity === handle.identity &&
      existing.sourceBytes === handle.sizeBytes
    )
    if (existingExact && existing) {
      if (onReady) {
        onReady({ summary: existing, nativeKey, liveFingerprint: handle.liveFingerprint, fd: handle.fd })
      }
      verifyStaticSourceBeforeClose(handle.fd, handle.path, handle.identity, handle.assertPath, handle.configUnchanged, assertCurrent, staleError)
      closeOnce()
      handle.verifyAfterClose?.()
      return { status: 'READY', nativeKey, summary: existing, liveFingerprint: handle.liveFingerprint, sourcePhysicalBytes: existing.sourceBytes }
    }

    if (mode === 'READ_ONLY') {
      const cp = refs.getCheckpoint(nativeKey)
      const checkpointExact = !!(
        cp &&
        cp.locatorHash === handle.locatorHash &&
        cp.normalizer === normalizer &&
        cp.fileIdentity === handle.identity &&
        cp.sourceBytes === handle.sizeBytes &&
        Number.isSafeInteger(cp.nextOffset) &&
        cp.nextOffset >= 0
      )
      return {
        status: 'INDEXING_PENDING',
        nativeKey,
        indexedBytes: checkpointExact ? cp!.nextOffset : 0,
        totalBytes: null,
        sourcePhysicalBytes: handle.sizeBytes,
        indexedEvents: checkpointExact ? (JSON.parse(cp!.stateJson) as NativeIndexerState).typedEvents ?? 0 : 0,
        liveFingerprint: handle.liveFingerprint,
        reason: 'READ_ONLY_STORE'
      }
    }

    if (existing) {
      refs.invalidate(nativeKey)
      invalidateZstdStreamCache(nativeKey)
    }

    let checkpoint = refs.getCheckpoint(nativeKey)
    const checkpointValid = !!(
      checkpoint &&
      checkpoint.locatorHash === handle.locatorHash &&
      checkpoint.normalizer === normalizer &&
      checkpoint.fileIdentity === handle.identity &&
      checkpoint.sourceBytes === handle.sizeBytes
    )
    if (checkpoint && !checkpointValid) {
      refs.invalidate(nativeKey)
      invalidateZstdStreamCache(nativeKey)
      checkpoint = undefined
    }

    const onDemandCap = stepBudget?.onDemandMaxBytes ?? DEFAULT_NATIVE_ONDEMAND_BYTES
    if (mode === 'ON_DEMAND' && handle.sizeBytes > onDemandCap) {
      return {
        status: 'INDEXING_PENDING',
        nativeKey,
        indexedBytes: checkpoint ? checkpoint.nextOffset : 0,
        totalBytes: null,
        sourcePhysicalBytes: handle.sizeBytes,
        indexedEvents: checkpoint ? (JSON.parse(checkpoint.stateJson) as NativeIndexerState).typedEvents ?? 0 : 0,
        liveFingerprint: handle.liveFingerprint,
        reason: 'SOURCE_REQUIRES_INDEXING'
      }
    }

    if (!checkpoint) {
      checkpoint = refs.startFreshCheckpoint({
        nativeKey,
        locatorHash: handle.locatorHash,
        normalizer,
        fileIdentity: handle.identity,
        prefixDigest: '',
        sourceBytes: handle.sizeBytes,
        stateJson: JSON.stringify(createInitialIndexerState(attemptCoverage))
      })
    }

    const state = JSON.parse(checkpoint.stateJson) as NativeIndexerState
    state.turns = {}
    const acc: StepAccumulator = {
      state,
      events: [],
      pairUpdates: [],
      skillEvents: [],
      dirtyTurns: new Set<string>(),
      makeEventId: (ordinal, part, payloadDigest) => makeEventId(ordinal, part, payloadDigest, handle.identity)
    }

    const streamDeadline = stepBudget?.stepMs !== undefined
      ? (stepBudget.deadlineMs !== undefined ? Math.min(stepBudget.deadlineMs, Date.now() + stepBudget.stepMs) : Date.now() + stepBudget.stepMs)
      : stepBudget?.deadlineMs
    const effectiveStepBudget: NativeStepBudget = {
      maxBytes: stepBudget?.maxBytes ?? (mode === 'ON_DEMAND' ? Math.max(onDemandCap, DEFAULT_NATIVE_STEP_BYTES) : DEFAULT_NATIVE_STEP_BYTES),
      maxLines: stepBudget?.maxLines ?? DEFAULT_NATIVE_STEP_LINES,
      ...(streamDeadline !== undefined ? { deadlineMs: streamDeadline } : {})
    }

    let stepOut: { done: boolean; nextOffset: number; processedBytes: number; processedLines: number }
    try {
      stepOut = await streamZstdJsonlChunk({
        fd: handle.fd,
        fileSize: handle.sizeBytes,
        nativeKey,
        fileIdentity: handle.identity,
        startOffset: checkpoint.nextOffset,
        formatError,
        stepBudget: effectiveStepBudget,
        assertCurrent,
        onRecord: (record, lineStart, lineEnd) => processRecord(record, lineStart, lineEnd, acc),
        ...(onUnavailableRecord
          ? {
              onUnavailableRecord: (lineStart, lineEnd, limitation) =>
                onUnavailableRecord(lineStart, lineEnd, limitation, acc)
            }
          : {})
      })
      verifyStaticSourceBeforeClose(handle.fd, handle.path, handle.identity, handle.assertPath, handle.configUnchanged, assertCurrent, staleError)
      handle.verifyAfterClose?.()
    } catch (error) {
      refs.invalidate(nativeKey)
      invalidateZstdStreamCache(nativeKey)
      throw error
    }

    if (stepOut.done && (!state.ordinal || (state.typedRecords === 0 && state.opaqueRecords === 0))) {
      closeOnce()
      handle.verifyAfterClose?.()
      refs.invalidate(nativeKey)
      invalidateZstdStreamCache(nativeKey)
      throw new Error(state.ordinal ? 'SOURCE_CONTENT_UNAVAILABLE' : formatError)
    }

    if (stepOut.done) {
      options.onFinalizeSkillCalls?.(acc)
    }

    const turnRows = [...acc.dirtyTurns].map(id => {
      const t = state.turns[id]!
      return {
        ordinal: t.ordinal,
        turnId: t.id,
        firstTime: t.firstObserved || undefined,
        lastTime: t.lastObserved || undefined,
        eventCount: t.eventCount,
        typesJson: '{}'
      }
    })
    state.turns = {}

    try {
      refs.saveChunk({
        nativeKey,
        revision: checkpoint.revision,
        events: acc.events,
        pairUpdates: acc.pairUpdates,
        skillEvents: acc.skillEvents,
        turns: turnRows,
        nextOffset: stepOut.nextOffset,
        tailDigest: '',
        sourceBytes: handle.sizeBytes,
        fileIdentity: handle.identity,
        stateJson: JSON.stringify(state),
        allowLexicalIndex: handle.allowLexicalIndex
      })

      if (!stepOut.done) {
        verifyStaticSourceBeforeClose(handle.fd, handle.path, handle.identity, handle.assertPath, handle.configUnchanged, assertCurrent, staleError)
        closeOnce()
        handle.verifyAfterClose?.()
        return {
          status: 'INDEXING_PENDING',
          nativeKey,
          indexedBytes: stepOut.nextOffset,
          totalBytes: null,
          sourcePhysicalBytes: handle.sizeBytes,
          indexedEvents: state.typedEvents,
          liveFingerprint: handle.liveFingerprint,
          reason: 'STEP_BUDGET_REACHED'
        }
      }

      verifyStaticSourceBeforeClose(handle.fd, handle.path, handle.identity, handle.assertPath, handle.configUnchanged, assertCurrent, staleError)
      handle.verifyAfterClose?.()

      const summary = refs.promote(buildSummaryFromState({
        nativeKey,
        provider,
        repositoryId,
        worktreeId,
        generation,
        sourceSessionId,
        locatorHash: handle.locatorHash,
        normalizer,
        revision: checkpoint.revision,
        fileIdentity: handle.identity,
        prefixDigest: '',
        tailOffset: stepOut.nextOffset,
        tailDigest: '',
        sourceBytes: handle.sizeBytes,
        sourceCoverage,
        ...(handle.sourceVariant ? { sourceVariant: handle.sourceVariant } : {}),
        ...(handle.coexistingVariants?.length ? { coexistingVariants: handle.coexistingVariants } : {})
      }, state))
      onReady?.({ summary, nativeKey, liveFingerprint: handle.liveFingerprint, fd: handle.fd })
      verifyStaticSourceBeforeClose(handle.fd, handle.path, handle.identity, handle.assertPath, handle.configUnchanged, assertCurrent, staleError)
      closeOnce()
      handle.verifyAfterClose?.()
      return { status: 'READY', nativeKey, summary, liveFingerprint: handle.liveFingerprint, sourcePhysicalBytes: summary.sourceBytes }
    } catch (error) {
      refs.invalidate(nativeKey)
      invalidateZstdStreamCache(nativeKey)
      throw error
    }
  } finally {
    closeOnce()
  }
}

export function streamNativeJsonlChunk(options: {
  fd: number
  startOffset: number
  fileSize: number
  formatError: string
  stepBudget?: NativeStepBudget
  assertCurrent: () => void
  onRecord: (record: unknown, lineStart: number, lineEnd: number) => void
  onUnavailableRecord?: (lineStart: number, lineEnd: number, limitation: 'RECORD_TOO_LARGE' | 'INVALID_RECORD_FORMAT') => void
}): { done: boolean; nextOffset: number; processedBytes: number; processedLines: number } {
  const { fd, startOffset, fileSize, formatError, stepBudget, assertCurrent, onRecord, onUnavailableRecord } = options
  const maxStepBytes = stepBudget?.maxBytes ?? Number.POSITIVE_INFINITY
  const maxStepLines = stepBudget?.maxLines ?? Number.POSITIVE_INFINITY
  const deadlineMs = stepBudget?.deadlineMs
  const chunkBuf = Buffer.allocUnsafe(NATIVE_IO_CHUNK_BYTES)
  let readPos = startOffset
  let lineStart = startOffset
  let pending = Buffer.alloc(0)
  let skippingOversized = false
  let processedBytes = 0
  let processedLines = 0
  let paused = false

  while (!paused && readPos < fileSize) {
    assertCurrent()
    const toRead = Math.min(chunkBuf.length, fileSize - readPos)
    const size = readSync(fd, chunkBuf, 0, toRead, readPos)
    if (size <= 0) break
    const chunkBaseOffset = readPos
    readPos += size
    let data = skippingOversized
      ? chunkBuf.subarray(0, size)
      : (pending.length ? Buffer.concat([pending, chunkBuf.subarray(0, size)]) : chunkBuf.subarray(0, size))
    let dataOffset = skippingOversized ? chunkBaseOffset : lineStart
    let newline: number
    while ((newline = data.indexOf(10)) !== -1) {
      const lineEnd = dataOffset + newline
      if (skippingOversized || lineEnd - lineStart > NATIVE_LINE_MAX_BYTES) {
        if (!onUnavailableRecord) throw new Error('SOURCE_LIMIT_REACHED')
        onUnavailableRecord(lineStart, lineEnd, 'RECORD_TOO_LARGE')
        skippingOversized = false
        data = data.subarray(newline + 1)
        dataOffset = lineEnd + 1
        const consumed = (lineEnd + 1) - lineStart
        lineStart = lineEnd + 1
        processedBytes += consumed
        processedLines++
      } else {
        let parsed: unknown
        let parseOk = true
        try {
          parsed = JSON.parse(utf8Decoder.decode(data.subarray(0, newline)))
        } catch {
          parseOk = false
        }
        data = data.subarray(newline + 1)
        dataOffset = lineEnd + 1
        if (parseOk) {
          onRecord(parsed, lineStart, lineEnd)
        } else {
          if (!onUnavailableRecord) throw new Error(formatError)
          onUnavailableRecord(lineStart, lineEnd, 'INVALID_RECORD_FORMAT')
        }
        lineStart = lineEnd + 1
        processedBytes += newline + 1
        processedLines++
      }
      if (lineStart < fileSize && (
        processedBytes >= maxStepBytes ||
        processedLines >= maxStepLines ||
        (deadlineMs !== undefined && Date.now() >= deadlineMs)
      )) {
        paused = true
        break
      }
    }
    if (!paused) {
      if (skippingOversized) {
        pending = Buffer.alloc(0)
      } else if (data.length > NATIVE_LINE_MAX_BYTES) {
        if (!onUnavailableRecord) throw new Error('SOURCE_LIMIT_REACHED')
        skippingOversized = true
        pending = Buffer.alloc(0)
      } else {
        pending = data.length ? Buffer.from(data) : Buffer.alloc(0)
      }
    } else {
      pending = Buffer.alloc(0)
      skippingOversized = false
    }
  }

  if (!paused && (pending.length > 0 || skippingOversized)) throw new Error(formatError)
  return {
    done: !paused && lineStart >= fileSize,
    nextOffset: lineStart,
    processedBytes,
    processedLines
  }
}

export function extractAndVerifyEventLiteral(options: {
  fd: number
  row: NativeIndexedEventRow
  formatError: string
  staleError: string
  extractPart: (record: unknown, partIndex: number) => string | undefined
}): {
  content: string
  sanitized: boolean
  opaque?: boolean
  unavailable?: boolean
  limitation?: string
  safeFields?: Record<string, string | number>
} {
  const { fd, row, formatError, staleError, extractPart } = options
  if (row.type === 'UNAVAILABLE') {
    const limitation = row.errorKind ?? 'RECORD_TOO_LARGE'
    const expectedDigest = digest(JSON.stringify(['UNAVAILABLE', limitation, row.lineStart, row.lineEnd]))
    if (expectedDigest !== row.payloadDigest) throw new Error(staleError)
    return { content: '', sanitized: false, unavailable: true, limitation }
  }
  const lineLen = row.lineEnd - row.lineStart
  if (lineLen < 0 || lineLen > NATIVE_LINE_MAX_BYTES) throw new Error('SOURCE_LIMIT_REACHED')
  const lineBuf = readFdExactRange(fd, row.lineStart, lineLen, staleError)
  let record: unknown
  try {
    record = JSON.parse(utf8Decoder.decode(lineBuf))
  } catch {
    throw new Error(formatError)
  }
  if (row.type === 'OPAQUE') {
    const safeFields = extractOpaqueSafeMetadata(record)
    if (digest(JSON.stringify(safeFields)) !== row.payloadDigest) throw new Error(staleError)
    return {
      content: '',
      sanitized: true,
      opaque: true,
      limitation: row.errorKind ?? 'UNRECOGNIZED_FORMAT',
      safeFields
    }
  }
  const rawText = extractPart(record, row.partIndex)
  if (rawText === undefined) throw new Error(staleError)
  const content = sanitize(rawText)
  if (digest(content) !== row.payloadDigest || Buffer.byteLength(content) !== row.bytes) {
    throw new Error(staleError)
  }
  return { content, sanitized: content !== rawText }
}

export async function extractAndVerifyEventLiteralAsync(options: {
  fd: number
  fileSize: number
  nativeKey: string
  fileIdentity: string
  compressed?: boolean
  row: NativeIndexedEventRow
  formatError: string
  staleError: string
  extractPart: (record: unknown, partIndex: number) => string | undefined
  assertCurrent: () => void
  deadlineMs?: number
}) {
  const { fd, fileSize, nativeKey, fileIdentity, compressed, row, formatError, staleError, extractPart, assertCurrent, deadlineMs } = options
  if (!compressed) {
    return extractAndVerifyEventLiteral({ fd, row, formatError, staleError, extractPart })
  }
  if (row.type === 'UNAVAILABLE') {
    const limitation = row.errorKind ?? 'RECORD_TOO_LARGE'
    const expectedDigest = digest(JSON.stringify(['UNAVAILABLE', limitation, row.lineStart, row.lineEnd]))
    if (expectedDigest !== row.payloadDigest) throw new Error(staleError)
    return { content: '', sanitized: false, unavailable: true, limitation }
  }
  const lineBuf = await readZstdLogicalRange({
    fd,
    fileSize,
    nativeKey,
    fileIdentity,
    lineStart: row.lineStart,
    lineEnd: row.lineEnd,
    staleError,
    formatError,
    assertCurrent,
    deadlineMs
  })
  let record: unknown
  try {
    record = JSON.parse(utf8Decoder.decode(lineBuf))
  } catch {
    throw new Error(formatError)
  }
  if (row.type === 'OPAQUE') {
    const safeFields = extractOpaqueSafeMetadata(record)
    if (digest(JSON.stringify(safeFields)) !== row.payloadDigest) throw new Error(staleError)
    return {
      content: '',
      sanitized: true,
      opaque: true,
      limitation: row.errorKind ?? 'UNRECOGNIZED_FORMAT',
      safeFields
    }
  }
  const rawText = extractPart(record, row.partIndex)
  if (rawText === undefined) throw new Error(staleError)
  const content = sanitize(rawText)
  if (digest(content) !== row.payloadDigest || Buffer.byteLength(content) !== row.bytes) {
    throw new Error(staleError)
  }
  return { content, sanitized: content !== rawText }
}

export function findFtsMatchOffset(content: string, queryText: string, mode: 'ALL_TERMS' | 'PHRASE' = 'ALL_TERMS'): number | undefined {
  const trimmed = queryText.trim()
  if (!trimmed) return undefined
  let db: Database.Database | undefined
  try {
    db = new Database(':memory:')
    db.exec("CREATE VIRTUAL TABLE mem_fts USING fts5(body, tokenize='unicode61 remove_diacritics 2')")
    db.prepare('INSERT INTO mem_fts(rowid, body) VALUES (1, ?)').run(content)
    let matchExpr = `"${trimmed.replaceAll('"', '""')}"`
    let match = db.prepare("SELECT highlight(mem_fts, 0, char(1), char(2)) AS hl FROM mem_fts WHERE mem_fts MATCH ?").get(matchExpr) as { hl: string } | undefined
    if (!match && mode !== 'PHRASE') {
      const tokens = trimmed.split(/\s+/).map(t => t.replaceAll(/["*^:{}()]/g, '')).filter(Boolean)
      if (tokens.length) {
        matchExpr = tokens.map(t => `"${t}"`).join(' ')
        match = db.prepare("SELECT highlight(mem_fts, 0, char(1), char(2)) AS hl FROM mem_fts WHERE mem_fts MATCH ?").get(matchExpr) as { hl: string } | undefined
      }
    }
    if (match && typeof match.hl === 'string') {
      const idx = match.hl.indexOf('\x01')
      if (idx >= 0) {
        const prefix = match.hl.slice(0, idx)
        return Buffer.byteLength(prefix)
      }
    }
    return undefined
  } catch {
    return undefined
  } finally {
    try { db?.close() } catch {}
  }
}

export function readEventLiteralSlice(options: {
  content: string
  sanitized: boolean
  eventId: string
  payloadDigest: string
  offset: number
  budget: number
  base: Record<string, unknown>
  nextCursor: (end: number) => string
  fits: (payload: object, budget: number, strict?: boolean) => boolean
  queryText?: string
  mode?: 'ALL_TERMS' | 'PHRASE'
}) {
  const { content, sanitized, eventId, payloadDigest, offset, budget, base, nextCursor, fits, queryText, mode } = options
  const raw = Buffer.from(content)
  let effectiveOffset = offset
  if (effectiveOffset === 0 && queryText) {
    const matchOffset = findFtsMatchOffset(content, queryText, mode)
    if (matchOffset !== undefined) {
      let candidateStart = Math.max(0, matchOffset - 1024)
      while (candidateStart > 0 && (raw[candidateStart] & 0xc0) === 0x80) {
        candidateStart--
      }
      effectiveOffset = candidateStart
    }
  }
  if (effectiveOffset > raw.length || (effectiveOffset < raw.length && (raw[effectiveOffset] & 0xc0) === 0x80)) {
    throw new Error('CURSOR_STALE')
  }
  for (let size = 8192; size >= 4; size = Math.floor(size / 2)) {
    const slice = utf8Prefix(raw.subarray(effectiveOffset).toString('utf8'), size)
    const end = effectiveOffset + Buffer.byteLength(slice)
    const result = {
      ...base,
      eventId,
      content: slice,
      range: { startByte: effectiveOffset, endByte: end },
      payloadDigest,
      provenance: 'OBSERVED_FROM_PROVIDER',
      omission: null,
      sanitized,
      complete: end === raw.length,
      partial: end < raw.length,
      ...(end < raw.length ? { nextCursor: nextCursor(end) } : {})
    }
    if (fits(result, budget, true)) return result
  }
  throw new Error('RESPONSE_LIMIT_REACHED')
}

export async function searchIndexedNativeEventsAsync(options: Parameters<typeof searchIndexedNativeEvents>[0] & {
  fileSize?: number
  fileIdentity?: string
  compressed?: boolean
}) {
  if (!options.compressed || options.fileSize === undefined || !options.fileIdentity) {
    return searchIndexedNativeEvents(options)
  }
  const { refs, nativeKey, revision, filters, query, matchOffset, limit, fd, fileSize, fileIdentity, formatError, staleError, extractPart, assertCurrent } = options
  const batchSize = 100
  const maxScan = 50_000
  const deadlineMs = options.deadlineMs ?? (Date.now() + 4000)
  let sqlOffset = 0
  let matchedSeen = 0
  let scanned = 0
  let truncated = false
  const items: Array<ReturnType<typeof toNativeEventMeta> & { match: { startByte: number } }> = []

  for (;;) {
    assertCurrent()
    if (scanned >= maxScan || Date.now() >= deadlineMs) {
      truncated = true
      break
    }
    const batch = refs.pageEvents(nativeKey, revision, filters, sqlOffset, batchSize)
    if (!batch.length) break
    sqlOffset += batch.length
    for (const row of batch) {
      assertCurrent()
      scanned++
      if (row.type === 'OPAQUE' || row.type === 'UNAVAILABLE') continue
      const { content } = await extractAndVerifyEventLiteralAsync({
        fd, fileSize, nativeKey, fileIdentity, compressed: true, row, formatError, staleError, extractPart, assertCurrent, deadlineMs
      })
      const pos = content.indexOf(query)
      if (pos >= 0) {
        if (matchedSeen >= matchOffset) {
          items.push({ ...toNativeEventMeta(row), match: { startByte: Buffer.byteLength(content.slice(0, pos)) } })
          if (items.length >= limit + 1) return { items, truncated: false }
        }
        matchedSeen++
      }
      if (scanned >= maxScan || Date.now() >= deadlineMs) {
        truncated = true
        break
      }
    }
    if (batch.length < batchSize) break
  }
  return { items, truncated, ...(truncated ? {} : { totalMatched: matchedSeen }) }
}

export function searchIndexedNativeEvents(options: {
  refs: NativeSessionReferences
  nativeKey: string
  revision: number
  filters: NativeEventFilter
  query: string
  matchOffset: number
  limit: number
  fd: number
  formatError: string
  staleError: string
  extractPart: (record: unknown, partIndex: number) => string | undefined
  assertCurrent: () => void
  deadlineMs?: number
}): {
  items: Array<ReturnType<typeof toNativeEventMeta> & { match: { startByte: number } }>
  truncated: boolean
  totalMatched?: number
} {
  const { refs, nativeKey, revision, filters, query, matchOffset, limit, fd, formatError, staleError, extractPart, assertCurrent } = options
  const batchSize = 100
  const maxScan = 50_000
  const deadlineMs = options.deadlineMs ?? (Date.now() + 4000)
  let sqlOffset = 0
  let matchedSeen = 0
  let scanned = 0
  let truncated = false
  const items: Array<ReturnType<typeof toNativeEventMeta> & { match: { startByte: number } }> = []

  for (;;) {
    assertCurrent()
    if (scanned >= maxScan || (deadlineMs !== undefined && Date.now() >= deadlineMs)) {
      truncated = true
      break
    }
    const batch = refs.pageEvents(nativeKey, revision, filters, sqlOffset, batchSize)
    if (!batch.length) break
    sqlOffset += batch.length
    for (const row of batch) {
      assertCurrent()
      scanned++
      if (row.type === 'OPAQUE' || row.type === 'UNAVAILABLE') continue
      const { content } = extractAndVerifyEventLiteral({ fd, row, formatError, staleError, extractPart })
      const pos = content.indexOf(query)
      if (pos >= 0) {
        if (matchedSeen >= matchOffset) {
          items.push({ ...toNativeEventMeta(row), match: { startByte: Buffer.byteLength(content.slice(0, pos)) } })
          if (items.length >= limit + 1) return { items, truncated: false }
        }
        matchedSeen++
      }
      if (scanned >= maxScan || (deadlineMs !== undefined && Date.now() >= deadlineMs)) {
        truncated = true
        break
      }
    }
    if (batch.length < batchSize) break
  }
  return { items, truncated, ...(truncated ? {} : { totalMatched: matchedSeen }) }
}

export function verifyStaticSourceBeforeClose(
  fd: number,
  path: string,
  expectedIdentity: string,
  assertPath: () => void,
  configUnchanged: () => boolean,
  assertCurrent: () => void,
  staleError = 'SOURCE_REVISION_CHANGED'
): void {
  assertPath()
  assertCurrent()
  try {
    if (
      fileIdentityOf(fstatSync(fd, { bigint: true })) !== expectedIdentity ||
      fileIdentityOf(lstatSync(path, { bigint: true })) !== expectedIdentity ||
      !configUnchanged()
    ) {
      throw new Error(staleError)
    }
  } catch (error) {
    if (error instanceof Error && error.message === staleError) throw error
    throw new Error(staleError)
  }
}
