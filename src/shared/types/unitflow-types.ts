export type UnitFlowPlanStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED'

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
