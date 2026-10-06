import type { ChannelTraceEvent } from '../../shared/types/channel-types'
import type { CanonicalStage, CanonicalStageResult, StageStatus } from '../../shared/types/system-health-types'
import { CANONICAL_PIPELINE, pipelineIndexOf, toCanonicalStage } from './canonical-pipeline'

export interface DiagnosticTrace {
  traceId: string
  operation: string
  startedAt: string
  completedAt: string
  durationMs: number
  success: boolean
  stages: CanonicalStageResult[]
  firstFailedBoundary: CanonicalStage | null
  lastSuccessfulStage: CanonicalStage | null
  reasonCode: string | null
  hasContradictoryExecution?: boolean
}

interface StageAccumulator {
  durationMs: number | null
  reasonCode: string | null
  failed: boolean
  seen: boolean
  succeeded: boolean
}

export function buildDiagnosticTrace(events: ChannelTraceEvent[]): DiagnosticTrace | null {
  if (events.length === 0) return null

  const first = events[0]
  const last = events[events.length - 1]
  const traceId = first.requestId
  const toolEvent = events.find((e) => e.tool && e.tool !== 'unknown' && e.tool !== '')
  const operation = toolEvent?.tool || first.method || 'unknown'
  const startedAt = first.timestamp
  const completedAt = last.timestamp
  const durationMs = last.durationMs

  const accumulated = new Map<CanonicalStage, StageAccumulator>()
  for (const stage of CANONICAL_PIPELINE) {
    accumulated.set(stage, { durationMs: null, reasonCode: null, failed: false, seen: false, succeeded: false })
  }

  for (const event of events) {
    const canonical = toCanonicalStage(event.stage)
    if (!canonical) continue
    const acc = accumulated.get(canonical)!
    acc.seen = true
    if (event.durationMs !== undefined && event.durationMs !== null) {
      acc.durationMs = Math.max(acc.durationMs ?? 0, event.durationMs)
    }
    if (event.status === 'success') {
      acc.succeeded = true
    }
    if (event.status === 'error') {
      acc.failed = true
      if (!acc.reasonCode && event.error) acc.reasonCode = event.error
    }
  }

  let firstFailedIndex = -1
  let firstFailedBoundary: CanonicalStage | null = null
  let reasonCode: string | null = null

  for (let i = 0; i < CANONICAL_PIPELINE.length; i++) {
    const stage = CANONICAL_PIPELINE[i]
    const acc = accumulated.get(stage)!
    if (acc.failed && firstFailedIndex === -1) {
      firstFailedIndex = i
      firstFailedBoundary = stage
      reasonCode = acc.reasonCode
      break
    }
  }

  // Deepest Proven Progress:
  // When an outer/enclosing layer experiences a failure (such as an enclosing transport timeout),
  // but downstream execution has already proven progress, localize the fault
  // to the deepest proven downstream stage instead of marking it BLOCKED.
  if (firstFailedIndex !== -1) {
    const mcpRequestIdx = pipelineIndexOf('MCP Request')
    const codescopeIdx = pipelineIndexOf('CodeScope Execution')
    const mcpResponseIdx = pipelineIndexOf('MCP Response')

    if (firstFailedIndex <= mcpRequestIdx) {
      const hasCodeScopeProgress = events.some((e) => {
        const canonical = toCanonicalStage(e.stage)
        return canonical === 'CodeScope Execution'
      })

      if (hasCodeScopeProgress) {
        const codeScopeCompleted = events.some(
          (e) =>
            (e.stage === 'codescope-response-produced' || e.stage === 'codescope-handler-completed') &&
            e.status === 'success'
        )

        if (codeScopeCompleted) {
          firstFailedIndex = mcpResponseIdx
          firstFailedBoundary = 'MCP Response'
          reasonCode = reasonCode ?? 'REQUEST_TIMEOUT'

          const csAcc = accumulated.get('CodeScope Execution')!
          csAcc.failed = false
          csAcc.succeeded = true
          csAcc.reasonCode = null

          const respAcc = accumulated.get('MCP Response')!
          respAcc.failed = true
          respAcc.reasonCode = reasonCode
          respAcc.durationMs = Math.max(respAcc.durationMs ?? 0, durationMs)
        } else {
          firstFailedIndex = codescopeIdx
          firstFailedBoundary = 'CodeScope Execution'
          reasonCode = reasonCode ?? 'REQUEST_TIMEOUT'

          const mcpAcc = accumulated.get('MCP Request')!
          mcpAcc.failed = false
          mcpAcc.succeeded = true
          mcpAcc.reasonCode = null
          const mcpNonErrorDurations = events
            .filter((e) => toCanonicalStage(e.stage) === 'MCP Request' && e.status !== 'error')
            .map((e) => e.durationMs)
            .filter((d): d is number => d !== undefined && d !== null)
          if (mcpNonErrorDurations.length > 0) {
            mcpAcc.durationMs = Math.max(...mcpNonErrorDurations)
          }

          const csAcc = accumulated.get('CodeScope Execution')!
          csAcc.failed = true
          csAcc.reasonCode = reasonCode
          csAcc.durationMs = Math.max(csAcc.durationMs ?? 0, durationMs)
        }
      }
    }
  }

  let lastSuccessfulStage: CanonicalStage | null = null
  if (firstFailedIndex !== -1) {
    for (let i = 0; i < firstFailedIndex; i++) {
      const stage = CANONICAL_PIPELINE[i]
      const acc = accumulated.get(stage)!
      if (acc.seen && !acc.failed) {
        lastSuccessfulStage = stage
      }
    }
  }

  let hasContradictoryExecution = false
  if (firstFailedIndex !== -1) {
    const relayInboundIdx = pipelineIndexOf('Relay Inbound')
    for (let i = firstFailedIndex + 1; i < CANONICAL_PIPELINE.length; i++) {
      const acc = accumulated.get(CANONICAL_PIPELINE[i])!
      if (firstFailedIndex < pipelineIndexOf('MCP Request')) {
        if (acc.succeeded) {
          hasContradictoryExecution = true
          break
        }
      } else {
        if (i >= relayInboundIdx && acc.succeeded) {
          hasContradictoryExecution = true
          break
        }
      }
    }
  }

  const hasDelivery = events.some((e) =>
    (e.stage === 'gateway-response-delivered' ||
     e.stage === 'http-response-returned' ||
     e.stage === 'client-response-completed' ||
     e.stage === 'relay-response-delivered') &&
    e.status === 'success'
  )

  const success = firstFailedBoundary === null && hasDelivery

  const stages: CanonicalStageResult[] = CANONICAL_PIPELINE.map((stage) => {
    const acc = accumulated.get(stage)!
    const idx = pipelineIndexOf(stage)
    let status: StageStatus
    if (firstFailedIndex !== -1) {
      if (idx === firstFailedIndex) {
        status = 'FAILED'
      } else if (idx > firstFailedIndex) {
        status = 'BLOCKED'
      } else {
        status = acc.seen ? 'OPERATIONAL' : 'UNKNOWN'
      }
    } else {
      status = acc.seen ? 'OPERATIONAL' : 'UNKNOWN'
    }
    return {
      stage,
      status,
      durationMs: status === 'BLOCKED' ? null : acc.durationMs,
      reasonCode: status === 'FAILED' ? acc.reasonCode : null
    }
  })

  return { traceId, operation, startedAt, completedAt, durationMs, success, stages, firstFailedBoundary, lastSuccessfulStage, reasonCode, hasContradictoryExecution }
}
