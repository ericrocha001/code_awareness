import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { AcademyError } from '../academy-package'

export interface ZipEntry { path: string; data: Buffer }

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1)
  return crc >>> 0
})

function crc32(value: Buffer): number {
  let crc = 0xffffffff
  for (const byte of value) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export function createDeterministicZip(input: ZipEntry[]): Buffer {
  const entries = [...input].sort((left, right) => left.path.localeCompare(right.path))
  const names = new Set<string>()
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    if (!entry.path || entry.path.includes('\\') || entry.path.startsWith('/') || entry.path.split('/').includes('..')) throw new AcademyError('OPENAI_ZIP_INVALID_PATH', entry.path)
    if (names.has(entry.path.toLowerCase())) throw new AcademyError('OPENAI_ZIP_DUPLICATE_PATH', entry.path)
    names.add(entry.path.toLowerCase())
    const name = Buffer.from(entry.path, 'utf8')
    const compressed = deflateRawSync(entry.data, { level: 9 })
    const checksum = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28)
    localParts.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10)
    central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(entry.data.length, 24); central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + compressed.length
  }
  const centralSize = centralParts.reduce((sum, item) => sum + item.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, ...centralParts, end])
}

export function readZipEntries(archive: Buffer): ZipEntry[] {
  const endOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (endOffset < 0 || endOffset + 22 > archive.length) throw new AcademyError('OPENAI_ZIP_INVALID')
  const count = archive.readUInt16LE(endOffset + 10)
  let cursor = archive.readUInt32LE(endOffset + 16)
  const result: ZipEntry[] = []
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new AcademyError('OPENAI_ZIP_INVALID_CENTRAL_DIRECTORY')
    const method = archive.readUInt16LE(cursor + 10)
    const checksum = archive.readUInt32LE(cursor + 16)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const localOffset = archive.readUInt32LE(cursor + 42)
    const path = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new AcademyError('OPENAI_ZIP_INVALID_LOCAL_HEADER')
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const compressed = archive.subarray(start, start + compressedSize)
    const data = method === 8 ? inflateRawSync(compressed) : method === 0 ? Buffer.from(compressed) : (() => { throw new AcademyError('OPENAI_ZIP_UNSUPPORTED_COMPRESSION') })()
    if (crc32(data) !== checksum) throw new AcademyError('OPENAI_ZIP_CRC_MISMATCH', path)
    result.push({ path, data })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return result
}
