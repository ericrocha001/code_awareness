import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { sourceTimestamp as timestamp, compareSourceTime } from './source-time'
import { LIMITS, type EventInput, type EventType, type SourceObservation, type CoverageReason, type CoverageReasons } from './types'

type RecordValue = Record<string, unknown>
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

export class CodexParser {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private skipping = false
  private position = 0
  private hash = createHash('sha256')
  private retainedBytes = 0
  private readonly toolsByCall = new Map<string, string>()
  readonly events: EventInput[] = []
  readonly coverageReasons: CoverageReasons = {}
  private identityIncomplete = false
  private partialReason(reason: CoverageReason): void {
    this.partial = true
    if (reason === 'INVALID_RECORD' || reason === 'LINE_LIMIT' || reason === 'IMPORT_LIMIT' || reason === 'EVENT_LIMIT') this.identityIncomplete = true
    this.coverageReasons[reason] = (this.coverageReasons[reason] ?? 0) + 1
  }
  partial = false
  bytes = 0
  sessionId?: string
  cwd?: string
  startedAt?: string
  identityConflict = false
  identityUnavailable = false
  private firstTimestamp?: string
  private lastTimestamp?: string
  private timestampedRecords = 0
  private missingTimestamps = 0
  private invalidTimestamps = 0
  private declaredCwd?: string
  constructor(private readonly canonicalCwd: (cwd: string) => string = cwd => cwd) {}
  private observeIdentity(id: unknown, cwd?: unknown, cwdRequired = false): void {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id)) this.identityUnavailable = true
    else if (this.sessionId === undefined) this.sessionId = id
    else if (this.sessionId !== id) this.identityConflict = true
    if (cwd === undefined && !cwdRequired) return
    if (typeof cwd !== 'string' || !cwd || cwd.length > 32768) { this.identityUnavailable = true; return }
    if (this.identityConflict || cwd === this.declaredCwd) return
    try {
      const canonical = this.canonicalCwd(cwd)
      if (this.cwd === undefined) { this.cwd = canonical; this.declaredCwd = cwd }
      else if (this.cwd !== canonical) this.identityConflict = true
    } catch { this.identityUnavailable = true }
  }
  observation(startedAt?: string, endedAt?: string): SourceObservation {
    const start = timestamp(startedAt), end = timestamp(endedAt)
    let windowRelation: SourceObservation['streamTime']['windowRelation'] = 'UNAVAILABLE'
    if (this.firstTimestamp && this.lastTimestamp) {
      if ((start && compareSourceTime(this.firstTimestamp, start) < 0) || (end && compareSourceTime(this.lastTimestamp, end) > 0)) windowRelation = 'OUTSIDE_PROVIDER_WINDOW'
      else if (start && end && compareSourceTime(start, end) <= 0 && !this.missingTimestamps && !this.invalidTimestamps && !this.identityIncomplete) windowRelation = 'WITHIN_PROVIDER_WINDOW'
    }
    return { identity: this.sessionId && !this.identityConflict && !this.identityUnavailable && !this.identityIncomplete ? 'VERIFIED' : 'UNKNOWN',
      streamTime: { first: this.firstTimestamp, last: this.lastTimestamp, timestampedRecords: this.timestampedRecords,
        missingTimestamps: this.missingTimestamps, invalidTimestamps: this.invalidTimestamps, windowRelation } }
  }
  push(chunk: Buffer): boolean {
    if (this.bytes + chunk.length > LIMITS.import) { this.partialReason('IMPORT_LIMIT'); return false }
    this.bytes += chunk.length; this.hash.update(chunk)
    const text = this.decoder.write(chunk)
    for (const part of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const newline = part.endsWith('\n')
      if (!this.skipping) {
        if (Buffer.byteLength(this.pending) + Buffer.byteLength(part) > 256 * 1024) { this.pending = ''; this.skipping = true; this.partialReason('LINE_LIMIT') }
        else this.pending += part
      }
      if (newline) {
        this.position++
        if (!this.skipping) this.line(this.pending.trim())
        this.pending = ''; this.skipping = false
      }
      if (this.events.length >= LIMITS.events) { this.partialReason('EVENT_LIMIT'); return false }
    }
    return true
  }
  finish() {
    this.pending += this.decoder.end()
    if (this.pending.trim() && !this.skipping) { this.position++; this.line(this.pending.trim()) }
    return { events: this.events, coverage: this.partial ? 'PARTIAL' as const : 'COMPLETE' as const, sourceDigest: this.hash.digest('hex'), sourceBytes: this.bytes, coverageReasons: { ...this.coverageReasons } }
  }
  private line(text: string): void {
    if (!text) return
    let row: RecordValue
    try { row = object(JSON.parse(text)) } catch { this.partialReason('INVALID_RECORD'); return }
    if (typeof row.type !== 'string') { this.partialReason('INVALID_RECORD'); return }
    const payload = object(row.payload), item = object(row.item)
    const rawTime = Object.hasOwn(row, 'timestamp') ? row.timestamp : row.type === 'session_meta' ? payload.timestamp : undefined
    const observedTime = timestamp(rawTime)
    if (observedTime) {
      this.timestampedRecords++
      if (!this.firstTimestamp || compareSourceTime(observedTime, this.firstTimestamp) < 0) this.firstTimestamp = observedTime
      if (!this.lastTimestamp || compareSourceTime(observedTime, this.lastTimestamp) > 0) this.lastTimestamp = observedTime
    } else if (rawTime === undefined) this.missingTimestamps++
    else this.invalidTimestamps++
    if (row.type === 'session_meta') {
      this.observeIdentity(payload.id, payload.cwd, true)
      this.startedAt ??= timestamp(payload.timestamp ?? row.timestamp)
      return
    }
    if (row.type === 'thread.started') { this.observeIdentity(row.thread_id); return }
    if (['turn_context', 'turn.started', 'turn.completed'].includes(row.type)) return
    let type: EventType = 'OTHER', tool: string | undefined, body: string | undefined, success: boolean | undefined
    let files: string[] = []
    const p = row.type === 'response_item' || row.type === 'event_msg' ? payload : item
    const kind = string(p.type)
    if (row.type === 'response_item') {
      if (kind === 'reasoning') return
      if (kind === 'message') {
        if (!['user', 'assistant'].includes(String(p.role))) return
        type = p.role === 'user' ? 'INPUT' : 'AGENT_UPDATE'
        body = Array.isArray(p.content) ? p.content.map(object).filter(part => ['input_text', 'output_text'].includes(String(part.type))).map(part => string(part.text) ?? '').join('\n') : undefined
      } else if (['function_call', 'custom_tool_call', 'local_shell_call'].includes(kind ?? '')) {
        type = 'TOOL_CALL'; tool = string(p.name) ?? (kind === 'local_shell_call' ? 'shell' : undefined)
        body = string(p.arguments) ?? string(p.input) ?? (p.action ? JSON.stringify(p.action) : undefined)
        const call = string(p.call_id)
        if (call && call.length <= 200 && tool && tool.length <= 80) this.toolsByCall.set(call, tool)
      } else if (['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'].includes(kind ?? '')) {
        type = 'TOOL_RESULT'; body = string(p.output); tool = this.toolsByCall.get(String(p.call_id))
      } else { this.partialReason('UNKNOWN_RECORD'); return }
    } else if (row.type === 'event_msg') {
      if (kind === 'agent_reasoning' || kind === 'token_count' || kind === 'task_started' || kind === 'task_complete') return
      if (kind === 'user_message') { type = 'INPUT'; body = string(p.message) }
      else if (kind === 'agent_message') { type = 'AGENT_UPDATE'; body = string(p.message) }
      else if (kind === 'error') { type = 'ERROR'; body = string(p.message); success = false }
      else if (kind === 'item_completed' && object(p.item).type === 'file_change') {
        const change = object(p.item); type = 'CHANGE'; files = Object.keys(object(change.changes)); body = JSON.stringify(change)
        success = change.status === 'completed' ? true : change.status === 'failed' ? false : undefined
      } else { this.partialReason('UNKNOWN_RECORD'); return }
    } else if (row.type === 'error' || row.type === 'turn.failed') {
      type = 'ERROR'; body = string(row.message) ?? string(object(row.error).message); success = false
    } else if (row.type === 'item.started' || row.type === 'item.completed') {
      if (kind === 'reasoning') return
      if (kind === 'agent_message') { type = 'AGENT_UPDATE'; body = string(p.text) }
      else if (kind === 'command_execution' || kind === 'mcp_tool_call') {
        type = row.type === 'item.started' ? 'TOOL_CALL' : 'TOOL_RESULT'
        tool = kind === 'command_execution' ? 'shell' : string(p.tool)
        body = row.type === 'item.started' ? string(p.command) ?? JSON.stringify(p.arguments ?? {}) : string(p.aggregated_output) ?? JSON.stringify(p.result ?? {})
        if (typeof p.exit_code === 'number') success = p.exit_code === 0
        else if (p.status === 'failed') success = false
      } else if (kind === 'file_change') {
        type = 'CHANGE'; files = Array.isArray(p.changes) ? p.changes.map(object).map(entry => string(entry.path)).filter((path): path is string => !!path) : []
        body = JSON.stringify(p.changes ?? []); success = p.status === 'completed' ? true : p.status === 'failed' ? false : undefined
      } else { this.partialReason('UNKNOWN_RECORD'); return }
    } else { this.partialReason('UNKNOWN_RECORD'); return }
    if (type === 'TOOL_CALL' && tool === 'apply_patch' && body) files = [...body.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => match[1])
    if (type === 'TOOL_RESULT' && body) {
      const exit = body.match(/Process exited with code (\d+)/)
      if (exit) success = exit[1] === '0'
    }
    if (success === false) type = 'ERROR'
    // Keep an envelope after the session's parser budget is exhausted, without retaining more literal text.
    const bytes = Buffer.byteLength(body ?? '')
    let omission: EventInput['omission']
    if (this.retainedBytes + bytes > LIMITS.session + 256 * 1024) { body = undefined; omission = 'LIMIT_REACHED'; this.partial = true }
    else this.retainedBytes += bytes
    this.events.push({ type, text: body, timestamp: timestamp(row.timestamp), tool, success, files, sourcePosition: this.position, omission })
  }
}
