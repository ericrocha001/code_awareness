import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'

export const startStage = z.enum(['discovery', 'profile', 'preflight', 'git', 'dependencies', 'approval', 'authority', 'guard', 'context',
  'context_backup', 'context_sanitize', 'context_vacuum', 'context_validation', 'context_digest', 'adapter', 'spawn', 'startup', 'abi', 'vite', 'cache'])
const milliseconds = z.number().finite().nonnegative().max(86400000)
export const startTimingSchema = z.object({
  totalMs: milliseconds, approvalMs: milliseconds, technicalMs: milliseconds, windowMs: milliseconds.nullable(), readyMs: milliseconds.nullable(),
  technicalWindowMs: milliseconds.nullable(), technicalReadyMs: milliseconds.nullable(), hostCpuMs: milliseconds,
  preparationBeforeRequestMs: milliseconds, criticalPathMs: milliseconds, unmeasuredMs: milliseconds,
  phases: z.array(z.object({ id: z.number().int().min(0).max(63), stage: startStage, parent: z.number().int().min(0).max(63).nullable(),
    after: z.array(z.number().int().min(0).max(63)).max(64), startMs: milliseconds, durationMs: milliseconds }).strict()).max(64)
}).strict()
export type PreviewStartTiming = z.infer<typeof startTimingSchema>
const now = () => Number(process.hrtime.bigint()) / 1e6

export class PreviewStartClock {
  readonly origin = now()
  private readonly cpu = process.cpuUsage()
  private readonly scope = new AsyncLocalStorage<number>()
  private readonly phases: PreviewStartTiming['phases'] = []
  private readonly frontier = new Set<number>()
  private windowMs: number | null = null
  private readyMs: number | null = null
  private begin(stage: z.infer<typeof startStage>) {
    if (this.phases.length >= 64) return undefined
    const parent = this.scope.getStore() ?? null
    const phase = { id: this.phases.length, stage, parent, after: parent === null ? [...this.frontier] : [], startMs: now() - this.origin, durationMs: 0 }
    this.phases.push(phase)
    return phase
  }
  private finish(phase: PreviewStartTiming['phases'][number]) {
    phase.durationMs = now() - this.origin - phase.startMs
    if (phase.parent === null) { phase.after.forEach(id => this.frontier.delete(id)); this.frontier.add(phase.id) }
  }
  async measure<T>(stage: z.infer<typeof startStage>, work: () => Promise<T>): Promise<T> {
    const phase = this.begin(stage)
    if (!phase) return work()
    try { return await this.scope.run(phase.id, work) } finally { this.finish(phase) }
  }
  measureSync<T>(stage: z.infer<typeof startStage>, work: () => T): T {
    const phase = this.begin(stage)
    if (!phase) return work()
    try { return this.scope.run(phase.id, work) } finally { this.finish(phase) }
  }
  presented(at: string) {
    if (!/^\d{1,24}$/.test(at)) throw new Error('WINDOW_TIMING_INVALID')
    const elapsed = Number(BigInt(at)) / 1e6 - this.origin
    if (elapsed < 0 || elapsed > now() - this.origin + 10) throw new Error('WINDOW_TIMING_INVALID')
    this.windowMs ??= elapsed
  }
  ready() { this.readyMs = now() - this.origin }
  external(stage: 'abi' | 'vite', startNs: string, endNs: string, parentStage: 'abi' | 'startup') {
    if (!/^\d{1,24}$/.test(startNs) || !/^\d{1,24}$/.test(endNs)) throw new Error('BOOTSTRAP_TIMING_INVALID')
    const startMs = Number(BigInt(startNs)) / 1e6 - this.origin, endMs = Number(BigInt(endNs)) / 1e6 - this.origin
    if (startMs < 0 || endMs < startMs || endMs > now() - this.origin + 10) throw new Error('BOOTSTRAP_TIMING_INVALID')
    if (this.phases.length >= 64) return
    const parent = [...this.phases].reverse().find(phase => phase.stage === parentStage)?.id ?? null
    this.phases.push({ id: this.phases.length, stage, parent, after: [], startMs, durationMs: endMs - startMs })
  }
  snapshot(): PreviewStartTiming {
    const totalMs = now() - this.origin
    const approvalBefore = (limit: number) => this.phases.filter(p => p.stage === 'approval').reduce((sum, p) => sum + Math.max(0, Math.min(p.durationMs, limit - p.startMs)), 0)
    const approvalMs = approvalBefore(totalMs), costs: number[] = []
    const roots = this.phases.filter(p => p.parent === null)
    for (const phase of roots) costs[phase.id] = Math.max(0, ...phase.after.map(id => costs[id] ?? 0)) + phase.durationMs
    const intervals = roots.map(p => [p.startMs, p.startMs + p.durationMs]).sort((a, b) => a[0] - b[0])
    let covered = 0, end = 0
    for (const [start, finish] of intervals) { covered += Math.max(0, finish - Math.max(start, end)); end = Math.max(end, finish) }
    const cpu = process.cpuUsage(this.cpu)
    return startTimingSchema.parse({ totalMs, approvalMs, technicalMs: Math.max(0, totalMs - approvalMs), windowMs: this.windowMs, readyMs: this.readyMs,
      technicalWindowMs: this.windowMs === null ? null : Math.max(0, this.windowMs - approvalBefore(this.windowMs)),
      technicalReadyMs: this.readyMs === null ? null : Math.max(0, this.readyMs - approvalBefore(this.readyMs)),
      hostCpuMs: (cpu.user + cpu.system) / 1000, preparationBeforeRequestMs: 0,
      criticalPathMs: Math.max(0, ...costs.filter(Number.isFinite)), unmeasuredMs: Math.max(0, totalMs - covered), phases: this.phases })
  }
}
