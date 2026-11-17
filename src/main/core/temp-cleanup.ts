import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'

export type CleanupStatus = 'REMOVED' | 'ALREADY_ABSENT' | 'REFUSED' | 'FAILED'

export type CleanupReason =
  | 'OUTSIDE_TEMP_ROOT'
  | 'TEMP_ROOT_FORBIDDEN'
  | 'NON_DIRECTORY_FIXTURE'
  | 'SYMLINK_OR_JUNCTION_REJECTED'
  | 'UNOWNED_FIXTURE'
  | 'IDENTITY_MISMATCH'
  | 'SHARED_HARDLINK_READONLY'
  | 'ACTIVE_PROCESS_UNCONFIRMED'
  | 'WALK_LIMIT_REACHED'
  | 'CLEANUP_TIMEOUT'
  | 'PERSISTENT_LOCK_OR_PERMISSION'

export interface CleanupResult {
  ok: boolean
  status: CleanupStatus
  path: string
  reason?: CleanupReason
  clearedReadOnlyCount: number
  attempts: number
  durationMs: number
  error?: string
}

export interface CleanupOptions {
  maxAttempts?: number
  maxDurationMs?: number
  beforeRemove?: (targetPath: string) => void
  strict?: boolean
}

export interface FixtureExecutionGuard {
  readonly fixtureKey: string
  readonly canonicalPath: string
  readonly fingerprint: string
  readonly token: string
}

interface OwnedFixture {
  canonicalPath: string
  fingerprint: string
}

const MAX_WALK_ENTRIES = 100_000
const DEFAULT_MAX_ATTEMPTS = 4
const DEFAULT_MAX_DURATION_MS = 1500
const TRANSIENT_LOCK_CODES = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM', 'EACCES'])

const ownedFixtures = new Map<string, OwnedFixture>()
const cleanedFixtures = new Map<string, string>()
const activeFixtureGuards = new Map<string, Map<string, string>>()

function samePath(a: string, b: string): boolean {
  const na = normalize(a)
  const nb = normalize(b)
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb
}

function canonicalKey(targetPath: string): string {
  const normalized = normalize(targetPath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function identityFingerprint(stat: { dev: bigint; ino: bigint; birthtimeNs: bigint }): string {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}

function isInsideDirectory(base: string, candidate: string): boolean {
  const rel = relative(base, candidate)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

function verifyAncestorsReal(baseRoot: string, target: string): boolean {
  let current = target
  while (!samePath(current, baseRoot)) {
    const parent = dirname(current)
    if (samePath(parent, current)) return false
    const stat = lstatSync(current, { bigint: true })
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false
    current = parent
  }
  return true
}

function recordFixture(canonicalPath: string): void {
  const stat = lstatSync(canonicalPath, { bigint: true })
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Owned fixture must be a real directory: ${canonicalPath}`)
  }
  const key = canonicalKey(canonicalPath)
  cleanedFixtures.delete(key)
  ownedFixtures.set(key, {
    canonicalPath,
    fingerprint: identityFingerprint(stat)
  })
}

export function createOwnedTempDir(prefix = 'tmp_fixture_'): string {
  const tmpBase = realpathSync.native(tmpdir())
  const created = mkdtempSync(join(tmpBase, prefix))
  const resolved = realpathSync.native(created)
  if (!isInsideDirectory(tmpBase, resolved) || !samePath(resolved, created)) {
    throw new Error(`Refusing temp fixture outside temp root: ${created}`)
  }
  recordFixture(created)
  return created
}

/**
 * Registra apenas subdiretório real cujo chamador demonstre posse por uma fixture pai
 * já criada e validada neste harness, impedindo adoção de diretórios arbitrários no temp.
 */
export function registerOwnedTempDir(dirPath: string, ownerFixturePath: string): string {
  if (!ownerFixturePath || typeof ownerFixturePath !== 'string') {
    throw new Error('Refusing unanchored temp fixture registration: owner fixture required')
  }
  const tmpBase = realpathSync.native(tmpdir())
  const ownerCandidate = resolve(ownerFixturePath)
  const ownerKey = canonicalKey(ownerCandidate)
  const owner = ownedFixtures.get(ownerKey)
  if (!owner || !samePath(owner.canonicalPath, ownerCandidate)) {
    throw new Error(`Refusing temp fixture registration without owned parent fixture: ${ownerFixturePath}`)
  }
  const ownerStat = lstatSync(ownerCandidate, { bigint: true })
  if (
    ownerStat.isSymbolicLink() ||
    !ownerStat.isDirectory() ||
    identityFingerprint(ownerStat) !== owner.fingerprint ||
    !verifyAncestorsReal(tmpBase, ownerCandidate)
  ) {
    throw new Error(`Refusing temp fixture registration under invalid owner identity: ${ownerFixturePath}`)
  }

  const candidate = resolve(dirPath)
  if (samePath(candidate, tmpBase) || !isInsideDirectory(ownerCandidate, candidate)) {
    throw new Error(`Refusing to register fixture outside owned parent boundary: ${dirPath}`)
  }
  if (!verifyAncestorsReal(ownerCandidate, candidate)) {
    throw new Error(`Refusing to register symlink or non-directory fixture: ${dirPath}`)
  }
  const real = realpathSync.native(candidate)
  if (!isInsideDirectory(ownerCandidate, real) || !samePath(real, candidate)) {
    throw new Error(`Refusing to register redirected fixture: ${dirPath}`)
  }
  recordFixture(candidate)
  return dirPath
}

export function createOwnedSubdir(ownerFixturePath: string, name: string): string {
  const target = join(ownerFixturePath, name)
  mkdirSync(target, { recursive: false })
  return registerOwnedTempDir(target, ownerFixturePath)
}

function findOwnedFixtureForPath(targetPath: string): { key: string; owned: OwnedFixture } | null {
  if (!targetPath || typeof targetPath !== 'string') return null
  const candidate = resolve(targetPath)
  const exactKey = canonicalKey(candidate)
  const exact = ownedFixtures.get(exactKey)
  if (exact) return { key: exactKey, owned: exact }

  let best: { key: string; owned: OwnedFixture } | null = null
  for (const [key, owned] of ownedFixtures.entries()) {
    if (isInsideDirectory(owned.canonicalPath, candidate)) {
      if (!best || owned.canonicalPath.length > best.owned.canonicalPath.length) {
        best = { key, owned }
      }
    }
  }
  return best
}

export function acquireFixtureProcessGuard(targetPath: string): FixtureExecutionGuard | null {
  const match = findOwnedFixtureForPath(targetPath)
  if (!match) return null
  try {
    const stat = lstatSync(match.owned.canonicalPath, { bigint: true })
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null
    const fp = identityFingerprint(stat)
    if (fp !== match.owned.fingerprint) return null
    const token = randomUUID()
    let guards = activeFixtureGuards.get(match.key)
    if (!guards) {
      guards = new Map()
      activeFixtureGuards.set(match.key, guards)
    }
    guards.set(token, fp)
    return {
      fixtureKey: match.key,
      canonicalPath: match.owned.canonicalPath,
      fingerprint: fp,
      token
    }
  } catch {
    return null
  }
}

export function releaseFixtureProcessGuard(guard: FixtureExecutionGuard | null): void {
  if (!guard) return
  const guards = activeFixtureGuards.get(guard.fixtureKey)
  if (!guards) return
  guards.delete(guard.token)
  if (guards.size === 0) {
    activeFixtureGuards.delete(guard.fixtureKey)
  }
}

function hasActiveGuardForIdentity(key: string, fingerprint: string): boolean {
  const guards = activeFixtureGuards.get(key)
  if (!guards || guards.size === 0) return false
  for (const guardedFp of guards.values()) {
    if (guardedFp === fingerprint) return true
  }
  return false
}

function removeLinkOrEmptyReparse(entryPath: string): void {
  // Junctions NTFS no Windows podem rejeitar unlinkSync com EPERM/EISDIR; rmdirSync remove só o ponto de reparo.
  try {
    unlinkSync(entryPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EISDIR')) {
      rmdirSync(entryPath)
      return
    }
    throw error
  }
}

function makeCleanupError(message: string, reason: CleanupReason): Error & { cleanupReason: CleanupReason } {
  return Object.assign(new Error(message), { cleanupReason: reason })
}

type RootValidation =
  | { kind: 'VALID'; key: string; fp: string; tmpBase: string }
  | { kind: 'RESULT'; result: CleanupResult }

function verifyOwnedRoot(
  targetPath: string,
  started: number,
  expectedKey?: string,
  expectedFingerprint?: string
): RootValidation {
  if (!targetPath || typeof targetPath !== 'string') {
    return {
      kind: 'RESULT',
      result: {
        ok: false, status: 'REFUSED', path: String(targetPath), reason: 'OUTSIDE_TEMP_ROOT',
        clearedReadOnlyCount: 0, attempts: 0, durationMs: Date.now() - started
      }
    }
  }

  const tmpBase = realpathSync.native(tmpdir())
  const candidate = resolve(targetPath)
  const parent = dirname(candidate)

  if (samePath(parent, candidate) || samePath(candidate, tmpBase)) {
    return {
      kind: 'RESULT',
      result: {
        ok: false, status: 'REFUSED', path: candidate, reason: 'TEMP_ROOT_FORBIDDEN',
        clearedReadOnlyCount: 0, attempts: 0, durationMs: Date.now() - started
      }
    }
  }
  if (!isInsideDirectory(tmpBase, candidate)) {
    return {
      kind: 'RESULT',
      result: {
        ok: false, status: 'REFUSED', path: candidate, reason: 'OUTSIDE_TEMP_ROOT',
        clearedReadOnlyCount: 0, attempts: 0, durationMs: Date.now() - started
      }
    }
  }

  const key = canonicalKey(candidate)
  if (expectedKey && key !== expectedKey) {
    return {
      kind: 'RESULT',
      result: {
        ok: false, status: 'REFUSED', path: candidate, reason: 'IDENTITY_MISMATCH',
        clearedReadOnlyCount: 0, attempts: 0, durationMs: Date.now() - started
      }
    }
  }

  let rootStat: ReturnType<typeof lstatSync> & { dev: bigint; ino: bigint; birthtimeNs: bigint }
  try {
    rootStat = lstatSync(candidate, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      ownedFixtures.delete(key)
      activeFixtureGuards.delete(key)
      return {
        kind: 'RESULT',
        result: {
          ok: true, status: 'ALREADY_ABSENT', path: candidate,
          clearedReadOnlyCount: 0, attempts: 0, durationMs: Date.now() - started
        }
      }
    }
    return {
      kind: 'RESULT',
      result: {
        ok: false, status: 'FAILED', path: candidate, reason: 'PERSISTENT_LOCK_OR_PERMISSION',
        clearedReadOnlyCount: 0, attempts: 0, durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  if (rootStat.isSymbolicLink() || !verifyAncestorsReal(tmpBase, candidate)) {
    return {
      kind: 'RESULT',
      result: {
        ok: false, status: 'REFUSED', path: candidate, reason: 'SYMLINK_OR_JUNCTION_REJECTED',
        clearedReadOnlyCount: 0, attempts: 0, durationMs: Date.now() - started
      }
    }
  }
  if (!rootStat.isDirectory()) {
    return {
      kind: 'RESULT',
      result: {
        ok: false, status: 'REFUSED', path: candidate, reason: 'NON_DIRECTORY_FIXTURE',
        clearedReadOnlyCount: 0, attempts: 0, durationMs: Date.now() - started
      }
    }
  }

  const resolvedReal = realpathSync.native(candidate)
  if (!isInsideDirectory(tmpBase, resolvedReal) || !samePath(resolvedReal, candidate)) {
    return {
      kind: 'RESULT',
      result: {
        ok: false, status: 'REFUSED', path: candidate, reason: 'SYMLINK_OR_JUNCTION_REJECTED',
        clearedReadOnlyCount: 0, attempts: 0, durationMs: Date.now() - started
      }
    }
  }

  const fp = identityFingerprint(rootStat)
  const owned = ownedFixtures.get(key)
  if (!owned) {
    const prior = cleanedFixtures.has(key)
    return {
      kind: 'RESULT',
      result: {
        ok: false, status: 'REFUSED', path: candidate,
        reason: prior || expectedFingerprint ? 'IDENTITY_MISMATCH' : 'UNOWNED_FIXTURE',
        clearedReadOnlyCount: 0, attempts: 0, durationMs: Date.now() - started
      }
    }
  }
  if (!samePath(owned.canonicalPath, candidate) || owned.fingerprint !== fp || (expectedFingerprint && fp !== expectedFingerprint)) {
    return {
      kind: 'RESULT',
      result: {
        ok: false, status: 'REFUSED', path: candidate, reason: 'IDENTITY_MISMATCH',
        clearedReadOnlyCount: 0, attempts: 0, durationMs: Date.now() - started
      }
    }
  }

  if (hasActiveGuardForIdentity(key, fp)) {
    return {
      kind: 'RESULT',
      result: {
        ok: false, status: 'REFUSED', path: candidate, reason: 'ACTIVE_PROCESS_UNCONFIRMED',
        clearedReadOnlyCount: 0, attempts: 0, durationMs: Date.now() - started,
        error: 'Fixture possui processo próprio ativo ou com término não confirmado'
      }
    }
  }

  return { kind: 'VALID', key, fp, tmpBase }
}

function clearAndRemoveOwnedTree(
  rootDir: string,
  expectedRootFp: string,
  expectedRootKey: string,
  deadlineMs: number
): { clearedReadOnlyCount: number } {
  let visited = 0
  let clearedReadOnlyCount = 0

  const assertRootIntact = () => {
    const rootStat = lstatSync(rootDir, { bigint: true })
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw makeCleanupError(`Unexpected root type change during cleanup: ${rootDir}`, 'SYMLINK_OR_JUNCTION_REJECTED')
    }
    const real = realpathSync.native(rootDir)
    if (!samePath(real, rootDir)) {
      throw makeCleanupError(`Root canonical path changed during cleanup: ${rootDir}`, 'SYMLINK_OR_JUNCTION_REJECTED')
    }
    if (identityFingerprint(rootStat) !== expectedRootFp) {
      throw makeCleanupError(`Root identity changed during cleanup: ${rootDir}`, 'IDENTITY_MISMATCH')
    }
    if (hasActiveGuardForIdentity(expectedRootKey, expectedRootFp)) {
      throw makeCleanupError(`Active or unconfirmed subprocess tied to fixture: ${rootDir}`, 'ACTIVE_PROCESS_UNCONFIRMED')
    }
    return rootStat
  }

  const visit = (dir: string, isRoot: boolean): void => {
    if (Date.now() > deadlineMs) {
      throw makeCleanupError('Cleanup deadline exceeded', 'CLEANUP_TIMEOUT')
    }
    if (++visited > MAX_WALK_ENTRIES) {
      throw makeCleanupError('Walk entry limit reached', 'WALK_LIMIT_REACHED')
    }
    const dirStat = isRoot ? assertRootIntact() : lstatSync(dir, { bigint: true })
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw makeCleanupError(`Unexpected non-directory inside fixture: ${dir}`, 'SYMLINK_OR_JUNCTION_REJECTED')
    }
    if (!isRoot) {
      const realDir = realpathSync.native(dir)
      if (!samePath(realDir, dir)) {
        throw makeCleanupError(`Redirected directory inside fixture: ${dir}`, 'SYMLINK_OR_JUNCTION_REJECTED')
      }
    }

    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (Date.now() > deadlineMs) {
        throw makeCleanupError('Cleanup deadline exceeded', 'CLEANUP_TIMEOUT')
      }
      if (++visited > MAX_WALK_ENTRIES) {
        throw makeCleanupError('Walk entry limit reached', 'WALK_LIMIT_REACHED')
      }
      const entryPath = join(dir, entry.name)
      const stat = lstatSync(entryPath, { bigint: true })
      if (stat.isSymbolicLink()) {
        // Nunca executar chmod nem descer em symlinks/junctions; remover somente a entrada de link.
        removeLinkOrEmptyReparse(entryPath)
        continue
      }
      if (stat.isDirectory()) {
        visit(entryPath, false)
        continue
      }

      const isSharedHardLink = stat.nlink > 1n
      const isReadOnly = (Number(stat.mode) & 0o200) === 0
      if (isSharedHardLink) {
        // Nunca chmod arquivo com nlink > 1: alteraria atributos/permissões do objeto hard-linked externo.
        if (process.platform === 'win32' && isReadOnly) {
          throw makeCleanupError(
            `Refusing cleanup of read-only hard-linked entry without mutating external object: ${entryPath}`,
            'SHARED_HARDLINK_READONLY'
          )
        }
        try {
          unlinkSync(entryPath)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code
          if (code === 'ENOENT') continue
          if (code === 'EPERM' || code === 'EACCES') {
            throw makeCleanupError(
              `Refusing cleanup of shared hard-linked entry on permission error: ${entryPath}`,
              'SHARED_HARDLINK_READONLY'
            )
          }
          throw error
        }
        continue
      }

      if (isReadOnly) {
        chmodSync(entryPath, Number(stat.mode) | 0o200)
        clearedReadOnlyCount++
      }
      unlinkSync(entryPath)
    }

    const finalDirStat = isRoot ? assertRootIntact() : lstatSync(dir, { bigint: true })
    if ((Number(finalDirStat.mode) & 0o200) === 0) {
      chmodSync(dir, Number(finalDirStat.mode) | 0o700)
      clearedReadOnlyCount++
    }
    rmdirSync(dir)
  }

  visit(rootDir, true)
  return { clearedReadOnlyCount }
}

function finalizeResult(result: CleanupResult, strict?: boolean): CleanupResult {
  if (!result.ok) {
    console.warn(`[temp-cleanup] ${result.status} (${result.reason}): ${result.path}${result.error ? ` — ${result.error}` : ''}`)
    if (strict) {
      throw Object.assign(new Error(`Cleanup ${result.status.toLowerCase()} (${result.reason}): ${result.path}`), { cleanupResult: result })
    }
  }
  return result
}

export async function safeCleanupTempDir(targetPath: string, options: CleanupOptions = {}): Promise<CleanupResult> {
  const started = Date.now()
  const initialCheck = verifyOwnedRoot(targetPath, started)
  if (initialCheck.kind === 'RESULT') {
    return finalizeResult(initialCheck.result, options.strict)
  }

  const candidate = resolve(targetPath)
  const expectedKey = initialCheck.key
  const expectedFp = initialCheck.fp

  let callbackError: string | undefined
  try {
    options.beforeRemove?.(candidate)
  } catch (error) {
    callbackError = error instanceof Error ? error.message : String(error)
  }

  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const deadlineMs = started + Math.max(50, options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS)
  let totalCleared = 0
  let lastError: unknown = callbackError
  let lastReason: CleanupReason = 'PERSISTENT_LOCK_OR_PERMISSION'

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Revalida posse, fingerprint da raiz, ancestrais e caminho canônico após beforeRemove e em toda nova tentativa.
    const preAttempt = verifyOwnedRoot(candidate, started, expectedKey, expectedFp)
    if (preAttempt.kind === 'RESULT') {
      const res = preAttempt.result
      if (res.status === 'ALREADY_ABSENT') {
        cleanedFixtures.set(expectedKey, expectedFp)
        return { ...res, clearedReadOnlyCount: totalCleared, attempts: attempt - 1 }
      }
      return finalizeResult({ ...res, clearedReadOnlyCount: totalCleared, attempts: attempt - 1 }, options.strict)
    }

    try {
      const { clearedReadOnlyCount } = clearAndRemoveOwnedTree(candidate, expectedFp, expectedKey, deadlineMs)
      totalCleared += clearedReadOnlyCount
      if (!existsSync(candidate)) {
        ownedFixtures.delete(expectedKey)
        cleanedFixtures.set(expectedKey, expectedFp)
        return {
          ok: true, status: 'REMOVED', path: candidate,
          clearedReadOnlyCount: totalCleared, attempts: attempt, durationMs: Date.now() - started
        }
      }
    } catch (error) {
      lastError = error
      const taggedReason = (error as { cleanupReason?: CleanupReason })?.cleanupReason
      if (taggedReason) {
        lastReason = taggedReason
        if (taggedReason !== 'CLEANUP_TIMEOUT') {
          return finalizeResult({
            ok: false, status: 'REFUSED', path: candidate, reason: taggedReason,
            clearedReadOnlyCount: totalCleared, attempts: attempt, durationMs: Date.now() - started,
            error: error instanceof Error ? error.message : String(error)
          }, options.strict)
        }
      }
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT' && !existsSync(candidate)) {
        ownedFixtures.delete(expectedKey)
        cleanedFixtures.set(expectedKey, expectedFp)
        return {
          ok: true, status: 'REMOVED', path: candidate,
          clearedReadOnlyCount: totalCleared, attempts: attempt, durationMs: Date.now() - started
        }
      }
      const remainingMs = deadlineMs - Date.now()
      if (remainingMs <= 0 || (code && !TRANSIENT_LOCK_CODES.has(code))) {
        return finalizeResult({
          ok: false, status: 'FAILED', path: candidate,
          reason: remainingMs <= 0 ? 'CLEANUP_TIMEOUT' : lastReason,
          clearedReadOnlyCount: totalCleared, attempts: attempt, durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error)
        }, options.strict)
      }
      if (attempt < maxAttempts) {
        const delayMs = Math.min(remainingMs, 50 * 2 ** (attempt - 1))
        await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs))
      }
    }
  }

  if (!existsSync(candidate)) {
    ownedFixtures.delete(expectedKey)
    cleanedFixtures.set(expectedKey, expectedFp)
    return {
      ok: true, status: 'REMOVED', path: candidate,
      clearedReadOnlyCount: totalCleared, attempts: maxAttempts, durationMs: Date.now() - started
    }
  }

  return finalizeResult({
    ok: false, status: 'FAILED', path: candidate, reason: lastReason,
    clearedReadOnlyCount: totalCleared, attempts: maxAttempts, durationMs: Date.now() - started,
    error: lastError instanceof Error ? lastError.message : lastError ? String(lastError) : 'Directory still present after cleanup attempts'
  }, options.strict)
}
