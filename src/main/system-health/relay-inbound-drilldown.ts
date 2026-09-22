import type { CodeScopeTraceEvent } from '../mcp/code-scope-health'
import type {
  CheckpointResult,
  InvestigationTarget,
  StageDrilldownProvider,
  StageDrilldownResult,
  StageStatus
} from '../../shared/types/system-health-types'
import { computeLinearAdaptiveLocalization } from './adaptive-fault-locator'

export const RELAY_INBOUND_CHECKPOINTS = [
  'Desktop Relay Egress',
  'Gateway Relay Ingress'
] as const

export type RelayInboundCheckpoint = (typeof RELAY_INBOUND_CHECKPOINTS)[number]

const AVAILABLE_INSTRUMENTATION = new Set([
  'desktop-relay-response-sent',
  'relay-response-forwarded',
  'relay-response-delivered'
])

const REFINED_TARGETS: Record<RelayInboundCheckpoint, InvestigationTarget> = {
  'Desktop Relay Egress': {
    systemArea: 'Desktop Relay Egress',
    component: 'Desktop Relay WebSocket Egress',
    boundary: 'Desktop MCP → Relay Outbound',
    responsibility: 'Serializing and transmitting MCP result/error frame over WebSocket to gateway',
    investigationSeeds: [
      'src/main/mcp/connection/relay-transport.ts',
      'src/shared/distribution/relay-protocol.ts'
    ]
  },
  'Gateway Relay Ingress': {
    systemArea: 'Gateway Relay Response Ingress',
    component: 'Installation Relay Inbound Handler',
    boundary: 'Desktop Relay Egress → Gateway Relay Ingress',
    responsibility: 'Awaiting, receiving, and correlating desktop response frame within gateway deadline',
    investigationSeeds: [
      'infra/gateway/cloudflare/installation-relay.ts',
      'infra/gateway/domain/public-mcp-gateway.ts'
    ]
  }
}

export class RelayInboundDrilldownProvider implements StageDrilldownProvider {
  readonly canonicalStage = 'Relay Inbound' as const

  evaluate(events: CodeScopeTraceEvent[], failureReason?: string | null): StageDrilldownResult | null {
    if (events.length === 0) return null

    const findEvent = (stage: string) =>
      events.find((e) => e.stage === stage)

    const findErrorEvent = (stage: string) =>
      events.find((e) => e.stage === stage && e.status === 'error')

    const desktopSent = findEvent('desktop-relay-response-sent') || findEvent('relay-response-forwarded')
    const desktopError = findErrorEvent('desktop-relay-response-sent') || findErrorEvent('relay-response-forwarded')
    const relayDelivered = findEvent('relay-response-delivered')

    const statuses = new Map<RelayInboundCheckpoint, { status: StageStatus; durationMs?: number | null; reasonCode?: string | null }>()

    if (desktopError) {
      statuses.set('Desktop Relay Egress', {
        status: 'FAILED',
        durationMs: desktopError.durationMs,
        reasonCode: desktopError.error ?? failureReason ?? 'SEND_FAILED'
      })
      statuses.set('Gateway Relay Ingress', { status: 'BLOCKED' })
    } else if (desktopSent && desktopSent.status === 'success') {
      statuses.set('Desktop Relay Egress', {
        status: 'OPERATIONAL',
        durationMs: desktopSent.durationMs
      })

      if (relayDelivered && relayDelivered.status === 'success') {
        statuses.set('Gateway Relay Ingress', {
          status: 'OPERATIONAL',
          durationMs: relayDelivered.durationMs
        })
      } else if (relayDelivered && relayDelivered.status === 'error') {
        statuses.set('Gateway Relay Ingress', {
          status: 'FAILED',
          durationMs: relayDelivered.durationMs,
          reasonCode: relayDelivered.error ?? failureReason ?? 'DELIVERY_FAILED'
        })
      } else {
        statuses.set('Gateway Relay Ingress', {
          status: 'UNKNOWN'
        })
      }
    } else {
      statuses.set('Desktop Relay Egress', {
        status: 'UNKNOWN'
      })
      statuses.set('Gateway Relay Ingress', {
        status: 'BLOCKED'
      })
    }

    const checkpoints: CheckpointResult[] = RELAY_INBOUND_CHECKPOINTS.map((name) => {
      const info = statuses.get(name)!
      return {
        name,
        status: info.status,
        ...(info.durationMs !== undefined && info.durationMs !== null ? { durationMs: info.durationMs } : {}),
        ...(info.status === 'FAILED' && info.reasonCode ? { reasonCode: info.reasonCode } : {})
      }
    })

    const missingEvidence: string[] = []
    if (!relayDelivered && statuses.get('Desktop Relay Egress')?.status === 'OPERATIONAL') {
      missingEvidence.push('relay-response-delivered')
    }
    if (!desktopSent) {
      missingEvidence.push('desktop-relay-response-sent')
    }

    const adaptive = computeLinearAdaptiveLocalization({
      canonicalStage: 'Relay Inbound',
      checkpointNames: RELAY_INBOUND_CHECKPOINTS,
      statuses: statuses as Map<string, { status: StageStatus; durationMs?: number | null; reasonCode?: string | null }>,
      missingEvidence,
      availableInstrumentation: AVAILABLE_INSTRUMENTATION,
      hasRefinedTarget: Boolean(statuses.get('Desktop Relay Egress')?.status === 'FAILED')
    })

    const failedCheckpoint = checkpoints.find((cp) => cp.status === 'FAILED')?.name ?? null
    const firstBlockedCheckpoint = checkpoints.find((cp) => cp.status === 'BLOCKED')?.name ?? null
    const lastSuccessfulCheckpoint = checkpoints.filter((cp) => cp.status === 'OPERATIONAL').pop()?.name ?? null

    const targetCheckpoint = (failedCheckpoint ?? adaptive.diagnosticFrontier?.at ?? 'Gateway Relay Ingress') as RelayInboundCheckpoint
    const refinedInvestigationTarget = REFINED_TARGETS[targetCheckpoint] ?? REFINED_TARGETS['Gateway Relay Ingress']

    const isBounded = adaptive.diagnosticFrontier?.precision === 'BOUNDED'
    const state = isBounded ? 'BOUNDED' : 'LOCALIZED'

    return {
      canonicalStage: 'Relay Inbound',
      state,
      precision: adaptive.diagnosticFrontier?.precision ?? 'BOUNDED',
      lastSuccessfulCheckpoint,
      firstFailedCheckpoint: failedCheckpoint,
      firstBlockedCheckpoint,
      reasonCode: failureReason ?? (failedCheckpoint ? statuses.get(failedCheckpoint as RelayInboundCheckpoint)?.reasonCode ?? null : null),
      checkpoints,
      missingEvidence: missingEvidence.length > 0 ? missingEvidence : undefined,
      deepestProvenProgress: adaptive.deepestProvenProgress,
      diagnosticFrontier: adaptive.diagnosticFrontier,
      diagnosticResolution: adaptive.diagnosticResolution,
      observabilityGap: adaptive.observabilityGap,
      nextBestEvidence: adaptive.nextBestEvidence,
      refinedInvestigationTarget,
      resolutionSufficient: !isBounded
    }
  }
}

export const relayInboundDrilldownProvider = new RelayInboundDrilldownProvider()
