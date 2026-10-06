import type { McpToolDefinition, McpToolResult } from '../mcp/channel-mcp-adapter'
import { CODESCOPE_FUNCTIONAL_TOOLS, type SystemHealthCore } from './system-health-core'
import { CANONICAL_PIPELINE } from './canonical-pipeline'
import type {
  CanonicalStage,
  CurrentHealthState,
  DiagnosisFaultScope,
  LastFailureDiagnosis,
  StageStatus,
  SystemHealthDiagnosis
} from '../../shared/types/system-health-types'
import { getCodeScopeInvestigationTarget } from './codescope-investigation-targets'

import type { RuntimeIdentitySummary } from '../runtime-identity/runtime-identity-types'

export interface SystemHealthDiagnosticPayload {
  feature: 'codescope'
  status: 'OPERATIONAL' | 'DEGRADED' | 'UNAVAILABLE' | 'UNKNOWN' | 'CHECKING'
  operation: string | null
  traceId: string | null
  durationMs: number | null
  firstFailedBoundary: CanonicalStage | null
  lastSuccessfulStage: CanonicalStage | null
  reasonCode: string | null
  diagnosis: SystemHealthDiagnosis
  currentHealth: CurrentHealthState
  runtimeIdentity?: RuntimeIdentitySummary | null
  lastFailureDiagnosis: LastFailureDiagnosis | null
  lastFunctionalProof: {
    operation: string
    traceId: string
    at: string
    durationMs: number
    runtimeInstanceId?: string | null
  } | null
  lastFailure: {
    operation: string
    traceId: string
    at: string
    firstFailedBoundary: CanonicalStage | null
    reasonCode: string | null
    lastSuccessfulStage: CanonicalStage | null
    runtimeInstanceId?: string | null
    isHistoricalRuntime?: boolean
  } | null
  stages: Array<{
    name: CanonicalStage
    status: StageStatus | 'STALE'
    durationMs?: number | null
    reasonCode?: string | null
  }>
  stale: boolean
}

export const SYSTEM_HEALTH_MCP_TOOL: McpToolDefinition = {
  name: 'get_system_health',
  description:
    'Inspect the operational health and diagnostic trace of Code Awareness features (currently CodeScope). Use when encountering a failure, timeout, degraded integration, unexpected behavior, or during debugging to identify the exact failed boundary and reason code before investigating. Do not call routinely without operational uncertainty.',
  inputSchema: {
    type: 'object',
    properties: {
      feature: {
        type: 'string',
        description: 'The feature subsystem to inspect. Supported values: "codescope". Defaults to "codescope".'
      }
    },
    additionalProperties: false
  },
  securitySchemes: [{ type: 'oauth2', scopes: [] }]
}

export function executeGetSystemHealth(core: SystemHealthCore, args: unknown): McpToolResult {
  if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
    return {
      content: [{ type: 'text', text: 'INVALID_ARGUMENT: Expected an arguments object' }],
      isError: true
    }
  }

  const values = (args ?? {}) as Record<string, unknown>
  const feature = values.feature

  if (feature !== undefined && feature !== null) {
    if (typeof feature !== 'string' || feature !== 'codescope') {
      return {
        content: [
          {
            type: 'text',
            text: `SYSTEM_HEALTH_FEATURE_NOT_SUPPORTED: Feature "${String(feature)}" is not supported by System Health. Only "codescope" is supported in V1.`
          }
        ],
        isError: true
      }
    }
  }

  const state = core.getState()
  const failure = state.lastFailure
  const proof = state.lastFunctionalProof && CODESCOPE_FUNCTIONAL_TOOLS.has(state.lastFunctionalProof.operation)
    ? state.lastFunctionalProof
    : null

  let failureDiagnosis: LastFailureDiagnosis | null = null
  let failureDurationMs: number | null = null
  if (failure) {
    failureDurationMs = failure.stages.find((s) => s.stage === failure.firstFailedBoundary)?.durationMs ?? null
    if (failure.reasonCode === 'REQUEST_TIMEOUT' && (failureDurationMs === null || failureDurationMs > 30_000)) {
      failureDurationMs = 30_000
    }
    const failedStageIdx = failure.firstFailedBoundary ? CANONICAL_PIPELINE.indexOf(failure.firstFailedBoundary) : -1
    const firstBlockedStage = failedStageIdx !== -1 && failedStageIdx + 1 < CANONICAL_PIPELINE.length
      ? CANONICAL_PIPELINE[failedStageIdx + 1]
      : null

    const drilldown = failure.drilldown
    const drilldownPayload = drilldown
      ? {
          canonicalStage: drilldown.canonicalStage,
          state: drilldown.state,
          precision: drilldown.precision,
          lastSuccessfulCheckpoint: drilldown.lastSuccessfulCheckpoint,
          firstFailedCheckpoint: drilldown.firstFailedCheckpoint,
          firstBlockedCheckpoint: drilldown.firstBlockedCheckpoint,
          reasonCode: drilldown.reasonCode,
          checkpoints: drilldown.checkpoints,
          ...(drilldown.missingEvidence?.length ? { missingEvidence: drilldown.missingEvidence } : {}),
          ...(drilldown.deepestProvenProgress ? { deepestProvenProgress: drilldown.deepestProvenProgress } : {}),
          ...(drilldown.diagnosticFrontier ? { diagnosticFrontier: drilldown.diagnosticFrontier } : {}),
          ...(drilldown.diagnosticResolution ? { diagnosticResolution: drilldown.diagnosticResolution } : {}),
          ...(drilldown.observabilityGap ? { observabilityGap: drilldown.observabilityGap } : {}),
          ...(drilldown.nextBestEvidence ? { nextBestEvidence: drilldown.nextBestEvidence } : {})
        }
      : undefined

    let investigationTarget = getCodeScopeInvestigationTarget(failure.firstFailedBoundary, failure.reasonCode)
    if (drilldown?.refinedInvestigationTarget) {
      investigationTarget = drilldown.refinedInvestigationTarget
    }

    let faultScope: DiagnosisFaultScope
    if (failure.hasContradictoryExecution) {
      faultScope = {
        precision: 'BOUNDED',
        lastSuccessfulStage: failure.lastSuccessfulStage,
        firstFailedStage: failure.firstFailedBoundary,
        firstFailedBoundary: failure.firstFailedBoundary,
        firstBlockedStage
      }
    } else if (drilldown) {
      faultScope = {
        precision: drilldown.precision,
        lastSuccessfulStage: failure.lastSuccessfulStage,
        firstFailedStage: failure.firstFailedBoundary,
        firstFailedBoundary: failure.firstFailedBoundary,
        firstBlockedStage
      }
    } else {
      const precision = failure.firstFailedBoundary === 'Relay Inbound' ? 'BOUNDED' : 'EXACT'
      faultScope = {
        precision,
        lastSuccessfulStage: failure.lastSuccessfulStage,
        firstFailedStage: failure.firstFailedBoundary,
        firstFailedBoundary: failure.firstFailedBoundary,
        firstBlockedStage
      }
    }

    failureDiagnosis = {
      operation: failure.operation,
      traceId: failure.traceId,
      at: failure.at,
      reasonCode: failure.reasonCode,
      firstFailedBoundary: failure.firstFailedBoundary,
      lastSuccessfulStage: failure.lastSuccessfulStage,
      faultScope,
      ...(drilldownPayload ? { drilldown: drilldownPayload } : {}),
      investigationTarget,
      evidenceState: state.stale || Boolean(failure.isHistoricalRuntime) ? 'HISTORICAL' : 'CURRENT',
      runtimeInstanceId: failure.runtimeInstanceId ?? null,
      isHistoricalRuntime: failure.isHistoricalRuntime ?? false,
      ...(drilldown?.deepestProvenProgress ? { deepestProvenProgress: drilldown.deepestProvenProgress } : {}),
      ...(drilldown?.diagnosticFrontier ? { diagnosticFrontier: drilldown.diagnosticFrontier } : {}),
      ...(drilldown?.diagnosticResolution ? { diagnosticResolution: drilldown.diagnosticResolution } : {}),
      ...(drilldown?.observabilityGap ? { observabilityGap: drilldown.observabilityGap } : {}),
      ...(drilldown?.nextBestEvidence ? { nextBestEvidence: drilldown.nextBestEvidence } : {})
    }
  }

  let operation: string | null = null
  let traceId: string | null = null
  let durationMs: number | null = null
  let firstFailedBoundary: CanonicalStage | null = null
  let lastSuccessfulStage: CanonicalStage | null = null
  let reasonCode: string | null = null
  let stages: SystemHealthDiagnosticPayload['stages']
  let diagnosis: SystemHealthDiagnosis

  if (state.stale) {
    if (failure && failureDiagnosis) {
      operation = failure.operation
      traceId = failure.traceId
      durationMs = failureDurationMs
      firstFailedBoundary = failure.firstFailedBoundary
      lastSuccessfulStage = failure.lastSuccessfulStage
      reasonCode = failure.reasonCode
      diagnosis = {
        state: failure.hasContradictoryExecution ? 'INSUFFICIENT_EVIDENCE' : (failure.drilldown?.state ?? 'LOCALIZED'),
        faultScope: failureDiagnosis.faultScope,
        investigationTarget: failureDiagnosis.investigationTarget,
        disposition: 'REPRODUCE',
        evidenceState: 'HISTORICAL',
        ...(failureDiagnosis.drilldown ? { drilldown: failureDiagnosis.drilldown } : {}),
        ...(failureDiagnosis.deepestProvenProgress ? { deepestProvenProgress: failureDiagnosis.deepestProvenProgress } : {}),
        ...(failureDiagnosis.diagnosticFrontier ? { diagnosticFrontier: failureDiagnosis.diagnosticFrontier } : {}),
        ...(failureDiagnosis.diagnosticResolution ? { diagnosticResolution: failureDiagnosis.diagnosticResolution } : {}),
        ...(failureDiagnosis.observabilityGap ? { observabilityGap: failureDiagnosis.observabilityGap } : {}),
        ...(failureDiagnosis.nextBestEvidence ? { nextBestEvidence: failureDiagnosis.nextBestEvidence } : {})
      }
    } else {
      diagnosis = {
        state: 'STALE',
        faultScope: null,
        investigationTarget: null,
        disposition: 'REPRODUCE',
        evidenceState: 'HISTORICAL'
      }
    }
    stages = CANONICAL_PIPELINE.map((stage) => ({
      name: stage,
      status: 'STALE' as const
    }))
  } else if (state.status === 'DEGRADED' && failure && failureDiagnosis) {
    operation = failure.operation
    traceId = failure.traceId
    durationMs = failureDurationMs
    firstFailedBoundary = failure.firstFailedBoundary
    lastSuccessfulStage = failure.lastSuccessfulStage
    reasonCode = failure.reasonCode
    stages = failure.stages.map((s) => ({
      name: s.stage,
      status: s.status,
      ...(s.durationMs !== null ? { durationMs: s.durationMs } : {}),
      ...(s.reasonCode ? { reasonCode: s.reasonCode } : {})
    }))

    const drilldown = failure.drilldown
    if (failure.hasContradictoryExecution) {
      diagnosis = {
        state: 'INSUFFICIENT_EVIDENCE',
        faultScope: failureDiagnosis.faultScope,
        investigationTarget: failureDiagnosis.investigationTarget,
        disposition: 'COLLECT_EVIDENCE',
        evidenceState: 'CURRENT',
        ...(failureDiagnosis.drilldown ? { drilldown: failureDiagnosis.drilldown } : {}),
        ...(failureDiagnosis.deepestProvenProgress ? { deepestProvenProgress: failureDiagnosis.deepestProvenProgress } : {}),
        ...(failureDiagnosis.diagnosticFrontier ? { diagnosticFrontier: failureDiagnosis.diagnosticFrontier } : {}),
        ...(failureDiagnosis.diagnosticResolution ? { diagnosticResolution: failureDiagnosis.diagnosticResolution } : {}),
        ...(failureDiagnosis.observabilityGap ? { observabilityGap: failureDiagnosis.observabilityGap } : {}),
        ...(failureDiagnosis.nextBestEvidence ? { nextBestEvidence: failureDiagnosis.nextBestEvidence } : {})
      }
    } else if (drilldown) {
      const diagState = drilldown.state
      const disposition =
        diagState === 'LOCALIZED'
          ? 'INSPECT_CODE'
          : drilldown.missingEvidence?.length
            ? 'EXTEND_SYSTEM_HEALTH'
            : 'COLLECT_EVIDENCE'

      diagnosis = {
        state: diagState,
        faultScope: failureDiagnosis.faultScope,
        investigationTarget: failureDiagnosis.investigationTarget,
        disposition,
        evidenceState: 'CURRENT',
        ...(drilldown.missingEvidence?.length ? { missingEvidence: drilldown.missingEvidence } : {}),
        drilldown: failureDiagnosis.drilldown,
        ...(drilldown.deepestProvenProgress ? { deepestProvenProgress: drilldown.deepestProvenProgress } : {}),
        ...(drilldown.diagnosticFrontier ? { diagnosticFrontier: drilldown.diagnosticFrontier } : {}),
        ...(drilldown.diagnosticResolution ? { diagnosticResolution: drilldown.diagnosticResolution } : {}),
        ...(drilldown.observabilityGap ? { observabilityGap: drilldown.observabilityGap } : {}),
        ...(drilldown.nextBestEvidence ? { nextBestEvidence: drilldown.nextBestEvidence } : {})
      }
    } else {
      diagnosis = {
        state: 'LOCALIZED',
        faultScope: failureDiagnosis.faultScope,
        investigationTarget: failureDiagnosis.investigationTarget,
        disposition: 'INSPECT_CODE',
        evidenceState: 'CURRENT'
      }
    }
  } else if (state.status === 'OPERATIONAL' && proof) {
    operation = proof.operation
    traceId = proof.traceId
    durationMs = proof.durationMs
    firstFailedBoundary = null
    lastSuccessfulStage = 'Client Response'
    reasonCode = null
    stages = CANONICAL_PIPELINE.map((stage) => ({
      name: stage,
      status: 'OPERATIONAL' as const
    }))
    diagnosis = {
      state: 'NO_ACTIVE_FAILURE',
      faultScope: null,
      investigationTarget: null,
      disposition: 'NONE',
      evidenceState: 'CURRENT'
    }
  } else {
    stages = CANONICAL_PIPELINE.map((stage) => ({
      name: stage,
      status: 'UNKNOWN' as const
    }))
    diagnosis = {
      state: 'NO_ACTIVE_FAILURE',
      faultScope: null,
      investigationTarget: null,
      disposition: 'NONE',
      evidenceState: 'CURRENT'
    }
  }

  const currentHealth: CurrentHealthState = {
    status: state.status,
    stale: state.stale,
    stages
  }

  const payload: SystemHealthDiagnosticPayload = {
    feature: 'codescope',
    status: state.status,
    operation,
    traceId,
    durationMs,
    firstFailedBoundary,
    lastSuccessfulStage,
    reasonCode,
    diagnosis,
    currentHealth,
    runtimeIdentity: core.getRuntimeIdentityProvider()?.getSummary() ?? null,
    lastFailureDiagnosis: failureDiagnosis,
    lastFunctionalProof: proof
      ? {
          operation: proof.operation,
          traceId: proof.traceId,
          at: proof.at,
          durationMs: proof.durationMs,
          runtimeInstanceId: proof.runtimeInstanceId ?? null
        }
      : null,
    lastFailure: failure
      ? {
          operation: failure.operation,
          traceId: failure.traceId,
          at: failure.at,
          firstFailedBoundary: failure.firstFailedBoundary,
          reasonCode: failure.reasonCode,
          lastSuccessfulStage: failure.lastSuccessfulStage,
          runtimeInstanceId: failure.runtimeInstanceId ?? null,
          isHistoricalRuntime: failure.isHistoricalRuntime ?? false
        }
      : null,
    stages,
    stale: state.stale
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
  }
}

