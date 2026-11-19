import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, normalize, parse, resolve, sep } from 'node:path'
import { normalizeExtensionAllowedOrigins } from './native-host-registration'
import { WEB_NATIVE_HOST_NAME } from './web-activation-types'
import type {
  BuildArtifactMetadata,
  EnrollManagedInstallationInput,
  ExtensionOperationRecord,
  ExtensionRuntimeAttestation,
  ManagedInstallationEnrollment
} from './extension-manager-types'

const MAX_STORED_OPERATIONS = 20

function normalizeComparePath(value: string): string {
  const normalized = normalize(resolve(value))
  if (process.platform === 'win32') {
    return normalized.toLowerCase()
  }
  return normalized
}

/**
 * Ensures a configured path is absolute, traversal-free, non-symlink/junction, and canonical.
 */
export function assertCanonicalRealPath(
  rawPath: string,
  label: string,
  options: { mustExist?: boolean; expectedType?: 'dir' | 'file' } = {}
): string {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new Error(`INVALID_PATH:${label}`)
  }
  const trimmed = rawPath.trim()
  if (!isAbsolute(trimmed)) {
    throw new Error(`RELATIVE_PATH_UNSUPPORTED:${label}:${trimmed}`)
  }
  if (trimmed.split(/[\\/]+/).includes('..')) {
    throw new Error(`PATH_TRAVERSAL_UNSUPPORTED:${label}:${trimmed}`)
  }

  const resolved = resolve(trimmed)
  const parsedRoot = parse(resolved).root
  const remainder = resolved.slice(parsedRoot.length).split(sep).filter(Boolean)

  let cursor = parsedRoot
  let deepestExisting = existsSync(parsedRoot) ? parsedRoot : ''
  for (const segment of remainder) {
    cursor = join(cursor, segment)
    if (!existsSync(cursor)) {
      if (lstatExists(cursor)) {
        // Broken symlink
        throw new Error(`SYMLINK_PATH_UNSUPPORTED:${label}:${cursor}`)
      }
      break
    }
    const stat = lstatSync(cursor)
    if (stat.isSymbolicLink()) {
      throw new Error(`SYMLINK_PATH_UNSUPPORTED:${label}:${cursor}`)
    }
    deepestExisting = cursor
  }

  if (deepestExisting) {
    const canonicalExisting = realpathSync(deepestExisting)
    if (normalizeComparePath(canonicalExisting) !== normalizeComparePath(deepestExisting)) {
      throw new Error(`SYMLINK_PATH_UNSUPPORTED:${label}:${deepestExisting}`)
    }
  }

  const mustExist = options.mustExist !== false
  if (!existsSync(resolved)) {
    if (mustExist) {
      throw new Error(`PATH_NOT_FOUND:${label}:${resolved}`)
    }
    const parent = dirname(resolved)
    if (!existsSync(parent)) {
      throw new Error(`PARENT_PATH_NOT_FOUND:${label}:${parent}`)
    }
    return resolved
  }

  const targetStat = statSync(resolved)
  if (options.expectedType === 'dir' && !targetStat.isDirectory()) {
    throw new Error(`EXPECTED_DIRECTORY:${label}:${resolved}`)
  }
  if (options.expectedType === 'file' && !targetStat.isFile()) {
    throw new Error(`EXPECTED_FILE:${label}:${resolved}`)
  }

  return resolved
}

function lstatExists(target: string): boolean {
  try {
    lstatSync(target)
    return true
  } catch {
    return false
  }
}

export function writeJsonAtomic(filePath: string, payload: unknown): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tempPath = join(dir, `.tmp-${process.pid}-${randomUUID()}.json`)
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  renameSync(tempPath, filePath)
}

export interface PersistedExtensionManagerState {
  schemaVersion: 1
  epoch: number
  lastValidBuild: BuildArtifactMetadata | null
  lastAttestation: ExtensionRuntimeAttestation | null
  operations: ExtensionOperationRecord[]
}

const DEFAULT_MANAGER_STATE: PersistedExtensionManagerState = {
  schemaVersion: 1,
  epoch: 0,
  lastValidBuild: null,
  lastAttestation: null,
  operations: []
}

/**
 * Durable single-installation enrollment and operation state store under profile userData.
 */
export class ExtensionEnrollmentStore {
  readonly baseDir: string
  readonly managerDir: string
  readonly enrollmentPath: string
  readonly statePath: string

  constructor(userDataPath: string) {
    if (typeof userDataPath !== 'string' || !userDataPath.trim()) {
      throw new Error('USER_DATA_PATH_REQUIRED')
    }
    this.baseDir = join(resolve(userDataPath), 'web-activation')
    this.managerDir = join(this.baseDir, 'manager')
    this.enrollmentPath = join(this.baseDir, 'enrollment.json')
    this.statePath = join(this.managerDir, 'manager-state.json')
  }

  loadEnrollment(): ManagedInstallationEnrollment | null {
    if (!existsSync(this.enrollmentPath)) return null
    try {
      const parsed = JSON.parse(readFileSync(this.enrollmentPath, 'utf8')) as Partial<ManagedInstallationEnrollment>
      if (
        !parsed ||
        parsed.schemaVersion !== 1 ||
        typeof parsed.enrollmentId !== 'string' ||
        typeof parsed.installationId !== 'string' ||
        typeof parsed.extensionId !== 'string' ||
        typeof parsed.allowedOrigin !== 'string' ||
        parsed.installType !== 'development' ||
        typeof parsed.profileId !== 'string' ||
        typeof parsed.unpackedPath !== 'string' ||
        typeof parsed.hostInstallDir !== 'string' ||
        typeof parsed.hostScriptPath !== 'string' ||
        typeof parsed.sourceRepoPath !== 'string'
      ) {
        return null
      }
      return {
        ...parsed,
        nativeHostApplication: parsed.nativeHostApplication || WEB_NATIVE_HOST_NAME,
        enabled: parsed.enabled === true
      } as ManagedInstallationEnrollment
    } catch {
      return null
    }
  }

  /**
   * Registers or updates the sole managed development installation enrollment.
   */
  enroll(
    input: EnrollManagedInstallationInput,
    options: { replace?: boolean } = {}
  ): ManagedInstallationEnrollment {
    if (input.installType && input.installType !== 'development') {
      throw new Error(`UNSUPPORTED_INSTALL_TYPE:${input.installType}`)
    }
    const [allowedOrigin] = normalizeExtensionAllowedOrigins([input.extensionId])
    const extensionId = allowedOrigin.slice('chrome-extension://'.length, -1)
    const profileId = typeof input.profileId === 'string' ? input.profileId.trim() : ''
    if (!profileId) {
      throw new Error('PROFILE_ID_REQUIRED')
    }

    const unpackedPath = assertCanonicalRealPath(input.unpackedPath, 'unpackedPath', {
      mustExist: true,
      expectedType: 'dir'
    })
    const hostInstallDir = assertCanonicalRealPath(input.hostInstallDir, 'hostInstallDir', {
      mustExist: true,
      expectedType: 'dir'
    })
    const hostScriptPath = assertCanonicalRealPath(input.hostScriptPath, 'hostScriptPath', {
      mustExist: false
    })
    const sourceRepoPath = assertCanonicalRealPath(input.sourceRepoPath, 'sourceRepoPath', {
      mustExist: true,
      expectedType: 'dir'
    })

    if (!existsSync(join(sourceRepoPath, 'scripts', 'web-activation', 'build.cjs'))) {
      throw new Error(`SOURCE_BUILD_SCRIPT_MISSING:${sourceRepoPath}`)
    }

    const existing = this.loadEnrollment()
    const installationId = (input.installationId?.trim() || existing?.installationId || randomUUID())
    if (existing && existing.enabled && !options.replace && existing.installationId !== installationId) {
      throw new Error(`ACTIVE_ENROLLMENT_EXISTS:${existing.installationId}`)
    }

    const now = new Date().toISOString()
    const record: ManagedInstallationEnrollment = {
      schemaVersion: 1,
      enrollmentId: existing?.enrollmentId ?? randomUUID(),
      installationId,
      extensionId,
      allowedOrigin,
      installType: 'development',
      profileId,
      ...(input.profileLabel?.trim() ? { profileLabel: input.profileLabel.trim() } : {}),
      unpackedPath,
      hostInstallDir,
      hostScriptPath,
      sourceRepoPath,
      nativeHostApplication: input.nativeHostApplication?.trim() || WEB_NATIVE_HOST_NAME,
      enabled: true,
      enrolledAt: existing?.enrolledAt ?? now,
      updatedAt: now,
      revokedAt: null
    }

    writeJsonAtomic(this.enrollmentPath, record)
    return record
  }

  revoke(): ManagedInstallationEnrollment | null {
    const existing = this.loadEnrollment()
    if (!existing) return null
    const now = new Date().toISOString()
    const updated: ManagedInstallationEnrollment = {
      ...existing,
      enabled: false,
      revokedAt: now,
      updatedAt: now
    }
    writeJsonAtomic(this.enrollmentPath, updated)
    return updated
  }

  loadState(): PersistedExtensionManagerState {
    if (!existsSync(this.statePath)) {
      return { ...DEFAULT_MANAGER_STATE, operations: [] }
    }
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<PersistedExtensionManagerState>
      if (!parsed || parsed.schemaVersion !== 1) {
        return { ...DEFAULT_MANAGER_STATE, operations: [] }
      }
      return {
        schemaVersion: 1,
        epoch: typeof parsed.epoch === 'number' && Number.isSafeInteger(parsed.epoch) ? parsed.epoch : 0,
        lastValidBuild: parsed.lastValidBuild ?? null,
        lastAttestation: parsed.lastAttestation ?? null,
        operations: Array.isArray(parsed.operations) ? parsed.operations.slice(0, MAX_STORED_OPERATIONS) : []
      }
    } catch {
      return { ...DEFAULT_MANAGER_STATE, operations: [] }
    }
  }

  saveState(state: PersistedExtensionManagerState): void {
    const trimmed: PersistedExtensionManagerState = {
      schemaVersion: 1,
      epoch: state.epoch,
      lastValidBuild: state.lastValidBuild,
      lastAttestation: state.lastAttestation,
      operations: state.operations.slice(0, MAX_STORED_OPERATIONS)
    }
    writeJsonAtomic(this.statePath, trimmed)
  }
}
