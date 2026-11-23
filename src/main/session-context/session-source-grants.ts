import Database from 'better-sqlite3'
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { assertProfilePath, assertUserOwned } from '../local-mcp-clients/safe-config-file'
import type {
  CodexAccountCandidate,
  ProviderGrantState,
  ProviderGrantSummary,
  SessionSourceGrantsStatus
} from '../../shared/types/session-source-grants-types'
import { readAntigravityAppGrantStatus } from './native-antigravity-app-source'
import { readCodexGrantStatus } from './native-codex-source'
import { resolveCodexHome } from './native-hook-profile'
import { boundedFile, sameNativePath } from './native-hooks'
import { digest } from './privacy'
import { SessionStore, sessionStorePath } from './store'

export interface ResolveGrantProfilesOptions {
  antigravityProfile?: string
  codexProfile?: string
  env?: NodeJS.ProcessEnv
  readOnly?: boolean
}

const MAX_CONFIG_BYTES = 65536
const MAX_HEADER_BYTES = 64 * 1024
const MAX_CODEX_SCAN_DIRS = 12
const MAX_CODEX_SCAN_FILES = 16
const SHA256_RE = /^[a-f0-9]{64}$/

function atomicWriteConfig(configPath: string, content: string, expectedPrevDigest?: string): void {
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })
  assertProfilePath(configPath, dir)
  if (existsSync(configPath)) {
    assertUserOwned(configPath)
    if (expectedPrevDigest !== undefined) {
      const current = boundedFile(configPath, MAX_CONFIG_BYTES)
      if (digest(current) !== expectedPrevDigest) throw new Error('CONFIG_CONFLICT')
    }
  }
  const tmpPath = join(dir, `.session-context.provider.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(tmpPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  try {
    if (process.platform !== 'win32') chmodSync(tmpPath, 0o600)
    renameSync(tmpPath, configPath)
    if (process.platform !== 'win32') chmodSync(configPath, 0o600)
  } catch (error) {
    try { unlinkSync(tmpPath) } catch {}
    throw error
  }
}

function readRawProviderConfig(configPath: string, repositoryId: string): {
  exists: boolean
  raw: Record<string, unknown>
  rawDigest?: string
  corrupt: boolean
} {
  const dir = dirname(configPath)
  assertProfilePath(configPath, dir)
  if (!existsSync(configPath)) {
    return { exists: false, raw: { repositoryId, nativeSources: {} }, corrupt: false }
  }
  try {
    assertUserOwned(configPath)
    const text = boundedFile(configPath, MAX_CONFIG_BYTES)
    const parsed = JSON.parse(text) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { exists: true, raw: {}, corrupt: true }
    }
    if (parsed.repositoryId !== undefined && parsed.repositoryId !== repositoryId) {
      return { exists: true, raw: parsed, rawDigest: digest(text), corrupt: true }
    }
    return { exists: true, raw: parsed, rawDigest: digest(text), corrupt: false }
  } catch {
    return { exists: true, raw: {}, corrupt: true }
  }
}

function resolveDefaultAntigravityProfile(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = explicit ?? env.ANTIGRAVITY_APP_HOME ?? join(homedir(), '.gemini', 'antigravity')
  return resolve(raw)
}

function validateUserProfileDir(profile: string): boolean {
  try {
    if (!isAbsolute(profile)) return false
    assertProfilePath(profile, profile)
    assertUserOwned(profile)
    const stat = lstatSync(profile)
    if (!stat.isDirectory()) return false
    return sameNativePath(realpathSync.native(profile), profile)
  } catch {
    return false
  }
}

function readFirstHeaderLine(filePath: string): Record<string, unknown> | undefined {
  let fd: number | undefined
  try {
    const stat = lstatSync(filePath, { bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n || stat.size === 0n) return undefined
    fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const buf = Buffer.alloc(MAX_HEADER_BYTES)
    const bytes = readSync(fd, buf, 0, buf.length, 0)
    const nl = buf.subarray(0, bytes).indexOf(10)
    if (nl <= 0) return undefined
    return JSON.parse(buf.subarray(0, nl).toString('utf8')) as Record<string, unknown>
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
  }
}

function discoverCodexAccountCandidates(codexProfile: string): CodexAccountCandidate[] {
  const seen = new Map<string, string>()
  const addCandidate = (userId: unknown, accountId: unknown) => {
    if (typeof userId !== 'string' || !userId || typeof accountId !== 'string' || !accountId) return
    const hash = digest(JSON.stringify([userId, accountId]))
    if (!seen.has(hash)) seen.set(hash, `Conta Codex #${seen.size + 1} (${hash.slice(0, 8)})`)
  }

  // 1. Check state_5.sqlite rollout_path headers first (fast metadata-only index)
  const dbPath = join(codexProfile, 'state_5.sqlite')
  let filesChecked = 0
  try {
    assertProfilePath(dbPath, codexProfile)
    assertUserOwned(dbPath)
    const st = lstatSync(dbPath, { bigint: true })
    if (st.isFile() && st.nlink === 1n && sameNativePath(realpathSync.native(dbPath), dbPath)) {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 100 })
      try {
        const rows = db.prepare('SELECT rollout_path FROM threads ORDER BY updated_at DESC LIMIT ?').all(MAX_CODEX_SCAN_FILES) as Array<{ rollout_path?: unknown }>
        for (const r of rows) {
          if (typeof r.rollout_path !== 'string') continue
          const rolloutPath = process.platform === 'win32' && r.rollout_path.startsWith('\\\\?\\') ? r.rollout_path.slice(4) : r.rollout_path
          try {
            assertProfilePath(rolloutPath, join(codexProfile, 'sessions'))
            const rec = readFirstHeaderLine(rolloutPath)
            const p = rec?.type === 'session_meta' ? (rec.payload as Record<string, unknown> | undefined) : undefined
            if (p?.account_scoped === true) addCandidate(p.creator_user_id, p.creator_account_id)
            filesChecked++
          } catch {}
        }
      } finally {
        db.close()
      }
    }
  } catch {}

  // 2. Bounded header-only fallback in sessions/ if index didn't yield any candidates
  if (seen.size === 0 && filesChecked < MAX_CODEX_SCAN_FILES) {
    const sessionsDir = join(codexProfile, 'sessions')
    let dirsVisited = 0
    const walk = (dir: string, depth: number) => {
      if (dirsVisited >= MAX_CODEX_SCAN_DIRS || filesChecked >= MAX_CODEX_SCAN_FILES) return
      dirsVisited++
      try {
        const entries = readdirSync(dir, { withFileTypes: true }).map(e => e.name).sort().reverse()
        for (const name of entries.slice(0, 8)) {
          if (filesChecked >= MAX_CODEX_SCAN_FILES) break
          const full = join(dir, name)
          assertProfilePath(full, codexProfile)
          if (depth < 3) walk(full, depth + 1)
          else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) {
            const rec = readFirstHeaderLine(full)
            const p = rec?.type === 'session_meta' ? (rec.payload as Record<string, unknown> | undefined) : undefined
            if (p?.account_scoped === true) addCandidate(p.creator_user_id, p.creator_account_id)
            filesChecked++
          }
        }
      } catch {}
    }
    walk(sessionsDir, 0)
  }

  return Array.from(seen.entries()).map(([accountHash, label]) => ({ accountHash, label }))
}

function classifyProviderState(
  grantStatus: { configured: false; reason: 'GRANT_MISSING' } | { configured: true; ok: false; reason: 'GRANT_INVALID_OR_REVOKED' } | { configured: true; ok: true },
  revokedFlag: boolean,
  profileValid: boolean
): ProviderGrantState {
  if (grantStatus.configured && grantStatus.ok) return 'READY'
  if (revokedFlag && !grantStatus.configured) return 'REVOKED'
  if (!grantStatus.configured) return profileValid ? 'MISSING' : 'UNAVAILABLE'
  return 'INVALID'
}

export function inspectSessionSourceGrants(
  baseProfile: string,
  repositoryId: string,
  options: ResolveGrantProfilesOptions = {}
): SessionSourceGrantsStatus {
  if (!repositoryId) throw new Error('REPOSITORY_REQUIRED')
  const storePath = sessionStorePath(baseProfile, repositoryId)
  const configPath = join(dirname(storePath), 'session-context.provider.json')
  const cfg = readRawProviderConfig(configPath, repositoryId)
  const revokedProviders = (cfg.raw.revokedProviders as Record<string, unknown> | undefined) ?? {}
  const dismissed = cfg.raw.onboardingDismissed === true

  const agProfile = resolveDefaultAntigravityProfile(options.antigravityProfile, options.env)
  const agProfileValid = validateUserProfileDir(agProfile)
  const agStatus = readAntigravityAppGrantStatus(storePath, repositoryId)
  const agState = cfg.corrupt ? 'INVALID' : classifyProviderState(agStatus, revokedProviders.antigravityApp === true, agProfileValid)

  const codexProfile = resolveCodexHome(options.codexProfile, options.env)
  const codexProfileValid = validateUserProfileDir(codexProfile)
  const codexStatus = readCodexGrantStatus(storePath, repositoryId)
  const codexState = cfg.corrupt ? 'INVALID' : classifyProviderState(codexStatus, revokedProviders.codex === true, codexProfileValid)

  const codexCandidates = codexProfileValid && (codexState === 'MISSING' || codexState === 'REVOKED')
    ? discoverCodexAccountCandidates(codexProfile)
    : []
  const codexAccountAmbiguous = codexCandidates.length > 1
  const codexAccountMissing = (codexState === 'MISSING' || codexState === 'REVOKED') && codexProfileValid && codexCandidates.length === 0

  const agSummary: ProviderGrantSummary = {
    provider: 'antigravityApp',
    state: agState,
    eligible: agProfileValid,
    allowLexicalIndex: agStatus.configured && agStatus.ok ? Boolean(agStatus.grant.allowLexicalIndex) : false,
    ...(agState === 'UNAVAILABLE' ? { reasonCode: 'PROFILE_UNAVAILABLE' } : {}),
    ...(agState === 'INVALID' ? { reasonCode: 'GRANT_INVALID_OR_REVOKED' } : {})
  }

  const effectiveCodexState: ProviderGrantState =
    codexAccountMissing ? 'UNAVAILABLE' : codexState

  const codexSummary: ProviderGrantSummary = {
    provider: 'codex',
    state: effectiveCodexState,
    eligible: codexProfileValid && codexCandidates.length === 1,
    allowLexicalIndex: codexStatus.configured && codexStatus.ok ? codexStatus.allowLexicalIndex : false,
    ...(effectiveCodexState === 'UNAVAILABLE'
      ? { reasonCode: codexProfileValid ? 'CREATOR_ACCOUNT_UNVERIFIED' : 'PROFILE_UNAVAILABLE' }
      : {}),
    ...(effectiveCodexState === 'INVALID' ? { reasonCode: 'GRANT_INVALID_OR_REVOKED' } : {}),
    ...(codexAccountAmbiguous ? {
      accountSelectionRequired: true,
      accountCandidates: codexCandidates,
      reasonCode: 'MULTIPLE_CODEX_ACCOUNTS'
    } : {})
  }

  const allowLexicalIndex = (agSummary.state === 'READY' && agSummary.allowLexicalIndex) ||
    (codexSummary.state === 'READY' && codexSummary.allowLexicalIndex)

  const needsOnboarding = !options.readOnly && !dismissed && (
    (agSummary.state === 'MISSING' && agSummary.eligible) ||
    (codexSummary.state === 'MISSING' && (codexSummary.eligible || Boolean(codexSummary.accountSelectionRequired)))
  )

  return {
    repositoryId,
    readOnly: Boolean(options.readOnly),
    dismissed,
    allowLexicalIndex,
    providers: {
      antigravityApp: agSummary,
      codex: codexSummary
    },
    needsOnboarding
  }
}

export function grantSessionSourceAccess(input: {
  baseProfile: string
  repositoryId: string
  allowLexicalIndex?: boolean
  selectedCodexAccountHash?: string
  options?: ResolveGrantProfilesOptions
}): SessionSourceGrantsStatus {
  const { baseProfile, repositoryId, allowLexicalIndex = false, selectedCodexAccountHash, options = {} } = input
  if (options.readOnly) throw new Error('STORE_READ_ONLY')
  if (!repositoryId) throw new Error('REPOSITORY_REQUIRED')
  const storePath = sessionStorePath(baseProfile, repositoryId)
  const configPath = join(dirname(storePath), 'session-context.provider.json')
  const cfg = readRawProviderConfig(configPath, repositoryId)
  if (cfg.corrupt) throw new Error('GRANT_INVALID_OR_REVOKED')

  const next = { ...cfg.raw, repositoryId } as Record<string, unknown>
  const nativeSources = (
    next.nativeSources && typeof next.nativeSources === 'object' && !Array.isArray(next.nativeSources)
      ? { ...(next.nativeSources as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>
  const revokedProviders = (
    next.revokedProviders && typeof next.revokedProviders === 'object' && !Array.isArray(next.revokedProviders)
      ? { ...(next.revokedProviders as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>

  const agProfile = resolveDefaultAntigravityProfile(options.antigravityProfile, options.env)
  if (validateUserProfileDir(agProfile)) {
    const prevAg = (nativeSources.antigravityApp && typeof nativeSources.antigravityApp === 'object' && !Array.isArray(nativeSources.antigravityApp))
      ? (nativeSources.antigravityApp as Record<string, unknown>)
      : {}
    nativeSources.antigravityApp = {
      ...prevAg,
      profile: agProfile,
      allowLexicalIndex: Boolean(allowLexicalIndex)
    }
    delete revokedProviders.antigravityApp
  }

  const codexProfile = resolveCodexHome(options.codexProfile, options.env)
  if (validateUserProfileDir(codexProfile)) {
    const candidates = discoverCodexAccountCandidates(codexProfile)
    let chosenHash: string | undefined
    if (selectedCodexAccountHash !== undefined) {
      if (!SHA256_RE.test(selectedCodexAccountHash) || !candidates.some(c => c.accountHash === selectedCodexAccountHash)) {
        throw new Error('IDENTITY_MISMATCH')
      }
      chosenHash = selectedCodexAccountHash
    } else if (candidates.length === 1) {
      chosenHash = candidates[0].accountHash
    }
    if (chosenHash) {
      const prevCodex = (nativeSources.codex && typeof nativeSources.codex === 'object' && !Array.isArray(nativeSources.codex))
        ? (nativeSources.codex as Record<string, unknown>)
        : {}
      nativeSources.codex = {
        ...prevCodex,
        profile: codexProfile,
        creatorAccountHash: chosenHash,
        allowLexicalIndex: Boolean(allowLexicalIndex)
      }
      delete revokedProviders.codex
    }
  }

  next.nativeSources = nativeSources
  if (Object.keys(revokedProviders).length > 0) next.revokedProviders = revokedProviders
  else delete next.revokedProviders
  delete next.onboardingDismissed

  atomicWriteConfig(configPath, JSON.stringify(next, null, 2) + '\n', cfg.rawDigest)
  const status = inspectSessionSourceGrants(baseProfile, repositoryId, options)
  const readyCount = [status.providers.antigravityApp.state, status.providers.codex.state].filter(s => s === 'READY').length
  return { ...status, partialSuccess: readyCount === 1 }
}

export function revokeSessionSourceAccess(input: {
  baseProfile: string
  repositoryId: string
  provider?: 'antigravityApp' | 'codex' | 'all'
  options?: ResolveGrantProfilesOptions
}): SessionSourceGrantsStatus {
  const { baseProfile, repositoryId, provider = 'all', options = {} } = input
  if (options.readOnly) throw new Error('STORE_READ_ONLY')
  if (!repositoryId) throw new Error('REPOSITORY_REQUIRED')
  const storePath = sessionStorePath(baseProfile, repositoryId)
  const configPath = join(dirname(storePath), 'session-context.provider.json')
  const cfg = readRawProviderConfig(configPath, repositoryId)
  if (cfg.corrupt) throw new Error('GRANT_INVALID_OR_REVOKED')

  const next = { ...cfg.raw, repositoryId } as Record<string, unknown>
  const nativeSources = (
    next.nativeSources && typeof next.nativeSources === 'object' && !Array.isArray(next.nativeSources)
      ? { ...(next.nativeSources as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>
  const revokedProviders = (
    next.revokedProviders && typeof next.revokedProviders === 'object' && !Array.isArray(next.revokedProviders)
      ? { ...(next.revokedProviders as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>

  const targets: Array<'antigravityApp' | 'codex'> = provider === 'all' ? ['antigravityApp', 'codex'] : [provider]
  for (const t of targets) {
    delete nativeSources[t]
    revokedProviders[t] = true
  }
  next.nativeSources = nativeSources
  next.revokedProviders = revokedProviders

  atomicWriteConfig(configPath, JSON.stringify(next, null, 2) + '\n', cfg.rawDigest)

  // Immediately invalidate derived native indexes and FTS5 entries for revoked providers
  if (existsSync(storePath)) {
    const store = new SessionStore(storePath, repositoryId)
    try {
      for (const t of targets) {
        store.references.native.purgeProvider(repositoryId, t === 'antigravityApp' ? 'antigravity' : 'codex')
      }
    } finally {
      store.close()
    }
  }

  return inspectSessionSourceGrants(baseProfile, repositoryId, options)
}

export function updateLexicalIndexAccess(input: {
  baseProfile: string
  repositoryId: string
  allowLexicalIndex: boolean
  options?: ResolveGrantProfilesOptions
}): SessionSourceGrantsStatus {
  const { baseProfile, repositoryId, allowLexicalIndex, options = {} } = input
  if (options.readOnly) throw new Error('STORE_READ_ONLY')
  if (!repositoryId) throw new Error('REPOSITORY_REQUIRED')
  const storePath = sessionStorePath(baseProfile, repositoryId)
  const configPath = join(dirname(storePath), 'session-context.provider.json')
  const cfg = readRawProviderConfig(configPath, repositoryId)
  if (cfg.corrupt) throw new Error('GRANT_INVALID_OR_REVOKED')

  const next = { ...cfg.raw, repositoryId } as Record<string, unknown>
  const nativeSources = (
    next.nativeSources && typeof next.nativeSources === 'object' && !Array.isArray(next.nativeSources)
      ? { ...(next.nativeSources as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>

  for (const key of ['antigravityApp', 'codex'] as const) {
    const entry = nativeSources[key]
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      nativeSources[key] = { ...(entry as Record<string, unknown>), allowLexicalIndex: Boolean(allowLexicalIndex) }
    }
  }
  next.nativeSources = nativeSources
  atomicWriteConfig(configPath, JSON.stringify(next, null, 2) + '\n', cfg.rawDigest)

  if (!allowLexicalIndex && existsSync(storePath)) {
    const store = new SessionStore(storePath, repositoryId)
    try {
      store.references.native.purgeProviderFts(repositoryId, 'antigravity')
      store.references.native.purgeProviderFts(repositoryId, 'codex')
    } finally {
      store.close()
    }
  }

  return inspectSessionSourceGrants(baseProfile, repositoryId, options)
}

export function dismissSessionSourceOnboarding(input: {
  baseProfile: string
  repositoryId: string
  options?: ResolveGrantProfilesOptions
}): SessionSourceGrantsStatus {
  const { baseProfile, repositoryId, options = {} } = input
  if (options.readOnly) throw new Error('STORE_READ_ONLY')
  if (!repositoryId) throw new Error('REPOSITORY_REQUIRED')
  const storePath = sessionStorePath(baseProfile, repositoryId)
  const configPath = join(dirname(storePath), 'session-context.provider.json')
  const cfg = readRawProviderConfig(configPath, repositoryId)
  if (cfg.corrupt) throw new Error('GRANT_INVALID_OR_REVOKED')
  const next = { ...cfg.raw, repositoryId, onboardingDismissed: true }
  atomicWriteConfig(configPath, JSON.stringify(next, null, 2) + '\n', cfg.rawDigest)
  return inspectSessionSourceGrants(baseProfile, repositoryId, options)
}
