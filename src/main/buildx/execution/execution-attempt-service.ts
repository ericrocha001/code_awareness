import type {
  ExecutionAttemptRecord,
  ExecutorSelection,
  PrepareExecutionAttemptOptions
} from '../../../shared/types/buildx/execution-types'
import {
  executorSelectionsEqual,
  formatExecutorSelection,
  normalizeExecutorSelection
} from './executor-port'
import {
  BuildXWorkspaceBindingConflictError,
  BuildXWorkspaceInvalidError
} from './workspace-binding-errors'
import type { GitOperationsResolver } from './workspace-binding-service'
import { WorkspaceBindingService } from './workspace-binding-service'
import {
  ExecutionAttemptConflictError,
  ExecutionAttemptIdConflictError,
  ExecutionInvalidAttemptIdError
} from './execution-errors'
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
  UnitFlowReservationNotFoundError
} from '../unitflow/unitflow-errors'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class ExecutionAttemptService {
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

  async prepareExecutionAttempt(
    repositoryId: string,
    sessionId: string,
    reservationId: string,
    options: PrepareExecutionAttemptOptions
  ): Promise<ExecutionAttemptRecord> {
    const validRepoId = validateRepositoryId(repositoryId)

    if (typeof sessionId !== 'string' || !sessionId.trim() || !UUID_REGEX.test(sessionId.trim())) {
      throw new SmcInvalidSessionIdError(sessionId ?? '')
    }
    const cleanSessionId = sessionId.trim().toLowerCase()

    if (typeof reservationId !== 'string' || !reservationId.trim() || !UUID_REGEX.test(reservationId.trim())) {
      throw new UnitFlowInvalidReservationIdError(reservationId ?? '')
    }
    const cleanReservationId = reservationId.trim().toLowerCase()

    if (
      !options ||
      typeof options.attemptId !== 'string' ||
      !options.attemptId.trim() ||
      !UUID_REGEX.test(options.attemptId.trim())
    ) {
      throw new ExecutionInvalidAttemptIdError(options?.attemptId ?? '')
    }
    const cleanAttemptId = options.attemptId.trim().toLowerCase()

    let normalizedSelection: ExecutorSelection | undefined
    if (options.executorSelection !== undefined) {
      try {
        normalizedSelection = normalizeExecutorSelection(options.executorSelection)
      } catch (err: any) {
        throw new ExecutionAttemptConflictError(err?.message ?? String(err))
      }
    }

    const store = this.smcService.getStore(validRepoId)

    // 1. Replay check imediato (idempotente sem tocar Git)
    const existing = store.getExecutionAttempt(cleanAttemptId)
    if (existing) {
      if (
        existing.repositoryId === validRepoId &&
        existing.sessionId === cleanSessionId &&
        existing.reservationId === cleanReservationId
      ) {
        if (normalizedSelection) {
          if (!existing.executorSelection || !executorSelectionsEqual(existing.executorSelection, normalizedSelection)) {
            throw new ExecutionAttemptIdConflictError(
              cleanAttemptId,
              `already exists with divergent executor selection (existing=${existing.executorSelection ? formatExecutorSelection(existing.executorSelection) : 'none'}, requested=${formatExecutorSelection(normalizedSelection)})`
            )
          }
        }
        return existing
      }
      throw new ExecutionAttemptIdConflictError(
        cleanAttemptId,
        `already exists with divergent scope (repo=${existing.repositoryId}, session=${existing.sessionId}, reservation=${existing.reservationId})`
      )
    }

    // 2. Validação prévia de sessão e reserva
    const session = this.smcService.getSession(validRepoId, cleanSessionId)
    if (!session) {
      throw new SmcSessionNotFoundError(cleanSessionId)
    }
    if (session.status === 'CLOSED') {
      throw new SmcSessionClosedError(cleanSessionId)
    }

    const reservation = store.getReservation(cleanReservationId)
    if (!reservation) {
      throw new UnitFlowReservationNotFoundError(cleanReservationId)
    }
    if (reservation.sessionId !== cleanSessionId) {
      throw new ExecutionAttemptConflictError(
        `Reservation "${cleanReservationId}" belongs to another session "${reservation.sessionId}"`
      )
    }
    if (reservation.status !== 'ACTIVE') {
      throw new ExecutionAttemptConflictError(
        `Reservation "${cleanReservationId}" is not ACTIVE (status: ${reservation.status})`
      )
    }

    const plan = store.getPlan(reservation.planId)
    if (!plan) {
      throw new UnitFlowPlanNotFoundError(reservation.planId)
    }
    if (plan.sessionId !== cleanSessionId) {
      throw new UnitFlowPlanConflictError(`Plan "${reservation.planId}" belongs to another session "${plan.sessionId}"`)
    }
    if (plan.status !== 'ACTIVE') {
      throw new UnitFlowPlanConflictError(`Plan "${reservation.planId}" is not ACTIVE (status: ${plan.status})`)
    }

    const unitState = store.getUnitState(cleanSessionId, reservation.planId, reservation.unitId)
    if (!unitState) {
      throw new ExecutionAttemptConflictError(`Unit "${reservation.unitId}" has no persisted state in smc_unit_states`)
    }
    if (unitState.status !== 'RESERVED') {
      throw new ExecutionAttemptConflictError(
        `Unit "${reservation.unitId}" is not in RESERVED state (status: ${unitState.status})`
      )
    }
    if (unitState.revision !== reservation.unitStateRevision) {
      throw new ExecutionAttemptConflictError(
        `Unit "${reservation.unitId}" state revision (${unitState.revision}) diverges from reservation unitStateRevision (${reservation.unitStateRevision})`
      )
    }

    // 3. Observação do workspace vinculado (exige status=CURRENT com head atual não vazio)
    const inspectResult = await this.workspaceService.inspectBoundWorkspace(validRepoId, cleanSessionId)
    if (inspectResult.status !== 'CURRENT') {
      const reasonSuffix = inspectResult.status !== 'UNBOUND' ? `, reason: ${(inspectResult as any).reason}` : ''
      throw new BuildXWorkspaceInvalidError(
        `Cannot prepare execution attempt: workspace is not CURRENT (status: ${inspectResult.status}${reasonSuffix})`
      )
    }

    if (!inspectResult.currentHead || typeof inspectResult.currentHead !== 'string' || !inspectResult.currentHead.trim()) {
      throw new BuildXWorkspaceInvalidError('Cannot prepare execution attempt: observed workspace currentHead is empty')
    }

    // Confronta o workspace observado com a reserva
    if (
      inspectResult.binding.worktreeId !== reservation.worktreeId ||
      inspectResult.binding.generation !== reservation.generation ||
      inspectResult.binding.branch !== reservation.branch
    ) {
      throw new BuildXWorkspaceBindingConflictError(
        `Observed workspace binding diverges from reservation (reservation wt=${reservation.worktreeId}, gen=${reservation.generation}, br=${reservation.branch}; observed wt=${inspectResult.binding.worktreeId}, gen=${inspectResult.binding.generation}, br=${inspectResult.binding.branch})`
      )
    }

    // 4. Executa transação atômica SQLite
    return store.prepareExecutionAttempt({
      attemptId: cleanAttemptId,
      sessionId: cleanSessionId,
      reservationId: cleanReservationId,
      expectedBinding: {
        worktreeId: inspectResult.binding.worktreeId,
        generation: inspectResult.binding.generation,
        branch: inspectResult.binding.branch
      },
      headObserved: inspectResult.currentHead,
      ...(normalizedSelection ? { executorSelection: normalizedSelection } : {})
    })
  }

  getExecutionAttempt(
    repositoryId: string,
    attemptId: string
  ): ExecutionAttemptRecord | null {
    const validRepoId = validateRepositoryId(repositoryId)
    const store = this.smcService.getStore(validRepoId)
    return store.getExecutionAttempt(attemptId)
  }

  getPreparedExecutionAttempt(
    repositoryId: string,
    sessionId: string
  ): ExecutionAttemptRecord | null {
    const validRepoId = validateRepositoryId(repositoryId)
    const store = this.smcService.getStore(validRepoId)
    return store.getPreparedExecutionAttempt(sessionId)
  }

  close(): void {
    if (this.ownsSmcService) {
      this.smcService.close()
    }
  }
}
