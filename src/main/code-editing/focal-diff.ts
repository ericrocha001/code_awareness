import { createTwoFilesPatch } from 'diff'

export interface FocalDiff {
  patch: string
  bytes: number
  truncated: boolean
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  let end = value.length
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes) {
    end = Math.floor(end * 0.8)
  }
  while (end < value.length && Buffer.byteLength(value.slice(0, end + 1), 'utf8') <= maxBytes) {
    end++
  }
  if (end > 0 && end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--
  return value.slice(0, end)
}

export function focalDiff(
  previews: Array<{ path: string; before: string; after: string }>,
  budget = 8 * 1024
): FocalDiff {
  const chunks: string[] = []
  for (const item of previews) {
    const raw = createTwoFilesPatch(item.path, item.path, item.before, item.after, '', '', { context: 2 })
    const cleaned = raw.replace(/^=+\r?\n/m, '')
    chunks.push(cleaned.endsWith('\n') ? cleaned : `${cleaned}\n`)
  }
  const full = chunks.join('')
  const fullBytes = Buffer.byteLength(full, 'utf8')
  if (fullBytes <= budget) {
    return { patch: full, bytes: fullBytes, truncated: false }
  }

  const lines = full.split('\n')
  const kept: string[] = []
  let usedBytes = 0
  for (let i = 0; i < lines.length; i++) {
    const segment = i === 0 ? lines[i] : `\n${lines[i]}`
    const segBytes = Buffer.byteLength(segment, 'utf8')
    if (usedBytes + segBytes > budget) {
      if (kept.length === 0) {
        const sliced = truncateUtf8(lines[0], budget)
        return { patch: sliced, bytes: Buffer.byteLength(sliced, 'utf8'), truncated: true }
      }
      break
    }
    kept.push(lines[i])
    usedBytes += segBytes
  }
  const patch = kept.join('\n')
  return { patch, bytes: Buffer.byteLength(patch, 'utf8'), truncated: true }
}
