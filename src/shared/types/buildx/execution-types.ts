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
  readonly createdAt: string
  readonly updatedAt: string
}

export interface PrepareExecutionAttemptOptions {
  readonly attemptId: string
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
