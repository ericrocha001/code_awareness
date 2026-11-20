import { closeSync, fstatSync, lstatSync, openSync, readSync, constants, type BigIntStats } from 'node:fs'
import { createHash } from 'node:crypto'
import { digest, sanitize, utf8Prefix } from './privacy'
import {
  toNativeEventMeta,
  type NativeAttemptSummary,
  type NativeEventFilter,
  type NativeIndexedDiagnosticRef,
  type NativeIndexedEventRow,
  type NativeSessionReferences,
  type NativeSourceRecordSummary
} from './native-session-references'
import type { NativeSourceEventType } from './native-source-events'

export const NATIVE_LINE_MAX_BYTES = 512 * 1024
export const NATIVE_IO_CHUNK_BYTES = 64 * 1024
export const NATIVE_PREFIX_WINDOW = 4096
export const NATIVE_TAIL_WINDOW = 512
export const DEFAULT_NATIVE_STEP_BYTES = 2 * 1024 * 1024
export const DEFAULT_NATIVE_STEP_LINES = 10_000
export const DEFAULT_NATIVE_ONDEMAND_BYTES = 512 * 1024

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

export interface NativeStepBudget {
  maxBytes?: number
  maxLines?: number
  deadlineMs?: number
  onDemandMaxBytes?: number
}

export interface NativeIndexerState {
  ordinal: number
  seq: number
  omittedRecords: number
  currentTurnId?: string
  typeCounts: Record<string, number>
  toolStats: Record<string, number>
  attemptCounts: { total: number; success: number; failure: number; refusal: number; dangling: number; unknown: number }
  attemptCoverage: string
  errors: NativeIndexedDiagnosticRef[]
  totalErrors: number
  openCalls: Record<string, NativeIndexedDiagnosticRef>
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

export function sameFileDeviceInode(a: string, b: string): boolean {
  const pa = a.split(':'), pb = b.split(':')
  return pa.length >= 2 && pb.length >= 2 && pa[0] === pb[0] && pa[1] === pb[1]
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

export function digestFdRange(fd: number, start: number, length: number, staleError = 'SOURCE_REVISION_CHANGED'): string {
  if (length <= 0) return digest('')
  const hash = createHash('sha256')
  const buf = Buffer.allocUnsafe(Math.min(length, NATIVE_IO_CHUNK_BYTES))
  let pos = 0
  while (pos < length) {
    const toRead = Math.min(buf.length, length - pos)
    const n = readSync(fd, buf, 0, toRead, start + pos)
    if (n <= 0) throw new Error(staleError)
    hash.update(buf.subarray(0, n))
    pos += n
  }
  return hash.digest('hex')
}

export function computePrefixTailDigests(fd: number, indexedOffset: number, staleError = 'SOURCE_REVISION_CHANGED'): {
  prefixDigest: string
  tailDigest: string
} {
  const prefixDigest = digestFdRange(fd, 0, Math.min(indexedOffset, NATIVE_PREFIX_WINDOW), staleError)
  const tailStart = Math.max(0, indexedOffset - NATIVE_TAIL_WINDOW)
  const tailDigest = indexedOffset > 0 ? digestFdRange(fd, tailStart, indexedOffset - tailStart, staleError) : digest('')
  return { prefixDigest, tailDigest }
}

export function verifyAppendContinuity(
  fd: number,
  fileSize: number,
  prefixDigest: string,
  tailOffset: number,
  tailDigest: string,
  staleError = 'SOURCE_REVISION_CHANGED'
): 'EXACT' | 'APPENDED' | 'DRIFT' {
  if (tailOffset < 0 || tailOffset > fileSize) return 'DRIFT'
  const currentPrefix = digestFdRange(fd, 0, Math.min(tailOffset, NATIVE_PREFIX_WINDOW), staleError)
  if (currentPrefix !== prefixDigest) return 'DRIFT'
  if (tailOffset > 0) {
    const tailStart = Math.max(0, tailOffset - NATIVE_TAIL_WINDOW)
    const currentTail = digestFdRange(fd, tailStart, tailOffset - tailStart, staleError)
    if (currentTail !== tailDigest) return 'DRIFT'
  }
  return fileSize === tailOffset ? 'EXACT' : 'APPENDED'
}

export interface StepAccumulator {
  state: NativeIndexerState
  events: NativeIndexedEventRow[]
  pairUpdates: Array<{ eventId: string; status: string; pairing: string }>
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
    partIndex: input.part
  }
  acc.events.push(row)
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
}, state: NativeIndexerState): NativeSourceRecordSummary {
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
    eventCount: state.seq,
    omittedRecords: state.omittedRecords,
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

export function stateFromSummary(summary: NativeSourceRecordSummary): NativeIndexerState {
  const typeCounts: Record<string, number> = {}
  for (const entry of summary.sourceTypeCounts) typeCounts[entry.type] = entry.count
  const toolStats: Record<string, number> = {}
  for (const entry of summary.sourceTools) toolStats[entry.tool] = entry.count
  const openCalls = JSON.parse(summary.openCallsJson || '{}') as Record<string, NativeIndexedDiagnosticRef>
  const openIds = new Set(Object.values(openCalls).map(o => o.eventId))
  return {
    ordinal: summary.lastOrdinal,
    seq: summary.eventCount,
    omittedRecords: summary.omittedRecords,
    ...(summary.currentTurnId ? { currentTurnId: summary.currentTurnId } : {}),
    typeCounts,
    toolStats,
    attemptCounts: {
      total: summary.attemptSummary.total,
      success: summary.attemptSummary.success,
      failure: summary.attemptSummary.failure,
      refusal: summary.attemptSummary.refusal,
      dangling: summary.attemptSummary.dangling,
      unknown: summary.attemptSummary.unknown
    },
    attemptCoverage: summary.attemptCoverage,
    errors: [...summary.errors],
    totalErrors: summary.errors.length + summary.omittedErrors,
    openCalls,
    unmatchedDangling: summary.danglingCalls.filter(d => !openIds.has(d.eventId)),
    turns: {},
    turnOrder: summary.turnCount,
    timestampedEvents: summary.timeCoverage.timestampedEvents,
    missingTimestamps: summary.timeCoverage.missingTimestamps
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
}

export type NativeReferenceStepResult =
  | {
      status: 'READY'
      nativeKey: string
      summary: NativeSourceRecordSummary
      liveFingerprint: string
    }
  | {
      status: 'INDEXING_PENDING'
      nativeKey: string
      indexedBytes: number
      totalBytes: number
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
  makeEventId: (ordinal: number, part: number, payloadDigest: string) => string
  onReady?: (ready: { summary: NativeSourceRecordSummary; nativeKey: string; liveFingerprint: string; fd: number }) => void
}): NativeReferenceStepResult {
  const {
    refs, nativeKey, provider, repositoryId, worktreeId, generation, sourceSessionId,
    normalizer, sourceCoverage, attemptCoverage, formatError, staleError,
    mode, stepBudget, assertCurrent, openHandle, processRecord, makeEventId, onReady
  } = options
  const handle = openHandle()
  let closed = false
  const closeOnce = () => { if (!closed) { closed = true; closeSync(handle.fd) } }
  try {
    const existing = refs.getSummary(nativeKey)
    if (
      existing &&
      existing.locatorHash === handle.locatorHash &&
      existing.normalizer === normalizer &&
      sameFileDeviceInode(existing.fileIdentity, handle.identity)
    ) {
      const continuity = verifyAppendContinuity(
        handle.fd, handle.sizeBytes, existing.prefixDigest, existing.tailOffset, existing.tailDigest, staleError
      )
      if (continuity === 'EXACT' && existing.fileIdentity === handle.identity) {
        onReady?.({ summary: existing, nativeKey, liveFingerprint: handle.liveFingerprint, fd: handle.fd })
        verifyStaticSourceBeforeClose(handle.fd, handle.path, handle.identity, handle.assertPath, handle.configUnchanged, assertCurrent, staleError)
        closeOnce()
        handle.verifyAfterClose?.()
        return { status: 'READY', nativeKey, summary: existing, liveFingerprint: handle.liveFingerprint }
      }
      if (continuity === 'DRIFT' && mode !== 'READ_ONLY') {
        refs.invalidate(nativeKey)
      }
    } else if (existing && mode !== 'READ_ONLY') {
      refs.invalidate(nativeKey)
    }

    if (mode === 'READ_ONLY') {
      return {
        status: 'INDEXING_PENDING',
        nativeKey,
        indexedBytes: existing?.indexedBytes ?? 0,
        totalBytes: handle.sizeBytes,
        indexedEvents: existing?.eventCount ?? 0,
        liveFingerprint: handle.liveFingerprint,
        reason: 'READ_ONLY_STORE'
      }
    }

    const freshExisting = refs.getSummary(nativeKey)
    let checkpoint = refs.getCheckpoint(nativeKey)
    const checkpointValid = !!(
      checkpoint &&
      checkpoint.locatorHash === handle.locatorHash &&
      checkpoint.normalizer === normalizer &&
      sameFileDeviceInode(checkpoint.fileIdentity, handle.identity) &&
      verifyAppendContinuity(handle.fd, handle.sizeBytes, checkpoint.prefixDigest, checkpoint.nextOffset, checkpoint.tailDigest, staleError) !== 'DRIFT'
    )
    if (checkpoint && !checkpointValid) checkpoint = undefined

    const canAppendFromReady = !!(
      !checkpoint &&
      freshExisting &&
      freshExisting.locatorHash === handle.locatorHash &&
      freshExisting.normalizer === normalizer &&
      sameFileDeviceInode(freshExisting.fileIdentity, handle.identity) &&
      verifyAppendContinuity(handle.fd, handle.sizeBytes, freshExisting.prefixDigest, freshExisting.tailOffset, freshExisting.tailDigest, staleError) === 'APPENDED'
    )

    const remainingBytes = checkpoint
      ? handle.sizeBytes - checkpoint.nextOffset
      : canAppendFromReady
        ? handle.sizeBytes - freshExisting!.tailOffset
        : handle.sizeBytes
    const onDemandCap = stepBudget?.onDemandMaxBytes ?? DEFAULT_NATIVE_ONDEMAND_BYTES
    if (mode === 'ON_DEMAND' && remainingBytes > onDemandCap) {
      return {
        status: 'INDEXING_PENDING',
        nativeKey,
        indexedBytes: checkpoint ? checkpoint.nextOffset : canAppendFromReady ? freshExisting!.tailOffset : 0,
        totalBytes: handle.sizeBytes,
        indexedEvents: checkpoint ? (JSON.parse(checkpoint.stateJson) as NativeIndexerState).seq : canAppendFromReady ? freshExisting!.eventCount : 0,
        liveFingerprint: handle.liveFingerprint,
        reason: 'SOURCE_REQUIRES_INDEXING'
      }
    }

    const initialPrefixDigest = digestFdRange(handle.fd, 0, Math.min(handle.sizeBytes, NATIVE_PREFIX_WINDOW), staleError)
    if (!checkpoint) {
      if (canAppendFromReady && freshExisting) {
        const resumeState = stateFromSummary(freshExisting)
        checkpoint = refs.startAppendCheckpoint({
          nativeKey,
          baseRevision: freshExisting.revision,
          locatorHash: handle.locatorHash,
          normalizer,
          fileIdentity: handle.identity,
          prefixDigest: freshExisting.prefixDigest,
          nextOffset: freshExisting.tailOffset,
          tailDigest: freshExisting.tailDigest,
          sourceBytes: handle.sizeBytes,
          stateJson: JSON.stringify(resumeState)
        })
      } else {
        checkpoint = refs.startFreshCheckpoint({
          nativeKey,
          locatorHash: handle.locatorHash,
          normalizer,
          fileIdentity: handle.identity,
          prefixDigest: initialPrefixDigest,
          sourceBytes: handle.sizeBytes,
          stateJson: JSON.stringify(createInitialIndexerState(attemptCoverage))
        })
      }
    }

    const state = JSON.parse(checkpoint.stateJson) as NativeIndexerState
    state.turns = {}
    const acc: StepAccumulator = {
      state,
      events: [],
      pairUpdates: [],
      dirtyTurns: new Set<string>(),
      makeEventId
    }

    const effectiveStepBudget: NativeStepBudget = {
      maxBytes: stepBudget?.maxBytes ?? (mode === 'ON_DEMAND' ? Math.max(onDemandCap, DEFAULT_NATIVE_STEP_BYTES) : DEFAULT_NATIVE_STEP_BYTES),
      maxLines: stepBudget?.maxLines ?? DEFAULT_NATIVE_STEP_LINES,
      ...(stepBudget?.deadlineMs !== undefined ? { deadlineMs: stepBudget.deadlineMs } : {})
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
        onRecord: (record, lineStart, lineEnd) => processRecord(record, lineStart, lineEnd, acc)
      })
    } catch (error) {
      refs.invalidate(nativeKey)
      throw error
    }

    verifyStaticSourceBeforeClose(handle.fd, handle.path, handle.identity, handle.assertPath, handle.configUnchanged, assertCurrent, staleError)
    const digests = computePrefixTailDigests(handle.fd, stepOut.nextOffset, staleError)

    if (stepOut.done && (!state.ordinal || !state.seq)) {
      closeOnce()
      handle.verifyAfterClose?.()
      refs.invalidate(nativeKey)
      throw new Error(state.ordinal ? 'SOURCE_CONTENT_UNAVAILABLE' : formatError)
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

    refs.saveChunk({
      nativeKey,
      revision: checkpoint.revision,
      events: acc.events,
      pairUpdates: acc.pairUpdates,
      turns: turnRows,
      nextOffset: stepOut.nextOffset,
      tailDigest: digests.tailDigest,
      sourceBytes: handle.sizeBytes,
      fileIdentity: handle.identity,
      stateJson: JSON.stringify(state)
    })

    if (!stepOut.done) {
      closeOnce()
      handle.verifyAfterClose?.()
      return {
        status: 'INDEXING_PENDING',
        nativeKey,
        indexedBytes: stepOut.nextOffset,
        totalBytes: handle.sizeBytes,
        indexedEvents: state.seq,
        liveFingerprint: handle.liveFingerprint,
        reason: 'STEP_BUDGET_REACHED'
      }
    }

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
      prefixDigest: digests.prefixDigest,
      tailOffset: stepOut.nextOffset,
      tailDigest: digests.tailDigest,
      sourceBytes: handle.sizeBytes,
      sourceCoverage
    }, state))
    onReady?.({ summary, nativeKey, liveFingerprint: handle.liveFingerprint, fd: handle.fd })
    verifyStaticSourceBeforeClose(handle.fd, handle.path, handle.identity, handle.assertPath, handle.configUnchanged, assertCurrent, staleError)
    closeOnce()
    handle.verifyAfterClose?.()
    return { status: 'READY', nativeKey, summary, liveFingerprint: handle.liveFingerprint }
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
}): { done: boolean; nextOffset: number; processedBytes: number; processedLines: number } {
  const { fd, startOffset, fileSize, formatError, stepBudget, assertCurrent, onRecord } = options
  const maxStepBytes = stepBudget?.maxBytes ?? Number.POSITIVE_INFINITY
  const maxStepLines = stepBudget?.maxLines ?? Number.POSITIVE_INFINITY
  const deadlineMs = stepBudget?.deadlineMs
  const chunkBuf = Buffer.allocUnsafe(NATIVE_IO_CHUNK_BYTES)
  let readPos = startOffset
  let lineStart = startOffset
  let pending = Buffer.alloc(0)
  let processedBytes = 0
  let processedLines = 0
  let paused = false

  while (!paused && readPos < fileSize) {
    assertCurrent()
    const toRead = Math.min(chunkBuf.length, fileSize - readPos)
    const size = readSync(fd, chunkBuf, 0, toRead, readPos)
    if (size <= 0) break
    readPos += size
    let data = pending.length ? Buffer.concat([pending, chunkBuf.subarray(0, size)]) : chunkBuf.subarray(0, size)
    let newline: number
    while ((newline = data.indexOf(10)) !== -1) {
      if (newline > NATIVE_LINE_MAX_BYTES) throw new Error('SOURCE_LIMIT_REACHED')
      const lineEnd = lineStart + newline
      let parsed: unknown
      try {
        parsed = JSON.parse(utf8Decoder.decode(data.subarray(0, newline)))
      } catch {
        throw new Error(formatError)
      }
      data = data.subarray(newline + 1)
      onRecord(parsed, lineStart, lineEnd)
      lineStart = lineEnd + 1
      processedBytes += newline + 1
      processedLines++
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
      if (data.length > NATIVE_LINE_MAX_BYTES) throw new Error('SOURCE_LIMIT_REACHED')
      pending = data.length ? Buffer.from(data) : Buffer.alloc(0)
    } else {
      pending = Buffer.alloc(0)
    }
  }

  if (!paused && pending.length > 0) throw new Error(formatError)
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
}): { content: string; sanitized: boolean } {
  const { fd, row, formatError, staleError, extractPart } = options
  const lineLen = row.lineEnd - row.lineStart
  if (lineLen < 0 || lineLen > NATIVE_LINE_MAX_BYTES) throw new Error('SOURCE_LIMIT_REACHED')
  const lineBuf = readFdExactRange(fd, row.lineStart, lineLen, staleError)
  let record: unknown
  try {
    record = JSON.parse(utf8Decoder.decode(lineBuf))
  } catch {
    throw new Error(formatError)
  }
  const rawText = extractPart(record, row.partIndex)
  if (rawText === undefined) throw new Error(staleError)
  const content = sanitize(rawText)
  if (digest(content) !== row.payloadDigest || Buffer.byteLength(content) !== row.bytes) {
    throw new Error(staleError)
  }
  return { content, sanitized: content !== rawText }
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
}) {
  const { content, sanitized, eventId, payloadDigest, offset, budget, base, nextCursor, fits } = options
  const raw = Buffer.from(content)
  if (offset > raw.length || (offset < raw.length && (raw[offset] & 0xc0) === 0x80)) {
    throw new Error('CURSOR_STALE')
  }
  for (let size = 8192; size >= 4; size = Math.floor(size / 2)) {
    const slice = utf8Prefix(raw.subarray(offset).toString('utf8'), size)
    const end = offset + Buffer.byteLength(slice)
    const result = {
      ...base,
      eventId,
      content: slice,
      range: { startByte: offset, endByte: end },
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
