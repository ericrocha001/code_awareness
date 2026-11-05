import { parentPort, workerData } from 'node:worker_threads'
import { SessionStore, sessionStorePath } from './store'
import { EntireProvider, runReadOnly } from './entire-provider'
import { executeSessionTool, executeLiveSessionTool, type SessionToolName } from './mcp'
import { isLiveSessionTool } from './entire-live'
import { sourceFingerprint, type SessionTargetSelection, type LiveSessionTarget } from './target'
import type { RegistryBatch, RegistryReader } from './checkpoint-registry'
import { join } from 'node:path'
import { readNativeBinding } from './native-hooks'
import { ingestNativeHooks } from './native-hook-ingestion'
import { correlateNativeGit } from './native-git-correlation'
import { correlateNativeArtifact } from './native-artifact-correlation'
import type { PublicationProvenancePort, PublicationReceipt, PublicationAssociationResult } from '../../shared/types/publication-provenance-types'
import { GitService } from '../core/git-service'

const { storageBase, repositoryId, root, cancellation } = workerData as { storageBase: string; repositoryId: string; root: string; cancellation: SharedArrayBuffer }
const cancelled = new Int32Array(cancellation)
const abort = new AbortController()
const assertActive = () => { if (Atomics.load(cancelled, 0)) throw new Error('PROJECT_CONTEXT_CHANGED') }
const storeIdentity = { path: sessionStorePath(storageBase, repositoryId), repositoryId }
let store: SessionStore | undefined
let pending = 0, closing = false
let nativeIngesting = false
let validationId = 0
type ResolvedTarget = { root: string; fingerprint: string; selection: SessionTargetSelection }
const validations = new Map<number, { resolve: (target?: ResolvedTarget) => void; reject: (error: Error) => void }>()
const registryReads = new Map<number, { resolve: (batches: RegistryBatch[]) => void; reject: (error: Error) => void }>()
const publicationReads = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
const validateTarget = (id: number, sourceSelection?: SessionTargetSelection) => new Promise<ResolvedTarget | undefined>((resolve, reject) => {
  assertActive()
  const validation = ++validationId
  validations.set(validation, { resolve, reject })
  parentPort?.postMessage({ id, validate: validation, ...(sourceSelection ? { sourceSelection } : {}) })
})
const close = () => { if (closing && !pending) { store?.close(); parentPort?.close() } }
parentPort?.on('message', async (message: { id: number; name: SessionToolName; args: unknown; deadline: number; nativeTargets?: LiveSessionTarget[]; liveTargets?: LiveSessionTarget[]; target?: ResolvedTarget } | { close: true } | { validation: number; code?: string; target?: ResolvedTarget } | { registryResult: number; batches: RegistryBatch[]; code?: string } | { publicationResult: number; result?: unknown; code?: string }) => {
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
  try {
    let target = message.target
    const assertRequest = () => {
      assertActive()
      if (Date.now() >= message.deadline) throw new Error('SESSION_CONTEXT_TIMEOUT')
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
    const requestStore = isLiveSessionTool(message.name) ? storeIdentity : (store ??= new SessionStore(storeIdentity.path, repositoryId))
    const publication = <T>(request: object): Promise<T> => new Promise((resolve, reject) => {
      assertRequest()
      const token = ++validationId
      publicationReads.set(token, { resolve: value => resolve(value as T), reject })
      parentPort?.postMessage({ id: message.id, publication: { token, ...request } })
    })
    const publicationPort: PublicationProvenancePort = {
      readReceipt: receiptId => publication<PublicationReceipt | null>({ action: 'read', receiptId }),
      associate: association => publication<PublicationAssociationResult>({ action: 'associate', association }),
      invalidate: (invocationId, state) => publication<void>({ action: 'invalidate', invocationId, state })
    }
    if (store && message.nativeTargets?.length && !nativeIngesting) {
      nativeIngesting = true
      try {
      for (const nativeTarget of message.nativeTargets) {
        try {
          const binding = readNativeBinding(join(nativeTarget.root, '.code-awareness/native-hooks/binding.json'))
          if (binding.repositoryId !== repositoryId || binding.worktreeId !== nativeTarget.worktreeId || binding.generation !== nativeTarget.generation) throw new Error('WORKTREE_STALE')
          await ingestNativeHooks(store.registry, binding, async selection => {
            const resolved = await validateTarget(message.id, selection)
            if (!resolved) throw new Error('WORKTREE_STALE')
            return { ...resolved, validate: async () => { await validateTarget(message.id, selection); assertRequest() } }
          }, assertRequest, Date.now(), async event => {
            if (event.git && event.invocationId) await correlateNativeGit(store!.registry, binding, event.invocationId, new GitService(), assertRequest)
            if (event.artifact && event.invocationId) await correlateNativeArtifact(store!.registry, binding, event.invocationId, publicationPort, assertRequest)
          })
          const scan = 'NATIVE_ARTIFACT_SCAN:' + binding.worktreeId
          const previous = store.registry.source(scan)
          const candidates = store.registry.nativeArtifactCandidates(binding.worktreeId, binding.generation, previous?.cursor)
          for (const key of candidates) {
            const invocationId = store.registry.invocationFromKey(key)
            if (store.registry.source('NATIVE_ARTIFACT:' + invocationId)?.status !== 'COMPLETE') await correlateNativeArtifact(store.registry, binding, invocationId, publicationPort, assertRequest)
          }
          store.registry.apply({ repositoryId, source: scan, revision: String(Date.now()), status: candidates.length === 32 ? 'PARTIAL' : 'COMPLETE', cursor: candidates.length === 32 ? candidates.at(-1) : '', edges: [] }, previous?.revision, assertRequest)
        } catch {
          assertRequest()
          const previous = store.registry.source('NATIVE_HOOK')
          store.registry.apply({ repositoryId, source: 'NATIVE_HOOK', revision: previous?.revision ?? 'unavailable', status: 'PARTIAL', edges: [] }, previous?.revision, assertRequest)
        }
      }
      } finally { nativeIngesting = false }
    }
    if (message.name === 'read_agent_session_event' && store && message.args && typeof message.args === 'object' && 'sessionId' in message.args && typeof message.args.sessionId === 'string') {
      const selection = store.references.source(message.args.sessionId)?.locator.target
      if (selection) {
        target = await validateTarget(message.id, selection)
        if (!target || target.selection.worktreeId !== selection.worktreeId || target.selection.generation !== selection.generation) throw new Error('WORKTREE_STALE')
        assertRequest()
      }
    }
    const readRegistry: RegistryReader = request => new Promise((resolve, reject) => {
      assertRequest()
      const token = ++validationId
      registryReads.set(token, { resolve, reject })
      parentPort?.postMessage({ id: message.id, registryRead: { token, request } })
    })
    const provider = new EntireProvider(requestStore, target?.root ?? root, assertRequest,
      (exe, args, cwd, limit, consume, timeout) => runReadOnly(exe, args, cwd, limit, consume, timeout, abort.signal),
      target || message.liveTargets ? async () => { await validateTarget(message.id) } : async () => {},
      phase => { if (!closing) parentPort?.postMessage({ id: message.id, phase }) }, target?.selection)
    const result = isLiveSessionTool(message.name)
      ? await executeLiveSessionTool(provider, message.name, message.args, assertRequest, message.liveTargets ?? [])
      : await executeSessionTool(
          store!,
          provider,
          message.name,
          message.args,
          assertRequest,
          target?.selection,
          message.liveTargets ?? [],
          (exe, args, cwd, limit, consume, timeout) => runReadOnly(exe, args, cwd, limit, consume, timeout, abort.signal),
          target?.root ?? root,
          undefined,
          readRegistry
        )
    if (!closing && !Atomics.load(cancelled, 0)) parentPort?.postMessage({ id: message.id, result })
  } catch (error) {
    if (!closing && !Atomics.load(cancelled, 0)) parentPort?.postMessage({ id: message.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'SESSION_CONTEXT_UNAVAILABLE' }) }] } })
  }
  finally { pending--; close() }
})
