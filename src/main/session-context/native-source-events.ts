import { sanitize } from './privacy'
import type { EventType } from './types'

export type NativeSourceEventType = Extract<EventType, 'INPUT' | 'AGENT_UPDATE' | 'TOOL_CALL' | 'TOOL_RESULT' | 'ERROR'>
export type AttemptStatus = 'SUCCESS' | 'FAILURE' | 'REFUSAL' | 'DANGLING' | 'UNKNOWN'
export type PairingState = 'PAIRED' | 'DANGLING' | 'UNPAIRED' | 'NO_NATIVE_CALL_PAIR_ID'

export interface NativeSourceEvent {
  eventId: string
  ordinal: number
  type: NativeSourceEventType
  timestamp?: string
  tool?: string
  turnId?: string
  status?: AttemptStatus
  pairing?: PairingState
  errorKind?: string
  bytes: number
  payloadDigest: string
  content: string
  sanitized: boolean
}

export interface NativeSourceAttemptRef {
  eventId: string
  ordinal: number
  timestamp?: string
  tool?: string
  turnId?: string
  status: AttemptStatus
  errorKind?: string
  pairing: PairingState
  resultEventId?: string
}

export function validTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined
}

export function extractTextValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const item of value) {
      if (item && typeof item === 'object' && 'text' in item && typeof (item as { text: unknown }).text === 'string') {
        parts.push((item as { text: string }).text)
      }
    }
    return parts.join('\n')
  }
  if (value !== undefined && value !== null) return JSON.stringify(value)
  return ''
}

export function classifyStructuredOutput(rawText: string): { isError: boolean; status: AttemptStatus; errorKind?: string } {
  const trimmed = rawText.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const code = typeof parsed.code === 'string' && /^[A-Za-z0-9_:-]{1,64}$/.test(parsed.code) ? parsed.code : undefined
      const meta = parsed.metadata && typeof parsed.metadata === 'object' ? parsed.metadata as Record<string, unknown> : undefined
      const exitCode = meta && typeof meta.exit_code === 'number' ? meta.exit_code : undefined
      if (parsed.isError === true || parsed.status === 'FAILED' || parsed.status === 'ERROR' ||
        (typeof parsed.error === 'string' && parsed.error.length > 0) ||
        (exitCode !== undefined && exitCode !== 0) ||
        (code && /^[A-Z_]{3,64}$/.test(code) && Object.keys(parsed).length <= 6 && !('content' in parsed))) {
        const errorKind = code ?? (exitCode !== undefined ? 'NON_ZERO_EXIT' : 'TOOL_ERROR')
        const refusal = /(?:DENIED|REJECTED|UNAUTHORIZED|REFUSED|BLOCKED|ABORTED)/i.test(errorKind)
        return { isError: true, status: refusal ? 'REFUSAL' : 'FAILURE', errorKind }
      }
    } catch {}
  }
  if (/^(?:Chunk ID:[^\n]*\n)?(?:Wall time:[^\n]*\n)?Process exited with code [1-9]\d*/m.test(rawText) || /^Exit code:\s*[1-9]\d*/m.test(rawText)) {
    return { isError: true, status: 'FAILURE', errorKind: 'NON_ZERO_EXIT' }
  }
  return { isError: false, status: 'SUCCESS' }
}

export function buildSourceSummary(events: NativeSourceEvent[], attempts: NativeSourceAttemptRef[], attemptCoverage: string) {
  const typeCounts = new Map<NativeSourceEventType, number>()
  const toolCounts = new Map<string, number>()
  const turns = new Map<string, { id: string; firstObserved: string; lastObserved: string; eventCount: number }>()
  let timestampedEvents = 0, missingTimestamps = 0
  for (const event of events) {
    typeCounts.set(event.type, (typeCounts.get(event.type) ?? 0) + 1)
    if (event.tool) toolCounts.set(event.tool, (toolCounts.get(event.tool) ?? 0) + 1)
    if (event.timestamp) {
      timestampedEvents++
      if (event.turnId) {
        const prev = turns.get(event.turnId)
        turns.set(event.turnId, {
          id: event.turnId,
          firstObserved: prev && prev.firstObserved < event.timestamp ? prev.firstObserved : event.timestamp,
          lastObserved: prev && prev.lastObserved > event.timestamp ? prev.lastObserved : event.timestamp,
          eventCount: (prev?.eventCount ?? 0) + 1
        })
      }
    } else {
      missingTimestamps++
      if (event.turnId && !turns.has(event.turnId)) {
        turns.set(event.turnId, { id: event.turnId, firstObserved: '', lastObserved: '', eventCount: 1 })
      } else if (event.turnId) {
        turns.get(event.turnId)!.eventCount++
      }
    }
  }
  const allErrors = events
    .filter(e => e.type === 'ERROR')
    .map(e => ({
      eventId: e.eventId,
      ordinal: e.ordinal,
      ...(e.timestamp ? { timestamp: e.timestamp } : {}),
      ...(e.tool ? { tool: e.tool } : {}),
      ...(e.turnId ? { turnId: e.turnId } : {}),
      ...(e.status ? { status: e.status } : {}),
      ...(e.errorKind ? { errorKind: e.errorKind } : {})
    }))
  const dangling = attempts
    .filter(a => a.status === 'DANGLING')
    .map(a => ({
      eventId: a.eventId,
      ordinal: a.ordinal,
      ...(a.timestamp ? { timestamp: a.timestamp } : {}),
      ...(a.tool ? { tool: a.tool } : {}),
      ...(a.turnId ? { turnId: a.turnId } : {}),
      pairing: a.pairing
    }))
  const counts = {
    total: attempts.length,
    success: attempts.filter(a => a.status === 'SUCCESS').length,
    failure: attempts.filter(a => a.status === 'FAILURE').length,
    refusal: attempts.filter(a => a.status === 'REFUSAL').length,
    dangling: dangling.length,
    unknown: attempts.filter(a => a.status === 'UNKNOWN').length
  }
  return {
    sourceTypeCounts: [...typeCounts.entries()].map(([type, count]) => ({ type, count })),
    sourceTools: [...toolCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([tool, count]) => ({ tool, count })),
    attemptSummary: { ...counts, attemptCoverage },
    errors: allErrors.slice(0, 5),
    omittedErrors: Math.max(0, allErrors.length - 5),
    danglingCalls: dangling.slice(0, 5),
    omittedDanglingCalls: Math.max(0, dangling.length - 5),
    turns: [...turns.values()],
    timeCoverage: { timestampedEvents, missingTimestamps }
  }
}

export function filterSourceEvents(events: NativeSourceEvent[], options: {
  types?: string[]; tool?: string; turnId?: string; after?: string; before?: string; file?: string; query?: string
}) {
  if (options.file) return []
  const afterMs = options.after ? Date.parse(options.after) : undefined
  const beforeMs = options.before ? Date.parse(options.before) : undefined
  const projected: Array<Omit<NativeSourceEvent, 'content'> & { match?: { startByte: number } }> = []
  for (const { content, ...meta } of events) {
    if (options.types?.length && !options.types.includes(meta.type)) continue
    if (options.tool && meta.tool !== options.tool) continue
    if (options.turnId && meta.turnId !== options.turnId) continue
    if (afterMs !== undefined || beforeMs !== undefined) {
      if (!meta.timestamp) continue
      const ts = Date.parse(meta.timestamp)
      if (!Number.isFinite(ts)) continue
      if (afterMs !== undefined && ts < afterMs) continue
      if (beforeMs !== undefined && ts > beforeMs) continue
    }
    if (options.query) {
      const searchable = meta.sanitized ? content : sanitize(content)
      const pos = searchable.indexOf(options.query)
      if (pos < 0) continue
      projected.push({ ...meta, match: { startByte: Buffer.byteLength(searchable.slice(0, pos)) } })
    } else {
      projected.push(meta)
    }
  }
  return projected
}
