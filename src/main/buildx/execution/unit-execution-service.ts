import { validateRepositoryId } from '../smc/session-memory-central-paths'
import type { SessionMemoryCentralService } from '../smc/session-memory-central-service'
import type { WorkspaceBindingService } from './workspace-binding-service'
import type { UnitPromptStageService } from './unit-prompt-stage-service'
import type {
  StartUnitExecutionOptions,
  UnitExecutionResult,
  UnitExecutionStatus,
  ExecutionAttemptRecord
} from '../../../shared/types/buildx/execution-types'
import type { BuildXInspectWorkspaceResult } from '../../../shared/types/buildx/workspace-types'
import type {
  CliExecutionSnapshot
} from '../../cli-execution/cli-execution-types'
import type { CliExecutionPort, CliExecutionResolver } from './grok-cli-bridge'
import { ExecutionAttemptConflictError } from './execution-errors'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function mapCliStatusToUnitStatus(snapshot: CliExecutionSnapshot): UnitExecutionStatus {
  if (snapshot.status === 'AWAITING_APPROVAL') return 'AWAITING_APPROVAL'
  if (snapshot.status === 'RUNNING') return 'RUNNING'
  if (snapshot.status === 'REFUSED') return 'REFUSED'
  if (
    snapshot.status === 'SUCCEEDED' ||
    snapshot.status === 'FAILED' ||
    snapshot.status === 'CANCELLED' ||
    snapshot.status === 'TIMED_OUT' ||
    snapshot.status === 'INTERRUPTED'
  ) {
    return 'TERMINAL_OBSERVED'
  }
  return 'UNKNOWN'
}

export class UnitExecutionService {
  private readonly smcService: SessionMemoryCentralService
  private readonly workspaceService: WorkspaceBindingService
  private readonly stageService: UnitPromptStageService
  private readonly cliResolver: CliExecutionResolver

  constructor(
    smcService: SessionMemoryCentralService,
    workspaceService: WorkspaceBindingService,
    stageService: UnitPromptStageService,
    cliServiceOrResolver: CliExecutionPort | CliExecutionResolver | null
  ) {
    this.smcService = smcService
    this.workspaceService = workspaceService
    this.stageService = stageService
    if (typeof cliServiceOrResolver === 'function') {
      this.cliResolver = cliServiceOrResolver
    } else if (cliServiceOrResolver) {
      this.cliResolver = () => cliServiceOrResolver
    } else {
      this.cliResolver = () => null
    }
  }

  async startUnitExecution(
    repositoryId: string,
    sessionId: string,
    attemptId: string,
    options: StartUnitExecutionOptions
  ): Promise<UnitExecutionResult> {
    // 1. Parameter validation
    let validRepoId: string
    try {
      validRepoId = validateRepositoryId(repositoryId)
    } catch {
      return {
        status: 'UNAVAILABLE',
        attemptId: attemptId ?? '',
        sessionId: sessionId ?? '',
        repositoryId: repositoryId ?? '',
        reason: 'INVALID_REPOSITORY_ID'
      }
    }

    if (typeof sessionId !== 'string' || !sessionId.trim() || !UUID_REGEX.test(sessionId.trim())) {
      return {
        status: 'UNAVAILABLE',
        attemptId: attemptId ?? '',
        sessionId: sessionId ?? '',
        repositoryId: validRepoId,
        reason: 'INVALID_SESSION_ID'
      }
    }
    const cleanSessionId = sessionId.trim().toLowerCase()

    if (typeof attemptId !== 'string' || !attemptId.trim() || !UUID_REGEX.test(attemptId.trim())) {
      return {
        status: 'UNAVAILABLE',
        attemptId: attemptId ?? '',
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'INVALID_ATTEMPT_ID'
      }
    }
    const cleanAttemptId = attemptId.trim().toLowerCase()

    if (!options?.stageOperationId || typeof options.stageOperationId !== 'string' || !options.stageOperationId.trim()) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'STAGE_OPERATION_ID_REQUIRED'
      }
    }

    // 2. Resolve CLI service
    const cliService = await this.cliResolver(validRepoId)
    if (!cliService || !cliService.isEnabled()) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'CLI_UNAVAILABLE'
      }
    }

    const cliRepoId = cliService.getRepositoryId()
    if (cliRepoId !== null && cliRepoId !== validRepoId) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'CLI_REPOSITORY_MISMATCH'
      }
    }

    // 3. Read SMC state
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

    if (!attempt || attempt.sessionId !== cleanSessionId) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'ATTEMPT_NOT_FOUND'
      }
    }

    // Handle replay: attempt already STARTING or RUNNING
    if (attempt.status === 'STARTING') {
      return this.observeRunningAttempt(cliService, cleanAttemptId, cleanSessionId, validRepoId)
    }
    if (attempt.status === 'RUNNING') {
      return {
        status: 'RUNNING',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        cliStatus: 'RUNNING',
        unitFlowStatus: 'EXECUTING'
      }
    }
    if (attempt.status !== 'PREPARED') {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: `ATTEMPT_NOT_PREPARED: status=${attempt.status}`
      }
    }

    // 4. Verify reservation, plan, unit state
    const store = this.smcService.getStore(validRepoId)
    const reservation = store.getReservation(attempt.reservationId)
    if (!reservation || reservation.status !== 'ACTIVE' || reservation.sessionId !== cleanSessionId) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
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
        reason: 'UNIT_NOT_RESERVED'
      }
    }

    // 5. Verify workspace CURRENT
    let ws: BuildXInspectWorkspaceResult
    try {
      ws = await this.workspaceService.inspectBoundWorkspace(validRepoId, cleanSessionId)
    } catch {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
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
        reason: 'WORKSPACE_NOT_CURRENT'
      }
    }

    // 6. Resolve stage path (kept internal — not surfaced to callers)
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
        reason: 'STAGE_NOT_READY'
      }
    }

    // 7. Prepare CLI proposal
    const headlessArgs = [
      '--prompt-file', stagePath,
      '--output-format', 'json',
      '--no-auto-update',
      ...(options.allowAlwaysApprove ? ['--always-approve'] : [])
    ]

    let proposal: Awaited<ReturnType<typeof cliService.prepare>>
    try {
      proposal = await cliService.prepare({
        worktree: { worktreeId: attempt.worktreeId, generation: attempt.generation },
        executable: 'grok',
        args: headlessArgs
      })
    } catch (err: any) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: `CLI_PREPARE_ERROR: ${err?.message ?? String(err)}`
      }
    }

    // 8. Validate proposal integrity
    if (
      proposal.command.originalExecutable !== 'grok' ||
      !Array.isArray(proposal.command.originalArgs) ||
      proposal.command.originalArgs[0] !== '--prompt-file' ||
      proposal.command.originalArgs[1] !== stagePath
    ) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'PROPOSAL_VALIDATION_FAILED'
      }
    }

    if (proposal.autoAuthorized === true && !options.allowAlwaysApprove) {
      return {
        status: 'REFUSED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'AUTO_AUTHORIZED_NOT_REQUESTED'
      }
    }

    // 9. CAS: PREPARED → STARTING
    let startingAttempt: ExecutionAttemptRecord
    try {
      startingAttempt = this.smcService.transitionAttemptToStarting(validRepoId, cleanAttemptId, attempt.revision)
    } catch (err: any) {
      if (err instanceof ExecutionAttemptConflictError) {
        // Re-read current state and observe
        const current = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId)
        if (current?.status === 'STARTING') {
          return this.observeRunningAttempt(cliService, cleanAttemptId, cleanSessionId, validRepoId)
        }
        if (current?.status === 'RUNNING') {
          return {
            status: 'RUNNING',
            attemptId: cleanAttemptId,
            sessionId: cleanSessionId,
            repositoryId: validRepoId,
            unitFlowStatus: 'EXECUTING'
          }
        }
      }
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: `CAS_STARTING_ERROR: ${err?.message ?? String(err)}`
      }
    }

    // 10. Start CLI execution — operationId === attemptId (durable correlation)
    if (!cliService.start) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'CLI_START_NOT_SUPPORTED'
      }
    }

    let snapshot: CliExecutionSnapshot
    try {
      snapshot = await cliService.start({ proposalId: proposal.proposalId, operationId: cleanAttemptId })
    } catch (err: any) {
      // After CAS to STARTING, start threw — state is ambiguous; leave attempt STARTING
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: `CLI_START_ERROR: ${err?.message ?? String(err)}`
      }
    }

    // 11. Observe snapshot and transition accordingly
    if (snapshot.status === 'AWAITING_APPROVAL') {
      return {
        status: 'AWAITING_APPROVAL',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        cliStatus: snapshot.status,
        cliPhase: snapshot.phase,
        unitFlowStatus: 'RESERVED'
      }
    }

    if (snapshot.status === 'RUNNING') {
      try {
        this.smcService.transitionAttemptToRunning(
          validRepoId,
          cleanAttemptId,
          startingAttempt.revision,
          attempt.unitId,
          unitState.revision
        )
        return {
          status: 'RUNNING',
          attemptId: cleanAttemptId,
          sessionId: cleanSessionId,
          repositoryId: validRepoId,
          cliStatus: snapshot.status,
          cliPhase: snapshot.phase,
          unitFlowStatus: 'EXECUTING'
        }
      } catch (err: any) {
        return {
          status: 'UNKNOWN',
          attemptId: cleanAttemptId,
          sessionId: cleanSessionId,
          repositoryId: validRepoId,
          reason: `CAS_RUNNING_ERROR: ${err?.message ?? String(err)}`
        }
      }
    }

    if (snapshot.status === 'REFUSED') {
      return {
        status: 'REFUSED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        cliStatus: snapshot.status,
        unitFlowStatus: 'RESERVED'
      }
    }

    // Terminal states: SUCCEEDED, FAILED, CANCELLED, TIMED_OUT, INTERRUPTED
    return {
      status: 'TERMINAL_OBSERVED',
      attemptId: cleanAttemptId,
      sessionId: cleanSessionId,
      repositoryId: validRepoId,
      cliStatus: snapshot.status,
      cliPhase: snapshot.phase
    }
  }

  async observeUnitExecution(
    repositoryId: string,
    sessionId: string,
    attemptId: string
  ): Promise<UnitExecutionResult> {
    let validRepoId: string
    try {
      validRepoId = validateRepositoryId(repositoryId)
    } catch {
      return {
        status: 'UNAVAILABLE',
        attemptId: attemptId ?? '',
        sessionId: sessionId ?? '',
        repositoryId: repositoryId ?? '',
        reason: 'INVALID_REPOSITORY_ID'
      }
    }

    if (typeof sessionId !== 'string' || !sessionId.trim() || !UUID_REGEX.test(sessionId.trim())) {
      return {
        status: 'UNAVAILABLE',
        attemptId: attemptId ?? '',
        sessionId: sessionId ?? '',
        repositoryId: validRepoId,
        reason: 'INVALID_SESSION_ID'
      }
    }
    const cleanSessionId = sessionId.trim().toLowerCase()

    if (typeof attemptId !== 'string' || !attemptId.trim() || !UUID_REGEX.test(attemptId.trim())) {
      return {
        status: 'UNAVAILABLE',
        attemptId: attemptId ?? '',
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'INVALID_ATTEMPT_ID'
      }
    }
    const cleanAttemptId = attemptId.trim().toLowerCase()

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

    if (attempt.status === 'RUNNING') {
      return {
        status: 'RUNNING',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        cliStatus: 'RUNNING',
        unitFlowStatus: 'EXECUTING'
      }
    }

    const cliService = await this.cliResolver(validRepoId)
    if (!cliService || !cliService.isEnabled() || !cliService.get) {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'CLI_UNAVAILABLE'
      }
    }

    return this.observeRunningAttempt(cliService, cleanAttemptId, cleanSessionId, validRepoId)
  }

  private async observeRunningAttempt(
    cliService: CliExecutionPort,
    cleanAttemptId: string,
    cleanSessionId: string,
    validRepoId: string
  ): Promise<UnitExecutionResult> {
    if (!cliService.get) {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'CLI_GET_NOT_SUPPORTED'
      }
    }

    try {
      const snapshot = await cliService.get({ operationId: cleanAttemptId })
      const unitStatus = mapCliStatusToUnitStatus(snapshot)
      return {
        status: unitStatus,
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        cliStatus: snapshot.status,
        cliPhase: snapshot.phase
      }
    } catch (err: any) {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: `CLI_GET_ERROR: ${err?.message ?? String(err)}`
      }
    }
  }
}
