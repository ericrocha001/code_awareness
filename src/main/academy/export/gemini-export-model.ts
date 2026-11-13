import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { extname, join, posix } from 'node:path'
import type {
  AcademyGeminiCoverage,
  AcademyGeminiExcludedSkill,
  AcademyGeminiExclusionReason,
  AcademyGeminiExportReceipt,
  AcademyGeminiSkillExportEntry,
  AcademyPackage,
  AcademySkillDetail,
  AcademySkillSummary
} from '../../../shared/types/academy-types'
import type { AcademyStore } from '../academy-store'
import { createDeterministicZip, type ZipEntry } from '../publication/deterministic-zip'
import type { AcademyPluginTaskResult } from '../publication/academy-plugin-executor'

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
  const matches = content.match(/`+/g)
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
  rejectionReason?: string
}

export function adaptGeminiPackage(canonicalPackage: AcademyPackage): GeminiPackageAdaptationResult {
  const adaptedFiles: AdaptedFileMapping[] = []
  const derivedArtifacts: Record<string, string> = {}
  const occupiedPaths = new Set<string>()

  for (const [rawPath, content] of Object.entries(canonicalPackage.artifacts ?? {})) {
    if (rawPath.includes('\\') || rawPath.startsWith('/') || rawPath.split('/').includes('..')) {
      return {
        package: canonicalPackage,
        adaptedFiles: [],
        rejectionReason: `Caminho de artefato inválido '${rawPath}': caminhos não podem conter barras invertidas, iniciar com barra ou conter '..'.`
      }
    }
    const normalized = posix.normalize(rawPath)
    if (normalized === 'SKILL.md') {
      return {
        package: canonicalPackage,
        adaptedFiles: [],
        rejectionReason: `Artefato não pode sobrescrever 'SKILL.md'.`
      }
    }

    const ext = extname(normalized).toLowerCase()

    if (GEMINI_REJECTED_AUDIO_VIDEO_EXTENSIONS.has(ext)) {
      return {
        package: canonicalPackage,
        adaptedFiles: [],
        rejectionReason: `Arquivo '${rawPath}' possui extensão '${ext}' (áudio/vídeo), não suportada dentro de arquivos ZIP no Gemini Web.`
      }
    }

    if (GEMINI_REJECTED_BINARY_EXTENSIONS.has(ext) || content.includes('\0')) {
      return {
        package: canonicalPackage,
        adaptedFiles: [],
        rejectionReason: `Arquivo '${rawPath}' é binário ou não conversível para referência textual no Gemini Web.`
      }
    }

    if (GEMINI_NATIVE_ALLOWED_EXTENSIONS.has(ext)) {
      if (occupiedPaths.has(normalized)) {
        return {
          package: canonicalPackage,
          adaptedFiles: [],
          rejectionReason: `Colisão de caminho: '${normalized}' já está registrado no pacote.`
        }
      }
      occupiedPaths.add(normalized)
      derivedArtifacts[normalized] = content
      continue
    }

    if (GEMINI_ADAPTABLE_CODE_EXTENSIONS.has(ext)) {
      const adaptedPath = mapAdaptedPath(normalized)
      if (occupiedPaths.has(adaptedPath) || (canonicalPackage.artifacts && adaptedPath in canonicalPackage.artifacts)) {
        return {
          package: canonicalPackage,
          adaptedFiles: [],
          rejectionReason: `Colisão de caminho ao adaptar '${rawPath}' para '${adaptedPath}': caminho de destino já ocupado.`
        }
      }
      occupiedPaths.add(adaptedPath)
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

    return {
      package: canonicalPackage,
      adaptedFiles: [],
      rejectionReason: `Arquivo '${rawPath}' possui extensão '${ext || '(sem extensão)'}' não suportada pelo Gemini Web.`
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

  return {
    package: {
      skillMd: derivedSkillMd,
      artifacts: derivedArtifacts
    },
    adaptedFiles
  }
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

  const adaptation = adaptGeminiPackage(detail.current.package)
  if (adaptation.rejectionReason) {
    return {
      valid: false,
      details: adaptation.rejectionReason
    }
  }

  const derived = adaptation.package
  let totalBytes = Buffer.byteLength(derived.skillMd, 'utf8')
  for (const content of Object.values(derived.artifacts ?? {})) {
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

export interface CanonicalGeminiSnapshot {
  profileVersion: string
  entries: CanonicalGeminiSnapshotEntry[]
}

export function buildCanonicalGeminiSnapshot(store: AcademyStore): CanonicalGeminiSnapshot {
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
  entries.sort((a, b) => a.skillId.localeCompare(b.skillId))
  return {
    profileVersion: GEMINI_ADAPTATION_PROFILE_VERSION,
    entries
  }
}

export function hashGeminiSnapshot(snapshot: CanonicalGeminiSnapshot): string {
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
  let adaptedCount = 0

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
      const detail = store.get(skill.id)
      const adaptation = adaptGeminiPackage(detail.current.package)
      if (adaptation.adaptedFiles.length > 0) {
        adaptedCount++
      }
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
    if (latestExport.profileVersion !== GEMINI_ADAPTATION_PROFILE_VERSION) {
      awaitingZip = includedIds.size
    } else {
      for (const skillId of includedIds) {
        const skill = store.get(skillId)
        const shipped = shippedSkills.get(skill.name)
        if (!shipped) {
          awaitingZip++
        } else if (shipped.packageHash) {
          if (shipped.packageHash !== skill.current.packageHash) {
            awaitingZip++
          }
        } else {
          const adaptation = adaptGeminiPackage(skill.current.package)
          const expectedCount = Object.keys(adaptation.package.artifacts ?? {}).length + 1
          if (shipped.entryCount !== expectedCount) {
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
    adaptedCount,
    excluded
  }
}

export interface GeneratedGeminiSkillZip {
  name: string
  zipBuffer: Buffer
  zipSha256: string
  entryCount: number
  byteLength: number
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

  entries.sort((a, b) => a.path.localeCompare(b.path))
  const zipBuffer = createDeterministicZip(entries)

  return {
    name: detail.name,
    zipBuffer,
    zipSha256: sha256(zipBuffer),
    entryCount: entries.length,
    byteLength: zipBuffer.length,
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
    packageHash: string
    package: AcademyPackage
  }>
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

  const skillZips: Array<GeneratedGeminiSkillZip & { packageHash: string }> = []
  let convertedCount = 0
  for (const skill of task.skills) {
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
  }
  recordPhase('skillCompressionMs')

  const master = createGeminiMasterZip(skillZips)
  recordPhase('masterCompressionMs')

  const receipt: AcademyGeminiExportReceipt = {
    exportId: randomUUID(),
    exportedAt: new Date().toISOString(),
    snapshotHash: task.snapshotHash,
    profileVersion: task.profileVersion ?? GEMINI_ADAPTATION_PROFILE_VERSION,
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
    }))
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
      phases
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
