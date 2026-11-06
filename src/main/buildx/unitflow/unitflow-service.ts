import type {
  DefineUnitFlowUnitInput,
  RegisterUnitFlowPlanInput,
  UnitFlowEligibilityResult,
  UnitFlowPlanRecord,
  UnitFlowReservationRecord,
  UnitFlowUnitHeaderRecord,
  UnitFlowUnitRecord,
  UnitFlowUnitStateRecord
} from '../../../shared/types/buildx/unitflow-types'
import { validateRepositoryId } from '../smc/session-memory-central-paths'
import type { SessionMemoryCentralService } from '../smc/session-memory-central-service'
import { SessionMemoryCentralService as SmcServiceImpl } from '../smc/session-memory-central-service'

export class UnitFlowService {
  private readonly smcService: SessionMemoryCentralService
  private readonly ownsService: boolean

  constructor(serviceOrBaseDir: SessionMemoryCentralService | string) {
    if (typeof serviceOrBaseDir === 'string') {
      this.smcService = new SmcServiceImpl(serviceOrBaseDir)
      this.ownsService = true
    } else {
      this.smcService = serviceOrBaseDir
      this.ownsService = false
    }
  }

  registerPlan(
    repositoryId: string,
    sessionId: string,
    input: RegisterUnitFlowPlanInput
  ): UnitFlowPlanRecord {
    const validRepoId = validateRepositoryId(repositoryId)
    const store = this.smcService.getStore(validRepoId)
    return store.registerPlan(sessionId, input)
  }

  getActivePlan(
    repositoryId: string,
    sessionId: string
  ): UnitFlowPlanRecord | null {
    const validRepoId = validateRepositoryId(repositoryId)
    const store = this.smcService.getStore(validRepoId)
    return store.getActivePlan(sessionId)
  }

  getPlan(
    repositoryId: string,
    planId: string
  ): UnitFlowPlanRecord | null {
    const validRepoId = validateRepositoryId(repositoryId)
    const store = this.smcService.getStore(validRepoId)
    return store.getPlan(planId)
  }

  definePlanUnits(
    repositoryId: string,
    sessionId: string,
    planId: string,
    units: DefineUnitFlowUnitInput[]
  ): UnitFlowUnitRecord[] {
    const validRepoId = validateRepositoryId(repositoryId)
    const store = this.smcService.getStore(validRepoId)
    return store.definePlanUnits(sessionId, planId, units)
  }

  listPlanUnits(
    repositoryId: string,
    sessionId: string,
    planId: string
  ): UnitFlowUnitHeaderRecord[] {
    const validRepoId = validateRepositoryId(repositoryId)
    const store = this.smcService.getStore(validRepoId)
    return store.listPlanUnits(sessionId, planId)
  }

  getPlanUnit(
    repositoryId: string,
    sessionId: string,
    planId: string,
    unitId: string
  ): UnitFlowUnitRecord | null {
    const validRepoId = validateRepositoryId(repositoryId)
    const store = this.smcService.getStore(validRepoId)
    return store.getPlanUnit(sessionId, planId, unitId)
  }

  getUnitState(
    repositoryId: string,
    sessionId: string,
    planId: string,
    unitId: string
  ): UnitFlowUnitStateRecord | null {
    const validRepoId = validateRepositoryId(repositoryId)
    const store = this.smcService.getStore(validRepoId)
    return store.getUnitState(sessionId, planId, unitId)
  }

  getNextEligibleUnit(
    repositoryId: string,
    sessionId: string,
    planId: string
  ): UnitFlowEligibilityResult {
    const validRepoId = validateRepositoryId(repositoryId)
    const store = this.smcService.getStore(validRepoId)
    return store.getNextEligibleUnit(sessionId, planId)
  }

  getReservation(
    repositoryId: string,
    reservationId: string
  ): UnitFlowReservationRecord | null {
    const validRepoId = validateRepositoryId(repositoryId)
    const store = this.smcService.getStore(validRepoId)
    return store.getReservation(reservationId)
  }

  getActiveReservation(
    repositoryId: string,
    sessionId: string
  ): UnitFlowReservationRecord | null {
    const validRepoId = validateRepositoryId(repositoryId)
    const store = this.smcService.getStore(validRepoId)
    return store.getActiveReservation(sessionId)
  }

  close(): void {
    if (this.ownsService) {
      this.smcService.close()
    }
  }
}
