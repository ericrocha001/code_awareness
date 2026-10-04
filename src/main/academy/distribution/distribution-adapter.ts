import type { AcademyDestination, AcademyDistributionState, AcademyDistributionStatus, AcademyDistributionTarget, AcademySkillDetail } from '../../../shared/types/academy-types'

export interface AcademyDistributionContext {
  destination: AcademyDestination
  skill: AcademySkillDetail
  previous: AcademyDistributionState | null
}

export interface AcademyDistributionAdapterResult {
  status: AcademyDistributionStatus
  distributedVersion: number | null
  distributedHash: string | null
  errorCode: string | null
  errorMessage: string | null
  exposureName: string | null
  linkMechanism: 'SYMLINK' | 'JUNCTION' | null
}

export interface AcademyDistributionAdapter {
  readonly target: AcademyDistributionTarget
  inspect(context: AcademyDistributionContext): Promise<AcademyDistributionAdapterResult>
  reconcile(context: AcademyDistributionContext): Promise<AcademyDistributionAdapterResult>
  remove(context: AcademyDistributionContext): Promise<AcademyDistributionAdapterResult | null>
}
