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
