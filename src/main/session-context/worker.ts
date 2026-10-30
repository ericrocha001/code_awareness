import { parentPort, workerData } from 'node:worker_threads'
import { SessionStore, sessionStorePath } from './store'
import { EntireProvider, runReadOnly } from './entire-provider'
import { executeSessionTool, type SessionToolName } from './mcp'

const { storageBase, repositoryId, root, cancellation } = workerData as { storageBase: string; repositoryId: string; root: string; cancellation: SharedArrayBuffer }
const cancelled = new Int32Array(cancellation)
const abort = new AbortController()
const assertActive = () => { if (Atomics.load(cancelled, 0)) throw new Error('PROJECT_CONTEXT_CHANGED') }
const store = new SessionStore(sessionStorePath(storageBase, repositoryId), repositoryId)
const provider = new EntireProvider(store, root, assertActive, (exe, args, cwd, limit, consume, timeout) => runReadOnly(exe, args, cwd, limit, consume, timeout, abort.signal))
let pending = 0, closing = false
const close = () => { if (closing && !pending) { store.close(); parentPort?.close() } }
parentPort?.on('message', async (message: { id: number; name: SessionToolName; args: unknown } | { close: true }) => {
  if ('close' in message) { closing = true; abort.abort(); close(); return }
  pending++
  try { parentPort?.postMessage({ id: message.id, result: await executeSessionTool(store, provider, message.name, message.args, assertActive) }) }
  finally { pending--; close() }
})
