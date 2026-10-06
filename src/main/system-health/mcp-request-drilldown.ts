import type { ChannelTraceEvent } from '../../shared/types/channel-types'
import type {
  CheckpointResult,
  InvestigationTarget,
  StageDrilldownProvider,
  StageDrilldownResult,
  StageStatus
} from '../../shared/types/system-health-types'
import { computeLinearAdaptiveLocalization } from './adaptive-fault-locator'

export const MCP_REQUEST_CHECKPOINTS = [
  'Local MCP Connection Available',
  'MCP Request Dispatched',
  'MCP Request Received',
  'MCP Handler Started'
] as const

export type McpRequestCheckpoint = (typeof MCP_REQUEST_CHECKPOINTS)[number]

const AVAILABLE_INSTRUMENTATION = new Set([
  'mcp-request-received',
  'codescope-handler-started',
  'bridge-forward-started'
])

const REFINED_TARGETS: Record<McpRequestCheckpoint, InvestigationTarget> = {
  'Local MCP Connection Available': {
    systemArea: 'Local MCP Availability',
    component: 'Relay Transport / MCP Lifecycle',
    boundary: 'Desktop Process → Local MCP Server Binding',
    responsibility: 'Local MCP process lifecycle, HTTP server availability, and loopback port binding',
    investigationSeeds: [
      'src/main/mcp/connection/relay-transport.ts',
      'src/main/mcp/mcp-lifecycle.ts'
    ]
  },
  'MCP Request Dispatched': {
    systemArea: 'Local MCP Dispatch',
    component: 'Relay Transport Dispatcher',
    boundary: 'Relay Message Ingestion → Local HTTP Dispatch',
    responsibility: 'Preparing and dispatching the local HTTP POST request to the MCP server',
    investigationSeeds: [
      'src/main/mcp/connection/relay-transport.ts'
    ]
  },
  'MCP Request Received': {
    systemArea: 'Local MCP Ingress Transport',
    component: 'Local MCP HTTP Ingress',
    boundary: 'Desktop Dispatch → MCP HTTP Server Ingress',
    responsibility: 'Delivery and reception of the local HTTP request across loopback',
    investigationSeeds: [
      'src/main/mcp/mcp-http-server.ts',
      'src/main/mcp/connection/relay-transport.ts'
    ]
  },
  'MCP Handler Started': {
    systemArea: 'MCP Server Dispatcher',
    component: 'MCP Protocol Router / Dispatcher',
    boundary: 'MCP HTTP Ingress → Tool Handler Dispatch',
    responsibility: 'JSON-RPC parsing, schema validation, and tool method routing',
    investigationSeeds: [
      'src/main/mcp/mcp-http-server.ts',
      'src/main/mcp/channel-mcp-adapter.ts'
    ]
  }
}

export class McpRequestDrilldownProvider implements StageDrilldownProvider {
  readonly canonicalStage = 'MCP Request' as const

  evaluate(events: ChannelTraceEvent[], failureReason?: string | null): StageDrilldownResult | null {
    if (events.length === 0) return null

    const hasEvent = (stage: string, status?: string) =>
      events.some((e) => e.stage === stage && (status === undefined || e.status === status))

    const findEvent = (stage: string) =>
      events.find((e) => e.stage === stage)

    const findErrorEvent = (stage: string) =>
      events.find((e) => e.stage === stage && e.status === 'error')

    const bridgeError = findErrorEvent('bridge-forward-started')

    const hasServerEvents = events.some((e) =>
      e.stage === 'mcp-request-started' ||
      e.stage === 'mcp-request-received' ||
      e.stage === 'mcp-dispatch-started' ||
      e.stage === 'codescope-request-started' ||
      e.stage === 'codescope-handler-started' ||
      e.stage === 'codescope-response-produced' ||
      e.stage === 'codescope-handler-completed' ||
      e.stage === 'mcp-response-produced' ||
      e.stage === 'mcp-response-sent'
    )

    const connectionAborted =
      bridgeError &&
      bridgeError.error === 'RELAY_CLOSED' &&
      !hasServerEvents

    const connectionFailed =
      bridgeError &&
      (bridgeError.error === 'LOCAL_MCP_UNAVAILABLE' ||
        bridgeError.error === 'MCP_NOT_RUNNING' ||
        failureReason === 'LOCAL_MCP_UNAVAILABLE')

    if (connectionAborted) {
      return this.buildResult({
        failedCheckpoint: 'Local MCP Connection Available',
        reasonCode: 'RELAY_CLOSED',
        precision: 'EXACT',
        state: 'LOCALIZED',
        durationMs: bridgeError?.durationMs
      })
    }

    if (connectionFailed && !hasServerEvents) {
      const code = bridgeError?.error ?? failureReason ?? 'LOCAL_MCP_UNAVAILABLE'
      return this.buildResult({
        failedCheckpoint: 'Local MCP Connection Available',
        reasonCode: code,
        precision: 'EXACT',
        state: 'LOCALIZED',
        durationMs: bridgeError?.durationMs
      })
    }

    const bridgeStarted = hasEvent('bridge-forward-started', 'started') || hasEvent('bridge-forward-started', 'success')
    const dispatchFailed = bridgeError && !connectionFailed && !connectionAborted && !bridgeStarted && !hasServerEvents
    if (dispatchFailed) {
      return this.buildResult({
        failedCheckpoint: 'MCP Request Dispatched',
        reasonCode: bridgeError?.error ?? failureReason ?? 'DISPATCH_FAILED',
        precision: 'EXACT',
        state: 'LOCALIZED',
        durationMs: bridgeError?.durationMs
      })
    }

    const mcpReceived = hasEvent('mcp-request-received') || hasEvent('mcp-request-started')
    if (!mcpReceived) {
      if (bridgeError?.error === 'REQUEST_TIMEOUT' || failureReason === 'REQUEST_TIMEOUT') {
        return this.buildResult({
          failedCheckpoint: 'MCP Request Received',
          reasonCode: 'REQUEST_TIMEOUT',
          precision: 'BOUNDED',
          state: 'BOUNDED',
          missingEvidence: ['mcp-request-received'],
          durationMs: bridgeError?.durationMs ?? 30_000
        })
      }
      return this.buildResult({
        failedCheckpoint: 'MCP Request Received',
        reasonCode: bridgeError?.error ?? failureReason ?? 'MCP_UNREACHABLE',
        precision: 'BOUNDED',
        state: 'BOUNDED',
        missingEvidence: ['mcp-request-received'],
        durationMs: bridgeError?.durationMs
      })
    }

    const handlerStarted =
      hasEvent('codescope-handler-started', 'started') ||
      hasEvent('codescope-request-started', 'started') ||
      hasEvent('mcp-dispatch-started', 'started')

    const serverDispatchError =
      findErrorEvent('mcp-dispatch-started') ||
      findErrorEvent('mcp-request-received') ||
      findErrorEvent('mcp-request-started')

    if (!handlerStarted) {
      if (serverDispatchError) {
        return this.buildResult({
          failedCheckpoint: 'MCP Handler Started',
          reasonCode: serverDispatchError.error ?? failureReason ?? 'DISPATCH_ERROR',
          precision: 'EXACT',
          state: 'LOCALIZED',
          durationMs: serverDispatchError.durationMs
        })
      }
      return this.buildResult({
        failedCheckpoint: 'MCP Handler Started',
        reasonCode: failureReason ?? 'REQUEST_TIMEOUT',
        precision: 'BOUNDED',
        state: 'BOUNDED',
        missingEvidence: ['codescope-handler-started'],
        durationMs: bridgeError?.durationMs ?? 30_000
      })
    }

    return this.buildHappyPathResult(events)
  }

  private buildResult(params: {
    failedCheckpoint: McpRequestCheckpoint
    reasonCode: string
    precision: 'EXACT' | 'BOUNDED'
    state: 'LOCALIZED' | 'BOUNDED' | 'INSUFFICIENT_EVIDENCE'
    missingEvidence?: string[]
    durationMs?: number | null
  }): StageDrilldownResult {
    const failedIdx = MCP_REQUEST_CHECKPOINTS.indexOf(params.failedCheckpoint)
    const lastSuccessfulCheckpoint = failedIdx > 0 ? MCP_REQUEST_CHECKPOINTS[failedIdx - 1] : null
    const firstBlockedCheckpoint =
      failedIdx + 1 < MCP_REQUEST_CHECKPOINTS.length ? MCP_REQUEST_CHECKPOINTS[failedIdx + 1] : null

    const checkpoints: CheckpointResult[] = MCP_REQUEST_CHECKPOINTS.map((name, idx) => {
      let status: StageStatus
      let durationMs: number | null = null
      let reasonCode: string | null = null

      if (idx < failedIdx) {
        status = 'OPERATIONAL'
      } else if (idx === failedIdx) {
        status = params.precision === 'BOUNDED' ? 'UNKNOWN' : 'FAILED'
        if (status === 'FAILED') {
          durationMs = params.durationMs ?? null
          reasonCode = params.reasonCode
        }
      } else {
        status = 'BLOCKED'
      }

      return {
        name,
        status,
        ...(durationMs !== null ? { durationMs } : {}),
        ...(reasonCode ? { reasonCode } : {})
      }
    })

    const statusMap = new Map<string, { status: StageStatus; durationMs?: number | null; reasonCode?: string | null }>()
    for (const cp of checkpoints) {
      statusMap.set(cp.name, { status: cp.status, durationMs: cp.durationMs, reasonCode: cp.reasonCode })
    }

    const adaptive = computeLinearAdaptiveLocalization({
      canonicalStage: this.canonicalStage,
      checkpointNames: MCP_REQUEST_CHECKPOINTS,
      statuses: statusMap,
      missingEvidence: params.missingEvidence,
      availableInstrumentation: AVAILABLE_INSTRUMENTATION,
      hasRefinedTarget: Boolean(REFINED_TARGETS[params.failedCheckpoint])
    })

    return {
      canonicalStage: this.canonicalStage,
      state: params.state,
      precision: params.precision,
      lastSuccessfulCheckpoint,
      firstFailedCheckpoint: params.failedCheckpoint,
      firstBlockedCheckpoint,
      reasonCode: params.reasonCode,
      checkpoints,
      ...(params.missingEvidence?.length ? { missingEvidence: params.missingEvidence } : {}),
      refinedInvestigationTarget: REFINED_TARGETS[params.failedCheckpoint] ?? null,
      deepestProvenProgress: adaptive.deepestProvenProgress,
      diagnosticFrontier: adaptive.diagnosticFrontier,
      diagnosticResolution: adaptive.diagnosticResolution,
      observabilityGap: adaptive.observabilityGap,
      nextBestEvidence: adaptive.nextBestEvidence,
      resolutionSufficient: adaptive.observabilityGap.state === 'NONE'
    }
  }

  private buildHappyPathResult(events: ChannelTraceEvent[]): StageDrilldownResult {
    const last = events[events.length - 1]
    const checkpoints: CheckpointResult[] = MCP_REQUEST_CHECKPOINTS.map((name) => ({
      name,
      status: 'OPERATIONAL'
    }))

    return {
      canonicalStage: this.canonicalStage,
      state: 'NO_ACTIVE_FAILURE',
      precision: 'EXACT',
      lastSuccessfulCheckpoint: MCP_REQUEST_CHECKPOINTS[MCP_REQUEST_CHECKPOINTS.length - 1],
      firstFailedCheckpoint: null,
      firstBlockedCheckpoint: null,
      reasonCode: null,
      checkpoints,
      refinedInvestigationTarget: null
    }
  }
}

export const mcpRequestDrilldownProvider = new McpRequestDrilldownProvider()
