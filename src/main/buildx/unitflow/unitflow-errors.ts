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

export class UnitFlowInvalidReservationIdError extends Error {
  constructor(id: string) {
    super(`INVALID_RESERVATION_ID: reservationId must be a valid UUID format, received: "${id}"`)
    this.name = 'UnitFlowInvalidReservationIdError'
  }
}

export class UnitFlowReservationConflictError extends Error {
  constructor(reason: string) {
    super(reason.startsWith('RESERVATION_') ? reason : `RESERVATION_CONFLICT: ${reason}`)
    this.name = 'UnitFlowReservationConflictError'
  }
}

export class UnitFlowReservationIdConflictError extends UnitFlowReservationConflictError {
  constructor(reservationId: string, reason: string) {
    super(`RESERVATION_ID_CONFLICT: Reservation "${reservationId}" ${reason}`)
    this.name = 'UnitFlowReservationIdConflictError'
  }
}

export class UnitFlowReservationNotFoundError extends Error {
  constructor(reservationId: string) {
    super(`RESERVATION_NOT_FOUND: Reservation "${reservationId}" not found`)
    this.name = 'UnitFlowReservationNotFoundError'
  }
}

export class UnitFlowAcceptanceConflictError extends Error {
  constructor(reason: string) {
    super(reason.startsWith('ACCEPTANCE_') ? reason : `ACCEPTANCE_CONFLICT: ${reason}`)
    this.name = 'UnitFlowAcceptanceConflictError'
  }
}
