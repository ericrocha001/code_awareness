export type CodeScopeTraceStage =
  | 'gateway-request-started'
  | 'access-assertion-received'
  | 'access-assertion-validated'
  | 'identity-resolved'
  | 'installation-routed'
  | 'relay-request-sent'
  | 'desktop-request-received'
  | 'relay-request-received'
  | 'bridge-forward-started'
  | 'mcp-request-started'
  | 'mcp-request-received'
  | 'mcp-dispatch-started'
  | 'codescope-request-started'
  | 'codescope-handler-started'
  | 'codescope-operation-routed'
  | 'codescope-snapshot-started'
  | 'codescope-snapshot-completed'
  | 'codescope-readiness-requested'
  | 'codescope-readiness-satisfied'
  | 'codescope-readiness-failed'
  | 'codescope-index-query-started'
  | 'codescope-index-query-completed'
  | 'codescope-result-assembly-started'
  | 'codescope-result-assembly-completed'
  | 'codescope-execution'
  | 'codescope-response-produced'
  | 'codescope-handler-completed'
  | 'mcp-response-produced'
  | 'mcp-response-sent'
  | 'bridge-response-received'
  | 'desktop-relay-response-sent'
  | 'relay-response-forwarded'
  | 'gateway-relay-response-received'
  | 'relay-response-delivered'
  | 'gateway-response-produced'
  | 'http-response-returned'
  | 'gateway-response-delivered'

export interface CodeScopeTraceEvent {
  timestamp: string
  requestId: string
  sessionId: string
  method: string
  tool: string
  stage: CodeScopeTraceStage
  durationMs: number
  deadlineRemainingMs?: number
  status: 'started' | 'success' | 'error'
  error?: string
  capability?: string
  runtimeInstanceId?: string
}

export interface CodeScopeFunctionalHealth {
  status: 'UNKNOWN' | 'OPERATIONAL' | 'DEGRADED'
  lastSuccessfulToolCall: string | null
  lastSuccessfulAt: string | null
  lastFailedToolCall: string | null
  lastFailedAt: string | null
  lastFailureStage: CodeScopeTraceStage | null
  lastError: string | null
  lastStageLatencyMs: number | null
  lastDeadlineRemainingMs: number | null
}

export interface CodeScopeTraceSink {
  record(event: CodeScopeTraceEvent): void
}

const emptyHealth: CodeScopeFunctionalHealth = {
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

export class CodeScopeHealthMonitor implements CodeScopeTraceSink {
  private state: CodeScopeFunctionalHealth = { ...emptyHealth }
  private readonly listeners = new Set<(state: CodeScopeFunctionalHealth) => void>()

  getState(): CodeScopeFunctionalHealth {
    return { ...this.state }
  }

  onChanged(listener: (state: CodeScopeFunctionalHealth) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  record(event: CodeScopeTraceEvent): void {
    console.log('[CodeScope]', JSON.stringify(event))
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
        lastError: specificToolError ?? event.error ?? `CodeScope request failed at ${event.stage}`
      }
      this.publish()
    }
  }

  private publish(): void {
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }
}
