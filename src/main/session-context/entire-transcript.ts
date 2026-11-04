import { parser } from 'stream-json'
import { JsonLiteralWriter } from './json-literal-writer'
import { createHash } from 'node:crypto'
import { safeFile } from './privacy'
import { sourceTimestamp } from './source-time'
import type { EventType } from './types'

export const ENTIRE_TRANSCRIPT_NORMALIZERS = { codex: 'entire-codex-jsonl-v1', antigravity: 'entire-antigravity-step-jsonl-v1', 'claude-code': 'entire-claude-jsonl-v1' } as const
export interface TranscriptField { path: string; bytes: number; digest: string; startByte: number; endByte: number; encoding: 'JSON_STRING' | 'JSON_VALUE' }
export interface TranscriptRecord { position: number; metadata: Record<string, string>; fields: TranscriptField[]; files: string[] }
export interface ReferencedEvent { type: EventType; timestamp?: string; tool?: string; success?: boolean; fields: TranscriptField[]; files: string[]; sourcePosition: number }
type Token = { name: string; value?: string | number | boolean | null }
type Frame = { path: string[]; array: boolean; index: number; key?: string }
type SourceRange = { startByte: number; endByte: number }
const directBody = /^(?:payload\/(?:arguments|input|output|message)|payload\/content\/\d+\/text|item\/(?:text|command|aggregated_output)|message\/content\/\d+\/(?:text|content)|message\/content|message|error\/message|content)$/
const jsonBody = /^(?:payload\/(?:action|item)|item\/(?:arguments|result|changes)|message\/content\/\d+\/(?:input|content)|tool_calls\/\d+\/args)$/
const metadataPath = /^(?:type|timestamp|thread_id|sessionId|cwd|created_at|source|step_index|payload\/(?:type|role|name|call_id|id|cwd|timestamp)|payload\/item\/(?:type|status)|payload\/content\/\d+\/type|item\/(?:type|tool|status|exit_code)|message\/role|message\/content\/\d+\/(?:type|name|id|tool_use_id|is_error)|tool_calls\/\d+\/name)$/

export class EntireTranscriptStream {
  private readonly tokens = parser({ jsonStreaming: true, packKeys: false, packStrings: false, packNumbers: false, streamKeys: true, streamStrings: true, streamNumbers: true })
  private readonly stack: Frame[] = []
  private metadata: Record<string, string> = {}
  private fields: TranscriptField[] = []
  private files = new Set<string>()
  private line = 1
  private recordLine = 1
  private key?: string
  private scalar?: { path: string; value: string; probe: string; field?: { hash: ReturnType<typeof createHash>; bytes: number; high: string }; file: boolean }
  private scalarRange?: SourceRange
  private composites: { path: string; depth: number; writer: JsonLiteralWriter; hash: ReturnType<typeof createHash>; bytes: number; range: SourceRange }[] = []
  private quotes: SourceRange[] = []
  private containers: SourceRange[] = []
  private openContainers: SourceRange[] = []
  private openQuote?: SourceRange
  private escaped = false
  private error?: Error
  private ended = false
  private tokenCount = 0
  peakScalarBytes = 0
  sourceBytes = 0
  private readonly hash = createHash('sha256')
  constructor(private readonly onRecord: (record: TranscriptRecord) => void, private readonly onField: (position: number, path: string, chunk: string) => void = () => {}, private readonly assertCurrent: () => void = () => {}) {
    this.tokens.on('data', (token: Token) => { try { this.token(token) } catch (error) { this.error = error instanceof Error ? error : new Error('PROVIDER_SCHEMA_UNSUPPORTED') } })
    this.tokens.on('error', () => { this.error = new Error('PROVIDER_SCHEMA_UNSUPPORTED') })
    this.tokens.on('end', () => { this.ended = true })
  }
  push(chunk: Buffer): boolean {
    this.assertCurrent()
    if (this.error) throw this.error
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index], position = this.sourceBytes + index
      if (this.openQuote) {
        if (this.escaped) this.escaped = false
        else if (byte === 92) this.escaped = true
        else if (byte === 34) { this.openQuote.endByte = position; this.openQuote = undefined }
      } else if (byte === 34) { this.openQuote = { startByte: position + 1, endByte: -1 }; this.quotes.push(this.openQuote) }
      else if (byte === 123 || byte === 91) {
        const range = { startByte: position, endByte: -1 }; this.containers.push(range); this.openContainers.push(range)
        if (this.openContainers.length > 64) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
      } else if (byte === 125 || byte === 93) {
        const range = this.openContainers.pop(); if (!range) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED'); range.endByte = position + 1
      }
    }
    this.hash.update(chunk); this.sourceBytes += chunk.length
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset), end = newline < 0 ? chunk.length : newline + 1
      this.tokens.write(chunk.subarray(offset, end))
      if (this.error) throw this.error
      if (newline >= 0) this.line++
      offset = end
    }
    return true
  }
  async finish(): Promise<{ sourceDigest: string; sourceBytes: number; peakScalarBytes: number; coverage: 'COMPLETE' }> {
    this.tokens.end()
    if (!this.ended && !this.error) await new Promise<void>(resolve => { this.tokens.once('end', resolve); this.tokens.once('error', () => resolve()) })
    if (this.error) throw this.error
    this.assertCurrent()
    return { sourceDigest: this.hash.digest('hex'), sourceBytes: this.sourceBytes, peakScalarBytes: this.peakScalarBytes, coverage: 'COMPLETE' }
  }
  private path(): string[] {
    const parent = this.stack.at(-1)
    return parent ? [...parent.path, parent.array ? String(parent.index++) : parent.key ?? ''] : []
  }
  private token(token: Token): void {
    if ((this.tokenCount++ & 1023) === 0) this.assertCurrent()
    if (this.error) return
    if (token.name === 'startKey') { this.key = ''; this.quotes.shift(); for (const field of this.composites) field.writer.write(token); return }
    if (this.key !== undefined) {
      if (token.name === 'stringChunk') {
        this.key += String(token.value)
        if (this.key.length > 512) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
      } else if (token.name === 'endKey') {
        const parent = this.stack.at(-1)
        if (!parent || parent.array) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
        if (parent.path.join('/') === 'payload/item/changes') { const file = safeFile(this.key); if (file) this.files.add(file) }
        parent.key = this.key; this.key = undefined
      }
      for (const field of this.composites) field.writer.write(token)
      return
    }
    if (token.name === 'startObject' || token.name === 'startArray') {
      const path = this.path()
      const range = this.containers.shift()
      if (!range) throw new Error('SOURCE_IDENTITY_CONFLICT')
      if (!this.stack.length) { this.recordLine = this.line; this.metadata = {}; this.fields = []; this.files.clear() }
      if (path.length > 64) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
      if (jsonBody.test(path.join('/'))) {
        const field = { path: path.join('/'), depth: this.stack.length, writer: new JsonLiteralWriter(), hash: createHash('sha256'), bytes: 0, range }
        field.writer.on('data', (value: Buffer | string) => { const text = String(value); field.hash.update(text); field.bytes += Buffer.byteLength(text); this.onField(this.recordLine, field.path, text) })
        this.composites.push(field)
      }
      for (const field of this.composites) field.writer.write(token)
      this.stack.push({ path, array: token.name === 'startArray', index: 0 })
      return
    }
    for (const field of this.composites) field.writer.write(token)
    if (token.name === 'endObject' || token.name === 'endArray') {
      this.stack.pop()
      for (const field of this.composites.filter(field => field.depth === this.stack.length)) {
        field.writer.end(); this.fields.push({ path: field.path, bytes: field.bytes, digest: field.hash.digest('hex'), ...field.range, encoding: 'JSON_VALUE' })
      }
      this.composites = this.composites.filter(field => field.depth !== this.stack.length)
      if (!this.stack.length) this.onRecord({ position: this.recordLine, metadata: this.metadata, fields: this.fields, files: [...this.files] })
      return
    }
    if (token.name === 'startString' || token.name === 'startNumber') {
      const path = this.path().join('/'), field = directBody.test(path) ? { hash: createHash('sha256'), bytes: 0, high: '' } : undefined
      this.scalarRange = token.name === 'startString' ? this.quotes.shift() : undefined
      this.scalar = { path, value: '', probe: '', field, file: /(?:^|\/)(?:path|TargetFile)$/.test(path) }
    } else if (token.name === 'stringChunk' || token.name === 'numberChunk') {
      const scalar = this.scalar
      if (!scalar) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
      const text = String(token.value)
      if (scalar.field) {
        let part = scalar.field.high + text; scalar.field.high = ''
        const last = part.charCodeAt(part.length - 1)
        if (last >= 0xd800 && last <= 0xdbff) { scalar.field.high = part.slice(-1); part = part.slice(0, -1) }
        scalar.field.hash.update(part); scalar.field.bytes += Buffer.byteLength(part); this.onField(this.recordLine, scalar.path, part)
        const probe = scalar.probe + part
        if (scalar.path === 'payload/output') {
          const exit = probe.match(/Process exited with code (\d+)\b/)
          if (exit) this.metadata['payload/output/success'] = exit[1] === '0' ? 'true' : 'false'
        }
        if (['payload/arguments', 'payload/input'].includes(scalar.path)) for (const match of probe.matchAll(/(?:^|\n)\*\*\* (?:Add|Update|Delete) File: ([^\r\n]+)(?=\r?\n)/g)) { const file = safeFile(match[1]); if (file) this.files.add(file) }
        scalar.probe = probe.slice(-4096)
      }
      if (metadataPath.test(scalar.path) || scalar.file) {
        if (scalar.value.length + text.length > 4096) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
        scalar.value += text; this.peakScalarBytes = Math.max(this.peakScalarBytes, Buffer.byteLength(scalar.value))
      }
    } else if (token.name === 'endString' || token.name === 'endNumber') {
      const scalar = this.scalar!
      if (metadataPath.test(scalar.path)) this.metadata[scalar.path] = scalar.value
      if (scalar.file) { const file = safeFile(scalar.value); if (file) this.files.add(file) }
      if (scalar.field) {
        if (scalar.field.high) { scalar.field.hash.update(scalar.field.high); scalar.field.bytes += Buffer.byteLength(scalar.field.high); this.onField(this.recordLine, scalar.path, scalar.field.high) }
        if (!this.scalarRange || this.scalarRange.endByte < 0) throw new Error('SOURCE_IDENTITY_CONFLICT')
        this.fields.push({ path: scalar.path, bytes: scalar.field.bytes, digest: scalar.field.hash.digest('hex'), ...this.scalarRange, encoding: 'JSON_STRING' })
      }
      this.scalar = undefined
    } else if (['nullValue', 'trueValue', 'falseValue'].includes(token.name)) {
      const path = this.path().join('/')
      if (metadataPath.test(path)) this.metadata[path] = String(token.value)
    }
  }
}

export function normalizeEntireRecord(agent: keyof typeof ENTIRE_TRANSCRIPT_NORMALIZERS, record: TranscriptRecord, lookupTool: (id: string, tool?: string) => string | undefined): ReferencedEvent[] {
  const m = record.metadata, type = m.type, kind = m['payload/type'] ?? m['item/type'], fields = record.fields
  const take = (...paths: string[]) => paths.flatMap(path => fields.filter(field => field.path === path))
  const event = (type: EventType, selected: TranscriptField[], tool?: string, success?: boolean): ReferencedEvent => ({ type, timestamp: sourceTimestamp(m.timestamp ?? m.created_at), tool, success, fields: selected, files: record.files, sourcePosition: record.position })
  if (agent === 'antigravity') {
    if (!['USER_INPUT', 'PLANNER_RESPONSE', 'GENERIC', 'SYSTEM_MESSAGE'].includes(type)) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
    const events = fields.filter(field => field.path === 'content').map(field => event(type === 'USER_INPUT' ? 'INPUT' : type === 'GENERIC' ? 'TOOL_RESULT' : 'AGENT_UPDATE', [field]))
    for (const field of fields.filter(field => /^tool_calls\/\d+\/args$/.test(field.path))) events.push(event('TOOL_CALL', [field], m[field.path.replace(/args$/, 'name')]))
    return events
  }
  if (agent === 'claude-code') {
    if (!['user', 'assistant', 'system', 'progress', 'file-history-snapshot', 'queue-operation', 'summary'].includes(type)) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
    if (!['user', 'assistant'].includes(type)) return []
    const events: ReferencedEvent[] = []
    if (take('message/content').length) events.push(event(type === 'user' ? 'INPUT' : 'AGENT_UPDATE', take('message/content')))
    for (const [key, value] of Object.entries(m).filter(([key]) => /^message\/content\/\d+\/type$/.test(key))) {
      const base = key.replace(/type$/, '')
      if (value === 'text') events.push(event(type === 'user' ? 'INPUT' : 'AGENT_UPDATE', take(base + 'text')))
      else if (value === 'tool_use') events.push(event('TOOL_CALL', take(base + 'input'), lookupTool(m[base + 'id'], m[base + 'name'])))
      else if (value === 'tool_result') events.push(event(m[base + 'is_error'] === 'true' ? 'ERROR' : 'TOOL_RESULT', take(base + 'content'), lookupTool(m[base + 'tool_use_id'])))
      else if (!['thinking', 'redacted_thinking', 'image'].includes(value)) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
    }
    return events
  }
  if (['session_meta', 'thread.started', 'turn_context', 'turn.started', 'turn.completed'].includes(type)) return []
  if (type === 'response_item') {
    if (kind === 'reasoning') return []
    if (kind === 'message') return ['user', 'assistant'].includes(m['payload/role']) ? [event(m['payload/role'] === 'user' ? 'INPUT' : 'AGENT_UPDATE', fields.filter(field => /^payload\/content\/\d+\/text$/.test(field.path) && ['input_text', 'output_text'].includes(m[field.path.replace(/text$/, 'type')])))] : []
    if (['function_call', 'custom_tool_call', 'local_shell_call'].includes(kind)) return [event('TOOL_CALL', take('payload/arguments', 'payload/input', 'payload/action').slice(0, 1), lookupTool(m['payload/call_id'], m['payload/name'] ?? (kind === 'local_shell_call' ? 'shell' : undefined)))]
    if (['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'].includes(kind)) return [event(m['payload/output/success'] === 'false' ? 'ERROR' : 'TOOL_RESULT', take('payload/output'), lookupTool(m['payload/call_id']), m['payload/output/success'] === undefined ? undefined : m['payload/output/success'] === 'true')]
  }
  if (type === 'event_msg') {
    if (['agent_reasoning', 'token_count', 'task_started', 'task_complete'].includes(kind)) return []
    if (['user_message', 'agent_message', 'error'].includes(kind)) return [event(kind === 'user_message' ? 'INPUT' : kind === 'error' ? 'ERROR' : 'AGENT_UPDATE', take('payload/message'), undefined, kind === 'error' ? false : undefined)]
    if (kind === 'item_completed' && m['payload/item/type'] === 'file_change') return [event('CHANGE', take('payload/item'), undefined, m['payload/item/status'] === 'completed' ? true : m['payload/item/status'] === 'failed' ? false : undefined)]
  }
  if (type === 'error' || type === 'turn.failed') return [event('ERROR', take('message', 'error/message').slice(0, 1), undefined, false)]
  if (type === 'item.started' || type === 'item.completed') {
    if (kind === 'reasoning') return []
    if (kind === 'agent_message') return [event('AGENT_UPDATE', take('item/text'))]
    if (['command_execution', 'mcp_tool_call'].includes(kind)) return [event(m['item/exit_code'] && m['item/exit_code'] !== '0' || m['item/status'] === 'failed' ? 'ERROR' : type === 'item.started' ? 'TOOL_CALL' : 'TOOL_RESULT', type === 'item.started' ? take('item/command', 'item/arguments').slice(0, 1) : take('item/aggregated_output', 'item/result').slice(0, 1), kind === 'command_execution' ? 'shell' : m['item/tool'], m['item/exit_code'] !== undefined ? m['item/exit_code'] === '0' : m['item/status'] === 'failed' ? false : undefined)]
    if (kind === 'file_change') return [event('CHANGE', take('item/changes'), undefined, m['item/status'] === 'completed' ? true : m['item/status'] === 'failed' ? false : undefined)]
  }
  throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
}
