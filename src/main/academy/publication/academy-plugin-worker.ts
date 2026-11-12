import { parentPort, workerData } from 'node:worker_threads'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, link, unlink } from 'node:fs/promises'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AcademyGitSourceSnapshot } from '../../../shared/types/academy-git-source-types'
import type { AcademyBuildProjection } from '../../../shared/types/academy-publication-types'
import type { AcademyOpenAiPluginProfile } from '../../../shared/types/academy-types'
import { AcademyError } from '../academy-package'
import { assertAcademyPathHasNoLinks } from '../academy-filesystem'
import { assertSourcePath } from '../git/academy-git-materializer'
import { buildGitOpenAiInput, canonicalJson, gitOpenAiValidationProfile, sha256 } from './openai-plugin-model'
import { createDeterministicZip, readZipEntries, type ZipEntry } from './deterministic-zip'
import { validateOpenAiPluginPackage } from './openai-plugin-validator'
import { executeGeminiExport, type AcademyGeminiExportTask } from '../export/gemini-export-model'

export type AcademyPluginTask =
  | {
      kind: 'inventory' | 'build' | 'verify' | 'source-check'
      snapshotJson?: string
      suppliedSnapshot?: AcademyGitSourceSnapshot
      projection?: AcademyBuildProjection
      profile: AcademyOpenAiPluginProfile
      storageRoot?: string
      artifactPath?: string
      expectedZipSha?: string
      downloadsPath?: string
      sealed?: { entries: Array<{ path: string; data: string }>; fingerprint: string }
    }
  | AcademyGeminiExportTask

function safeArtifact(root: string, file: string): void {
  const rel = relative(root, file)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new AcademyError('OPENAI_RELEASE_UNSAFE_PATH')
  assertAcademyPathHasNoLinks(file)
}

function entriesFingerprint(entries: ZipEntry[]): string {
  return sha256(canonicalJson([...entries].sort((a, b) => a.path.localeCompare(b.path)).map(entry => ({ path: entry.path, sha256: sha256(entry.data) }))))
}

async function promote(file: string, bytes: Buffer, expectedHash: string): Promise<void> {
  assertAcademyPathHasNoLinks(file)
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    try { await link(temporary, file) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if ((await lstat(file)).isSymbolicLink() || sha256(await readFile(file)) !== expectedHash) throw new AcademyError('OPENAI_RELEASE_ARTIFACT_DRIFT')
    }
  } finally { await unlink(temporary).catch(() => {}) }
}

async function execute(task: AcademyPluginTask) {
  if (task.kind === 'gemini-export') {
    return executeGeminiExport(task, (name, durationMs) => {
      parentPort?.postMessage({ phase: name, durationMs })
    })
  }
  const phases: Record<string, number> = {}
  let start = performance.now()
  const phase = (name: string) => { phases[name] = performance.now() - start; parentPort?.postMessage({ phase: name, durationMs: phases[name] }); start = performance.now() }
  if (task.snapshotJson && task.suppliedSnapshot && canonicalJson(JSON.parse(task.snapshotJson)) !== canonicalJson(task.suppliedSnapshot)) throw new AcademyError('GIT_SOURCE_SNAPSHOT_NOT_VERIFIED')
  if (task.kind === 'source-check') return { phases }
  if (task.kind === 'inventory') {
    const source = JSON.parse(task.snapshotJson!) as AcademyGitSourceSnapshot
    const input = buildGitOpenAiInput(null, source)
    phase('inventoryHashingMs')
    validateOpenAiPluginPackage(input.entries, gitOpenAiValidationProfile(task.profile, input), input.snapshot)
    phase('validationMs')
    const projection: AcademyBuildProjection = { schema: 1, normalizationSchema: 1, sourceRepositoryId: source.repositoryId,
      sourceCommitSha: source.sourceCommitSha, managedTreeHash: source.managedTreeHash, manifest: input.manifest, pluginVersion: input.pluginVersion,
      manifestFingerprint: input.manifestFingerprint, assetFingerprint: input.assetFingerprint, entriesFingerprint: input.entriesFingerprint,
      snapshot: input.snapshot, entryCount: input.entries.length }
    return { projection, phases }
  }
  const projection = task.projection!
  const profile = { ...task.profile, logoPath: projection.assetFingerprint !== sha256('NO_ASSET') ? 'git:assets/logo.png' : null }
  const artifactPath = task.artifactPath!
  safeArtifact(task.storageRoot!, artifactPath)
  let archive: Buffer
  if (task.kind === 'verify') {
    if (!task.expectedZipSha || !(await lstat(artifactPath)).isFile()) throw new AcademyError('OPENAI_RELEASE_ARTIFACT_DRIFT')
    archive = await readFile(artifactPath)
    if (sha256(archive) !== task.expectedZipSha) throw new AcademyError('OPENAI_RELEASE_ARTIFACT_DRIFT')
  } else {
    let entries: ZipEntry[]
    if (task.sealed) {
      entries = task.sealed.entries.map(entry => ({ path: entry.path, data: Buffer.from(entry.data, 'base64') }))
      if (entriesFingerprint(entries) !== task.sealed.fingerprint || task.sealed.fingerprint !== projection.entriesFingerprint) throw new AcademyError('OPENAI_SEALED_SNAPSHOT_MISMATCH')
    } else {
      const source = JSON.parse(task.snapshotJson!) as AcademyGitSourceSnapshot
      if (source.repositoryId !== projection.sourceRepositoryId || source.sourceCommitSha !== projection.sourceCommitSha || source.managedTreeHash !== projection.managedTreeHash) throw new AcademyError('GIT_SOURCE_SNAPSHOT_NOT_VERIFIED')
      const manifest = JSON.parse(Buffer.from(source.authoredFiles['plugin.json'], 'base64').toString('utf8'))
      if (manifest.version !== projection.pluginVersion || sha256(canonicalJson(manifest)) !== projection.manifestFingerprint) throw new AcademyError('GIT_SOURCE_SNAPSHOT_NOT_VERIFIED')
      entries = Object.entries(source.authoredFiles).filter(([path]) => path !== '.academy/identities.json').map(([path, encoded]) => {
        assertSourcePath(path)
        return { path: `academy-skills/${path}`, data: path === 'plugin.json' ? Buffer.from(`${canonicalJson(manifest)}\n`) : Buffer.from(encoded, 'base64') }
      })
    }
    if (entries.length !== projection.entryCount) throw new AcademyError('GIT_SOURCE_INVENTORY_MISMATCH')
    validateOpenAiPluginPackage(entries, profile, projection.snapshot)
    archive = createDeterministicZip(entries)
    phase('compressionMs')
  }
  const hash = sha256(archive)
  if (task.expectedZipSha && hash !== task.expectedZipSha) throw new AcademyError('OPENAI_RELEASE_HASH_MISMATCH')
  const contents = readZipEntries(archive)
  validateOpenAiPluginPackage(contents, profile, projection.snapshot)
  if (contents.length !== projection.entryCount || entriesFingerprint(contents) !== projection.entriesFingerprint) throw new AcademyError('OPENAI_RELEASE_HASH_MISMATCH')
  phase('zipVerificationMs')
  if (task.kind === 'build') await promote(artifactPath, archive, hash)
  if (task.downloadsPath) {
    const destination = join(task.downloadsPath, `academy-skills-${projection.pluginVersion}.zip`)
    assertAcademyPathHasNoLinks(destination)
    let existing: Buffer | null = null
    try { existing = await readFile(destination) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (existing && sha256(existing) !== hash) throw new AcademyError('OPENAI_PLUGIN_DOWNLOAD_COPY_MISMATCH')
    if (!existing) await promote(destination, archive, hash)
  }
  phase('promotionCopyMs')
  return { artifactPath, artifactHash: hash, phases, reused: task.kind === 'verify' }
}

if (parentPort) void execute(workerData as AcademyPluginTask).then(result => parentPort!.postMessage({ result }), error => parentPort!.postMessage({ error: { code: error.code ?? 'ACADEMY_PACKAGE_BUILD_FAILED', message: error.message, details: error.details } })).finally(() => parentPort!.close())
