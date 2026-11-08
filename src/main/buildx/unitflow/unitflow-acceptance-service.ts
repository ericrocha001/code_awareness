import type {
  AcceptValidatedUnitOptions,
  AcceptUnitFlowUnitStoreResult,
  UnitAcceptanceResult,
  UnitFlowEligibilityResult
} from '../../../shared/types/buildx/unitflow-types'
import type { BuildXInspectWorkspaceResult } from '../../../shared/types/buildx/workspace-types'
import type {
  ValidationProof,
  ProofWithFreshness
} from '../../validation-ledger/validation-ledger-types'
import type { GitOperationsResolver } from '../execution/workspace-binding-service'
import { WorkspaceBindingService } from '../execution/workspace-binding-service'
import { validateRepositoryId } from '../smc/session-memory-central-paths'
import type { SessionMemoryCentralService } from '../smc/session-memory-central-service'
import { SessionMemoryCentralService as SmcServiceImpl } from '../smc/session-memory-central-service'
import { deterministicEntryId } from '../smc/session-memory-central-store'
import type { ExecutionAttemptRecord } from '../../../shared/types/buildx/execution-types'
import { UnitFlowAcceptanceConflictError } from './unitflow-errors'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ValidationProofLookup {
  getProof(
    proofId: string
  ): Promise<ValidationProof | ProofWithFreshness | null> | ValidationProof | ProofWithFreshness | null
}

export type ValidationLedgerResolver = (
  repositoryId: string
) => Promise<ValidationProofLookup | null> | ValidationProofLookup | null

export class UnitFlowAcceptanceService {
  private readonly smcService: SessionMemoryCentralService
  private readonly workspaceService: WorkspaceBindingService
  private readonly ledgerResolver: ValidationLedgerResolver
  private readonly ownsSmcService: boolean

  constructor(
    smcServiceOrBaseDir: SessionMemoryCentralService | string,
    workspaceServiceOrGit: WorkspaceBindingService | GitOperationsResolver,
    ledgerOrResolver: ValidationProofLookup | ValidationLedgerResolver
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

    if (typeof ledgerOrResolver === 'function') {
      this.ledgerResolver = ledgerOrResolver
    } else {
      this.ledgerResolver = () => ledgerOrResolver
    }
  }

  async acceptValidatedUnit(
    repositoryId: string,
    sessionId: string,
    attemptId: string,
    options: AcceptValidatedUnitOptions
  ): Promise<UnitAcceptanceResult> {
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
      typeof options.acceptanceOperationId !== 'string' ||
      !options.acceptanceOperationId.trim() ||
      !UUID_REGEX.test(options.acceptanceOperationId.trim())
    ) {
      return {
        status: 'UNKNOWN',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        reason: 'INVALID_ACCEPTANCE_OPERATION_ID'
      }
    }
    const cleanAcceptanceOpId = options.acceptanceOperationId.trim().toLowerCase()

    if (
      !options.proofIds ||
      !Array.isArray(options.proofIds) ||
      options.proofIds.length === 0 ||
      options.proofIds.some(id => typeof id !== 'string' || !id.trim())
    ) {
      return {
        status: 'EVIDENCE_REQUIRED',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        reason: 'NO_PROOF_IDS_PROVIDED'
      }
    }

    if (typeof options.acceptanceSummary !== 'string' || !options.acceptanceSummary.trim()) {
      return {
        status: 'EVIDENCE_REQUIRED',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        reason: 'ACCEPTANCE_SUMMARY_REQUIRED'
      }
    }

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

    const store = this.smcService.getStore(validRepoId)

    let attempt: ExecutionAttemptRecord | null
    try {
      attempt = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId)
    } catch {
      return {
        status: 'UNKNOWN',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        reason: 'ATTEMPT_READ_ERROR'
      }
    }

    if (!attempt || attempt.sessionId !== cleanSessionId) {
      return {
        status: 'CONFLICT',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        reason: 'ATTEMPT_NOT_FOUND_OR_MISMATCH'
      }
    }

    const plan = store.getPlan(attempt.planId)
    if (!plan || plan.sessionId !== cleanSessionId) {
      return {
        status: 'CONFLICT',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        reason: 'PLAN_NOT_FOUND_OR_MISMATCH'
      }
    }

    const unitState = store.getUnitState(cleanSessionId, attempt.planId, attempt.unitId)
    if (!unitState) {
      return {
        status: 'CONFLICT',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        reason: 'UNIT_STATE_NOT_FOUND'
      }
    }

    const reservation = store.getReservation(attempt.reservationId)
    if (
      !reservation ||
      reservation.sessionId !== cleanSessionId ||
      reservation.planId !== attempt.planId ||
      reservation.unitId !== attempt.unitId
    ) {
      return {
        status: 'CONFLICT',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        reason: 'RESERVATION_NOT_FOUND_OR_MISMATCH'
      }
    }

    // Replay check
    if (unitState.status === 'COMPLETED' && reservation.status === 'CONSUMED') {
      const entryId = deterministicEntryId('accept', cleanAcceptanceOpId)
      const existingEntry = store.getEntry(cleanSessionId, entryId)
      if (existingEntry) {
        try {
          const parsed = JSON.parse(existingEntry.body)
          if (parsed.attemptId === cleanAttemptId && parsed.unitId === attempt.unitId) {
            let nextEligibleUnit: UnitFlowEligibilityResult
            if (plan.status === 'COMPLETED') {
              nextEligibleUnit = { kind: 'ALL_UNITS_COMPLETED' }
            } else {
              try {
                nextEligibleUnit = store.getNextEligibleUnit(cleanSessionId, attempt.planId)
              } catch {
                nextEligibleUnit = { kind: 'WAITING', blockingUnitId: 'unknown' }
              }
            }
            return {
              status: 'ACCEPTED',
              repositoryId: validRepoId,
              sessionId: cleanSessionId,
              planId: attempt.planId,
              unitId: attempt.unitId,
              unitStatus: 'COMPLETED',
              reservationStatus: 'CONSUMED',
              planStatus: plan.status,
              nextEligibleUnit,
              acceptanceOperationId: cleanAcceptanceOpId
            }
          }
        } catch {}
      }
    }

    if (attempt.status !== 'COMPLETED') {
      return {
        status: 'CONFLICT',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: `ATTEMPT_NOT_COMPLETED: status=${attempt.status}`
      }
    }

    if (unitState.status !== 'VALIDATING') {
      return {
        status: 'CONFLICT',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: `UNIT_NOT_VALIDATING: status=${unitState.status}`
      }
    }

    if (reservation.status !== 'ACTIVE') {
      return {
        status: 'CONFLICT',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: `RESERVATION_NOT_ACTIVE: status=${reservation.status}`
      }
    }

    if (plan.status !== 'ACTIVE') {
      return {
        status: 'CONFLICT',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: `PLAN_NOT_ACTIVE: status=${plan.status}`
      }
    }

    let inspectResult: BuildXInspectWorkspaceResult
    try {
      inspectResult = await this.workspaceService.inspectBoundWorkspace(validRepoId, cleanSessionId)
    } catch (err: any) {
      return {
        status: 'UNKNOWN',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: `WORKSPACE_INSPECT_ERROR: ${err?.message ?? String(err)}`
      }
    }

    if (inspectResult.status !== 'CURRENT') {
      return {
        status: 'STALE',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: `WORKSPACE_NOT_CURRENT: status=${inspectResult.status}, reason=${(inspectResult as any).reason}`
      }
    }

    if (inspectResult.binding.worktreeId !== attempt.worktreeId) {
      return {
        status: 'STALE',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: `WORKTREE_ID_MISMATCH: bound=${inspectResult.binding.worktreeId}, attempt=${attempt.worktreeId}`
      }
    }
    if (inspectResult.binding.generation !== attempt.generation) {
      return {
        status: 'STALE',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: `WORKTREE_GENERATION_MISMATCH: bound=${inspectResult.binding.generation}, attempt=${attempt.generation}`
      }
    }
    if (inspectResult.binding.branch !== attempt.branch) {
      return {
        status: 'STALE',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: `WORKTREE_BRANCH_MISMATCH: bound=${inspectResult.binding.branch}, attempt=${attempt.branch}`
      }
    }

    const currentHead = inspectResult.currentHead

    let ledger: ValidationProofLookup | null
    try {
      ledger = await this.ledgerResolver(validRepoId)
    } catch (err: any) {
      return {
        status: 'UNKNOWN',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: `LEDGER_RESOLVER_ERROR: ${err?.message ?? String(err)}`
      }
    }

    if (!ledger || typeof ledger.getProof !== 'function') {
      return {
        status: 'UNKNOWN',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: 'VALIDATION_LEDGER_UNAVAILABLE'
      }
    }

    for (const proofId of options.proofIds) {
      let proof: ValidationProof | ProofWithFreshness | null
      try {
        proof = await ledger.getProof(proofId)
      } catch (err: any) {
        return {
          status: 'UNKNOWN',
          repositoryId: validRepoId,
          sessionId: cleanSessionId,
          planId: attempt.planId,
          unitId: attempt.unitId,
          reason: `PROOF_FETCH_ERROR: ${err?.message ?? String(err)}`
        }
      }

      if (!proof) {
        return {
          status: 'EVIDENCE_REQUIRED',
          repositoryId: validRepoId,
          sessionId: cleanSessionId,
          planId: attempt.planId,
          unitId: attempt.unitId,
          reason: `PROOF_NOT_FOUND: ${proofId}`
        }
      }

      if (proof.status !== 'PASSED') {
        return {
          status: 'EVIDENCE_REQUIRED',
          repositoryId: validRepoId,
          sessionId: cleanSessionId,
          planId: attempt.planId,
          unitId: attempt.unitId,
          reason: `PROOF_NOT_PASSED: proof "${proofId}" status="${proof.status}"`
        }
      }

      if (proof.commandProfile?.receipt?.trust === 'EXECUTOR_REPORTED' && !proof.commandProfile?.checkout) {
        return {
          status: 'EVIDENCE_REQUIRED',
          repositoryId: validRepoId,
          sessionId: cleanSessionId,
          planId: attempt.planId,
          unitId: attempt.unitId,
          reason: `PROOF_UNTRUSTED: proof "${proofId}" is EXECUTOR_REPORTED without native checkout link`
        }
      }

      if (proof.commandProfile?.checkout) {
        const co = proof.commandProfile.checkout
        if (co.repositoryId && co.repositoryId !== validRepoId) {
          return {
            status: 'CONFLICT',
            repositoryId: validRepoId,
            sessionId: cleanSessionId,
            planId: attempt.planId,
            unitId: attempt.unitId,
            reason: `PROOF_REPOSITORY_MISMATCH: proof "${proofId}" repo="${co.repositoryId}" expected "${validRepoId}"`
          }
        }
        if (co.worktreeId && co.worktreeId !== attempt.worktreeId) {
          return {
            status: 'STALE',
            repositoryId: validRepoId,
            sessionId: cleanSessionId,
            planId: attempt.planId,
            unitId: attempt.unitId,
            reason: `PROOF_WORKTREE_MISMATCH: proof "${proofId}" worktree="${co.worktreeId}" expected "${attempt.worktreeId}"`
          }
        }
        if (co.generation && co.generation !== attempt.generation) {
          return {
            status: 'STALE',
            repositoryId: validRepoId,
            sessionId: cleanSessionId,
            planId: attempt.planId,
            unitId: attempt.unitId,
            reason: `PROOF_GENERATION_MISMATCH: proof "${proofId}" generation="${co.generation}" expected "${attempt.generation}"`
          }
        }
        if (co.head && co.head !== currentHead) {
          return {
            status: 'STALE',
            repositoryId: validRepoId,
            sessionId: cleanSessionId,
            planId: attempt.planId,
            unitId: attempt.unitId,
            reason: `PROOF_HEAD_STALE: proof "${proofId}" head="${co.head}" currentHead="${currentHead}"`
          }
        }
      }

      const freshness = (proof as any).freshness
      if (freshness === 'SOURCE_STALE' || freshness === 'RUNTIME_HISTORICAL') {
        return {
          status: 'STALE',
          repositoryId: validRepoId,
          sessionId: cleanSessionId,
          planId: attempt.planId,
          unitId: attempt.unitId,
          reason: `PROOF_STALE: proof "${proofId}" freshness="${freshness}"`
        }
      }
    }

    let storeResult: AcceptUnitFlowUnitStoreResult
    try {
      storeResult = store.transitionUnitToAccepted({
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        expectedUnitRevision: unitState.revision,
        reservationId: attempt.reservationId,
        attemptId: cleanAttemptId,
        acceptanceOperationId: cleanAcceptanceOpId,
        proofIds: options.proofIds,
        acceptanceSummary: options.acceptanceSummary,
        gitIdentity: {
          worktreeId: attempt.worktreeId,
          generation: attempt.generation,
          branch: attempt.branch,
          head: currentHead
        },
        emitterId: options.emitterId
      })
    } catch (err: any) {
      if (err instanceof UnitFlowAcceptanceConflictError) {
        return {
          status: 'CONFLICT',
          repositoryId: validRepoId,
          sessionId: cleanSessionId,
          planId: attempt.planId,
          unitId: attempt.unitId,
          reason: err.message
        }
      }
      return {
        status: 'UNKNOWN',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        reason: `ACCEPTANCE_STORE_ERROR: ${err?.message ?? String(err)}`
      }
    }

    let nextEligibleUnit: UnitFlowEligibilityResult
    if (storeResult.planStatus === 'COMPLETED' || storeResult.allUnitsCompleted) {
      nextEligibleUnit = { kind: 'ALL_UNITS_COMPLETED' }
    } else {
      try {
        nextEligibleUnit = store.getNextEligibleUnit(cleanSessionId, attempt.planId)
      } catch {
        nextEligibleUnit = { kind: 'WAITING', blockingUnitId: 'unknown' }
      }
    }

    return {
      status: 'ACCEPTED',
      repositoryId: validRepoId,
      sessionId: cleanSessionId,
      planId: attempt.planId,
      unitId: attempt.unitId,
      unitStatus: storeResult.unitStatus,
      reservationStatus: storeResult.reservationStatus,
      planStatus: storeResult.planStatus,
      nextEligibleUnit,
      acceptanceOperationId: cleanAcceptanceOpId
    }
  }

  close(): void {
    if (this.ownsSmcService) {
      this.smcService.close()
    }
  }
}
