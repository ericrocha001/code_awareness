import { existsSync } from 'node:fs'
import { hasNativeBindingFile, nativeBindingPath, nativeDigest, readNativeBinding, spoolEventFiles, type NativeHookProvider } from './native-hooks'
import { nativeHookReadiness } from './native-hook-readiness'
import { unknownNativeTrust } from './native-hook-preflight'
import type { SessionStore } from './store'
import type { SessionTargetSelection } from './target'

export interface ExecutionOriginPreflight {
  worktreeId: string
  generation: string
  agent: NativeHookProvider
  captureStatus: 'CAPTURE_OBSERVED' | 'INGESTION_PENDING' | 'PENDING_FIRST_SESSION' | 'BINDING_MISSING' | 'BINDING_DISABLED' | 'STALE_GENERATION' | 'UNAVAILABLE'
  ready: boolean
  binding: { state: 'PRESENT' | 'MISSING' | 'DISABLED' | 'STALE_GENERATION' | 'INVALID'; pendingSpoolCount: number }
  installation: { state: string; reasonCode: string }
  origin: {
    state: 'ALIGNED' | 'TARGET_SESSION_OBSERVED' | 'ORIGIN_MISMATCH' | 'AMBIGUOUS' | 'UNKNOWN' | 'UNAVAILABLE'
    reason: string
    observedOnTarget: boolean
    observedWorktrees: { worktreeId: string; generation: string }[]
    recommendedAction?: string
  }
}

interface BindingInspection {
  state: ExecutionOriginPreflight['binding']['state']
  pendingSpoolCount: number
}

function inspectBindingState(root: string, target: SessionTargetSelection, agent: NativeHookProvider): BindingInspection {
  const path = nativeBindingPath(root, agent)
  if (!existsSync(path)) return { state: 'MISSING', pendingSpoolCount: 0 }
  try {
    const binding = readNativeBinding(path)
    if (binding.worktreeId !== target.worktreeId || binding.generation !== target.generation) {
      return { state: 'STALE_GENERATION', pendingSpoolCount: 0 }
    }
    const pendingSpoolCount = spoolEventFiles(binding.spool).length
    if (!binding.enabled) return { state: 'DISABLED', pendingSpoolCount }
    return { state: 'PRESENT', pendingSpoolCount }
  } catch {
    return { state: 'INVALID', pendingSpoolCount: 0 }
  }
}

function addWorktrees(seen: Map<string, SessionTargetSelection>, worktrees: SessionTargetSelection[]): void {
  for (const wt of worktrees) {
    const key = `${wt.worktreeId}:${wt.generation}`
    if (!seen.has(key)) seen.set(key, { worktreeId: wt.worktreeId, generation: wt.generation })
  }
}

function collectSessionWorktrees(store: SessionStore, sessionId: string, accountHash?: string): SessionTargetSelection[] {
  const seen = new Map<string, SessionTargetSelection>()
  const providers: ('codex-native' | 'antigravity-native')[] = ['codex-native', 'antigravity-native']
  const candidates: { provider: 'codex-native' | 'antigravity-native'; id: string }[] = []
  if (sessionId.startsWith('codex-native:')) {
    candidates.push({ provider: 'codex-native', id: sessionId.slice('codex-native:'.length) })
  } else if (sessionId.startsWith('antigravity-native:')) {
    candidates.push({ provider: 'antigravity-native', id: sessionId.slice('antigravity-native:'.length) })
  } else if (/^[a-f0-9]{64}$/.test(sessionId)) {
    for (const provider of providers) candidates.push({ provider, id: sessionId })
  } else {
    candidates.push(
      { provider: 'codex-native', id: nativeDigest(JSON.stringify([store.repositoryId, 'codex', sessionId])) },
      { provider: 'antigravity-native', id: nativeDigest(JSON.stringify([store.repositoryId, 'antigravity', sessionId])) }
    )
    if (/^[0-9a-f-]{36}$/i.test(sessionId)) {
      let local = store.byProvider(sessionId)
      if (!local) { try { local = store.session(sessionId) } catch {} }
      if (local && store.registry.visible({ kind: 'SESSION', id: `${local.provider ?? 'entire'}:${local.providerSessionId}` }, accountHash)) {
        addWorktrees(seen, store.worktreesForSession(local.id))
        if (local.provider === 'codex' || local.provider === 'entire') {
          for (const provider of providers) {
            const hashed = nativeDigest(JSON.stringify([store.repositoryId, provider === 'codex-native' ? 'codex' : 'antigravity', local.providerSessionId]))
            candidates.push({ provider, id: local.providerSessionId }, { provider, id: hashed })
          }
        }
      }
    }
  }
  for (const candidate of candidates) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,300}$/.test(candidate.id)) continue
    if (!store.registry.visible({ kind: 'SESSION', id: `${candidate.provider}:${candidate.id}` }, accountHash)) continue
    addWorktrees(seen, store.registry.sessionWorktrees(candidate.provider, candidate.id))
  }
  return [...seen.values()]
}

function collectExecutionWorktrees(store: SessionStore, executionId: string, accountHash?: string): SessionTargetSelection[] {
  const seen = new Map<string, SessionTargetSelection>()
  const linked = store.registry.linkedSessions({ kind: 'EXECUTION', id: executionId }, {}, accountHash)
  for (const row of linked.rows) addWorktrees(seen, row.worktrees)
  for (const row of store.sessions({ executionId }, 0, 20, accountHash)) {
    addWorktrees(seen, store.worktreesForSession(row.id))
  }
  return [...seen.values()]
}

function classifyObservedWorktrees(
  observed: SessionTargetSelection[],
  target: SessionTargetSelection,
  binding: BindingInspection,
  unavailableReason?: string
): ExecutionOriginPreflight['origin'] {
  const matchesTarget = (wt: SessionTargetSelection) => wt.worktreeId === target.worktreeId && wt.generation === target.generation
  const observedOnTarget = observed.some(matchesTarget)
  const conflicts = observed.filter(wt => !matchesTarget(wt))
  if (observedOnTarget && conflicts.length === 0) {
    return { state: 'ALIGNED', reason: 'ORIGIN_ALIGNED_WITH_TARGET', observedOnTarget: true, observedWorktrees: observed }
  }
  if (!observedOnTarget && conflicts.length > 0) {
    return {
      state: 'ORIGIN_MISMATCH',
      reason: 'SESSION_ORIGINATED_IN_DIFFERENT_WORKTREE',
      observedOnTarget: false,
      observedWorktrees: conflicts,
      recommendedAction: 'START_FRESH_SESSION_IN_TARGET_WORKTREE'
    }
  }
  if (observedOnTarget && conflicts.length > 0) {
    return {
      state: 'AMBIGUOUS',
      reason: 'MULTIPLE_WORKTREE_ORIGINS_OBSERVED',
      observedOnTarget: true,
      observedWorktrees: observed,
      recommendedAction: 'START_FRESH_SESSION_IN_TARGET_WORKTREE'
    }
  }
  if (unavailableReason) {
    return {
      state: 'UNAVAILABLE',
      reason: unavailableReason,
      observedOnTarget: false,
      observedWorktrees: [],
      recommendedAction: 'REPAIR_NATIVE_CAPTURE_BEFORE_EXECUTION'
    }
  }
  return {
    state: 'UNKNOWN',
    reason: binding.pendingSpoolCount > 0 ? 'INGESTION_PENDING' : 'SESSION_ORIGIN_UNOBSERVED',
    observedOnTarget: false,
    observedWorktrees: [],
    recommendedAction: binding.pendingSpoolCount > 0 ? 'WAIT_OR_RECHECK_CAPTURE_HEALTH' : 'OBSERVE_TARGET_SESSION_BEFORE_EXECUTION'
  }
}

function resolveTargetAgent(
  store: SessionStore,
  root: string,
  target: SessionTargetSelection,
  options: { agent?: NativeHookProvider; sessionId?: string; profile?: string; accountHash?: string }
): NativeHookProvider {
  if (options.agent) return options.agent
  if (options.sessionId?.startsWith('antigravity-native:')) return 'antigravity'
  if (options.sessionId?.startsWith('codex-native:')) return 'codex'
  if (hasNativeBindingFile(root, 'antigravity') && !hasNativeBindingFile(root, 'codex')) return 'antigravity'
  if (hasNativeBindingFile(root, 'codex') && !hasNativeBindingFile(root, 'antigravity')) return 'codex'
  const agSessions = store.registry.queryNativeSessions({ worktreeId: target.worktreeId, generation: target.generation, agent: 'antigravity' }, options.accountHash).rows
  if (agSessions.length > 0) return 'antigravity'
  const agReadiness = nativeHookReadiness(store.registry, root, target, unknownNativeTrust('CLIENT_TRUST_UNSUPPORTED'), 'antigravity', options.profile ? { profile: options.profile } : undefined)
  if (agReadiness.installation.state === 'CONFIGURED') return 'antigravity'
  return 'codex'
}

export function inspectExecutionOriginAlignment(
  store: SessionStore,
  root: string,
  target: SessionTargetSelection,
  options: { agent?: NativeHookProvider; sessionId?: string; executionId?: string; profile?: string; accountHash?: string } = {}
): ExecutionOriginPreflight {
  const agent: NativeHookProvider = resolveTargetAgent(store, root, target, options)
  const binding = inspectBindingState(root, target, agent)
  const readiness = nativeHookReadiness(store.registry, root, target, unknownNativeTrust('CLIENT_TRUST_UNSUPPORTED'), agent, options.profile ? { profile: options.profile } : undefined)
  const installation = { state: readiness.installation.state, reasonCode: readiness.installation.reasonCode }
  const installBroken = installation.state !== 'CONFIGURED' && installation.state !== 'UNKNOWN'
  const unavailableReason = installBroken
    ? installation.reasonCode
    : binding.state === 'DISABLED' ? 'BINDING_DISABLED'
    : binding.state === 'STALE_GENERATION' ? 'STALE_GENERATION'
    : binding.state === 'INVALID' ? 'INVALID_BINDING'
    : undefined

  const targetSessions = store.registry.queryNativeSessions(
    { worktreeId: target.worktreeId, generation: target.generation, ...(options.agent ? { agent: options.agent } : {}) },
    options.accountHash
  )
  const captureStatus: ExecutionOriginPreflight['captureStatus'] =
    binding.state === 'DISABLED' ? 'BINDING_DISABLED'
    : binding.state === 'STALE_GENERATION' ? 'STALE_GENERATION'
    : installBroken || binding.state === 'INVALID' ? 'UNAVAILABLE'
    : binding.pendingSpoolCount > 0 ? 'INGESTION_PENDING'
    : targetSessions.rows.length > 0 ? 'CAPTURE_OBSERVED'
    : binding.state === 'MISSING' ? 'BINDING_MISSING'
    : 'PENDING_FIRST_SESSION'

  if (options.sessionId || options.executionId) {
    const observed = new Map<string, SessionTargetSelection>()
    if (options.sessionId) addWorktrees(observed, collectSessionWorktrees(store, options.sessionId, options.accountHash))
    if (options.executionId) addWorktrees(observed, collectExecutionWorktrees(store, options.executionId, options.accountHash))
    const origin = classifyObservedWorktrees([...observed.values()], target, binding, unavailableReason)
    return {
      worktreeId: target.worktreeId,
      generation: target.generation,
      agent,
      captureStatus,
      ready: origin.state === 'ALIGNED' && !unavailableReason,
      binding,
      installation,
      origin
    }
  }

  if (unavailableReason) {
    return {
      worktreeId: target.worktreeId,
      generation: target.generation,
      agent,
      captureStatus,
      ready: false,
      binding,
      installation,
      origin: {
        state: 'UNAVAILABLE',
        reason: unavailableReason,
        observedOnTarget: targetSessions.rows.length > 0,
        observedWorktrees: targetSessions.rows.length > 0 ? [{ worktreeId: target.worktreeId, generation: target.generation }] : [],
        recommendedAction: 'REPAIR_NATIVE_CAPTURE_BEFORE_EXECUTION'
      }
    }
  }

  if (targetSessions.rows.length > 0) {
    return {
      worktreeId: target.worktreeId,
      generation: target.generation,
      agent,
      captureStatus,
      ready: true,
      binding,
      installation,
      origin: {
        state: 'TARGET_SESSION_OBSERVED',
        reason: 'TARGET_CAPTURE_OBSERVED',
        observedOnTarget: true,
        observedWorktrees: [{ worktreeId: target.worktreeId, generation: target.generation }]
      }
    }
  }

  return {
    worktreeId: target.worktreeId,
    generation: target.generation,
    agent,
    captureStatus,
    ready: false,
    binding,
    installation,
    origin: {
      state: 'UNKNOWN',
      reason: captureStatus === 'INGESTION_PENDING'
        ? 'INGESTION_PENDING'
        : binding.state === 'MISSING'
          ? 'BINDING_MISSING_BEFORE_FIRST_SESSION'
          : 'PENDING_FIRST_SESSION',
      observedOnTarget: false,
      observedWorktrees: [],
      recommendedAction: captureStatus === 'INGESTION_PENDING'
        ? 'RETRY_CAPTURE_HEALTH_RECHECK'
        : 'START_FRESH_SESSION_IN_TARGET_WORKTREE'
    }
  }
}
