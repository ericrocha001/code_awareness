import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChannelUsagePort, UsageBatch, UsageCatalog, UsageCompletion, UsageQuery } from './channel-usage-types'

export class ChannelUsage implements ChannelUsagePort {
  private readonly runId = randomUUID()
  private startedAt?: number
  private completions: UsageCompletion[] = []
  private catalogs: UsageCatalog[] = []
  private losses = 0
  private latestCatalog?: UsageCatalog
  private recoverCatalog = false
  private worker?: Worker
  private timer?: NodeJS.Timeout
  private idle?: NodeJS.Timeout
  private flushing?: Promise<void>
  private closed = false
  private querying = false
  private sequence = 0
  private batchSequence = 0
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()

  constructor(private readonly path: string, private readonly workerPath = join(__dirname, 'channel-usage-worker.js'), private readonly capacity = 2048, private readonly idleMs = 30_000) {}

  complete(event: UsageCompletion): void {
    if (this.closed) return
    this.startedAt ??= Date.now()
    if (this.completions.length >= this.capacity) this.losses++
    else this.completions.push(event)
    this.schedule()
  }

  catalog(event: UsageCatalog): void {
    if (this.closed) return
    this.startedAt ??= event.at
    if (event.tools.length <= 2048) this.latestCatalog = event
    if (this.catalogs.length >= 64 || event.tools.length > 2048) { this.losses++; this.recoverCatalog = true }
    else this.catalogs.push(event)
    this.schedule()
  }

  private schedule(): void {
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, 250).unref()
  }

  flush(stopped = false): Promise<void> {
    if (this.flushing) return this.flushing.then(() => this.flush(stopped))
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.startedAt === undefined) return Promise.resolve()
    if (!stopped && !this.completions.length && !this.catalogs.length && !this.losses) return Promise.resolve()
    if (this.recoverCatalog && this.latestCatalog) {
      this.catalogs.push({ ...this.latestCatalog, at: Date.now() })
      this.recoverCatalog = false
    }
    const batch: UsageBatch = { id: ++this.batchSequence, runId: this.runId, startedAt: this.startedAt, at: Date.now(),
      completions: this.completions, catalogs: this.catalogs, losses: this.losses, stopped }
    this.completions = []; this.catalogs = []; this.losses = 0
    this.flushing = (async () => {
      try { await this.rpc('write', { batch }) }
      catch {
        try { await this.rpc('write', { batch }) }
        catch { this.losses += batch.completions.length + batch.losses + batch.catalogs.length; this.recoverCatalog = true }
      }
    })().finally(() => { this.flushing = undefined })
    return this.flushing
  }

  async query(query: UsageQuery): Promise<unknown> {
    if (this.closed) throw new Error('USAGE_UNAVAILABLE')
    if (this.querying) throw new Error('USAGE_BUSY')
    this.querying = true
    try {
      await this.flush()
      const result = await this.rpc('query', { query, asOf: Date.now(), runId: this.runId })
      return { ...(result as object), collector: { pendingCompletions: this.completions.length, unpersistedLosses: this.losses } }
    } finally { this.querying = false }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.flush(true)
    if (this.timer) clearTimeout(this.timer)
    await this.resetWorker()
  }

  private rpc(type: string, payload: object): Promise<unknown> {
    try {
      if (this.idle) clearTimeout(this.idle)
      if (!this.worker) {
        const worker = new Worker(this.workerPath, { workerData: { path: this.path }, resourceLimits: { maxOldGenerationSizeMb: 64 } })
        this.worker = worker
        worker.on('message', message => {
          const waiting = this.pending.get(message.id)
          if (!waiting) return
          clearTimeout(waiting.timer); this.pending.delete(message.id)
          if (message.error) waiting.reject(new Error(message.error))
          else waiting.resolve(message.value)
          if (!this.pending.size) this.idle = setTimeout(() => this.resetWorker(), this.idleMs).unref()
        })
        worker.on('error', () => { if (this.worker === worker) this.resetWorker() })
        worker.on('exit', () => { if (this.worker === worker) this.resetWorker() })
      }
      const id = ++this.sequence
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.resetWorker(), 1500)
        this.pending.set(id, { resolve, reject, timer })
        try { this.worker!.postMessage({ id, type, ...payload }) }
        catch { void this.resetWorker() }
      })
    } catch { this.resetWorker(); return Promise.reject(new Error('USAGE_STORAGE_UNAVAILABLE')) }
  }

  private resetWorker(): Promise<unknown> {
    if (this.idle) clearTimeout(this.idle)
    this.idle = undefined
    const worker = this.worker
    this.worker = undefined
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('USAGE_STORAGE_UNAVAILABLE')) }
    this.pending.clear()
    return worker ? worker.terminate().catch(() => {}) : Promise.resolve()
  }
}
