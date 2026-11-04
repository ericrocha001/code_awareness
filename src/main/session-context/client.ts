import { Worker } from 'node:worker_threads'
import type { RegistryReader } from './checkpoint-registry'
import { join } from 'node:path'
import type { McpToolResult } from '../mcp/mcp-types'
import type { SessionContextPort, SessionToolName } from './mcp'
import { parseSessionRefresh, parseSessionList, parseCaptureHealth } from './mcp'
import { queryCodexArchive, type AuthorizedCodexArchiveConnection } from './codex-archive'
import type { SessionTargetResolver } from './target'
import { isLiveSessionTool, parseLiveSessionQuery } from './entire-live'
import { digest } from './privacy'
import type { CodexArchiveReadiness } from '../../shared/types/codex-archive-types'

const failure = (code: string, phase?: string): McpToolResult => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code, ...(phase ? { phase } : {}) }) }] })
interface Generation { worker: Worker; cancellation: Int32Array; closing: boolean }
interface Request {
  abort?: AbortController
  resolve: (result: McpToolResult) => void
  timer: NodeJS.Timeout
  deadline: number
  generation?: Generation
  validate?: () => Promise<void>
  phase: string
}
export class SessionContextClient implements SessionContextPort {
  private archiveReadiness: CodexArchiveReadiness = { state: 'NOT_CONFIGURED' }
  private generation?: Generation
  private terminal = false
  private retiring: Promise<void> = Promise.resolve()
  private serial = 0
  private pending = new Map<number, Request>()
  private refresh?: { key: string; task: Promise<McpToolResult> }
  constructor(private readonly storageBase: string, private readonly repositoryId: string, private readonly root: string, private readonly isCurrent: () => boolean,
    private readonly workerPath = join(__dirname, 'session-context-worker.js'), private readonly resolveTarget?: SessionTargetResolver,
    private readonly timeoutMs?: number,
    private readonly authorizeAssociation?: (request: ReturnType<typeof parseSessionRefresh>) => Promise<{ sourceRevision: number; sourceHash: string }>,
    private archiveConnection?: AuthorizedCodexArchiveConnection,
    private readonly registryReader?: RegistryReader) { if (archiveConnection) this.archiveReadiness = { state: 'READY', version: archiveConnection.version } }
  setArchiveConnection(connection: AuthorizedCodexArchiveConnection | undefined, readiness: CodexArchiveReadiness): void {
    if (connection && connection.repositoryId !== this.repositoryId) throw new Error('REPOSITORY_MISMATCH')
    const changed = this.archiveConnection !== connection
    this.archiveConnection = connection; this.archiveReadiness = { ...readiness }
    if (changed) {
      if (this.generation) void this.retire(this.generation, 'ARCHIVE_CONNECTION_CHANGED')
      for (const id of this.pending.keys()) this.finish(id, failure('ARCHIVE_CONNECTION_CHANGED'))
    }
  }
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
    if (name === 'inspect_capture_health') {
      try { parseCaptureHealth(args) } catch { return Promise.resolve(failure('INVALID_ARGUMENT')) }
    }
    if (isLiveSessionTool(name)) {
      try { parseLiveSessionQuery(name, args) } catch { return Promise.resolve(failure('INVALID_ARGUMENT')) }
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
    request.abort?.abort()
    clearTimeout(request.timer)
    request.resolve(result)
  }
  private createGeneration(): Generation {
    const cancellation = new Int32Array(new SharedArrayBuffer(4))
    const worker = new Worker(this.workerPath, { workerData: { storageBase: this.storageBase, repositoryId: this.repositoryId, root: this.root, cancellation: cancellation.buffer }, resourceLimits: { maxOldGenerationSizeMb: 128 } })
    const generation = { worker, cancellation, closing: false }
    this.generation = generation
    worker.on('message', async (message: { id: number; result?: McpToolResult; validate?: number; phase?: string; registryRead?: { token: number; request: Parameters<RegistryReader>[0] } }) => {
      if (generation !== this.generation || generation.closing) return
      const request = this.pending.get(message.id)
      if (!request || request.generation !== generation) return
      if (!this.active()) return
      if (Date.now() >= request.deadline) { this.expire(message.id); return }
      if (message.phase) {
        if (/^[a-z-]{1,40}$/.test(message.phase)) request.phase = message.phase
        return
      }
      if (message.registryRead) {
        let batches: Awaited<ReturnType<RegistryReader>> = [], code: string | undefined
        try { batches = await this.registryReader?.(message.registryRead.request) ?? [] } catch { code = 'REGISTRY_SOURCE_UNAVAILABLE' }
        if (generation !== this.generation || generation.closing || !this.pending.has(message.id) || !this.active()) return
        worker.postMessage({ registryResult: message.registryRead.token, batches, code })
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
      const timeoutMs = this.timeoutMs ?? (name === 'reconcile_checkpoint_registry' || name === 'list_agent_sessions' || name === 'inspect_capture_health' ? 20_000 : isLiveSessionTool(name) ? 20_000 : name === 'refresh_agent_sessions' ? (parseSessionRefresh(args).sessionId ? 14_000 : 12_000) : (name === 'inspect_code_provenance' || name === 'inspect_entire_checkpoint') ? 12_000 : 5000)
      const deadline = Date.now() + timeoutMs
      const request: Request = { resolve, deadline, phase: 'worker-recovery', timer: setTimeout(() => this.expire(id), timeoutMs) }
      this.pending.set(id, request)
      void (async () => {
        try {
          await this.retiring
          if (!this.pending.has(id) || !this.active()) return
          let target
          let liveTargets
          let archiveObservation
          if (name === 'inspect_capture_health') {
            const query = parseCaptureHealth(args)
            if (query.worktreeId && this.resolveTarget) {
              const selection = { worktreeId: query.worktreeId, generation: query.generation! }
              target = { ...await this.resolveTarget(selection), selection }
            } else if (this.resolveTarget?.current) target = await this.resolveTarget.current()
            if (!target) throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
            request.validate = target.validate
          }
          if (name === 'list_agent_sessions') {
            let query
            try { query = parseSessionList(args) } catch { throw new Error('INVALID_ARGUMENT') }
            if (query.includeArchived && !query.cursor) {
              request.abort = new AbortController()
              if (this.resolveTarget?.current && this.archiveConnection) {
                try {
                  target = await this.resolveTarget.current()
                  request.validate = target.validate
                } catch { target = undefined }
              }
              archiveObservation = await queryCodexArchive(target ? this.archiveConnection : undefined, this.repositoryId, target?.root ?? this.root, request.abort.signal, query.archiveCursor)
              archiveObservation.providerState = this.archiveReadiness.state
              if (!target && this.archiveConnection) archiveObservation.reason = 'WORKTREE_UNAVAILABLE'
            }
          }
          if (isLiveSessionTool(name)) {
            const q = parseLiveSessionQuery(name, args)
            if (!this.resolveTarget?.discover) throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
            request.phase = 'target-resolution'
            if (q.worktreeId) {
              const selection = { worktreeId: q.worktreeId, generation: q.generation! }
              target = { ...await this.resolveTarget(selection), selection }
              request.validate = target.validate
              liveTargets = [{ ...selection, root: target.root, fingerprint: target.fingerprint }]
            } else {
              liveTargets = await this.resolveTarget.discover()
              const snapshot = liveTargets
              request.validate = async () => {
                const fresh = await this.resolveTarget!.discover!()
                if (snapshot.some(t => !fresh.some(f => f.worktreeId === t.worktreeId && f.generation === t.generation && f.root === t.root && f.fingerprint === t.fingerprint))) throw new Error('WORKTREE_STALE')
              }
            }
          }
          if (name === 'refresh_agent_sessions') {
            let q
            try { q = parseSessionRefresh(args) } catch { throw new Error('INVALID_ARGUMENT') }
            if (q.association) {
              if (!this.authorizeAssociation) throw new Error('ASSOCIATION_AUTHORITY_UNAVAILABLE')
              const source = await this.authorizeAssociation(q)
              q.association = { ...q.association, ...source }
              args = q
            }
            if (q.worktreeId) {
              if (!this.resolveTarget) throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
              request.phase = 'target-resolution'
              const selection = { worktreeId: q.worktreeId, generation: q.generation! }
              target = { ...await this.resolveTarget(selection), selection }
              request.validate = target.validate
            } else if (this.resolveTarget?.current) {
              target = await this.resolveTarget.current()
              request.validate = target.validate
            }
          }
          if ((name === 'inspect_code_provenance' || name === 'inspect_entire_checkpoint') && args && typeof args === 'object' && 'worktreeId' in args && (args as any).worktreeId) {
            const q = args as { worktreeId: string; generation?: string }
            if (!this.resolveTarget) throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
            request.phase = 'target-resolution'
            const selection = { worktreeId: q.worktreeId, generation: q.generation! }
            target = { ...await this.resolveTarget(selection), selection }
            request.validate = target.validate
          } else if (name === 'inspect_entire_checkpoint' && this.resolveTarget?.current) {
            target = await this.resolveTarget.current()
            request.validate = target.validate
          }
          if (!this.pending.has(id) || !this.active()) return
          if (Date.now() >= deadline) { this.expire(id); return }
          request.phase = 'worker-dispatch'
          request.generation = this.generation ?? this.createGeneration()
          request.generation.worker.postMessage({ id, name, args, deadline, ...(this.archiveConnection ? { archiveAccountHash: digest(this.archiveConnection.accountIdentity) } : {}), ...(archiveObservation ? { archiveObservation } : {}), ...(liveTargets ? { liveTargets } : {}), ...(target ? { target: { root: target.root, fingerprint: target.fingerprint, selection: target.selection } } : {}) })
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
