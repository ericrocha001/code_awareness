import type { ChannelTraceEvent, ChannelTraceSink, ChannelFunctionalHealth } from '../../shared/types/channel-types'

const emptyHealth: ChannelFunctionalHealth = {
  status: 'UNKNOWN',
  lastSuccessfulToolCall: null,
  lastSuccessfulAt: null,
  lastFailedToolCall: null,
  lastFailedAt: null,
  lastFailureStage: null,
  lastError: null,
  lastStageLatencyMs: null,
  lastDeadlineRemainingMs: null
}

export class ChannelFunctionalHealthMonitor implements ChannelTraceSink {
  private state: ChannelFunctionalHealth = { ...emptyHealth }
  private readonly listeners = new Set<(state: ChannelFunctionalHealth) => void>()

  getState(): ChannelFunctionalHealth {
    return { ...this.state }
  }

  onChanged(listener: (state: ChannelFunctionalHealth) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  record(event: ChannelTraceEvent): void {
    console.log('[Channel Functional Health]', JSON.stringify(event))
    const isToolCall = event.method === 'tools/call' || (event.tool !== 'unknown' && event.tool !== '')
    if (
      event.sessionId !== 'local' &&
      isToolCall &&
      (event.stage === 'gateway-response-delivered' ||
        event.stage === 'http-response-returned' ||
        event.stage === 'relay-response-forwarded' ||
        event.stage === 'desktop-relay-response-sent') &&
      event.status === 'success'
    ) {
      this.state = {
        ...this.state,
        status: 'OPERATIONAL',
        lastSuccessfulToolCall: event.tool || this.state.lastSuccessfulToolCall,
        lastSuccessfulAt: event.timestamp,
        lastStageLatencyMs: event.durationMs,
        lastDeadlineRemainingMs: event.deadlineRemainingMs ?? null,
        lastError: null
      }
      this.publish()
      return
    }
    if (event.sessionId !== 'local' && isToolCall && event.status === 'error') {
      const specificToolError = this.state.lastFailedToolCall === (event.tool || this.state.lastFailedToolCall) && this.state.lastError && !['TOOL_ERROR', 'MCP_RESPONSE_ERROR', 'MCP_REQUEST_FAILED'].includes(this.state.lastError)
        ? this.state.lastError
        : undefined
      this.state = {
        ...this.state,
        status: 'DEGRADED',
        lastFailedToolCall: event.tool || this.state.lastFailedToolCall,
        lastFailedAt: event.timestamp,
        lastFailureStage: event.stage,
        lastStageLatencyMs: event.durationMs,
        lastDeadlineRemainingMs: event.deadlineRemainingMs ?? null,
        lastError: specificToolError ?? event.error ?? `Channel request failed at ${event.stage}`
      }
      this.publish()
    }
  }

  private publish(): void {
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }
}
