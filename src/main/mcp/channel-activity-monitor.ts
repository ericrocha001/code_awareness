import type { ChannelActivityCounters, ChannelActivityState, ChannelTraceEvent, ChannelTraceSink } from '../../shared/types/channel-types'

function emptyCounters(): ChannelActivityCounters {
  return {
    activeRequests: 0, peakConcurrentRequests: 0, totalRequests: 0,
    succeededRequests: 0, failedRequests: 0, timedOutRequests: 0,
    latency: { completedRequests: 0, totalDurationMs: 0, lastDurationMs: null, maxDurationMs: null }
  }
}

export class ChannelActivityMonitor implements ChannelTraceSink {
  private readonly state: ChannelActivityState = { ...emptyCounters(), byTool: {}, byCapability: {} }
  private readonly active = new Map<string, ChannelActivityCounters[]>()
  private readonly completed = new Set<string>()
  private readonly listeners = new Set<() => void>()

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState(): ChannelActivityState {
    return structuredClone(this.state)
  }

  record(event: ChannelTraceEvent): void {
    if (event.method !== 'tools/call') return
    if (event.stage === 'channel-request-started' && event.status === 'started') {
      if (this.active.has(event.requestId) || this.completed.has(event.requestId)) return
      const counters = [this.state, this.category(this.state.byTool, event.tool)]
      if (event.channelCapability) counters.push(this.category(this.state.byCapability, event.channelCapability))
      this.active.set(event.requestId, counters)
      for (const counter of counters) {
        counter.totalRequests++
        counter.activeRequests++
        counter.peakConcurrentRequests = Math.max(counter.peakConcurrentRequests, counter.activeRequests)
      }
    } else if (event.stage === 'channel-request-completed' && event.status !== 'started') {
      const counters = this.active.get(event.requestId)
      if (!counters) return
      this.active.delete(event.requestId)
      this.completed.add(event.requestId)
      if (this.completed.size > 256) this.completed.delete(this.completed.values().next().value!)
      const durationMs = Number.isFinite(event.durationMs) ? Math.max(0, event.durationMs) : 0
      for (const counter of counters) {
        counter.activeRequests--
        if (event.status === 'success') counter.succeededRequests++
        else if (event.error === 'REQUEST_TIMEOUT') counter.timedOutRequests++
        else counter.failedRequests++
        counter.latency.completedRequests++
        counter.latency.totalDurationMs += durationMs
        counter.latency.lastDurationMs = durationMs
        counter.latency.maxDurationMs = Math.max(counter.latency.maxDurationMs ?? 0, durationMs)
      }
    } else return
    for (const listener of this.listeners) {
      try { listener() } catch {}
    }
  }

  private category(categories: Record<string, ChannelActivityCounters>, label: string): ChannelActivityCounters {
    const key = label.length <= 128 && (Object.hasOwn(categories, label) || Object.keys(categories).length < 128) ? label : 'other'
    if (!Object.hasOwn(categories, key)) {
      Object.defineProperty(categories, key, { value: emptyCounters(), enumerable: true })
    }
    return categories[key]
  }
}
