import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { assertProfilePath, assertUserOwned } from '../local-mcp-clients/safe-config-file'
import { antigravityAppLocatorDigest, antigravityAppSessionId, antigravityAppTranscriptPath } from './antigravity-app-locator'
import { boundedFile, nativeDigest, sameNativePath } from './native-hooks'
import { sanitize } from './privacy'

const maxBytes = 8 * 1024 * 1024
const maxRecordBytes = 512 * 1024
const maxRecords = 16_384
const maxEvents = 256
const fingerprint = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':')

export function antigravityAppSourceSnapshot(options: {
  storePath: string; repositoryId: string; nativeHash: string; sourceSessionId: string; locatorDigest: string; assertCurrent: () => void
}) {
  const { storePath, repositoryId, nativeHash, sourceSessionId, locatorDigest, assertCurrent } = options
  if (!antigravityAppSessionId.test(sourceSessionId) ||
    nativeDigest(JSON.stringify([repositoryId, 'antigravity', sourceSessionId])) !== nativeHash) throw new Error('IDENTITY_MISMATCH')
  const directory = dirname(storePath), configPath = join(directory, 'session-context.provider.json')
  let configText: string, profile: string
  try {
    assertProfilePath(configPath, directory)
    assertUserOwned(configPath)
    configText = boundedFile(configPath, 65536)
    const config = JSON.parse(configText)
    profile = config?.nativeSources?.antigravityApp?.profile
    if (config?.repositoryId !== repositoryId || typeof profile !== 'string' || !isAbsolute(profile)) throw new Error()
    assertProfilePath(profile, profile)
    assertUserOwned(profile)
    if (!lstatSync(profile).isDirectory() || !sameNativePath(realpathSync.native(profile), profile)) throw new Error()
  } catch { throw new Error('PROFILE_UNAVAILABLE') }

  const path = antigravityAppTranscriptPath(profile, sourceSessionId)
  if (antigravityAppLocatorDigest(sourceSessionId, path) !== locatorDigest) throw new Error('IDENTITY_MISMATCH')
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
  let text: string
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
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data) }
    catch { throw new Error('FORMAT_UNSUPPORTED') }
  } finally { closeSync(fd) }

  if (!text.trim() || !text.endsWith('\n')) throw new Error('FORMAT_UNSUPPORTED')
  const events: { eventId: string; ordinal: number; type: 'AGENT_UPDATE'; bytes: number; payloadDigest: string; content: string; sanitized: boolean }[] = []
  let omitted = 0
  let ordinal = 0
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
    if (entry.type !== 'PLANNER_RESPONSE' || entry.source !== 'MODEL' || events.length >= maxEvents) { omitted++; continue }
    if (typeof entry.content !== 'string') throw new Error('FORMAT_UNSUPPORTED')
    const content = sanitize(entry.content), payloadDigest = nativeDigest(content)
    events.push({ eventId: nativeDigest(JSON.stringify([identity, ordinal, payloadDigest])), ordinal, type: 'AGENT_UPDATE',
      bytes: Buffer.byteLength(content), payloadDigest, content, sanitized: entry.content !== content })
  }
  assertCurrent()
  try {
    assertProfilePath(path, profile)
    assertProfilePath(configPath, directory)
    if (fingerprint(lstatSync(path, { bigint: true })) !== identity || boundedFile(configPath, 65536) !== configText) throw new Error()
  } catch { throw new Error('SOURCE_STALE') }
  if (!events.length) throw new Error('SOURCE_CONTENT_UNAVAILABLE')
  return { fingerprint: nativeDigest(JSON.stringify([locatorDigest, identity])), events, omitted }
}
