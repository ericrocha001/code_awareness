import { parentPort, workerData } from 'node:worker_threads'
import { SessionStore, sessionStorePath } from './store'
import { EntireProvider, runReadOnly } from './entire-provider'
import { executeSessionTool, type SessionToolName } from './mcp'
import { sourceFingerprint, type SessionTargetSelection } from './target'

const { storageBase, repositoryId, root, cancellation } = workerData as { storageBase: string; repositoryId: string; root: string; cancellation: SharedArrayBuffer }
const cancelled = new Int32Array(cancellation)
const abort = new AbortController()
const assertActive = () => { if (Atomics.load(cancelled, 0)) throw new Error('PROJECT_CONTEXT_CHANGED') }
const store = new SessionStore(sessionStorePath(storageBase, repositoryId), repositoryId)
const provider = new EntireProvider(store, root, assertActive, (exe, args, cwd, limit, consume, timeout) => runReadOnly(exe, args, cwd, limit, consume, timeout, abort.signal))
let pending = 0, closing = false
let validationId = 0
const validations = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
const validateTarget = (id: number) => new Promise<void>((resolve, reject) => {
  const validation = ++validationId
  validations.set(validation, { resolve, reject })
  parentPort?.postMessage({ id, validate: validation })
})
const close = () => { if (closing && !pending) { store.close(); parentPort?.close() } }
parentPort?.on('message', async (message: { id: number; name: SessionToolName; args: unknown; target?: { root: string; fingerprint: string; selection: SessionTargetSelection } } | { close: true } | { validation: number; code?: string }) => {
  if ('validation' in message) {
    const entry = validations.get(message.validation); validations.delete(message.validation)
    if (message.code) entry?.reject(new Error(message.code)); else entry?.resolve()
    return
  }
  if ('close' in message) { closing = true; abort.abort(); close(); return }
  pending++
  try {
    const target = message.target
    const assertRequest = () => {
      assertActive()
      if (target) {
        try { if (sourceFingerprint(target.root) !== target.fingerprint) throw new Error() }
        catch { throw new Error('WORKTREE_STALE') }
      }
    }
    const selectedProvider = target ? new EntireProvider(store, target.root, assertRequest,
      (exe, args, cwd, limit, consume, timeout) => runReadOnly(exe, args, cwd, limit, consume, timeout, abort.signal), () => validateTarget(message.id)) : provider
    parentPort?.postMessage({ id: message.id, result: await executeSessionTool(store, selectedProvider, message.name, message.args, assertRequest, target?.selection) })
  }
  finally { pending--; close() }
})
