export type ChannelTraceStage =
  | 'channel-request-started'
  | 'channel-request-completed'
  | 'gateway-request-started'
  | 'access-assertion-received'
  | 'access-assertion-validated'
  | 'identity-resolved'
  | 'installation-routed'
  | 'relay-request-sent'
  | 'relay-request-forwarded'
  | 'relay-response-received'
  | 'desktop-request-received'
  | 'desktop-connection-established'
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
  | 'client-response-completed'

export interface ChannelTraceEvent {
  timestamp: string
  requestId: string
  sessionId: string
  method: string
  tool: string
  stage: ChannelTraceStage
  durationMs: number
  deadlineRemainingMs?: number
  status: 'started' | 'success' | 'error'
  error?: string
  capability?: string
  channelCapability?: string
  runtimeInstanceId?: string
  installationId?: string
}

export interface ChannelFunctionalHealth {
  status: 'UNKNOWN' | 'OPERATIONAL' | 'DEGRADED'
  lastSuccessfulToolCall: string | null
  lastSuccessfulAt: string | null
  lastFailedToolCall: string | null
  lastFailedAt: string | null
  lastFailureStage: ChannelTraceStage | null
  lastError: string | null
  lastStageLatencyMs: number | null
  lastDeadlineRemainingMs: number | null
}

export interface ChannelTraceSink {
  record(event: ChannelTraceEvent): void
}

export interface ChannelActivityCounters {
  activeRequests: number
  peakConcurrentRequests: number
  totalRequests: number
  succeededRequests: number
  failedRequests: number
  timedOutRequests: number
  latency: {
    completedRequests: number
    totalDurationMs: number
    lastDurationMs: number | null
    maxDurationMs: number | null
  }
}

export interface ChannelActivityState extends ChannelActivityCounters {
  byTool: Record<string, ChannelActivityCounters>
  byCapability: Record<string, ChannelActivityCounters>
}

