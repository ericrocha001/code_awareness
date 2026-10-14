import { createHash } from 'node:crypto'
import type { OrchestrationOverview, ObservableWorktree } from '../../shared/types/work-orchestration-types'
import type { OrchestrationAttention, StructuralAlert } from '../../shared/types/work-orchestration-attention-types'
import type { SelectiveContractDiscovery } from './structural-discovery'
import { selectWorklineBatch, type WorklineChoice } from './workline-priority'
import type { CoordinationReference } from '../git-operations/git-coordination-evidence'

export class Workline {
  private readonly alerts = new Map<string, StructuralAlert>()
  private records: ObservableWorktree[] = []
  private readonly observed = new Map<string, number>()
  private readonly attempted = new Map<string, number>()
  private readonly attemptedRound = new Map<string, number>()
  private round = 0
  private choices: WorklineChoice[] = []
  private reference: CoordinationReference | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private epoch = 0
  private running = false
  private stopped = true
  private paused = false
  private repositoryId: string | null = null
  private inventoryAt = 0
  private checkedAt: string | null = null
  private cycleMs = 0
  private unavailable = false
  readonly budget = { observations: 2, pairs: 1, timeMs: 5000, captures: 64, alerts: 64 }
  readonly cadenceMs = 30000
  readonly inventoryCadenceMs = 180000
  constructor(private readonly inventory: () => Promise<OrchestrationOverview>, private readonly engine: SelectiveContractDiscovery,
    private readonly changed: (state: OrchestrationAttention) => void, private readonly now: () => number = Date.now) {}

  isCurrent = () => !this.stopped && !this.paused
  selection() { return this.choices.map(choice => ({ worktreeId: choice.record.worktreeId, reason: choice.reason })) }
  snapshot(): OrchestrationAttention {
    return { repositoryId: this.repositoryId, alerts: [...this.alerts.values()].map(a => ({ ...a, evidence: a.evidence.map(e => ({ ...e })) })), coverage: this.unavailable ? 'UNAVAILABLE' : this.observed.size ? 'PARTIAL' : 'PENDING',
      paused: this.paused, known: this.records.length, observed: this.observed.size,
      pending: this.records.filter(r => !this.observed.has(r.worktreeId) || this.engine.pending.has(r.worktreeId)).map(r => ({ worktreeId: r.worktreeId, reason: this.engine.pending.get(r.worktreeId) ?? 'NOT_OBSERVED' })),
      checkedAt: this.checkedAt, cadenceMs: Math.max(this.cadenceMs, this.cycleMs * 2), inventoryCadenceMs: this.inventoryCadenceMs, cycleMs: this.cycleMs, budget: this.budget, stats: { ...this.engine.stats } }
  }
  start() {
    if (this.stopped) { this.records = []; this.reference = null; this.observed.clear(); this.attempted.clear(); this.attemptedRound.clear(); this.choices = [] }
    this.stopped = false; this.schedule(1000)
  }
  stop() { this.stopped = true; this.epoch++; this.engine.invalidate(); for (const alert of this.alerts.values()) alert.state = 'STALE'; if (this.timer) clearTimeout(this.timer); this.timer = null }
  pause(value: boolean) {
    this.paused = value; this.epoch++
    if (this.timer) clearTimeout(this.timer); this.timer = null
    for (const alert of this.alerts.values()) alert.state = 'STALE'
    this.engine.invalidate(); this.changed(this.snapshot())
    if (!value && !this.stopped && !this.running) this.schedule(1000)
  }
  private schedule(ms: number) { if (this.isCurrent()) { this.timer = setTimeout(() => { this.timer = null; void this.runOnce() }, ms); this.timer.unref?.() } }
  private stale(id: string) { for (const alert of this.alerts.values()) if (alert.provider === id || alert.consumer === id) alert.state = 'STALE' }

  async runOnce() {
    if (!this.isCurrent() || this.running) return this.snapshot()
    if (this.timer) clearTimeout(this.timer); this.timer = null
    this.running = true
    const epoch = this.epoch, started = this.now(), current = () => this.isCurrent() && this.epoch === epoch
    try {
      if (!this.records.length || this.now() - this.inventoryAt >= this.inventoryCadenceMs) {
        const inventory = await this.inventory()
        if (!current()) return this.snapshot()
        this.repositoryId = inventory.repositoryId; this.inventoryAt = this.now(); this.records = inventory.worktrees
        const reference = this.records.find(r => r.reference)
        this.reference = reference?.head ? { repositoryId: inventory.repositoryId, worktreeId: reference.worktreeId, generation: reference.generation, head: reference.head } : null
        const ids = new Set(this.records.map(r => r.worktreeId))
        for (const id of new Set([...this.observed.keys(), ...this.engine.captures.keys()])) if (!ids.has(id)) { this.observed.delete(id); this.attempted.delete(id); this.attemptedRound.delete(id); this.engine.remove(id); this.stale(id) }
      }
      const reference = this.reference, head = reference?.head
      if (!head) throw new Error('HEAD_UNAVAILABLE')
      const observationStarted = this.now()
      const eligible = this.records.filter(r => !r.missing && !r.prunable)
      const structural = new Set([...this.engine.pending].filter(([, reason]) => reason === 'PAIR_BUDGET').map(([id]) => id))
      const eligibleIds = new Set(eligible.map(r => r.worktreeId))
      for (const alert of this.alerts.values()) if (alert.state === 'STALE' && eligibleIds.has(alert.provider) && eligibleIds.has(alert.consumer)) { structural.add(alert.provider); structural.add(alert.consumer) }
      this.choices = selectWorklineBatch(eligible, { reference: reference!, facts: this.engine.observedStates ?? new Map(), attempted: this.attempted, attemptedRound: this.attemptedRound,
        observed: this.observed, structural, pending: this.engine.pending, round: ++this.round, now: this.now(), inventoryAt: this.inventoryAt, cadenceMs: this.cadenceMs, budget: this.budget.observations })
      for (const { record } of this.choices) {
        if (!current() || this.now() - observationStarted >= this.budget.timeMs) break
        this.attempted.set(record.worktreeId, this.now())
        this.attemptedRound.set(record.worktreeId, this.round)
        try {
          const changed = await this.engine.observe(record.worktreeId, head, reference!)
          if (!current()) return this.snapshot()
          if (changed) this.stale(record.worktreeId)
          this.observed.set(record.worktreeId, this.now())
          const local = this.engine.observedStates?.get(record.worktreeId)
          if (record.reference && local?.generation === record.generation) this.reference = { ...reference!, head: local.head }
        } catch (error) { if (!current()) return this.snapshot(); this.engine.remove(record.worktreeId); this.engine.pending.set(record.worktreeId, error instanceof Error ? error.message : 'UNAVAILABLE'); this.stale(record.worktreeId) }
      }
      if (!current()) return this.snapshot()
      const findings = await this.engine.investigate(this.budget.pairs)
      if (!current()) return this.snapshot()
      for (const finding of findings) {
        const id = createHash('sha256').update(JSON.stringify([finding.provider, finding.providerGeneration, finding.consumer, finding.consumerGeneration, finding.evidence.map(e => [e.contractPath, e.consumerPath, e.symbol])])).digest('hex')
        if (this.alerts.size >= this.budget.alerts && !this.alerts.has(id)) { this.engine.pending.set(finding.consumer, 'ALERT_BUDGET'); continue }
        this.alerts.set(id, { ...finding, id, category: 'POTENTIAL_STRUCTURAL_INTERFERENCE', state: 'CURRENT', verifiedAt: new Date(this.now()).toISOString(),
          evidence: finding.evidence.map(e => ({ ...e, signature: e.signature.length > 200 ? e.signature.slice(0, 199) + '…' : e.signature, previousSignature: e.previousSignature.length > 200 ? e.previousSignature.slice(0, 199) + '…' : e.previousSignature })) })
      }
      this.unavailable = false; this.checkedAt = new Date(this.now()).toISOString()
    } catch { if (current()) { this.unavailable = true; for (const alert of this.alerts.values()) alert.state = 'STALE' } }
    finally {
      this.running = false; this.cycleMs = this.now() - started
      if (current()) this.changed(this.snapshot())
      this.schedule(Math.max(this.cadenceMs, this.cycleMs * 2))
    }
    return this.snapshot()
  }
}
