import type { AtlasCatalogManifest, AtlasCatalogState, AtlasCollectionRound } from '../../shared/types/git-atlas-catalog-types'
import type { AtlasCommit, AtlasPersistence } from './git-atlas-cache'

interface Consumer {
  store: AtlasPersistence
  manifest: AtlasCatalogManifest
  observe(): Promise<AtlasCatalogManifest>
  fingerprint(): Promise<string>
  metadata(shas: string[]): Promise<AtlasCommit[]>
  busy(): boolean
  changed(state: AtlasCatalogState): void
}

export class AtlasCollector {
  private static readonly catalogs = new Map<string, AtlasCollector>()
  private readonly consumers = new Set<Consumer>()
  private timer?: NodeJS.Timeout
  private running = false
  private cursor = 0
  private readonly rounds = new Map<Consumer, AtlasCollectionRound>()
  private readonly stopped = new Set<Consumer>()
  private readonly signatures = new Map<Consumer, string>()

  static attach(consumer: Consumer): () => void {
    let coordinator = this.catalogs.get(consumer.store.catalogIdentity)
    if (!coordinator) { coordinator = new AtlasCollector(); this.catalogs.set(consumer.store.catalogIdentity, coordinator) }
    const selected = coordinator
    selected.consumers.add(consumer)
    selected.schedule()
    return () => {
      selected.consumers.delete(consumer); selected.rounds.delete(consumer); selected.stopped.delete(consumer); selected.signatures.delete(consumer)
      if (!selected.consumers.size) {
        if (selected.timer) clearTimeout(selected.timer)
        selected.timer = undefined
        if (!selected.running) this.catalogs.delete(consumer.store.catalogIdentity)
      }
    }
  }

  private schedule() {
    if (this.timer || this.running || ![...this.consumers].some(consumer => !this.stopped.has(consumer))) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.step() }, 200)
    this.timer.unref()
  }

  private emit(consumer: Consumer, reason: string | null = null) {
    if (!this.consumers.has(consumer)) return
    const round = this.rounds.get(consumer)
    const state: AtlasCatalogState = { manifest: consumer.manifest, coverage: reason ? 'UNKNOWN' : round?.status ?? 'UNKNOWN', acquired: round?.acquired ?? 0, diagnostic: consumer.store.diagnostic(), reason: reason ?? round?.reason ?? null }
    const signature = JSON.stringify([state.manifest?.revision, state.coverage, state.diagnostic, state.reason])
    if (this.signatures.get(consumer) !== signature) { this.signatures.set(consumer, signature); consumer.changed(state) }
  }

  private async step() {
    const candidates = [...this.consumers].filter(consumer => !this.stopped.has(consumer))
    if (!candidates.length) return
    const consumer = candidates[this.cursor++ % candidates.length]
    const active = () => this.consumers.has(consumer)
    const busy = () => [...this.consumers].some(item => item.busy())
    this.running = true
    try {
      if (busy()) return
      const started = performance.now()
      if (consumer.store.diagnostic().state !== 'READY') { this.stopped.add(consumer); this.emit(consumer, 'CHECKPOINT_UNAVAILABLE'); return }
      const source = await consumer.fingerprint()
      if (!active() || busy()) return
      if (source !== consumer.manifest.sourceFingerprint) {
        consumer.manifest = await consumer.observe()
        if (!active() || busy()) return
        this.rounds.delete(consumer)
        return
      }
      const manifest = consumer.manifest
      const selected = () => active() && consumer.manifest === manifest
      let round = this.rounds.get(consumer)
      if (!round) {
        round = consumer.store.beginRound(consumer.manifest)
        if (!round) { this.stopped.add(consumer); this.emit(consumer); return }
        this.rounds.set(consumer, round)
        if (round.status !== 'COMPLETE') this.emit(consumer)
      }
      for (let unit = 0; unit < 8; unit++) {
        if (!selected() || busy() || unit > 0 && performance.now() - started >= 1000) return
        if (consumer.store.diagnostic().state !== 'READY') { this.stopped.add(consumer); this.emit(consumer, 'CHECKPOINT_UNAVAILABLE'); return }
        const frontier = round.status === 'COMPLETE' ? [] : consumer.store.frontier(round.id, 32)
        if (consumer.store.diagnostic().state !== 'READY') { this.stopped.add(consumer); this.emit(consumer, 'CHECKPOINT_UNAVAILABLE'); return }
        if (!frontier.length) {
          const current = await consumer.observe()
          if (!selected() || busy()) return
          if (current.revision !== manifest.revision || current.topology !== manifest.topology || current.worktreeGeneration !== manifest.worktreeGeneration || current.sourceFingerprint !== source) {
            consumer.manifest = current; this.rounds.delete(consumer); return
          }
          if (!current.available || round.status !== 'COMPLETE' && !consumer.store.finishRound(round.id, current.revision, current.available)) {
            consumer.store.markUnknown(round.id, 'SCOPE_OR_CLOSURE_UNAVAILABLE')
          }
          const confirmed = consumer.store.getRound(round.id)
          if (!confirmed || consumer.store.diagnostic().state !== 'READY') { this.stopped.add(consumer); this.emit(consumer, 'CHECKPOINT_UNAVAILABLE'); return }
          consumer.manifest = current
          this.rounds.set(consumer, confirmed)
          this.stopped.add(consumer); this.emit(consumer, current.available ? null : 'SOURCE_COVERAGE_UNAVAILABLE'); return
        }
        const missing = frontier.filter(sha => typeof consumer.store.getCommit(sha)?.message !== 'string')
        const commits = missing.length ? await consumer.metadata(missing) : []
        if (!selected() || busy()) return
        if (!consumer.store.checkpoint(round.id, commits, frontier)) { this.stopped.add(consumer); this.emit(consumer, 'CHECKPOINT_UNAVAILABLE'); return }
        round = consumer.store.getRound(round.id) ?? round
        this.rounds.set(consumer, round); this.emit(consumer)
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    } catch (error) {
      if (active()) {
        const reason = error instanceof Error ? error.message : 'COLLECTION_UNAVAILABLE'
        const round = this.rounds.get(consumer)
        if (round) consumer.store.markUnknown(round.id, reason)
        if (round) this.rounds.set(consumer, consumer.store.getRound(round.id) ?? round)
        this.stopped.add(consumer); this.emit(consumer, reason)
      }
    } finally {
      this.running = false
      if (!this.consumers.size) AtlasCollector.catalogs.delete(consumer.store.catalogIdentity)
      else this.schedule()
    }
  }
}
