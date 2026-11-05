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
