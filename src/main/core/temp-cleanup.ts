import {
  chmodSync,
  existsSync,
  lstatSync,
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
  | 'SYMLINK_OR_JUNCTION_REJECTED'
  | 'UNOWNED_FIXTURE'
  | 'IDENTITY_MISMATCH'
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

function samePath(a: string, b: string): boolean {
  const na = normalize(a)
  const nb = normalize(b)
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb
}

function canonicalKey(path: string): string {
  const normalized = normalize(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function identityFingerprint(stat: ReturnType<typeof lstatSync> & { dev: bigint; ino: bigint; birthtimeNs: bigint }): string {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}

function isInsideDirectory(base: string, candidate: string): boolean {
  const rel = relative(base, candidate)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

function verifyAncestorsReal(tmpBase: string, target: string): boolean {
  let current = target
  while (!samePath(current, tmpBase)) {
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

export function registerOwnedTempDir(dirPath: string): string {
  const tmpBase = realpathSync.native(tmpdir())
  const candidate = resolve(dirPath)
  if (samePath(candidate, tmpBase) || !isInsideDirectory(tmpBase, candidate)) {
    throw new Error(`Refusing to register non-temp fixture: ${dirPath}`)
  }
  if (!verifyAncestorsReal(tmpBase, candidate)) {
    throw new Error(`Refusing to register symlink or non-directory fixture: ${dirPath}`)
  }
  const real = realpathSync.native(candidate)
  if (!isInsideDirectory(tmpBase, real) || !samePath(real, candidate)) {
    throw new Error(`Refusing to register redirected fixture: ${dirPath}`)
  }
  recordFixture(candidate)
  return dirPath
}

function removeLinkOrEmptyReparse(entryPath: string): void {
  // Windows NTFS directory junctions may reject unlinkSync with EPERM/EISDIR; rmdirSync removes only the junction reparse point.
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

function clearAndRemoveOwnedTree(rootDir: string, deadlineMs: number): { clearedReadOnlyCount: number } {
  let visited = 0
  let clearedReadOnlyCount = 0

  const visit = (dir: string, isRoot: boolean): void => {
    if (Date.now() > deadlineMs) {
      throw Object.assign(new Error('Cleanup deadline exceeded'), { cleanupReason: 'CLEANUP_TIMEOUT' as CleanupReason })
    }
    if (++visited > MAX_WALK_ENTRIES) {
      throw Object.assign(new Error('Walk entry limit reached'), { cleanupReason: 'WALK_LIMIT_REACHED' as CleanupReason })
    }
    const dirStat = lstatSync(dir, { bigint: true })
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw Object.assign(new Error(`Unexpected non-directory inside fixture: ${dir}`), {
        cleanupReason: 'SYMLINK_OR_JUNCTION_REJECTED' as CleanupReason
      })
    }
    if (!isRoot) {
      const realDir = realpathSync.native(dir)
      if (!samePath(realDir, dir) && !isInsideDirectory(rootDir, realDir)) {
        throw Object.assign(new Error(`Escaped directory boundary: ${dir}`), {
          cleanupReason: 'SYMLINK_OR_JUNCTION_REJECTED' as CleanupReason
        })
      }
    }
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (Date.now() > deadlineMs) {
        throw Object.assign(new Error('Cleanup deadline exceeded'), { cleanupReason: 'CLEANUP_TIMEOUT' as CleanupReason })
      }
      if (++visited > MAX_WALK_ENTRIES) {
        throw Object.assign(new Error('Walk entry limit reached'), { cleanupReason: 'WALK_LIMIT_REACHED' as CleanupReason })
      }
      const entryPath = join(dir, entry.name)
      const stat = lstatSync(entryPath, { bigint: true })
      if (stat.isSymbolicLink()) {
        // Never chmod or recurse into symlinks/junctions; remove only the link entry itself.
        removeLinkOrEmptyReparse(entryPath)
        continue
      }
      if (stat.isDirectory()) {
        visit(entryPath, false)
        continue
      }
      if ((Number(stat.mode) & 0o200) === 0) {
        chmodSync(entryPath, Number(stat.mode) | 0o200)
        clearedReadOnlyCount++
      }
      unlinkSync(entryPath)
    }
    if ((Number(dirStat.mode) & 0o200) === 0) {
      chmodSync(dir, Number(dirStat.mode) | 0o700)
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
  if (!targetPath || typeof targetPath !== 'string') {
    return finalizeResult({
      ok: false, status: 'REFUSED', path: String(targetPath), reason: 'OUTSIDE_TEMP_ROOT',
      clearedReadOnlyCount: 0, attempts: 0, durationMs: Date.now() - started
    }, options.strict)
  }

  const tmpBase = realpathSync.native(tmpdir())
  const candidate = resolve(targetPath)
  const parent = dirname(candidate)

  if (samePath(parent, candidate) || samePath(candidate, tmpBase)) {
    return finalizeResult({
      ok: false, status: 'REFUSED', path: candidate, reason: 'TEMP_ROOT_FORBIDDEN',
      clearedReadOnlyCount: 0, attempts: 0, durationMs: Date.now() - started
    }, options.strict)
  }
  if (!isInsideDirectory(tmpBase, candidate)) {
    return finalizeResult({
      ok: false, status: 'REFUSED', path: candidate, reason: 'OUTSIDE_TEMP_ROOT',
      clearedReadOnlyCount: 0, attempts: 0, durationMs: Date.now() - started
    }, options.strict)
  }

  const key = canonicalKey(candidate)
  let rootStat: ReturnType<typeof lstatSync> & { dev: bigint; ino: bigint; birthtimeNs: bigint }
  try {
    rootStat = lstatSync(candidate, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      ownedFixtures.delete(key)
      return {
        ok: true, status: 'ALREADY_ABSENT', path: candidate,
        clearedReadOnlyCount: 0, attempts: 0, durationMs: Date.now() - started
      }
    }
    return finalizeResult({
      ok: false, status: 'FAILED', path: candidate, reason: 'PERSISTENT_LOCK_OR_PERMISSION',
      clearedReadOnlyCount: 0, attempts: 0, durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error)
    }, options.strict)
  }

  if (rootStat.isSymbolicLink() || !verifyAncestorsReal(tmpBase, candidate)) {
    return finalizeResult({
      ok: false, status: 'REFUSED', path: candidate, reason: 'SYMLINK_OR_JUNCTION_REJECTED',
      clearedReadOnlyCount: 0, attempts: 0, durationMs: Date.now() - started
    }, options.strict)
  }

  const resolvedReal = realpathSync.native(candidate)
  if (!isInsideDirectory(tmpBase, resolvedReal) || !samePath(resolvedReal, candidate)) {
    return finalizeResult({
      ok: false, status: 'REFUSED', path: candidate, reason: 'SYMLINK_OR_JUNCTION_REJECTED',
      clearedReadOnlyCount: 0, attempts: 0, durationMs: Date.now() - started
    }, options.strict)
  }

  const fp = identityFingerprint(rootStat)
  const owned = ownedFixtures.get(key)
  if (!owned) {
    const prior = cleanedFixtures.get(key)
    return finalizeResult({
      ok: false, status: 'REFUSED', path: candidate,
      reason: prior && prior !== fp ? 'IDENTITY_MISMATCH' : 'UNOWNED_FIXTURE',
      clearedReadOnlyCount: 0, attempts: 0, durationMs: Date.now() - started
    }, options.strict)
  }
  if (owned.fingerprint !== fp) {
    return finalizeResult({
      ok: false, status: 'REFUSED', path: candidate, reason: 'IDENTITY_MISMATCH',
      clearedReadOnlyCount: 0, attempts: 0, durationMs: Date.now() - started
    }, options.strict)
  }

  try {
    options.beforeRemove?.(candidate)
  } catch {}

  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const deadlineMs = started + Math.max(50, options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS)
  let totalCleared = 0
  let lastError: unknown
  let lastReason: CleanupReason = 'PERSISTENT_LOCK_OR_PERMISSION'

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { clearedReadOnlyCount } = clearAndRemoveOwnedTree(candidate, deadlineMs)
      totalCleared += clearedReadOnlyCount
      if (!existsSync(candidate)) {
        ownedFixtures.delete(key)
        cleanedFixtures.set(key, fp)
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
        ownedFixtures.delete(key)
        cleanedFixtures.set(key, fp)
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
    ownedFixtures.delete(key)
    cleanedFixtures.set(key, fp)
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
