import { createHash } from 'node:crypto'
import type { SessionReferences, ReferenceSource } from './session-references'
import { LiteralRedactions, type RedactionSpan } from './literal-redactions'
import { utf8Prefix } from './privacy'
import type { TranscriptField } from './entire-transcript'

export interface BodyPosition { fieldIndex: number; decodedByte: number; rawByte: number }
export type OpenLiteralBody = (consume: (text: string, position: BodyPosition) => boolean, start?: BodyPosition) => Promise<void>
interface Range extends RedactionSpan { outputStart: number; delta: number }
interface Projection { revision: number; payloadDigest: string; outputBytes: number }
const builds = new WeakMap<SessionReferences, Map<string, Promise<void>>>()

function ranges(refs: SessionReferences, eventId: string, revision: number, after = 0): IterableIterator<Range> {
  return refs.db.prepare('SELECT start,end,replacement,rule,outputStart,delta FROM literal_ranges WHERE eventId=? AND revision=? AND end>? ORDER BY start').iterate(eventId, revision, after) as IterableIterator<Range>
}
class Projector {
  private next: IteratorResult<Range>
  input: number
  output: number
  private replacementEmitted = false
  constructor(private readonly iterator: IterableIterator<Range>, private readonly emit: (bytes: Buffer, offset: number) => void, input = 0, output = 0) {
    this.next = iterator.next(); this.input = input; this.output = output
    this.replacementEmitted = !this.next.done && this.next.value.start < input
  }
  private send(bytes: Buffer): void { if (bytes.length) { this.emit(bytes, this.output); this.output += bytes.length } }
  close(): void { this.iterator.return?.() }
  push(text: string): void {
    const bytes = Buffer.from(text)
    let cursor = 0
    while (cursor < bytes.length) {
      if (this.next.done) { this.send(bytes.subarray(cursor)); this.input += bytes.length - cursor; return }
      const range = this.next.value
      if (this.input < range.start) {
        const size = Math.min(bytes.length - cursor, range.start - this.input)
        this.send(bytes.subarray(cursor, cursor + size)); cursor += size; this.input += size
      } else {
        if (!this.replacementEmitted) { this.send(Buffer.from(range.replacement)); this.replacementEmitted = true }
        const size = Math.min(bytes.length - cursor, range.end - this.input)
        cursor += size; this.input += size
        if (this.input >= range.end) { this.next = this.iterator.next(); this.replacementEmitted = false }
      }
    }
  }
}
function mergeRanges(refs: SessionReferences, eventId: string, revision: number): void {
  const ordered = function* (): IterableIterator<RedactionSpan> {
    let offset = 0
    for (;;) {
      const batch = refs.db.prepare('SELECT start,end,replacement,rule FROM literal_spans WHERE eventId=? AND revision=? ORDER BY start,end DESC,rule LIMIT 256 OFFSET ?').all(eventId, revision, offset) as RedactionSpan[]
      if (!batch.length) return
      for (const span of batch) yield span
      offset += batch.length
    }
  }
  const insert = refs.db.prepare('INSERT INTO literal_ranges VALUES(?,?,?,?,?,?,?,?)')
  let pending: RedactionSpan | undefined, delta = 0
  const flush = () => {
    if (!pending) return
    const outputStart = pending.start + delta
    delta += Buffer.byteLength(pending.replacement) - (pending.end - pending.start)
    insert.run(eventId, revision, pending.start, pending.end, pending.replacement, pending.rule, outputStart, delta)
  }
  for (const span of ordered()) {
    if (pending && span.start < pending.end) {
      if (span.end > pending.end) { pending.end = span.end; if (span.rule === 1) { pending.replacement = span.replacement; pending.rule = span.rule } }
    } else { flush(); pending = { ...span } }
  }
  flush()
}
async function prepare(refs: SessionReferences, eventId: string, source: ReferenceSource, openBody: OpenLiteralBody, assertCurrent: () => void): Promise<void> {
  for (const table of ['literal_spans', 'literal_ranges', 'literal_anchors', 'literal_projection']) refs.db.prepare(`DELETE FROM ${table} WHERE eventId=?`).run(eventId)
  const insertSpan = refs.db.prepare('INSERT INTO literal_spans VALUES(?,?,?,?,?,?)')
  const insertAnchor = refs.db.prepare('INSERT OR IGNORE INTO literal_anchors VALUES(?,?,?,?,?)')
  const scanner = new LiteralRedactions(span => insertSpan.run(eventId, source.revision, span.start, span.end, span.replacement, span.rule))
  await openBody((text, position) => {
    assertCurrent(); scanner.push(text)
    if (source.locator.kind === 'ENTIRE_FILE' && position.fieldIndex >= 0) insertAnchor.run(eventId, source.revision, position.fieldIndex, position.decodedByte, position.rawByte)
    return true
  })
  scanner.finish(); mergeRanges(refs, eventId, source.revision)
  const hash = createHash('sha256'), projector = new Projector(ranges(refs, eventId, source.revision), bytes => hash.update(bytes))
  try { await openBody(text => { assertCurrent(); projector.push(text); return true }) } finally { projector.close() }
  assertCurrent()
  refs.db.prepare('INSERT OR REPLACE INTO literal_projection VALUES(?,?,?,?)').run(eventId, source.revision, hash.digest('hex'), projector.output)
}
function seek(refs: SessionReferences, eventId: string, source: ReferenceSource, fields: TranscriptField[], target: number): { start?: BodyPosition; input: number; output: number } {
  if (source.locator.kind !== 'ENTIRE_FILE' || !target) return { input: 0, output: 0 }
  const span = refs.db.prepare('SELECT start,end,replacement,rule,outputStart,delta FROM literal_ranges WHERE eventId=? AND revision=? AND outputStart<=? ORDER BY start DESC LIMIT 1').get(eventId, source.revision, target) as Range | undefined
  let input = span ? target < span.outputStart + Buffer.byteLength(span.replacement) ? span.start : target - span.delta : target
  let fieldIndex = 0, base = 0
  while (fieldIndex < fields.length - 1 && input > base + fields[fieldIndex].bytes) { base += fields[fieldIndex].bytes + 1; fieldIndex++ }
  const field = fields[fieldIndex]
  const anchor = field.encoding === 'JSON_STRING' ? refs.db.prepare('SELECT decodedByte,rawByte FROM literal_anchors WHERE eventId=? AND revision=? AND fieldIndex=? AND decodedByte<=? ORDER BY decodedByte DESC LIMIT 1').get(eventId, source.revision, fieldIndex, Math.max(0, input - base)) as { decodedByte: number; rawByte: number } | undefined : undefined
  const start = { fieldIndex, decodedByte: anchor?.decodedByte ?? 0, rawByte: anchor?.rawByte ?? field.startByte }
  input = base + start.decodedByte
  const before = refs.db.prepare('SELECT start,end,replacement,outputStart,delta FROM literal_ranges WHERE eventId=? AND revision=? AND start<? ORDER BY start DESC LIMIT 1').get(eventId, source.revision, input) as Range | undefined
  const output = before ? input < before.end ? before.outputStart + Buffer.byteLength(before.replacement) : input + before.delta : input
  return { start, input, output }
}
export async function readLiteralPage(refs: SessionReferences, eventId: string, source: ReferenceSource, fields: TranscriptField[], offset: number, openBody: OpenLiteralBody, assertCurrent: () => void, pageBytes = 8192): Promise<{ content: string; range: { startByte: number; endByte: number }; complete: boolean; partial: boolean; payloadDigest: string; sanitized: boolean }> {
  if (!fields.length) throw new Error('SOURCE_BODY_UNAVAILABLE')
  refs.db.exec('CREATE TABLE IF NOT EXISTS literal_ranges(eventId TEXT,revision INTEGER,start INTEGER,end INTEGER,replacement TEXT,rule INTEGER,outputStart INTEGER,delta INTEGER,PRIMARY KEY(eventId,revision,start));')
  let projection = refs.db.prepare('SELECT * FROM literal_projection WHERE eventId=?').get(eventId) as Projection | undefined
  if (projection?.revision !== source.revision) {
    let pending = builds.get(refs)
    if (!pending) { pending = new Map(); builds.set(refs, pending) }
    const key = eventId + ':' + source.revision
    let task = pending.get(key)
    if (!task) { task = prepare(refs, eventId, source, openBody, assertCurrent).finally(() => pending!.delete(key)); pending.set(key, task) }
    await task
    projection = refs.db.prepare('SELECT * FROM literal_projection WHERE eventId=?').get(eventId) as Projection
  }
  if (!projection || offset > projection.outputBytes) throw new Error('CURSOR_STALE')
  const start = seek(refs, eventId, source, fields, offset), buffers: Buffer[] = []
  let collected = 0
  const projector = new Projector(ranges(refs, eventId, source.revision, start.input), (bytes, position) => {
    const from = Math.max(0, offset - position), available = Math.min(bytes.length - from, pageBytes + 4 - collected)
    if (available > 0) { buffers.push(Buffer.from(bytes.subarray(from, from + available))); collected += available }
  }, start.input, start.output)
  try { await openBody(text => { assertCurrent(); projector.push(text); return source.locator.kind !== 'ENTIRE_FILE' || collected < pageBytes + 4 }, start.start) } finally { projector.close() }
  assertCurrent()
  const content = utf8Prefix(Buffer.concat(buffers, collected).toString('utf8'), pageBytes), end = offset + Buffer.byteLength(content)
  return { content, range: { startByte: offset, endByte: end }, complete: end === projection.outputBytes, partial: end < projection.outputBytes, payloadDigest: projection.payloadDigest, sanitized: !!refs.db.prepare('SELECT 1 FROM literal_ranges WHERE eventId=? AND revision=? LIMIT 1').get(eventId, source.revision) }
}
