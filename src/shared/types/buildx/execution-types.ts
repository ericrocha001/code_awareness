import type { UnitFlowUnitStatus } from './unitflow-types'

export interface ExecutorSelection {
  readonly executorId: string
  readonly providerId?: string | null
  readonly modelId?: string | null
}

export type ExecutorUsageProvenance =
  | 'EXECUTOR_REPORTED'
  | 'PROVIDER_BILLING_API'
  | 'ESTIMATED'
  | 'UNAVAILABLE'
  | 'UNKNOWN'

export type ExecutorBillingClassification =
  | 'ZERO_COST_CONFIRMED'
  | 'CHARGED'
  | 'UNKNOWN'

export interface ExecutorUsageRecord {
  readonly inputTokens?: number | null
  readonly outputTokens?: number | null
  readonly cacheReadTokens?: number | null
  readonly cacheWriteTokens?: number | null
  readonly totalTokens?: number | null
  readonly provenance: ExecutorUsageProvenance
}

export interface ExecutorBillingRecord {
  readonly upstreamCostUsd?: number | null
  readonly creditsUsed?: number | null
  readonly balanceDelta?: number | null
  readonly currency?: string | null
  readonly classification: ExecutorBillingClassification
  readonly provenance: ExecutorUsageProvenance
}

export interface ExecutorAttemptResult {
  readonly summary?: string | null
  readonly usage?: ExecutorUsageRecord
  readonly billing?: ExecutorBillingRecord
  readonly externalSessionId?: string | null
  readonly provenance: {
    readonly executorId: string
    readonly providerId?: string | null
    readonly modelId?: string | null
    readonly origin: string
  }
}

export type ExecutorRunStatus =
  | 'PREPARED'
  | 'AWAITING_APPROVAL'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'REFUSED'
  | 'INTERRUPTED'
  | 'UNAVAILABLE'
  | 'UNKNOWN'

export type ExecutorLifecyclePhase =
  | 'PREPARED'
  | 'AWAITING_APPROVAL'
  | 'LAUNCHING'
  | 'RUNNING'
  | 'STOPPING'
  | 'TERMINAL'
  | 'TERMINATION_UNCONFIRMED'

export interface ExecutorTerminationConfirmation {
  readonly confirmed: boolean
  readonly activeProcesses?: number
  readonly handlesClosed?: boolean
  readonly reason?: string
}

export type ExecutorEventKind =
  | 'PREPARED'
  | 'AWAITING_APPROVAL'
  | 'STARTED'
  | 'PROGRESS'
  | 'TOOL_ACTIVITY'
  | 'APPROVAL_REQUESTED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'REFUSED'
  | 'INTERRUPTED'

export interface ExecutorEvent {
  readonly eventId?: string
  readonly kind: ExecutorEventKind
  readonly attemptId: string
  readonly timestamp: string
  readonly phase?: ExecutorLifecyclePhase
  readonly status?: ExecutorRunStatus
  readonly message?: string
  readonly reason?: string
  readonly provenance: {
    readonly executorId: string
    readonly providerId?: string | null
    readonly modelId?: string | null
  }
}

export interface ExecutorAvailabilityResult {
  readonly available: boolean
  readonly reason?: string
}

export interface ExecutorWorktreeTarget {
  readonly worktreeId: string
  readonly generation: string
  readonly branch: string
  readonly path?: string
}

export interface ExecutorPromptReference {
  readonly stageOperationId: string
  readonly promptFilePath: string
  readonly promptHash?: string
  readonly promptBytes?: number
  readonly readPromptText?: () => string
}

export interface PrepareExecutorAttemptInput {
  readonly repositoryId: string
  readonly sessionId: string
  readonly planId: string
  readonly unitId: string
  readonly attemptId: string
  readonly worktree: ExecutorWorktreeTarget
  readonly prompt: ExecutorPromptReference
  readonly allowAlwaysApprove?: boolean
  readonly timeoutProfile?: string
  readonly timeoutMs?: number
}

export type ExecutorPreparationStatus = 'READY' | 'REFUSED' | 'UNAVAILABLE'

export interface ExecutorPreparedHandle {
  readonly preparedAttemptId: string
  readonly selection: ExecutorSelection
  readonly timeoutProfile?: string
  readonly timeoutMs?: number
}

export interface ExecutorPreparationResult {
  readonly status: ExecutorPreparationStatus
  readonly handle?: ExecutorPreparedHandle
  readonly reason?: string
}

export interface StartExecutorAttemptInput {
  readonly repositoryId: string
  readonly sessionId: string
  readonly attemptId: string
  readonly handle: ExecutorPreparedHandle
}

export interface ObserveExecutorAttemptInput {
  readonly repositoryId: string
  readonly sessionId: string
  readonly attemptId: string
}

export interface CancelExecutorAttemptInput {
  readonly repositoryId: string
  readonly sessionId: string
  readonly attemptId: string
}

export interface ExecutorRunObservation {
  readonly attemptId: string
  readonly status: ExecutorRunStatus
  readonly phase: ExecutorLifecyclePhase
  readonly selection: ExecutorSelection
  readonly reason?: string
  readonly exitCode?: number | null
  readonly durationMs?: number
  readonly timeoutProfile?: string
  readonly timeoutMs?: number
  readonly termination?: ExecutorTerminationConfirmation
  readonly events?: readonly ExecutorEvent[]
  readonly result?: ExecutorAttemptResult
  readonly legacyExecution?: {
    readonly status: string
    readonly phase?: string
    readonly treeObservation?: unknown
    readonly diagnostic?: string
  }
}

export type ExecutionAttemptStatus =
  | 'PREPARED'
  | 'STARTING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

export interface ExecutionAttemptRecord {
  readonly attemptId: string
  readonly repositoryId: string
  readonly sessionId: string
  readonly planId: string
  readonly unitId: string
  readonly reservationId: string
  readonly worktreeId: string
  readonly generation: string
  readonly branch: string
  readonly headObservedAtPreparation: string
  readonly status: ExecutionAttemptStatus
  readonly revision: number
  readonly executorSelection?: ExecutorSelection
  readonly createdAt: string
  readonly updatedAt: string
}

export interface PrepareExecutionAttemptOptions {
  readonly attemptId: string
  readonly executorSelection?: ExecutorSelection
}

export type GrokCliPreAdmissionStatus =
  | 'PROPOSAL_PREPARED'
  | 'CLI_NOT_AVAILABLE'
  | 'CLI_DISABLED'
  | 'CLI_INSTALLATION_UNVERIFIED'
  | 'PROJECT_CONTEXT_CHANGED'
  | 'WORKSPACE_INVALID'
  | 'ATTEMPT_INVALID'

export interface GrokCliPreAdmissionPreparedResult {
  readonly status: 'PROPOSAL_PREPARED'
  readonly proposalId: string
  readonly attemptId: string
  readonly sessionId: string
  readonly repositoryId: string
  readonly worktree: {
    readonly worktreeId: string
    readonly generation: string
    readonly branch: string
    readonly head: string
  }
  readonly executable: 'grok'
  readonly args: readonly ['version']
}

export interface GrokCliPreAdmissionRejectedResult {
  readonly status: Exclude<GrokCliPreAdmissionStatus, 'PROPOSAL_PREPARED'>
  readonly reason: string
  readonly attemptId: string
  readonly sessionId: string
  readonly repositoryId: string
}

export type GrokCliPreAdmissionResult =
  | GrokCliPreAdmissionPreparedResult
  | GrokCliPreAdmissionRejectedResult

export type GrokProbeStatus =
  | 'NOT_STARTED'
  | 'AWAITING_APPROVAL'
  | 'RUNNING'
  | 'INSTALLED_VERSION_OBSERVED'
  | 'UNAVAILABLE'
  | 'REFUSED'
  | 'FAILED'
  | 'INTERRUPTED'
  | 'UNKNOWN'

export interface GrokQualifications {
  readonly installedVersion: 'VERIFIED' | 'UNVERIFIED'
  readonly authentication: 'UNVERIFIED'
  readonly modelAccess: 'UNVERIFIED'
  readonly quota: 'UNVERIFIED'
  readonly headlessPrompt: 'UNVERIFIED'
  readonly fileEditing: 'UNVERIFIED'
  readonly agentPermissions: 'UNVERIFIED'
  readonly promptFileCompatibility: 'UNVERIFIED'
}

export interface GrokProbeDiagnosisResult {
  readonly status: GrokProbeStatus
  readonly probeOperationId: string
  readonly repositoryId: string
  readonly sessionId: string
  readonly attemptId: string
  readonly phase?: string
  readonly exitCode?: number | null
  readonly version?: string
  readonly reason?: string
  readonly qualifications: GrokQualifications
}

export type UnitPromptStageStatus =
  | 'READY'
  | 'FAILED'
  | 'EXPIRED'
  | 'RELEASED'
  | 'UNKNOWN'

export interface StageUnitPromptOptions {
  readonly stageOperationId: string
}

export interface UnitPromptStageResult {
  readonly success: boolean
  readonly status: UnitPromptStageStatus
  readonly stageOperationId: string
  readonly repositoryId: string
  readonly sessionId: string
  readonly attemptId: string
  readonly promptHash?: string
  readonly promptBytes?: number
  readonly headObserved?: string
  readonly createdAt?: string
  readonly expiresAt?: string
  readonly reason?: string
}

export interface UnitPromptStageInspection {
  readonly status: UnitPromptStageStatus
  readonly stageOperationId: string
  readonly repositoryId: string
  readonly sessionId: string
  readonly attemptId: string
  readonly promptHash?: string
  readonly promptBytes?: number
  readonly headObserved?: string
  readonly createdAt?: string
  readonly expiresAt?: string
  readonly reason?: string
}

export interface UnitPromptReleaseResult {
  readonly success: boolean
  readonly status: 'RELEASED' | 'UNKNOWN'
  readonly stageOperationId: string
  readonly repositoryId: string
  readonly sessionId: string
  readonly attemptId: string
  readonly reason?: string
}

export type UnitExecutionStatus =
  | 'AWAITING_APPROVAL'
  | 'RUNNING'
  | 'TERMINAL_OBSERVED'
  | 'UNAVAILABLE'
  | 'REFUSED'
  | 'UNKNOWN'

export interface StartUnitExecutionOptions {
  readonly stageOperationId: string
  readonly allowAlwaysApprove?: boolean
  readonly executorSelection?: ExecutorSelection
}

export interface UnitExecutionResult {
  readonly status: UnitExecutionStatus
  readonly attemptId: string
  readonly sessionId: string
  readonly repositoryId: string
  readonly executorId?: string
  readonly providerId?: string | null
  readonly modelId?: string | null
  readonly cliPhase?: string
  readonly cliStatus?: string
  readonly unitFlowStatus?: string
  readonly reason?: string
  readonly timeoutProfile?: string
  readonly timeoutMs?: number
  readonly usage?: ExecutorUsageRecord
  readonly billing?: ExecutorBillingRecord
}

export type UnitSettlementStatus =
  | 'VALIDATION_READY'
  | 'RECONCILING'
  | 'ACTIVE'
  | 'UNKNOWN'

export interface UnitSettlementResult {
  readonly status: UnitSettlementStatus
  readonly attemptId: string
  readonly sessionId: string
  readonly repositoryId: string
  readonly planId?: string
  readonly unitId?: string
  readonly attemptStatus?: ExecutionAttemptStatus
  readonly unitFlowStatus?: UnitFlowUnitStatus
  readonly executorId?: string
  readonly providerId?: string | null
  readonly modelId?: string | null
  readonly cliStatus?: string
  readonly cliPhase?: string
  readonly exitCode?: number | null
  readonly reason?: string
  readonly timeoutProfile?: string
  readonly timeoutMs?: number
  readonly usage?: ExecutorUsageRecord
  readonly billing?: ExecutorBillingRecord
}

export interface SettleExecutionAttemptStoreInput {
  readonly attemptId: string
  readonly expectedAttemptRevision: number
  readonly unitId: string
  readonly expectedUnitRevision: number
  readonly terminalOutcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
  readonly entryData?: {
    readonly title: string
    readonly body: string
    readonly kind: 'RESULT' | 'PENDING'
  }
}
