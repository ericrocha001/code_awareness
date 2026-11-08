export type UnitFlowPlanStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED'

export type UnitFlowUnitStatus =
  | 'AVAILABLE'
  | 'RESERVED'
  | 'EXECUTING'
  | 'VALIDATING'
  | 'COMPLETED'
  | 'RECONCILING'

export interface UnitFlowPlanRecord {
  readonly planId: string
  readonly sessionId: string
  readonly repositoryId: string
  readonly title: string
  readonly sourceArtifactId?: string
  readonly status: UnitFlowPlanStatus
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface RegisterUnitFlowPlanInput {
  readonly planId: string
  readonly title: string
  readonly sourceArtifactId?: string
}

export interface DefineUnitFlowUnitInput {
  readonly unitId: string
  readonly title: string
  readonly objective: string
  readonly acceptanceCriteria: string
  readonly dependsOnUnitIds?: readonly string[]
}

export interface UnitFlowUnitHeaderRecord {
  readonly unitId: string
  readonly planId: string
  readonly position: number
  readonly title: string
  readonly dependsOnUnitIds: readonly string[]
  readonly createdAt: string
}

export interface UnitFlowUnitRecord extends UnitFlowUnitHeaderRecord {
  readonly objective: string
  readonly acceptanceCriteria: string
}

export interface UnitFlowUnitStateRecord {
  readonly unitId: string
  readonly planId: string
  readonly status: UnitFlowUnitStatus
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
}

export type UnitFlowEligibilityResult =
  | { readonly kind: 'ELIGIBLE'; readonly unitId: string; readonly position: number; readonly title: string; readonly status: UnitFlowUnitStatus }
  | { readonly kind: 'MANIFEST_UNDEFINED' }
  | { readonly kind: 'WAITING'; readonly blockingUnitId: string }
  | { readonly kind: 'ALL_UNITS_COMPLETED' }

export type UnitFlowReservationStatus = 'ACTIVE' | 'CONSUMED' | 'CANCELLED'

export interface UnitFlowReservationRecord {
  readonly reservationId: string
  readonly repositoryId: string
  readonly sessionId: string
  readonly planId: string
  readonly unitId: string
  readonly worktreeId: string
  readonly generation: string
  readonly branch: string
  readonly headObservedAtReservation: string
  readonly unitStateRevision: number
  readonly status: UnitFlowReservationStatus
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ReserveUnitFlowUnitOptions {
  readonly reservationId: string
}

export type UnitFlowReservationResult =
  | { readonly kind: 'RESERVED'; readonly reservation: UnitFlowReservationRecord }
  | { readonly kind: 'MANIFEST_UNDEFINED' }
  | { readonly kind: 'WAITING'; readonly blockingUnitId: string }
  | { readonly kind: 'ALL_UNITS_COMPLETED' }



export type UnitAcceptanceStatus =
  | 'ACCEPTED'
  | 'EVIDENCE_REQUIRED'
  | 'STALE'
  | 'CONFLICT'
  | 'UNKNOWN'

export interface AcceptValidatedUnitOptions {
  readonly acceptanceOperationId: string
  readonly proofIds: readonly string[]
  readonly acceptanceSummary: string
  readonly emitterId?: string
}

export interface UnitAcceptanceResult {
  readonly status: UnitAcceptanceStatus
  readonly repositoryId: string
  readonly sessionId: string
  readonly planId?: string
  readonly unitId?: string
  readonly unitStatus?: UnitFlowUnitStatus
  readonly reservationStatus?: UnitFlowReservationStatus
  readonly planStatus?: UnitFlowPlanStatus
  readonly nextEligibleUnit?: UnitFlowEligibilityResult
  readonly acceptanceOperationId?: string
  readonly reason?: string
}

export interface AcceptUnitFlowUnitStoreInput {
  readonly sessionId: string
  readonly planId: string
  readonly unitId: string
  readonly expectedUnitRevision: number
  readonly reservationId: string
  readonly attemptId: string
  readonly acceptanceOperationId: string
  readonly proofIds: readonly string[]
  readonly acceptanceSummary: string
  readonly gitIdentity: {
    readonly worktreeId: string
    readonly generation: string
    readonly branch: string
    readonly head: string
  }
  readonly emitterId?: string
}

export interface AcceptUnitFlowUnitStoreResult {
  readonly unitId: string
  readonly planId: string
  readonly unitStatus: UnitFlowUnitStatus
  readonly unitRevision: number
  readonly reservationStatus: UnitFlowReservationStatus
  readonly planStatus: UnitFlowPlanStatus
  readonly planRevision: number
  readonly allUnitsCompleted: boolean
}
