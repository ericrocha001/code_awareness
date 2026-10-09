import { createHash } from 'node:crypto'
import sharp from 'sharp'
import type { VisualMedia } from './continuum-types'

export const VISUAL_MAX_BYTES = 4 * 1024 * 1024
export const VISUAL_MAX_PIXELS = 16_000_000
export function mediaHash(data: Uint8Array): string { return createHash('sha256').update(data).digest('hex') }

export function inspectWebP(data: Buffer): { width: number; height: number } {
  const invalid = () => { throw new Error('INVALID_VISUAL_MEDIA') }
  if (!data.length || data.length > VISUAL_MAX_BYTES) throw new Error('VISUAL_SIZE_LIMIT')
  if (data.length < 26 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP' || data.readUInt32LE(4) + 8 !== data.length) return invalid()
  let dimensions: { width: number; height: number } | undefined
  let extended: { width: number; height: number; flags: number } | undefined
  let icc = false
  let alpha = false
  for (let offset = 12; offset < data.length;) {
    if (offset + 8 > data.length) return invalid()
    const kind = data.toString('ascii', offset, offset + 4)
    const size = data.readUInt32LE(offset + 4)
    const start = offset + 8
    const end = start + size
    if (end + (size & 1) > data.length || (size & 1) && data[end] !== 0) return invalid()
    if (kind === 'VP8X') {
      if (offset !== 12 || size !== 10 || extended || data[start] & ~0x30 || data.readUIntLE(start + 1, 3)) return invalid()
      extended = { flags: data[start], width: 1 + data.readUIntLE(start + 4, 3), height: 1 + data.readUIntLE(start + 7, 3) }
    } else if (kind === 'ICCP') {
      if (!extended || !(extended.flags & 0x20) || icc || dimensions || size < 132) return invalid()
      const profile = data.subarray(start, end)
      if (profile.readUInt32BE(0) !== size || profile.toString('ascii', 36, 40) !== 'acsp' || profile.toString('ascii', 16, 20) !== 'RGB ') return invalid()
      const tags = profile.readUInt32BE(128)
      if (tags > (size - 132) / 12) return invalid()
      for (let index = 0; index < tags; index++) {
        const entry = 132 + index * 12
        const position = profile.readUInt32BE(entry + 4), length = profile.readUInt32BE(entry + 8)
        if (position < 132 + tags * 12 || length < 8 || position + length > size) return invalid()
      }
      icc = true
    } else if (kind === 'VP8L') {
      if (dimensions || size < 5 || data[start] !== 0x2f) return invalid()
      const bits = data.readUInt32LE(start + 1)
      if (bits >>> 29) return invalid()
      dimensions = { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
      alpha = !!(bits & 0x10000000)
    } else return invalid()
    offset = end + (size & 1)
  }
  if (!dimensions || (extended && (extended.width !== dimensions.width || extended.height !== dimensions.height || !!(extended.flags & 0x20) !== icc || !!(extended.flags & 0x10) !== alpha))) return invalid()
  if (dimensions.width > 4096 || dimensions.height > 4096 || dimensions.width * dimensions.height > VISUAL_MAX_PIXELS) throw new Error('VISUAL_DIMENSION_LIMIT')
  return dimensions
}

export async function validateVisualMedia(data: Buffer): Promise<VisualMedia> {
  const dimensions = inspectWebP(data)
  try {
    const decoded = await sharp(data, { failOn: 'warning', limitInputPixels: VISUAL_MAX_PIXELS, sequentialRead: true })
      .timeout({ seconds: 5 }).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
    if (decoded.info.width !== dimensions.width || decoded.info.height !== dimensions.height) throw new Error()
  } catch { throw new Error('INVALID_VISUAL_MEDIA') }
  return { mimeType: 'image/webp', sha256: mediaHash(data), bytes: data.length, ...dimensions, lossless: true, animated: false }
}
