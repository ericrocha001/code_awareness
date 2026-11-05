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

export class UnitFlowPlanNotFoundError extends Error {
  constructor(planId: string) {
    super(`PLAN_NOT_FOUND: Plan "${planId}" not found`)
    this.name = 'UnitFlowPlanNotFoundError'
  }
}

export class UnitFlowInvalidUnitError extends Error {
  constructor(reason: string) {
    super(`INVALID_UNIT: ${reason}`)
    this.name = 'UnitFlowInvalidUnitError'
  }
}

export class UnitFlowUnitConflictError extends Error {
  constructor(reason: string) {
    super(`UNIT_CONFLICT: ${reason}`)
    this.name = 'UnitFlowUnitConflictError'
  }
}

export class UnitFlowManifestConflictError extends UnitFlowUnitConflictError {
  constructor(planId: string, reason?: string) {
    super(
      reason
        ? `MANIFEST_CONFLICT: Plan "${planId}" already has a defined unit manifest: ${reason}`
        : `MANIFEST_CONFLICT: Plan "${planId}" already has a defined unit manifest`
    )
    this.name = 'UnitFlowManifestConflictError'
  }
}
