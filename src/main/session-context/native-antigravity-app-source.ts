import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertProfilePath, assertUserOwned } from '../local-mcp-clients/safe-config-file'
import { antigravityAppLocatorDigest, antigravityAppSessionId, antigravityAppTranscriptPath } from './antigravity-app-locator'
import { boundedFile, nativeDigest, sameNativePath } from './native-hooks'
import type { NativeSourceAttemptRef, NativeSourceEvent } from './native-source-events'
import { sanitize } from './privacy'

const maxBytes = 8 * 1024 * 1024
const maxRecordBytes = 512 * 1024
const maxRecords = 16_384
const maxEvents = 512
const maxDiscoveryRows = 256
const maxDiscoveryResults = 20
const sha256Pattern = /^[a-f0-9]{64}$/
const fingerprint = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':')

export interface DiscoveredAntigravityAppSource {
  provider: 'antigravity-native'
  providerSessionId: string
  sourceSessionId: string
  agent: 'antigravity'
  lastObserved?: string
  contentAvailability: 'AVAILABLE'
  captureCoverage: 'SOURCE_AVAILABLE_NO_HOOK_CAPTURE'
  identityEvidence: 'HASH_AND_APP_LOCATOR_VERIFIED'
}

export interface AntigravityAppDiscoveryResult {
  sessions: DiscoveredAntigravityAppSource[]
  truncated: boolean
  coverageReason?: 'NO_METADATA_INDEX' | 'SOURCE_DISCOVERY_LIMIT_REACHED' | 'PROFILE_UNAVAILABLE'
  stats: {
    usedIndex: boolean
    rowsScanned: number
    transcriptFilesOpened: number
    transcriptBytesRead: number
  }
}

interface AntigravityAppGrant {
  configPath: string
  configText: string
  profile: string
  sessionHash?: string
  sessionHashes?: string[]
}

function stripVerbatimPrefix(path: string): string {
  return process.platform === 'win32' && path.startsWith('\\\\?\\') ? path.slice(4) : path
}

function readAntigravityAppGrantStatus(storePath: string, repositoryId: string, nativeHash?: string):
  | { configured: false }
  | { configured: true; ok: false }
  | { configured: true; ok: true; grant: AntigravityAppGrant } {
  const directory = dirname(storePath), configPath = join(directory, 'session-context.provider.json')
  let configText: string
  try {
    assertProfilePath(configPath, directory)
    assertUserOwned(configPath)
    configText = boundedFile(configPath, 65536)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { configured: false }
    return { configured: true, ok: false }
  }
  let config: Record<string, unknown>
  try {
    config = JSON.parse(configText) as Record<string, unknown>
  } catch {
    return { configured: true, ok: false }
  }
  const nativeSources = config?.nativeSources as Record<string, unknown> | undefined
  if (!nativeSources || nativeSources.antigravityApp === undefined) return { configured: false }
  try {
    const grant = nativeSources.antigravityApp as Record<string, unknown> | null
    if (!grant || typeof grant !== 'object' || Array.isArray(grant)) throw new Error()
    const profile = grant.profile
    if (config.repositoryId !== repositoryId || typeof profile !== 'string' || profile.length === 0 || profile.length > 4096 || !isAbsolute(profile)) {
      throw new Error()
    }
    if (grant.sessionHash !== undefined && (typeof grant.sessionHash !== 'string' || !sha256Pattern.test(grant.sessionHash))) {
      throw new Error()
    }
    if (grant.sessionHashes !== undefined) {
      if (!Array.isArray(grant.sessionHashes) || grant.sessionHashes.length > 1024 ||
        !grant.sessionHashes.every((v: unknown) => typeof v === 'string' && sha256Pattern.test(v))) {
        throw new Error()
      }
    }
    const sessionHash = grant.sessionHash as string | undefined
    const sessionHashes = grant.sessionHashes as string[] | undefined
    if (nativeHash !== undefined) {
      if (sessionHash !== undefined && sessionHash !== nativeHash) throw new Error()
      if (sessionHashes !== undefined && !sessionHashes.includes(nativeHash)) throw new Error()
    }
    assertProfilePath(profile, profile)
    assertUserOwned(profile)
    if (!lstatSync(profile).isDirectory() || !sameNativePath(realpathSync.native(profile), profile)) throw new Error()
    return { configured: true, ok: true, grant: { configPath, configText, profile, sessionHash, sessionHashes } }
  } catch {
    return { configured: true, ok: false }
  }
}

function readAntigravityAppGrant(storePath: string, repositoryId: string, nativeHash?: string): AntigravityAppGrant {
  const status = readAntigravityAppGrantStatus(storePath, repositoryId, nativeHash)
  if (!status.configured || !status.ok) throw new Error('PROFILE_UNAVAILABLE')
  return status.grant
}

function canonicalLocatorHash(path: string): string {
  const canonical = process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path)
  return createHash('sha256').update(canonical).digest('hex')
}

function normalizeMetadataTimestamp(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const normalized = raw.trim().replace(
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))?(.*)$/,
    (_, d: string, t: string, frac: string | undefined, tz: string) =>
      `${d}T${t}${frac ? '.' + frac.slice(0, 3) : ''}${tz ? (tz === '+00:00' ? 'Z' : tz) : 'Z'}`
  )
  const ms = Date.parse(normalized)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

function canonicalUriMatchesRoot(rawUri: unknown, resolvedRoot: string): boolean {
  if (typeof rawUri !== 'string' || !rawUri || rawUri.length > 4096) return false
  try {
    const parsed = new URL(rawUri)
    if (parsed.protocol !== 'file:') return false
    const fsPath = stripVerbatimPrefix(fileURLToPath(parsed))
    if (!isAbsolute(fsPath)) return false
    const canonical = realpathSync.native(fsPath)
    return sameNativePath(canonical, resolvedRoot)
  } catch {
    return false
  }
}

function workspaceUrisMatchRoot(rawUris: unknown, resolvedRoot: string): boolean {
  if (typeof rawUris !== 'string' || !rawUris) return false
  let parsed: unknown
  try { parsed = JSON.parse(rawUris) } catch { return false }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 16) return false
  // Every entry must resolve canonically to the queried checkout so multi-workspace sessions are never guessed.
  return parsed.every(uri => canonicalUriMatchesRoot(uri, resolvedRoot))
}

function openSummariesDbChecked(profile: string): { db: Database.Database; dbPath: string; identity: string } | undefined {
  const dbPath = join(profile, 'conversation_summaries.db')
  let stat: BigIntStats
  try {
    assertProfilePath(dbPath, profile)
    assertUserOwned(dbPath)
    stat = lstatSync(dbPath, { bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n || !sameNativePath(realpathSync.native(dbPath), dbPath)) return undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
    throw new Error('PROFILE_UNAVAILABLE')
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 100 })
  return { db, dbPath, identity: fingerprint(stat) }
}

function summaryRowMatchesWorktree(
  profile: string,
  sourceSessionId: string,
  resolvedRoot: string,
  assertCurrent: () => void
): 'MATCHED' | 'MISMATCHED' | 'UNAVAILABLE' {
  assertCurrent()
  const handle = openSummariesDbChecked(profile)
  if (!handle) return 'UNAVAILABLE'
  try {
    let row: { workspace_uris?: unknown } | undefined
    try {
      row = handle.db.prepare(
        'SELECT workspace_uris FROM conversation_summaries WHERE conversation_id = ? LIMIT 1'
      ).get(sourceSessionId) as { workspace_uris?: unknown } | undefined
    } catch {
      return 'UNAVAILABLE'
    }
    assertCurrent()
    assertProfilePath(handle.dbPath, profile)
    const current = lstatSync(handle.dbPath, { bigint: true })
    if (fingerprint(current) !== handle.identity) throw new Error('SOURCE_STALE')
    if (!row) return 'UNAVAILABLE'
    return workspaceUrisMatchRoot(row.workspace_uris, resolvedRoot) ? 'MATCHED' : 'MISMATCHED'
  } finally {
    handle.db.close()
  }
}

function readTranscriptChecked(path: string, profile: string, assertCurrent: () => void) {
  assertCurrent()
  let stat: BigIntStats
  try {
    assertProfilePath(path, profile)
    stat = lstatSync(path, { bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n || !sameNativePath(realpathSync.native(path), path)) throw new Error('IDENTITY_MISMATCH')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('SOURCE_NOT_FOUND')
    throw error
  }
  if (stat.size > BigInt(maxBytes)) throw new Error('SOURCE_LIMIT_REACHED')
  const identity = fingerprint(stat)
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (fingerprint(fstatSync(fd, { bigint: true })) !== identity) throw new Error('SOURCE_STALE')
    const data = Buffer.alloc(Number(stat.size))
    for (let offset = 0; offset < data.length;) {
      assertCurrent()
      const count = readSync(fd, data, offset, Math.min(65536, data.length - offset), offset)
      if (!count) throw new Error('SOURCE_STALE')
      offset += count
    }
    if (fingerprint(fstatSync(fd, { bigint: true })) !== identity) throw new Error('SOURCE_STALE')
    try { return { identity, text: new TextDecoder('utf-8', { fatal: true }).decode(data) } }
    catch { throw new Error('FORMAT_UNSUPPORTED') }
  } finally { closeSync(fd) }
}

export function discoverAntigravityAppSources(options: {
  storePath: string
  repositoryId: string
  worktreeRoot: string
  after?: string
  before?: string
  limit?: number
  assertCurrent: () => void
}): AntigravityAppDiscoveryResult {
  const status = readAntigravityAppGrantStatus(options.storePath, options.repositoryId)
  if (!status.configured) {
    return { sessions: [], truncated: false, stats: { usedIndex: false, rowsScanned: 0, transcriptFilesOpened: 0, transcriptBytesRead: 0 } }
  }
  if (!status.ok) {
    return {
      sessions: [],
      truncated: true,
      coverageReason: 'PROFILE_UNAVAILABLE',
      stats: { usedIndex: false, rowsScanned: 0, transcriptFilesOpened: 0, transcriptBytesRead: 0 }
    }
  }
  const grant = status.grant
  let handle: ReturnType<typeof openSummariesDbChecked>
  try {
    options.assertCurrent()
    handle = openSummariesDbChecked(grant.profile)
  } catch {
    return {
      sessions: [],
      truncated: true,
      coverageReason: 'PROFILE_UNAVAILABLE',
      stats: { usedIndex: false, rowsScanned: 0, transcriptFilesOpened: 0, transcriptBytesRead: 0 }
    }
  }
  if (!handle) {
    return {
      sessions: [],
      truncated: true,
      coverageReason: 'NO_METADATA_INDEX',
      stats: { usedIndex: false, rowsScanned: 0, transcriptFilesOpened: 0, transcriptBytesRead: 0 }
    }
  }

  const resolvedRoot = realpathSync.native(options.worktreeRoot)
  const afterMs = options.after ? Date.parse(options.after) : undefined
  const beforeMs = options.before ? Date.parse(options.before) : undefined
  const limit = Math.min(Math.max(options.limit ?? maxDiscoveryResults, 1), maxDiscoveryResults)
  let rowsScanned = 0
  let truncated = false
  let coverageReason: AntigravityAppDiscoveryResult['coverageReason']
  const found: DiscoveredAntigravityAppSource[] = []

  try {
    let rows: Array<{ conversation_id?: unknown; workspace_uris?: unknown; last_modified_time?: unknown }>
    try {
      rows = handle.db.prepare(
        `SELECT conversation_id, workspace_uris, last_modified_time
         FROM conversation_summaries
         ORDER BY last_modified_time DESC
         LIMIT ?`
      ).all(maxDiscoveryRows + 1) as Array<{ conversation_id?: unknown; workspace_uris?: unknown; last_modified_time?: unknown }>
    } catch {
      return {
        sessions: [],
        truncated: true,
        coverageReason: 'NO_METADATA_INDEX',
        stats: { usedIndex: false, rowsScanned: 0, transcriptFilesOpened: 0, transcriptBytesRead: 0 }
      }
    }

    if (rows.length > maxDiscoveryRows) {
      truncated = true
      coverageReason = 'SOURCE_DISCOVERY_LIMIT_REACHED'
    }

    for (const row of rows.slice(0, maxDiscoveryRows)) {
      options.assertCurrent()
      rowsScanned++
      if (typeof row.conversation_id !== 'string' || !antigravityAppSessionId.test(row.conversation_id)) continue
      const nativeHash = nativeDigest(JSON.stringify([options.repositoryId, 'antigravity', row.conversation_id]))
      if (grant.sessionHash !== undefined && grant.sessionHash !== nativeHash) continue
      if (grant.sessionHashes !== undefined && !grant.sessionHashes.includes(nativeHash)) continue
      if (!workspaceUrisMatchRoot(row.workspace_uris, resolvedRoot)) continue
      const lastObserved = normalizeMetadataTimestamp(row.last_modified_time)
      if ((afterMs !== undefined || beforeMs !== undefined) && lastObserved === undefined) continue
      if (afterMs !== undefined && lastObserved !== undefined && Date.parse(lastObserved) < afterMs) continue
      if (beforeMs !== undefined && lastObserved !== undefined && Date.parse(lastObserved) > beforeMs) continue
      if (found.length >= limit) {
        truncated = true
        coverageReason = 'SOURCE_DISCOVERY_LIMIT_REACHED'
        break
      }
      found.push({
        provider: 'antigravity-native',
        providerSessionId: nativeHash,
        sourceSessionId: row.conversation_id,
        agent: 'antigravity',
        ...(lastObserved ? { lastObserved } : {}),
        contentAvailability: 'AVAILABLE',
        captureCoverage: 'SOURCE_AVAILABLE_NO_HOOK_CAPTURE',
        identityEvidence: 'HASH_AND_APP_LOCATOR_VERIFIED'
      })
    }

    options.assertCurrent()
    assertProfilePath(handle.dbPath, grant.profile)
    assertProfilePath(grant.configPath, dirname(options.storePath))
    const currentDb = lstatSync(handle.dbPath, { bigint: true })
    if (fingerprint(currentDb) !== handle.identity || boundedFile(grant.configPath, 65536) !== grant.configText) {
      return {
        sessions: [],
        truncated: true,
        coverageReason: 'PROFILE_UNAVAILABLE',
        stats: { usedIndex: true, rowsScanned, transcriptFilesOpened: 0, transcriptBytesRead: 0 }
      }
    }
  } catch {
    return {
      sessions: [],
      truncated: true,
      coverageReason: 'PROFILE_UNAVAILABLE',
      stats: { usedIndex: true, rowsScanned, transcriptFilesOpened: 0, transcriptBytesRead: 0 }
    }
  } finally {
    handle.db.close()
  }

  return {
    sessions: found,
    truncated,
    ...(coverageReason ? { coverageReason } : {}),
    stats: { usedIndex: true, rowsScanned, transcriptFilesOpened: 0, transcriptBytesRead: 0 }
  }
}

export function antigravityAppSourceSnapshot(options: {
  storePath: string
  repositoryId: string
  nativeHash: string
  sourceSessionId: string
  locatorDigest?: string
  worktreeRoot?: string
  registryVerifiedOrigin?: boolean
  assertCurrent: () => void
}) {
  const { storePath, repositoryId, nativeHash, sourceSessionId, locatorDigest, worktreeRoot, registryVerifiedOrigin, assertCurrent } = options
  if (!antigravityAppSessionId.test(sourceSessionId) ||
    nativeDigest(JSON.stringify([repositoryId, 'antigravity', sourceSessionId])) !== nativeHash) throw new Error('IDENTITY_MISMATCH')
  const { configPath, configText, profile } = readAntigravityAppGrant(storePath, repositoryId, nativeHash)
  const directory = dirname(storePath)

  const path = antigravityAppTranscriptPath(profile, sourceSessionId)
  if (locatorDigest !== undefined && antigravityAppLocatorDigest(sourceSessionId, path) !== locatorDigest) throw new Error('IDENTITY_MISMATCH')
  if (locatorDigest === undefined) {
    if (!worktreeRoot) throw new Error('ORIGIN_UNVERIFIED')
    const resolvedRoot = realpathSync.native(worktreeRoot)
    const dbMatch = summaryRowMatchesWorktree(profile, sourceSessionId, resolvedRoot, assertCurrent)
    if (dbMatch === 'MISMATCHED') throw new Error('ORIGIN_UNVERIFIED')
    if (dbMatch === 'UNAVAILABLE' && !registryVerifiedOrigin) throw new Error('ORIGIN_UNVERIFIED')
  }

  const effectiveLocator = locatorDigest ?? canonicalLocatorHash(path)
  const { identity, text } = readTranscriptChecked(path, profile, assertCurrent)

  if (!text.trim() || !text.endsWith('\n')) throw new Error('FORMAT_UNSUPPORTED')
  const events: NativeSourceEvent[] = []
  const attempts: NativeSourceAttemptRef[] = []
  let omitted = 0
  let ordinal = 0
  const pushEvent = (part: number, type: NativeSourceEvent['type'], timestamp: string, rawText: string, extra: Partial<NativeSourceEvent> = {}) => {
    if (events.length >= maxEvents) { omitted++; return undefined }
    const content = sanitize(rawText), payloadDigest = nativeDigest(content)
    const event: NativeSourceEvent = {
      eventId: nativeDigest(JSON.stringify([identity, ordinal, part, payloadDigest])),
      ordinal,
      type,
      ...(extra.tool ? { tool: extra.tool } : {}),
      ...(extra.status ? { status: extra.status } : {}),
      ...(extra.pairing ? { pairing: extra.pairing } : {}),
      ...(extra.errorKind ? { errorKind: extra.errorKind } : {}),
      bytes: Buffer.byteLength(content),
      payloadDigest,
      content,
      sanitized: rawText !== content
    }
    events.push(event)
    return event
  }
  for (let offset = 0; offset < text.length;) {
    assertCurrent()
    const next = text.indexOf('\n', offset)
    const line = text.slice(offset, next)
    offset = next + 1
    if (++ordinal > maxRecords) throw new Error('SOURCE_LIMIT_REACHED')
    if (Buffer.byteLength(line) > maxRecordBytes) throw new Error('SOURCE_LIMIT_REACHED')
    let entry
    try { entry = JSON.parse(line) } catch { throw new Error('FORMAT_UNSUPPORTED') }
    if (!Number.isSafeInteger(entry?.step_index) || entry.step_index < 0 || typeof entry.type !== 'string' ||
      typeof entry.source !== 'string' || typeof entry.created_at !== 'string' || !Number.isFinite(Date.parse(entry.created_at))) throw new Error('FORMAT_UNSUPPORTED')
    const ts = entry.created_at as string
    if (entry.type === 'USER_INPUT' && (entry.source === 'USER_EXPLICIT' || entry.source === 'USER') && typeof entry.content === 'string') {
      pushEvent(0, 'INPUT', ts, entry.content)
      continue
    }
    if (entry.type === 'PLANNER_RESPONSE' && entry.source === 'MODEL') {
      let part = 0
      if (Array.isArray(entry.tool_calls)) {
        for (const tc of entry.tool_calls as { name?: unknown; args?: unknown }[]) {
          if (!tc || typeof tc.name !== 'string') continue
          const tool = sanitize(tc.name).slice(0, 80)
          const rawArgs = tc.args !== undefined ? JSON.stringify(tc.args) : '{}'
          const ev = pushEvent(part++, 'TOOL_CALL', ts, rawArgs, { tool, status: entry.status === 'ERROR' ? 'FAILURE' : 'UNKNOWN', pairing: 'NO_NATIVE_CALL_PAIR_ID' })
          if (ev) attempts.push({ eventId: ev.eventId, ordinal, timestamp: ts, tool, status: ev.status!, pairing: 'NO_NATIVE_CALL_PAIR_ID' })
        }
      }
      if (typeof entry.content === 'string' && entry.content.length > 0) {
        pushEvent(part++, 'AGENT_UPDATE', ts, entry.content)
      }
      if (entry.status === 'ERROR' || typeof entry.error === 'string') {
        const errorKind = typeof entry.error_code === 'string' ? entry.error_code : 'PLANNER_ERROR'
        const rawErr = typeof entry.error === 'string' ? entry.error : typeof entry.content === 'string' ? entry.content : errorKind
        pushEvent(part++, 'ERROR', ts, rawErr, { status: 'FAILURE', errorKind })
      }
      continue
    }
    if (entry.type === 'ERROR_MESSAGE' || entry.status === 'ERROR' || typeof entry.error === 'string') {
      const errorKind = typeof entry.error_code === 'string' ? entry.error_code : entry.type === 'ERROR_MESSAGE' ? 'ERROR_MESSAGE' : `${entry.type}_ERROR`
      const refusal = /(?:DENIED|REJECTED|REFUSED)/i.test(errorKind)
      const rawErr = typeof entry.error === 'string' ? entry.error : typeof entry.content === 'string' ? entry.content : errorKind
      pushEvent(0, 'ERROR', ts, rawErr, { status: refusal ? 'REFUSAL' : 'FAILURE', errorKind })
      continue
    }
    if ((entry.type === 'GENERIC' || entry.type === 'GENERATE_IMAGE') && entry.source === 'MODEL' && typeof entry.content === 'string' && entry.content.length > 0) {
      pushEvent(0, 'TOOL_RESULT', ts, entry.content, { status: 'UNKNOWN', pairing: 'NO_NATIVE_CALL_PAIR_ID' })
      continue
    }
    omitted++
  }
  assertCurrent()
  try {
    assertProfilePath(path, profile)
    assertProfilePath(configPath, directory)
    if (fingerprint(lstatSync(path, { bigint: true })) !== identity || boundedFile(configPath, 65536) !== configText) throw new Error()
  } catch { throw new Error('SOURCE_STALE') }
  if (locatorDigest === undefined) {
    if (!worktreeRoot) throw new Error('ORIGIN_UNVERIFIED')
    const dbMatch = summaryRowMatchesWorktree(profile, sourceSessionId, realpathSync.native(worktreeRoot), assertCurrent)
    if (dbMatch === 'MISMATCHED' || (dbMatch === 'UNAVAILABLE' && !registryVerifiedOrigin)) throw new Error('ORIGIN_UNVERIFIED')
  }
  if (!events.length) throw new Error('SOURCE_CONTENT_UNAVAILABLE')
  return {
    fingerprint: nativeDigest(JSON.stringify([effectiveLocator, identity])),
    events,
    attempts,
    omitted,
    sourceCoverage: 'TYPED_SOURCE_EVENTS_UNPAIRED_TOOLS' as const,
    attemptCoverage: 'NO_NATIVE_CALL_PAIR_ID' as const
  }
}
