import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, utimesSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { gitReceiptFingerprint } from '../git-operations/git-operation-receipts'
import { nativeArtifactFact, validNativeArtifactFact, type NativeArtifactFact } from './native-artifact-facts'

export const nativeHookEvents = ['SessionStart', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd'] as const
export type NativeHookEvent = typeof nativeHookEvents[number]
export const nativeHookLimits = { inputBytes: 65536, envelopeBytes: 4096, slots: 1024, retentionMs: 86400000, timeoutMs: 750 }
export const nativeDigest = (value: string): string => createHash('sha256').update(value).digest('hex')
export const nativeGapReasons = ['JSON_SYNTAX', 'JSON_STRUCTURE', 'EVENT_UNSUPPORTED', 'REQUIRED_ID_MISSING', 'INVALID_ID', 'CWD_MISSING', 'INVOCATION_ID_MISSING',
  'WORKTREE_MISMATCH', 'WORKTREE_STALE', 'INVALID_ENVELOPE', 'ENVELOPE_INTEGRITY', 'ENVELOPE_LIMIT', 'UNSAFE_SPOOL', 'IO_FAILURE', 'INPUT_LIMIT', 'SPOOL_FULL', 'READ_FAILURE', 'TIMEOUT', 'EVENT_EXPIRED', 'EVENT_TIME_INVALID', 'LEGACY_UNTYPED', 'DIAGNOSTIC_LIMIT', 'DIAGNOSTIC_INVALID'] as const
export type NativeGapReason = typeof nativeGapReasons[number]
export type NativeGapPhase = 'READ' | 'PARSE' | 'NORMALIZE' | 'WRITE' | 'INGEST'
export interface NativeGap {
  schema: 2; reasonCode: NativeGapReason; phase: NativeGapPhase; eventType: NativeHookEvent | 'UNKNOWN'; observedAt: string
}
export function nativeEventType(payload: unknown): NativeGap['eventType'] {
  return object(payload) && nativeHookEvents.includes(payload.hook_event_name as NativeHookEvent) ? payload.hook_event_name as NativeHookEvent : 'UNKNOWN'
}
export function nativeGapReason(error: unknown): NativeGapReason {
  const code = error instanceof Error ? error.message : ''
  return nativeGapReasons.includes(code as NativeGapReason) ? code as NativeGapReason : 'IO_FAILURE'
}
const hashPattern = /^[a-f0-9]{64}$/
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export interface NativeHookBinding {
  schema: 1
  enabled: boolean
  repositoryId: string
  worktreeId: string
  generation: string
  root: string
  commonDirectory: string
  directoryIdentity: string
  spool: string
  gitCommitTool?: string
}
export interface NativeHookEnvelope {
  schema: 1
  source: 'CODEX_NATIVE_HOOK'
  repositoryId: string
  worktreeId: string
  generation: string
  sessionId: string
  event: NativeHookEvent
  turnId?: string
  invocationId?: string
  subagentId?: string
  tool?: 'SHELL' | 'MCP' | 'OTHER'
  git?: { operationId: string; fingerprint: string; expectedHead: string | null; sha?: string; parent?: string | null; replayed?: boolean }
  artifact?: NativeArtifactFact
  observedAt: string
  eventId: string
  digest: string
}

export function boundedFile(path: string, maxBytes: number): string {
  if (lstatSync(path).isSymbolicLink()) throw new Error('UNSAFE_FILE')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('FILE_LIMIT')
    return readFileSync(fd, 'utf8')
  } finally { closeSync(fd) }
}

export function nativeGitIdentity(root: string): { root: string; commonDirectory: string; directoryIdentity: string } {
  const physical = realpathSync(root), pointer = join(physical, '.git')
  if (lstatSync(pointer).isSymbolicLink()) throw new Error('UNSAFE_GIT_DIRECTORY')
  let admin = pointer
  if (!lstatSync(pointer).isDirectory()) {
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(boundedFile(pointer, 4096))
    if (!match) throw new Error('INVALID_GIT_DIRECTORY')
    admin = resolve(physical, match[1])
  }
  admin = realpathSync(admin)
  let commonDirectory = admin
  try { commonDirectory = realpathSync(resolve(admin, boundedFile(join(admin, 'commondir'), 4096).trim())) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const identity = [physical, admin, commonDirectory].map(path => {
    const stat = lstatSync(path, { bigint: true })
    return [path, String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]
  })
  return { root: physical, commonDirectory, directoryIdentity: nativeDigest(JSON.stringify(identity)) }
}

export function readNativeBinding(path: string): NativeHookBinding {
  const value: unknown = JSON.parse(boundedFile(path, 8192))
  if (!object(value) || value.schema !== 1 || typeof value.enabled !== 'boolean' ||
    typeof value.repositoryId !== 'string' || !idPattern.test(value.repositoryId) ||
    !['worktreeId', 'generation', 'directoryIdentity'].every(k => typeof value[k] === 'string' && hashPattern.test(value[k] as string)) ||
    !['root', 'commonDirectory', 'spool'].every(k => typeof value[k] === 'string' && (value[k] as string).length <= 4096) ||
    (value.gitCommitTool !== undefined && (typeof value.gitCommitTool !== 'string' || !/^mcp__[a-zA-Z0-9_-]+__commit_git_changes$/.test(value.gitCommitTool)))) throw new Error('INVALID_BINDING')
  return value as unknown as NativeHookBinding
}

export function normalizeNativeHook(payload: unknown, binding: NativeHookBinding, now = new Date()): NativeHookEnvelope {
  if (!binding.enabled) throw new Error('DISABLED')
  if (!object(payload)) throw new Error('JSON_STRUCTURE')
  if (!nativeHookEvents.includes(payload.hook_event_name as NativeHookEvent)) throw new Error('EVENT_UNSUPPORTED')
  if (payload.session_id === undefined || payload.session_id === null || payload.session_id === '') throw new Error('REQUIRED_ID_MISSING')
  if (typeof payload.session_id !== 'string' || !idPattern.test(payload.session_id)) throw new Error('INVALID_ID')
  if (typeof payload.cwd !== 'string') throw new Error('CWD_MISSING')
  let identity: ReturnType<typeof nativeGitIdentity>
  try { identity = nativeGitIdentity(payload.cwd) } catch { throw new Error('WORKTREE_STALE') }
  if (identity.root !== binding.root || identity.commonDirectory !== binding.commonDirectory || identity.directoryIdentity !== binding.directoryIdentity) throw new Error('WORKTREE_MISMATCH')
  const sessionId = nativeDigest(JSON.stringify([binding.repositoryId, 'codex', payload.session_id]))
  const event = payload.hook_event_name as NativeHookEvent
  const optionalId = (key: string): string | undefined => {
    const value = payload[key]
    if (value === undefined || value === null) return
    if (typeof value !== 'string' || !idPattern.test(value)) throw new Error('INVALID_ID')
    return nativeDigest(JSON.stringify([sessionId, key, value]))
  }
  const turnId = optionalId('turn_id'), invocationId = optionalId('tool_use_id'), subagentId = optionalId('agent_id')
  const toolEvent = event === 'PreToolUse' || event === 'PostToolUse'
  if (toolEvent && !invocationId) throw new Error('INVOCATION_ID_MISSING')
  const tool: NativeHookEnvelope['tool'] = toolEvent ? payload.tool_name === 'Bash' ? 'SHELL' : typeof payload.tool_name === 'string' && payload.tool_name.startsWith('mcp__') ? 'MCP' : 'OTHER' : undefined
  let git: NativeHookEnvelope['git']
  if (toolEvent && binding.gitCommitTool && payload.tool_name === binding.gitCommitTool && object(payload.tool_input)) {
    const { operationId, ...args } = payload.tool_input
    if (typeof operationId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(operationId) &&
      Object.keys(args).length === 3 && typeof args.message === 'string' && args.message.length <= 10000 &&
      (args.expectedHead === null || typeof args.expectedHead === 'string' && /^[a-f0-9]{40}$/.test(args.expectedHead)) &&
      typeof args.expectedIndexRevision === 'string' && hashPattern.test(args.expectedIndexRevision)) {
      git = { operationId, fingerprint: gitReceiptFingerprint('commit_git_changes', args), expectedHead: args.expectedHead as string | null }
      if (event === 'PostToolUse' && object(payload.tool_response) && payload.tool_response.isError !== true && Array.isArray(payload.tool_response.content)) {
        const first = payload.tool_response.content[0]
        if (object(first) && first.type === 'text' && typeof first.text === 'string') {
          try {
            const result = JSON.parse(first.text)
            if (object(result) && result.operationId === operationId && typeof result.sha === 'string' && /^[a-f0-9]{40}$/.test(result.sha) &&
              result.parent === args.expectedHead && typeof result.replayed === 'boolean') Object.assign(git, { sha: result.sha, parent: result.parent, replayed: result.replayed })
          } catch {}
        }
      }
    }
  }
  const artifact = toolEvent ? nativeArtifactFact(payload, binding.repositoryId) : undefined
  const facts = { schema: 1 as const, source: 'CODEX_NATIVE_HOOK' as const, repositoryId: binding.repositoryId, worktreeId: binding.worktreeId,
    generation: binding.generation, sessionId, event, ...(turnId ? { turnId } : {}), ...(invocationId ? { invocationId } : {}), ...(subagentId ? { subagentId } : {}), ...(tool ? { tool } : {}), ...(git ? { git } : {}), ...(artifact ? { artifact } : {}) }
  const eventId = nativeDigest(JSON.stringify(facts)), observedAt = now.toISOString()
  return { ...facts, observedAt, eventId, digest: nativeDigest(JSON.stringify({ ...facts, observedAt, eventId })) }
}

export function parseNativeEnvelope(text: string): NativeHookEnvelope {
  if (Buffer.byteLength(text) > nativeHookLimits.envelopeBytes) throw new Error('ENVELOPE_LIMIT')
  const value: unknown = JSON.parse(text)
  if (!object(value)) throw new Error('INVALID_ENVELOPE')
  const keys = ['schema', 'source', 'repositoryId', 'worktreeId', 'generation', 'sessionId', 'event', 'turnId', 'invocationId', 'subagentId', 'tool', 'git', 'artifact', 'observedAt', 'eventId', 'digest']
  if (Object.keys(value).some(k => !keys.includes(k)) || value.schema !== 1 || value.source !== 'CODEX_NATIVE_HOOK' ||
    typeof value.repositoryId !== 'string' || !idPattern.test(value.repositoryId) || !nativeHookEvents.includes(value.event as NativeHookEvent) ||
    !['worktreeId','generation','sessionId','eventId','digest'].every(k => typeof value[k] === 'string' && hashPattern.test(value[k] as string)) ||
    ['turnId','invocationId','subagentId'].some(k => value[k] !== undefined && (typeof value[k] !== 'string' || !hashPattern.test(value[k] as string))) ||
    (value.tool !== undefined && !['SHELL','MCP','OTHER'].includes(String(value.tool))) ||
    typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))) throw new Error('INVALID_ENVELOPE')
  if (value.git !== undefined) {
    const git = value.git
    if (!object(git) || Object.keys(git).some(k => !['operationId','fingerprint','expectedHead','sha','parent','replayed'].includes(k)) ||
      typeof git.operationId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(git.operationId) ||
      typeof git.fingerprint !== 'string' || !hashPattern.test(git.fingerprint) ||
      !(git.expectedHead === null || typeof git.expectedHead === 'string' && /^[a-f0-9]{40}$/.test(git.expectedHead)) ||
      (git.sha !== undefined && (typeof git.sha !== 'string' || !/^[a-f0-9]{40}$/.test(git.sha))) ||
      (git.parent !== undefined && git.parent !== git.expectedHead) || (git.replayed !== undefined && typeof git.replayed !== 'boolean')) throw new Error('INVALID_ENVELOPE')
  }
  if (value.artifact !== undefined && (!['PreToolUse','PostToolUse'].includes(String(value.event)) || !value.invocationId || !validNativeArtifactFact(value.artifact))) throw new Error('INVALID_ENVELOPE')
  const { digest, ...body } = value
  const { eventId, observedAt, ...facts } = body
  if (digest !== nativeDigest(JSON.stringify(body)) || eventId !== nativeDigest(JSON.stringify(facts))) throw new Error('ENVELOPE_INTEGRITY')
  return value as unknown as NativeHookEnvelope
}

export function spoolNativeHook(envelope: NativeHookEnvelope, spool: string): 'WRITTEN' | 'DUPLICATE' | 'FULL' {
  const text = JSON.stringify(envelope)
  parseNativeEnvelope(text)
  const stat = lstatSync(spool)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(spool) !== resolve(spool)) throw new Error('UNSAFE_SPOOL')
  const slot = parseInt(envelope.eventId.slice(0, 8), 16) % nativeHookLimits.slots
  for (let offset = 0; offset < 8; offset++) {
    const destination = join(spool, `${(slot + offset) % nativeHookLimits.slots}.json`)
    try {
      const previous = parseNativeEnvelope(boundedFile(destination, nativeHookLimits.envelopeBytes))
      if (previous.eventId === envelope.eventId) return 'DUPLICATE'
      continue
    } catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code && code !== 'ENOENT') throw error; if (code !== 'ENOENT') continue }
    const pending = destination + '.pending'
    try { writeFileSync(pending, text, { flag: 'wx', mode: 0o600, flush: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; continue }
    try {
      linkSync(pending, destination)
      return 'WRITTEN'
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    finally { unlinkSync(pending) }
  }
  return 'FULL'
}

export function prepareNativeSpool(spool: string): void {
  mkdirSync(spool, { recursive: true, mode: 0o700 })
  if (lstatSync(spool).isSymbolicLink() || realpathSync(dirname(spool)) !== resolve(dirname(spool))) throw new Error('UNSAFE_SPOOL')
}

export function recordNativeGap(spool: string, reasonCode: NativeGapReason, phase: NativeGapPhase = 'READ', eventType: NativeGap['eventType'] = 'UNKNOWN'): void {
  try {
    if (!nativeGapReasons.includes(reasonCode) || !['READ', 'PARSE', 'NORMALIZE', 'WRITE', 'INGEST'].includes(phase) ||
      !(eventType === 'UNKNOWN' || nativeHookEvents.includes(eventType))) return
    if (lstatSync(spool).isSymbolicLink() || realpathSync(spool) !== resolve(spool)) return
    const text = JSON.stringify({ schema: 2, reasonCode, phase, eventType, observedAt: new Date().toISOString() } satisfies NativeGap)
    for (let slot = 0; slot < 32; slot++) {
      const path = join(spool, `gap-${slot}.json`), pending = path + '.pending'
      if (existsGap(path)) continue
      try { writeFileSync(pending, text, { flag: 'wx', mode: 0o600 }) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; return }
      try { linkSync(pending, path); return } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return }
      finally { unlinkSync(pending) }
    }
    const overflow = join(spool, 'gap-overflow.json')
    try { writeFileSync(overflow, JSON.stringify({ schema: 2, reasonCode: 'DIAGNOSTIC_LIMIT', phase, eventType: 'UNKNOWN', observedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST' && !lstatSync(overflow).isSymbolicLink()) utimesSync(overflow, new Date(), new Date()) }
  } catch {}
}
function existsGap(path: string): boolean {
  try { lstatSync(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
