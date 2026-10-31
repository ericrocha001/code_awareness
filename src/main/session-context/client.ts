import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { McpToolResult } from '../mcp/mcp-types'
import type { SessionContextPort, SessionToolName } from './mcp'
import { parseSessionRefresh } from './mcp'
import type { SessionTargetResolver } from './target'

const failure = (code: string, phase?: string): McpToolResult => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code, ...(phase ? { phase } : {}) }) }] })
interface Generation { worker: Worker; cancellation: Int32Array; closing: boolean }
interface Request {
  resolve: (result: McpToolResult) => void
  timer: NodeJS.Timeout
  deadline: number
  generation?: Generation
  validate?: () => Promise<void>
  phase: string
}
export class SessionContextClient implements SessionContextPort {
  private generation?: Generation
  private terminal = false
  private retiring: Promise<void> = Promise.resolve()
  private serial = 0
  private pending = new Map<number, Request>()
  private refresh?: { key: string; task: Promise<McpToolResult> }
  constructor(private readonly storageBase: string, private readonly repositoryId: string, private readonly root: string, private readonly isCurrent: () => boolean,
    private readonly workerPath = join(__dirname, 'session-context-worker.js'), private readonly resolveTarget?: SessionTargetResolver,
    private readonly timeoutMs?: number) {}
  private active(): boolean {
    if (!this.isCurrent()) void this.dispose()
    return !this.terminal
  }
  call(name: SessionToolName, args: unknown): Promise<McpToolResult> {
    if (!this.active()) return Promise.resolve(failure('PROJECT_CONTEXT_CHANGED'))
    if (Buffer.byteLength(JSON.stringify(args ?? {})) > 8192) return Promise.resolve(failure('INVALID_ARGUMENT'))
    if (name === 'refresh_agent_sessions') {
      try { parseSessionRefresh(args) } catch { return Promise.resolve(failure('INVALID_ARGUMENT')) }
    }
    const key = JSON.stringify(args ?? {})
    if (name === 'refresh_agent_sessions' && this.refresh) return this.refresh.key === key ? this.refresh.task : Promise.resolve(failure('BACKPRESSURE'))
    const task = this.dispatch(name, args)
    if (name === 'refresh_agent_sessions') {
      const refresh = { key, task }
      this.refresh = refresh
      void task.finally(() => { if (this.refresh === refresh) this.refresh = undefined })
    }
    return task
  }
  private finish(id: number, result: McpToolResult): void {
    const request = this.pending.get(id)
    if (!request) return
    this.pending.delete(id)
    clearTimeout(request.timer)
    request.resolve(result)
  }
  private createGeneration(): Generation {
    const cancellation = new Int32Array(new SharedArrayBuffer(4))
    const worker = new Worker(this.workerPath, { workerData: { storageBase: this.storageBase, repositoryId: this.repositoryId, root: this.root, cancellation: cancellation.buffer }, resourceLimits: { maxOldGenerationSizeMb: 128 } })
    const generation = { worker, cancellation, closing: false }
    this.generation = generation
    worker.on('message', async (message: { id: number; result?: McpToolResult; validate?: number; phase?: string }) => {
      if (generation !== this.generation || generation.closing) return
      const request = this.pending.get(message.id)
      if (!request || request.generation !== generation) return
      if (!this.active()) return
      if (Date.now() >= request.deadline) { this.expire(message.id); return }
      if (message.phase) {
        if (/^[a-z-]{1,40}$/.test(message.phase)) request.phase = message.phase
        return
      }
      if (message.validate !== undefined) {
        let code: string | undefined
        try {
          if (!request.validate) throw new Error('WORKTREE_STALE')
          await request.validate()
        } catch (error) { code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'WORKTREE_STALE' }
        if (generation !== this.generation || generation.closing || !this.pending.has(message.id) || !this.active()) return
        if (Date.now() >= request.deadline) { this.expire(message.id); return }
        worker.postMessage({ validation: message.validate, code })
        return
      }
      if (message.result) this.finish(message.id, message.result)
    })
    worker.on('error', () => { void this.retire(generation, 'SESSION_CONTEXT_UNAVAILABLE') })
    worker.on('exit', () => { if (!generation.closing) void this.retire(generation, 'SESSION_CONTEXT_UNAVAILABLE', true) })
    return generation
  }
  private expire(id: number): void {
    const request = this.pending.get(id)
    if (!request) return
    if (request.generation) void this.retire(request.generation, 'SESSION_CONTEXT_TIMEOUT')
    else this.finish(id, failure('SESSION_CONTEXT_TIMEOUT', request.phase))
  }
  private retire(generation: Generation, code: string, exited = false): Promise<void> {
    if (generation.closing) return this.retiring
    generation.closing = true
    Atomics.store(generation.cancellation, 0, 1)
    if (this.generation === generation) this.generation = undefined
    this.retiring = exited ? Promise.resolve() : new Promise<void>(resolve => {
      const timer = setTimeout(() => { void generation.worker.terminate() }, 1500)
      timer.unref()
      generation.worker.once('exit', () => { clearTimeout(timer); resolve() })
      try { generation.worker.postMessage({ close: true }) } catch { void generation.worker.terminate() }
    })
    for (const [id, request] of this.pending) {
      if (request.generation === generation) this.finish(id, failure(code, request.phase))
    }
    return this.retiring
  }
  private dispatch(name: SessionToolName, args: unknown): Promise<McpToolResult> {
    if (this.pending.size >= 16) return Promise.resolve(failure('BACKPRESSURE'))
    const id = ++this.serial
    return new Promise<McpToolResult>(resolve => {
      const timeoutMs = this.timeoutMs ?? (name === 'refresh_agent_sessions' ? (parseSessionRefresh(args).sessionId ? 14_000 : 12_000) : 5000)
      const deadline = Date.now() + timeoutMs
      const request: Request = { resolve, deadline, phase: 'worker-recovery', timer: setTimeout(() => this.expire(id), timeoutMs) }
      this.pending.set(id, request)
      void (async () => {
        try {
          await this.retiring
          if (!this.pending.has(id) || !this.active()) return
          let target
          if (name === 'refresh_agent_sessions') {
            let q
            try { q = parseSessionRefresh(args) } catch { throw new Error('INVALID_ARGUMENT') }
            if (q.worktreeId) {
              if (!this.resolveTarget) throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
              request.phase = 'target-resolution'
              const selection = { worktreeId: q.worktreeId, generation: q.generation! }
              target = { ...await this.resolveTarget(selection), selection }
              request.validate = target.validate
            }
          }
          if (!this.pending.has(id) || !this.active()) return
          if (Date.now() >= deadline) { this.expire(id); return }
          request.phase = 'worker-dispatch'
          request.generation = this.generation ?? this.createGeneration()
          request.generation.worker.postMessage({ id, name, args, deadline, ...(target ? { target: { root: target.root, fingerprint: target.fingerprint, selection: target.selection } } : {}) })
        } catch (error) {
          this.finish(id, failure(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'SESSION_CONTEXT_UNAVAILABLE'))
        }
      })()
    })
  }
  dispose(code = 'PROJECT_CONTEXT_CHANGED'): Promise<void> {
    this.terminal = true
    if (this.generation) void this.retire(this.generation, code)
    for (const id of this.pending.keys()) this.finish(id, failure(code))
    return this.retiring
  }
}
