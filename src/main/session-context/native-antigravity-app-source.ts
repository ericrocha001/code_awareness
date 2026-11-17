import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, type BigIntStats } from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { assertProfilePath, assertUserOwned } from '../local-mcp-clients/safe-config-file'
import { antigravityAppLocatorDigest, antigravityAppSessionId, antigravityAppTranscriptPath } from './antigravity-app-locator'
import { boundedFile, nativeDigest, sameNativePath } from './native-hooks'
import type { NativeSourceAttemptRef, NativeSourceEvent } from './native-source-events'
import { sanitize } from './privacy'

const maxBytes = 8 * 1024 * 1024
const maxRecordBytes = 512 * 1024
const maxRecords = 16_384
const maxEvents = 512
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

interface AntigravityAppGrant {
  configPath: string
  configText: string
  profile: string
  sessionHash?: string
  sessionHashes?: string[]
}

function readAntigravityAppGrant(storePath: string, repositoryId: string, nativeHash?: string): AntigravityAppGrant {
  const directory = dirname(storePath), configPath = join(directory, 'session-context.provider.json')
  try {
    assertProfilePath(configPath, directory)
    assertUserOwned(configPath)
    const configText = boundedFile(configPath, 65536)
    const config = JSON.parse(configText)
    const grant = config?.nativeSources?.antigravityApp
    const profile = grant?.profile
    if (config?.repositoryId !== repositoryId || typeof profile !== 'string' || !isAbsolute(profile)) throw new Error()
    if (nativeHash !== undefined && grant.sessionHash !== undefined && grant.sessionHash !== nativeHash) throw new Error()
    const sessionHashes = Array.isArray(grant.sessionHashes) && grant.sessionHashes.every((v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))
      ? grant.sessionHashes as string[] : undefined
    if (nativeHash !== undefined && sessionHashes && !sessionHashes.includes(nativeHash)) throw new Error()
    assertProfilePath(profile, profile)
    assertUserOwned(profile)
    if (!lstatSync(profile).isDirectory() || !sameNativePath(realpathSync.native(profile), profile)) throw new Error()
    return { configPath, configText, profile, sessionHash: grant.sessionHash, sessionHashes }
  } catch { throw new Error('PROFILE_UNAVAILABLE') }
}

function canonicalLocatorHash(path: string): string {
  const canonical = process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path)
  return createHash('sha256').update(canonical).digest('hex')
}

function entryMatchesWorktree(entry: Record<string, unknown>, normalizedRoot: string): boolean {
  const containsRoot = (value: string) => {
    const candidate = process.platform === 'win32' ? value.toLowerCase().replaceAll('\\', '/') : value
    return candidate.includes(normalizedRoot)
  }
  if (typeof entry.content === 'string' && entry.content.includes('Active Workspaces:') && containsRoot(entry.content)) return true
  if (Array.isArray(entry.tool_calls)) {
    for (const call of entry.tool_calls as { args?: Record<string, unknown> }[]) {
      if (!call?.args || typeof call.args !== 'object') continue
      for (const field of ['Path', 'TargetFile', 'SearchDirectory', 'DirectoryPath', 'AbsolutePath', 'Cwd', 'CommandLine']) {
        const val = call.args[field]
        if (typeof val === 'string' && containsRoot(val)) return true
      }
    }
  }
  return false
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
  storePath: string; repositoryId: string; worktreeRoot: string; assertCurrent: () => void
}): DiscoveredAntigravityAppSource[] {
  let grant: AntigravityAppGrant
  try { grant = readAntigravityAppGrant(options.storePath, options.repositoryId) }
  catch { return [] }
  const brainDir = join(grant.profile, 'brain')
  let dirs: { id: string; path: string; mtimeMs: number }[] = []
  try {
    for (const entry of readdirSync(brainDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !antigravityAppSessionId.test(entry.name)) continue
      const transcript = antigravityAppTranscriptPath(grant.profile, entry.name)
      try {
        assertProfilePath(transcript, grant.profile)
        const s = lstatSync(transcript, { bigint: true })
        if (s.isFile() && s.nlink === 1n && s.size <= BigInt(maxBytes)) dirs.push({ id: entry.name, path: transcript, mtimeMs: Number(s.mtimeMs) })
      } catch {}
    }
  } catch { return [] }
  const normalizedRoot = (() => {
    const p = realpathSync.native(options.worktreeRoot)
    return process.platform === 'win32' ? p.toLowerCase().replaceAll('\\', '/') : p
  })()
  const found: DiscoveredAntigravityAppSource[] = []
  for (const item of dirs.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 24)) {
    options.assertCurrent()
    const nativeHash = nativeDigest(JSON.stringify([options.repositoryId, 'antigravity', item.id]))
    if (grant.sessionHash && grant.sessionHash !== nativeHash) continue
    if (grant.sessionHashes && !grant.sessionHashes.includes(nativeHash)) continue
    try {
      const { text } = readTranscriptChecked(item.path, grant.profile, options.assertCurrent)
      if (!text.trim() || !text.endsWith('\n')) continue
      let matchedWorkspace = false, lastObserved: string | undefined, valid = true
      for (let offset = 0, n = 0; offset < text.length && n < maxRecords; n++) {
        const next = text.indexOf('\n', offset)
        const line = text.slice(offset, next)
        offset = next + 1
        if (Buffer.byteLength(line) > maxRecordBytes) { valid = false; break }
        const entry = JSON.parse(line)
        if (!Number.isSafeInteger(entry?.step_index) || entry.step_index < 0 || typeof entry.type !== 'string' ||
          typeof entry.source !== 'string' || typeof entry.created_at !== 'string' || !Number.isFinite(Date.parse(entry.created_at))) { valid = false; break }
        lastObserved = entry.created_at
        if (!matchedWorkspace && entryMatchesWorktree(entry, normalizedRoot)) matchedWorkspace = true
      }
      if (!valid || !matchedWorkspace) continue
      found.push({
        provider: 'antigravity-native',
        providerSessionId: nativeHash,
        sourceSessionId: item.id,
        agent: 'antigravity',
        lastObserved,
        contentAvailability: 'AVAILABLE',
        captureCoverage: 'SOURCE_AVAILABLE_NO_HOOK_CAPTURE',
        identityEvidence: 'HASH_AND_APP_LOCATOR_VERIFIED'
      })
      if (found.length >= 20) break
    } catch {}
  }
  return found
}

export function antigravityAppSourceSnapshot(options: {
  storePath: string; repositoryId: string; nativeHash: string; sourceSessionId: string; locatorDigest?: string; worktreeRoot?: string; assertCurrent: () => void
}) {
  const { storePath, repositoryId, nativeHash, sourceSessionId, locatorDigest, worktreeRoot, assertCurrent } = options
  if (!antigravityAppSessionId.test(sourceSessionId) ||
    nativeDigest(JSON.stringify([repositoryId, 'antigravity', sourceSessionId])) !== nativeHash) throw new Error('IDENTITY_MISMATCH')
  const { configPath, configText, profile, sessionHash, sessionHashes } = readAntigravityAppGrant(storePath, repositoryId, nativeHash)
  const directory = dirname(storePath)

  const path = antigravityAppTranscriptPath(profile, sourceSessionId)
  if (locatorDigest !== undefined && antigravityAppLocatorDigest(sourceSessionId, path) !== locatorDigest) throw new Error('IDENTITY_MISMATCH')
  const effectiveLocator = locatorDigest ?? canonicalLocatorHash(path)
  const { identity, text } = readTranscriptChecked(path, profile, assertCurrent)

  if (!text.trim() || !text.endsWith('\n')) throw new Error('FORMAT_UNSUPPORTED')
  const events: NativeSourceEvent[] = []
  const attempts: NativeSourceAttemptRef[] = []
  let omitted = 0
  let ordinal = 0
  let matchedWorktree = false
  const pushEvent = (part: number, type: NativeSourceEvent['type'], timestamp: string, rawText: string, extra: Partial<NativeSourceEvent> = {}) => {
    if (events.length >= maxEvents) { omitted++; return undefined }
    const content = sanitize(rawText), payloadDigest = nativeDigest(content)
    const event: NativeSourceEvent = {
      eventId: nativeDigest(JSON.stringify([identity, ordinal, part, payloadDigest])),
      ordinal,
      type,
      timestamp,
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
  const normalizedRoot = worktreeRoot ? (() => {
    const p = realpathSync.native(worktreeRoot)
    return process.platform === 'win32' ? p.toLowerCase().replaceAll('\\', '/') : p
  })() : undefined
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
    if (normalizedRoot && !matchedWorktree && entryMatchesWorktree(entry, normalizedRoot)) matchedWorktree = true
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
  if (!locatorDigest && sessionHash !== nativeHash && !(sessionHashes?.includes(nativeHash)) && !matchedWorktree) {
    throw new Error('ORIGIN_UNVERIFIED')
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
