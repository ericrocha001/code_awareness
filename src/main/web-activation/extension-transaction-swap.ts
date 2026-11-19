import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { assertCanonicalRealPath, writeJsonAtomic } from './extension-enrollment-store'
import type { BuildArtifactMetadata, ManagedInstallationEnrollment } from './extension-manager-types'

export interface SwapJournalRecord {
  schemaVersion: 1
  operationId: string
  targetBuildId: string
  phase: 'PREPARING' | 'SWAPPING_EXT' | 'SWAPPING_HOST' | 'COMMITTED' | 'ROLLING_BACK' | 'ROLLED_BACK'
  unpackedPath: string
  nextExtTempDir: string
  backupExtDir: string
  targetHostFile: string
  nextHostTempFile: string
  backupHostFile: string
  startedAt: string
  updatedAt: string
  error?: string
}

export function sha256File(filePath: string): { sha256: string; bytes: number } {
  const buf = readFileSync(filePath)
  return {
    sha256: createHash('sha256').update(buf).digest('hex'),
    bytes: buf.length
  }
}

export function verifyBuildArtifactsIntegrity(metadata: BuildArtifactMetadata): void {
  const extEntries = Object.entries(metadata.extFiles)
  if (extEntries.length === 0) {
    throw new Error('BUILD_METADATA_EMPTY_EXT_FILES')
  }
  for (const [name, expected] of extEntries) {
    const filePath = join(metadata.extOutDir, name)
    if (!existsSync(filePath)) {
      throw new Error(`STAGED_EXT_FILE_MISSING:${name}`)
    }
    const actual = sha256File(filePath)
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
      throw new Error(`STAGED_EXT_HASH_MISMATCH:${name}`)
    }
  }

  const hostEntry = metadata.hostFiles['native-host.cjs']
  if (!hostEntry) {
    throw new Error('BUILD_METADATA_MISSING_HOST_BUNDLE')
  }
  const hostPath = join(metadata.hostOutDir, 'native-host.cjs')
  if (!existsSync(hostPath)) {
    throw new Error('STAGED_HOST_FILE_MISSING:native-host.cjs')
  }
  const actualHost = sha256File(hostPath)
  if (actualHost.sha256 !== hostEntry.sha256 || actualHost.bytes !== hostEntry.bytes) {
    throw new Error('STAGED_HOST_HASH_MISMATCH:native-host.cjs')
  }
}

export function resolveLiveHostTargetFile(hostScriptPath: string): string {
  const resolved = resolve(hostScriptPath)
  if (basename(resolved).toLowerCase() === 'native-host.cjs' && existsSync(resolved)) {
    const contents = readFileSync(resolved, 'utf8')
    if (contents.includes('native-host.bundle.cjs')) {
      return join(dirname(resolved), 'native-host.bundle.cjs')
    }
  }
  return resolved
}

function renameWithRetrySync(fromPath: string, toPath: string, attempts = 8): void {
  let lastErr: unknown
  for (let i = 0; i < attempts; i += 1) {
    try {
      renameSync(fromPath, toPath)
      return
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : ''
      if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && i + 1 < attempts) {
        const until = Date.now() + 20 * (i + 1)
        while (Date.now() < until) {
          // Short bounded synchronous wait during atomic directory/file swap retry
        }
        lastErr = err
        continue
      }
      throw err
    }
  }
  throw lastErr
}

function verifyNativeHostManifestPreserved(enrollment: ManagedInstallationEnrollment): void {
  const hostManifestPath = join(enrollment.hostInstallDir, `${enrollment.nativeHostApplication}.json`)
  if (!existsSync(hostManifestPath)) {
    return
  }
  const parsed = JSON.parse(readFileSync(hostManifestPath, 'utf8')) as {
    name?: unknown
    allowed_origins?: unknown
  }
  if (parsed.name !== enrollment.nativeHostApplication) {
    throw new Error(`NATIVE_HOST_MANIFEST_NAME_MISMATCH:${String(parsed.name)}`)
  }
  const origins = Array.isArray(parsed.allowed_origins) ? parsed.allowed_origins : []
  const normalizedOrigins = origins.map((entry) => String(entry).trim().toLowerCase())
  if (!normalizedOrigins.includes(enrollment.allowedOrigin.toLowerCase())) {
    throw new Error(`NATIVE_HOST_ORIGIN_NOT_ALLOWED:${enrollment.allowedOrigin}`)
  }
}

function rollbackJournal(journal: SwapJournalRecord, journalPath: string, err?: unknown): void {
  const updating: SwapJournalRecord = {
    ...journal,
    phase: 'ROLLING_BACK',
    updatedAt: new Date().toISOString(),
    error: err instanceof Error ? err.message : err ? String(err) : journal.error
  }
  try {
    writeJsonAtomic(journalPath, updating)
  } catch {
    // Best-effort journal update during rollback
  }

  try {
    if (existsSync(journal.backupHostFile)) {
      if (existsSync(journal.targetHostFile)) {
        rmSync(journal.targetHostFile, { force: true })
      }
      renameWithRetrySync(journal.backupHostFile, journal.targetHostFile)
    }
  } catch {
    // Preserve error details below
  }

  try {
    if (existsSync(journal.backupExtDir)) {
      if (existsSync(journal.unpackedPath)) {
        rmSync(journal.unpackedPath, { recursive: true, force: true })
      }
      renameWithRetrySync(journal.backupExtDir, journal.unpackedPath)
    }
  } catch {
    // Preserve error details below
  }

  try {
    rmSync(journal.nextExtTempDir, { recursive: true, force: true })
  } catch {}
  try {
    if (existsSync(journal.nextHostTempFile)) unlinkSync(journal.nextHostTempFile)
  } catch {}

  try {
    writeJsonAtomic(journalPath, {
      ...updating,
      phase: 'ROLLED_BACK',
      updatedAt: new Date().toISOString()
    } satisfies SwapJournalRecord)
  } catch {}
}

/**
 * Recovers any incomplete swap journal left behind by an unexpected crash before reload.
 */
export function recoverPendingSwapJournal(managerDir: string): SwapJournalRecord | null {
  const journalPath = join(managerDir, 'swap-journal.json')
  if (!existsSync(journalPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(journalPath, 'utf8')) as Partial<SwapJournalRecord>
    if (
      !parsed ||
      parsed.schemaVersion !== 1 ||
      typeof parsed.unpackedPath !== 'string' ||
      typeof parsed.backupExtDir !== 'string' ||
      typeof parsed.targetHostFile !== 'string' ||
      typeof parsed.backupHostFile !== 'string'
    ) {
      return null
    }
    const journal = parsed as SwapJournalRecord
    if (journal.phase === 'SWAPPING_EXT' || journal.phase === 'SWAPPING_HOST' || journal.phase === 'ROLLING_BACK') {
      rollbackJournal(journal, journalPath, 'CRASH_RECOVERY_ROLLBACK')
      return journal
    }
    if (journal.phase === 'PREPARING') {
      rmSync(journal.nextExtTempDir, { recursive: true, force: true })
      if (existsSync(journal.nextHostTempFile)) rmSync(journal.nextHostTempFile, { force: true })
      rmSync(journalPath, { force: true })
    }
    return null
  } catch {
    return null
  }
}

/**
 * Atomically promotes verified staged extension and native host artifacts into live paths
 * on the same volume, retaining at most one backup and preserving existing allowed_origins.
 */
export function promoteStagedArtifactsTransactionally(options: {
  managerDir: string
  operationId: string
  enrollment: ManagedInstallationEnrollment
  metadata: BuildArtifactMetadata
}): { unpackedPath: string; targetHostFile: string; hostManifestPreserved: boolean } {
  const { managerDir, operationId, enrollment, metadata } = options
  const journalPath = join(managerDir, 'swap-journal.json')

  verifyBuildArtifactsIntegrity(metadata)
  assertCanonicalRealPath(enrollment.unpackedPath, 'unpackedPath', { mustExist: true, expectedType: 'dir' })
  assertCanonicalRealPath(enrollment.hostInstallDir, 'hostInstallDir', { mustExist: true, expectedType: 'dir' })
  assertCanonicalRealPath(enrollment.hostScriptPath, 'hostScriptPath', { mustExist: false })
  verifyNativeHostManifestPreserved(enrollment)

  const opSuffix = operationId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'swap'
  const extParent = dirname(enrollment.unpackedPath)
  const nextExtTempDir = join(extParent, `.ca-ext-next-${opSuffix}`)
  const backupExtDir = join(extParent, '.ca-ext-prev')
  const targetHostFile = resolveLiveHostTargetFile(enrollment.hostScriptPath)
  const hostParent = dirname(targetHostFile)
  const nextHostTempFile = join(hostParent, `.ca-host-next-${opSuffix}.cjs`)
  const backupHostFile = join(hostParent, `${basename(targetHostFile)}.prev`)

  mkdirSync(hostParent, { recursive: true })
  rmSync(nextExtTempDir, { recursive: true, force: true })
  if (existsSync(nextHostTempFile)) rmSync(nextHostTempFile, { force: true })

  const now = new Date().toISOString()
  let journal: SwapJournalRecord = {
    schemaVersion: 1,
    operationId,
    targetBuildId: metadata.buildId,
    phase: 'PREPARING',
    unpackedPath: enrollment.unpackedPath,
    nextExtTempDir,
    backupExtDir,
    targetHostFile,
    nextHostTempFile,
    backupHostFile,
    startedAt: now,
    updatedAt: now
  }

  writeJsonAtomic(journalPath, journal)

  try {
    mkdirSync(nextExtTempDir, { recursive: true })
    for (const [name, expected] of Object.entries(metadata.extFiles)) {
      const dest = join(nextExtTempDir, name)
      copyFileSync(join(metadata.extOutDir, name), dest)
      const actual = sha256File(dest)
      if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
        throw new Error(`SAME_VOLUME_STAGE_VERIFY_FAILED:${name}`)
      }
    }

    copyFileSync(join(metadata.hostOutDir, 'native-host.cjs'), nextHostTempFile)
    const expectedHost = metadata.hostFiles['native-host.cjs']
    const actualHost = sha256File(nextHostTempFile)
    if (actualHost.sha256 !== expectedHost.sha256 || actualHost.bytes !== expectedHost.bytes) {
      throw new Error('SAME_VOLUME_HOST_VERIFY_FAILED')
    }

    journal = { ...journal, phase: 'SWAPPING_EXT', updatedAt: new Date().toISOString() }
    writeJsonAtomic(journalPath, journal)

    if (existsSync(backupExtDir)) {
      rmSync(backupExtDir, { recursive: true, force: true })
    }
    if (existsSync(enrollment.unpackedPath)) {
      renameWithRetrySync(enrollment.unpackedPath, backupExtDir)
    }
    renameWithRetrySync(nextExtTempDir, enrollment.unpackedPath)

    journal = { ...journal, phase: 'SWAPPING_HOST', updatedAt: new Date().toISOString() }
    writeJsonAtomic(journalPath, journal)

    if (existsSync(backupHostFile)) {
      rmSync(backupHostFile, { force: true })
    }
    if (existsSync(targetHostFile)) {
      renameWithRetrySync(targetHostFile, backupHostFile)
    }
    renameWithRetrySync(nextHostTempFile, targetHostFile)

    journal = { ...journal, phase: 'COMMITTED', updatedAt: new Date().toISOString() }
    writeJsonAtomic(journalPath, journal)

    return {
      unpackedPath: enrollment.unpackedPath,
      targetHostFile,
      hostManifestPreserved: true
    }
  } catch (err) {
    rollbackJournal(journal, journalPath, err)
    throw err
  }
}

/**
 * Retains only recent staging directories up to the configured limit to avoid unbounded disk growth.
 */
export function pruneStagingDirectories(stagingRoot: string, retainDirNames: ReadonlySet<string>): void {
  if (!existsSync(stagingRoot)) return
  for (const entry of readdirSync(stagingRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (retainDirNames.has(entry.name)) continue
    rmSync(join(stagingRoot, entry.name), { recursive: true, force: true })
  }
}
