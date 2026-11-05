export class UnitFlowInvalidPlanError extends Error {
  constructor(reason: string) {
    super(`INVALID_PLAN: ${reason}`)
    this.name = 'UnitFlowInvalidPlanError'
  }
}

export class UnitFlowPlanConflictError extends Error {
  constructor(reason: string) {
    super(`PLAN_CONFLICT: ${reason}`)
    this.name = 'UnitFlowPlanConflictError'
  }
}

export class UnitFlowActivePlanAlreadyExistsError extends UnitFlowPlanConflictError {
  constructor(sessionId: string, existingPlanId: string) {
    super(`ACTIVE_PLAN_ALREADY_EXISTS: Session "${sessionId}" already has an active plan "${existingPlanId}"`)
    this.name = 'UnitFlowActivePlanAlreadyExistsError'
  }
}
