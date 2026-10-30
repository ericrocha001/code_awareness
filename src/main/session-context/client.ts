import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { McpToolResult } from '../mcp/mcp-types'
import type { SessionContextPort, SessionToolName } from './mcp'

const failure = (code: string): McpToolResult => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code }) }] })
export class SessionContextClient implements SessionContextPort {
  private worker?: Worker
  private readonly cancellation = new Int32Array(new SharedArrayBuffer(4))
  private serial = 0
  private pending = new Map<number, { resolve: (result: McpToolResult) => void; timer: NodeJS.Timeout }>()
  private refresh?: { key: string; task: Promise<McpToolResult> }
  constructor(private readonly storageBase: string, private readonly repositoryId: string, private readonly root: string, private readonly isCurrent: () => boolean,
    private readonly workerPath = join(__dirname, 'session-context-worker.js')) {}
  call(name: SessionToolName, args: unknown): Promise<McpToolResult> {
    if (!this.isCurrent() || Atomics.load(this.cancellation, 0)) return Promise.resolve(failure('PROJECT_CONTEXT_CHANGED'))
    if (Buffer.byteLength(JSON.stringify(args ?? {})) > 8192) return Promise.resolve(failure('INVALID_ARGUMENT'))
    const key = JSON.stringify(args ?? {})
    if (name === 'refresh_agent_sessions' && this.refresh) return this.refresh.key === key ? this.refresh.task : Promise.resolve(failure('BACKPRESSURE'))
    if (this.pending.size >= 16) return Promise.resolve(failure('BACKPRESSURE'))
    if (!this.worker) {
      try {
        this.worker = new Worker(this.workerPath, { workerData: { storageBase: this.storageBase, repositoryId: this.repositoryId, root: this.root, cancellation: this.cancellation.buffer }, resourceLimits: { maxOldGenerationSizeMb: 128 } })
        this.worker.on('message', ({ id, result }: { id: number; result: McpToolResult }) => {
          const request = this.pending.get(id)
          if (!request) return
          this.pending.delete(id); clearTimeout(request.timer)
          request.resolve(this.isCurrent() && !Atomics.load(this.cancellation, 0) ? result : failure('PROJECT_CONTEXT_CHANGED'))
        })
        this.worker.on('error', () => this.dispose('SESSION_CONTEXT_UNAVAILABLE'))
        this.worker.on('exit', () => this.dispose('SESSION_CONTEXT_UNAVAILABLE'))
      } catch { return Promise.resolve(failure('SESSION_CONTEXT_UNAVAILABLE')) }
    }
    const id = ++this.serial
    const task = new Promise<McpToolResult>(resolve => {
      const timer = setTimeout(() => this.dispose('SESSION_CONTEXT_TIMEOUT'), 14_000)
      this.pending.set(id, { resolve, timer })
      this.worker!.postMessage({ id, name, args })
    })
    if (name === 'refresh_agent_sessions') {
      this.refresh = { key, task }
      void task.finally(() => { this.refresh = undefined })
    }
    return task
  }
  dispose(code = 'PROJECT_CONTEXT_CHANGED'): void {
    Atomics.store(this.cancellation, 0, 1)
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.resolve(failure(code)) }
    this.pending.clear()
    const worker = this.worker; this.worker = undefined
    if (worker) {
      worker.postMessage({ close: true })
      const timer = setTimeout(() => { void worker.terminate() }, 1500)
      timer.unref(); worker.once('exit', () => clearTimeout(timer))
    }
  }
}
