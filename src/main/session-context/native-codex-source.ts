import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync, type BigIntStats } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { assertProfilePath, assertUserOwned } from '../local-mcp-clients/safe-config-file'
import { boundedFile, nativeDigest, sameNativePath } from './native-hooks'
import { digest } from './privacy'

const sha = z.string().regex(/^[a-f0-9]{64}$/)
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const grant = z.object({ profile: z.string().max(4096).refine(isAbsolute), creatorAccountHash: sha }).strict()
const maxBytes = 8 * 1024 * 1024
const maxLine = 512 * 1024
const maxHeaderLine = 16 * 1024
const maxEvents = 256
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
  return { configPath, configText, profile, creatorAccountHash }
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
  if (files.length !== 1) throw new Error(files.length ? 'SOURCE_IDENTITY_CONFLICT' : 'SOURCE_UNAVAILABLE')
  return files[0]
}

function firstLine(path: string): string | undefined {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isFile() || stat.nlink !== 1n || stat.size === 0n) return
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const buf = Buffer.alloc(maxHeaderLine)
    const read = readSync(fd, buf, 0, buf.length, 0)
    const nl = buf.subarray(0, read).indexOf(10)
    if (nl <= 0) return
    return decoder.decode(buf.subarray(0, nl))
  } finally { closeSync(fd) }
}

export function discoverCodexSources(options: {
  storePath: string; repositoryId: string; worktreeRoot: string; assertCurrent: () => void
}): DiscoveredCodexSource[] {
  let profile: string, creatorAccountHash: string
  try { ({ profile, creatorAccountHash } = readCodexGrant(options.storePath, options.repositoryId)) }
  catch { return [] }
  const sessionsDir = join(profile, 'sessions')
  const root = realpathSync.native(options.worktreeRoot)
  const candidates: { path: string; sessionId: string; mtimeMs: number }[] = []
  const collectDays = (dir: string, depth: number) => {
    try {
      const entries = readdirSync(dir, { withFileTypes: true }).map(e => e.name).sort().reverse()
      for (const name of entries.slice(0, depth === 0 ? 3 : depth === 1 ? 4 : 16)) {
        options.assertCurrent()
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
  const found: DiscoveredCodexSource[] = []
  for (const item of candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 48)) {
    options.assertCurrent()
    try {
      if (!sameNativePath(item.path, realpathSync.native(item.path))) continue
      const line = firstLine(item.path)
      if (!line) continue
      const record = JSON.parse(line)
      const meta = record?.payload
      if (record?.type !== 'session_meta' || meta?.id !== item.sessionId || typeof meta.session_id !== 'string' || !uuid.test(meta.session_id) ||
        meta.account_scoped !== true || typeof meta.creator_account_id !== 'string' || typeof meta.creator_user_id !== 'string' ||
        digest(JSON.stringify([meta.creator_user_id, meta.creator_account_id])) !== creatorAccountHash ||
        meta.cli_version !== '0.169.0-alpha.11.1' || !checkCodexWorktreeRoots(meta, root, profile)) continue
      const ts = typeof meta.timestamp === 'string' && Number.isFinite(Date.parse(meta.timestamp)) ? meta.timestamp : new Date(item.mtimeMs).toISOString()
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
      if (found.length >= 20) break
    } catch {}
  }
  return found
}

export function codexSourceSnapshot(options: {
  storePath: string; repositoryId: string; worktreeRoot: string; nativeHash: string; sourceSessionId: string; assertCurrent: () => void
}) {
  const { storePath, repositoryId, worktreeRoot, nativeHash, sourceSessionId, assertCurrent } = options
  if (!uuid.test(sourceSessionId) || nativeDigest(JSON.stringify([repositoryId, 'codex', sourceSessionId])) !== nativeHash) throw new Error('SOURCE_IDENTITY_CONFLICT')
  const { configPath, configText, profile, creatorAccountHash } = readCodexGrant(storePath, repositoryId)
  const path = exactRollout(profile, sourceSessionId)
  assertProfilePath(path, profile)
  if (!sameNativePath(path, realpathSync.native(path))) throw new Error('SOURCE_PATH_ESCAPE')
  assertCurrent()

  const fingerprint = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':')
  const before = lstatSync(path, { bigint: true })
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes)) throw new Error('SOURCE_LIMIT_REACHED')
  const identity = fingerprint(before)
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (fingerprint(fstatSync(fd, { bigint: true })) !== identity) throw new Error('SOURCE_REVISION_CHANGED')
    const buffer = Buffer.alloc(65536)
    let pending = Buffer.alloc(0), position = 0, ordinal = 0, omitted = 0
    const root = realpathSync.native(worktreeRoot)
    const events: { eventId: string; ordinal: number; type: 'INPUT' | 'AGENT_UPDATE'; bytes: number; payloadDigest: string; content: string }[] = []
    const checkRoot = (value: unknown) => typeof value === 'string' && isAbsolute(value) && sameNativePath(realpathSync.native(value), root) && sameNativePath(resolve(value), root)
    for (;;) {
      assertCurrent()
      const size = readSync(fd, buffer, 0, buffer.length, position)
      if (!size) break
      position += size
      if (position > maxBytes) throw new Error('SOURCE_LIMIT_REACHED')
      let data = Buffer.concat([pending, buffer.subarray(0, size)]), newline: number
      while ((newline = data.indexOf(10)) !== -1) {
        if (newline > maxLine) throw new Error('SOURCE_LIMIT_REACHED')
        let record
        try { record = JSON.parse(decoder.decode(data.subarray(0, newline))) } catch { throw new Error('SOURCE_FORMAT_UNSUPPORTED') }
        data = data.subarray(newline + 1)
        ordinal++
        const item = record?.payload
        if (ordinal === 1) {
          if (record?.type !== 'session_meta' || item?.id !== sourceSessionId || typeof item.session_id !== 'string' || !uuid.test(item.session_id) ||
            item.account_scoped !== true || typeof item.creator_account_id !== 'string' || typeof item.creator_user_id !== 'string' ||
            digest(JSON.stringify([item.creator_user_id, item.creator_account_id])) !== creatorAccountHash) throw new Error('SOURCE_IDENTITY_CONFLICT')
          if (item.cli_version !== '0.169.0-alpha.11.1') throw new Error('SOURCE_FORMAT_UNSUPPORTED')
          if (!checkCodexWorktreeRoots(item, root, profile)) throw new Error('ORIGIN_UNVERIFIED')
          continue
        }
        if (record?.type === 'turn_context' && !checkRoot(item?.cwd)) throw new Error('ORIGIN_UNVERIFIED')
        if (record?.type !== 'response_item' || item?.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) continue
        for (const [part, entry] of item.content.entries()) {
          if (entry?.type !== 'output_text' || typeof entry.text !== 'string') continue
          if (events.length >= maxEvents) { omitted++; continue }
          const payloadDigest = digest(entry.text)
          events.push({ eventId: digest(JSON.stringify([identity, ordinal, part, payloadDigest])), ordinal, type: 'AGENT_UPDATE',
            bytes: Buffer.byteLength(entry.text), payloadDigest, content: entry.text })
        }
      }
      if (data.length > maxLine) throw new Error('SOURCE_LIMIT_REACHED')
      pending = data
    }
    assertProfilePath(path, profile)
    assertCurrent()
    if (fingerprint(fstatSync(fd, { bigint: true })) !== identity || fingerprint(lstatSync(path, { bigint: true })) !== identity ||
      boundedFile(configPath, 65536) !== configText) throw new Error('SOURCE_REVISION_CHANGED')
    if (pending.length || !ordinal) throw new Error('SOURCE_FORMAT_UNSUPPORTED')
    if (!events.length) throw new Error('SOURCE_CONTENT_UNAVAILABLE')
    return { fingerprint: digest(identity), events, omitted }
  } finally { closeSync(fd) }
}
