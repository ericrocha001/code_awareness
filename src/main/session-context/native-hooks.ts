import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, utimesSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { gitReceiptFingerprint } from '../git-operations/git-operation-receipts'
import { nativeArtifactFact, validNativeArtifactFact, type NativeArtifactFact } from './native-artifact-facts'

export const nativeHookProviders = ['codex', 'antigravity'] as const
export type NativeHookProvider = typeof nativeHookProviders[number]
export const codexHookEvents = ['SessionStart', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd'] as const
export const antigravityHookEvents = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop'] as const
export const nativeHookEvents = ['SessionStart', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'PreInvocation', 'PostInvocation', 'Stop', 'SessionEnd'] as const
export type NativeHookEvent = typeof nativeHookEvents[number]
export const nativeHookLimits = { inputBytes: 65536, envelopeBytes: 4096, slots: 1024, retentionMs: 86400000, timeoutMs: 750 }
export const nativeDigest = (value: string): string => createHash('sha256').update(value).digest('hex')
export const nativeCaptureRuntimeId = nativeDigest(randomUUID())
export const nativeCaptureRuntimeStartedAt = Date.now()
export const nativeGapReasons = ['JSON_SYNTAX', 'JSON_STRUCTURE', 'EVENT_UNSUPPORTED', 'REQUIRED_ID_MISSING', 'INVALID_ID', 'CWD_MISSING', 'INVOCATION_ID_MISSING',
  'WORKTREE_MISMATCH', 'WORKTREE_SCOPE_AMBIGUOUS', 'WORKTREE_STALE', 'INVALID_ENVELOPE', 'ENVELOPE_INTEGRITY', 'ENVELOPE_LIMIT', 'UNSAFE_SPOOL', 'IO_FAILURE', 'INPUT_LIMIT', 'SPOOL_FULL', 'READ_FAILURE', 'TIMEOUT', 'EVENT_EXPIRED', 'EVENT_TIME_INVALID', 'LEGACY_UNTYPED', 'DIAGNOSTIC_LIMIT', 'DIAGNOSTIC_INVALID'] as const
export type NativeGapReason = typeof nativeGapReasons[number]
export type NativeGapPhase = 'READ' | 'PARSE' | 'NORMALIZE' | 'WRITE' | 'INGEST'
export interface NativeGap {
  schema: 2; reasonCode: NativeGapReason; phase: NativeGapPhase; eventType: NativeHookEvent | 'UNKNOWN'; observedAt: string
}
export function nativeEventType(payload: unknown, provider?: NativeHookProvider): NativeGap['eventType'] {
  if (!object(payload)) return 'UNKNOWN'
  if (provider === 'antigravity' || (provider === undefined && typeof payload.hookEventName === 'string')) {
    return antigravityHookEvents.includes(payload.hookEventName as typeof antigravityHookEvents[number])
      ? payload.hookEventName as NativeHookEvent : 'UNKNOWN'
  }
  return codexHookEvents.includes(payload.hook_event_name as typeof codexHookEvents[number])
    ? payload.hook_event_name as NativeHookEvent : 'UNKNOWN'
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
  provider?: NativeHookProvider
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
  source: 'CODEX_NATIVE_HOOK' | 'ANTIGRAVITY_NATIVE_HOOK'
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
  capture?: { epoch: string; configuration: string; gapRevision: string }
  observedAt: string
  eventId: string
  digest: string
}
export function nativeHookSource(provider: NativeHookProvider = 'codex'): NativeHookEnvelope['source'] {
  return provider === 'antigravity' ? 'ANTIGRAVITY_NATIVE_HOOK' : 'CODEX_NATIVE_HOOK'
}
export function nativeSessionPrefix(providerOrSource: NativeHookProvider | NativeHookEnvelope['source'] = 'codex'): 'codex-native' | 'antigravity-native' {
  return providerOrSource === 'antigravity' || providerOrSource === 'ANTIGRAVITY_NATIVE_HOOK' ? 'antigravity-native' : 'codex-native'
}
export function nativeSessionEntityId(eventOrBinding: { source?: NativeHookEnvelope['source']; provider?: NativeHookProvider }, sessionId: string): string {
  return `${nativeSessionPrefix(eventOrBinding.source ?? eventOrBinding.provider ?? 'codex')}:${sessionId}`
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
    (value.provider !== undefined && !nativeHookProviders.includes(value.provider as NativeHookProvider)) ||
    typeof value.repositoryId !== 'string' || !idPattern.test(value.repositoryId) ||
    !['worktreeId', 'generation', 'directoryIdentity'].every(k => typeof value[k] === 'string' && hashPattern.test(value[k] as string)) ||
    !['root', 'commonDirectory', 'spool'].every(k => typeof value[k] === 'string' && (value[k] as string).length <= 4096) ||
    (value.gitCommitTool !== undefined && (typeof value.gitCommitTool !== 'string' || !/^mcp__[a-zA-Z0-9_-]+__commit_git_changes$/.test(value.gitCommitTool)))) throw new Error('INVALID_BINDING')
  return value as unknown as NativeHookBinding
}

function verifyBindingWorktree(identity: ReturnType<typeof nativeGitIdentity>, binding: NativeHookBinding): void {
  if (identity.root !== binding.root || identity.commonDirectory !== binding.commonDirectory || identity.directoryIdentity !== binding.directoryIdentity) throw new Error('WORKTREE_MISMATCH')
}

function normalizeAntigravityHook(payload: Record<string, unknown>, binding: NativeHookBinding, now: Date): NativeHookEnvelope {
  if (!antigravityHookEvents.includes(payload.hookEventName as typeof antigravityHookEvents[number])) throw new Error('EVENT_UNSUPPORTED')
  if (payload.conversationId === undefined || payload.conversationId === null || payload.conversationId === '') throw new Error('REQUIRED_ID_MISSING')
  if (typeof payload.conversationId !== 'string' || !idPattern.test(payload.conversationId)) throw new Error('INVALID_ID')
  let identity: ReturnType<typeof nativeGitIdentity>
  if (payload.workspacePaths !== undefined) {
    if (!Array.isArray(payload.workspacePaths) || !payload.workspacePaths.length || payload.workspacePaths.some(p => typeof p !== 'string' || !p.trim())) throw new Error('CWD_MISSING')
    const identities: ReturnType<typeof nativeGitIdentity>[] = []
    for (const rootPath of payload.workspacePaths as string[]) {
      try { identities.push(nativeGitIdentity(rootPath)) }
      catch { throw new Error(payload.workspacePaths.length > 1 ? 'WORKTREE_SCOPE_AMBIGUOUS' : 'WORKTREE_STALE') }
    }
    const distinct = new Map(identities.map(item => [`${item.root}:${item.directoryIdentity}`, item]))
    if (distinct.size > 1) throw new Error('WORKTREE_SCOPE_AMBIGUOUS')
    identity = identities[0]
    if (payload.cwd !== undefined) {
      if (typeof payload.cwd !== 'string' || !payload.cwd.trim()) throw new Error('CWD_MISSING')
      let cwdIdentity: ReturnType<typeof nativeGitIdentity>
      try { cwdIdentity = nativeGitIdentity(payload.cwd) } catch { throw new Error('WORKTREE_MISMATCH') }
      if (cwdIdentity.root !== identity.root || cwdIdentity.commonDirectory !== identity.commonDirectory || cwdIdentity.directoryIdentity !== identity.directoryIdentity) throw new Error('WORKTREE_MISMATCH')
    }
  } else {
    if (typeof payload.cwd !== 'string' || !payload.cwd.trim()) throw new Error('CWD_MISSING')
    try { identity = nativeGitIdentity(payload.cwd) } catch { throw new Error('WORKTREE_STALE') }
  }
  verifyBindingWorktree(identity, binding)
  const sessionId = nativeDigest(JSON.stringify([binding.repositoryId, 'antigravity', payload.conversationId]))
  const event = payload.hookEventName as typeof antigravityHookEvents[number]
  let turnId: string | undefined
  if (payload.invocationNum !== undefined && payload.invocationNum !== null) {
    if (!Number.isSafeInteger(payload.invocationNum) || Number(payload.invocationNum) < 0) throw new Error('INVALID_ID')
    turnId = nativeDigest(JSON.stringify([sessionId, 'invocationNum', String(payload.invocationNum)]))
  }
  const toolEvent = event === 'PreToolUse' || event === 'PostToolUse'
  const toolCall = object(payload.toolCall) ? payload.toolCall : undefined
  if (toolCall?.id !== undefined && toolCall.id !== null && (typeof toolCall.id !== 'string' || !idPattern.test(toolCall.id))) throw new Error('INVALID_ID')
  if (payload.stepIdx !== undefined && payload.stepIdx !== null && (!Number.isSafeInteger(payload.stepIdx) || Number(payload.stepIdx) < 0)) throw new Error('INVALID_ID')
  const rawInvocationId = typeof toolCall?.id === 'string' ? toolCall.id : (typeof payload.stepIdx === 'number' ? 'step:' + String(payload.stepIdx) : undefined)
  if (toolEvent && !rawInvocationId) throw new Error('INVOCATION_ID_MISSING')
  const invocationId = rawInvocationId ? nativeDigest(JSON.stringify([sessionId, 'tool_call_id', rawInvocationId])) : undefined
  const toolName = typeof toolCall?.name === 'string' ? toolCall.name : ''
  const tool: NativeHookEnvelope['tool'] = toolEvent
    ? (toolName === 'run_command' || toolName === 'Bash' || toolName === 'bash' ? 'SHELL' : (toolName === 'call_mcp_tool' || toolName.startsWith('mcp_') || toolName.startsWith('mcp__')) ? 'MCP' : 'OTHER')
    : undefined
  const facts = {
    schema: 1 as const, source: 'ANTIGRAVITY_NATIVE_HOOK' as const, repositoryId: binding.repositoryId, worktreeId: binding.worktreeId,
    generation: binding.generation, sessionId, event, ...(turnId ? { turnId } : {}), ...(invocationId ? { invocationId } : {}), ...(tool ? { tool } : {})
  }
  const eventId = nativeDigest(JSON.stringify(facts)), observedAt = now.toISOString()
  return { ...facts, observedAt, eventId, digest: nativeDigest(JSON.stringify({ ...facts, observedAt, eventId })) }
}

export function normalizeNativeHook(payload: unknown, binding: NativeHookBinding, now = new Date()): NativeHookEnvelope {
  if (!binding.enabled) throw new Error('DISABLED')
  if (!object(payload)) throw new Error('JSON_STRUCTURE')
  if ((binding.provider ?? 'codex') === 'antigravity') return normalizeAntigravityHook(payload, binding, now)
  if (!codexHookEvents.includes(payload.hook_event_name as typeof codexHookEvents[number])) throw new Error('EVENT_UNSUPPORTED')
  if (payload.session_id === undefined || payload.session_id === null || payload.session_id === '') throw new Error('REQUIRED_ID_MISSING')
  if (typeof payload.session_id !== 'string' || !idPattern.test(payload.session_id)) throw new Error('INVALID_ID')
  if (typeof payload.cwd !== 'string') throw new Error('CWD_MISSING')
  let identity: ReturnType<typeof nativeGitIdentity>
  try { identity = nativeGitIdentity(payload.cwd) } catch { throw new Error('WORKTREE_STALE') }
  verifyBindingWorktree(identity, binding)
  const sessionId = nativeDigest(JSON.stringify([binding.repositoryId, 'codex', payload.session_id]))
  const event = payload.hook_event_name as typeof codexHookEvents[number]
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
    const context = args.deliveryContext
    const hasContext = context !== undefined
    const validContext = object(context) && Object.keys(context).length === 5 &&
      typeof context.bindingArtifactId === 'string' && /^artifact-execution-branch-[a-f0-9]{64}$/.test(context.bindingArtifactId) &&
      Number.isSafeInteger(context.bindingRevision) && Number(context.bindingRevision) > 0 && Number.isSafeInteger(context.planRevision) && Number(context.planRevision) > 0 &&
      typeof context.planArtifactId === 'string' && /^artifact-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(context.planArtifactId) &&
      typeof context.executionId === 'string' && idPattern.test(context.executionId)
    if (typeof operationId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(operationId) &&
      Object.keys(args).length === (hasContext ? 4 : 3) && (!hasContext || validContext) && typeof args.message === 'string' && args.message.length <= 10000 &&
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
  const keys = ['schema', 'source', 'repositoryId', 'worktreeId', 'generation', 'sessionId', 'event', 'turnId', 'invocationId', 'subagentId', 'tool', 'git', 'artifact', 'capture', 'observedAt', 'eventId', 'digest']
  const validEvent = value.source === 'CODEX_NATIVE_HOOK'
    ? codexHookEvents.includes(value.event as typeof codexHookEvents[number])
    : value.source === 'ANTIGRAVITY_NATIVE_HOOK'
      ? antigravityHookEvents.includes(value.event as typeof antigravityHookEvents[number])
      : false
  if (Object.keys(value).some(k => !keys.includes(k)) || value.schema !== 1 || !validEvent ||
    typeof value.repositoryId !== 'string' || !idPattern.test(value.repositoryId) ||
    !['worktreeId','generation','sessionId','eventId','digest'].every(k => typeof value[k] === 'string' && hashPattern.test(value[k] as string)) ||
    ['turnId','invocationId','subagentId'].some(k => value[k] !== undefined && (typeof value[k] !== 'string' || !hashPattern.test(value[k] as string))) ||
    (value.source === 'ANTIGRAVITY_NATIVE_HOOK' && (value.git !== undefined || value.artifact !== undefined || value.subagentId !== undefined)) ||
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
  if (value.capture !== undefined && (!object(value.capture) || Object.keys(value.capture).length !== 3 ||
    !['epoch', 'configuration', 'gapRevision'].every(key => typeof (value.capture as Record<string, unknown>)[key] === 'string' && hashPattern.test((value.capture as Record<string, string>)[key])))) throw new Error('INVALID_ENVELOPE')
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
  let ancestor = resolve(spool)
  while (true) {
    const stat = lstatSync(ancestor, { throwIfNoEntry: false })
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(ancestor) !== ancestor)) throw new Error('UNSAFE_SPOOL')
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
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
