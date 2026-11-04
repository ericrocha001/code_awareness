import { createReadStream } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { parser } from 'stream-json'
import { JsonLiteralWriter } from './json-literal-writer'
import { assertProfilePath } from '../local-mcp-clients/safe-config-file'
import { digest } from './privacy'
import type { TranscriptField } from './entire-transcript'
import type { CheckpointTranscriptSource } from './checkpoint-transcript'

export interface EntireFileSource { kind: 'ENTIRE_FILE'; path: string; identity: string }
export interface EntireCliSource { kind: 'ENTIRE_CLI'; agent: string; providerSessionId: string }
export type EntireSource = (EntireFileSource | EntireCliSource | CheckpointTranscriptSource) & { target?: { worktreeId: string; generation: string } }

export async function entireFileIdentity(path: string): Promise<string> {
  const stat = await lstat(path, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error('SOURCE_UNAVAILABLE')
  return digest([await realpath(path), stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'))
}
export async function localEntireSource(root: string, providerSessionId: string): Promise<EntireFileSource | undefined> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(providerSessionId)) throw new Error('SOURCE_IDENTITY_CONFLICT')
  const path = join(root, '.entire', 'metadata', providerSessionId, 'full.jsonl')
  try {
    assertProfilePath(path, join(root, '.entire'))
    return { kind: 'ENTIRE_FILE', path, identity: await entireFileIdentity(path) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
function utf8End(bytes: Buffer, start: number, end: number): number {
  let first = end - 1
  while (first >= start && (bytes[first] & 0xc0) === 0x80) first--
  if (first < start) return start
  const byte = bytes[first], length = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4
  return first + length <= end ? end : first
}
export async function* decodeJsonString(handle: FileHandle, field: Pick<TranscriptField, 'startByte' | 'endByte'>, assertCurrent: () => void, fromRaw = field.startByte): AsyncGenerator<{ text: string; rawEnd: number }> {
  let position = fromRaw
  const bytes = Buffer.alloc(65536)
  while (position < field.endByte) {
    assertCurrent()
    const size = (await handle.read(bytes, 0, Math.min(bytes.length, field.endByte - position), position)).bytesRead
    if (!size) throw new Error('SOURCE_REVISION_CHANGED')
    let cursor = 0
    while (cursor < size) {
      if (bytes[cursor] !== 92) {
        const slash = bytes.indexOf(92, cursor), end = utf8End(bytes, cursor, slash < 0 || slash >= size ? size : slash)
        if (end <= cursor) break
        yield { text: bytes.subarray(cursor, end).toString('utf8'), rawEnd: position + end }
        cursor = end
      } else {
        if (cursor + 2 > size) break
        let length = bytes[cursor + 1] === 117 ? 6 : 2
        if (cursor + length > size) break
        if (length === 6) {
          const code = Number.parseInt(bytes.subarray(cursor + 2, cursor + 6).toString(), 16)
          if (code >= 0xd800 && code <= 0xdbff && position + cursor + 6 < field.endByte) {
            if (cursor + 8 > size && position + size < field.endByte) break
            if (bytes[cursor + 6] === 92 && bytes[cursor + 7] === 117) {
              if (cursor + 12 > size) break
              const low = Number.parseInt(bytes.subarray(cursor + 8, cursor + 12).toString(), 16)
              if (low >= 0xdc00 && low <= 0xdfff) length = 12
            }
          }
        }
        let text: string
        try { text = JSON.parse('"' + bytes.subarray(cursor, cursor + length).toString() + '"') } catch { throw new Error('SOURCE_REVISION_CHANGED') }
        cursor += length
        yield { text, rawEnd: position + cursor }
      }
    }
    if (!cursor) throw new Error('SOURCE_REVISION_CHANGED')
    position += cursor
  }
}
export async function* readEntireField(source: EntireFileSource, field: TranscriptField, assertCurrent: () => void, fromRaw?: number): AsyncGenerator<{ text: string; rawEnd: number }> {
  assertCurrent()
  if (await entireFileIdentity(source.path) !== source.identity) throw new Error('SOURCE_REVISION_CHANGED')
  const handle = await open(source.path, 'r')
  try {
    const opened = await handle.stat({ bigint: true })
    if (digest([await realpath(source.path), opened.dev, opened.ino, opened.size, opened.mtimeNs, opened.ctimeNs].join(':')) !== source.identity) throw new Error('SOURCE_REVISION_CHANGED')
    if (field.encoding === 'JSON_STRING') yield* decodeJsonString(handle, field, assertCurrent, fromRaw)
    else {
      if (fromRaw !== undefined && fromRaw !== field.startByte) throw new Error('SOURCE_LOCATOR_UNSUPPORTED')
      const input = createReadStream(source.path, { fd: handle.fd, autoClose: false, start: field.startByte, end: field.endByte - 1, highWaterMark: 65536 })
      const tokens = parser({ packValues: false }), output = new JsonLiteralWriter()
      input.pipe(tokens).pipe(output)
      const fail = (error: Error) => output.destroy(error)
      input.on('error', fail); tokens.on('error', fail)
      try {
        for await (const chunk of output) { assertCurrent(); yield { text: chunk.toString(), rawEnd: field.startByte } }
      } finally { input.destroy(); tokens.destroy(); output.destroy() }
    }
    assertCurrent()
    if (await entireFileIdentity(source.path) !== source.identity) throw new Error('SOURCE_REVISION_CHANGED')
  } finally { await handle.close() }
}
