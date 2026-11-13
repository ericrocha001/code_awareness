import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { extname, join, posix } from 'node:path'
import type {
  AcademyPackage,
  AcademySkillDetail,
  AcademySkillSummary,
  AcademyGeminiCoverage,
  AcademyGeminiExcludedSkill,
  AcademyGeminiExclusionReason,
  AcademyGeminiExportReceipt
} from '../../../shared/types/academy-types'
import type { AcademyStore } from '../academy-store'
import { createDeterministicZip, type ZipEntry } from '../publication/deterministic-zip'
import type {
  AcademyGeminiWorkerExcludedSkill,
  AcademyPluginTaskResult
} from '../publication/academy-plugin-executor'

export const GEMINI_ADAPTATION_PROFILE_VERSION = 'v1-script-markdown-reference'
export const GEMINI_MAX_SKILL_BYTES = 100 * 1024 * 1024 // 100 MB

export const GEMINI_NATIVE_ALLOWED_EXTENSIONS = new Set<string>([
  // Documents & Plain Text
  '.doc', '.docx', '.dot', '.dotx', '.hwp', '.hwpx', '.pdf', '.rtf', '.txt', '.md',
  // Spreadsheets & Tabular Data
  '.csv', '.tsv', '.xls', '.xlsx',
  // Presentations
  '.pptx',
  // Code & Structured Data natively accepted by Gemini Apps Web
  '.py', '.sh', '.js', '.json', '.yaml', '.yml', '.xml', '.html', '.htm',
  // Images
  '.png', '.jpg', '.jpeg', '.webp', '.heic', '.heif'
])

export const GEMINI_ADAPTABLE_CODE_EXTENSIONS = new Set<string>([
  // Scripts and code formats to convert non-destructively into Markdown references
  '.ts', '.tsx', '.jsx', '.sql', '.cs', '.php', '.rb',
  '.c', '.cpp', '.h', '.hpp', '.go', '.java', '.rs',
  '.cjs', '.mjs', '.ps1', '.bat', '.cmd', '.css'
])

export const GEMINI_REJECTED_AUDIO_VIDEO_EXTENSIONS = new Set<string>([
  // Audio
  '.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a', '.wma',
  // Video
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv'
])

export const GEMINI_REJECTED_BINARY_EXTENSIONS = new Set<string>([
  '.exe', '.dll', '.bin', '.so', '.dylib', '.zip', '.tar', '.gz', '.7z',
  '.iso', '.class', '.o', '.obj', '.pyc', '.wasm'
])

export const GEMINI_ALLOWED_EXTENSIONS = new Set<string>([
  ...GEMINI_NATIVE_ALLOWED_EXTENSIONS,
  ...GEMINI_ADAPTABLE_CODE_EXTENSIONS
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

export function inferCodeLanguage(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.ts':
    case '.tsx':
      return 'typescript'
    case '.js':
    case '.jsx':
    case '.cjs':
    case '.mjs':
      return 'javascript'
    case '.sql':
      return 'sql'
    case '.cs':
      return 'csharp'
    case '.php':
      return 'php'
    case '.rb':
      return 'ruby'
    case '.c':
    case '.h':
      return 'c'
    case '.cpp':
    case '.hpp':
      return 'cpp'
    case '.go':
      return 'go'
    case '.java':
      return 'java'
    case '.rs':
      return 'rust'
    case '.ps1':
      return 'powershell'
    case '.bat':
    case '.cmd':
      return 'batch'
    case '.py':
      return 'python'
    case '.sh':
    case '.bash':
      return 'bash'
    case '.css':
      return 'css'
    default:
      return ext.replace(/^\./, '').toLowerCase() || 'text'
  }
}

export function generateMarkdownFence(content: string): string {
  if (!content.includes('```')) {
    return '```'
  }
  const matches = content.match(/`{3,}/g)
  let maxBackticks = 0
  if (matches) {
    for (const m of matches) {
      if (m.length > maxBackticks) {
        maxBackticks = m.length
      }
    }
  }
  const fenceLength = Math.max(3, maxBackticks + 1)
  return '`'.repeat(fenceLength)
}

export function formatAdaptedReferenceMarkdown(originalPath: string, content: string, language: string): string {
  const fence = generateMarkdownFence(content)
  return [
    `# Referência: ${originalPath}`,
    '',
    '> [!WARNING]',
    '> **Aviso de Compatibilidade Gemini:** Este arquivo é uma **referência textual** do script original e **não é executável** no ambiente Gemini Web. Não execute comandos locais ou tente invocar este arquivo diretamente.',
    '',
    `- **Caminho original:** \`${originalPath}\``,
    `- **Linguagem:** \`${language}\``,
    '',
    `${fence}${language}`,
    content,
    fence,
    ''
  ].join('\n')
}

export function mapAdaptedPath(normalizedPath: string): string {
  if (normalizedPath.startsWith('references/')) {
    return `${normalizedPath}.md`
  }
  return posix.join('references', `${normalizedPath}.md`)
}

export interface AdaptedFileMapping {
  originalPath: string
  adaptedPath: string
  language: string
}

export interface GeminiPackageAdaptationResult {
  package: AcademyPackage
  adaptedFiles: AdaptedFileMapping[]
  totalBytes: number
  rejectionReason?: string
}

export interface GeminiPackagePreflightResult {
  valid: boolean
  rejectionReason?: string
  adaptedFileCount: number
  artifactCount: number
}

/**
 * Executa pré-validação estrutural e de compatibilidade usando apenas caminhos e
 * metadados dos artefatos, sem ler conteúdo nem estimar tamanho por heurística.
 */
export function preflightGeminiPackage(canonicalPackage: AcademyPackage): GeminiPackagePreflightResult {
  const artifactPaths = Object.keys(canonicalPackage.artifacts ?? {})
  const originalLowerMap = new Map<string, string>()

  for (const rawPath of artifactPaths) {
    if (rawPath.includes('\\') || rawPath.startsWith('/') || rawPath.split('/').includes('..')) {
      return {
        valid: false,
        rejectionReason: `Caminho de artefato inválido '${rawPath}': caminhos não podem conter barras invertidas, iniciar com barra ou conter '..'.`,
        adaptedFileCount: 0,
        artifactCount: artifactPaths.length
      }
    }
    const normalized = posix.normalize(rawPath)
    const normalizedLower = normalized.toLowerCase()

    if (normalizedLower === 'skill.md') {
      return {
        valid: false,
        rejectionReason: `Artefato não pode sobrescrever 'SKILL.md'.`,
        adaptedFileCount: 0,
        artifactCount: artifactPaths.length
      }
    }

    if (originalLowerMap.has(normalizedLower)) {
      return {
        valid: false,
        rejectionReason: `Colisão de caminho: '${rawPath}' colide (não sensível a maiúsculas) com '${originalLowerMap.get(normalizedLower)}'.`,
        adaptedFileCount: 0,
        artifactCount: artifactPaths.length
      }
    }
    originalLowerMap.set(normalizedLower, rawPath)
  }

  let adaptedFileCount = 0
  const zipDestinationsLower = new Map<string, string>()
  zipDestinationsLower.set('skill.md', 'SKILL.md')

  for (const rawPath of artifactPaths) {
    const normalized = posix.normalize(rawPath)
    const normalizedLower = normalized.toLowerCase()
    const ext = extname(normalized).toLowerCase()

    if (GEMINI_REJECTED_AUDIO_VIDEO_EXTENSIONS.has(ext)) {
      return {
        valid: false,
        rejectionReason: `Arquivo '${rawPath}' possui extensão '${ext}' (áudio/vídeo), não suportada dentro de arquivos ZIP no Gemini Web.`,
        adaptedFileCount: 0,
        artifactCount: artifactPaths.length
      }
    }

    if (GEMINI_REJECTED_BINARY_EXTENSIONS.has(ext)) {
      return {
        valid: false,
        rejectionReason: `Arquivo '${rawPath}' é binário ou não conversível para referência textual no Gemini Web.`,
        adaptedFileCount: 0,
        artifactCount: artifactPaths.length
      }
    }

    if (GEMINI_NATIVE_ALLOWED_EXTENSIONS.has(ext)) {
      if (zipDestinationsLower.has(normalizedLower)) {
        return {
          valid: false,
          rejectionReason: `Colisão de caminho: '${normalized}' já está registrado no pacote.`,
          adaptedFileCount: 0,
          artifactCount: artifactPaths.length
        }
      }
      zipDestinationsLower.set(normalizedLower, normalized)
      continue
    }

    if (GEMINI_ADAPTABLE_CODE_EXTENSIONS.has(ext)) {
      const adaptedPath = mapAdaptedPath(normalized)
      const adaptedLower = adaptedPath.toLowerCase()

      if (zipDestinationsLower.has(adaptedLower)) {
        return {
          valid: false,
          rejectionReason: `Colisão de caminho ao adaptar '${rawPath}' para '${adaptedPath}': caminho de destino já ocupado.`,
          adaptedFileCount: 0,
          artifactCount: artifactPaths.length
        }
      }
      if (originalLowerMap.has(adaptedLower)) {
        return {
          valid: false,
          rejectionReason: `Colisão de caminho ao adaptar '${rawPath}' para '${adaptedPath}': caminho de destino colide com arquivo original '${originalLowerMap.get(adaptedLower)}'.`,
          adaptedFileCount: 0,
          artifactCount: artifactPaths.length
        }
      }

      zipDestinationsLower.set(adaptedLower, adaptedPath)
      adaptedFileCount++
      continue
    }

    return {
      valid: false,
      rejectionReason: `Arquivo '${rawPath}' possui extensão '${ext || '(sem extensão)'}' não suportada pelo Gemini Web.`,
      adaptedFileCount: 0,
      artifactCount: artifactPaths.length
    }
  }

  return {
    valid: true,
    adaptedFileCount,
    artifactCount: artifactPaths.length
  }
}

export function adaptGeminiPackage(canonicalPackage: AcademyPackage): GeminiPackageAdaptationResult {
  const preflight = preflightGeminiPackage(canonicalPackage)
  if (!preflight.valid) {
    return {
      package: canonicalPackage,
      adaptedFiles: [],
      totalBytes: 0,
      rejectionReason: preflight.rejectionReason
    }
  }

  const adaptedFiles: AdaptedFileMapping[] = []
  const derivedArtifacts: Record<string, string> = {}

  for (const [rawPath, content] of Object.entries(canonicalPackage.artifacts ?? {})) {
    if (content.includes('\0')) {
      return {
        package: canonicalPackage,
        adaptedFiles: [],
        totalBytes: 0,
        rejectionReason: `Arquivo '${rawPath}' é binário ou não conversível para referência textual no Gemini Web.`
      }
    }

    const normalized = posix.normalize(rawPath)
    const ext = extname(normalized).toLowerCase()

    if (GEMINI_NATIVE_ALLOWED_EXTENSIONS.has(ext)) {
      derivedArtifacts[normalized] = content
      continue
    }

    if (GEMINI_ADAPTABLE_CODE_EXTENSIONS.has(ext)) {
      const adaptedPath = mapAdaptedPath(normalized)
      const language = inferCodeLanguage(ext)
      const referenceContent = formatAdaptedReferenceMarkdown(rawPath, content, language)
      derivedArtifacts[adaptedPath] = referenceContent
      adaptedFiles.push({
        originalPath: rawPath,
        adaptedPath,
        language
      })
      continue
    }
  }

  let derivedSkillMd = canonicalPackage.skillMd
  if (adaptedFiles.length > 0) {
    for (const item of adaptedFiles) {
      const regexExact = new RegExp(`\\]\\(\\s*\\.?/?${item.originalPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\)`, 'g')
      derivedSkillMd = derivedSkillMd.replace(regexExact, `](${item.adaptedPath})`)
    }

    const adaptationNotes = [
      '',
      '## Compatibilidade Gemini — Scripts Adaptados',
      '',
      '> [!NOTE]',
      '> Os seguintes scripts foram convertidos em referências textuais não executáveis para compatibilidade com o Gemini Web:',
      ...adaptedFiles.map(
        (f) => `> - \`${f.originalPath}\` → \`${f.adaptedPath}\` (referência textual; não executável)`
      ),
      ''
    ].join('\n')

    derivedSkillMd = `${derivedSkillMd.trimEnd()}\n${adaptationNotes}`
  }

  let totalBytes = Buffer.byteLength(derivedSkillMd ?? '', 'utf8')
  for (const derivedContent of Object.values(derivedArtifacts)) {
    totalBytes += Buffer.byteLength(derivedContent, 'utf8')
  }

  if (totalBytes > GEMINI_MAX_SKILL_BYTES) {
    return {
      package: canonicalPackage,
      adaptedFiles: [],
      totalBytes,
      rejectionReason: `Tamanho total da Skill (${totalBytes} bytes) excede o limite de 100MB do Gemini Web.`
    }
  }

  return {
    package: {
      skillMd: derivedSkillMd,
      artifacts: derivedArtifacts
    },
    adaptedFiles,
    totalBytes
  }
}

export interface GeminiValidationResult {
  valid: boolean
  details?: string
  adaptedFileCount?: number
}

export function validateGeminiSkill(detail: AcademySkillDetail): GeminiValidationResult {
  if (!GEMINI_NAME_PATTERN.test(detail.name)) {
    return {
      valid: false,
      details: `Nome '${detail.name}' não segue o padrão kebab-case exigido pelo Gemini (apenas letras minúsculas, números e hífens).`
    }
  }

  const preflight = preflightGeminiPackage(detail.current.package)
  if (!preflight.valid) {
    return {
      valid: false,
      details: preflight.rejectionReason
    }
  }

  return { valid: true, adaptedFileCount: preflight.adaptedFileCount }
}

interface CachedGeminiSkillEvaluation {
  version: number
  packageHash: string
  profileVersion: string
  name: string
  artifactCount: number
  workerExcluded?: boolean
  validation: GeminiValidationResult
}

const storeEvaluationCache = new WeakMap<AcademyStore, Map<string, CachedGeminiSkillEvaluation>>()

function getStoreCache(store: AcademyStore): Map<string, CachedGeminiSkillEvaluation> {
  let cache = storeEvaluationCache.get(store)
  if (!cache) {
    cache = new Map<string, CachedGeminiSkillEvaluation>()
    storeEvaluationCache.set(store, cache)
  }
  return cache
}

export function clearGeminiEvaluationCache(store: AcademyStore): void {
  storeEvaluationCache.delete(store)
}

function getCurrentVersionPackageHash(store: AcademyStore, skill: AcademySkillSummary): string | null {
  if (typeof store.history !== 'function') return null
  const versions = store.history(skill.id, { metadataOnly: true })
  const currentMeta = versions.find((entry) => entry.version === skill.currentVersion)
  return currentMeta?.packageHash ?? null
}

/**
 * Registra no cache em memória uma exclusão apurada na verificação integral do
 * worker (ex.: tamanho derivado > 100 MB ou byte nulo). A entrada é invalidada
 * automaticamente quando version, packageHash ou profileVersion mudam.
 */
export function recordGeminiWorkerExclusion(
  store: AcademyStore,
  exclusion: AcademyGeminiWorkerExcludedSkill,
  profileVersion = GEMINI_ADAPTATION_PROFILE_VERSION
): void {
  const cache = getStoreCache(store)
  cache.set(exclusion.skillId, {
    version: exclusion.version,
    packageHash: exclusion.packageHash,
    profileVersion: exclusion.profileVersion || profileVersion,
    name: exclusion.name,
    artifactCount: 0,
    workerExcluded: true,
    validation: {
      valid: false,
      details: exclusion.details
    }
  })
}

/**
 * Restaura no cache em memória as exclusões apuradas pelo worker e persistidas
 * no recibo, mantendo o vínculo estrito com version, packageHash e profileVersion.
 */
export function restoreGeminiReceiptExclusions(
  store: AcademyStore,
  receipt: AcademyGeminiExportReceipt | null,
  currentProfileVersion = GEMINI_ADAPTATION_PROFILE_VERSION
): void {
  if (!receipt?.excludedSkills?.length) return
  if (receipt.profileVersion && receipt.profileVersion !== currentProfileVersion) return

  const cache = getStoreCache(store)
  for (const item of receipt.excludedSkills) {
    if (
      !item ||
      typeof item.skillId !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.version !== 'number' ||
      typeof item.packageHash !== 'string' ||
      typeof item.profileVersion !== 'string' ||
      typeof item.details !== 'string'
    ) {
      continue
    }
    if (item.profileVersion !== currentProfileVersion) continue

    const existing = cache.get(item.skillId)
    if (
      existing &&
      existing.workerExcluded &&
      existing.version === item.version &&
      existing.packageHash === item.packageHash &&
      existing.profileVersion === item.profileVersion &&
      existing.name === item.name
    ) {
      continue
    }
    recordGeminiWorkerExclusion(store, item, currentProfileVersion)
  }
}

/**
 * Retorna exclusões apuradas pelo worker que continuam válidas para a versão,
 * hash e perfil correntes, evitando perda de exclusões em reexportações parciais.
 */
export function getActiveWorkerExclusions(
  store: AcademyStore,
  profileVersion = GEMINI_ADAPTATION_PROFILE_VERSION
): AcademyGeminiWorkerExcludedSkill[] {
  const cache = storeEvaluationCache.get(store)
  if (!cache || cache.size === 0) return []

  const skillsById = new Map(store.list().map((s) => [s.id, s]))
  const active: AcademyGeminiWorkerExcludedSkill[] = []

  for (const [skillId, entry] of cache.entries()) {
    if (!entry.workerExcluded || entry.profileVersion !== profileVersion || entry.validation.valid) {
      continue
    }
    const skill = skillsById.get(skillId)
    if (!skill || skill.currentVersion !== entry.version || skill.name !== entry.name) {
      continue
    }
    const metadataHash = getCurrentVersionPackageHash(store, skill)
    if (!metadataHash || metadataHash !== entry.packageHash) {
      continue
    }
    active.push({
      skillId,
      name: entry.name,
      version: entry.version,
      packageHash: entry.packageHash,
      profileVersion: entry.profileVersion,
      details: entry.validation.details ?? 'Incompatível para exportação Gemini.'
    })
  }

  return active
}

interface EvaluatedGeminiSkill {
  skill: AcademySkillSummary
  inclusion: GeminiInclusionResult
  packageHash?: string
  artifactCount?: number
}

function evaluateSkillWithCache(
  store: AcademyStore,
  skill: AcademySkillSummary,
  profileVersion: string,
  gitFirst: boolean
): EvaluatedGeminiSkill {
  if (skill.scope !== 'GLOBAL') {
    return { skill, inclusion: { status: 'NOT_APPLICABLE' } }
  }
  if (!gitFirst && store.isDeleted(skill.id)) {
    return {
      skill,
      inclusion: {
        status: 'EXCLUDED',
        reason: 'REMOVED',
        details: 'Skill removida do catálogo.',
        action: 'REINTRODUCE_SKILL'
      }
    }
  }
  if (skill.status !== 'ACTIVE') {
    return {
      skill,
      inclusion: {
        status: 'EXCLUDED',
        reason: 'DISABLED',
        details: 'Skill desativada no catálogo.',
        action: 'ENABLE_SKILL'
      }
    }
  }
  if (!gitFirst && store.publicationEligibility(skill.id) !== 'APPROVED') {
    return {
      skill,
      inclusion: {
        status: 'EXCLUDED',
        reason: 'PRIVATE',
        details: 'Skill privada sem aprovação para publicação.',
        action: 'APPROVE_PUBLICATION'
      }
    }
  }

  const cache = getStoreCache(store)
  const cached = cache.get(skill.id)
  if (cached && cached.version === skill.currentVersion && cached.profileVersion === profileVersion && cached.name === skill.name) {
    const metadataHash = getCurrentVersionPackageHash(store, skill)
    if (metadataHash && metadataHash === cached.packageHash) {
      if (!cached.validation.valid) {
        return {
          skill,
          packageHash: cached.packageHash,
          artifactCount: cached.artifactCount,
          inclusion: {
            status: 'EXCLUDED',
            reason: 'INCOMPATIBLE',
            details: cached.validation.details,
            action: 'VIEW_SKILL'
          }
        }
      }
      return {
        skill,
        packageHash: cached.packageHash,
        artifactCount: cached.artifactCount,
        inclusion: {
          status: 'INCLUDED',
          adaptedFileCount: cached.validation.adaptedFileCount
        }
      }
    }
  }

  const detail = store.get(skill.id)
  const validation = validateGeminiSkill(detail)
  const artifactCount = Object.keys(detail.current.package.artifacts ?? {}).length

  cache.set(skill.id, {
    version: skill.currentVersion,
    packageHash: detail.current.packageHash,
    profileVersion,
    name: skill.name,
    artifactCount,
    validation
  })

  if (!validation.valid) {
    return {
      skill,
      packageHash: detail.current.packageHash,
      artifactCount,
      inclusion: {
        status: 'EXCLUDED',
        reason: 'INCOMPATIBLE',
        details: validation.details,
        action: 'VIEW_SKILL'
      }
    }
  }

  return {
    skill,
    packageHash: detail.current.packageHash,
    artifactCount,
    inclusion: {
      status: 'INCLUDED',
      adaptedFileCount: validation.adaptedFileCount
    }
  }
}

export interface GeminiInclusionResult {
  status: 'INCLUDED' | 'NOT_APPLICABLE' | 'EXCLUDED'
  reason?: AcademyGeminiExclusionReason
  details?: string
  action?: AcademyGeminiExcludedSkill['action']
  adaptedFileCount?: number
}

export function geminiInclusion(store: AcademyStore, skill: AcademySkillSummary): GeminiInclusionResult {
  return evaluateSkillWithCache(store, skill, GEMINI_ADAPTATION_PROFILE_VERSION, store.usesGitFirst()).inclusion
}

export interface CanonicalGeminiSnapshotEntry {
  skillId: string
  name: string
  academyVersion: number
  packageHash: string
}

export interface CanonicalGeminiSnapshot {
  profileVersion: string
  entries: CanonicalGeminiSnapshotEntry[]
}

export interface GeminiCatalogEvaluation {
  coverage: AcademyGeminiCoverage
  canonicalSnapshot: CanonicalGeminiSnapshot
  canonicalSnapshotHash: string
  eligibleSkills: AcademySkillSummary[]
}

/**
 * Avalia o catálogo completo da Academy em passagem única, calculando
 * cobertura, snapshot canônico e lista de skills elegíveis sem validações
 * duplicadas no processo Main.
 */
export function evaluateGeminiCatalog(
  store: AcademyStore,
  latestExport: AcademyGeminiExportReceipt | null,
  profileVersion = GEMINI_ADAPTATION_PROFILE_VERSION
): GeminiCatalogEvaluation {
  restoreGeminiReceiptExclusions(store, latestExport, profileVersion)
  const gitFirst = store.usesGitFirst()
  const skills = store.list()

  let catalog = 0
  let notApplicable = 0
  let adaptedCount = 0
  const includedIds = new Set<string>()
  const includedById = new Map<string, EvaluatedGeminiSkill>()
  const excluded: AcademyGeminiExcludedSkill[] = []
  const snapshotEntries: CanonicalGeminiSnapshotEntry[] = []
  const eligibleSkills: AcademySkillSummary[] = []
  const skillsByName = new Map<string, AcademySkillSummary>()

  for (const skill of skills) {
    skillsByName.set(skill.name, skill)
    const evaluated = evaluateSkillWithCache(store, skill, profileVersion, gitFirst)
    const { inclusion } = evaluated

    if (inclusion.status !== 'EXCLUDED' || inclusion.reason !== 'REMOVED') {
      catalog++
    }

    if (inclusion.status === 'NOT_APPLICABLE') {
      notApplicable++
    } else if (inclusion.status === 'INCLUDED') {
      includedIds.add(skill.id)
      includedById.set(skill.id, evaluated)
      eligibleSkills.push(skill)
      if ((inclusion.adaptedFileCount ?? 0) > 0) {
        adaptedCount++
      }
      snapshotEntries.push({
        skillId: skill.id,
        name: skill.name,
        academyVersion: skill.currentVersion,
        packageHash: evaluated.packageHash!
      })
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

  snapshotEntries.sort((a, b) => a.skillId.localeCompare(b.skillId))
  const canonicalSnapshot: CanonicalGeminiSnapshot = {
    profileVersion,
    entries: snapshotEntries
  }
  const canonicalSnapshotHash = hashGeminiSnapshot(canonicalSnapshot)

  const shippedSkills = new Map(latestExport?.skills.map((s) => [s.name, s]))
  let awaitingZip = 0

  if (latestExport) {
    if (latestExport.profileVersion !== profileVersion) {
      awaitingZip = includedIds.size
    } else {
      for (const [skillId, evaluated] of includedById.entries()) {
        const shipped = shippedSkills.get(evaluated.skill.name)
        if (!shipped) {
          awaitingZip++
        } else if (shipped.packageHash) {
          if (shipped.packageHash !== evaluated.packageHash) {
            awaitingZip++
          }
        } else {
          const expectedCount = (evaluated.artifactCount ?? 0) + 1
          if (shipped.entryCount !== expectedCount) {
            awaitingZip++
          }
        }
        void skillId
      }
      for (const shippedName of shippedSkills.keys()) {
        const current = skillsByName.get(shippedName)
        if (!current || !includedIds.has(current.id)) {
          awaitingZip++
        }
      }
    }
  } else {
    awaitingZip = includedIds.size
  }

  return {
    coverage: {
      catalog,
      eligible: includedIds.size,
      includedInLastZip: latestExport ? latestExport.skillCount : null,
      awaitingZip,
      notApplicable,
      adaptedCount,
      excluded
    },
    canonicalSnapshot,
    canonicalSnapshotHash,
    eligibleSkills
  }
}

export function buildCanonicalGeminiSnapshot(store: AcademyStore): CanonicalGeminiSnapshot {
  return evaluateGeminiCatalog(store, null, GEMINI_ADAPTATION_PROFILE_VERSION).canonicalSnapshot
}

export function hashGeminiSnapshot(snapshot: CanonicalGeminiSnapshot): string {
  return sha256(canonicalJson(snapshot))
}

export function buildGeminiCoverage(
  store: AcademyStore,
  latestExport: AcademyGeminiExportReceipt | null
): AcademyGeminiCoverage {
  return evaluateGeminiCatalog(store, latestExport, GEMINI_ADAPTATION_PROFILE_VERSION).coverage
}

export interface GeneratedGeminiSkillZip {
  name: string
  zipBuffer: Buffer
  zipSha256: string
  entryCount: number
  byteLength: number
  uncompressedBytes: number
  adaptedFiles: AdaptedFileMapping[]
}

export function createGeminiSkillZip(detail: { name: string; current: { package: AcademyPackage } }): GeneratedGeminiSkillZip {
  const adaptation = adaptGeminiPackage(detail.current.package)
  if (adaptation.rejectionReason) {
    throw new Error(`Falha ao adaptar skill '${detail.name}': ${adaptation.rejectionReason}`)
  }

  const derived = adaptation.package
  const entries: ZipEntry[] = [
    {
      path: 'SKILL.md',
      data: Buffer.from(derived.skillMd, 'utf8')
    }
  ]

  for (const [path, content] of Object.entries(derived.artifacts ?? {})) {
    entries.push({
      path: posix.normalize(path),
      data: Buffer.from(content, 'utf8')
    })
  }

  const uncompressedBytes = entries.reduce((sum, entry) => sum + entry.data.byteLength, 0)
  if (uncompressedBytes > GEMINI_MAX_SKILL_BYTES) {
    throw new Error(
      `Falha ao adaptar skill '${detail.name}': Tamanho total da Skill (${uncompressedBytes} bytes) excede o limite de 100MB do Gemini Web.`
    )
  }

  entries.sort((a, b) => a.path.localeCompare(b.path))
  const zipBuffer = createDeterministicZip(entries)

  return {
    name: detail.name,
    zipBuffer,
    zipSha256: sha256(zipBuffer),
    entryCount: entries.length,
    byteLength: zipBuffer.length,
    uncompressedBytes,
    adaptedFiles: adaptation.adaptedFiles
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

export interface AcademyGeminiExportTask {
  kind: 'gemini-export'
  exportDirectory: string
  masterZipPath: string
  receiptPath: string
  downloadsPath?: string
  snapshotHash: string
  profileVersion?: string
  skills: Array<{
    id: string
    name: string
    version: number
    packageHash: string
    package: AcademyPackage
  }>
  carriedExcludedSkills?: AcademyGeminiWorkerExcludedSkill[]
  _failStage?: 'stage-zip' | 'stage-receipt' | 'promote'
}

async function safeMove(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination)
  } catch {
    await copyFile(source, destination)
    await unlink(source).catch(() => {})
  }
}

export async function executeGeminiExport(
  task: AcademyGeminiExportTask,
  phase?: (name: string, durationMs: number) => void
): Promise<AcademyPluginTaskResult> {
  const phases: Record<string, number> = {}
  let start = performance.now()
  const recordPhase = (name: string) => {
    const elapsed = performance.now() - start
    phases[name] = elapsed
    phase?.(name, elapsed)
    start = performance.now()
  }

  const profileVersion = task.profileVersion ?? GEMINI_ADAPTATION_PROFILE_VERSION
  const skillZips: Array<GeneratedGeminiSkillZip & { packageHash: string }> = []
  const excludedById = new Map<string, AcademyGeminiWorkerExcludedSkill>()
  for (const carried of task.carriedExcludedSkills ?? []) {
    if (carried.profileVersion === profileVersion) {
      excludedById.set(carried.skillId, carried)
    }
  }
  const includedEntries: CanonicalGeminiSnapshotEntry[] = []
  let convertedCount = 0

  for (const skill of task.skills) {
    try {
      const generated = createGeminiSkillZip({
        name: skill.name,
        current: { package: skill.package }
      })
      if (generated.adaptedFiles.length > 0) {
        convertedCount++
      }
      skillZips.push({
        ...generated,
        packageHash: skill.packageHash
      })
      includedEntries.push({
        skillId: skill.id,
        name: skill.name,
        academyVersion: skill.version,
        packageHash: skill.packageHash
      })
      excludedById.delete(skill.id)
    } catch (error) {
      excludedById.set(skill.id, {
        skillId: skill.id,
        name: skill.name,
        version: skill.version,
        packageHash: skill.packageHash,
        profileVersion,
        details: error instanceof Error ? error.message : String(error)
      })
    }
  }
  recordPhase('skillCompressionMs')

  const excludedSkills = [...excludedById.values()].sort((a, b) => a.name.localeCompare(b.name))
  const master = createGeminiMasterZip(skillZips)
  recordPhase('masterCompressionMs')

  const snapshotHash = hashGeminiSnapshot({
    profileVersion,
    entries: includedEntries.sort((a, b) => a.skillId.localeCompare(b.skillId))
  })

  const receipt: AcademyGeminiExportReceipt = {
    exportId: randomUUID(),
    exportedAt: new Date().toISOString(),
    snapshotHash,
    profileVersion,
    artifactPath: task.masterZipPath,
    artifactHash: master.masterHash,
    skillCount: skillZips.length,
    convertedCount,
    totalBytes: master.totalBytes,
    skills: skillZips.map((s) => ({
      name: s.name,
      packageHash: s.packageHash,
      zipSha256: s.zipSha256,
      entryCount: s.entryCount,
      byteLength: s.byteLength,
      adaptedFiles: s.adaptedFiles.length > 0 ? s.adaptedFiles : undefined
    })),
    ...(excludedSkills.length > 0 ? { excludedSkills } : {})
  }
  const receiptJson = Buffer.from(JSON.stringify(receipt, null, 2), 'utf8')

  await mkdir(task.exportDirectory, { recursive: true })

  // Stage new artifacts in temporary files first to protect existing valid export
  const stagedZipPath = `${task.masterZipPath}.${randomUUID()}.stage`
  const stagedReceiptPath = `${task.receiptPath}.${randomUUID()}.stage`
  let stagedDownloadPath: string | null = null

  if (task.downloadsPath) {
    try {
      await mkdir(task.downloadsPath, { recursive: true })
      stagedDownloadPath = `${join(task.downloadsPath, 'academy-gemini.zip')}.${randomUUID()}.stage`
    } catch {
      stagedDownloadPath = null
    }
  }

  try {
    if (task._failStage === 'stage-zip') {
      throw new Error('SIMULATED_STAGE_ZIP_FAILURE')
    }
    await writeFile(stagedZipPath, master.masterBuffer)

    if (task._failStage === 'stage-receipt') {
      throw new Error('SIMULATED_STAGE_RECEIPT_FAILURE')
    }
    await writeFile(stagedReceiptPath, receiptJson)

    if (stagedDownloadPath) {
      try {
        await writeFile(stagedDownloadPath, master.masterBuffer)
      } catch {
        stagedDownloadPath = null
      }
    }
    recordPhase('diskWriteMs')

    // Two-phase promotion with rollback preservation of previous artifacts
    let backupZipPath: string | null = null
    let backupReceiptPath: string | null = null

    try {
      if (existsSync(task.masterZipPath)) {
        backupZipPath = `${task.masterZipPath}.${randomUUID()}.bak`
        await safeMove(task.masterZipPath, backupZipPath)
      }
      if (existsSync(task.receiptPath)) {
        backupReceiptPath = `${task.receiptPath}.${randomUUID()}.bak`
        await safeMove(task.receiptPath, backupReceiptPath)
      }

      if (task._failStage === 'promote') {
        throw new Error('SIMULATED_PROMOTE_FAILURE')
      }

      await safeMove(stagedZipPath, task.masterZipPath)
      await safeMove(stagedReceiptPath, task.receiptPath)

      if (stagedDownloadPath && task.downloadsPath) {
        const downloadDest = join(task.downloadsPath, 'academy-gemini.zip')
        try {
          await safeMove(stagedDownloadPath, downloadDest)
        } catch {
          await unlink(stagedDownloadPath).catch(() => {})
        }
      }

      // Promotion succeeded: remove backups
      if (backupZipPath) await unlink(backupZipPath).catch(() => {})
      if (backupReceiptPath) await unlink(backupReceiptPath).catch(() => {})
    } catch (promotionError) {
      // Rollback to restore previous valid export
      if (backupZipPath && existsSync(backupZipPath)) {
        await safeMove(backupZipPath, task.masterZipPath).catch(() => {})
      }
      if (backupReceiptPath && existsSync(backupReceiptPath)) {
        await safeMove(backupReceiptPath, task.receiptPath).catch(() => {})
      }
      throw promotionError
    }

    recordPhase('receiptWriteMs')

    return {
      artifactPath: task.masterZipPath,
      artifactHash: master.masterHash,
      receipt,
      phases,
      ...(excludedSkills.length > 0 ? { excludedSkills } : {})
    }
  } finally {
    // Always clean up any leftover staging files
    await unlink(stagedZipPath).catch(() => {})
    await unlink(stagedReceiptPath).catch(() => {})
    if (stagedDownloadPath) {
      await unlink(stagedDownloadPath).catch(() => {})
    }
  }
}
