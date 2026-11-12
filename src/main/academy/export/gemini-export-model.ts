import { createHash } from 'node:crypto'
import { extname, posix } from 'node:path'
import type {
  AcademyGeminiCoverage,
  AcademyGeminiExcludedSkill,
  AcademyGeminiExclusionReason,
  AcademyGeminiExportReceipt,
  AcademyGeminiSkillExportEntry,
  AcademySkillDetail,
  AcademySkillSummary
} from '../../../shared/types/academy-types'
import type { AcademyStore } from '../academy-store'
import { createDeterministicZip, type ZipEntry } from '../publication/deterministic-zip'

export const GEMINI_MAX_SKILL_BYTES = 100 * 1024 * 1024 // 100 MB

export const GEMINI_ALLOWED_EXTENSIONS = new Set<string>([
  // Docs / Text
  '.md', '.txt', '.rtf', '.html', '.htm', '.csv', '.tsv', '.pdf', '.docx', '.doc', '.json', '.yaml', '.yml', '.xml',
  // Images
  '.png', '.jpg', '.jpeg', '.webp'
])

export const GEMINI_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

export interface GeminiValidationResult {
  valid: boolean
  details?: string
}

export function validateGeminiSkill(detail: AcademySkillDetail): GeminiValidationResult {
  if (!GEMINI_NAME_PATTERN.test(detail.name)) {
    return {
      valid: false,
      details: `Nome '${detail.name}' não segue o padrão kebab-case exigido pelo Gemini (apenas letras minúsculas, números e hífens).`
    }
  }

  const skillMdBytes = Buffer.byteLength(detail.current.package.skillMd, 'utf8')
  let totalBytes = skillMdBytes

  for (const [path, content] of Object.entries(detail.current.package.artifacts ?? {})) {
    if (path.includes('\\') || path.startsWith('/') || path.split('/').includes('..')) {
      return {
        valid: false,
        details: `Caminho de artefato inválido '${path}': caminhos não podem conter barras invertidas, iniciar com barra ou conter '..'.`
      }
    }
    const normalized = posix.normalize(path)
    if (normalized === 'SKILL.md') {
      return {
        valid: false,
        details: `Artefato não pode sobrescrever 'SKILL.md'.`
      }
    }

    const ext = extname(path).toLowerCase()
    if (!GEMINI_ALLOWED_EXTENSIONS.has(ext)) {
      return {
        valid: false,
        details: `Arquivo '${path}' possui extensão '${ext || '(sem extensão)'}' não suportada pelo Gemini Web.`
      }
    }

    totalBytes += Buffer.byteLength(content, 'utf8')
  }

  if (totalBytes > GEMINI_MAX_SKILL_BYTES) {
    return {
      valid: false,
      details: `Tamanho total da Skill (${totalBytes} bytes) excede o limite de 100MB do Gemini Web.`
    }
  }

  return { valid: true }
}

export interface GeminiInclusionResult {
  status: 'INCLUDED' | 'NOT_APPLICABLE' | 'EXCLUDED'
  reason?: AcademyGeminiExclusionReason
  details?: string
  action?: AcademyGeminiExcludedSkill['action']
}

export function geminiInclusion(store: AcademyStore, skill: AcademySkillSummary): GeminiInclusionResult {
  if (skill.scope !== 'GLOBAL') {
    return { status: 'NOT_APPLICABLE' }
  }
  if (!store.usesGitFirst() && store.isDeleted(skill.id)) {
    return {
      status: 'EXCLUDED',
      reason: 'REMOVED',
      details: 'Skill removida do catálogo.',
      action: 'REINTRODUCE_SKILL'
    }
  }
  if (skill.status !== 'ACTIVE') {
    return {
      status: 'EXCLUDED',
      reason: 'DISABLED',
      details: 'Skill desativada no catálogo.',
      action: 'ENABLE_SKILL'
    }
  }
  if (!store.usesGitFirst() && store.publicationEligibility(skill.id) !== 'APPROVED') {
    return {
      status: 'EXCLUDED',
      reason: 'PRIVATE',
      details: 'Skill privada sem aprovação para publicação.',
      action: 'APPROVE_PUBLICATION'
    }
  }

  const detail = store.get(skill.id)
  const validation = validateGeminiSkill(detail)
  if (!validation.valid) {
    return {
      status: 'EXCLUDED',
      reason: 'INCOMPATIBLE',
      details: validation.details,
      action: 'VIEW_SKILL'
    }
  }

  return { status: 'INCLUDED' }
}

export interface CanonicalGeminiSnapshotEntry {
  skillId: string
  name: string
  academyVersion: number
  packageHash: string
}

export function buildCanonicalGeminiSnapshot(store: AcademyStore): CanonicalGeminiSnapshotEntry[] {
  const entries: CanonicalGeminiSnapshotEntry[] = []
  for (const skill of store.list()) {
    const inclusion = geminiInclusion(store, skill)
    if (inclusion.status === 'INCLUDED') {
      const detail = store.get(skill.id)
      entries.push({
        skillId: skill.id,
        name: skill.name,
        academyVersion: skill.currentVersion,
        packageHash: detail.current.packageHash
      })
    }
  }
  return entries.sort((a, b) => a.skillId.localeCompare(b.skillId))
}

export function hashGeminiSnapshot(snapshot: CanonicalGeminiSnapshotEntry[]): string {
  return sha256(canonicalJson(snapshot))
}

export function buildGeminiCoverage(
  store: AcademyStore,
  latestExport: AcademyGeminiExportReceipt | null
): AcademyGeminiCoverage {
  let catalog = 0
  let notApplicable = 0
  const includedIds = new Set<string>()
  const excluded: AcademyGeminiExcludedSkill[] = []

  const shippedSkills = new Map(latestExport?.skills.map((s) => [s.name, s]))

  for (const skill of store.list()) {
    const inclusion = geminiInclusion(store, skill)
    if (inclusion.status !== 'EXCLUDED' || inclusion.reason !== 'REMOVED') {
      catalog++
    }

    if (inclusion.status === 'NOT_APPLICABLE') {
      notApplicable++
    } else if (inclusion.status === 'INCLUDED') {
      includedIds.add(skill.id)
    } else if (inclusion.status === 'EXCLUDED' && inclusion.reason) {
      excluded.push({
        skillId: skill.id,
        name: skill.name,
        version: skill.currentVersion,
        reason: inclusion.reason,
        action: inclusion.action,
        details: inclusion.details
      })
    }
  }

  let awaitingZip = 0
  if (latestExport) {
    for (const skillId of includedIds) {
      const skill = store.get(skillId)
      const shipped = shippedSkills.get(skill.name)
      if (!shipped) {
        awaitingZip++
      } else {
        const skillZip = createGeminiSkillZip(skill)
        if (skillZip.zipSha256 !== shipped.zipSha256) {
          awaitingZip++
        }
      }
    }
    for (const shippedName of shippedSkills.keys()) {
      const current = store.list().find((s) => s.name === shippedName)
      if (!current || !includedIds.has(current.id)) {
        awaitingZip++
      }
    }
  } else {
    awaitingZip = includedIds.size
  }

  return {
    catalog,
    eligible: includedIds.size,
    includedInLastZip: latestExport ? latestExport.skillCount : null,
    awaitingZip,
    notApplicable,
    excluded
  }
}

export interface GeneratedGeminiSkillZip {
  name: string
  zipBuffer: Buffer
  zipSha256: string
  entryCount: number
  byteLength: number
}

export function createGeminiSkillZip(detail: AcademySkillDetail): GeneratedGeminiSkillZip {
  const entries: ZipEntry[] = [
    {
      path: 'SKILL.md',
      data: Buffer.from(detail.current.package.skillMd, 'utf8')
    }
  ]

  for (const [path, content] of Object.entries(detail.current.package.artifacts ?? {})) {
    entries.push({
      path: posix.normalize(path),
      data: Buffer.from(content, 'utf8')
    })
  }

  entries.sort((a, b) => a.path.localeCompare(b.path))
  const zipBuffer = createDeterministicZip(entries)

  return {
    name: detail.name,
    zipBuffer,
    zipSha256: sha256(zipBuffer),
    entryCount: entries.length,
    byteLength: zipBuffer.length
  }
}

export interface GeneratedGeminiMasterZip {
  masterBuffer: Buffer
  masterHash: string
  totalBytes: number
}

export function createGeminiMasterZip(skillZips: GeneratedGeminiSkillZip[]): GeneratedGeminiMasterZip {
  const entries: ZipEntry[] = skillZips.map((item) => ({
    path: `${item.name}.zip`,
    data: item.zipBuffer
  }))

  entries.sort((a, b) => a.path.localeCompare(b.path))
  const masterBuffer = createDeterministicZip(entries)

  return {
    masterBuffer,
    masterHash: sha256(masterBuffer),
    totalBytes: masterBuffer.length
  }
}
