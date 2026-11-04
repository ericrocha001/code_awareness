import { expect, it } from 'vitest'
import { digest } from './privacy'
import { EntireTranscriptStream, normalizeEntireRecord, type ReferencedEvent, type TranscriptRecord } from './entire-transcript'

async function read(agent: 'codex' | 'antigravity' | 'claude-code', values: object[], chunkSize = 7) {
  const records: TranscriptRecord[] = [], events: ReferencedEvent[] = [], text = new Map<string, string>()
  const tools = new Map<string, string>()
  const stream = new EntireTranscriptStream(record => { records.push(record); events.push(...normalizeEntireRecord(agent, record, (id, tool) => { if (id && tool) tools.set(id, tool); return tools.get(id) })) }, (position, path, chunk) => { const key = position + ':' + path; text.set(key, (text.get(key) ?? '') + chunk) })
  const source = Buffer.from(values.map(value => JSON.stringify(value)).join('\n') + '\n')
  for (let offset = 0; offset < source.length; offset += chunkSize) stream.push(source.subarray(offset, offset + chunkSize))
  const result = await stream.finish()
  return { records, events, text, result }
}
it('normalizes proven Entire native records for Codex, Antigravity CLI and Claude without provider-private discovery', async () => {
  const codex = await read('codex', [{ type: 'session_meta', payload: { id: 'same', cwd: '/fixture' } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'literal ç🙂' }] } }])
  expect(codex.events).toMatchObject([{ type: 'INPUT', sourcePosition: 2, fields: [{ path: 'payload/content/0/text', digest: digest('literal ç🙂') }] }])
  expect(codex.text.get('2:payload/content/0/text')).toBe('literal ç🙂')
  const antigravity = await read('antigravity', [{ step_index: 0, source: 'user', type: 'USER_INPUT', created_at: '2026-11-04T00:00:00Z', content: 'literal user' }, { step_index: 1, source: 'model', type: 'PLANNER_RESPONSE', content: 'literal model', tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'src/file.ts', CodeContent: 'code' } }] }])
  expect(antigravity.events.map(event => event.type)).toEqual(['INPUT', 'AGENT_UPDATE', 'TOOL_CALL'])
  expect(antigravity.text.get('2:tool_calls/0/args')).toBe('{"TargetFile":"src/file.ts","CodeContent":"code"}')
  expect(antigravity.events.at(-1)?.files).toEqual(['src/file.ts'])
  const claude = await read('claude-code', [{ type: 'user', sessionId: 'same', message: { role: 'user', content: [{ type: 'text', text: 'request' }] } }, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call', name: 'Read', input: { file_path: 'src/file.ts' } }] } }, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'tool literal' }] } }])
  expect(claude.events.map(event => [event.type, event.tool])).toEqual([['INPUT', undefined], ['TOOL_CALL', 'Read'], ['TOOL_RESULT', 'Read']])
})
it('indexes more than 20000 records without retaining their bodies and streams a single >8MiB event with bounded scalars', async () => {
  let count = 0, bytes = 0, bodyHash = '', metadataPeak = 0
  const stream = new EntireTranscriptStream(record => { const events = normalizeEntireRecord('codex', record, () => undefined); count += events.length; bodyHash = events.at(-1)?.fields[0]?.digest ?? bodyHash }, (_position, _path, text) => { bytes += Buffer.byteLength(text) })
  const small = Buffer.from('{"type":"event_msg","payload":{"type":"agent_message","message":"small"}}\n')
  for (let n = 0; n < 20001; n++) stream.push(small)
  stream.push(Buffer.from('{"type":"response_item","payload":{"type":"function_call_output","output":"'))
  const part = 'x'.repeat(65536)
  for (let n = 0; n < 145; n++) stream.push(Buffer.from(part))
  stream.push(Buffer.from('"}}\n'))
  const result = await stream.finish(); metadataPeak = result.peakScalarBytes
  expect(count).toBe(20002)
  expect(bytes).toBe(20001 * 5 + 145 * 65536)
  expect(bodyHash).toBe(digest(part.repeat(145)))
  expect(metadataPeak).toBeLessThanOrEqual(4096)
})
it('rejects malformed or unsupported formats instead of inventing events', async () => {
  await expect(read('antigravity', [{ type: 'INVENTED', content: 'not a supported format' }])).rejects.toThrow('PROVIDER_SCHEMA_UNSUPPORTED')
  const parser = new EntireTranscriptStream(() => {})
  parser.push(Buffer.from('{"type":"broken"'))
  await expect(parser.finish()).rejects.toThrow('PROVIDER_SCHEMA_UNSUPPORTED')
})
it('preserves escaped surrogate pairs and structural byte ranges across single-byte source chunks', async () => {
  const source = '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"\\uD83D\\uDE00 ç"}]}}\n'
  let field: TranscriptRecord['fields'][number] | undefined
  const stream = new EntireTranscriptStream(record => { field = record.fields[0] })
  for (const byte of Buffer.from(source)) stream.push(Buffer.from([byte]))
  await stream.finish()
  expect(field?.digest).toBe(digest('😀 ç'))
  expect(field?.bytes).toBe(Buffer.byteLength('😀 ç'))
  expect(JSON.parse('"' + Buffer.from(source).subarray(field!.startByte, field!.endByte).toString() + '"')).toBe('😀 ç')
})
