export class ExecutionInvalidAttemptIdError extends Error {
  constructor(id: string) {
    super(`INVALID_ATTEMPT_ID: attemptId must be a valid UUID format, received: "${id}"`)
    this.name = 'ExecutionInvalidAttemptIdError'
  }
}

export class ExecutionAttemptConflictError extends Error {
  constructor(reason: string) {
    super(reason.startsWith('EXECUTION_') ? reason : `EXECUTION_ATTEMPT_CONFLICT: ${reason}`)
    this.name = 'ExecutionAttemptConflictError'
  }
}

export class ExecutionAttemptIdConflictError extends ExecutionAttemptConflictError {
  constructor(attemptId: string, reason: string) {
    super(`ATTEMPT_ID_CONFLICT: Execution attempt "${attemptId}" ${reason}`)
    this.name = 'ExecutionAttemptIdConflictError'
  }
}

export class ExecutionAttemptNotFoundError extends Error {
  constructor(attemptId: string) {
    super(`EXECUTION_ATTEMPT_NOT_FOUND: Execution attempt "${attemptId}" not found`)
    this.name = 'ExecutionAttemptNotFoundError'
  }
}
