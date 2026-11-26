import Database from 'better-sqlite3'
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync, type BigIntStats } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { assertProfilePath, assertUserOwned } from '../local-mcp-clients/safe-config-file'
import { boundedFile, nativeDigest, sameNativePath } from './native-hooks'
import { classifyStructuredOutput, extractTextValue, validTimestamp } from './native-source-events'
import {
  applyAttemptOutcome,
  emitIndexedEvent,
  emitOpaqueRecord,
  emitUnavailableRecord,
  fileIdentityOf,
  NATIVE_LINE_MAX_BYTES,
  openNoFollowReadOnly,
  runNativeReferenceStep,
  runNativeReferenceStepAsync,
  type NativeIndexedSourceHandle,
  type NativeReferenceStepResult,
  type NativeStepBudget,
  type StepAccumulator
} from './native-source-index'
import { readZstdFirstLine } from './native-zstd-jsonl'
import { NATIVE_CODEX_NORMALIZER, nativeReferenceKey, type NativeSessionReferences } from './native-session-references'
import {
  extractSkillCallMetadata,
  qualifySkillToolObservation,
  resolveCanonicalSkillTool
} from './skill-intelligence-extractor'
import { digest, sanitize } from './privacy'

const sha = z.string().regex(/^[a-f0-9]{64}$/)
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const grant = z.object({
  profile: z.string().max(4096).refine(isAbsolute),
  creatorAccountHash: sha,
  allowLexicalIndex: z.boolean().optional()
}).strict()
const maxHeaderLine = 64 * 1024
const maxDiscoveryDirs = 32
const maxDiscoveryEntries = 256
const maxCandidateFiles = 24
const maxTotalHeaderBytes = 512 * 1024
const maxDiscoveryResults = 20
const decoder = new TextDecoder('utf-8', { fatal: true })

export interface DiscoveredCodexSource {
  provider: 'codex-native'
  providerSessionId: string
  sourceSessionId: string
  agent: 'codex'
  lastObserved?: string
  contentAvailability: 'AVAILABLE' | 'IDENTITY_UNVERIFIED'
  captureCoverage: 'SOURCE_AVAILABLE_NO_HOOK_CAPTURE'
  identityEvidence: 'HASH_AND_PROVIDER_HEADER_VERIFIED' | 'IDENTITY_UNVERIFIED'
  readinessReason?: 'READY' | 'IDENTITY_UNVERIFIED'
  sourceLocation?: 'ACTIVE' | 'ARCHIVED'
  compressed?: boolean
}

export interface CodexDiscoveryResult {
  sessions: DiscoveredCodexSource[]
  truncated: boolean
  coverageReason?: 'SOURCE_DISCOVERY_LIMIT_REACHED' | 'PROFILE_UNAVAILABLE'
  stats: {
    usedIndex: boolean
    dirsVisited: number
    filesOpened: number
    headerBytesRead: number
  }
}

function stripVerbatimPrefix(path: string): string {
  return process.platform === 'win32' && path.startsWith('\\\\?\\') ? path.slice(4) : path
}

export function readCodexGrantStatus(storePath: string, repositoryId: string):
  | { configured: false; reason: 'GRANT_MISSING' }
  | { configured: true; ok: false; reason: 'GRANT_INVALID_OR_REVOKED' }
  | { configured: true; ok: true; configPath: string; configText: string; profile: string; creatorAccountHash: string; allowLexicalIndex: boolean } {
  const configDirectory = dirname(storePath), configPath = join(configDirectory, 'session-context.provider.json')
  let configText: string
  try {
    assertProfilePath(configPath, configDirectory)
    configText = boundedFile(configPath, 65536)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { configured: false, reason: 'GRANT_MISSING' }
    return { configured: true, ok: false, reason: 'GRANT_INVALID_OR_REVOKED' }
  }
  let config: Record<string, unknown>
  try { config = JSON.parse(configText) as Record<string, unknown> } catch { return { configured: true, ok: false, reason: 'GRANT_INVALID_OR_REVOKED' } }
  const nativeSources = config?.nativeSources as Record<string, unknown> | undefined
  if (!nativeSources || nativeSources.codex === undefined) return { configured: false, reason: 'GRANT_MISSING' }
  try {
    assertUserOwned(configPath)
    const auth = grant.safeParse(nativeSources.codex)
    if (config.repositoryId !== repositoryId || !auth.success) throw new Error('SOURCE_NOT_AUTHORIZED')
    const { profile, creatorAccountHash } = auth.data
    assertProfilePath(profile, profile)
    if (!sameNativePath(resolve(profile), realpathSync.native(profile))) throw new Error('SOURCE_PATH_ESCAPE')
    assertUserOwned(profile)
    return { configured: true, ok: true, configPath, configText, profile, creatorAccountHash, allowLexicalIndex: auth.data.allowLexicalIndex === true }
  } catch {
    return { configured: true, ok: false, reason: 'GRANT_INVALID_OR_REVOKED' }
  }
}

function readCodexGrant(storePath: string, repositoryId: string) {
  const configDirectory = dirname(storePath), configPath = join(configDirectory, 'session-context.provider.json')
  assertProfilePath(configPath, configDirectory)
  let configText: string
  try { configText = boundedFile(configPath, 65536) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('SOURCE_NOT_AUTHORIZED'); throw error }
  assertUserOwned(configPath)
  const config = JSON.parse(configText)
  const auth = grant.safeParse(config.nativeSources?.codex)
  if (config.repositoryId !== repositoryId || !auth.success) throw new Error('SOURCE_NOT_AUTHORIZED')
  const { profile, creatorAccountHash } = auth.data
  assertProfilePath(profile, profile)
  if (!sameNativePath(resolve(profile), realpathSync.native(profile))) throw new Error('SOURCE_PATH_ESCAPE')
  assertUserOwned(profile)
  return { configPath, configText, profile, creatorAccountHash, allowLexicalIndex: auth.data.allowLexicalIndex === true }
}

function checkCodexWorktreeRoots(item: Record<string, unknown>, root: string, profile: string): boolean {
  const checkRoot = (value: unknown) => {
    try {
      return typeof value === 'string' && isAbsolute(value) && sameNativePath(realpathSync.native(value), root) && sameNativePath(resolve(value), root)
    } catch { return false }
  }
  const isVisualizationRoot = (value: unknown) => {
    if (typeof value !== 'string' || !isAbsolute(value)) return false
    try {
      const visBase = resolve(profile, 'visualizations')
      const resolved = resolve(value)
      const rel = relative(visBase, resolved).replaceAll('\\', '/')
      return /^\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}$/i.test(rel)
    } catch { return false }
  }
  if (!checkRoot(item.cwd) || !Array.isArray(item.runtime_workspace_roots) || !item.runtime_workspace_roots.length) return false
  if (!checkRoot(item.runtime_workspace_roots[0])) return false
  return item.runtime_workspace_roots.slice(1).every(isVisualizationRoot)
}

const KNOWN_CODEX_CLI_VERSIONS = new Set(['0.169.0-alpha.11.1', '0.171.0-alpha.13'])

function qualifyCodexSessionMeta(
  record: unknown,
  expectedSessionId: string,
  creatorAccountHash: string,
  root: string,
  profile: string
): { ok: true; meta: Record<string, unknown> } | { ok: false; error: 'SOURCE_IDENTITY_CONFLICT' | 'IDENTITY_UNVERIFIED' | 'SOURCE_FORMAT_UNSUPPORTED' | 'ORIGIN_UNVERIFIED' } {
  const rec = record as { type?: unknown; payload?: Record<string, unknown> } | null
  const meta = rec?.payload
  if (
    rec?.type !== 'session_meta' ||
    !meta ||
    typeof meta !== 'object' ||
    meta.id !== expectedSessionId ||
    typeof meta.session_id !== 'string' ||
    !uuid.test(meta.session_id)
  ) {
    return { ok: false, error: 'SOURCE_IDENTITY_CONFLICT' }
  }
  const cliVersion = meta.cli_version
  const validVersion = typeof cliVersion === 'string' && (KNOWN_CODEX_CLI_VERSIONS.has(cliVersion) || (cliVersion.trim().length > 0 && cliVersion.length <= 64))
  const validFormat = validVersion && typeof meta.cwd === 'string' && Array.isArray(meta.runtime_workspace_roots) && meta.runtime_workspace_roots.length > 0
  if (!validFormat) {
    return { ok: false, error: 'SOURCE_FORMAT_UNSUPPORTED' }
  }
  if (!checkCodexWorktreeRoots(meta, root, profile)) {
    return { ok: false, error: 'ORIGIN_UNVERIFIED' }
  }
  if (
    meta.account_scoped !== true ||
    typeof meta.creator_account_id !== 'string' ||
    !meta.creator_account_id ||
    typeof meta.creator_user_id !== 'string' ||
    !meta.creator_user_id
  ) {
    return { ok: false, error: 'IDENTITY_UNVERIFIED' }
  }
  if (digest(JSON.stringify([meta.creator_user_id, meta.creator_account_id])) !== creatorAccountHash) {
    return { ok: false, error: 'SOURCE_IDENTITY_CONFLICT' }
  }
  return { ok: true, meta }
}

const ROLLOUT_FILE_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl(\.zst)?$/

function parseRolloutFileName(name: string): { sessionId: string; compressed: boolean } | undefined {
  const match = ROLLOUT_FILE_RE.exec(name)
  if (!match) return undefined
  return { sessionId: match[1]!, compressed: match[2] === '.zst' }
}

function exactRollout(profile: string, id: string): { path: string; compressed: boolean; location: 'ACTIVE' | 'ARCHIVED' } {
  const sessions = join(profile, 'sessions')
  const archived = join(profile, 'archived_sessions')
  const stamp = Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)
  const activeMatches: Array<{ path: string; compressed: boolean }> = []
  for (const delta of [-1, 0, 1]) {
    const day = new Date(stamp + delta * 86400000).toISOString().slice(0, 10)
    const directory = join(sessions, ...day.split('-'))
    assertProfilePath(directory, profile)
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const parsed = parseRolloutFileName(entry.name)
        if (parsed && parsed.sessionId === id) {
          activeMatches.push({ path: join(directory, entry.name), compressed: parsed.compressed })
        }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const archivedMatches: Array<{ path: string; compressed: boolean }> = []
  assertProfilePath(archived, profile)
  try {
    for (const entry of readdirSync(archived, { withFileTypes: true })) {
      const parsed = parseRolloutFileName(entry.name)
      if (parsed && parsed.sessionId === id) {
        archivedMatches.push({ path: join(archived, entry.name), compressed: parsed.compressed })
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }

  const pickBest = (list: Array<{ path: string; compressed: boolean }>) => {
    const plain = list.filter(x => !x.compressed)
    if (plain.length === 1) return plain[0]!
    if (plain.length > 1) throw new Error('SOURCE_IDENTITY_CONFLICT')
    if (list.length === 1) return list[0]!
    throw new Error('SOURCE_IDENTITY_CONFLICT')
  }

  if (activeMatches.length > 0 && archivedMatches.length > 0) throw new Error('SOURCE_IDENTITY_CONFLICT')
  if (activeMatches.length > 0) return { ...pickBest(activeMatches), location: 'ACTIVE' }
  if (archivedMatches.length > 0) return { ...pickBest(archivedMatches), location: 'ARCHIVED' }
  throw new Error('SOURCE_NOT_FOUND')
}

function firstLine(path: string): { line?: string; bytesRead: number } {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isFile() || stat.nlink !== 1n || stat.size === 0n) return { bytesRead: 0 }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const buf = Buffer.alloc(maxHeaderLine)
    const read = readSync(fd, buf, 0, buf.length, 0)
    const nl = buf.subarray(0, read).indexOf(10)
    if (nl <= 0) return { bytesRead: read }
    return { line: decoder.decode(buf.subarray(0, nl)), bytesRead: read }
  } finally { closeSync(fd) }
}

async function firstLineAsync(path: string, compressed: boolean, assertCurrent: () => void): Promise<{ line?: string; bytesRead: number }> {
  if (!compressed) return firstLine(path)
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isFile() || stat.nlink !== 1n || stat.size === 0n) return { bytesRead: 0 }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    return await readZstdFirstLine(fd, Number(stat.size), maxHeaderLine, 128 * 1024, assertCurrent)
  } finally { closeSync(fd) }
}

function canonicalIndexPathMatchesRoot(rawCwd: unknown, root: string): boolean {
  if (typeof rawCwd !== 'string' || !rawCwd || rawCwd.length > 4096) return false
  const stripped = stripVerbatimPrefix(rawCwd)
  if (!isAbsolute(stripped)) return false
  try {
    return sameNativePath(realpathSync.native(stripped), root)
  } catch {
    return false
  }
}

function indexedCodexCandidates(
  profile: string,
  root: string,
  assertCurrent: () => void,
  offset = 0
): { usedIndex: true; truncated: boolean; candidates: { path: string; sessionId: string; mtimeMs: number; compressed: boolean; location: 'ACTIVE' | 'ARCHIVED' }[] } | undefined {
  const dbPath = join(profile, 'state_5.sqlite')
  let stat: BigIntStats
  try {
    assertProfilePath(dbPath, profile)
    assertUserOwned(dbPath)
    stat = lstatSync(dbPath, { bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n || !sameNativePath(realpathSync.native(dbPath), dbPath)) return undefined
  } catch {
    return undefined
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 100 })
  const sessionsRoot = join(profile, 'sessions')
  const archivedRoot = join(profile, 'archived_sessions')
  try {
    const normalizedRoot = stripVerbatimPrefix(root).replaceAll('\\', '/')
    const comparableRoot = process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot
    let rows: Array<{ id?: unknown; rollout_path?: unknown; cwd?: unknown; updated_at?: unknown }>
    try {
      const expr = process.platform === 'win32'
        ? "lower(replace(CASE WHEN substr(cwd, 1, 4) = '\\\\?\\' THEN substr(cwd, 5) ELSE cwd END, '\\', '/'))"
        : 'cwd'
      rows = db.prepare(
        `SELECT id, rollout_path, cwd, updated_at
         FROM threads
         WHERE ${expr} = ?
         ORDER BY updated_at DESC
         LIMIT ? OFFSET ?`
      ).all(comparableRoot, maxCandidateFiles + 1, offset) as Array<{ id?: unknown; rollout_path?: unknown; cwd?: unknown; updated_at?: unknown }>
    } catch {
      return undefined
    }
    const truncated = rows.length > maxCandidateFiles
    const candidates: { path: string; sessionId: string; mtimeMs: number; compressed: boolean; location: 'ACTIVE' | 'ARCHIVED' }[] = []
    for (const row of rows.slice(0, maxCandidateFiles)) {
      assertCurrent()
      if (typeof row.id !== 'string' || !uuid.test(row.id)) continue
      if (!canonicalIndexPathMatchesRoot(row.cwd, root)) continue
      if (typeof row.rollout_path !== 'string') continue
      const rawPath = stripVerbatimPrefix(row.rollout_path)
      const inSessions = (() => { try { assertProfilePath(rawPath, sessionsRoot); return true } catch { return false } })()
      const inArchived = !inSessions && (() => { try { assertProfilePath(rawPath, archivedRoot); return true } catch { return false } })()
      if (!inSessions && !inArchived) continue
      const location: 'ACTIVE' | 'ARCHIVED' = inArchived ? 'ARCHIVED' : 'ACTIVE'
      const tryPaths = rawPath.endsWith('.jsonl.zst')
        ? [{ path: rawPath.slice(0, -4), compressed: false }, { path: rawPath, compressed: true }]
        : [{ path: rawPath, compressed: false }, { path: `${rawPath}.zst`, compressed: true }]
      for (const tp of tryPaths) {
        try {
          assertProfilePath(tp.path, location === 'ARCHIVED' ? archivedRoot : sessionsRoot)
          const s = statSync(tp.path)
          candidates.push({ path: tp.path, sessionId: row.id, mtimeMs: s.mtimeMs, compressed: tp.compressed, location })
          break
        } catch {}
      }
    }
    return { usedIndex: true, truncated, candidates }
  } finally {
    db.close()
  }
}

function collectCodexDirCandidates(
  profile: string,
  root: string,
  offset: number,
  assertCurrent: () => void
): {
  usedIndex: boolean
  truncated: boolean
  dirsVisited: number
  candidates: { path: string; sessionId: string; mtimeMs: number; compressed: boolean; location: 'ACTIVE' | 'ARCHIVED' }[]
} {
  const indexed = indexedCodexCandidates(profile, root, assertCurrent, offset)
  if (indexed) {
    return { usedIndex: true, truncated: indexed.truncated, dirsVisited: 0, candidates: indexed.candidates }
  }
  const sessionsDir = join(profile, 'sessions')
  const archivedDir = join(profile, 'archived_sessions')
  let dirsVisited = 0
  let entriesChecked = 0
  let truncated = false
  const byDirAndId = new Map<string, { path: string; sessionId: string; mtimeMs: number; compressed: boolean; location: 'ACTIVE' | 'ARCHIVED' }>()

  const addEntry = (full: string, sessionId: string, compressed: boolean, location: 'ACTIVE' | 'ARCHIVED', dirKey: string) => {
    const key = `${dirKey}:${sessionId}`
    const existing = byDirAndId.get(key)
    if (existing && !existing.compressed) return
    byDirAndId.set(key, { path: full, sessionId, mtimeMs: statSync(full).mtimeMs, compressed, location })
  }

  const collectDays = (dir: string, depth: number) => {
    if (dirsVisited >= maxDiscoveryDirs || entriesChecked >= maxDiscoveryEntries) {
      truncated = true
      return
    }
    dirsVisited++
    try {
      const entries = readdirSync(dir, { withFileTypes: true }).map(e => e.name).sort().reverse()
      const maxPerDepth = depth === 0 ? 3 : depth === 1 ? 4 : 16
      if (entries.length > maxPerDepth) truncated = true
      for (const name of entries.slice(0, maxPerDepth)) {
        assertCurrent()
        if (entriesChecked >= maxDiscoveryEntries) {
          truncated = true
          break
        }
        entriesChecked++
        const full = join(dir, name)
        assertProfilePath(full, profile)
        if (depth < 3) collectDays(full, depth + 1)
        else {
          const parsed = parseRolloutFileName(name)
          if (parsed) addEntry(full, parsed.sessionId, parsed.compressed, 'ACTIVE', dir)
        }
      }
    } catch {}
  }
  collectDays(sessionsDir, 0)

  try {
    assertProfilePath(archivedDir, profile)
    const archivedEntries = readdirSync(archivedDir, { withFileTypes: true }).map(e => e.name).sort().reverse()
    if (archivedEntries.length > maxDiscoveryEntries) truncated = true
    for (const name of archivedEntries.slice(0, maxDiscoveryEntries)) {
      assertCurrent()
      const full = join(archivedDir, name)
      assertProfilePath(full, profile)
      const parsed = parseRolloutFileName(name)
      if (parsed) addEntry(full, parsed.sessionId, parsed.compressed, 'ARCHIVED', archivedDir)
    }
  } catch {}

  return { usedIndex: false, truncated, dirsVisited, candidates: [...byDirAndId.values()] }
}

function buildDiscoveredCodexEntry(options: {
  repositoryId: string
  item: { path: string; sessionId: string; mtimeMs: number; compressed: boolean; location: 'ACTIVE' | 'ARCHIVED' }
  line: string
  creatorAccountHash: string
  root: string
  profile: string
  afterMs?: number
  beforeMs?: number
}): DiscoveredCodexSource | undefined {
  const { repositoryId, item, line, creatorAccountHash, root, profile, afterMs, beforeMs } = options
  const record = JSON.parse(line)
  const qualified = qualifyCodexSessionMeta(record, item.sessionId, creatorAccountHash, root, profile)
  if (!qualified.ok) {
    if (qualified.error === 'IDENTITY_UNVERIFIED') {
      const meta = (record as { payload?: Record<string, unknown> })?.payload
      const ts = typeof meta?.timestamp === 'string' && Number.isFinite(Date.parse(meta.timestamp))
        ? meta.timestamp
        : new Date(item.mtimeMs).toISOString()
      const tsMs = Date.parse(ts)
      if (afterMs !== undefined && tsMs < afterMs) return undefined
      if (beforeMs !== undefined && tsMs > beforeMs) return undefined
      return {
        provider: 'codex-native',
        providerSessionId: nativeDigest(JSON.stringify([repositoryId, 'codex', item.sessionId])),
        sourceSessionId: item.sessionId,
        agent: 'codex',
        lastObserved: ts,
        contentAvailability: 'IDENTITY_UNVERIFIED',
        captureCoverage: 'SOURCE_AVAILABLE_NO_HOOK_CAPTURE',
        identityEvidence: 'IDENTITY_UNVERIFIED',
        readinessReason: 'IDENTITY_UNVERIFIED',
        sourceLocation: item.location,
        compressed: item.compressed
      }
    }
    return undefined
  }
  const meta = qualified.meta
  const ts = typeof meta.timestamp === 'string' && Number.isFinite(Date.parse(meta.timestamp)) ? meta.timestamp : new Date(item.mtimeMs).toISOString()
  const tsMs = Date.parse(ts)
  if (afterMs !== undefined && tsMs < afterMs) return undefined
  if (beforeMs !== undefined && tsMs > beforeMs) return undefined
  return {
    provider: 'codex-native',
    providerSessionId: nativeDigest(JSON.stringify([repositoryId, 'codex', item.sessionId])),
    sourceSessionId: item.sessionId,
    agent: 'codex',
    lastObserved: ts,
    contentAvailability: 'AVAILABLE',
    captureCoverage: 'SOURCE_AVAILABLE_NO_HOOK_CAPTURE',
    identityEvidence: 'HASH_AND_PROVIDER_HEADER_VERIFIED',
    readinessReason: 'READY',
    sourceLocation: item.location,
    compressed: item.compressed
  }
}

export function discoverCodexSources(options: {
  storePath: string
  repositoryId: string
  worktreeRoot: string
  after?: string
  before?: string
  limit?: number
  offset?: number
  assertCurrent: () => void
}): CodexDiscoveryResult {
  const grantStatus = readCodexGrantStatus(options.storePath, options.repositoryId)
  if (!grantStatus.configured) {
    return { sessions: [], truncated: false, stats: { usedIndex: false, dirsVisited: 0, filesOpened: 0, headerBytesRead: 0 } }
  }
  if (!grantStatus.ok) {
    return {
      sessions: [],
      truncated: true,
      coverageReason: 'PROFILE_UNAVAILABLE',
      stats: { usedIndex: false, dirsVisited: 0, filesOpened: 0, headerBytesRead: 0 }
    }
  }
  const { profile, creatorAccountHash } = grantStatus
  const root = realpathSync.native(options.worktreeRoot)
  const limit = Math.min(Math.max(options.limit ?? maxDiscoveryResults, 1), maxDiscoveryResults)
  const afterMs = options.after ? Date.parse(options.after) : undefined
  const beforeMs = options.before ? Date.parse(options.before) : undefined

  const collected = collectCodexDirCandidates(profile, root, options.offset ?? 0, options.assertCurrent)
  let truncated = collected.truncated
  let candidates = collected.candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (candidates.length > maxCandidateFiles) {
    truncated = true
    candidates = candidates.slice(0, maxCandidateFiles)
  }

  const found: DiscoveredCodexSource[] = []
  let filesOpened = 0
  let headerBytesRead = 0
  for (const item of candidates) {
    if (item.compressed) continue
    options.assertCurrent()
    if (filesOpened >= maxCandidateFiles || headerBytesRead >= maxTotalHeaderBytes) {
      truncated = true
      break
    }
    if (found.length >= limit) {
      truncated = true
      break
    }
    try {
      if (!sameNativePath(item.path, realpathSync.native(item.path))) continue
      filesOpened++
      const { line, bytesRead } = firstLine(item.path)
      headerBytesRead += bytesRead
      if (!line) continue
      const entry = buildDiscoveredCodexEntry({
        repositoryId: options.repositoryId,
        item,
        line,
        creatorAccountHash,
        root,
        profile,
        afterMs,
        beforeMs
      })
      if (entry) found.push(entry)
    } catch {}
  }

  return {
    sessions: found,
    truncated,
    ...(truncated ? { coverageReason: 'SOURCE_DISCOVERY_LIMIT_REACHED' as const } : {}),
    stats: { usedIndex: collected.usedIndex, dirsVisited: collected.dirsVisited, filesOpened, headerBytesRead }
  }
}

export async function discoverCodexSourcesAsync(options: {
  storePath: string
  repositoryId: string
  worktreeRoot: string
  after?: string
  before?: string
  limit?: number
  offset?: number
  assertCurrent: () => void
}): Promise<CodexDiscoveryResult> {
  const grantStatus = readCodexGrantStatus(options.storePath, options.repositoryId)
  if (!grantStatus.configured) {
    return { sessions: [], truncated: false, stats: { usedIndex: false, dirsVisited: 0, filesOpened: 0, headerBytesRead: 0 } }
  }
  if (!grantStatus.ok) {
    return {
      sessions: [],
      truncated: true,
      coverageReason: 'PROFILE_UNAVAILABLE',
      stats: { usedIndex: false, dirsVisited: 0, filesOpened: 0, headerBytesRead: 0 }
    }
  }
  const { profile, creatorAccountHash } = grantStatus
  const root = realpathSync.native(options.worktreeRoot)
  const limit = Math.min(Math.max(options.limit ?? maxDiscoveryResults, 1), maxDiscoveryResults)
  const afterMs = options.after ? Date.parse(options.after) : undefined
  const beforeMs = options.before ? Date.parse(options.before) : undefined

  const collected = collectCodexDirCandidates(profile, root, options.offset ?? 0, options.assertCurrent)
  let truncated = collected.truncated
  let candidates = collected.candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (candidates.length > maxCandidateFiles) {
    truncated = true
    candidates = candidates.slice(0, maxCandidateFiles)
  }

  const found: DiscoveredCodexSource[] = []
  let filesOpened = 0
  let headerBytesRead = 0
  for (const item of candidates) {
    options.assertCurrent()
    if (filesOpened >= maxCandidateFiles || headerBytesRead >= maxTotalHeaderBytes) {
      truncated = true
      break
    }
    if (found.length >= limit) {
      truncated = true
      break
    }
    try {
      if (!sameNativePath(item.path, realpathSync.native(item.path))) continue
      filesOpened++
      const { line, bytesRead } = await firstLineAsync(item.path, item.compressed, options.assertCurrent)
      headerBytesRead += bytesRead
      if (!line) continue
      const entry = buildDiscoveredCodexEntry({
        repositoryId: options.repositoryId,
        item,
        line,
        creatorAccountHash,
        root,
        profile,
        afterMs,
        beforeMs
      })
      if (entry) found.push(entry)
    } catch {}
  }

  return {
    sessions: found,
    truncated,
    ...(truncated ? { coverageReason: 'SOURCE_DISCOVERY_LIMIT_REACHED' as const } : {}),
    stats: { usedIndex: collected.usedIndex, dirsVisited: collected.dirsVisited, filesOpened, headerBytesRead }
  }
}

export function extractCodexRecordPart(record: unknown, partIndex: number): string | undefined {
  const rec = record as { type?: unknown; payload?: Record<string, unknown> } | null
  const item = rec?.payload
  if (!item || typeof item !== 'object') return undefined
  if (rec?.type === 'event_msg' && (item.type === 'turn_aborted' || item.type === 'error') && partIndex === 0) {
    return typeof item.reason === 'string' ? item.reason : typeof item.message === 'string' ? item.message : String(item.type)
  }
  if (rec?.type !== 'response_item') return undefined
  if (item.type === 'message' && (item.role === 'assistant' || item.role === 'user') && Array.isArray(item.content)) {
    const expectedPartType = item.role === 'user' ? 'input_text' : 'output_text'
    const entry = item.content[partIndex] as { type?: unknown; text?: unknown } | undefined
    return entry?.type === expectedPartType && typeof entry.text === 'string' ? entry.text : undefined
  }
  if ((item.type === 'function_call' || item.type === 'custom_tool_call' || item.type === 'local_shell_call') && partIndex === 0) {
    return typeof item.arguments === 'string'
      ? item.arguments
      : typeof item.input === 'string'
        ? item.input
        : item.action !== undefined ? JSON.stringify(item.action) : '{}'
  }
  if ((item.type === 'function_call_output' || item.type === 'custom_tool_call_output' || item.type === 'local_shell_call_output') && partIndex === 0) {
    return extractTextValue(item.output)
  }
  return undefined
}

export function openCodexSourceHandle(options: {
  storePath: string; repositoryId: string; worktreeRoot: string; nativeHash: string; sourceSessionId: string; assertCurrent: () => void
}): NativeIndexedSourceHandle & { worktreeRootResolved: string; creatorAccountHash: string } {
  const { storePath, repositoryId, worktreeRoot, nativeHash, sourceSessionId, assertCurrent } = options
  if (!uuid.test(sourceSessionId) || nativeDigest(JSON.stringify([repositoryId, 'codex', sourceSessionId])) !== nativeHash) {
    throw new Error('SOURCE_IDENTITY_CONFLICT')
  }
  const { configPath, configText, profile, creatorAccountHash, allowLexicalIndex } = readCodexGrant(storePath, repositoryId)
  const resolved = exactRollout(profile, sourceSessionId)
  const path = resolved.path
  assertProfilePath(path, profile)
  if (!sameNativePath(path, realpathSync.native(path))) throw new Error('SOURCE_PATH_ESCAPE')
  assertCurrent()

  const before = lstatSync(path, { bigint: true })
  if (!before.isFile() || before.nlink !== 1n) throw new Error('SOURCE_LIMIT_REACHED')
  const identity = fileIdentityOf(before)
  const fd = openNoFollowReadOnly(path)
  try {
    if (fileIdentityOf(fstatSync(fd, { bigint: true })) !== identity) {
      throw new Error('SOURCE_REVISION_CHANGED')
    }
    const root = realpathSync.native(worktreeRoot)
    const sourceVariant = resolved.compressed
      ? (resolved.location === 'ARCHIVED' ? 'ARCHIVED_ZSTD' : 'ACTIVE_ZSTD')
      : (resolved.location === 'ARCHIVED' ? 'ARCHIVED_JSONL' : 'ACTIVE_JSONL')
    return {
      fd,
      path,
      profile,
      identity,
      sizeBytes: Number(before.size),
      locatorHash: digest(JSON.stringify([path, root, creatorAccountHash, allowLexicalIndex])),
      liveFingerprint: digest(identity),
      worktreeRootResolved: root,
      creatorAccountHash,
      allowLexicalIndex,
      compressed: resolved.compressed,
      sourceVariant,
      assertPath: () => assertProfilePath(path, profile),
      configUnchanged: () => boundedFile(configPath, 65536) === configText
    }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

function buildCodexStepOptions(options: {
  refs: NativeSessionReferences
  storePath: string
  repositoryId: string
  worktreeId: string
  generation: string
  worktreeRoot: string
  nativeHash: string
  sourceSessionId: string
  mode: 'READ_ONLY' | 'ON_DEMAND' | 'STEP'
  stepBudget?: NativeStepBudget
  onReady?: (ready: { summary: import('./native-session-references').NativeSourceRecordSummary; nativeKey: string; liveFingerprint: string; fd: number }) => void
  assertCurrent: () => void
}): Parameters<typeof runNativeReferenceStep>[0] {
  const {
    refs, storePath, repositoryId, worktreeId, generation, worktreeRoot,
    nativeHash, sourceSessionId, mode, stepBudget, onReady, assertCurrent
  } = options
  const nativeKey = nativeReferenceKey('codex', repositoryId, worktreeId, generation, sourceSessionId)
  let root = ''
  let profile = ''
  let creatorAccountHash = ''
  return {
    refs,
    nativeKey,
    provider: 'codex',
    repositoryId,
    worktreeId,
    generation,
    sourceSessionId,
    normalizer: NATIVE_CODEX_NORMALIZER,
    sourceCoverage: 'TYPED_SOURCE_EVENTS_WITH_ATTEMPTS',
    attemptCoverage: 'EXACT_CALL_ID_PAIRING',
    formatError: 'SOURCE_FORMAT_UNSUPPORTED',
    staleError: 'SOURCE_REVISION_CHANGED',
    mode,
    stepBudget,
    onReady,
    assertCurrent,
    openHandle: () => {
      const h = openCodexSourceHandle({ storePath, repositoryId, worktreeRoot, nativeHash, sourceSessionId, assertCurrent })
      root = h.worktreeRootResolved
      profile = h.profile
      creatorAccountHash = h.creatorAccountHash
      return h
    },
    makeEventId: (ordinal, part, payloadDigest, snapshotIdentity) =>
      digest(JSON.stringify([NATIVE_CODEX_NORMALIZER, sourceSessionId, snapshotIdentity, ordinal, part, payloadDigest])),
    onUnavailableRecord: (lineStart, lineEnd, limitation, acc: StepAccumulator) => {
      if (acc.state.ordinal === 0) throw new Error('SOURCE_FORMAT_UNSUPPORTED')
      acc.state.ordinal++
      emitUnavailableRecord(acc, { ordinal: acc.state.ordinal, limitation, lineStart, lineEnd })
    },
    processRecord: (rawRecord, lineStart, lineEnd, acc: StepAccumulator) => {
      const record = rawRecord as { type?: unknown; timestamp?: unknown; payload?: Record<string, unknown> } | null
      acc.state.ordinal++
      const ordinal = acc.state.ordinal
      const item = record?.payload
      const timestamp = validTimestamp(record?.timestamp)
      const checkRoot = (value: unknown) => typeof value === 'string' && isAbsolute(value) && sameNativePath(realpathSync.native(value), root) && sameNativePath(resolve(value), root)

      if (ordinal === 1) {
        const qualified = qualifyCodexSessionMeta(rawRecord, sourceSessionId, creatorAccountHash, root, profile)
        if (!qualified.ok) throw new Error(qualified.error)
        emitOpaqueRecord(acc, { ordinal, rawRecord, timestamp, limitation: 'PROTOCOL_METADATA', lineStart, lineEnd })
        return
      }
      if (record?.type === 'turn_context') {
        if (!checkRoot(item?.cwd)) throw new Error('ORIGIN_UNVERIFIED')
        if (typeof item?.turn_id === 'string' && item.turn_id.length > 0 && item.turn_id.length <= 128) acc.state.currentTurnId = item.turn_id
        emitOpaqueRecord(acc, { ordinal, rawRecord, timestamp, limitation: 'PROTOCOL_METADATA', lineStart, lineEnd })
        return
      }
      if (record?.type === 'event_msg' && item && typeof item === 'object') {
        if (item.type === 'task_started' && typeof item.turn_id === 'string' && item.turn_id.length > 0 && item.turn_id.length <= 128) {
          acc.state.currentTurnId = item.turn_id
          emitOpaqueRecord(acc, { ordinal, rawRecord, timestamp, limitation: 'PROTOCOL_METADATA', lineStart, lineEnd })
        } else if (
          item.type === 'item_completed' ||
          item.type === 'token_count' ||
          item.type === 'thread_settings_applied' ||
          item.type === 'token_usage_record'
        ) {
          emitOpaqueRecord(acc, { ordinal, rawRecord, timestamp, limitation: 'PROTOCOL_METADATA', lineStart, lineEnd })
        } else if (item.type === 'agent_reasoning' || item.type === 'reasoning') {
          emitOpaqueRecord(acc, { ordinal, rawRecord, timestamp, limitation: 'UNQUALIFIED_CONTENT', lineStart, lineEnd })
        } else if (item.type === 'turn_aborted' || item.type === 'error') {
          const turnId = typeof item.turn_id === 'string' && item.turn_id.length <= 128 ? item.turn_id : acc.state.currentTurnId
          const reason = typeof item.reason === 'string' ? item.reason : typeof item.message === 'string' ? item.message : String(item.type)
          const refusal = item.type === 'turn_aborted' || /(?:DENIED|REJECTED|REFUSED|ABORTED|INTERRUPTED)/i.test(reason)
          acc.state.typedRecords++
          emitIndexedEvent(acc, {
            ordinal, part: 0, type: 'ERROR', rawText: reason, timestamp, turnId,
            status: refusal ? 'REFUSAL' : 'FAILURE',
            errorKind: item.type === 'turn_aborted' ? 'TURN_ABORTED' : 'PROVIDER_ERROR',
            lineStart, lineEnd
          })
        } else {
          emitOpaqueRecord(acc, { ordinal, rawRecord, timestamp, limitation: 'UNRECOGNIZED_FORMAT', lineStart, lineEnd })
        }
        return
      }
      if (record?.type !== 'response_item' || !item || typeof item !== 'object') {
        emitOpaqueRecord(acc, { ordinal, rawRecord, timestamp, limitation: 'UNRECOGNIZED_FORMAT', lineStart, lineEnd })
        return
      }
      if (item.type === 'message' && (item.role === 'assistant' || item.role === 'user') && Array.isArray(item.content)) {
        const expectedPartType = item.role === 'user' ? 'input_text' : 'output_text'
        const mappedType = item.role === 'user' ? 'INPUT' : 'AGENT_UPDATE'
        let emitted = 0
        for (const [part, entry] of (item.content as Array<{ type?: unknown; text?: unknown }>).entries()) {
          if (entry?.type !== expectedPartType || typeof entry.text !== 'string') continue
          emitted++
          emitIndexedEvent(acc, {
            ordinal, part, type: mappedType, rawText: entry.text, timestamp, turnId: acc.state.currentTurnId,
            lineStart, lineEnd
          })
        }
        if (emitted > 0) acc.state.typedRecords++
        else emitOpaqueRecord(acc, { ordinal, rawRecord, timestamp, limitation: 'UNRECOGNIZED_FORMAT', lineStart, lineEnd })
        return
      }
      if (item.type === 'message' && item.role === 'developer') {
        emitOpaqueRecord(acc, { ordinal, rawRecord, timestamp, limitation: 'PROTOCOL_METADATA', lineStart, lineEnd })
        return
      }
      if (item.type === 'function_call' || item.type === 'custom_tool_call' || item.type === 'local_shell_call') {
        const rawToolName = String(item.name || item.type || 'shell')
        const tool = sanitize(rawToolName).slice(0, 80)
        const callId = typeof item.call_id === 'string' && item.call_id.length > 0 ? item.call_id : undefined
        const rawInput = typeof item.arguments === 'string'
          ? item.arguments
          : typeof item.input === 'string'
            ? item.input
            : item.action !== undefined ? JSON.stringify(item.action) : '{}'
        acc.state.typedRecords++
        const event = emitIndexedEvent(acc, {
          ordinal, part: 0, type: 'TOOL_CALL', rawText: rawInput, timestamp, tool, turnId: acc.state.currentTurnId,
          status: 'DANGLING', pairing: 'DANGLING', lineStart, lineEnd
        })
        acc.state.attemptCounts.total++
        acc.state.attemptCounts.dangling++
        const ref = {
          eventId: event.eventId, ordinal,
          ...(timestamp ? { timestamp } : {}),
          tool,
          ...(acc.state.currentTurnId ? { turnId: acc.state.currentTurnId } : {}),
          pairing: 'DANGLING'
        }
        const canonicalSkillTool = resolveCanonicalSkillTool(rawToolName)
        if (canonicalSkillTool) {
          const callArgs = extractSkillCallMetadata(canonicalSkillTool, rawInput)
          if (callId) {
            acc.state.openSkillCalls ??= {}
            if (!acc.state.openSkillCalls[callId]) {
              acc.state.openSkillCalls[callId] = {
                ...callArgs,
                canonicalTool: canonicalSkillTool,
                callEventId: event.eventId,
                ordinal,
                ...(timestamp ? { timestamp } : {}),
                ...(acc.state.currentTurnId ? { turnId: acc.state.currentTurnId } : {})
              }
            }
          } else {
            const obs = qualifySkillToolObservation({
              canonicalTool: canonicalSkillTool,
              callArgs,
              hasResult: false,
              nativeSessionId: nativeHash,
              repositoryId,
              provider: 'codex',
              worktreeId,
              generation,
              sourceSurface: 'native_source_event',
              sourceContract: 'codex-native/v1',
              sourceNamespace: nativeKey,
              callEventId: event.eventId,
              originalEventId: event.eventId,
              turnId: acc.state.currentTurnId ?? null,
              sessionBindingState: 'BOUND_BY_WITNESS',
              bindingAuthority: 'codex_native_source',
              captureOrder: ordinal,
              sourceTimestamp: timestamp ?? null
            })
            if (obs) acc.skillEvents.push(obs)
          }
        }
        if (callId && !acc.state.openCalls[callId]) {
          acc.state.openCalls[callId] = ref
        } else if (!callId && acc.state.unmatchedDangling.length < 5) {
          acc.state.unmatchedDangling.push(ref)
        }
        return
      }
      if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output' || item.type === 'local_shell_call_output') {
        const callId = typeof item.call_id === 'string' && item.call_id.length > 0 ? item.call_id : undefined
        const rawOutput = extractTextValue(item.output)
        const classified = classifyStructuredOutput(rawOutput)
        const match = callId ? acc.state.openCalls[callId] : undefined
        const pairing = match ? 'PAIRED' : 'UNPAIRED'
        acc.state.typedRecords++
        const resultEvent = emitIndexedEvent(acc, {
          ordinal, part: 0, type: classified.isError ? 'ERROR' : 'TOOL_RESULT', rawText: rawOutput,
          timestamp, tool: match?.tool, turnId: acc.state.currentTurnId,
          status: classified.status, pairing, errorKind: classified.errorKind, lineStart, lineEnd
        })
        const skillCall = callId ? acc.state.openSkillCalls?.[callId] : undefined
        if (skillCall && callId) {
          const obs = qualifySkillToolObservation({
            canonicalTool: skillCall.canonicalTool,
            callArgs: skillCall,
            rawOutput,
            hasResult: true,
            nativeSessionId: nativeHash,
            repositoryId,
            provider: 'codex',
            worktreeId,
            generation,
            sourceSurface: 'native_source_event',
            sourceContract: 'codex-native/v1',
            sourceNamespace: nativeKey,
            callEventId: skillCall.callEventId,
            resultEventId: resultEvent.eventId,
            originalEventId: resultEvent.eventId,
            turnId: acc.state.currentTurnId ?? skillCall.turnId ?? null,
            sessionBindingState: 'BOUND_BY_WITNESS',
            bindingAuthority: 'codex_native_source',
            captureOrder: ordinal,
            sourceTimestamp: timestamp ?? null
          })
          if (obs) acc.skillEvents.push(obs)
          delete acc.state.openSkillCalls![callId]
        }
        if (match && callId) {
          acc.state.attemptCounts.dangling--
          applyAttemptOutcome(acc.state.attemptCounts, classified.status)
          const inChunk = acc.events.find(e => e.eventId === match.eventId)
          if (inChunk) {
            inChunk.status = classified.status
            inChunk.pairing = 'PAIRED'
          } else {
            acc.pairUpdates.push({ eventId: match.eventId, status: classified.status, pairing: 'PAIRED' })
          }
          delete acc.state.openCalls[callId]
        } else if (classified.isError) {
          acc.state.attemptCounts.total++
          applyAttemptOutcome(acc.state.attemptCounts, classified.status)
        }
        return
      }
      emitOpaqueRecord(acc, { ordinal, rawRecord, timestamp, limitation: 'UNRECOGNIZED_FORMAT', lineStart, lineEnd })
    },
    onFinalizeSkillCalls: (acc: StepAccumulator) => {
      const open = acc.state.openSkillCalls
      if (!open) return
      for (const [callId, skillCall] of Object.entries(open)) {
        const obs = qualifySkillToolObservation({
          canonicalTool: skillCall.canonicalTool,
          callArgs: skillCall,
          hasResult: false,
          nativeSessionId: nativeHash,
          repositoryId,
          provider: 'codex',
          worktreeId,
          generation,
          sourceSurface: 'native_source_event',
          sourceContract: 'codex-native/v1',
          sourceNamespace: nativeKey,
          callEventId: skillCall.callEventId,
          originalEventId: skillCall.callEventId,
          turnId: skillCall.turnId ?? null,
          sessionBindingState: 'BOUND_BY_WITNESS',
          bindingAuthority: 'codex_native_source',
          captureOrder: skillCall.ordinal,
          sourceTimestamp: skillCall.timestamp ?? null
        })
        if (obs) acc.skillEvents.push(obs)
        delete open[callId]
      }
    }
  }
}

export function stepCodexSourceIndex(options: Parameters<typeof buildCodexStepOptions>[0]): NativeReferenceStepResult {
  return runNativeReferenceStep(buildCodexStepOptions(options))
}

export function stepCodexSourceIndexAsync(options: Parameters<typeof buildCodexStepOptions>[0]): Promise<NativeReferenceStepResult> {
  return runNativeReferenceStepAsync(buildCodexStepOptions(options))
}
