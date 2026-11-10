import { validateRepositoryId } from '../smc/session-memory-central-paths'
import type { SessionMemoryCentralService } from '../smc/session-memory-central-service'
import type { WorkspaceBindingService } from './workspace-binding-service'
import type { UnitPromptStageService } from './unit-prompt-stage-service'
import type {
  StartUnitExecutionOptions,
  UnitExecutionResult,
  UnitExecutionStatus,
  ExecutionAttemptRecord,
  UnitSettlementResult
} from '../../../shared/types/buildx/execution-types'
import type { BuildXInspectWorkspaceResult } from '../../../shared/types/buildx/workspace-types'
import type { CliPolicy } from '../../../shared/types/cli-policy-types'
import type {
  CliExecutionSnapshot
} from '../../cli-execution/cli-execution-types'
import type { CliExecutionPort, CliExecutionResolver } from './grok-cli-bridge'
import { ExecutionAttemptConflictError } from './execution-errors'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function timeoutMetadata(record: Pick<CliExecutionSnapshot, 'timeoutProfile' | 'timeoutMs'>): {
  timeoutProfile?: string
  timeoutMs?: number
} {
  return {
    ...(record.timeoutProfile ? { timeoutProfile: record.timeoutProfile } : {}),
    ...(record.timeoutMs !== undefined ? { timeoutMs: record.timeoutMs } : {})
  }
}

function classifyObservedGrokOutcome(snapshot: CliExecutionSnapshot): string {
  const diagnostic = typeof snapshot.diagnostic === 'string' && snapshot.diagnostic.trim()
    ? snapshot.diagnostic.trim()
    : undefined
  const output = `${snapshot.stdout ?? ''}\n${snapshot.stderr ?? ''}`

  if (snapshot.status === 'TIMED_OUT') {
    if (/\b(approval required|confirmation required|waiting for approval|use --always-approve|allow tool)\b/i.test(output)) {
      return 'APPROVAL_PROMPT_TIMED_OUT'
    }
    return diagnostic ?? 'TIMED_OUT'
  }
  if (snapshot.status === 'CANCELLED' || snapshot.status === 'INTERRUPTED') {
    return diagnostic ?? snapshot.status
  }
  if (snapshot.status === 'FAILED') {
    if (/\b(approval required|interactive permission|use --always-approve)\b/i.test(output)) {
      return 'GROK_APPROVAL_REQUIRED'
    }
    if (/\b(unknown option|unknown flag|unrecognized arguments?|invalid option)\b/i.test(output)) {
      return 'GROK_ARGUMENT_ERROR'
    }
    if (/\b(insufficient credits|quota exceeded|rate limit|billing|payment required|429)\b/i.test(output)) {
      return 'GROK_QUOTA_OR_RATE_LIMIT'
    }
    if (/\b(invalid api key|authentication failed|not authenticated|unauthorized|401|XAI_API_KEY)\b/i.test(output)) {
      return 'GROK_AUTHENTICATION_FAILED'
    }
    if (diagnostic) return diagnostic
    if (snapshot.exitCode !== null && snapshot.exitCode !== undefined) {
      return `NON_ZERO_EXIT_CODE_${snapshot.exitCode}`
    }
    return 'FAILED'
  }
  return diagnostic ?? snapshot.status
}

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

    // Handle replay: attempt already STARTING or RUNNING -> delegate directly to observation
    if (attempt.status === 'STARTING' || attempt.status === 'RUNNING') {
      return this.observeRunningAttempt(cliService, cleanAttemptId, cleanSessionId, validRepoId)
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

    // Retém o arquivo de prompt em memória enquanto a CLI prepara e executa
    this.stageService.retainStage(options.stageOperationId, cleanAttemptId)

    // Derive autonomous permission strictly from local Desktop grant for this Worktree when available
    let hostPolicy: CliPolicy | undefined
    if (typeof cliService.getPolicyForWorktree === 'function') {
      try {
        hostPolicy = await cliService.getPolicyForWorktree({
          worktreeId: attempt.worktreeId,
          generation: attempt.generation
        })
      } catch (err: any) {
        this.stageService.releaseStageRetention(options.stageOperationId, cleanAttemptId)
        return {
          status: 'UNAVAILABLE',
          attemptId: cleanAttemptId,
          sessionId: cleanSessionId,
          repositoryId: validRepoId,
          reason: `CLI_POLICY_ERROR: ${err?.message ?? String(err)}`
        }
      }
    }

    const hostYoloAuthorized =
      hostPolicy?.mode === 'AUTONOMOUS_TRUSTED' &&
      hostPolicy?.scope === 'REPOSITORY_WORKTREES'
    const allowAlwaysApprove = hostPolicy !== undefined ? hostYoloAuthorized : options.allowAlwaysApprove === true

    // 7. Prepare CLI proposal (agentic Worktree unit timeout profile: 10m default, 15m hard cap)
    const headlessArgs = [
      '--prompt-file', stagePath,
      '--output-format', 'json',
      '--no-auto-update',
      ...(allowAlwaysApprove ? ['--always-approve'] : [])
    ]

    let proposal: Awaited<ReturnType<typeof cliService.prepare>>
    try {
      proposal = await cliService.prepare({
        worktree: { worktreeId: attempt.worktreeId, generation: attempt.generation },
        executable: 'grok',
        args: headlessArgs,
        executionProfile: 'BUILDX_AGENTIC_UNIT'
      })
    } catch (err: any) {
      this.stageService.releaseStageRetention(options.stageOperationId, cleanAttemptId)
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
      this.stageService.releaseStageRetention(options.stageOperationId, cleanAttemptId)
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'PROPOSAL_VALIDATION_FAILED'
      }
    }

    if (proposal.autoAuthorized === true && !allowAlwaysApprove) {
      this.stageService.releaseStageRetention(options.stageOperationId, cleanAttemptId)
      return {
        status: 'REFUSED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'AUTO_AUTHORIZED_NOT_REQUESTED'
      }
    }

    if (
      allowAlwaysApprove &&
      hostPolicy !== undefined &&
      (proposal.policy?.mode !== 'AUTONOMOUS_TRUSTED' ||
        proposal.policy?.scope !== 'REPOSITORY_WORKTREES' ||
        proposal.autoAuthorized !== true)
    ) {
      this.stageService.releaseStageRetention(options.stageOperationId, cleanAttemptId)
      return {
        status: 'REFUSED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'POLICY_CHANGED'
      }
    }

    // 9. CAS: PREPARED → STARTING
    let startingAttempt: ExecutionAttemptRecord
    try {
      startingAttempt = this.smcService.transitionAttemptToStarting(validRepoId, cleanAttemptId, attempt.revision)
    } catch (err: any) {
      if (err instanceof ExecutionAttemptConflictError) {
        // Re-read current state and observe; keep retention active for the active attempt
        const current = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId)
        if (current?.status === 'STARTING' || current?.status === 'RUNNING') {
          return this.observeRunningAttempt(cliService, cleanAttemptId, cleanSessionId, validRepoId)
        }
      }
      this.stageService.releaseStageRetention(options.stageOperationId, cleanAttemptId)
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
      this.stageService.releaseStageRetention(options.stageOperationId, cleanAttemptId)
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
      // After CAS to STARTING, start threw — state is ambiguous; leave attempt STARTING and keep retention
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
      // Prompts permanecem retidos enquanto aguarda aprovação
      return {
        status: 'AWAITING_APPROVAL',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        cliStatus: snapshot.status,
        cliPhase: snapshot.phase,
        unitFlowStatus: 'RESERVED',
        ...timeoutMetadata(snapshot)
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
      } catch (err: any) {
        if (!(err instanceof ExecutionAttemptConflictError)) {
          return {
            status: 'UNKNOWN',
            attemptId: cleanAttemptId,
            sessionId: cleanSessionId,
            repositoryId: validRepoId,
            reason: `CAS_RUNNING_ERROR: ${err?.message ?? String(err)}`
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
          cliStatus: snapshot.status,
          cliPhase: snapshot.phase,
          unitFlowStatus: 'EXECUTING',
          ...timeoutMetadata(snapshot)
        }
      }
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'CAS_RUNNING_NOT_ESTABLISHED'
      }
    }

    if (snapshot.status === 'REFUSED') {
      this.stageService.releaseAttemptRetention(cleanAttemptId)
      return {
        status: 'REFUSED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        cliStatus: snapshot.status,
        unitFlowStatus: 'RESERVED',
        reason: snapshot.diagnostic ?? 'NATIVE_APPROVAL_REFUSED',
        ...timeoutMetadata(snapshot)
      }
    }

    // Terminal states: SUCCEEDED, FAILED, CANCELLED, TIMED_OUT, INTERRUPTED
    this.stageService.releaseAttemptRetention(cleanAttemptId)
    return {
      status: 'TERMINAL_OBSERVED',
      attemptId: cleanAttemptId,
      sessionId: cleanSessionId,
      repositoryId: validRepoId,
      cliStatus: snapshot.status,
      cliPhase: snapshot.phase,
      ...(snapshot.status !== 'SUCCEEDED' ? { reason: classifyObservedGrokOutcome(snapshot) } : {}),
      ...timeoutMetadata(snapshot)
    }
  }

  async observeUnitExecution(
    repositoryId: string,
    sessionId: string,
    attemptId: string,
    options?: { readOnly?: boolean }
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

    if (attempt.status !== 'STARTING' && attempt.status !== 'RUNNING') {
      return {
        status: 'UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: `ATTEMPT_NOT_ACTIVE: status=${attempt.status}`
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

    return this.observeRunningAttempt(cliService, cleanAttemptId, cleanSessionId, validRepoId, options)
  }

  async settleUnitExecution(
    repositoryId: string,
    sessionId: string,
    attemptId: string
  ): Promise<UnitSettlementResult> {
    let validRepoId: string
    try {
      validRepoId = validateRepositoryId(repositoryId)
    } catch {
      return {
        status: 'UNKNOWN',
        attemptId: attemptId ?? '',
        sessionId: sessionId ?? '',
        repositoryId: repositoryId ?? '',
        reason: 'INVALID_REPOSITORY_ID'
      }
    }

    if (typeof sessionId !== 'string' || !sessionId.trim() || !UUID_REGEX.test(sessionId.trim())) {
      return {
        status: 'UNKNOWN',
        attemptId: attemptId ?? '',
        sessionId: sessionId ?? '',
        repositoryId: validRepoId,
        reason: 'INVALID_SESSION_ID'
      }
    }
    const cleanSessionId = sessionId.trim().toLowerCase()

    if (typeof attemptId !== 'string' || !attemptId.trim() || !UUID_REGEX.test(attemptId.trim())) {
      return {
        status: 'UNKNOWN',
        attemptId: attemptId ?? '',
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'INVALID_ATTEMPT_ID'
      }
    }
    const cleanAttemptId = attemptId.trim().toLowerCase()

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

    // Replay / idempotência: se já finalizado em estado terminal
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
        cliStatus: attempt.status
      }
    }

    if (attempt.status !== 'STARTING' && attempt.status !== 'RUNNING') {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
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

    const cliService = await this.cliResolver(validRepoId)
    if (!cliService || !cliService.isEnabled() || !cliService.get) {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'CLI_UNAVAILABLE'
      }
    }

    let snapshot: CliExecutionSnapshot
    try {
      snapshot = await cliService.get({ operationId: cleanAttemptId })
    } catch (err: any) {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: `CLI_GET_ERROR: ${err?.message ?? String(err)}`
      }
    }

    // Classificação dos fatos
    if (snapshot.status === 'AWAITING_APPROVAL') {
      return {
        status: 'ACTIVE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        attemptStatus: 'STARTING',
        unitFlowStatus: 'RESERVED',
        cliStatus: snapshot.status,
        cliPhase: snapshot.phase
      }
    }

    if (snapshot.status === 'RUNNING') {
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
        cliStatus: snapshot.status,
        cliPhase: snapshot.phase
      }
    }

    if (snapshot.phase === 'TERMINATION_UNCONFIRMED') {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        attemptStatus: attempt.status,
        unitFlowStatus: unitState.status,
        cliStatus: snapshot.status,
        cliPhase: snapshot.phase,
        exitCode: snapshot.exitCode,
        reason: 'TERMINATION_UNCONFIRMED'
      }
    }

    if (snapshot.status === 'SUCCEEDED') {
      const isCleanTree = Boolean(
        snapshot.treeObservation &&
        snapshot.treeObservation.activeProcesses === 0 &&
        snapshot.treeObservation.handlesClosed === true
      )
      const isTerminalPhase = snapshot.phase === 'TERMINAL'
      const isZeroExit = snapshot.exitCode === 0

      if (!isCleanTree || !isTerminalPhase || !isZeroExit) {
        return {
          status: 'UNKNOWN',
          attemptId: cleanAttemptId,
          sessionId: cleanSessionId,
          repositoryId: validRepoId,
          planId: attempt.planId,
          unitId: attempt.unitId,
          attemptStatus: attempt.status,
          unitFlowStatus: unitState.status,
          cliStatus: snapshot.status,
          cliPhase: snapshot.phase,
          exitCode: snapshot.exitCode,
          reason: 'TERMINATION_UNCONFIRMED'
        }
      }

      const currentAttempt = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId) ?? attempt
      const currentUnit = store.getUnitState(cleanSessionId, attempt.planId, attempt.unitId) ?? unitState

      let settledAttempt: ExecutionAttemptRecord
      try {
        settledAttempt = this.smcService.transitionAttemptToSettled(validRepoId, {
          attemptId: cleanAttemptId,
          expectedAttemptRevision: currentAttempt.revision,
          unitId: attempt.unitId,
          expectedUnitRevision: currentUnit.revision,
          terminalOutcome: 'SUCCEEDED',
            entryData: {
              title: `Execution attempt completed: ${attempt.unitId}`,
              body: JSON.stringify({
                attemptId: cleanAttemptId,
                unitId: attempt.unitId,
                planId: attempt.planId,
                terminalOutcome: 'SUCCEEDED',
                cliStatus: snapshot.status,
                cliPhase: snapshot.phase,
                exitCode: snapshot.exitCode,
                durationMs: snapshot.durationMs,
                ...timeoutMetadata(snapshot),
                treeObservation: snapshot.treeObservation
              }),
              kind: 'RESULT'
            }
          })
      } catch (err: any) {
        if (err instanceof ExecutionAttemptConflictError) {
          const recheck = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId)
          if (recheck?.status === 'COMPLETED') {
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
        status: 'VALIDATION_READY',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        attemptStatus: settledAttempt.status,
        unitFlowStatus: finalUnit?.status,
        cliStatus: snapshot.status,
        cliPhase: snapshot.phase,
        exitCode: snapshot.exitCode,
        ...timeoutMetadata(snapshot)
      }
    }

    if (snapshot.status === 'REFUSED') {
      const refusalReason = snapshot.diagnostic ?? 'NATIVE_APPROVAL_REFUSED'
      const currentAttempt = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId) ?? attempt
      const currentUnit = store.getUnitState(cleanSessionId, attempt.planId, attempt.unitId) ?? unitState

      let settledAttempt: ExecutionAttemptRecord
      try {
        settledAttempt = this.smcService.transitionAttemptToSettled(validRepoId, {
          attemptId: cleanAttemptId,
          expectedAttemptRevision: currentAttempt.revision,
          unitId: attempt.unitId,
          expectedUnitRevision: currentUnit.revision,
          terminalOutcome: 'CANCELLED',
          entryData: {
            title: `Execution attempt refused: ${attempt.unitId}`,
            body: JSON.stringify({
              attemptId: cleanAttemptId,
              unitId: attempt.unitId,
              planId: attempt.planId,
              terminalOutcome: 'CANCELLED',
              cliStatus: snapshot.status,
              cliPhase: snapshot.phase,
              reason: refusalReason,
              ...timeoutMetadata(snapshot)
            }),
            kind: 'PENDING'
          }
        })
      } catch (err: any) {
        if (err instanceof ExecutionAttemptConflictError) {
          const recheck = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId)
          if (recheck?.status === 'CANCELLED' || recheck?.status === 'FAILED') {
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
        status: 'RECONCILING',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        attemptStatus: settledAttempt.status,
        unitFlowStatus: finalUnit?.status,
        cliStatus: snapshot.status,
        cliPhase: snapshot.phase,
        exitCode: snapshot.exitCode,
        reason: refusalReason,
        ...timeoutMetadata(snapshot)
      }
    }

    if (
      snapshot.status === 'FAILED' ||
      snapshot.status === 'TIMED_OUT' ||
      snapshot.status === 'CANCELLED' ||
      snapshot.status === 'INTERRUPTED'
    ) {
      const isCleanTree = Boolean(
        snapshot.treeObservation &&
        snapshot.treeObservation.activeProcesses === 0 &&
        snapshot.treeObservation.handlesClosed === true
      )
      const isTerminalPhase = snapshot.phase === 'TERMINAL'

      if (!isCleanTree || !isTerminalPhase) {
        return {
          status: 'UNKNOWN',
          attemptId: cleanAttemptId,
          sessionId: cleanSessionId,
          repositoryId: validRepoId,
          planId: attempt.planId,
          unitId: attempt.unitId,
          attemptStatus: attempt.status,
          unitFlowStatus: unitState.status,
          cliStatus: snapshot.status,
          cliPhase: snapshot.phase,
          exitCode: snapshot.exitCode,
          reason: 'TERMINATION_UNCONFIRMED'
        }
      }

      const classifiedReason = classifyObservedGrokOutcome(snapshot)
      const terminalOutcome = snapshot.status === 'CANCELLED' ? 'CANCELLED' : 'FAILED'
      const currentAttempt = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId) ?? attempt
      const currentUnit = store.getUnitState(cleanSessionId, attempt.planId, attempt.unitId) ?? unitState

      let settledAttempt: ExecutionAttemptRecord
      try {
        settledAttempt = this.smcService.transitionAttemptToSettled(validRepoId, {
          attemptId: cleanAttemptId,
          expectedAttemptRevision: currentAttempt.revision,
          unitId: attempt.unitId,
          expectedUnitRevision: currentUnit.revision,
          terminalOutcome,
          entryData: {
            title: `Execution attempt failed: ${attempt.unitId} (${snapshot.status})`,
            body: JSON.stringify({
              attemptId: cleanAttemptId,
              unitId: attempt.unitId,
              planId: attempt.planId,
              terminalOutcome,
              cliStatus: snapshot.status,
              cliPhase: snapshot.phase,
              exitCode: snapshot.exitCode,
              durationMs: snapshot.durationMs,
              ...timeoutMetadata(snapshot),
              treeObservation: snapshot.treeObservation,
              diagnostic: snapshot.diagnostic,
              reason: classifiedReason
            }),
            kind: 'PENDING'
          }
        })
      } catch (err: any) {
        if (err instanceof ExecutionAttemptConflictError) {
          const recheck = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId)
          if (recheck?.status === 'FAILED' || recheck?.status === 'CANCELLED') {
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
        status: 'RECONCILING',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        planId: attempt.planId,
        unitId: attempt.unitId,
        attemptStatus: settledAttempt.status,
        unitFlowStatus: finalUnit?.status,
        cliStatus: snapshot.status,
        cliPhase: snapshot.phase,
        exitCode: snapshot.exitCode,
        reason: classifiedReason,
        ...timeoutMetadata(snapshot)
      }
    }

    return {
      status: 'UNKNOWN',
      attemptId: cleanAttemptId,
      sessionId: cleanSessionId,
      repositoryId: validRepoId,
      reason: `UNRECOGNIZED_CLI_STATUS: ${snapshot.status}`
    }
  }

  private async observeRunningAttempt(
    cliService: CliExecutionPort,
    cleanAttemptId: string,
    cleanSessionId: string,
    validRepoId: string,
    options?: { readOnly?: boolean }
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

    let snapshot: CliExecutionSnapshot
    try {
      snapshot = await cliService.get({ operationId: cleanAttemptId })
    } catch (err: any) {
      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: `CLI_GET_ERROR: ${err?.message ?? String(err)}`
      }
    }

    if (snapshot.status === 'AWAITING_APPROVAL') {
      return {
        status: 'AWAITING_APPROVAL',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        cliStatus: snapshot.status,
        cliPhase: snapshot.phase,
        unitFlowStatus: 'RESERVED',
        ...timeoutMetadata(snapshot)
      }
    }

    if (snapshot.status === 'RUNNING') {
      if (options?.readOnly) {
        return {
          status: 'RUNNING',
          attemptId: cleanAttemptId,
          sessionId: cleanSessionId,
          repositoryId: validRepoId,
          cliStatus: snapshot.status,
          cliPhase: snapshot.phase,
          unitFlowStatus: 'EXECUTING',
          ...timeoutMetadata(snapshot)
        }
      }

      // Re-consult SMC state: if attempt is in STARTING, execute atomic CAS transition to RUNNING and unit to EXECUTING
      const currentAttempt = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId)
      if (currentAttempt && currentAttempt.status === 'STARTING') {
        const store = this.smcService.getStore(validRepoId)
        const unitState = store.getUnitState(cleanSessionId, currentAttempt.planId, currentAttempt.unitId)
        if (unitState && unitState.status === 'RESERVED') {
          try {
            this.smcService.transitionAttemptToRunning(
              validRepoId,
              cleanAttemptId,
              currentAttempt.revision,
              currentAttempt.unitId,
              unitState.revision
            )
          } catch (err: any) {
            if (!(err instanceof ExecutionAttemptConflictError)) {
              return {
                status: 'UNKNOWN',
                attemptId: cleanAttemptId,
                sessionId: cleanSessionId,
                repositoryId: validRepoId,
                reason: `CAS_RUNNING_ERROR: ${err?.message ?? String(err)}`
              }
            }
          }
        }
      }

      // Read back to confirm state
      const recheck = this.smcService.getExecutionAttempt(validRepoId, cleanAttemptId)
      if (recheck?.status === 'RUNNING') {
        return {
          status: 'RUNNING',
          attemptId: cleanAttemptId,
          sessionId: cleanSessionId,
          repositoryId: validRepoId,
          cliStatus: snapshot.status,
          cliPhase: snapshot.phase,
          unitFlowStatus: 'EXECUTING',
          ...timeoutMetadata(snapshot)
        }
      }

      return {
        status: 'UNKNOWN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        reason: 'CAS_RUNNING_NOT_ESTABLISHED'
      }
    }

    if (snapshot.status === 'REFUSED') {
      if (!options?.readOnly) {
        this.stageService.releaseAttemptRetention(cleanAttemptId)
      }
      return {
        status: 'REFUSED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
        cliStatus: snapshot.status,
        unitFlowStatus: 'RESERVED',
        reason: snapshot.diagnostic ?? 'NATIVE_APPROVAL_REFUSED',
        ...timeoutMetadata(snapshot)
      }
    }

    // Terminal states: SUCCEEDED, FAILED, CANCELLED, TIMED_OUT, INTERRUPTED
    if (!options?.readOnly) {
      this.stageService.releaseAttemptRetention(cleanAttemptId)
    }
    return {
      status: 'TERMINAL_OBSERVED',
      attemptId: cleanAttemptId,
      sessionId: cleanSessionId,
      repositoryId: validRepoId,
      cliStatus: snapshot.status,
      cliPhase: snapshot.phase,
      ...(snapshot.status !== 'SUCCEEDED' ? { reason: classifyObservedGrokOutcome(snapshot) } : {}),
      ...timeoutMetadata(snapshot)
    }
  }
}
