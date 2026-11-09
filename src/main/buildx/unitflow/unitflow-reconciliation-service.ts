import type {
  ReconcileFailedUnitOptions,
  ReconcileUnitFlowUnitStoreResult,
  UnitReconciliationResult
} from '../../../shared/types/buildx/unitflow-types'
import type { GitOperationsPort, GitOperationsResolver } from '../execution/workspace-binding-service'
import { WorkspaceBindingService } from '../execution/workspace-binding-service'
import { validateRepositoryId } from '../smc/session-memory-central-paths'
import type { SessionMemoryCentralService } from '../smc/session-memory-central-service'
import { SessionMemoryCentralService as SmcServiceImpl } from '../smc/session-memory-central-service'
import { deterministicEntryId } from '../smc/session-memory-central-store'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class UnitFlowReconciliationService {
  private readonly smcService: SessionMemoryCentralService
  private readonly workspaceService: WorkspaceBindingService
  private readonly gitOperations?: GitOperationsResolver
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
      this.gitOperations = (workspaceServiceOrGit as any).gitOperations
    } else {
      this.gitOperations = workspaceServiceOrGit
      this.workspaceService = new WorkspaceBindingService(this.smcService, workspaceServiceOrGit)
    }
  }

  private async resolveGitPort(repositoryId: string): Promise<GitOperationsPort | null> {
    if (!this.gitOperations) return null
    if (typeof this.gitOperations === 'function') {
      return await this.gitOperations(repositoryId)
    }
    return this.gitOperations
  }

  async reconcileFailedUnit(
    repositoryId: string,
    sessionId: string,
    attemptId: string,
    options: ReconcileFailedUnitOptions
  ): Promise<UnitReconciliationResult> {
    let validRepoId: string
    try {
      validRepoId = validateRepositoryId(repositoryId)
    } catch {
      return {
        status: 'UNKNOWN',
        repositoryId: repositoryId ?? '',
        sessionId: sessionId ?? '',
        reason: 'INVALID_REPOSITORY_ID'
      }
    }

    if (typeof sessionId !== 'string' || !sessionId.trim() || !UUID_REGEX.test(sessionId.trim())) {
      return {
        status: 'UNKNOWN',
        repositoryId: validRepoId,
        sessionId: sessionId ?? '',
        reason: 'INVALID_SESSION_ID'
      }
    }
    const cleanSessionId = sessionId.trim().toLowerCase()

    if (typeof attemptId !== 'string' || !attemptId.trim() || !UUID_REGEX.test(attemptId.trim())) {
      return {
        status: 'UNKNOWN',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        reason: 'INVALID_ATTEMPT_ID'
      }
    }
    const cleanAttemptId = attemptId.trim().toLowerCase()

    if (
      !options ||
      typeof options.reconciliationOperationId !== 'string' ||
      !options.reconciliationOperationId.trim() ||
      !UUID_REGEX.test(options.reconciliationOperationId.trim())
    ) {
      return {
        status: 'UNKNOWN',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        reason: 'INVALID_RECONCILIATION_OPERATION_ID'
      }
    }
    const cleanReconciliationOpId = options.reconciliationOperationId.trim().toLowerCase()

    if (typeof options.summary !== 'string' || !options.summary.trim()) {
      return {
        status: 'UNKNOWN',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        reason: 'SUMMARY_REQUIRED'
      }
    }

    if (options.decision !== 'RETRY_SAME_UNIT') {
      return {
        status: 'CONFLICT',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        reason: 'INVALID_DECISION'
      }
    }

    const store = this.smcService.getStore(validRepoId)

    // 1. Replay check idempotente
    const replayEntryId = deterministicEntryId('reconcile', cleanReconciliationOpId)
    const existingReplayEntry = store.getEntry(cleanSessionId, replayEntryId)
    if (existingReplayEntry) {
      try {
        const parsed = JSON.parse(existingReplayEntry.body)
        if (
          parsed.attemptId === cleanAttemptId &&
          parsed.reconciliationOperationId === cleanReconciliationOpId &&
          parsed.decision === options.decision
        ) {
          const nextEligible = store.getNextEligibleUnit(cleanSessionId, parsed.planId)
          const unitState = store.getUnitState(cleanSessionId, parsed.planId, parsed.unitId)
          const reservation = store.getReservation(parsed.reservationId)
          const plan = store.getPlan(parsed.planId)
          const status = (nextEligible.kind === 'ELIGIBLE' && nextEligible.unitId === parsed.unitId)
            ? 'RETRY_ELIGIBLE'
            : (nextEligible.kind === 'WAITING' ? 'WAITING' : 'RETRY_ELIGIBLE')
          return {
            status,
            repositoryId: validRepoId,
            sessionId: cleanSessionId,
            planId: parsed.planId,
            unitId: parsed.unitId,
            unitStatus: unitState?.status ?? 'AVAILABLE',
            reservationStatus: reservation?.status ?? 'CANCELLED',
            planStatus: plan?.status ?? 'ACTIVE',
            nextEligibleUnit: nextEligible,
            reconciliationOperationId: cleanReconciliationOpId
          }
        }
      } catch {}
      return {
        status: 'CONFLICT',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        reason: 'RECONCILIATION_OPERATION_ID_CONFLICT'
      }
    }

    // 2. Validação da Sessão
    const session = this.smcService.getSession(validRepoId, cleanSessionId)
    if (!session) {
      return {
        status: 'UNKNOWN',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        reason: 'SESSION_NOT_FOUND'
      }
    }
    if (session.status === 'CLOSED') {
      return {
        status: 'CONFLICT',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        reason: 'SESSION_CLOSED'
      }
    }

    // 3. Validação do Attempt
    const attempt = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId)
    if (!attempt) {
      return {
        status: 'CONFLICT',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        reason: 'ATTEMPT_NOT_FOUND'
      }
    }
    if (attempt.repositoryId !== validRepoId || attempt.sessionId !== cleanSessionId) {
      return {
        status: 'CONFLICT',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        reason: 'ATTEMPT_SCOPE_MISMATCH'
      }
    }
    if (attempt.status === 'STARTING' || attempt.status === 'RUNNING') {
      return {
        status: 'BLOCKED_UNKNOWN',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: 'ATTEMPT_NOT_TERMINAL: attempt is still STARTING/RUNNING'
      }
    }
    if (attempt.status === 'COMPLETED') {
      return {
        status: 'CONFLICT',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: 'ATTEMPT_ALREADY_COMPLETED'
      }
    }
    if (attempt.status !== 'FAILED' && attempt.status !== 'CANCELLED') {
      return {
        status: 'BLOCKED_UNKNOWN',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: `ATTEMPT_NOT_TERMINAL: attempt status is "${attempt.status}"`
      }
    }

    // 4. Validação de Prova Terminal no histórico SMC (PENDING)
    const settleEntry = store.getEntry(cleanSessionId, deterministicEntryId('settle', cleanAttemptId))
    let hasTerminalPending = false
    if (settleEntry && settleEntry.kind === 'PENDING') {
      hasTerminalPending = true
    } else {
      const { entries } = store.listEntries(cleanSessionId, { limit: 100 })
      const matchingPending = entries.find(e => e.kind === 'PENDING')
      if (matchingPending) {
        const fullEntry = store.getEntry(cleanSessionId, matchingPending.entryId)
        if (fullEntry && (fullEntry.body.includes(cleanAttemptId) || (fullEntry.references && fullEntry.references.some(r => r.target === cleanAttemptId)))) {
          hasTerminalPending = true
        }
      }
    }

    if (!hasTerminalPending) {
      return {
        status: 'BLOCKED_UNKNOWN',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: 'TERMINATION_UNCONFIRMED: missing terminal settlement entry in SMC'
      }
    }

    // 5. Validação de Plano, Unidade e Reserva
    const plan = store.getPlan(attempt.planId)
    if (!plan) {
      return {
        status: 'CONFLICT',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: 'PLAN_NOT_FOUND'
      }
    }
    if (plan.status !== 'ACTIVE') {
      return {
        status: 'CONFLICT',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: `PLAN_NOT_ACTIVE: plan status is "${plan.status}"`
      }
    }

    const unitState = store.getUnitState(cleanSessionId, attempt.planId, attempt.unitId)
    if (!unitState) {
      return {
        status: 'CONFLICT',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: 'UNIT_STATE_NOT_FOUND'
      }
    }
    if (unitState.status !== 'RECONCILING') {
      return {
        status: 'CONFLICT',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: `UNIT_NOT_RECONCILING: unit status is "${unitState.status}", expected RECONCILING`
      }
    }

    const reservation = store.getReservation(attempt.reservationId)
    if (!reservation) {
      return {
        status: 'CONFLICT',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: 'RESERVATION_NOT_FOUND'
      }
    }
    if (reservation.status !== 'ACTIVE') {
      return {
        status: 'CONFLICT',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: `RESERVATION_NOT_ACTIVE: reservation status is "${reservation.status}", expected ACTIVE`
      }
    }
    if (reservation.unitId !== attempt.unitId) {
      return {
        status: 'CONFLICT',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: 'RESERVATION_UNIT_MISMATCH'
      }
    }

    // 6. Observação de Workspace e Git
    const inspectResult = await this.workspaceService.inspectBoundWorkspace(validRepoId, cleanSessionId)
    if (inspectResult.status !== 'CURRENT') {
      const reason = (inspectResult as any).reason ?? inspectResult.status
      const isBlockedUnknown = reason === 'WORKTREE_MISSING' || reason === 'GENERATION_CHANGED' || reason === 'WORKTREE_NOT_FOUND'
      return {
        status: isBlockedUnknown ? 'BLOCKED_UNKNOWN' : 'STALE',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: `WORKSPACE_NOT_CURRENT: ${reason}`
      }
    }

    if (
      inspectResult.binding.worktreeId !== attempt.worktreeId ||
      inspectResult.binding.generation !== attempt.generation ||
      inspectResult.binding.branch !== attempt.branch
    ) {
      return {
        status: 'BLOCKED_UNKNOWN',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: 'WORKSPACE_IDENTITY_MISMATCH'
      }
    }

    let gitChangesSummary: { totalCount?: number; dirty?: boolean } = {}
    try {
      const port = await this.resolveGitPort(validRepoId)
      if (port && typeof (port as any).getWorktreeChanges === 'function') {
        const changes = await (port as any).getWorktreeChanges({ worktreeId: inspectResult.binding.worktreeId, pageSize: 20 })
        const totalCount = changes?.totalCount ?? (Array.isArray(changes?.changes) ? changes.changes.length : 0)
        gitChangesSummary = {
          totalCount,
          dirty: totalCount > 0
        }
      }
    } catch (err: any) {
      return {
        status: 'BLOCKED_UNKNOWN',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: `GIT_READ_ERROR: ${err?.message ?? 'git read failure'}`
      }
    }

    // 7. Transação CAS no Store
    let storeResult: ReconcileUnitFlowUnitStoreResult
    try {
      storeResult = store.transitionUnitToReconciled({
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        expectedUnitRevision: unitState.revision,
        reservationId: attempt.reservationId,
        attemptId: cleanAttemptId,
        reconciliationOperationId: cleanReconciliationOpId,
        decision: options.decision,
        summary: options.summary,
        gitIdentity: {
          worktreeId: inspectResult.binding.worktreeId,
          generation: inspectResult.binding.generation,
          branch: inspectResult.binding.branch,
          head: inspectResult.currentHead
        },
        worktreeChangesSummary: gitChangesSummary,
        emitterId: options.emitterId
      })
    } catch (err: any) {
      return {
        status: 'CONFLICT',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: err?.message ?? 'RECONCILIATION_CAS_CONFLICT'
      }
    }

    // 8. Consulta sequencial para retorno informativo
    const nextEligible = store.getNextEligibleUnit(cleanSessionId, attempt.planId)
    const status: 'RETRY_ELIGIBLE' | 'WAITING' = (nextEligible.kind === 'ELIGIBLE' && nextEligible.unitId === attempt.unitId)
      ? 'RETRY_ELIGIBLE'
      : (nextEligible.kind === 'WAITING' ? 'WAITING' : 'RETRY_ELIGIBLE')

    return {
      status,
      repositoryId: validRepoId,
      sessionId: cleanSessionId,
      planId: attempt.planId,
      unitId: attempt.unitId,
      unitStatus: storeResult.unitStatus,
      reservationStatus: storeResult.reservationStatus,
      planStatus: storeResult.planStatus,
      nextEligibleUnit: nextEligible,
      reconciliationOperationId: cleanReconciliationOpId
    }
  }

  close(): void {
    if (this.ownsSmcService) {
      this.smcService.close()
    }
  }
}
