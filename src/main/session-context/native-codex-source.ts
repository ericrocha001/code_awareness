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
  type NativeIndexedSourceHandle,
  type NativeReferenceStepResult,
  type NativeStepBudget,
  type StepAccumulator
} from './native-source-index'
import { NATIVE_CODEX_NORMALIZER, nativeReferenceKey, type NativeSessionReferences } from './native-session-references'
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
  contentAvailability: 'AVAILABLE'
  captureCoverage: 'SOURCE_AVAILABLE_NO_HOOK_CAPTURE'
  identityEvidence: 'HASH_AND_PROVIDER_HEADER_VERIFIED'
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

function exactRollout(profile: string, id: string) {
  const sessions = join(profile, 'sessions')
  const stamp = Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)
  const files: string[] = []
  for (const delta of [-1, 0, 1]) {
    const day = new Date(stamp + delta * 86400000).toISOString().slice(0, 10)
    const directory = join(sessions, ...day.split('-'))
    assertProfilePath(directory, profile)
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('rollout-') && entry.name.endsWith('-' + id + '.jsonl')) files.push(join(directory, entry.name))
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  if (files.length !== 1) throw new Error(files.length ? 'SOURCE_IDENTITY_CONFLICT' : 'SOURCE_NOT_FOUND')
  return files[0]
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
  assertCurrent: () => void
): { usedIndex: true; truncated: boolean; candidates: { path: string; sessionId: string; mtimeMs: number }[] } | undefined {
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
         LIMIT ?`
      ).all(comparableRoot, maxCandidateFiles + 1) as Array<{ id?: unknown; rollout_path?: unknown; cwd?: unknown; updated_at?: unknown }>
    } catch {
      return undefined
    }
    const truncated = rows.length > maxCandidateFiles
    const candidates: { path: string; sessionId: string; mtimeMs: number }[] = []
    for (const row of rows.slice(0, maxCandidateFiles)) {
      assertCurrent()
      if (typeof row.id !== 'string' || !uuid.test(row.id)) continue
      if (!canonicalIndexPathMatchesRoot(row.cwd, root)) continue
      if (typeof row.rollout_path !== 'string') continue
      const rolloutPath = stripVerbatimPrefix(row.rollout_path)
      try {
        assertProfilePath(rolloutPath, sessionsRoot)
        const s = statSync(rolloutPath)
        candidates.push({ path: rolloutPath, sessionId: row.id, mtimeMs: s.mtimeMs })
      } catch {}
    }
    return { usedIndex: true, truncated, candidates }
  } finally {
    db.close()
  }
}

export function discoverCodexSources(options: {
  storePath: string
  repositoryId: string
  worktreeRoot: string
  after?: string
  before?: string
  limit?: number
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
  const sessionsDir = join(profile, 'sessions')
  const root = realpathSync.native(options.worktreeRoot)
  const limit = Math.min(Math.max(options.limit ?? maxDiscoveryResults, 1), maxDiscoveryResults)
  const afterMs = options.after ? Date.parse(options.after) : undefined
  const beforeMs = options.before ? Date.parse(options.before) : undefined

  let dirsVisited = 0
  let entriesChecked = 0
  let truncated = false
  let usedIndex = false
  let candidates: { path: string; sessionId: string; mtimeMs: number }[] = []

  const indexed = indexedCodexCandidates(profile, root, options.assertCurrent)
  if (indexed) {
    usedIndex = true
    truncated = indexed.truncated
    candidates = indexed.candidates
  } else {
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
          options.assertCurrent()
          if (entriesChecked >= maxDiscoveryEntries) {
            truncated = true
            break
          }
          entriesChecked++
          const full = join(dir, name)
          assertProfilePath(full, profile)
          if (depth < 3) collectDays(full, depth + 1)
          else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) {
            const match = /([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/.exec(name)
            if (match) candidates.push({ path: full, sessionId: match[1], mtimeMs: statSync(full).mtimeMs })
          }
        }
      } catch {}
    }
    collectDays(sessionsDir, 0)
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
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
      const { line, bytesRead } = firstLine(item.path)
      headerBytesRead += bytesRead
      if (!line) continue
      const record = JSON.parse(line)
      const meta = record?.payload
      if (record?.type !== 'session_meta' || meta?.id !== item.sessionId || typeof meta.session_id !== 'string' || !uuid.test(meta.session_id) ||
        meta.account_scoped !== true || typeof meta.creator_account_id !== 'string' || typeof meta.creator_user_id !== 'string' ||
        digest(JSON.stringify([meta.creator_user_id, meta.creator_account_id])) !== creatorAccountHash ||
        meta.cli_version !== '0.169.0-alpha.11.1' || !checkCodexWorktreeRoots(meta, root, profile)) continue
      const ts = typeof meta.timestamp === 'string' && Number.isFinite(Date.parse(meta.timestamp)) ? meta.timestamp : new Date(item.mtimeMs).toISOString()
      const tsMs = Date.parse(ts)
      if (afterMs !== undefined && tsMs < afterMs) continue
      if (beforeMs !== undefined && tsMs > beforeMs) continue
      found.push({
        provider: 'codex-native',
        providerSessionId: nativeDigest(JSON.stringify([options.repositoryId, 'codex', item.sessionId])),
        sourceSessionId: item.sessionId,
        agent: 'codex',
        lastObserved: ts,
        contentAvailability: 'AVAILABLE',
        captureCoverage: 'SOURCE_AVAILABLE_NO_HOOK_CAPTURE',
        identityEvidence: 'HASH_AND_PROVIDER_HEADER_VERIFIED'
      })
    } catch {}
  }

  return {
    sessions: found,
    truncated,
    ...(truncated ? { coverageReason: 'SOURCE_DISCOVERY_LIMIT_REACHED' as const } : {}),
    stats: { usedIndex, dirsVisited, filesOpened, headerBytesRead }
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
  const path = exactRollout(profile, sourceSessionId)
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
      assertPath: () => assertProfilePath(path, profile),
      configUnchanged: () => boundedFile(configPath, 65536) === configText
    }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

export function stepCodexSourceIndex(options: {
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
}): NativeReferenceStepResult {
  const {
    refs, storePath, repositoryId, worktreeId, generation, worktreeRoot,
    nativeHash, sourceSessionId, mode, stepBudget, onReady, assertCurrent
  } = options
  const nativeKey = nativeReferenceKey('codex', repositoryId, worktreeId, generation, sourceSessionId)
  let root = ''
  let profile = ''
  let creatorAccountHash = ''
  return runNativeReferenceStep({
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
        if (
          record?.type !== 'session_meta' ||
          item?.id !== sourceSessionId ||
          typeof item.session_id !== 'string' ||
          !uuid.test(item.session_id) ||
          item.account_scoped !== true ||
          typeof item.creator_account_id !== 'string' ||
          typeof item.creator_user_id !== 'string' ||
          digest(JSON.stringify([item.creator_user_id, item.creator_account_id])) !== creatorAccountHash
        ) throw new Error('SOURCE_IDENTITY_CONFLICT')
        if (item.cli_version !== '0.169.0-alpha.11.1') throw new Error('SOURCE_FORMAT_UNSUPPORTED')
        if (!checkCodexWorktreeRoots(item, root, profile)) throw new Error('ORIGIN_UNVERIFIED')
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
        const tool = sanitize(String(item.name || item.type || 'shell')).slice(0, 80)
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
        emitIndexedEvent(acc, {
          ordinal, part: 0, type: classified.isError ? 'ERROR' : 'TOOL_RESULT', rawText: rawOutput,
          timestamp, tool: match?.tool, turnId: acc.state.currentTurnId,
          status: classified.status, pairing, errorKind: classified.errorKind, lineStart, lineEnd
        })
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
    }
  })
}
