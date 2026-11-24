import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { contextDownloadsDirectory } from '../continuum/bundle-export'
import type { PickerFile } from '../../shared/web-activation/context-picker-contract'
import { BUNDLE_MAX_TOTAL, type ContextBundle } from '../continuum/context-bundle'
import type { ContinuumService } from '../continuum/continuum-service'

interface OriginalFile {
  name: string
  type: PickerFile['type']
  bytes: Buffer
}

function safeBase(name: string): string {
  const base = name.normalize('NFC').replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu, '_').trim().slice(0, 80).replace(/[. ]+$/g, '')
  if (!base) return 'documento'
  return /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(base) ? '_' + base : base
}

export function pickerOriginals(service: ContinuumService, bundle: ContextBundle): OriginalFile[] {
  const used = new Set<string>()
  let total = 0
  const files: OriginalFile[] = []
  for (const member of bundle.preview.members) {
    const item = service.get(member.artifactId)
    if (!item || item.revision !== member.revision) throw new Error('BUNDLE_SNAPSHOT_STALE')
    const bytes = Buffer.from(item.rawMarkdown, 'utf8')
    if (createHash('sha256').update(bytes).digest('hex') !== item.contentHash) throw new Error('ARTIFACT_INTEGRITY_ERROR')
    const base = safeBase(member.name)
    let unique = base
    for (let suffix = 2; used.has(unique.toLowerCase()); suffix++) unique = `${base}-${suffix}`
    used.add(unique.toLowerCase())
    files.push({ name: unique + '.md', type: 'text/markdown', bytes })
    total += bytes.length
    if (member.mediaPath) {
      const { data, media } = service.getVisual(member.artifactId)
      if (media.bytes !== data.length || createHash('sha256').update(data).digest('hex') !== media.sha256) {
        throw new Error('VISUAL_INTEGRITY_ERROR')
      }
      files.push({ name: unique + '.webp', type: 'image/webp', bytes: data })
      total += data.length
    }
    if (total > BUNDLE_MAX_TOTAL) throw new Error('BUNDLE_LIMIT')
  }
  bundle.assertFresh()
  return files
}

export function nativePickerFiles(files: OriginalFile[]): PickerFile[] {
  if (files.some(file => file.type !== 'text/markdown')) throw new Error('PICKER_MEDIA_DOWNLOAD_REQUIRED')
  const payload: PickerFile[] = []
  let size = 0
  for (const { bytes, name, type } of files) {
    size += 4 * Math.ceil(bytes.length / 3) + Buffer.byteLength(name) + 256
    if (size > 900_000) throw new Error('PICKER_FILES_TOO_LARGE')
    payload.push({ name, type, encoded: bytes.toString('base64') })
  }
  return payload
}

export function downloadPickerFiles(files: OriginalFile[], assertCurrent: () => void) {
  assertCurrent()
  const downloads = contextDownloadsDirectory()
  const directory = mkdtempSync(join(downloads, 'continuum-contexto-'))
  try {
    for (const file of files) {
      assertCurrent()
      writeFileSync(join(directory, file.name), file.bytes, { flag: 'wx', mode: 0o600 })
    }
    assertCurrent()
    return { outcome: 'downloaded' as const, directory, names: files.map(file => file.name) }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
