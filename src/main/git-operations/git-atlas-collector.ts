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
      if (consumer.store.diagnostic().state !== 'READY') { this.stopped.add(consumer); this.emit(consumer); return }
      const source = await consumer.fingerprint()
      if (!active() || busy()) return
      if (source !== consumer.manifest.sourceFingerprint) {
        consumer.manifest = await consumer.observe()
        if (!active() || busy()) return
        this.rounds.delete(consumer)
      }
      let round = this.rounds.get(consumer)
      if (!round) {
        round = consumer.store.beginRound(consumer.manifest)
        if (!round) { this.stopped.add(consumer); this.emit(consumer); return }
        this.rounds.set(consumer, round)
        if (round.status !== 'COMPLETE') this.emit(consumer)
      }
      if (round.status === 'COMPLETE') {
        const current = await consumer.observe()
        if (!active() || busy()) return
        consumer.manifest = current
        if (!current.available || current.revision !== round.manifest.revision || current.sourceFingerprint !== source) { this.rounds.delete(consumer); return }
        this.stopped.add(consumer); this.emit(consumer); return
      }
      const frontier = consumer.store.frontier(round.id, 32)
      if (!frontier.length) {
        const current = await consumer.observe()
        if (!active() || busy()) return
        if (current.revision !== round.manifest.revision || current.sourceFingerprint !== consumer.manifest.sourceFingerprint) {
          consumer.manifest = current; this.rounds.delete(consumer); return
        }
        if (!consumer.store.finishRound(round.id, current.revision, current.available)) {
          consumer.store.markUnknown(round.id, 'SCOPE_OR_CLOSURE_UNAVAILABLE')
        }
        this.rounds.set(consumer, consumer.store.getRound(round.id) ?? round)
        this.stopped.add(consumer); this.emit(consumer); return
      }
      const missing = frontier.filter(sha => typeof consumer.store.getCommit(sha)?.message !== 'string')
      const commits = await consumer.metadata(missing)
      if (!active() || busy()) return
      if (await consumer.fingerprint() !== consumer.manifest.sourceFingerprint) { this.rounds.delete(consumer); return }
      if (!active() || busy()) return
      if (!consumer.store.checkpoint(round.id, commits, frontier)) { this.stopped.add(consumer); this.emit(consumer, 'CHECKPOINT_UNAVAILABLE'); return }
      this.rounds.set(consumer, consumer.store.getRound(round.id) ?? round); this.emit(consumer)
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
