import type {
  RegisterUnitFlowPlanInput,
  UnitFlowPlanRecord
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

  close(): void {
    if (this.ownsService) {
      this.smcService.close()
    }
  }
}
