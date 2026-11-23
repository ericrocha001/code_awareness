import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, realpathSync, type BigIntStats } from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertProfilePath, assertUserOwned } from '../local-mcp-clients/safe-config-file'
import {
  antigravityAppLocatorDigest,
  antigravityAppSessionId,
  antigravityAppTranscriptCandidates,
  type AntigravityTranscriptVariant
} from './antigravity-app-locator'
import { boundedFile, nativeDigest, sameNativePath } from './native-hooks'
import type { NativeSourceEventType } from './native-source-events'
import {
  applyAttemptOutcome,
  emitIndexedEvent,
  emitOpaqueRecord,
  emitUnavailableRecord,
  openNoFollowReadOnly,
  runNativeReferenceStep,
  type NativeIndexedSourceHandle,
  type NativeReferenceStepResult,
  type NativeStepBudget,
  type StepAccumulator
} from './native-source-index'
import { NATIVE_ANTIGRAVITY_NORMALIZER, nativeReferenceKey, type NativeSessionReferences } from './native-session-references'
import { digest, sanitize } from './privacy'

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
  allowLexicalIndex?: boolean
}

function stripVerbatimPrefix(path: string): string {
  return process.platform === 'win32' && path.startsWith('\\\\?\\') ? path.slice(4) : path
}

export type SourceReadinessReason =
  | 'GRANT_MISSING'
  | 'GRANT_INVALID_OR_REVOKED'
  | 'SOURCE_NOT_FOUND'
  | 'IDENTITY_MISMATCH'
  | 'SOURCE_FORMAT_UNSUPPORTED'
  | 'SOURCE_STALE'
  | 'INDEXING_PENDING'
  | 'READY'

export function readAntigravityAppGrantStatus(storePath: string, repositoryId: string, nativeHash?: string):
  | { configured: false; reason: 'GRANT_MISSING' }
  | { configured: true; ok: false; reason: 'GRANT_INVALID_OR_REVOKED' }
  | { configured: true; ok: true; grant: AntigravityAppGrant } {
  const directory = dirname(storePath), configPath = join(directory, 'session-context.provider.json')
  let configText: string
  try {
    assertProfilePath(configPath, directory)
    assertUserOwned(configPath)
    configText = boundedFile(configPath, 65536)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { configured: false, reason: 'GRANT_MISSING' }
    return { configured: true, ok: false, reason: 'GRANT_INVALID_OR_REVOKED' }
  }
  let config: Record<string, unknown>
  try {
    config = JSON.parse(configText) as Record<string, unknown>
  } catch {
    return { configured: true, ok: false, reason: 'GRANT_INVALID_OR_REVOKED' }
  }
  const nativeSources = config?.nativeSources as Record<string, unknown> | undefined
  if (!nativeSources || nativeSources.antigravityApp === undefined) return { configured: false, reason: 'GRANT_MISSING' }
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
    const allowLexicalIndex = grant.allowLexicalIndex === true
    assertProfilePath(profile, profile)
    assertUserOwned(profile)
    if (!lstatSync(profile).isDirectory() || !sameNativePath(realpathSync.native(profile), profile)) throw new Error()
    return { configured: true, ok: true, grant: { configPath, configText, profile, sessionHash, sessionHashes, allowLexicalIndex } }
  } catch {
    return { configured: true, ok: false, reason: 'GRANT_INVALID_OR_REVOKED' }
  }
}

export function resolveAntigravityTranscriptCandidate(
  profile: string,
  sourceSessionId: string,
  locatorDigest?: string
): {
  path: string
  variant: AntigravityTranscriptVariant
  coexistingVariants: AntigravityTranscriptVariant[]
  stat: BigIntStats
} {
  const candidates = antigravityAppTranscriptCandidates(profile, sourceSessionId)
  if (locatorDigest !== undefined) {
    const matched = candidates.find(c => antigravityAppLocatorDigest(sourceSessionId, c.path) === locatorDigest)
    if (!matched) throw new Error('IDENTITY_MISMATCH')
    let stat: BigIntStats
    try {
      assertProfilePath(matched.path, profile)
      stat = lstatSync(matched.path, { bigint: true })
      if (!stat.isFile() || stat.nlink !== 1n || !sameNativePath(realpathSync.native(matched.path), matched.path)) {
        throw new Error('IDENTITY_MISMATCH')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('SOURCE_NOT_FOUND')
      throw error
    }
    return { path: matched.path, variant: matched.variant, coexistingVariants: [matched.variant], stat }
  }

  const available: Array<{ path: string; variant: AntigravityTranscriptVariant; stat: BigIntStats }> = []
  for (const candidate of candidates) {
    try {
      assertProfilePath(candidate.path, profile)
      const stat = lstatSync(candidate.path, { bigint: true })
      if (!stat.isFile() || stat.nlink !== 1n || !sameNativePath(realpathSync.native(candidate.path), candidate.path)) {
        throw new Error('IDENTITY_MISMATCH')
      }
      available.push({ path: candidate.path, variant: candidate.variant, stat })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
  if (!available.length) throw new Error('SOURCE_NOT_FOUND')
  const selected = available[0]
  return {
    path: selected.path,
    variant: selected.variant,
    coexistingVariants: available.map(a => a.variant),
    stat: selected.stat
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

interface DecodedAntigravityPart {
  part: number
  type: NativeSourceEventType
  timestamp: string
  rawText: string
  tool?: string
  status?: string
  pairing?: string
  errorKind?: string
  isAttempt?: boolean
}

function decodeAntigravityRecordParts(rawRecord: unknown): { timestamp: string; parts: DecodedAntigravityPart[]; omitted: boolean } {
  const entry = rawRecord as Record<string, unknown> | null
  if (
    !entry ||
    !Number.isSafeInteger(entry.step_index) ||
    (entry.step_index as number) < 0 ||
    typeof entry.type !== 'string' ||
    typeof entry.source !== 'string' ||
    typeof entry.created_at !== 'string' ||
    !Number.isFinite(Date.parse(entry.created_at))
  ) {
    throw new Error('FORMAT_UNSUPPORTED')
  }
  const ts = entry.created_at
  const parts: DecodedAntigravityPart[] = []
  if (entry.type === 'USER_INPUT' && (entry.source === 'USER_EXPLICIT' || entry.source === 'USER') && typeof entry.content === 'string') {
    parts.push({ part: 0, type: 'INPUT', timestamp: ts, rawText: entry.content })
    return { timestamp: ts, parts, omitted: false }
  }
  if (entry.type === 'PLANNER_RESPONSE' && entry.source === 'MODEL') {
    let part = 0
    if (Array.isArray(entry.tool_calls)) {
      for (const tc of entry.tool_calls as { name?: unknown; args?: unknown }[]) {
        if (!tc || typeof tc.name !== 'string') continue
        const tool = sanitize(tc.name).slice(0, 80)
        const rawArgs = tc.args !== undefined ? JSON.stringify(tc.args) : '{}'
        const status = entry.status === 'ERROR' ? 'FAILURE' : 'UNKNOWN'
        parts.push({ part: part++, type: 'TOOL_CALL', timestamp: ts, rawText: rawArgs, tool, status, pairing: 'NO_NATIVE_CALL_PAIR_ID', isAttempt: true })
      }
    }
    if (typeof entry.content === 'string' && entry.content.length > 0) {
      parts.push({ part: part++, type: 'AGENT_UPDATE', timestamp: ts, rawText: entry.content })
    }
    if (entry.status === 'ERROR' || typeof entry.error === 'string') {
      const errorKind = typeof entry.error_code === 'string' ? entry.error_code : 'PLANNER_ERROR'
      const rawErr = typeof entry.error === 'string' ? entry.error : typeof entry.content === 'string' ? entry.content : errorKind
      parts.push({ part: part++, type: 'ERROR', timestamp: ts, rawText: rawErr, status: 'FAILURE', errorKind })
    }
    return { timestamp: ts, parts, omitted: false }
  }
  if (entry.type === 'ERROR_MESSAGE' || entry.status === 'ERROR' || typeof entry.error === 'string') {
    const errorKind = typeof entry.error_code === 'string' ? entry.error_code : entry.type === 'ERROR_MESSAGE' ? 'ERROR_MESSAGE' : `${entry.type}_ERROR`
    const refusal = /(?:DENIED|REJECTED|REFUSED)/i.test(errorKind)
    const rawErr = typeof entry.error === 'string' ? entry.error : typeof entry.content === 'string' ? entry.content : errorKind
    parts.push({ part: 0, type: 'ERROR', timestamp: ts, rawText: rawErr, status: refusal ? 'REFUSAL' : 'FAILURE', errorKind })
    return { timestamp: ts, parts, omitted: false }
  }
  if ((entry.type === 'GENERIC' || entry.type === 'GENERATE_IMAGE') && entry.source === 'MODEL' && typeof entry.content === 'string' && entry.content.length > 0) {
    parts.push({ part: 0, type: 'TOOL_RESULT', timestamp: ts, rawText: entry.content, status: 'UNKNOWN', pairing: 'NO_NATIVE_CALL_PAIR_ID' })
    return { timestamp: ts, parts, omitted: false }
  }
  return { timestamp: ts, parts, omitted: true }
}

export function extractAntigravityRecordPart(record: unknown, partIndex: number): string | undefined {
  return decodeAntigravityRecordParts(record).parts.find(p => p.part === partIndex)?.rawText
}

export function openAntigravitySourceHandle(options: {
  storePath: string
  repositoryId: string
  nativeHash: string
  sourceSessionId: string
  locatorDigest?: string
  worktreeRoot?: string
  registryVerifiedOrigin?: boolean
  assertCurrent: () => void
}): NativeIndexedSourceHandle {
  const { storePath, repositoryId, nativeHash, sourceSessionId, locatorDigest, worktreeRoot, registryVerifiedOrigin, assertCurrent } = options
  if (!antigravityAppSessionId.test(sourceSessionId) ||
    nativeDigest(JSON.stringify([repositoryId, 'antigravity', sourceSessionId])) !== nativeHash) throw new Error('IDENTITY_MISMATCH')
  const { configPath, configText, profile, allowLexicalIndex } = readAntigravityAppGrant(storePath, repositoryId, nativeHash)
  const directory = dirname(storePath)

  const verifyWorktreeOrigin = () => {
    if (locatorDigest === undefined) {
      if (!worktreeRoot) throw new Error('ORIGIN_UNVERIFIED')
      const resolvedRoot = realpathSync.native(worktreeRoot)
      const dbMatch = summaryRowMatchesWorktree(profile, sourceSessionId, resolvedRoot, assertCurrent)
      if (dbMatch === 'MISMATCHED') throw new Error('ORIGIN_UNVERIFIED')
      if (dbMatch === 'UNAVAILABLE' && !registryVerifiedOrigin) throw new Error('ORIGIN_UNVERIFIED')
    }
  }
  verifyWorktreeOrigin()

  assertCurrent()
  const resolvedCandidate = resolveAntigravityTranscriptCandidate(profile, sourceSessionId, locatorDigest)
  const { path, stat } = resolvedCandidate
  const effectiveLocator = locatorDigest ?? canonicalLocatorHash(path)
  if (stat.size === 0n) throw new Error('FORMAT_UNSUPPORTED')
  const identity = fingerprint(stat)
  const fd = openNoFollowReadOnly(path)
  try {
    if (fingerprint(fstatSync(fd, { bigint: true })) !== identity) throw new Error('SOURCE_STALE')
    const resolvedRoot = worktreeRoot ? realpathSync.native(worktreeRoot) : ''
    return {
      fd,
      path,
      profile,
      identity,
      sizeBytes: Number(stat.size),
      locatorHash: digest(JSON.stringify([path, effectiveLocator, resolvedRoot, configText])),
      liveFingerprint: nativeDigest(JSON.stringify([effectiveLocator, identity])),
      allowLexicalIndex,
      sourceVariant: resolvedCandidate.variant,
      coexistingVariants: resolvedCandidate.coexistingVariants,
      assertPath: () => {
        assertProfilePath(path, profile)
        assertProfilePath(configPath, directory)
      },
      configUnchanged: () => boundedFile(configPath, 65536) === configText,
      verifyAfterClose: verifyWorktreeOrigin
    }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

export function discoverAntigravityAppSources(options: {
  storePath: string
  repositoryId: string
  worktreeRoot: string
  after?: string
  before?: string
  limit?: number
  offset?: number
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
         LIMIT ? OFFSET ?`
      ).all(maxDiscoveryRows + 1, options.offset ?? 0) as Array<{ conversation_id?: unknown; workspace_uris?: unknown; last_modified_time?: unknown }>
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

export function stepAntigravityAppSourceIndex(options: {
  refs: NativeSessionReferences
  storePath: string
  repositoryId: string
  worktreeId: string
  generation: string
  nativeHash: string
  sourceSessionId: string
  locatorDigest?: string
  worktreeRoot?: string
  registryVerifiedOrigin?: boolean
  mode: 'READ_ONLY' | 'ON_DEMAND' | 'STEP'
  stepBudget?: NativeStepBudget
  onReady?: (ready: { summary: import('./native-session-references').NativeSourceRecordSummary; nativeKey: string; liveFingerprint: string; fd: number }) => void
  assertCurrent: () => void
}): NativeReferenceStepResult {
  const {
    refs, storePath, repositoryId, worktreeId, generation, nativeHash, sourceSessionId,
    locatorDigest, worktreeRoot, registryVerifiedOrigin, mode, stepBudget, onReady, assertCurrent
  } = options
  const nativeKey = nativeReferenceKey('antigravity', repositoryId, worktreeId, generation, sourceSessionId)
  return runNativeReferenceStep({
    refs,
    nativeKey,
    provider: 'antigravity',
    repositoryId,
    worktreeId,
    generation,
    sourceSessionId,
    normalizer: NATIVE_ANTIGRAVITY_NORMALIZER,
    sourceCoverage: 'TYPED_SOURCE_EVENTS_UNPAIRED_TOOLS',
    attemptCoverage: 'NO_NATIVE_CALL_PAIR_ID',
    formatError: 'FORMAT_UNSUPPORTED',
    staleError: 'SOURCE_STALE',
    mode,
    stepBudget,
    onReady,
    assertCurrent,
    openHandle: () => openAntigravitySourceHandle({
      storePath, repositoryId, nativeHash, sourceSessionId, locatorDigest, worktreeRoot, registryVerifiedOrigin, assertCurrent
    }),
    makeEventId: (ordinal, part, payloadDigest, snapshotIdentity) =>
      nativeDigest(JSON.stringify([NATIVE_ANTIGRAVITY_NORMALIZER, sourceSessionId, snapshotIdentity, ordinal, part, payloadDigest])),
    onUnavailableRecord: (lineStart, lineEnd, limitation, acc: StepAccumulator) => {
      acc.state.ordinal++
      emitUnavailableRecord(acc, { ordinal: acc.state.ordinal, limitation, lineStart, lineEnd })
    },
    processRecord: (rawRecord, lineStart, lineEnd, acc: StepAccumulator) => {
      acc.state.ordinal++
      const ordinal = acc.state.ordinal
      let decoded: { timestamp?: string; parts: DecodedAntigravityPart[]; omitted: boolean }
      try {
        decoded = decodeAntigravityRecordParts(rawRecord)
      } catch (error) {
        if (ordinal === 1 || !rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) throw error
        emitOpaqueRecord(acc, {
          ordinal,
          rawRecord,
          limitation: 'UNRECOGNIZED_FORMAT',
          lineStart,
          lineEnd
        })
        return
      }
      if (decoded.omitted || decoded.parts.length === 0) {
        emitOpaqueRecord(acc, {
          ordinal,
          rawRecord,
          timestamp: decoded.timestamp,
          limitation: decoded.omitted ? 'UNRECOGNIZED_FORMAT' : 'EMPTY_RECORD',
          lineStart,
          lineEnd
        })
        return
      }
      acc.state.typedRecords++
      for (const p of decoded.parts) {
        emitIndexedEvent(acc, {
          ordinal,
          part: p.part,
          type: p.type,
          rawText: p.rawText,
          timestamp: p.timestamp,
          tool: p.tool,
          status: p.status,
          pairing: p.pairing,
          errorKind: p.errorKind,
          lineStart,
          lineEnd
        })
        if (p.isAttempt) {
          acc.state.attemptCounts.total++
          applyAttemptOutcome(acc.state.attemptCounts, p.status ?? 'UNKNOWN')
        }
      }
    }
  })
}
