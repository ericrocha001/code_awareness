export type CanonicalStage =
  | 'Remote Request'
  | 'Access Assertion'
  | 'Identity Resolution'
  | 'Installation Routing'
  | 'Relay Outbound'
  | 'Desktop Request'
  | 'MCP Request'
  | 'CodeScope Execution'
  | 'MCP Response'
  | 'Relay Inbound'
  | 'Gateway Response'
  | 'Client Response'

export type StageStatus = 'OPERATIONAL' | 'FAILED' | 'BLOCKED' | 'UNKNOWN'

export interface CanonicalStageResult {
  stage: CanonicalStage
  status: StageStatus
  durationMs: number | null
  reasonCode: string | null
}

export interface SystemHealthState {
  revision: number
  feature: 'CodeScope'
  status: 'OPERATIONAL' | 'DEGRADED' | 'UNAVAILABLE' | 'UNKNOWN' | 'CHECKING'
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
    stages: CanonicalStageResult[]
    hasContradictoryExecution?: boolean
    drilldown?: StageDrilldownResult | null
    runtimeInstanceId?: string | null
    isHistoricalRuntime?: boolean
  } | null
  stale: boolean
}

export type DiagnosisState =
  | 'NO_ACTIVE_FAILURE'
  | 'LOCALIZED'
  | 'BOUNDED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'STALE'

export type FaultScopePrecision = 'EXACT' | 'BOUNDED'

export type DiagnosisDisposition =
  | 'INSPECT_CODE'
  | 'REPRODUCE'
  | 'COLLECT_EVIDENCE'
  | 'EXTEND_SYSTEM_HEALTH'
  | 'NONE'

export interface DiagnosisFaultScope {
  precision: FaultScopePrecision
  lastSuccessfulStage: CanonicalStage | null
  firstFailedStage: CanonicalStage | null
  firstFailedBoundary: CanonicalStage | null
  firstBlockedStage: CanonicalStage | null
}

export interface InvestigationTarget {
  systemArea: string
  component: string
  boundary: string
  responsibility: string
  investigationSeeds: string[]
}

export interface CheckpointResult {
  name: string
  status: StageStatus
  durationMs?: number | null
  reasonCode?: string | null
}

export type DiagnosticResolution = 'FEATURE' | 'STAGE' | 'CHECKPOINT' | 'COMPONENT'

export type ObservabilityGapState = 'NONE' | 'EVIDENCE_AVAILABLE' | 'EVIDENCE_MISSING' | 'REPRODUCTION_REQUIRED'

export interface ObservabilityGap {
  state: ObservabilityGapState
  currentBoundary?: string
  missingEvidence?: string[]
  reason?: string
  instrumentationAvailable?: boolean
}

export interface NextBestEvidence {
  evidenceKey: string
  boundary: string
  diagnosticValue: string
  instrumentationState: 'AVAILABLE' | 'MISSING'
}

export interface DiagnosticFrontier {
  lastProven: string | null
  at: string
  nextBlocked?: string | null
  precision: FaultScopePrecision
}

export interface StageDrilldownDiagnosis {
  canonicalStage: CanonicalStage
  state: DiagnosisState
  precision: FaultScopePrecision
  lastSuccessfulCheckpoint: string | null
  firstFailedCheckpoint: string | null
  firstBlockedCheckpoint: string | null
  reasonCode: string | null
  checkpoints: CheckpointResult[]
  missingEvidence?: string[]
  deepestProvenProgress?: string | null
  diagnosticFrontier?: DiagnosticFrontier | null
  diagnosticResolution?: DiagnosticResolution | null
  observabilityGap?: ObservabilityGapState | ObservabilityGap | null
  nextBestEvidence?: NextBestEvidence | null
}

export interface StageDrilldownResult extends StageDrilldownDiagnosis {
  refinedInvestigationTarget?: InvestigationTarget | null
  resolutionSufficient?: boolean
}

export interface StageDrilldownProvider {
  readonly canonicalStage: CanonicalStage
  evaluate(
    events: import('../../main/mcp/code-scope-health').CodeScopeTraceEvent[],
    failureReason?: string | null
  ): StageDrilldownResult | null
}

export type EvidenceState = 'CURRENT' | 'HISTORICAL'

export interface SystemHealthDiagnosis {
  state: DiagnosisState
  faultScope?: DiagnosisFaultScope | null
  investigationTarget?: InvestigationTarget | null
  disposition: DiagnosisDisposition
  missingEvidence?: string[]
  drilldown?: StageDrilldownDiagnosis
  evidenceState?: EvidenceState
  deepestProvenProgress?: string | null
  diagnosticFrontier?: DiagnosticFrontier | null
  diagnosticResolution?: DiagnosticResolution | null
  observabilityGap?: ObservabilityGapState | ObservabilityGap | null
  nextBestEvidence?: NextBestEvidence | null
}

export interface CurrentHealthState {
  status: 'OPERATIONAL' | 'DEGRADED' | 'UNAVAILABLE' | 'UNKNOWN' | 'CHECKING'
  stale: boolean
  stages?: Array<{
    name: CanonicalStage
    status: StageStatus | 'STALE'
    durationMs?: number | null
    reasonCode?: string | null
  }>
}

export interface LastFailureDiagnosis {
  operation: string
  traceId: string
  at: string
  reasonCode: string | null
  firstFailedBoundary: CanonicalStage | null
  lastSuccessfulStage: CanonicalStage | null
  faultScope: DiagnosisFaultScope | null
  drilldown?: StageDrilldownDiagnosis
  investigationTarget: InvestigationTarget | null
  evidenceState: EvidenceState
  deepestProvenProgress?: string | null
  diagnosticFrontier?: DiagnosticFrontier | null
  diagnosticResolution?: DiagnosticResolution | null
  observabilityGap?: ObservabilityGapState | ObservabilityGap | null
  nextBestEvidence?: NextBestEvidence | null
  runtimeInstanceId?: string | null
  isHistoricalRuntime?: boolean
}

