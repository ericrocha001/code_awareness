import type {
  ReserveUnitFlowUnitOptions,
  UnitFlowReservationRecord,
  UnitFlowReservationResult
} from '../../../shared/types/buildx/unitflow-types'
import { BuildXWorkspaceInvalidError } from '../execution/workspace-binding-errors'
import type { GitOperationsResolver } from '../execution/workspace-binding-service'
import { WorkspaceBindingService } from '../execution/workspace-binding-service'
import { validateRepositoryId } from '../smc/session-memory-central-paths'
import type { SessionMemoryCentralService } from '../smc/session-memory-central-service'
import { SessionMemoryCentralService as SmcServiceImpl } from '../smc/session-memory-central-service'
import {
  SmcInvalidSessionIdError,
  SmcSessionClosedError,
  SmcSessionNotFoundError
} from '../smc/session-memory-central-store'
import {
  UnitFlowInvalidPlanError,
  UnitFlowInvalidReservationIdError,
  UnitFlowPlanConflictError,
  UnitFlowPlanNotFoundError,
  UnitFlowReservationIdConflictError
} from './unitflow-errors'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class UnitFlowReservationService {
  private readonly smcService: SessionMemoryCentralService
  private readonly workspaceService: WorkspaceBindingService
  private readonly ownsSmcService: boolean

  constructor(
    smcServiceOrBaseDir: SessionMemoryCentralService | string,
    workspaceServiceOrGit: WorkspaceBindingService | GitOperationsResolver
  ) {
    if (typeof smcServiceOrBaseDir === 'string') {
      this.smcService = new SmcServiceImpl(smcServiceOrBaseDir)
      this.ownsSmcService = true
    } else {
      this.smcService = smcServiceOrBaseDir
      this.ownsSmcService = false
    }

    if (workspaceServiceOrGit instanceof WorkspaceBindingService) {
      this.workspaceService = workspaceServiceOrGit
    } else {
      this.workspaceService = new WorkspaceBindingService(this.smcService, workspaceServiceOrGit)
    }
  }

  async reserveNextEligibleUnit(
    repositoryId: string,
    sessionId: string,
    planId: string,
    options: ReserveUnitFlowUnitOptions
  ): Promise<UnitFlowReservationResult> {
    const validRepoId = validateRepositoryId(repositoryId)

    if (typeof sessionId !== 'string' || !sessionId.trim() || !UUID_REGEX.test(sessionId.trim())) {
      throw new SmcInvalidSessionIdError(sessionId ?? '')
    }
    const cleanSessionId = sessionId.trim().toLowerCase()

    if (typeof planId !== 'string' || !planId.trim() || !UUID_REGEX.test(planId.trim())) {
      throw new UnitFlowInvalidPlanError(`planId must be a valid UUID format, received: "${planId}"`)
    }
    const cleanPlanId = planId.trim().toLowerCase()

    if (
      !options ||
      typeof options.reservationId !== 'string' ||
      !options.reservationId.trim() ||
      !UUID_REGEX.test(options.reservationId.trim())
    ) {
      throw new UnitFlowInvalidReservationIdError(options?.reservationId ?? '')
    }
    const cleanReservationId = options.reservationId.trim().toLowerCase()

    const store = this.smcService.getStore(validRepoId)

    // 1. Replay check imediato (idempotente sem tocar Git)
    const existing = store.getReservation(cleanReservationId)
    if (existing) {
      if (
        existing.repositoryId === validRepoId &&
        existing.sessionId === cleanSessionId &&
        existing.planId === cleanPlanId
      ) {
        return { kind: 'RESERVED', reservation: existing }
      }
      throw new UnitFlowReservationIdConflictError(
        cleanReservationId,
        `already exists with divergent scope (repo=${existing.repositoryId}, session=${existing.sessionId}, plan=${existing.planId})`
      )
    }

    // 2. Validação prévia de sessão e plano
    const session = this.smcService.getSession(validRepoId, cleanSessionId)
    if (!session) {
      throw new SmcSessionNotFoundError(cleanSessionId)
    }
    if (session.status === 'CLOSED') {
      throw new SmcSessionClosedError(cleanSessionId)
    }

    const plan = store.getPlan(cleanPlanId)
    if (!plan) {
      throw new UnitFlowPlanNotFoundError(cleanPlanId)
    }
    if (plan.sessionId !== cleanSessionId) {
      throw new UnitFlowPlanConflictError(`Plan "${cleanPlanId}" belongs to another session "${plan.sessionId}"`)
    }
    if (plan.status !== 'ACTIVE') {
      throw new UnitFlowPlanConflictError(`Plan "${cleanPlanId}" is not ACTIVE (status: ${plan.status})`)
    }

    // 3. Observação do workspace vinculado (exige status=CURRENT com head atual não vazio)
    const inspectResult = await this.workspaceService.inspectBoundWorkspace(validRepoId, cleanSessionId)
    if (inspectResult.status !== 'CURRENT') {
      const reasonSuffix = inspectResult.status !== 'UNBOUND' ? `, reason: ${(inspectResult as any).reason}` : ''
      throw new BuildXWorkspaceInvalidError(
        `Cannot reserve unit: workspace is not CURRENT (status: ${inspectResult.status}${reasonSuffix})`
      )
    }

    if (!inspectResult.currentHead || typeof inspectResult.currentHead !== 'string' || !inspectResult.currentHead.trim()) {
      throw new BuildXWorkspaceInvalidError('Cannot reserve unit: observed workspace currentHead is empty')
    }

    // 4. Executa transação atômica SQLite (confronta binding, seleciona unidade, CAS smc_unit_states, INSERT smc_unit_reservations)
    return store.reserveEligibleUnit({
      reservationId: cleanReservationId,
      sessionId: cleanSessionId,
      planId: cleanPlanId,
      expectedBinding: {
        worktreeId: inspectResult.binding.worktreeId,
        generation: inspectResult.binding.generation,
        branch: inspectResult.binding.branch
      },
      headObserved: inspectResult.currentHead
    })
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
    if (this.ownsSmcService) {
      this.smcService.close()
    }
  }
}
