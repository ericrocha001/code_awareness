import type {
  DefineUnitFlowUnitInput,
  UnitFlowUnitStatus
} from './unitflow-types'
import type {
  EconomicSelectionDecision,
  EconomicSelectionPolicy,
  ExecutorSelection,
  NormalizedEconomicSelectionPolicy,
  PersistedEconomicDecisionRecord
} from './execution-types'

export type OrchestrationState =
  | 'READY'
  | 'STARTING'
  | 'RUNNING'
  | 'VALIDATION_READY'
  | 'RECONCILING'
  | 'COMPLETED'
  | 'UNKNOWN'

export interface PrepareUnitFlowPlanInput {
  readonly planId: string
  readonly title: string
  readonly objective: string
  readonly description?: string
  readonly sourceArtifactId?: string
  readonly units: readonly DefineUnitFlowUnitInput[]
}

export interface CompactUnitSummary {
  readonly unitId: string
  readonly position: number
  readonly title: string
  readonly state: UnitFlowUnitStatus | string
}

export interface PrepareUnitFlowPlanResult {
  readonly repositoryId: string
  readonly sessionId: string
  readonly planId: string
  readonly title: string
  readonly status: 'ACTIVE'
  readonly totalUnits: number
  readonly units: readonly CompactUnitSummary[]
  readonly replayed?: boolean
}

export interface BindUnitFlowWorkspaceResult {
  readonly repositoryId: string
  readonly sessionId: string
  readonly worktreeId: string
  readonly generation: string
  readonly branch: string
  readonly boundHead: string
  readonly boundAt: string
}

export interface StartNextUnitOptions {
  readonly reservationId: string
  readonly attemptId: string
  readonly stageOperationId: string
  readonly executorSelection?: ExecutorSelection
  readonly economicSelection?: EconomicSelectionPolicy | NormalizedEconomicSelectionPolicy
}

export interface StartedUnitFlowResult {
  readonly repositoryId: string
  readonly sessionId: string
  readonly planId: string
  readonly unitId: string
  readonly reservationId: string
  readonly attemptId: string
  readonly stageOperationId: string
  readonly status: string
  readonly reason?: string | null
  readonly proposalId?: string | null
  readonly executionId?: string | null
  readonly timeoutProfile?: string
  readonly timeoutMs?: number
  readonly executorSelection?: ExecutorSelection | null
  readonly economicDecision?: PersistedEconomicDecisionRecord | EconomicSelectionDecision | null
  readonly replayed?: boolean
}

export interface UnitFlowStatusResult {
  readonly repositoryId: string
  readonly sessionId: string
  readonly plan: {
    readonly planId: string
    readonly title: string
    readonly status: string
    readonly totalUnits: number
    readonly completedUnits: number
    readonly units: readonly CompactUnitSummary[]
  } | null
  readonly workspace: {
    readonly worktreeId: string
    readonly branch: string
    readonly generation: string
    readonly boundHead: string
    readonly status: string
    readonly currentHead?: string | null
  } | null
  readonly currentUnit: CompactUnitSummary | null
  readonly activeAttempt: {
    readonly attemptId: string
    readonly reservationId: string
    readonly unitId: string
    readonly status: string
    readonly cliExecutionId?: string | null
    readonly exitCode?: number | null
    readonly terminalReason?: string | null
    readonly lastSummary?: string | null
  } | null
  readonly orchestrationState: OrchestrationState
  readonly nextAllowedActions: readonly string[]
}

export interface SettleUnitFlowResult {
  readonly repositoryId: string
  readonly sessionId: string
  readonly attemptId: string
  readonly unitId: string
  readonly settled: boolean
  readonly attemptStatus: string
  readonly unitState: string
  readonly exitCode: number | null
  readonly terminalReason: string | null
  readonly timeoutProfile?: string
  readonly timeoutMs?: number
}

export interface AcceptUnitFlowOptions {
  readonly operationId: string
  readonly proofIds: readonly string[]
  readonly summary: string
  readonly semanticDecision?: 'ACCEPTED' | 'REJECTED'
  readonly emitterId?: string
}

export interface AcceptUnitFlowResult {
  readonly repositoryId: string
  readonly sessionId: string
  readonly attemptId: string
  readonly unitId?: string
  readonly status: 'ACCEPTED' | 'REJECTED' | 'EVIDENCE_REQUIRED' | 'STALE' | 'CONFLICT' | 'UNKNOWN'
  readonly reason?: string | null
  readonly decisionEntryId?: string | null
  readonly nextEligibleUnitId?: string | null
}

export interface ReconcileUnitFlowOptions {
  readonly operationId: string
  readonly action?: 'RETRY_SAME_UNIT'
  readonly summary: string
  readonly emitterId?: string
}

export interface ReconcileUnitFlowResult {
  readonly repositoryId: string
  readonly sessionId: string
  readonly attemptId: string
  readonly unitId?: string
  readonly status: string
  readonly unitState?: string
  readonly reason?: string | null
  readonly reconciliationOperationId?: string | null
}
