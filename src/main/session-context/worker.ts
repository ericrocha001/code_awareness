import { parentPort, workerData } from 'node:worker_threads'
import { SessionStore, sessionStorePath } from './store'
import { EntireProvider, runReadOnly } from './entire-provider'
import { executeSessionTool, executeLiveSessionTool, type SessionToolName } from './mcp'
import { isLiveSessionTool } from './entire-live'
import { sourceFingerprint, type SessionTargetSelection, type LiveSessionTarget } from './target'

const { storageBase, repositoryId, root, cancellation } = workerData as { storageBase: string; repositoryId: string; root: string; cancellation: SharedArrayBuffer }
const cancelled = new Int32Array(cancellation)
const abort = new AbortController()
const assertActive = () => { if (Atomics.load(cancelled, 0)) throw new Error('PROJECT_CONTEXT_CHANGED') }
const storeIdentity = { path: sessionStorePath(storageBase, repositoryId), repositoryId }
let store: SessionStore | undefined
let pending = 0, closing = false
let validationId = 0
const validations = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
const validateTarget = (id: number) => new Promise<void>((resolve, reject) => {
  assertActive()
  const validation = ++validationId
  validations.set(validation, { resolve, reject })
  parentPort?.postMessage({ id, validate: validation })
})
const close = () => { if (closing && !pending) { store?.close(); parentPort?.close() } }
parentPort?.on('message', async (message: { id: number; name: SessionToolName; args: unknown; deadline: number; liveTargets?: LiveSessionTarget[]; target?: { root: string; fingerprint: string; selection: SessionTargetSelection } } | { close: true } | { validation: number; code?: string }) => {
  if ('validation' in message) {
    const entry = validations.get(message.validation); validations.delete(message.validation)
    if (message.code) entry?.reject(new Error(message.code)); else entry?.resolve()
    return
  }
  if ('close' in message) {
    closing = true
    Atomics.store(cancelled, 0, 1)
    abort.abort()
    for (const entry of validations.values()) entry.reject(new Error('PROJECT_CONTEXT_CHANGED'))
    validations.clear()
    close()
    return
  }
  if (closing) return
  pending++
  try {
    const target = message.target
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
    const provider = new EntireProvider(requestStore, target?.root ?? root, assertRequest,
      (exe, args, cwd, limit, consume, timeout) => runReadOnly(exe, args, cwd, limit, consume, timeout, abort.signal),
      target || message.liveTargets ? () => validateTarget(message.id) : async () => {},
      phase => { if (!closing) parentPort?.postMessage({ id: message.id, phase }) })
    const result = isLiveSessionTool(message.name)
      ? await executeLiveSessionTool(provider, message.name, message.args, assertRequest, message.liveTargets ?? [])
      : await executeSessionTool(store!, provider, message.name, message.args, assertRequest, target?.selection)
    if (!closing && !Atomics.load(cancelled, 0)) parentPort?.postMessage({ id: message.id, result })
  }
  finally { pending--; close() }
})
