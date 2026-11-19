import type { NativeTrustSnapshot } from './native-hook-preflight'
import { parentPort, workerData } from 'node:worker_threads'
import { SessionStore, sessionStorePath } from './store'
import { EntireProvider, runReadOnly, type CommandRunner } from './entire-provider'
import { executeSessionTool, executeLiveSessionTool, parseCaptureHealth, type SessionToolName } from './mcp'
import { nativeCaptureAgent } from './capture-health'
import { isLiveSessionTool } from './entire-live'
import { sourceFingerprint, type SessionTargetSelection, type LiveSessionTarget } from './target'
import type { RegistryBatch, RegistryReader } from './checkpoint-registry'
import { existsSync } from 'node:fs'
import { hasNativeBindingFile, nativeBindingPath, nativeHookProviders, readNativeBinding, spoolEventFiles, type NativeHookProvider } from './native-hooks'
import { ingestNativeHooks } from './native-hook-ingestion'
import { correlateNativeGit } from './native-git-correlation'
import { nativeInvocationWindow } from './native-capture-window'
import { correlateNativeArtifact } from './native-artifact-correlation'
import type { PublicationProvenancePort, PublicationReceipt, PublicationAssociationResult } from '../../shared/types/publication-provenance-types'
import { GitService } from '../core/git-service'

const { storageBase, repositoryId, root, cancellation, readOnlyStore } = workerData as { storageBase: string; repositoryId: string; root: string; cancellation: SharedArrayBuffer; readOnlyStore?: boolean }
const cancelled = new Int32Array(cancellation)
const abort = new AbortController()
const assertActive = () => { if (Atomics.load(cancelled, 0)) throw new Error('PROJECT_CONTEXT_CHANGED') }
const storeIdentity = { path: sessionStorePath(storageBase, repositoryId), repositoryId }
let store: SessionStore | undefined
let pending = 0, closing = false
let nativeIngesting = false
let validationId = 0
type ResolvedTarget = { root: string; fingerprint: string; selection: SessionTargetSelection }
type PendingIpc<T> = { requestId: number; resolve: (value: T) => void; reject: (error: Error) => void }
type ActiveRequest = { abort: AbortController; cancelled: boolean; deadline: number }
export interface NativeIngestionTargetReport {
  worktreeId: string
  generation: string
  remainingSpool: boolean
  remainingScan?: boolean
  progressed: boolean
  errorCode?: string
  settledSpools?: { spool: string; filesKey: string }[]
}
const activeRequests = new Map<number, ActiveRequest>()
const validations = new Map<number, PendingIpc<ResolvedTarget | undefined>>()
const registryReads = new Map<number, PendingIpc<RegistryBatch[]>>()
const publicationReads = new Map<number, PendingIpc<unknown>>()
const validateTarget = (id: number, sourceSelection?: SessionTargetSelection) => new Promise<ResolvedTarget | undefined>((resolve, reject) => {
  assertActive()
  if (activeRequests.get(id)?.cancelled) { reject(new Error('SESSION_CONTEXT_TIMEOUT')); return }
  const validation = ++validationId
  validations.set(validation, { requestId: id, resolve, reject })
  parentPort?.postMessage({ id, validate: validation, ...(sourceSelection ? { sourceSelection } : {}) })
})
const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve))
const close = () => { if (closing && !pending) { store?.close(); parentPort?.close() } }
parentPort?.on('message', async (message: { id: number; name: SessionToolName; args: unknown; deadline: number; allowArtifactMetadata?: boolean; nativeTargets?: LiveSessionTarget[]; nativeMode?: 'FOCAL' | 'MAINTENANCE' | 'FULL'; nativeAgent?: NativeHookProvider; nativeBudgetMs?: number; hasMoreNativeTargets?: boolean; nativeTrust?: NativeTrustSnapshot; liveTargets?: LiveSessionTarget[]; target?: ResolvedTarget } | { cancel: number } | { close: true } | { validation: number; code?: string; target?: ResolvedTarget } | { registryResult: number; batches: RegistryBatch[]; code?: string } | { publicationResult: number; result?: unknown; code?: string }) => {
  if ('cancel' in message) {
    const req = activeRequests.get(message.cancel)
    if (req) {
      req.cancelled = true
      req.abort.abort()
    }
    for (const [token, entry] of validations) if (entry.requestId === message.cancel) { validations.delete(token); entry.reject(new Error('SESSION_CONTEXT_TIMEOUT')) }
    for (const [token, entry] of registryReads) if (entry.requestId === message.cancel) { registryReads.delete(token); entry.reject(new Error('SESSION_CONTEXT_TIMEOUT')) }
    for (const [token, entry] of publicationReads) if (entry.requestId === message.cancel) { publicationReads.delete(token); entry.reject(new Error('SESSION_CONTEXT_TIMEOUT')) }
    return
  }
  if ('publicationResult' in message) {
    const entry = publicationReads.get(message.publicationResult); publicationReads.delete(message.publicationResult)
    if (message.code) entry?.reject(new Error(message.code)); else entry?.resolve(message.result)
    return
  }
  if ('registryResult' in message) {
    const entry = registryReads.get(message.registryResult); registryReads.delete(message.registryResult)
    if (message.code) entry?.reject(new Error(message.code)); else entry?.resolve(message.batches)
    return
  }
  if ('validation' in message) {
    const entry = validations.get(message.validation); validations.delete(message.validation)
    if (message.code) entry?.reject(new Error(message.code)); else entry?.resolve(message.target)
    return
  }
  if ('close' in message) {
    closing = true
    Atomics.store(cancelled, 0, 1)
    abort.abort()
    for (const req of activeRequests.values()) { req.cancelled = true; req.abort.abort() }
    for (const entry of validations.values()) entry.reject(new Error('PROJECT_CONTEXT_CHANGED'))
    validations.clear()
    for (const entry of registryReads.values()) entry.reject(new Error('PROJECT_CONTEXT_CHANGED'))
    registryReads.clear()
    for (const entry of publicationReads.values()) entry.reject(new Error('PROJECT_CONTEXT_CHANGED'))
    publicationReads.clear()
    close()
    return
  }
  if (closing) return
  pending++
  const reqState: ActiveRequest = { abort: new AbortController(), cancelled: false, deadline: message.deadline }
  activeRequests.set(message.id, reqState)
  const onGlobalAbort = () => reqState.abort.abort()
  abort.signal.addEventListener('abort', onGlobalAbort, { once: true })
  try {
    let target = message.target
    const assertRequest = () => {
      assertActive()
      if (reqState.cancelled || Date.now() >= message.deadline) throw new Error('SESSION_CONTEXT_TIMEOUT')
      if (target) {
        try { if (sourceFingerprint(target.root) !== target.fingerprint) throw new Error() }
        catch { throw new Error('WORKTREE_STALE') }
      }
      if (message.liveTargets) {
        for (const t of message.liveTargets) {
          try { if (sourceFingerprint(t.root) !== t.fingerprint) throw new Error() } catch { throw new Error('WORKTREE_STALE') }
        }
      }
    }
    const runScoped: CommandRunner = (exe, args, cwd, limit, consume, timeout, signal) =>
      runReadOnly(exe, args, cwd, limit, consume, timeout, signal ?? reqState.abort.signal)
    parentPort?.postMessage({ id: message.id, phase: isLiveSessionTool(message.name) ? 'live-metadata' : 'store-open' })
    const requestStore = isLiveSessionTool(message.name) ? storeIdentity : (store ??= new SessionStore(storeIdentity.path, repositoryId, readOnlyStore))
    const publication = <T>(request: object): Promise<T> => new Promise((resolve, reject) => {
      assertRequest()
      const token = ++validationId
      publicationReads.set(token, { requestId: message.id, resolve: value => resolve(value as T), reject })
      parentPort?.postMessage({ id: message.id, publication: { token, ...request } })
    })
    const publicationPort: PublicationProvenancePort = {
      readReceipt: receiptId => publication<PublicationReceipt | null>({ action: 'read', receiptId }),
      associate: association => publication<PublicationAssociationResult>({ action: 'associate', association }),
      invalidate: (invocationId, state) => publication<void>({ action: 'invalidate', invocationId, state })
    }
    const health = message.name === 'inspect_capture_health' ? parseCaptureHealth(message.args) : undefined
    const nativeAgent = message.nativeAgent ?? (health?.source === 'native' ? nativeCaptureAgent(health) : undefined)
    const nativeMode = message.nativeMode ?? 'FULL'
    const nativeDeadline = message.nativeBudgetMs !== undefined
      ? Math.min(message.deadline - 500, Date.now() + message.nativeBudgetMs)
      : message.deadline
    const nativeReports: NativeIngestionTargetReport[] = []
    let nativeCatchUp: { state: 'OBSERVED' | 'PARTIAL' | 'PENDING'; pending: boolean; deferred?: boolean; reason?: string } | undefined
    let remainingNativeBacklog = !!message.hasMoreNativeTargets
    if (store && message.nativeTargets?.length && (!nativeIngesting || nativeMode === 'FULL')) {
      if (nativeMode === 'FOCAL' && nativeIngesting) {
        nativeCatchUp = { state: 'PARTIAL', pending: true, deferred: true, reason: 'INGESTION_IN_PROGRESS' }
      } else {
        parentPort?.postMessage({ id: message.id, phase: 'native-ingestion' })
        nativeIngesting = true
        try {
          for (let idx = 0; idx < message.nativeTargets.length; idx++) {
            const nativeTarget = message.nativeTargets[idx]
            if (idx > 0) await yieldToEventLoop()
            assertRequest()
            if (nativeMode !== 'FULL' && Date.now() >= nativeDeadline) {
              remainingNativeBacklog = true
              nativeCatchUp = { state: 'PARTIAL', pending: true, deferred: true, reason: 'INGESTION_BUDGET_REACHED' }
              break
            }
            const candidates = (nativeAgent ? [nativeAgent] : nativeHookProviders)
              .map(agent => nativeBindingPath(nativeTarget.root, agent))
              .filter(path => existsSync(path))
            if (!candidates.length) {
              nativeReports.push({ worktreeId: nativeTarget.worktreeId, generation: nativeTarget.generation, remainingSpool: false, progressed: false })
              continue
            }
            let targetPending = false
            let targetProgressed = false
            let targetRemainingScan = false
            let targetErrorCode: string | undefined
            const targetSettledSpools: { spool: string; filesKey: string }[] = []
            for (const bindingFile of candidates) {
              try {
                const binding = readNativeBinding(bindingFile)
                if (binding.repositoryId !== repositoryId || binding.worktreeId !== nativeTarget.worktreeId || binding.generation !== nativeTarget.generation ||
                  nativeAgent && (binding.provider ?? 'codex') !== nativeAgent) throw new Error('WORKTREE_STALE')
                const observed = new Map<string, { git: boolean; artifact: boolean }>()
                let validatedRoot: { root: string; fingerprint: string; at: number } | undefined
                const receipt = await ingestNativeHooks(store.registry, binding, async selection => {
                  const resolved = await validateTarget(message.id, selection)
                  if (!resolved) throw new Error('WORKTREE_STALE')
                  validatedRoot = { root: resolved.root, fingerprint: resolved.fingerprint, at: Date.now() }
                  return {
                    ...resolved,
                    validate: async () => {
                      assertRequest()
                      if (validatedRoot && sourceFingerprint(validatedRoot.root) !== validatedRoot.fingerprint) throw new Error('WORKTREE_STALE')
                      if (!validatedRoot || Date.now() - validatedRoot.at >= 250) {
                        await validateTarget(message.id, selection)
                        if (validatedRoot) validatedRoot.at = Date.now()
                      }
                      assertRequest()
                    }
                  }
                }, assertRequest, Date.now(), async event => {
                  if (event.invocationId && (event.git || event.artifact)) observed.set(event.invocationId, { git: !!event.git, artifact: !!event.artifact })
                }, {
                  maxEvents: nativeMode === 'MAINTENANCE' ? 128 : 32,
                  ...(nativeMode !== 'FULL' ? { deadlineMs: nativeDeadline, shouldStop: () => reqState.cancelled || Date.now() >= nativeDeadline } : {})
                })
                if (receipt.ingested > 0 || receipt.expired > 0) targetProgressed = true
                if (receipt.pending) {
                  targetPending = true
                  remainingNativeBacklog = true
                } else if (!receipt.deferredByBudget) {
                  const leftover = spoolEventFiles(binding.spool)
                  if (leftover.length > 0) targetSettledSpools.push({ spool: binding.spool, filesKey: leftover.join('\0') })
                }
                if (receipt.deferredByBudget) {
                  nativeCatchUp = { state: 'PARTIAL', pending: true, deferred: true, reason: 'INGESTION_BUDGET_REACHED' }
                } else if (receipt.pending) {
                  nativeCatchUp ??= { state: 'PARTIAL', pending: true, reason: 'INGESTION_PENDING' }
                } else if (receipt.rejected > 0 && !nativeCatchUp) {
                  nativeCatchUp = { state: 'PARTIAL', pending: false, reason: 'CAPTURE_PARTIAL' }
                } else if (receipt.ingested > 0 && !nativeCatchUp) {
                  nativeCatchUp = { state: 'OBSERVED', pending: false }
                }
                if (nativeMode === 'FOCAL' && targetProgressed && (binding.provider ?? 'codex') === 'codex') {
                  targetRemainingScan = true
                }
                if (nativeMode !== 'FOCAL' && (binding.provider ?? 'codex') === 'codex') {
                  const scanLimit = nativeMode === 'MAINTENANCE' ? 4 : 32
                  for (const [invocation, kinds] of observed) {
                    if (nativeMode === 'MAINTENANCE' && Date.now() >= nativeDeadline) { remainingNativeBacklog = true; targetRemainingScan = true; break }
                    if (kinds.git) await correlateNativeGit(store.registry, binding, invocation, new GitService(), assertRequest)
                    if (kinds.artifact) await correlateNativeArtifact(store.registry, binding, invocation, publicationPort, assertRequest)
                    targetProgressed = true
                  }
                  for (const kind of ['ARTIFACT', 'GIT'] as const) {
                    if (nativeMode === 'MAINTENANCE' && Date.now() >= nativeDeadline) { remainingNativeBacklog = true; targetRemainingScan = true; break }
                    const scan = `NATIVE_${kind}_SCAN:${binding.worktreeId}:${binding.generation}`
                    const previous = store.registry.source(scan)
                    const keys = store.registry.nativeCorrelationCandidates(kind, binding.worktreeId, binding.generation, previous?.cursor, scanLimit)
                    let processedKeys = 0
                    for (const key of keys) {
                      if (nativeMode === 'MAINTENANCE' && Date.now() >= nativeDeadline) { remainingNativeBacklog = true; targetRemainingScan = true; break }
                      processedKeys++
                      const invocationId = store.registry.invocationFromKey(key)
                      if (observed.has(invocationId)) continue
                      const session = store.registry.directEvidence({ kind: 'EXECUTION', id: 'native-invocation:' + invocationId }, `NATIVE_${kind}_REQUEST`).find(edge => edge.relation === 'PreToolUse')?.to
                      const current = session && nativeInvocationWindow(store.registry, binding, { kind: 'EXECUTION', id: 'native-invocation:' + invocationId }, session) === 'VERIFIED'
                      if (store.registry.source(`NATIVE_${kind}:` + invocationId)?.status !== 'COMPLETE' || !current) {
                        if (kind === 'ARTIFACT') await correlateNativeArtifact(store.registry, binding, invocationId, publicationPort, assertRequest)
                        else await correlateNativeGit(store.registry, binding, invocationId, new GitService(), assertRequest)
                        targetProgressed = true
                      }
                      if (nativeMode === 'MAINTENANCE') await yieldToEventLoop()
                    }
                    const moreScan = processedKeys < keys.length || keys.length === scanLimit
                    if (moreScan) { remainingNativeBacklog = true; targetRemainingScan = true }
                    const lastKey = processedKeys > 0 ? keys[processedKeys - 1] : (previous?.cursor ?? '')
                    store.registry.apply({
                      repositoryId, source: scan, revision: String(Date.now()),
                      status: moreScan ? 'PARTIAL' : 'COMPLETE',
                      cursor: moreScan ? lastKey : '',
                      edges: []
                    }, previous?.revision, assertRequest)
                  }
                }
              } catch (error) {
                assertRequest()
                targetErrorCode = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'INGESTION_FAILED'
                if (nativeMode === 'FOCAL') {
                  nativeCatchUp = {
                    state: 'PARTIAL',
                    pending: hasNativeBindingFile(nativeTarget.root, nativeAgent),
                    reason: targetErrorCode === 'SQLITE_BUSY' ? 'STORE_BUSY' : targetErrorCode
                  }
                } else {
                  const previous = store.registry.source('NATIVE_HOOK')
                  store.registry.apply({ repositoryId, source: 'NATIVE_HOOK', revision: previous?.revision ?? 'unavailable', status: 'PARTIAL', edges: [] }, previous?.revision, assertRequest)
                }
              }
            }
            nativeReports.push({
              worktreeId: nativeTarget.worktreeId,
              generation: nativeTarget.generation,
              remainingSpool: targetPending,
              remainingScan: targetRemainingScan,
              progressed: targetProgressed,
              ...(targetErrorCode ? { errorCode: targetErrorCode } : {}),
              ...(targetSettledSpools.length ? { settledSpools: targetSettledSpools } : {})
            })
          }
        } finally { nativeIngesting = false }
      }
    } else if (store && message.nativeTargets?.length && nativeIngesting && nativeMode === 'FOCAL') {
      nativeCatchUp = { state: 'PARTIAL', pending: true, deferred: true, reason: 'INGESTION_IN_PROGRESS' }
    }
    if ((message.name === 'read_agent_session_event' || message.name === 'list_agent_session_events' &&
      message.args && typeof message.args === 'object' && 'query' in message.args) && store && message.args && typeof message.args === 'object' && 'sessionId' in message.args && typeof message.args.sessionId === 'string') {
      const selection = store.references.source(message.args.sessionId)?.locator.target
      if (selection) {
        target = await validateTarget(message.id, selection)
        if (!target || target.selection.worktreeId !== selection.worktreeId || target.selection.generation !== selection.generation) throw new Error('WORKTREE_STALE')
        assertRequest()
      }
    }
    const readRegistry: RegistryReader = request => new Promise((resolve, reject) => {
      assertRequest()
      parentPort?.postMessage({ id: message.id, phase: 'registry-source-read' })
      const token = ++validationId
      registryReads.set(token, { requestId: message.id, resolve, reject })
      parentPort?.postMessage({ id: message.id, registryRead: { token, request } })
    })
    const provider = nativeAgent ? {} : new EntireProvider(requestStore, target?.root ?? root, assertRequest,
      runScoped,
      target || message.liveTargets ? async () => { await validateTarget(message.id) } : async () => {},
      phase => { if (!closing && !reqState.cancelled) parentPort?.postMessage({ id: message.id, phase }) }, target?.selection)
    parentPort?.postMessage({ id: message.id, phase: message.name === 'discover_execution_context' ? 'registry-map' : 'session-tool' })
    let result = isLiveSessionTool(message.name)
      ? await executeLiveSessionTool(provider, message.name, message.args, assertRequest, message.liveTargets ?? [])
      : await executeSessionTool(
          store!,
          provider,
          message.name,
          message.args,
          assertRequest,
          target?.selection,
          message.liveTargets ?? [],
          runScoped,
          target?.root ?? root,
          undefined,
          readRegistry,
          undefined,
          undefined,
          message.nativeTrust,
          message.allowArtifactMetadata,
          undefined,
          nativeCatchUp
        )
    if (message.name === 'reconcile_checkpoint_registry' && !result.isError && result.content[0]?.type === 'text' && remainingNativeBacklog) {
      const payload = JSON.parse(result.content[0].text)
      if (payload && typeof payload === 'object' && payload.backlog && typeof payload.backlog === 'object') {
        payload.backlog.pending = true
        payload.backlog.drainable = true
        result = { ...result, content: [{ type: 'text', text: JSON.stringify(payload) }] }
      }
    }
    if (!closing && !reqState.cancelled && !Atomics.load(cancelled, 0)) parentPort?.postMessage({ id: message.id, result, ...(nativeReports.length ? { nativeReports } : {}) })
  } catch (error) {
    if (!closing && !reqState.cancelled && !Atomics.load(cancelled, 0)) parentPort?.postMessage({ id: message.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'SESSION_CONTEXT_UNAVAILABLE' }) }] } })
  }
  finally {
    abort.signal.removeEventListener('abort', onGlobalAbort)
    activeRequests.delete(message.id)
    pending--
    close()
  }
})
