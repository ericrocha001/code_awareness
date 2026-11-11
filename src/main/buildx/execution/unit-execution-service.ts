import { readFileSync } from 'node:fs'
import { validateRepositoryId } from '../smc/session-memory-central-paths'
import type { SessionMemoryCentralService } from '../smc/session-memory-central-service'
import type { WorkspaceBindingService } from './workspace-binding-service'
import type { UnitPromptStageService } from './unit-prompt-stage-service'
import type {
  ExecutionAttemptRecord,
  ExecutorEvent,
  ExecutorRunObservation,
  ExecutorSelection,
  ExecutorTerminationConfirmation,
  StartUnitExecutionOptions,
  UnitExecutionResult,
  UnitSettlementResult
} from '../../../shared/types/buildx/execution-types'
import { ExecutionAttemptConflictError } from './execution-errors'
import {
  executorSelectionsEqual,
  formatExecutorSelection,
  normalizeExecutorSelection,
  type UnitExecutorPort,
  type UnitExecutorResolver
} from './executor-port'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type IdValidationResult =
  | {
      ok: true
      validRepoId: string
      cleanSessionId: string
      cleanAttemptId: string
    }
  | {
      ok: false
      reason: 'INVALID_REPOSITORY_ID' | 'INVALID_SESSION_ID' | 'INVALID_ATTEMPT_ID'
      repositoryId: string
      sessionId: string
      attemptId: string
    }

function validateAttemptIdentifiers(
  repositoryId: string,
  sessionId: string,
  attemptId: string
): IdValidationResult {
  let validRepoId: string
  try {
    validRepoId = validateRepositoryId(repositoryId)
  } catch {
    return {
      ok: false,
      reason: 'INVALID_REPOSITORY_ID',
      repositoryId: repositoryId ?? '',
      sessionId: sessionId ?? '',
      attemptId: attemptId ?? ''
    }
  }

  if (typeof sessionId !== 'string' || !sessionId.trim() || !UUID_REGEX.test(sessionId.trim())) {
    return {
      ok: false,
      reason: 'INVALID_SESSION_ID',
      repositoryId: validRepoId,
      sessionId: sessionId ?? '',
      attemptId: attemptId ?? ''
    }
  }
  const cleanSessionId = sessionId.trim().toLowerCase()

  if (typeof attemptId !== 'string' || !attemptId.trim() || !UUID_REGEX.test(attemptId.trim())) {
    return {
      ok: false,
      reason: 'INVALID_ATTEMPT_ID',
      repositoryId: validRepoId,
      sessionId: cleanSessionId,
      attemptId: attemptId ?? ''
    }
  }

  return {
    ok: true,
    validRepoId,
    cleanSessionId,
    cleanAttemptId: attemptId.trim().toLowerCase()
  }
}

function selectionFields(selection?: ExecutorSelection): {
  executorId?: string
  providerId?: string | null
  modelId?: string | null
} {
  if (!selection) return {}
  return {
    executorId: selection.executorId,
    providerId: selection.providerId ?? null,
    modelId: selection.modelId ?? null
  }
}

function timeoutMetadata(observation: Pick<ExecutorRunObservation, 'timeoutProfile' | 'timeoutMs'>): {
  timeoutProfile?: string
  timeoutMs?: number
} {
  return {
    ...(observation.timeoutProfile ? { timeoutProfile: observation.timeoutProfile } : {}),
    ...(observation.timeoutMs !== undefined ? { timeoutMs: observation.timeoutMs } : {})
  }
}

function legacyStatusMetadata(observation: ExecutorRunObservation): {
  cliStatus: string
  cliPhase?: string
} {
  const cliStatus = observation.legacyExecution?.status ?? observation.status
  const cliPhase = observation.legacyExecution?.phase ?? observation.phase
  return {
    cliStatus,
    ...(cliPhase !== undefined ? { cliPhase } : {})
  }
}

function outcomeMetadata(observation: ExecutorRunObservation): {
  usage?: NonNullable<ExecutorRunObservation['result']>['usage']
  billing?: NonNullable<ExecutorRunObservation['result']>['billing']
} {
  return {
    ...(observation.result?.usage ? { usage: observation.result.usage } : {}),
    ...(observation.result?.billing ? { billing: observation.result.billing } : {})
  }
}

function isTerminalRunStatus(status: ExecutorRunObservation['status']): boolean {
  return (
    status === 'SUCCEEDED' ||
    status === 'FAILED' ||
    status === 'CANCELLED' ||
    status === 'TIMED_OUT' ||
    status === 'INTERRUPTED'
  )
}

export class UnitExecutionService {
  private readonly smcService: SessionMemoryCentralService
  private readonly workspaceService: WorkspaceBindingService
  private readonly stageService: UnitPromptStageService
  private readonly executorResolver: UnitExecutorResolver

  constructor(
    smcService: SessionMemoryCentralService,
    workspaceService: WorkspaceBindingService,
    stageService: UnitPromptStageService,
    executorOrResolver: UnitExecutorPort | UnitExecutorResolver | null
  ) {
    this.smcService = smcService
    this.workspaceService = workspaceService
    this.stageService = stageService
    if (typeof executorOrResolver === 'function') {
      this.executorResolver = executorOrResolver
    } else if (executorOrResolver) {
      this.executorResolver = () => executorOrResolver
    } else {
      this.executorResolver = () => null
    }
  }

  async startUnitExecution(
    repositoryId: string,
    sessionId: string,
    attemptId: string,
    options: StartUnitExecutionOptions
  ): Promise<UnitExecutionResult> {
    const ids = validateAttemptIdentifiers(repositoryId, sessionId, attemptId)
    if (!ids.ok) {
      return {
        status: 'UNAVAILABLE',
        attemptId: ids.attemptId,
        sessionId: ids.sessionId,
        repositoryId: ids.repositoryId,
        reason: ids.reason
      }
    }
    const { validRepoId, cleanSessionId, cleanAttemptId } = ids

    if (!options?.stageOperationId || typeof options.stageOperationId !== 'string' || !options.stageOperationId.trim()) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'STAGE_OPERATION_ID_REQUIRED'
      }
    }

    let requestedSelection: ExecutorSelection | undefined
    if (options.executorSelection !== undefined) {
      try {
        requestedSelection = normalizeExecutorSelection(options.executorSelection)
      } catch (err: any) {
        return {
          status: 'UNAVAILABLE',
          attemptId: cleanAttemptId,
          sessionId: cleanSessionId,
          repositoryId: validRepoId,
          reason: err?.message ?? 'INVALID_EXECUTOR_SELECTION'
        }
      }
    }

    // 1. Read SMC attempt state upfront so persisted selection and replay are checked before spawning
    let attempt: ExecutionAttemptRecord | null
    try {
      attempt = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId)
    } catch {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'ATTEMPT_READ_ERROR'
      }
    }

    const persistedSelection = attempt?.executorSelection

    if (
      attempt &&
      attempt.sessionId === cleanSessionId &&
      persistedSelection &&
      requestedSelection &&
      !executorSelectionsEqual(persistedSelection, requestedSelection)
    ) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(persistedSelection),
        reason: `EXECUTOR_SELECTION_CONFLICT: attempt locked to (${formatExecutorSelection(persistedSelection)}), requested (${formatExecutorSelection(requestedSelection)})`
      }
    }

    // 2. Resolve and verify executor adapter
    const selectionHint = requestedSelection ?? persistedSelection
    const executor = await this.executorResolver(validRepoId, selectionHint)
    if (!executor) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(selectionHint),
        reason: 'EXECUTOR_UNAVAILABLE'
      }
    }

    let availability: Awaited<ReturnType<UnitExecutorPort['checkAvailability']>>
    try {
      availability = await executor.checkAvailability(validRepoId)
    } catch (err: any) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(executor.identity),
        reason: `EXECUTOR_AVAILABILITY_ERROR: ${err?.message ?? String(err)}`
      }
    }

    if (!availability.available) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(executor.identity),
        reason: availability.reason ?? 'EXECUTOR_UNAVAILABLE'
      }
    }

    if (requestedSelection && !executorSelectionsEqual(requestedSelection, executor.identity)) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(executor.identity),
        reason: `EXECUTOR_SELECTION_CONFLICT: requested (${formatExecutorSelection(requestedSelection)}) does not match resolved executor (${formatExecutorSelection(executor.identity)})`
      }
    }

    if (!attempt || attempt.sessionId !== cleanSessionId) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(executor.identity),
        reason: 'ATTEMPT_NOT_FOUND'
      }
    }

    if (persistedSelection && !executorSelectionsEqual(persistedSelection, executor.identity)) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(persistedSelection),
        reason: `EXECUTOR_SELECTION_CONFLICT: attempt locked to (${formatExecutorSelection(persistedSelection)}), resolved executor is (${formatExecutorSelection(executor.identity)})`
      }
    }

    // Replay: attempt already STARTING or RUNNING -> observe without spawning again
    if (attempt.status === 'STARTING' || attempt.status === 'RUNNING') {
      return this.observeRunningAttempt(executor, cleanAttemptId, cleanSessionId, validRepoId)
    }
    if (attempt.status !== 'PREPARED') {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(persistedSelection ?? executor.identity),
        reason: `ATTEMPT_NOT_PREPARED: status=${attempt.status}`
      }
    }

    // 3. Verify reservation, plan, unit state
    const store = this.smcService.getStore(validRepoId)
    const reservation = store.getReservation(attempt.reservationId)
    if (!reservation || reservation.status !== 'ACTIVE' || reservation.sessionId !== cleanSessionId) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(executor.identity),
        reason: 'RESERVATION_NOT_ACTIVE'
      }
    }

    const plan = store.getPlan(attempt.planId)
    if (!plan || plan.status !== 'ACTIVE') {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(executor.identity),
        reason: 'PLAN_NOT_ACTIVE'
      }
    }

    const unitState = store.getUnitState(cleanSessionId, attempt.planId, attempt.unitId)
    if (!unitState || unitState.status !== 'RESERVED' || unitState.revision !== reservation.unitStateRevision) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(executor.identity),
        reason: 'UNIT_NOT_RESERVED'
      }
    }

    // 4. Verify workspace CURRENT
    let ws: Awaited<ReturnType<WorkspaceBindingService['inspectBoundWorkspace']>>
    try {
      ws = await this.workspaceService.inspectBoundWorkspace(validRepoId, cleanSessionId)
    } catch {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(executor.identity),
        reason: 'WORKSPACE_INSPECT_ERROR'
      }
    }

    if (
      ws.status !== 'CURRENT' ||
      ws.binding.worktreeId !== attempt.worktreeId ||
      ws.binding.generation !== attempt.generation ||
      ws.binding.branch !== attempt.branch
    ) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(executor.identity),
        reason: 'WORKSPACE_NOT_CURRENT'
      }
    }

    // 5. Resolve staged prompt (kept internal — never surfaced to callers)
    const stagePath = await this.stageService.resolveStagedPromptPath(
      validRepoId,
      cleanSessionId,
      cleanAttemptId,
      options.stageOperationId
    )
    if (!stagePath) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(executor.identity),
        reason: 'STAGE_NOT_READY'
      }
    }

    const boundWorktreePath = await this.workspaceService.getWorktreePath(validRepoId, attempt.worktreeId)

    // Retain prompt file until attempt terminates or fails admission
    this.stageService.retainStage(options.stageOperationId, cleanAttemptId)

    // 6. Prepare attempt via agnostic executor port
    let preparation: Awaited<ReturnType<UnitExecutorPort['prepareAttempt']>>
    try {
      preparation = await executor.prepareAttempt({
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        attemptId: cleanAttemptId,
        worktree: {
          worktreeId: attempt.worktreeId,
          generation: attempt.generation,
          branch: attempt.branch,
          ...(boundWorktreePath ? { path: boundWorktreePath } : {})
        },
        prompt: {
          stageOperationId: options.stageOperationId,
          promptFilePath: stagePath,
          readPromptText: () => readFileSync(stagePath, 'utf8')
        },
        allowAlwaysApprove: options.allowAlwaysApprove
      })
    } catch (err: any) {
      this.stageService.releaseStageRetention(options.stageOperationId, cleanAttemptId)
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(executor.identity),
        reason: `EXECUTOR_PREPARE_ERROR: ${err?.message ?? String(err)}`
      }
    }

    if (preparation.status !== 'READY' || !preparation.handle) {
      this.stageService.releaseStageRetention(options.stageOperationId, cleanAttemptId)
      return {
        status: preparation.status === 'REFUSED' ? 'REFUSED' : 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(executor.identity),
        reason: preparation.reason ?? 'EXECUTOR_PREPARE_FAILED'
      }
    }

    const preparedSelection = preparation.handle.selection
    if (
      !executorSelectionsEqual(preparedSelection, executor.identity) ||
      (persistedSelection && !executorSelectionsEqual(preparedSelection, persistedSelection)) ||
      (requestedSelection && !executorSelectionsEqual(preparedSelection, requestedSelection))
    ) {
      this.stageService.releaseStageRetention(options.stageOperationId, cleanAttemptId)
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(persistedSelection ?? executor.identity),
        reason: 'EXECUTOR_SELECTION_CONFLICT'
      }
    }

    // 7. CAS: PREPARED -> STARTING with persisted executor selection BEFORE spawn
    let startingAttempt: ExecutionAttemptRecord
    try {
      startingAttempt = this.smcService.transitionAttemptToStarting(
        validRepoId,
        cleanAttemptId,
        attempt.revision,
        preparedSelection
      )
    } catch (err: any) {
      if (err instanceof ExecutionAttemptConflictError) {
        const current = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId)
        if (current?.executorSelection && !executorSelectionsEqual(current.executorSelection, executor.identity)) {
          if (current.status !== 'STARTING' && current.status !== 'RUNNING') {
            this.stageService.releaseStageRetention(options.stageOperationId, cleanAttemptId)
          }
          return {
            status: 'UNAVAILABLE',
            attemptId: cleanAttemptId,
            sessionId: cleanSessionId,
            repositoryId: validRepoId,
            ...selectionFields(current.executorSelection),
            reason: `EXECUTOR_SELECTION_CONFLICT: attempt locked to (${formatExecutorSelection(current.executorSelection)})`
          }
        }
        if (current?.status === 'STARTING' || current?.status === 'RUNNING') {
          return this.observeRunningAttempt(executor, cleanAttemptId, cleanSessionId, validRepoId)
        }
      }
      this.stageService.releaseStageRetention(options.stageOperationId, cleanAttemptId)
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(preparedSelection),
        reason: `CAS_STARTING_ERROR: ${err?.message ?? String(err)}`
      }
    }

    // 8. Start execution via agnostic executor port
    let observation: ExecutorRunObservation
    try {
      observation = await executor.startAttempt({
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        handle: preparation.handle
      })
    } catch (err: any) {
      // After CAS to STARTING, start threw — state is ambiguous; leave attempt STARTING and keep retention
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(preparedSelection),
        reason: err?.message ?? String(err)
      }
    }

    if (!executorSelectionsEqual(observation.selection, preparedSelection)) {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(preparedSelection),
        reason: 'EXECUTOR_SELECTION_CONFLICT'
      }
    }

    if (observation.status === 'UNAVAILABLE') {
      this.stageService.releaseStageRetention(options.stageOperationId, cleanAttemptId)
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(observation.selection),
        reason: observation.reason ?? 'EXECUTOR_UNAVAILABLE',
        ...timeoutMetadata(observation)
      }
    }

    return this.applyObservationToStartOrObserve(
      observation,
      validRepoId,
      cleanSessionId,
      cleanAttemptId,
      startingAttempt.revision,
      attempt.unitId,
      unitState.revision,
      false
    )
  }

  async observeUnitExecution(
    repositoryId: string,
    sessionId: string,
    attemptId: string,
    options?: { readOnly?: boolean }
  ): Promise<UnitExecutionResult> {
    const ids = validateAttemptIdentifiers(repositoryId, sessionId, attemptId)
    if (!ids.ok) {
      return {
        status: 'UNAVAILABLE',
        attemptId: ids.attemptId,
        sessionId: ids.sessionId,
        repositoryId: ids.repositoryId,
        reason: ids.reason
      }
    }
    const { validRepoId, cleanSessionId, cleanAttemptId } = ids

    const attempt = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId)
    if (!attempt || attempt.sessionId !== cleanSessionId) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'ATTEMPT_NOT_FOUND'
      }
    }

    if (attempt.status !== 'STARTING' && attempt.status !== 'RUNNING') {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(attempt.executorSelection),
        reason: `ATTEMPT_NOT_ACTIVE: status=${attempt.status}`
      }
    }

    const executor = await this.executorResolver(validRepoId, attempt.executorSelection)
    if (!executor) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(attempt.executorSelection),
        reason: 'EXECUTOR_UNAVAILABLE'
      }
    }

    const availability = await executor.checkAvailability(validRepoId)
    if (!availability.available) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(attempt.executorSelection ?? executor.identity),
        reason: availability.reason ?? 'EXECUTOR_UNAVAILABLE'
      }
    }

    if (attempt.executorSelection && !executorSelectionsEqual(attempt.executorSelection, executor.identity)) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(attempt.executorSelection),
        reason: `EXECUTOR_SELECTION_CONFLICT: attempt locked to (${formatExecutorSelection(attempt.executorSelection)}), resolved executor is (${formatExecutorSelection(executor.identity)})`
      }
    }

    return this.observeRunningAttempt(executor, cleanAttemptId, cleanSessionId, validRepoId, options)
  }

  async cancelUnitExecution(
    repositoryId: string,
    sessionId: string,
    attemptId: string
  ): Promise<UnitExecutionResult> {
    const ids = validateAttemptIdentifiers(repositoryId, sessionId, attemptId)
    if (!ids.ok) {
      return {
        status: 'UNAVAILABLE',
        attemptId: ids.attemptId,
        sessionId: ids.sessionId,
        repositoryId: ids.repositoryId,
        reason: ids.reason
      }
    }
    const { validRepoId, cleanSessionId, cleanAttemptId } = ids

    const attempt = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId)
    if (!attempt || attempt.sessionId !== cleanSessionId) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'ATTEMPT_NOT_FOUND'
      }
    }

    const store = this.smcService.getStore(validRepoId)
    if (attempt.status === 'COMPLETED' || attempt.status === 'FAILED' || attempt.status === 'CANCELLED') {
      const unitState = store.getUnitState(cleanSessionId, attempt.planId, attempt.unitId)
      return {
        status: 'TERMINAL_OBSERVED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(attempt.executorSelection),
        unitFlowStatus: unitState?.status,
        reason: `ATTEMPT_ALREADY_TERMINAL: ${attempt.status}`
      }
    }

    if (attempt.status !== 'STARTING' && attempt.status !== 'RUNNING') {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(attempt.executorSelection),
        reason: `ATTEMPT_NOT_ACTIVE: status=${attempt.status}`
      }
    }

    const executor = await this.executorResolver(validRepoId, attempt.executorSelection)
    if (!executor) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(attempt.executorSelection),
        reason: 'EXECUTOR_UNAVAILABLE'
      }
    }

    const availability = await executor.checkAvailability(validRepoId)
    if (!availability.available) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(attempt.executorSelection ?? executor.identity),
        reason: availability.reason ?? 'EXECUTOR_UNAVAILABLE'
      }
    }

    if (attempt.executorSelection && !executorSelectionsEqual(attempt.executorSelection, executor.identity)) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(attempt.executorSelection),
        reason: `EXECUTOR_SELECTION_CONFLICT: attempt locked to (${formatExecutorSelection(attempt.executorSelection)}), resolved executor is (${formatExecutorSelection(executor.identity)})`
      }
    }

    let observation: ExecutorRunObservation
    try {
      observation = await executor.cancelAttempt({
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId
      })
    } catch (err: any) {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(attempt.executorSelection ?? executor.identity),
        reason: err?.message ?? String(err)
      }
    }

    if (attempt.executorSelection && !executorSelectionsEqual(observation.selection, attempt.executorSelection)) {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(attempt.executorSelection),
        reason: 'EXECUTOR_SELECTION_CONFLICT'
      }
    }

    if (observation.status === 'REFUSED') {
      this.stageService.releaseAttemptRetention(cleanAttemptId)
      return {
        status: 'REFUSED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(observation.selection),
        ...legacyStatusMetadata(observation),
        unitFlowStatus: 'RESERVED',
        reason: observation.reason ?? 'NATIVE_APPROVAL_REFUSED',
        ...timeoutMetadata(observation)
      }
    }

    const confirmed = await this.verifyTerminationConfirmed(
      executor,
      validRepoId,
      cleanSessionId,
      cleanAttemptId,
      observation,
      false
    )

    if (!confirmed || !isTerminalRunStatus(observation.status)) {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(observation.selection),
        ...legacyStatusMetadata(observation),
        reason: observation.termination?.reason ?? observation.reason ?? 'TERMINATION_UNCONFIRMED',
        ...timeoutMetadata(observation)
      }
    }

    this.stageService.releaseAttemptRetention(cleanAttemptId)
    return {
      status: 'TERMINAL_OBSERVED',
      attemptId: cleanAttemptId,
      sessionId: cleanSessionId,
      repositoryId: validRepoId,
      ...selectionFields(observation.selection),
      ...legacyStatusMetadata(observation),
      ...(observation.status !== 'SUCCEEDED' ? { reason: observation.reason ?? observation.status } : {}),
      ...timeoutMetadata(observation),
      ...outcomeMetadata(observation)
    }
  }

  async subscribeAttemptEvents(
    repositoryId: string,
    sessionId: string,
    attemptId: string,
    listener: (event: ExecutorEvent) => void
  ): Promise<(() => void) | null> {
    const ids = validateAttemptIdentifiers(repositoryId, sessionId, attemptId)
    if (!ids.ok) return null
    const attempt = this.smcService.getExecutionAttempt(ids.validRepoId, ids.cleanAttemptId)
    if (!attempt || attempt.sessionId !== ids.cleanSessionId) return null
    const executor = await this.executorResolver(ids.validRepoId, attempt.executorSelection)
    if (!executor?.subscribe) return null
    if (attempt.executorSelection && !executorSelectionsEqual(attempt.executorSelection, executor.identity)) {
      return null
    }
    return executor.subscribe(ids.cleanAttemptId, listener)
  }

  async settleUnitExecution(
    repositoryId: string,
    sessionId: string,
    attemptId: string
  ): Promise<UnitSettlementResult> {
    const ids = validateAttemptIdentifiers(repositoryId, sessionId, attemptId)
    if (!ids.ok) {
      return {
        status: 'UNKNOWN',
        attemptId: ids.attemptId,
        sessionId: ids.sessionId,
        repositoryId: ids.repositoryId,
        reason: ids.reason
      }
    }
    const { validRepoId, cleanSessionId, cleanAttemptId } = ids

    let attempt: ExecutionAttemptRecord | null
    try {
      attempt = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId)
    } catch {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'ATTEMPT_READ_ERROR'
      }
    }

    if (!attempt || attempt.sessionId !== cleanSessionId) {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'ATTEMPT_NOT_FOUND'
      }
    }

    const store = this.smcService.getStore(validRepoId)

    // Replay / idempotency for already settled terminal states
    if (attempt.status === 'COMPLETED') {
      const unitState = store.getUnitState(cleanSessionId, attempt.planId, attempt.unitId)
      return {
        status: 'VALIDATION_READY',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        attemptStatus: 'COMPLETED',
        unitFlowStatus: unitState?.status,
        ...selectionFields(attempt.executorSelection),
        cliStatus: 'SUCCEEDED'
      }
    }

    if (attempt.status === 'FAILED' || attempt.status === 'CANCELLED') {
      const unitState = store.getUnitState(cleanSessionId, attempt.planId, attempt.unitId)
      return {
        status: 'RECONCILING',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        attemptStatus: attempt.status,
        unitFlowStatus: unitState?.status,
        ...selectionFields(attempt.executorSelection),
        cliStatus: attempt.status
      }
    }

    if (attempt.status !== 'STARTING' && attempt.status !== 'RUNNING') {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(attempt.executorSelection),
        reason: `ATTEMPT_NOT_ACTIVE: status=${attempt.status}`
      }
    }

    const reservation = store.getReservation(attempt.reservationId)
    if (!reservation || reservation.sessionId !== cleanSessionId) {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'RESERVATION_NOT_FOUND'
      }
    }

    const plan = store.getPlan(attempt.planId)
    if (!plan) {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'PLAN_NOT_FOUND'
      }
    }

    const unitState = store.getUnitState(cleanSessionId, attempt.planId, attempt.unitId)
    if (!unitState) {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'UNIT_STATE_NOT_FOUND'
      }
    }

    const executor = await this.executorResolver(validRepoId, attempt.executorSelection)
    if (!executor) {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(attempt.executorSelection),
        reason: 'EXECUTOR_UNAVAILABLE'
      }
    }

    const availability = await executor.checkAvailability(validRepoId)
    if (!availability.available) {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(attempt.executorSelection ?? executor.identity),
        reason: availability.reason ?? 'EXECUTOR_UNAVAILABLE'
      }
    }

    if (attempt.executorSelection && !executorSelectionsEqual(attempt.executorSelection, executor.identity)) {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(attempt.executorSelection),
        reason: `EXECUTOR_SELECTION_CONFLICT: attempt locked to (${formatExecutorSelection(attempt.executorSelection)}), resolved executor is (${formatExecutorSelection(executor.identity)})`
      }
    }

    let observation: ExecutorRunObservation
    try {
      observation = await executor.observeAttempt({
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId
      })
    } catch (err: any) {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(attempt.executorSelection ?? executor.identity),
        reason: err?.message ?? String(err)
      }
    }

    if (attempt.executorSelection && !executorSelectionsEqual(attempt.executorSelection, observation.selection)) {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(attempt.executorSelection),
        reason: 'EXECUTOR_SELECTION_CONFLICT'
      }
    }

    if (observation.status === 'UNAVAILABLE' || observation.status === 'UNKNOWN') {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(observation.selection),
        reason: observation.reason ?? 'EXECUTOR_UNAVAILABLE'
      }
    }

    if (observation.status === 'AWAITING_APPROVAL') {
      return {
        status: 'ACTIVE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        attemptStatus: 'STARTING',
        unitFlowStatus: 'RESERVED',
        ...selectionFields(observation.selection),
        ...legacyStatusMetadata(observation)
      }
    }

    if (observation.status === 'RUNNING') {
      if (attempt.status === 'STARTING') {
        try {
          this.smcService.transitionAttemptToRunning(
            validRepoId,
            cleanAttemptId,
            attempt.revision,
            attempt.unitId,
            unitState.revision
          )
        } catch {}
      }
      const currentAttempt = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId)
      const currentUnit = store.getUnitState(cleanSessionId, attempt.planId, attempt.unitId)
      return {
        status: 'ACTIVE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        attemptStatus: currentAttempt?.status ?? 'RUNNING',
        unitFlowStatus: currentUnit?.status ?? 'EXECUTING',
        ...selectionFields(observation.selection),
        ...legacyStatusMetadata(observation)
      }
    }

    if (observation.phase === 'TERMINATION_UNCONFIRMED') {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        attemptStatus: attempt.status,
        unitFlowStatus: unitState.status,
        ...selectionFields(observation.selection),
        ...legacyStatusMetadata(observation),
        exitCode: observation.exitCode,
        reason: 'TERMINATION_UNCONFIRMED'
      }
    }

    if (observation.status === 'SUCCEEDED') {
      const confirmed = await this.verifyTerminationConfirmed(
        executor,
        validRepoId,
        cleanSessionId,
        cleanAttemptId,
        observation,
        true
      )
      if (!confirmed) {
        return {
          status: 'UNKNOWN',
          attemptId: cleanAttemptId,
          sessionId: cleanSessionId,
          repositoryId: validRepoId,
          planId: attempt.planId,
          unitId: attempt.unitId,
          attemptStatus: attempt.status,
          unitFlowStatus: unitState.status,
          ...selectionFields(observation.selection),
          ...legacyStatusMetadata(observation),
          exitCode: observation.exitCode,
          reason: 'TERMINATION_UNCONFIRMED'
        }
      }

      return this.settleAttemptWithSmc(
        validRepoId,
        cleanSessionId,
        cleanAttemptId,
        attempt,
        unitState.revision,
        observation,
        'SUCCEEDED',
        'VALIDATION_READY',
        {
          title: `Execution attempt completed: ${attempt.unitId}`,
          body: JSON.stringify({
            attemptId: cleanAttemptId,
            unitId: attempt.unitId,
            planId: attempt.planId,
            terminalOutcome: 'SUCCEEDED',
            ...legacyStatusMetadata(observation),
            exitCode: observation.exitCode,
            durationMs: observation.durationMs,
            ...timeoutMetadata(observation),
            ...(observation.legacyExecution?.treeObservation !== undefined
              ? { treeObservation: observation.legacyExecution.treeObservation }
              : {}),
            executorSelection: observation.selection,
            ...(observation.termination ? { termination: observation.termination } : {}),
            ...(observation.result ? { result: observation.result } : {})
          }),
          kind: 'RESULT'
        }
      )
    }

    if (observation.status === 'REFUSED') {
      const refusalReason = observation.reason ?? 'NATIVE_APPROVAL_REFUSED'
      return this.settleAttemptWithSmc(
        validRepoId,
        cleanSessionId,
        cleanAttemptId,
        attempt,
        unitState.revision,
        observation,
        'CANCELLED',
        'RECONCILING',
        {
          title: `Execution attempt refused: ${attempt.unitId}`,
          body: JSON.stringify({
            attemptId: cleanAttemptId,
            unitId: attempt.unitId,
            planId: attempt.planId,
            terminalOutcome: 'CANCELLED',
            ...legacyStatusMetadata(observation),
            reason: refusalReason,
            ...timeoutMetadata(observation),
            executorSelection: observation.selection
          }),
          kind: 'PENDING'
        },
        refusalReason
      )
    }

    if (
      observation.status === 'FAILED' ||
      observation.status === 'TIMED_OUT' ||
      observation.status === 'CANCELLED' ||
      observation.status === 'INTERRUPTED'
    ) {
      const confirmed = await this.verifyTerminationConfirmed(
        executor,
        validRepoId,
        cleanSessionId,
        cleanAttemptId,
        observation,
        false
      )
      if (!confirmed) {
        return {
          status: 'UNKNOWN',
          attemptId: cleanAttemptId,
          sessionId: cleanSessionId,
          repositoryId: validRepoId,
          planId: attempt.planId,
          unitId: attempt.unitId,
          attemptStatus: attempt.status,
          unitFlowStatus: unitState.status,
          ...selectionFields(observation.selection),
          ...legacyStatusMetadata(observation),
          exitCode: observation.exitCode,
          reason: 'TERMINATION_UNCONFIRMED'
        }
      }

      const classifiedReason = observation.reason ?? observation.status
      const terminalOutcome = observation.status === 'CANCELLED' ? 'CANCELLED' : 'FAILED'
      const rawStatusLabel = observation.legacyExecution?.status ?? observation.status

      return this.settleAttemptWithSmc(
        validRepoId,
        cleanSessionId,
        cleanAttemptId,
        attempt,
        unitState.revision,
        observation,
        terminalOutcome,
        'RECONCILING',
        {
          title: `Execution attempt failed: ${attempt.unitId} (${rawStatusLabel})`,
          body: JSON.stringify({
            attemptId: cleanAttemptId,
            unitId: attempt.unitId,
            planId: attempt.planId,
            terminalOutcome,
            ...legacyStatusMetadata(observation),
            exitCode: observation.exitCode,
            durationMs: observation.durationMs,
            ...timeoutMetadata(observation),
            ...(observation.legacyExecution?.treeObservation !== undefined
              ? { treeObservation: observation.legacyExecution.treeObservation }
              : {}),
            ...(observation.legacyExecution?.diagnostic !== undefined
              ? { diagnostic: observation.legacyExecution.diagnostic }
              : {}),
            reason: classifiedReason,
            executorSelection: observation.selection,
            ...(observation.termination ? { termination: observation.termination } : {}),
            ...(observation.result ? { result: observation.result } : {})
          }),
          kind: 'PENDING'
        },
        classifiedReason
      )
    }

    return {
      status: 'UNKNOWN',
      attemptId: cleanAttemptId,
      sessionId: cleanSessionId,
      repositoryId: validRepoId,
      ...selectionFields(observation.selection),
      reason: `UNRECOGNIZED_EXECUTOR_STATUS: ${observation.status}`
    }
  }

  private async verifyTerminationConfirmed(
    executor: UnitExecutorPort,
    validRepoId: string,
    cleanSessionId: string,
    cleanAttemptId: string,
    observation: ExecutorRunObservation,
    requireZeroExitWhenPresent: boolean
  ): Promise<boolean> {
    if (observation.phase !== 'TERMINAL') {
      return false
    }
    if (
      requireZeroExitWhenPresent &&
      observation.exitCode !== undefined &&
      observation.exitCode !== null &&
      observation.exitCode !== 0
    ) {
      return false
    }

    let termination: ExecutorTerminationConfirmation | undefined = observation.termination
    if (!termination && executor.confirmTermination) {
      try {
        termination = await executor.confirmTermination({
          repositoryId: validRepoId,
          sessionId: cleanSessionId,
          attemptId: cleanAttemptId
        })
      } catch {
        return false
      }
    }

    return termination?.confirmed === true
  }

  private settleAttemptWithSmc(
    validRepoId: string,
    cleanSessionId: string,
    cleanAttemptId: string,
    attempt: ExecutionAttemptRecord,
    fallbackUnitRevision: number,
    observation: ExecutorRunObservation,
    terminalOutcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED',
    resultStatus: 'VALIDATION_READY' | 'RECONCILING',
    entryData: { title: string; body: string; kind: 'RESULT' | 'PENDING' },
    resultReason?: string
  ): UnitSettlementResult {
    const store = this.smcService.getStore(validRepoId)
    const currentAttempt = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId) ?? attempt
    const currentUnit = store.getUnitState(cleanSessionId, attempt.planId, attempt.unitId)
    const expectedUnitRevision = currentUnit?.revision ?? fallbackUnitRevision

    let settledAttempt: ExecutionAttemptRecord
    try {
      settledAttempt = this.smcService.transitionAttemptToSettled(validRepoId, {
        attemptId: cleanAttemptId,
        expectedAttemptRevision: currentAttempt.revision,
        unitId: attempt.unitId,
        expectedUnitRevision,
        terminalOutcome,
        entryData
      })
    } catch (err: any) {
      if (err instanceof ExecutionAttemptConflictError) {
        const recheck = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId)
        const expectedStates =
          terminalOutcome === 'SUCCEEDED' ? ['COMPLETED'] : ['FAILED', 'CANCELLED']
        if (recheck && expectedStates.includes(recheck.status)) {
          settledAttempt = recheck
        } else {
          return {
            status: 'UNKNOWN',
            attemptId: cleanAttemptId,
            sessionId: cleanSessionId,
            repositoryId: validRepoId,
            reason: `SETTLE_CONFLICT: ${err.message}`
          }
        }
      } else {
        return {
          status: 'UNKNOWN',
          attemptId: cleanAttemptId,
          sessionId: cleanSessionId,
          repositoryId: validRepoId,
          reason: `SETTLE_ERROR: ${err?.message ?? String(err)}`
        }
      }
    }

    this.stageService.releaseAttemptRetention(cleanAttemptId)

    const finalUnit = store.getUnitState(cleanSessionId, attempt.planId, attempt.unitId)
    return {
      status: resultStatus,
      attemptId: cleanAttemptId,
      sessionId: cleanSessionId,
      repositoryId: validRepoId,
      planId: attempt.planId,
      unitId: attempt.unitId,
      attemptStatus: settledAttempt.status,
      unitFlowStatus: finalUnit?.status,
      ...selectionFields(observation.selection),
      ...legacyStatusMetadata(observation),
      exitCode: observation.exitCode,
      ...(resultReason !== undefined ? { reason: resultReason } : {}),
      ...timeoutMetadata(observation),
      ...outcomeMetadata(observation)
    }
  }

  private async observeRunningAttempt(
    executor: UnitExecutorPort,
    cleanAttemptId: string,
    cleanSessionId: string,
    validRepoId: string,
    options?: { readOnly?: boolean }
  ): Promise<UnitExecutionResult> {
    let observation: ExecutorRunObservation
    try {
      observation = await executor.observeAttempt({
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId
      })
    } catch (err: any) {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(executor.identity),
        reason: err?.message ?? String(err)
      }
    }

    const attempt = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId)
    if (attempt?.executorSelection && !executorSelectionsEqual(attempt.executorSelection, observation.selection)) {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(attempt.executorSelection),
        reason: 'EXECUTOR_SELECTION_CONFLICT'
      }
    }

    if (observation.status === 'UNKNOWN' || observation.status === 'UNAVAILABLE') {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(observation.selection),
        reason: observation.reason ?? 'EXECUTOR_UNAVAILABLE'
      }
    }

    const store = this.smcService.getStore(validRepoId)
    const unitState = attempt ? store.getUnitState(cleanSessionId, attempt.planId, attempt.unitId) : null

    return this.applyObservationToStartOrObserve(
      observation,
      validRepoId,
      cleanSessionId,
      cleanAttemptId,
      attempt?.revision ?? 0,
      attempt?.unitId ?? '',
      unitState?.revision ?? 0,
      Boolean(options?.readOnly)
    )
  }

  private applyObservationToStartOrObserve(
    observation: ExecutorRunObservation,
    validRepoId: string,
    cleanSessionId: string,
    cleanAttemptId: string,
    attemptRevision: number,
    unitId: string,
    unitRevision: number,
    readOnly: boolean
  ): UnitExecutionResult {
    if (observation.status === 'AWAITING_APPROVAL') {
      return {
        status: 'AWAITING_APPROVAL',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(observation.selection),
        ...legacyStatusMetadata(observation),
        unitFlowStatus: 'RESERVED',
        ...timeoutMetadata(observation)
      }
    }

    if (observation.status === 'RUNNING') {
      if (readOnly) {
        return {
          status: 'RUNNING',
          attemptId: cleanAttemptId,
          sessionId: cleanSessionId,
          repositoryId: validRepoId,
          ...selectionFields(observation.selection),
          ...legacyStatusMetadata(observation),
          unitFlowStatus: 'EXECUTING',
          ...timeoutMetadata(observation)
        }
      }

      const currentAttempt = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId)
      if (currentAttempt && currentAttempt.status === 'STARTING') {
        const store = this.smcService.getStore(validRepoId)
        const currentUnit = store.getUnitState(cleanSessionId, currentAttempt.planId, currentAttempt.unitId)
        if (currentUnit && currentUnit.status === 'RESERVED') {
          try {
            this.smcService.transitionAttemptToRunning(
              validRepoId,
              cleanAttemptId,
              currentAttempt.revision || attemptRevision,
              unitId || currentAttempt.unitId,
              currentUnit.revision || unitRevision
            )
          } catch (err: any) {
            if (!(err instanceof ExecutionAttemptConflictError)) {
              return {
                status: 'UNKNOWN',
                attemptId: cleanAttemptId,
                sessionId: cleanSessionId,
                repositoryId: validRepoId,
                ...selectionFields(observation.selection),
                reason: `CAS_RUNNING_ERROR: ${err?.message ?? String(err)}`
              }
            }
          }
        }
      }

      const recheck = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId)
      if (recheck?.status === 'RUNNING') {
        return {
          status: 'RUNNING',
          attemptId: cleanAttemptId,
          sessionId: cleanSessionId,
          repositoryId: validRepoId,
          ...selectionFields(observation.selection),
          ...legacyStatusMetadata(observation),
          unitFlowStatus: 'EXECUTING',
          ...timeoutMetadata(observation)
        }
      }

      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(observation.selection),
        reason: 'CAS_RUNNING_NOT_ESTABLISHED'
      }
    }

    if (observation.status === 'REFUSED') {
      if (!readOnly) {
        this.stageService.releaseAttemptRetention(cleanAttemptId)
      }
      return {
        status: 'REFUSED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        ...selectionFields(observation.selection),
        ...legacyStatusMetadata(observation),
        unitFlowStatus: 'RESERVED',
        reason: observation.reason ?? 'NATIVE_APPROVAL_REFUSED',
        ...timeoutMetadata(observation)
      }
    }

    if (!readOnly) {
      this.stageService.releaseAttemptRetention(cleanAttemptId)
    }
    return {
      status: 'TERMINAL_OBSERVED',
      attemptId: cleanAttemptId,
      sessionId: cleanSessionId,
      repositoryId: validRepoId,
      ...selectionFields(observation.selection),
      ...legacyStatusMetadata(observation),
      ...(observation.status !== 'SUCCEEDED' ? { reason: observation.reason ?? observation.status } : {}),
      ...timeoutMetadata(observation),
      ...outcomeMetadata(observation)
    }
  }
}
