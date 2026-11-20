import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync, utimesSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { gitReceiptFingerprint } from '../git-operations/git-operation-receipts'
import { nativeArtifactFact, validNativeArtifactFact, type NativeArtifactFact } from './native-artifact-facts'
import { antigravityAppLocatorDigest } from './antigravity-app-locator'

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
  scope?: 'USER' | 'CHECKOUT'
  enabled: boolean
  repositoryId: string
  worktreeId: string
  generation: string
  root: string
  commonDirectory: string
  directoryIdentity: string
  spool: string
  configPath?: string
  gitCommitTool?: string
}
export interface NativeHookActivationRef {
  activationId: string
  revision: number
  executionId: string
  planArtifactId: string
  planRevision: number
  bindingArtifactId: string
  bindingRevision: number
  scope: 'CHECKOUT_OBSERVED' | 'DELEGATED'
  parentSessionId?: string
}
export interface NativeProducerWitness {
  verifiedBy: 'MANAGED_RUNTIME'
  sessionId: string
  receiptId?: string
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
  appTranscriptDigest?: string
  activation?: NativeHookActivationRef
  producerWitness?: NativeProducerWitness
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

export function nativeGitDirectories(root: string, strict = false) {
  const physical = realpathSync(root), pointer = join(physical, '.git')
  if (strict && (!isAbsolute(root) || !sameNativePath(resolve(root), physical))) throw new Error('WORKTREE_MISMATCH')
  if (lstatSync(pointer).isSymbolicLink()) throw new Error('UNSAFE_GIT_DIRECTORY')
  let admin = pointer
  if (!lstatSync(pointer).isDirectory()) {
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(boundedFile(pointer, 4096))
    if (!match) throw new Error('INVALID_GIT_DIRECTORY')
    admin = resolve(physical, match[1])
  }
  const resolvedAdmin = realpathSync(admin)
  if (strict && !sameNativePath(admin, resolvedAdmin)) throw new Error('UNSAFE_GIT_DIRECTORY')
  admin = resolvedAdmin
  let commonDirectory = admin
  const commonPointer = join(admin, 'commondir')
  if (lstatSync(commonPointer, { throwIfNoEntry: false })) {
    const value = readGitPath(commonPointer)
    const expectedCommon = resolve(admin, value)
    commonDirectory = realpathSync(expectedCommon)
    if (strict && !sameNativePath(expectedCommon, commonDirectory)) throw new Error('UNSAFE_GIT_DIRECTORY')
  }
  if (strict && admin !== pointer) {
    const backlink = resolve(admin, readGitPath(join(admin, 'gitdir')))
    if (dirname(admin) !== join(commonDirectory, 'worktrees') || !sameNativePath(backlink, pointer)) throw new Error('WORKTREE_MISMATCH')
  } else if (strict && commonDirectory !== admin) throw new Error('WORKTREE_MISMATCH')
  return { physical, admin, commonDirectory }
}

function readGitPath(path: string): string {
  const value = boundedFile(path, 4096).replace(/\r?\n$/, '')
  if (!value || /[\r\n\0]/.test(value)) throw new Error('INVALID_GIT_DIRECTORY')
  return value
}

export const sameNativePath = (first: string, second: string): boolean =>
  process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second

function gitDirectoryFingerprint(paths: string[]) {
  return paths.map(path => {
    const stat = lstatSync(path, { bigint: true })
    if (!stat.isDirectory()) throw new Error('UNSAFE_GIT_DIRECTORY')
    return [path, String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]
  })
}

export function nativeGitIdentity(root: string): { root: string; commonDirectory: string; directoryIdentity: string } {
  const { physical, admin, commonDirectory } = nativeGitDirectories(root)
  const identity = gitDirectoryFingerprint([physical, admin, commonDirectory])
  return { root: physical, commonDirectory, directoryIdentity: nativeDigest(JSON.stringify(identity)) }
}

export function nativeWorktreeIdentity(root: string, strict = true) {
  const { physical, admin, commonDirectory } = nativeGitDirectories(root, strict)
  const identity = gitDirectoryFingerprint([physical, admin, commonDirectory])
  const [[, , rootInode, rootBirth], adminIdentity] = identity
  const generation = nativeDigest(JSON.stringify([...adminIdentity, physical, rootInode, rootBirth]))
  const directoryIdentity = nativeDigest(JSON.stringify(identity))
  const gitPath = realpathSync.native(physical).replaceAll('\\', '/')
  const worktreeId = (repositoryId: string) => nativeDigest(JSON.stringify([repositoryId, commonDirectory, generation, gitPath]))
  return { root: physical, admin, commonDirectory, directoryIdentity, generation, gitPath, worktreeId }
}

export const nativeGitCommitToolPattern = /^mcp__[a-zA-Z0-9_-]+__commit_git_changes$/

export function readNativeBinding(path: string): NativeHookBinding {
  const value: unknown = JSON.parse(boundedFile(path, 8192))
  if (!object(value) || value.schema !== 1 || typeof value.enabled !== 'boolean' ||
    (value.provider !== undefined && !nativeHookProviders.includes(value.provider as NativeHookProvider)) ||
    (value.scope !== undefined && value.scope !== 'USER' && value.scope !== 'CHECKOUT') ||
    typeof value.repositoryId !== 'string' || !idPattern.test(value.repositoryId) ||
    !['worktreeId', 'generation', 'directoryIdentity'].every(k => typeof value[k] === 'string' && hashPattern.test(value[k] as string)) ||
    !['root', 'commonDirectory', 'spool'].every(k => typeof value[k] === 'string' && (value[k] as string).length <= 4096) ||
    (value.configPath !== undefined && (typeof value.configPath !== 'string' || value.configPath.length > 4096 || !isAbsolute(value.configPath))) ||
    (value.gitCommitTool !== undefined && (typeof value.gitCommitTool !== 'string' || !nativeGitCommitToolPattern.test(value.gitCommitTool)))) throw new Error('INVALID_BINDING')
  return value as unknown as NativeHookBinding
}

export const nativeBindingPath = (root: string, provider: NativeHookProvider = 'codex') =>
  join(root, '.code-awareness/native-hooks', ...(provider === 'antigravity' ? ['antigravity', 'binding.json'] : ['binding.json']))
export function hasNativeBindingFile(root: string, provider?: NativeHookProvider): boolean {
  const providers = provider ? [provider] : nativeHookProviders
  return providers.some(candidate => existsSync(nativeBindingPath(root, candidate)))
}
export function spoolEventFiles(spool: string): string[] {
  try {
    return readdirSync(spool).filter(name => /^(?:[0-9]{1,3}|10[01][0-9]|102[0-3])\.json$/.test(name)).sort()
  } catch {
    return []
  }
}
export const nativeDispatchMismatch = 'NATIVE_DISPATCH_SCOPE_MISMATCH'

export function readScopedNativeBinding(root: string, provider: NativeHookProvider = 'codex'): NativeHookBinding {
  const { physical, admin, commonDirectory } = nativeGitDirectories(root, true)
  const path = nativeBindingPath(physical, provider)
  if (!sameNativePath(realpathSync(path), path) || lstatSync(path).nlink !== 1) throw new Error('WORKTREE_MISMATCH')
  const binding = readNativeBinding(path)
  const identity = gitDirectoryFingerprint([physical, admin, commonDirectory])
  const [[, , rootInode, rootBirth], adminIdentity] = identity
  const generation = nativeDigest(JSON.stringify([...adminIdentity, physical, rootInode, rootBirth]))
  const gitPaths = process.platform === 'win32'
    ? [physical, realpathSync.native(physical)].map(path => path.replaceAll('\\', '/'))
    : [physical]
  const hasWorktreeId = gitPaths.some(path => binding.worktreeId === nativeDigest(JSON.stringify([binding.repositoryId, commonDirectory, generation, path])))
  const spool = join(dirname(path), 'spool')
  if (!binding.enabled || (binding.provider ?? 'codex') !== provider || binding.root !== physical || binding.commonDirectory !== commonDirectory ||
      binding.directoryIdentity !== nativeDigest(JSON.stringify(identity)) || binding.generation !== generation ||
      !hasWorktreeId || binding.spool !== spool ||
      !lstatSync(spool).isDirectory() || !sameNativePath(realpathSync(spool), spool)) throw new Error('WORKTREE_MISMATCH')
  return binding
}

export function resolveNativeHookBinding(anchorPath: string, cwd: string, provider: NativeHookProvider = 'codex', authorize?: (binding: NativeHookBinding) => void): NativeHookBinding {
  if (!isAbsolute(anchorPath)) throw new Error('WORKTREE_MISMATCH')
  const base = dirname(dirname(dirname(resolve(anchorPath))))
  const anchorRoot = provider === 'antigravity' ? dirname(base) : base
  if (!sameNativePath(resolve(anchorPath), nativeBindingPath(anchorRoot, provider))) throw new Error('WORKTREE_MISMATCH')
  const anchor = readScopedNativeBinding(anchorRoot, provider)
  // Antigravity starts handlers outside the checkout. Its payload scope is verified during normalization.
  const target = provider === 'antigravity' || cwd === anchor.root ? anchor : readScopedNativeBinding(cwd, provider)
  if (target.commonDirectory !== anchor.commonDirectory || target.repositoryId !== anchor.repositoryId ||
      (target.root !== anchor.root && (provider !== 'codex' || anchor.commonDirectory !== join(anchor.root, '.git')))) throw new Error(nativeDispatchMismatch)
  authorize?.(anchor)
  if (target !== anchor) authorize?.(target)
  return target
}

function verifyBindingWorktree(identity: ReturnType<typeof nativeGitIdentity>, binding: NativeHookBinding): void {
  if (identity.root !== binding.root || identity.commonDirectory !== binding.commonDirectory || identity.directoryIdentity !== binding.directoryIdentity) throw new Error('WORKTREE_MISMATCH')
}

// The IDE can emit a lowercase drive letter even when the binding uses the filesystem's casing.
const antigravityGitIdentity = (root: string) => nativeGitIdentity(realpathSync.native(root))

function antigravityPhysicalGitIdentity(rootPath: string, errorCode: string): ReturnType<typeof nativeGitIdentity> {
  if (!isAbsolute(rootPath)) throw new Error(errorCode)
  const resolved = resolve(rootPath)
  try {
    if (lstatSync(resolved).isSymbolicLink()) throw new Error(errorCode)
    const real = realpathSync(resolved)
    if (!sameNativePath(resolved, real)) throw new Error(errorCode)
    return antigravityGitIdentity(real)
  } catch {
    throw new Error(errorCode)
  }
}

export function resolveAntigravityPayloadIdentity(payload: Record<string, unknown>): ReturnType<typeof nativeGitIdentity> {
  let identity: ReturnType<typeof nativeGitIdentity>
  if (payload.workspacePaths !== undefined) {
    if (!Array.isArray(payload.workspacePaths) || !payload.workspacePaths.length || payload.workspacePaths.some(p => typeof p !== 'string' || !p.trim())) throw new Error('CWD_MISSING')
    const identities: ReturnType<typeof nativeGitIdentity>[] = []
    for (const rootPath of payload.workspacePaths as string[]) {
      identities.push(antigravityPhysicalGitIdentity(rootPath, payload.workspacePaths.length > 1 ? 'WORKTREE_SCOPE_AMBIGUOUS' : 'WORKTREE_STALE'))
    }
    const distinct = new Map(identities.map(item => [`${item.root}:${item.directoryIdentity}`, item]))
    if (distinct.size > 1) throw new Error('WORKTREE_SCOPE_AMBIGUOUS')
    identity = identities[0]
    if (payload.cwd !== undefined) {
      if (typeof payload.cwd !== 'string' || !payload.cwd.trim() || !isAbsolute(payload.cwd)) throw new Error('WORKTREE_MISMATCH')
      const resolvedCwd = resolve(payload.cwd)
      let realCwd: string
      try {
        if (lstatSync(resolvedCwd).isSymbolicLink()) throw new Error('WORKTREE_MISMATCH')
        realCwd = realpathSync(resolvedCwd)
      } catch { throw new Error('WORKTREE_MISMATCH') }
      if (!sameNativePath(resolvedCwd, realCwd)) throw new Error('WORKTREE_MISMATCH')
      const canonicalRoot = realpathSync.native(identity.root)
      const canonicalCwd = realpathSync.native(realCwd)
      let withinRoot = sameNativePath(canonicalCwd, canonicalRoot)
      const sep = process.platform === 'win32' ? '\\' : '/'
      if (!withinRoot && (process.platform === 'win32'
        ? canonicalCwd.toLowerCase().startsWith(canonicalRoot.toLowerCase() + sep)
        : canonicalCwd.startsWith(canonicalRoot + sep))) {
        let cursor = canonicalCwd
        withinRoot = true
        while (!sameNativePath(cursor, canonicalRoot)) {
          if (lstatSync(cursor).isSymbolicLink() || existsSync(join(cursor, '.git'))) { withinRoot = false; break }
          const parent = dirname(cursor)
          if (parent === cursor) { withinRoot = false; break }
          cursor = parent
        }
      }
      if (!withinRoot) throw new Error('WORKTREE_MISMATCH')
    }
  } else {
    if (typeof payload.cwd !== 'string' || !payload.cwd.trim()) throw new Error('CWD_MISSING')
    const resolvedCwd = resolve(payload.cwd)
    identity = antigravityPhysicalGitIdentity(payload.cwd, 'WORKTREE_STALE')
    const canonicalRoot = realpathSync.native(identity.root)
    const canonicalCwd = realpathSync.native(resolvedCwd)
    let cursor = canonicalCwd
    while (!sameNativePath(cursor, canonicalRoot)) {
      if (lstatSync(cursor).isSymbolicLink() || existsSync(join(cursor, '.git'))) throw new Error('WORKTREE_MISMATCH')
      const parent = dirname(cursor)
      if (parent === cursor) throw new Error('WORKTREE_MISMATCH')
      cursor = parent
    }
  }
  return identity
}

export interface NormalizeHookOptions {
  expectedEvent?: NativeHookEvent
  activation?: NativeHookActivationRef
  producerWitness?: NativeProducerWitness
}

export function readActiveHookActivation(
  profile: string | undefined,
  binding: Pick<NativeHookBinding, 'repositoryId' | 'worktreeId' | 'generation' | 'root'>,
  env: NodeJS.ProcessEnv = process.env
): NativeHookActivationRef | undefined {
  if (!profile) return undefined
  try {
    const dbPath = join(profile, 'continuum', 'repositories', Buffer.from(binding.repositoryId).toString('base64url'), 'continuum.db')
    const stat = lstatSync(dbPath, { throwIfNoEntry: false })
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) return undefined
    const sqlite = require('node:sqlite') as typeof import('node:sqlite')
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
    try {
      db.exec('PRAGMA busy_timeout=50')
      const row = db.prepare(`SELECT activation_id, revision, worktree_generation, branch_ref, execution_id, plan_artifact_id, plan_revision, binding_artifact_id, binding_revision
        FROM execution_activations WHERE repository_id=? AND worktree_id=? AND status='ACTIVE' LIMIT 1`).get(binding.repositoryId, binding.worktreeId) as Record<string, unknown> | undefined
      if (!row || row.worktree_generation !== binding.generation) return undefined
      try {
        const { admin } = nativeGitDirectories(binding.root, false)
        const head = boundedFile(join(admin, 'HEAD'), 4096).trim()
        const headRef = /^ref:\s*(refs\/heads\/.+)$/.exec(head)?.[1]
        if (headRef && row.branch_ref !== headRef) return undefined
      } catch { return undefined }
      const parentRaw = typeof env.CODE_AWARENESS_PARENT_SESSION_ID === 'string' && hashPattern.test(env.CODE_AWARENESS_PARENT_SESSION_ID)
        ? env.CODE_AWARENESS_PARENT_SESSION_ID
        : undefined
      let delegated = false
      if (parentRaw && typeof env.CODE_AWARENESS_DELIVERY_CONTEXT === 'string' && env.CODE_AWARENESS_DELIVERY_CONTEXT.trim()) {
        try {
          const parsed = JSON.parse(env.CODE_AWARENESS_DELIVERY_CONTEXT) as Record<string, unknown>
          delegated = parsed?.executionId === row.execution_id && parsed?.planArtifactId === row.plan_artifact_id &&
            parsed?.planRevision === row.plan_revision && parsed?.bindingArtifactId === row.binding_artifact_id && parsed?.bindingRevision === row.binding_revision
        } catch {}
      }
      return {
        activationId: String(row.activation_id),
        revision: Number(row.revision),
        executionId: String(row.execution_id),
        planArtifactId: String(row.plan_artifact_id),
        planRevision: Number(row.plan_revision),
        bindingArtifactId: String(row.binding_artifact_id),
        bindingRevision: Number(row.binding_revision),
        scope: delegated ? 'DELEGATED' : 'CHECKOUT_OBSERVED',
        ...(delegated && parentRaw ? { parentSessionId: parentRaw } : {})
      }
    } finally { db.close() }
  } catch { return undefined }
}

function validActivationRef(value: unknown): value is NativeHookActivationRef {
  if (!object(value)) return false
  const allowed = ['activationId', 'revision', 'executionId', 'planArtifactId', 'planRevision', 'bindingArtifactId', 'bindingRevision', 'scope', 'parentSessionId']
  if (Object.keys(value).some(k => !allowed.includes(k))) return false
  if (typeof value.activationId !== 'string' || !idPattern.test(value.activationId)) return false
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) return false
  if (typeof value.executionId !== 'string' || !idPattern.test(value.executionId)) return false
  if (typeof value.planArtifactId !== 'string' || !idPattern.test(value.planArtifactId)) return false
  if (!Number.isSafeInteger(value.planRevision) || Number(value.planRevision) < 1) return false
  if (typeof value.bindingArtifactId !== 'string' || !idPattern.test(value.bindingArtifactId)) return false
  if (!Number.isSafeInteger(value.bindingRevision) || Number(value.bindingRevision) < 1) return false
  if (value.scope !== 'CHECKOUT_OBSERVED' && value.scope !== 'DELEGATED') return false
  if (value.parentSessionId !== undefined && (value.scope !== 'DELEGATED' || typeof value.parentSessionId !== 'string' || !hashPattern.test(value.parentSessionId))) return false
  return true
}

function validProducerWitness(value: unknown): value is NativeProducerWitness {
  if (!object(value)) return false
  if (Object.keys(value).some(k => !['verifiedBy', 'sessionId', 'receiptId'].includes(k))) return false
  if (value.verifiedBy !== 'MANAGED_RUNTIME' || typeof value.sessionId !== 'string' || !hashPattern.test(value.sessionId)) return false
  if (value.receiptId !== undefined && (typeof value.receiptId !== 'string' || !idPattern.test(value.receiptId))) return false
  return true
}

function extractNativeGitFact(
  event: NativeHookEvent,
  binding: NativeHookBinding,
  toolName: unknown,
  toolInput: unknown,
  toolResponse: unknown
): NativeHookEnvelope['git'] {
  if (!binding.gitCommitTool || toolName !== binding.gitCommitTool || !object(toolInput)) return undefined
  const { operationId, ...args } = toolInput
  const context = args.deliveryContext
  const hasContext = context !== undefined
  const validContext = object(context) && Object.keys(context).length === 5 &&
    typeof context.bindingArtifactId === 'string' && /^artifact-execution-branch-[a-f0-9]{64}$/.test(context.bindingArtifactId) &&
    Number.isSafeInteger(context.bindingRevision) && Number(context.bindingRevision) > 0 && Number.isSafeInteger(context.planRevision) && Number(context.planRevision) > 0 &&
    typeof context.planArtifactId === 'string' && /^artifact-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(context.planArtifactId) &&
    typeof context.executionId === 'string' && idPattern.test(context.executionId)
  if (typeof operationId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(operationId) ||
    Object.keys(args).length !== (hasContext ? 4 : 3) || (hasContext && !validContext) || typeof args.message !== 'string' || args.message.length > 10000 ||
    !(args.expectedHead === null || typeof args.expectedHead === 'string' && /^[a-f0-9]{40}$/.test(args.expectedHead)) ||
    typeof args.expectedIndexRevision !== 'string' || !hashPattern.test(args.expectedIndexRevision)) return undefined
  const git: NonNullable<NativeHookEnvelope['git']> = {
    operationId,
    fingerprint: gitReceiptFingerprint('commit_git_changes', args),
    expectedHead: args.expectedHead as string | null
  }
  if (event === 'PostToolUse' && object(toolResponse) && toolResponse.isError !== true) {
    let result: unknown = toolResponse.structuredContent
    if (!result && Array.isArray(toolResponse.content)) {
      const first = toolResponse.content[0]
      if (object(first) && first.type === 'text' && typeof first.text === 'string') {
        try { result = JSON.parse(first.text) } catch {}
      }
    }
    if (object(result) && result.operationId === operationId && typeof result.sha === 'string' && /^[a-f0-9]{40}$/.test(result.sha) &&
      result.parent === args.expectedHead && typeof result.replayed === 'boolean') {
      Object.assign(git, { sha: result.sha, parent: result.parent, replayed: result.replayed })
    }
  }
  return git
}

function normalizeAntigravityHook(
  payload: Record<string, unknown>,
  binding: NativeHookBinding,
  now: Date,
  options?: NormalizeHookOptions
): NativeHookEnvelope {
  const payloadEvent = payload.hookEventName
  if (options?.expectedEvent !== undefined) {
    if (!antigravityHookEvents.includes(options.expectedEvent as typeof antigravityHookEvents[number])) throw new Error('EVENT_UNSUPPORTED')
    if (payloadEvent !== undefined && payloadEvent !== options.expectedEvent) throw new Error('EVENT_UNSUPPORTED')
  }
  const resolvedEvent = options?.expectedEvent ?? payloadEvent
  if (!antigravityHookEvents.includes(resolvedEvent as typeof antigravityHookEvents[number])) throw new Error('EVENT_UNSUPPORTED')
  if (payload.conversationId === undefined || payload.conversationId === null || payload.conversationId === '') throw new Error('REQUIRED_ID_MISSING')
  if (typeof payload.conversationId !== 'string' || !idPattern.test(payload.conversationId)) throw new Error('INVALID_ID')
  const identity = resolveAntigravityPayloadIdentity(payload)
  verifyBindingWorktree(identity, binding)
  const sessionId = nativeDigest(JSON.stringify([binding.repositoryId, 'antigravity', payload.conversationId]))
  const event = resolvedEvent as typeof antigravityHookEvents[number]
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
  const appTranscriptDigest = antigravityAppLocatorDigest(payload.conversationId, payload.transcriptPath)
  const activation = options?.activation && validActivationRef(options.activation) ? options.activation : undefined
  const producerWitness = options?.producerWitness && validProducerWitness(options.producerWitness) && options.producerWitness.sessionId === sessionId
    ? options.producerWitness
    : undefined
  let git: NativeHookEnvelope['git']
  let artifact: NativeArtifactFact | undefined
  if (toolEvent && producerWitness && invocationId) {
    const toolInput = toolCall?.input ?? payload.tool_input
    const toolResponse = toolCall?.response ?? payload.tool_response
    git = extractNativeGitFact(event, binding, toolName, toolInput, toolResponse)
    artifact = nativeArtifactFact({
      hook_event_name: event,
      tool_name: toolName,
      tool_input: toolInput,
      ...(toolResponse !== undefined ? { tool_response: toolResponse } : {})
    }, binding.repositoryId)
  }
  const hasVerifiedCausalFact = Boolean(git || artifact)
  const facts = {
    schema: 1 as const, source: 'ANTIGRAVITY_NATIVE_HOOK' as const, repositoryId: binding.repositoryId, worktreeId: binding.worktreeId,
    generation: binding.generation, sessionId, event, ...(turnId ? { turnId } : {}), ...(invocationId ? { invocationId } : {}), ...(tool ? { tool } : {}),
    ...(appTranscriptDigest ? { appTranscriptDigest } : {}),
    ...(activation ? { activation } : {}),
    ...(hasVerifiedCausalFact && producerWitness ? { producerWitness } : {}),
    ...(git ? { git } : {}),
    ...(artifact ? { artifact } : {})
  }
  const eventId = nativeDigest(JSON.stringify(facts)), observedAt = now.toISOString()
  return { ...facts, observedAt, eventId, digest: nativeDigest(JSON.stringify({ ...facts, observedAt, eventId })) }
}

export function normalizeNativeHook(payload: unknown, binding: NativeHookBinding, now = new Date(), options?: NormalizeHookOptions): NativeHookEnvelope {
  if (!binding.enabled) throw new Error('DISABLED')
  if (!object(payload)) throw new Error('JSON_STRUCTURE')
  if ((binding.provider ?? 'codex') === 'antigravity') return normalizeAntigravityHook(payload, binding, now, options)
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
  const git = toolEvent ? extractNativeGitFact(event, binding, payload.tool_name, payload.tool_input, payload.tool_response) : undefined
  const artifact = toolEvent ? nativeArtifactFact(payload, binding.repositoryId) : undefined
  const activation = options?.activation && validActivationRef(options.activation) ? options.activation : undefined
  const facts = { schema: 1 as const, source: 'CODEX_NATIVE_HOOK' as const, repositoryId: binding.repositoryId, worktreeId: binding.worktreeId,
    generation: binding.generation, sessionId, event, ...(turnId ? { turnId } : {}), ...(invocationId ? { invocationId } : {}), ...(subagentId ? { subagentId } : {}), ...(activation ? { activation } : {}), ...(tool ? { tool } : {}), ...(git ? { git } : {}), ...(artifact ? { artifact } : {}) }
  const eventId = nativeDigest(JSON.stringify(facts)), observedAt = now.toISOString()
  return { ...facts, observedAt, eventId, digest: nativeDigest(JSON.stringify({ ...facts, observedAt, eventId })) }
}

export function parseNativeEnvelope(text: string): NativeHookEnvelope {
  if (Buffer.byteLength(text) > nativeHookLimits.envelopeBytes) throw new Error('ENVELOPE_LIMIT')
  const value: unknown = JSON.parse(text)
  if (!object(value)) throw new Error('INVALID_ENVELOPE')
  const keys = ['schema', 'source', 'repositoryId', 'worktreeId', 'generation', 'sessionId', 'event', 'turnId', 'invocationId', 'subagentId', 'activation', 'producerWitness', 'tool', 'git', 'artifact', 'capture', 'appTranscriptDigest', 'observedAt', 'eventId', 'digest']
  const validEvent = value.source === 'CODEX_NATIVE_HOOK'
    ? codexHookEvents.includes(value.event as typeof codexHookEvents[number])
    : value.source === 'ANTIGRAVITY_NATIVE_HOOK'
      ? antigravityHookEvents.includes(value.event as typeof antigravityHookEvents[number])
      : false
  if (Object.keys(value).some(k => !keys.includes(k)) || value.schema !== 1 || !validEvent ||
    typeof value.repositoryId !== 'string' || !idPattern.test(value.repositoryId) ||
    !['worktreeId','generation','sessionId','eventId','digest'].every(k => typeof value[k] === 'string' && hashPattern.test(value[k] as string)) ||
    ['turnId','invocationId','subagentId'].some(k => value[k] !== undefined && (typeof value[k] !== 'string' || !hashPattern.test(value[k] as string))) ||
    (value.activation !== undefined && !validActivationRef(value.activation)) ||
    (value.producerWitness !== undefined && (!validProducerWitness(value.producerWitness) || value.producerWitness.sessionId !== value.sessionId)) ||
    (value.source === 'ANTIGRAVITY_NATIVE_HOOK' && (value.subagentId !== undefined || ((value.git !== undefined || value.artifact !== undefined) && !value.producerWitness))) ||
    (value.appTranscriptDigest !== undefined && (value.source !== 'ANTIGRAVITY_NATIVE_HOOK' || typeof value.appTranscriptDigest !== 'string' || !hashPattern.test(value.appTranscriptDigest))) ||
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
