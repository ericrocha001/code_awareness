import { createHash } from 'node:crypto'
import type {
  AcceptUnitFlowOptions,
  AcceptUnitFlowResult,
  BindUnitFlowWorkspaceResult,
  CompactUnitSummary,
  OrchestrationState,
  PrepareUnitFlowPlanInput,
  PrepareUnitFlowPlanResult,
  ReconcileUnitFlowOptions,
  ReconcileUnitFlowResult,
  SettleUnitFlowResult,
  StartedUnitFlowResult,
  StartNextUnitOptions,
  UnitFlowStatusResult
} from '../../../shared/types/buildx/unitflow-runtime-types'
import {
  SmcInvalidSessionIdError,
  SmcSessionClosedError,
  SmcSessionNotFoundError
} from '../smc/session-memory-central-store'
import { validateRepositoryId } from '../smc/session-memory-central-paths'
import type { SessionMemoryCentralService } from '../smc/session-memory-central-service'
import { UnitFlowService } from './unitflow-service'
import { UnitFlowReservationService } from './unitflow-reservation-service'
import { UnitFlowAcceptanceService, type ValidationLedgerResolver, type ValidationProofLookup } from './unitflow-acceptance-service'
import { UnitFlowReconciliationService } from './unitflow-reconciliation-service'
import {
  WorkspaceBindingService,
  type GitOperationsResolver
} from '../execution/workspace-binding-service'
import { ExecutionAttemptService } from '../execution/execution-attempt-service'
import { UnitPromptStageService } from '../execution/unit-prompt-stage-service'
import { UnitExecutionService } from '../execution/unit-execution-service'
import type { CliExecutionPort, CliExecutionResolver } from '../execution/grok-cli-bridge'
import {
  UnitFlowInvalidPlanError,
  UnitFlowPlanConflictError,
  UnitFlowPlanNotFoundError
} from './unitflow-errors'
import {
  ExecutionAttemptConflictError,
  ExecutionInvalidAttemptIdError
} from '../execution/execution-errors'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function derivePlanObjectiveEntryId(planId: string): string {
  const hash = createHash('sha256').update(`smc:plan:objective:${planId.toLowerCase().trim()}`).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

export interface UnitFlowRuntimeFacadeDependencies {
  readonly repositoryId: string
  readonly repoRoot: string
  readonly smcService: SessionMemoryCentralService
  readonly gitOperations: GitOperationsResolver
  readonly cliExecution?: CliExecutionPort | CliExecutionResolver | null
  readonly validationLedger: ValidationProofLookup | ValidationLedgerResolver
  readonly stagingDirectory?: string
  readonly assertActiveProject?: () => void
}

export class UnitFlowRuntimeFacade {
  readonly repositoryId: string
  readonly repoRoot: string
  readonly smcService: SessionMemoryCentralService
  readonly unitflowService: UnitFlowService
  readonly workspaceService: WorkspaceBindingService
  readonly reservationService: UnitFlowReservationService
  readonly attemptService: ExecutionAttemptService
  readonly promptStageService: UnitPromptStageService
  readonly executionService: UnitExecutionService
  readonly acceptanceService: UnitFlowAcceptanceService
  readonly reconciliationService: UnitFlowReconciliationService
  readonly assertActiveProject?: () => void

  constructor(deps: UnitFlowRuntimeFacadeDependencies) {
    this.repositoryId = validateRepositoryId(deps.repositoryId)
    this.repoRoot = deps.repoRoot
    this.smcService = deps.smcService
    this.assertActiveProject = deps.assertActiveProject

    this.unitflowService = new UnitFlowService(this.smcService)
    this.workspaceService = new WorkspaceBindingService(this.smcService, deps.gitOperations)
    this.reservationService = new UnitFlowReservationService(this.smcService, this.workspaceService)
    this.attemptService = new ExecutionAttemptService(this.smcService, this.workspaceService)
    this.promptStageService = new UnitPromptStageService(this.smcService, this.workspaceService, {
      stagingDirectory: deps.stagingDirectory
    })
    this.executionService = new UnitExecutionService(
      this.smcService,
      this.workspaceService,
      this.promptStageService,
      deps.cliExecution ?? null
    )
    this.acceptanceService = new UnitFlowAcceptanceService(
      this.smcService,
      this.workspaceService,
      deps.validationLedger
    )
    this.reconciliationService = new UnitFlowReconciliationService(
      this.smcService,
      this.workspaceService
    )
  }

  private verifyContext(): void {
    this.assertActiveProject?.()
  }

  private validateUuid(value: unknown, name: string): string {
    if (typeof value !== 'string' || !value.trim() || !UUID_REGEX.test(value.trim())) {
      throw new Error(`INVALID_ARGUMENT: ${name} must be a valid UUID format, received: "${String(value)}"`)
    }
    return value.trim().toLowerCase()
  }

  async preparePlan(
    sessionId: string,
    input: PrepareUnitFlowPlanInput
  ): Promise<PrepareUnitFlowPlanResult> {
    this.verifyContext()
    const cleanSessionId = this.validateUuid(sessionId, 'sessionId')
    const cleanPlanId = this.validateUuid(input?.planId, 'planId')

    if (!input?.title || typeof input.title !== 'string' || !input.title.trim()) {
      throw new Error('INVALID_ARGUMENT: title is required and cannot be empty')
    }
    if (!input?.objective || typeof input.objective !== 'string' || !input.objective.trim()) {
      throw new Error('INVALID_ARGUMENT: objective is required and cannot be empty')
    }
    if (!Array.isArray(input?.units) || input.units.length === 0) {
      throw new Error('INVALID_ARGUMENT: units must be a non-empty array of unit definitions')
    }

    const session = this.smcService.getSession(this.repositoryId, cleanSessionId)
    if (!session) {
      throw new SmcSessionNotFoundError(cleanSessionId)
    }
    if (session.status === 'CLOSED') {
      throw new SmcSessionClosedError(cleanSessionId)
    }

    // Check if plan already exists for this session
    const existingPlan = this.unitflowService.getPlan(this.repositoryId, cleanPlanId)
    if (existingPlan) {
      if (existingPlan.sessionId !== cleanSessionId) {
        throw new UnitFlowPlanConflictError(
          `Plan "${cleanPlanId}" already exists and belongs to a different session "${existingPlan.sessionId}"`
        )
      }
      if (existingPlan.title.trim() !== input.title.trim()) {
        throw new UnitFlowPlanConflictError(
          `Plan "${cleanPlanId}" already exists with divergent title: expected "${existingPlan.title}", received "${input.title}"`
        )
      }
      const existingSourceArtifactId = existingPlan.sourceArtifactId?.trim() ?? ''
      const inputSourceArtifactId = input.sourceArtifactId?.trim() ?? ''
      if (existingSourceArtifactId !== inputSourceArtifactId) {
        throw new UnitFlowPlanConflictError(
          `Plan "${cleanPlanId}" already exists with divergent sourceArtifactId: expected "${existingSourceArtifactId}", received "${inputSourceArtifactId}"`
        )
      }

      const objectiveEntryId = derivePlanObjectiveEntryId(cleanPlanId)
      const objectiveEntry = this.smcService.getEntry(this.repositoryId, cleanSessionId, objectiveEntryId)
      if (objectiveEntry) {
        if (objectiveEntry.body.trim() !== input.objective.trim()) {
          throw new UnitFlowPlanConflictError(
            `Plan "${cleanPlanId}" already exists with divergent objective: expected "${objectiveEntry.body}", received "${input.objective}"`
          )
        }
      }

      const existingUnits = this.unitflowService.listPlanUnits(this.repositoryId, cleanSessionId, cleanPlanId)
      if (existingUnits.length !== input.units.length) {
        throw new UnitFlowPlanConflictError(
          `Plan "${cleanPlanId}" already exists with divergent unit count: expected ${existingUnits.length}, received ${input.units.length}`
        )
      }

      for (let idx = 0; idx < input.units.length; idx++) {
        const u = input.units[idx]
        const cleanUnitId = u.unitId.trim().toLowerCase()
        const fullUnit = this.unitflowService.getPlanUnit(this.repositoryId, cleanSessionId, cleanPlanId, cleanUnitId)
        if (!fullUnit) {
          throw new UnitFlowPlanConflictError(
            `Plan "${cleanPlanId}" already exists but unit "${cleanUnitId}" was not found`
          )
        }
        const positionMatches =
          fullUnit.position === u.position ||
          fullUnit.position === u.position + 1 ||
          (u.position === idx && fullUnit.position === idx + 1)
        if (!positionMatches) {
          throw new UnitFlowPlanConflictError(
            `Plan "${cleanPlanId}" unit "${cleanUnitId}" has divergent position: expected ${fullUnit.position}, received ${u.position}`
          )
        }
        if (fullUnit.title.trim() !== u.title.trim()) {
          throw new UnitFlowPlanConflictError(
            `Plan "${cleanPlanId}" unit "${cleanUnitId}" has divergent title: expected "${fullUnit.title}", received "${u.title}"`
          )
        }
        if (fullUnit.objective.trim() !== u.objective.trim()) {
          throw new UnitFlowPlanConflictError(
            `Plan "${cleanPlanId}" unit "${cleanUnitId}" has divergent objective`
          )
        }
        if (fullUnit.acceptanceCriteria.trim() !== u.acceptanceCriteria.trim()) {
          throw new UnitFlowPlanConflictError(
            `Plan "${cleanPlanId}" unit "${cleanUnitId}" has divergent acceptanceCriteria`
          )
        }
        const expectedDeps = [...(fullUnit.dependsOnUnitIds ?? [])].map(d => d.trim().toLowerCase()).sort()
        const inputDeps = [...(u.dependsOnUnitIds ?? [])].map((d: string) => d.trim().toLowerCase()).sort()
        if (
          expectedDeps.length !== inputDeps.length ||
          !expectedDeps.every((dep, i) => dep === inputDeps[i])
        ) {
          throw new UnitFlowPlanConflictError(
            `Plan "${cleanPlanId}" unit "${cleanUnitId}" has divergent dependsOnUnitIds`
          )
        }
      }

      const summaries: CompactUnitSummary[] = existingUnits.map(u => {
        const state = this.unitflowService.getUnitState(this.repositoryId, cleanSessionId, cleanPlanId, u.unitId)
        return {
          unitId: u.unitId,
          position: u.position,
          title: u.title,
          state: state?.status ?? 'READY'
        }
      })
      return {
        repositoryId: this.repositoryId,
        sessionId: cleanSessionId,
        planId: cleanPlanId,
        title: existingPlan.title,
        status: 'ACTIVE',
        totalUnits: summaries.length,
        units: summaries,
        replayed: true
      }
    }

    // Register plan
    this.unitflowService.registerPlan(this.repositoryId, cleanSessionId, {
      planId: cleanPlanId,
      title: input.title.trim(),
      sourceArtifactId: input.sourceArtifactId?.trim()
    })

    // Persist plan objective into SMC
    this.smcService.appendEntry(this.repositoryId, cleanSessionId, {
      entryId: derivePlanObjectiveEntryId(cleanPlanId),
      kind: 'DECISION',
      title: `Plan Objective: ${cleanPlanId}`,
      body: input.objective.trim(),
      provenance: { role: 'AGENT' }
    })

    // Define ordered units
    const definedUnits = this.unitflowService.definePlanUnits(
      this.repositoryId,
      cleanSessionId,
      cleanPlanId,
      input.units.map(u => ({
        unitId: this.validateUuid(u.unitId, 'unitId'),
        position: u.position,
        title: u.title.trim(),
        objective: u.objective.trim(),
        acceptanceCriteria: u.acceptanceCriteria.trim(),
        dependsOnUnitIds: u.dependsOnUnitIds?.map((d: string) => this.validateUuid(d, 'dependsOnUnitId'))
      }))
    )

    const summaries: CompactUnitSummary[] = definedUnits.map(u => {
      const state = this.unitflowService.getUnitState(this.repositoryId, cleanSessionId, cleanPlanId, u.unitId)
      return {
        unitId: u.unitId,
        position: u.position,
        title: u.title,
        state: state?.status ?? (u.position === 0 ? 'READY' : 'BLOCKED')
      }
    })

    return {
      repositoryId: this.repositoryId,
      sessionId: cleanSessionId,
      planId: cleanPlanId,
      title: input.title.trim(),
      status: 'ACTIVE',
      totalUnits: summaries.length,
      units: summaries
    }
  }

  async bindWorkspace(
    sessionId: string,
    worktreeId: string
  ): Promise<BindUnitFlowWorkspaceResult> {
    this.verifyContext()
    const cleanSessionId = this.validateUuid(sessionId, 'sessionId')
    const bound = await this.workspaceService.bindWorkspace(this.repositoryId, cleanSessionId, worktreeId)

    return {
      repositoryId: this.repositoryId,
      sessionId: cleanSessionId,
      worktreeId: bound.worktreeId,
      generation: bound.generation,
      branch: bound.branch,
      boundHead: bound.headAtBind,
      boundAt: bound.createdAt
    }
  }

  async startNextUnit(
    sessionId: string,
    planId: string,
    options: StartNextUnitOptions
  ): Promise<StartedUnitFlowResult> {
    this.verifyContext()
    const cleanSessionId = this.validateUuid(sessionId, 'sessionId')
    const cleanPlanId = this.validateUuid(planId, 'planId')
    const cleanReservationId = this.validateUuid(options?.reservationId, 'reservationId')
    const cleanAttemptId = this.validateUuid(options?.attemptId, 'attemptId')

    const cleanStageOpId = this.validateUuid(options?.stageOperationId, 'stageOperationId')

    // 1. Check idempotency: attempt already prepared / active
    const existingAttempt = this.smcService.getExecutionAttempt(this.repositoryId, cleanAttemptId)
    if (existingAttempt) {
      if (
        existingAttempt.sessionId !== cleanSessionId ||
        existingAttempt.planId !== cleanPlanId ||
        existingAttempt.reservationId !== cleanReservationId
      ) {
        throw new ExecutionAttemptConflictError(
          `Attempt "${cleanAttemptId}" already exists with divergent scope`
        )
      }

      if (existingAttempt.status === 'STARTING' || existingAttempt.status === 'RUNNING') {
        const obs = await this.executionService.observeUnitExecution(
          this.repositoryId,
          cleanSessionId,
          cleanAttemptId
        )
        return {
          repositoryId: this.repositoryId,
          sessionId: cleanSessionId,
          planId: cleanPlanId,
          unitId: existingAttempt.unitId,
          reservationId: cleanReservationId,
          attemptId: cleanAttemptId,
          stageOperationId: cleanStageOpId,
          status: obs.status,
          reason: obs.reason ?? null,
          proposalId: (obs as any).proposalId ?? null,
          executionId: (obs as any).executionId ?? null,
          ...(obs.timeoutProfile ? { timeoutProfile: obs.timeoutProfile } : {}),
          ...(obs.timeoutMs !== undefined ? { timeoutMs: obs.timeoutMs } : {}),
          replayed: true
        }
      }

      if (existingAttempt.status === 'PREPARED') {
        const stageResult = await this.promptStageService.stageUnitPrompt(
          this.repositoryId,
          cleanSessionId,
          existingAttempt.attemptId,
          {
            stageOperationId: cleanStageOpId
          }
        )

        if (!stageResult.success || stageResult.status !== 'READY') {
          return {
            repositoryId: this.repositoryId,
            sessionId: cleanSessionId,
            planId: cleanPlanId,
            unitId: existingAttempt.unitId,
            reservationId: cleanReservationId,
            attemptId: existingAttempt.attemptId,
            stageOperationId: cleanStageOpId,
            status: 'UNAVAILABLE',
            reason: stageResult.reason ?? 'STAGE_FAILED'
          }
        }

        const execResult = await this.executionService.startUnitExecution(
          this.repositoryId,
          cleanSessionId,
          existingAttempt.attemptId,
          { stageOperationId: cleanStageOpId }
        )

        return {
          repositoryId: this.repositoryId,
          sessionId: cleanSessionId,
          planId: cleanPlanId,
          unitId: existingAttempt.unitId,
          reservationId: cleanReservationId,
          attemptId: existingAttempt.attemptId,
          stageOperationId: cleanStageOpId,
          status: execResult.status,
          reason: execResult.reason ?? null,
          proposalId: (execResult as any).proposalId ?? null,
          executionId: (execResult as any).executionId ?? null,
          ...(execResult.timeoutProfile ? { timeoutProfile: execResult.timeoutProfile } : {}),
          ...(execResult.timeoutMs !== undefined ? { timeoutMs: execResult.timeoutMs } : {}),
          replayed: true
        }
      }

      throw new ExecutionAttemptConflictError(
        `Attempt "${cleanAttemptId}" already exists in status "${existingAttempt.status}" and cannot be restarted`
      )
    }

    // 2. Strict constraint: Exactly one active executor attempt per session
    const activeSessionAttempt = this.smcService.getActiveExecutionAttempt(this.repositoryId, cleanSessionId)
    if (activeSessionAttempt && activeSessionAttempt.attemptId !== cleanAttemptId) {
      throw new ExecutionAttemptConflictError(
        `Session "${cleanSessionId}" already has an active attempt "${activeSessionAttempt.attemptId}" with status "${activeSessionAttempt.status}"`
      )
    }

    // 3. Atomically reserve eligible unit
    const eligibility = this.unitflowService.getNextEligibleUnit(this.repositoryId, cleanSessionId, cleanPlanId)
    if (eligibility.kind !== 'ELIGIBLE') {
      return {
        repositoryId: this.repositoryId,
        sessionId: cleanSessionId,
        planId: cleanPlanId,
        unitId: '',
        reservationId: cleanReservationId,
        attemptId: cleanAttemptId,
        stageOperationId: cleanStageOpId,
        status: 'NONE_ELIGIBLE',
        reason: eligibility.kind
      }
    }

    const reservationResult = await this.reservationService.reserveNextEligibleUnit(
      this.repositoryId,
      cleanSessionId,
      cleanPlanId,
      { reservationId: cleanReservationId }
    )

    if (reservationResult.kind !== 'RESERVED') {
      return {
        repositoryId: this.repositoryId,
        sessionId: cleanSessionId,
        planId: cleanPlanId,
        unitId: '',
        reservationId: cleanReservationId,
        attemptId: cleanAttemptId,
        stageOperationId: cleanStageOpId,
        status: 'NONE_ELIGIBLE',
        reason: reservationResult.kind
      }
    }

    const reservation = reservationResult.reservation

    // 4. Atomically prepare execution attempt in SMC
    const attempt = await this.attemptService.prepareExecutionAttempt(
      this.repositoryId,
      cleanSessionId,
      reservation.reservationId,
      { attemptId: cleanAttemptId }
    )

    // 5. Stage unit prompt safely outside worktree
    const stageResult = await this.promptStageService.stageUnitPrompt(
      this.repositoryId,
      cleanSessionId,
      attempt.attemptId,
      {
        stageOperationId: cleanStageOpId
      }
    )

    if (!stageResult.success || stageResult.status !== 'READY') {
      return {
        repositoryId: this.repositoryId,
        sessionId: cleanSessionId,
        planId: cleanPlanId,
        unitId: reservation.unitId,
        reservationId: reservation.reservationId,
        attemptId: attempt.attemptId,
        stageOperationId: cleanStageOpId,
        status: 'UNAVAILABLE',
        reason: stageResult.reason ?? 'STAGE_FAILED'
      }
    }

    // 6. Start supervised unit execution via Grok / CLI
    const execResult = await this.executionService.startUnitExecution(
      this.repositoryId,
      cleanSessionId,
      attempt.attemptId,
      { stageOperationId: cleanStageOpId }
    )

    return {
      repositoryId: this.repositoryId,
      sessionId: cleanSessionId,
      planId: cleanPlanId,
      unitId: reservation.unitId,
      reservationId: reservation.reservationId,
      attemptId: attempt.attemptId,
      stageOperationId: cleanStageOpId,
      status: execResult.status,
      reason: execResult.reason ?? null,
      proposalId: (execResult as any).proposalId ?? null,
      executionId: (execResult as any).executionId ?? null,
      ...(execResult.timeoutProfile ? { timeoutProfile: execResult.timeoutProfile } : {}),
      ...(execResult.timeoutMs !== undefined ? { timeoutMs: execResult.timeoutMs } : {})
    }
  }

  async getStatus(
    sessionId: string,
    options?: { planId?: string; attemptId?: string }
  ): Promise<UnitFlowStatusResult> {
    this.verifyContext()
    const cleanSessionId = this.validateUuid(sessionId, 'sessionId')

    const session = this.smcService.getSession(this.repositoryId, cleanSessionId)
    if (!session) {
      throw new SmcSessionNotFoundError(cleanSessionId)
    }

    // Read bound workspace
    const bound = this.smcService.getWorkspaceBinding(this.repositoryId, cleanSessionId)
    let wsInspection: Awaited<ReturnType<typeof this.workspaceService.inspectBoundWorkspace>> | null = null
    if (bound) {
      try {
        wsInspection = await this.workspaceService.inspectBoundWorkspace(this.repositoryId, cleanSessionId)
      } catch {
        wsInspection = null
      }
    }

    // Read plan
    const plan = options?.planId
      ? this.unitflowService.getPlan(this.repositoryId, this.validateUuid(options.planId, 'planId'))
      : this.unitflowService.getActivePlan(this.repositoryId, cleanSessionId)

    let compactUnits: CompactUnitSummary[] = []
    let completedCount = 0
    let currentUnitSummary: CompactUnitSummary | null = null

    if (plan) {
      const units = this.unitflowService.listPlanUnits(this.repositoryId, cleanSessionId, plan.planId)
      compactUnits = units.map(u => {
        const state = this.unitflowService.getUnitState(this.repositoryId, cleanSessionId, plan.planId, u.unitId)
        const unitStatus = state?.status ?? 'UNKNOWN'
        if (unitStatus === 'COMPLETED') completedCount++
        return {
          unitId: u.unitId,
          position: u.position,
          title: u.title,
          state: unitStatus
        }
      })
    }

    // 1. Identify active attempt or requested attempt
    const activeAttemptRecord = this.smcService.getActiveExecutionAttempt(this.repositoryId, cleanSessionId)
    const attemptRecord = options?.attemptId
      ? this.smcService.getExecutionAttempt(this.repositoryId, this.validateUuid(options.attemptId, 'attemptId'))
      : activeAttemptRecord

    let activeAttemptInfo: UnitFlowStatusResult['activeAttempt'] = null
    let observedTerminal = false

    if (attemptRecord) {
      let liveStatus: string = attemptRecord.status
      const exitCode: number | null = null
      let terminalReason: string | null = null
      const lastSummary: string | null = null

      if (attemptRecord.status === 'STARTING' || attemptRecord.status === 'RUNNING') {
        const obs = await this.executionService.observeUnitExecution(
          this.repositoryId,
          cleanSessionId,
          attemptRecord.attemptId,
          { readOnly: true }
        )
        liveStatus = obs.status
        if (obs.status === 'TERMINAL_OBSERVED' || obs.status === 'REFUSED') {
          observedTerminal = true
          liveStatus = (obs as any).cliStatus ?? obs.status
          terminalReason = obs.reason ?? null
        }
      }

      activeAttemptInfo = {
        attemptId: attemptRecord.attemptId,
        reservationId: attemptRecord.reservationId,
        unitId: attemptRecord.unitId,
        status: liveStatus,
        exitCode,
        terminalReason,
        lastSummary
      }
    }

    // 2. Determine current unit
    const validatingUnit = compactUnits.find(u => u.state === 'VALIDATING' || u.state === 'VALIDATION_READY')
    const reconcilingUnit = compactUnits.find(u => u.state === 'RECONCILING')
    const activeReservation = this.unitflowService.getActiveReservation(this.repositoryId, cleanSessionId)

    if (validatingUnit) {
      currentUnitSummary = validatingUnit
      if (!activeAttemptInfo) {
        const latestForUnit = this.smcService.getLatestExecutionAttempt(this.repositoryId, cleanSessionId, validatingUnit.unitId)
        if (latestForUnit) {
          activeAttemptInfo = {
            attemptId: latestForUnit.attemptId,
            reservationId: latestForUnit.reservationId,
            unitId: latestForUnit.unitId,
            status: latestForUnit.status,
            exitCode: null,
            terminalReason: null,
            lastSummary: null
          }
        }
      }
    } else if (reconcilingUnit) {
      currentUnitSummary = reconcilingUnit
      if (!activeAttemptInfo) {
        const latestForUnit = this.smcService.getLatestExecutionAttempt(this.repositoryId, cleanSessionId, reconcilingUnit.unitId)
        if (latestForUnit) {
          activeAttemptInfo = {
            attemptId: latestForUnit.attemptId,
            reservationId: latestForUnit.reservationId,
            unitId: latestForUnit.unitId,
            status: latestForUnit.status,
            exitCode: null,
            terminalReason: null,
            lastSummary: null
          }
        }
      }
    } else if (activeAttemptRecord) {
      currentUnitSummary = compactUnits.find(u => u.unitId === activeAttemptRecord.unitId) ?? null
    } else if (activeReservation) {
      currentUnitSummary = compactUnits.find(u => u.unitId === activeReservation.unitId) ?? null
    } else if (plan) {
      const elig = this.unitflowService.getNextEligibleUnit(this.repositoryId, cleanSessionId, plan.planId)
      if (elig.kind === 'ELIGIBLE') {
        currentUnitSummary = compactUnits.find(u => u.unitId === elig.unitId) ?? null
      } else {
        currentUnitSummary = compactUnits.find(u => u.state !== 'COMPLETED') ?? compactUnits[compactUnits.length - 1] ?? null
      }
    }

    // 3. Compute honest OrchestrationState and nextAllowedActions
    let orchestrationState: OrchestrationState = 'UNKNOWN'
    const nextAllowedActions: string[] = []

    if (!bound || !wsInspection || wsInspection.status !== 'CURRENT') {
      orchestrationState = 'UNKNOWN'
      nextAllowedActions.push('bind_unitflow_workspace')
    } else if (!plan) {
      orchestrationState = 'UNKNOWN'
      nextAllowedActions.push('prepare_unitflow_plan')
    } else if (plan.status === 'COMPLETED' || (compactUnits.length > 0 && completedCount === compactUnits.length)) {
      orchestrationState = 'COMPLETED'
    } else if (validatingUnit) {
      orchestrationState = 'VALIDATION_READY'
      nextAllowedActions.push('accept_unitflow_unit', 'reconcile_unitflow_unit')
    } else if (reconcilingUnit) {
      orchestrationState = 'RECONCILING'
      nextAllowedActions.push('reconcile_unitflow_unit')
    } else if (activeAttemptInfo && (activeAttemptInfo.status === 'STARTING' || activeAttemptInfo.status === 'AWAITING_APPROVAL')) {
      orchestrationState = 'STARTING'
      nextAllowedActions.push('get_unitflow_status')
    } else if (activeAttemptInfo && (activeAttemptInfo.status === 'RUNNING' || observedTerminal || activeAttemptInfo.status === 'REFUSED')) {
      orchestrationState = 'RUNNING'
      if (observedTerminal || activeAttemptInfo.status === 'REFUSED') {
        nextAllowedActions.push('settle_unitflow_unit')
      } else {
        nextAllowedActions.push('get_unitflow_status', 'settle_unitflow_unit')
      }
    } else {
      const elig = this.unitflowService.getNextEligibleUnit(this.repositoryId, cleanSessionId, plan.planId)
      if (elig.kind === 'ELIGIBLE') {
        orchestrationState = 'READY'
        nextAllowedActions.push('start_next_unitflow_unit')
      } else {
        orchestrationState = 'UNKNOWN'
      }
    }

    return {
      repositoryId: this.repositoryId,
      sessionId: cleanSessionId,
      plan: plan
        ? {
            planId: plan.planId,
            title: plan.title,
            status: plan.status,
            totalUnits: compactUnits.length,
            completedUnits: completedCount,
            units: compactUnits
          }
        : null,
      workspace: bound
        ? {
            worktreeId: bound.worktreeId,
            branch: bound.branch,
            generation: bound.generation,
            boundHead: bound.headAtBind,
            status: wsInspection?.status ?? 'UNKNOWN',
            currentHead: wsInspection && wsInspection.status === 'CURRENT' ? wsInspection.currentHead : null
          }
        : null,
      currentUnit: currentUnitSummary,
      activeAttempt: activeAttemptInfo,
      orchestrationState,
      nextAllowedActions
    }
  }

  async settleUnit(
    sessionId: string,
    attemptId: string
  ): Promise<SettleUnitFlowResult> {
    this.verifyContext()
    const cleanSessionId = this.validateUuid(sessionId, 'sessionId')
    const cleanAttemptId = this.validateUuid(attemptId, 'attemptId')

    const settlement = await this.executionService.settleUnitExecution(
      this.repositoryId,
      cleanSessionId,
      cleanAttemptId
    )

    const isSettled = settlement.status === 'VALIDATION_READY' || settlement.status === 'RECONCILING'

    return {
      repositoryId: this.repositoryId,
      sessionId: cleanSessionId,
      attemptId: cleanAttemptId,
      unitId: settlement.unitId ?? '',
      settled: isSettled,
      attemptStatus: settlement.attemptStatus ?? settlement.status,
      unitState: settlement.unitFlowStatus ?? 'UNKNOWN',
      exitCode: settlement.exitCode ?? null,
      terminalReason: settlement.reason ?? null,
      ...(settlement.timeoutProfile ? { timeoutProfile: settlement.timeoutProfile } : {}),
      ...(settlement.timeoutMs !== undefined ? { timeoutMs: settlement.timeoutMs } : {})
    }
  }

  async acceptUnit(
    sessionId: string,
    attemptId: string,
    options: AcceptUnitFlowOptions
  ): Promise<AcceptUnitFlowResult> {
    this.verifyContext()
    const cleanSessionId = this.validateUuid(sessionId, 'sessionId')
    const cleanAttemptId = this.validateUuid(attemptId, 'attemptId')
    const cleanOpId = this.validateUuid(options?.operationId, 'operationId')

    if (!Array.isArray(options?.proofIds) || options.proofIds.length === 0) {
      throw new Error('INVALID_ARGUMENT: proofIds must be a non-empty array of proof identifiers')
    }
    if (!options?.summary || typeof options.summary !== 'string' || !options.summary.trim()) {
      throw new Error('INVALID_ARGUMENT: summary is required and cannot be empty')
    }

    if (options.semanticDecision === 'REJECTED') {
      return {
        repositoryId: this.repositoryId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        status: 'REJECTED',
        reason: options.summary.trim()
      }
    }

    const result = await this.acceptanceService.acceptValidatedUnit(
      this.repositoryId,
      cleanSessionId,
      cleanAttemptId,
      {
        acceptanceOperationId: cleanOpId,
        proofIds: options.proofIds,
        acceptanceSummary: options.summary.trim(),
        emitterId: options.emitterId
      }
    )

    let nextEligibleUnitId: string | null = null
    if (result.nextEligibleUnit && result.nextEligibleUnit.kind === 'ELIGIBLE') {
      nextEligibleUnitId = result.nextEligibleUnit.unitId
    }

    return {
      repositoryId: this.repositoryId,
      sessionId: cleanSessionId,
      attemptId: cleanAttemptId,
      unitId: result.unitId,
      status: result.status,
      reason: result.reason ?? null,
      nextEligibleUnitId
    }
  }

  async reconcileUnit(
    sessionId: string,
    attemptId: string,
    options: ReconcileUnitFlowOptions
  ): Promise<ReconcileUnitFlowResult> {
    this.verifyContext()
    const cleanSessionId = this.validateUuid(sessionId, 'sessionId')
    const cleanAttemptId = this.validateUuid(attemptId, 'attemptId')
    const cleanOpId = this.validateUuid(options?.operationId, 'operationId')

    if (!options?.summary || typeof options.summary !== 'string' || !options.summary.trim()) {
      throw new Error('INVALID_ARGUMENT: summary is required and cannot be empty')
    }

    const result = await this.reconciliationService.reconcileFailedUnit(
      this.repositoryId,
      cleanSessionId,
      cleanAttemptId,
      {
        reconciliationOperationId: cleanOpId,
        decision: options.action ?? 'RETRY_SAME_UNIT',
        summary: options.summary.trim(),
        emitterId: options.emitterId
      }
    )

    return {
      repositoryId: this.repositoryId,
      sessionId: cleanSessionId,
      attemptId: cleanAttemptId,
      unitId: result.unitId,
      status: result.status,
      unitState: result.unitStatus,
      reason: result.reason ?? null,
      reconciliationOperationId: result.reconciliationOperationId ?? cleanOpId
    }
  }
}
