import type {
  CancelExecutorAttemptInput,
  ExecutorAvailabilityResult,
  ExecutorEvent,
  ExecutorEventKind,
  ExecutorLifecyclePhase,
  ExecutorPreparationResult,
  ExecutorRunObservation,
  ExecutorRunStatus,
  ExecutorSelection,
  ExecutorTerminationConfirmation,
  ObserveExecutorAttemptInput,
  PrepareExecutorAttemptInput,
  StartExecutorAttemptInput
} from '../../../../shared/types/buildx/execution-types'
import type { CliPolicy } from '../../../../shared/types/cli-policy-types'
import type { CliExecutionSnapshot } from '../../../cli-execution/cli-execution-types'
import {
  normalizeExecutorSelection,
  type UnitExecutorPort
} from '../../execution/executor-port'
import type { CliExecutionPort, CliExecutionResolver } from '../../execution/grok-cli-bridge'

export const DEFAULT_GROK_EXECUTOR_ID = 'grok-cli'
export const DEFAULT_GROK_PROVIDER_ID = 'xai'

export interface GrokExecutorAdapterOptions {
  readonly executorId?: string
  readonly providerId?: string | null
  readonly modelId?: string | null
}

export function classifyObservedGrokOutcome(snapshot: CliExecutionSnapshot): string {
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

function mapSnapshotStatus(status: CliExecutionSnapshot['status']): ExecutorRunStatus {
  switch (status) {
    case 'AWAITING_APPROVAL':
    case 'RUNNING':
    case 'SUCCEEDED':
    case 'FAILED':
    case 'CANCELLED':
    case 'TIMED_OUT':
    case 'REFUSED':
    case 'INTERRUPTED':
      return status
    default:
      return 'UNKNOWN'
  }
}

function mapSnapshotPhase(
  phase: CliExecutionSnapshot['phase'],
  status: ExecutorRunStatus
): ExecutorLifecyclePhase {
  switch (phase) {
    case 'AWAITING_APPROVAL':
    case 'LAUNCHING':
    case 'RUNNING':
    case 'STOPPING':
    case 'TERMINAL':
    case 'TERMINATION_UNCONFIRMED':
      return phase
    default:
      if (status === 'AWAITING_APPROVAL') return 'AWAITING_APPROVAL'
      if (status === 'RUNNING') return 'RUNNING'
      return 'TERMINAL'
  }
}

function mapStatusToEventKind(status: ExecutorRunStatus): ExecutorEventKind {
  switch (status) {
    case 'AWAITING_APPROVAL':
      return 'AWAITING_APPROVAL'
    case 'RUNNING':
      return 'PROGRESS'
    case 'SUCCEEDED':
      return 'COMPLETED'
    case 'CANCELLED':
      return 'CANCELLED'
    case 'TIMED_OUT':
      return 'TIMED_OUT'
    case 'REFUSED':
      return 'REFUSED'
    case 'INTERRUPTED':
      return 'INTERRUPTED'
    default:
      return 'FAILED'
  }
}

function isTerminalStatus(status: ExecutorRunStatus): boolean {
  return (
    status === 'SUCCEEDED' ||
    status === 'FAILED' ||
    status === 'CANCELLED' ||
    status === 'TIMED_OUT' ||
    status === 'INTERRUPTED'
  )
}

export class GrokExecutorAdapter implements UnitExecutorPort {
  readonly identity: ExecutorSelection
  private readonly cliResolver: CliExecutionResolver
  private readonly listeners = new Map<string, Set<(event: ExecutorEvent) => void>>()

  constructor(
    cliServiceOrResolver: CliExecutionPort | CliExecutionResolver | null,
    options?: GrokExecutorAdapterOptions
  ) {
    this.identity = Object.freeze(
      normalizeExecutorSelection({
        executorId: options?.executorId ?? DEFAULT_GROK_EXECUTOR_ID,
        providerId: options?.providerId !== undefined ? options.providerId : DEFAULT_GROK_PROVIDER_ID,
        modelId: options?.modelId ?? null
      })
    )

    if (typeof cliServiceOrResolver === 'function') {
      this.cliResolver = cliServiceOrResolver
    } else if (cliServiceOrResolver) {
      this.cliResolver = () => cliServiceOrResolver
    } else {
      this.cliResolver = () => null
    }
  }

  private async resolveCliService(
    repositoryId: string
  ): Promise<{ cliService: CliExecutionPort; availability: ExecutorAvailabilityResult } | { cliService: null; availability: ExecutorAvailabilityResult }> {
    const cliService = await this.cliResolver(repositoryId)
    if (!cliService || !cliService.isEnabled()) {
      return {
        cliService: null,
        availability: { available: false, reason: 'CLI_UNAVAILABLE' }
      }
    }

    const cliRepoId = cliService.getRepositoryId()
    if (cliRepoId !== null && cliRepoId !== repositoryId) {
      return {
        cliService: null,
        availability: { available: false, reason: 'CLI_REPOSITORY_MISMATCH' }
      }
    }

    return {
      cliService,
      availability: { available: true }
    }
  }

  async checkAvailability(repositoryId: string): Promise<ExecutorAvailabilityResult> {
    const resolved = await this.resolveCliService(repositoryId)
    return resolved.availability
  }

  async prepareAttempt(input: PrepareExecutorAttemptInput): Promise<ExecutorPreparationResult> {
    const { cliService, availability } = await this.resolveCliService(input.repositoryId)
    if (!cliService) {
      return {
        status: 'UNAVAILABLE',
        reason: availability.reason ?? 'CLI_UNAVAILABLE'
      }
    }

    let hostPolicy: CliPolicy | undefined
    if (typeof cliService.getPolicyForWorktree === 'function') {
      try {
        hostPolicy = await cliService.getPolicyForWorktree({
          worktreeId: input.worktree.worktreeId,
          generation: input.worktree.generation
        })
      } catch (err: any) {
        return {
          status: 'UNAVAILABLE',
          reason: `CLI_POLICY_ERROR: ${err?.message ?? String(err)}`
        }
      }
    }

    const hostYoloAuthorized =
      hostPolicy?.mode === 'AUTONOMOUS_TRUSTED' &&
      hostPolicy?.scope === 'REPOSITORY_WORKTREES'
    const allowAlwaysApprove = hostPolicy !== undefined ? hostYoloAuthorized : input.allowAlwaysApprove === true

    const headlessArgs = [
      '--prompt-file', input.prompt.promptFilePath,
      '--output-format', 'json',
      '--no-auto-update',
      ...(allowAlwaysApprove ? ['--always-approve'] : [])
    ]

    let proposal: Awaited<ReturnType<CliExecutionPort['prepare']>>
    try {
      proposal = await cliService.prepare({
        worktree: {
          worktreeId: input.worktree.worktreeId,
          generation: input.worktree.generation
        },
        executable: 'grok',
        args: headlessArgs,
        executionProfile: 'BUILDX_AGENTIC_UNIT'
      })
    } catch (err: any) {
      return {
        status: 'UNAVAILABLE',
        reason: `CLI_PREPARE_ERROR: ${err?.message ?? String(err)}`
      }
    }

    if (
      proposal.command.originalExecutable !== 'grok' ||
      !Array.isArray(proposal.command.originalArgs) ||
      proposal.command.originalArgs[0] !== '--prompt-file' ||
      proposal.command.originalArgs[1] !== input.prompt.promptFilePath
    ) {
      return {
        status: 'UNAVAILABLE',
        reason: 'PROPOSAL_VALIDATION_FAILED'
      }
    }

    if (proposal.autoAuthorized === true && !allowAlwaysApprove) {
      return {
        status: 'REFUSED',
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
      return {
        status: 'REFUSED',
        reason: 'POLICY_CHANGED'
      }
    }

    return {
      status: 'READY',
      handle: {
        preparedAttemptId: proposal.proposalId,
        selection: this.identity,
        ...(proposal.timeoutProfile ? { timeoutProfile: proposal.timeoutProfile } : {}),
        ...(proposal.timeoutMs !== undefined ? { timeoutMs: proposal.timeoutMs } : {})
      }
    }
  }

  async startAttempt(input: StartExecutorAttemptInput): Promise<ExecutorRunObservation> {
    const { cliService, availability } = await this.resolveCliService(input.repositoryId)
    if (!cliService) {
      return {
        attemptId: input.attemptId,
        status: 'UNAVAILABLE',
        phase: 'TERMINAL',
        selection: this.identity,
        reason: availability.reason ?? 'CLI_UNAVAILABLE',
        termination: { confirmed: true, reason: availability.reason ?? 'CLI_UNAVAILABLE' }
      }
    }

    if (!cliService.start) {
      return {
        attemptId: input.attemptId,
        status: 'UNAVAILABLE',
        phase: 'TERMINAL',
        selection: this.identity,
        reason: 'CLI_START_NOT_SUPPORTED',
        termination: { confirmed: true, reason: 'CLI_START_NOT_SUPPORTED' }
      }
    }

    let snapshot: CliExecutionSnapshot
    try {
      snapshot = await cliService.start({
        proposalId: input.handle.preparedAttemptId,
        operationId: input.attemptId
      })
    } catch (err: any) {
      throw new Error(`CLI_START_ERROR: ${err?.message ?? String(err)}`)
    }

    const observation = this.mapSnapshotToObservation(input.attemptId, snapshot)
    this.emitObservationEvent(observation)
    return observation
  }

  async observeAttempt(input: ObserveExecutorAttemptInput): Promise<ExecutorRunObservation> {
    const { cliService, availability } = await this.resolveCliService(input.repositoryId)
    if (!cliService) {
      return {
        attemptId: input.attemptId,
        status: 'UNAVAILABLE',
        phase: 'TERMINAL',
        selection: this.identity,
        reason: availability.reason ?? 'CLI_UNAVAILABLE'
      }
    }

    if (!cliService.get) {
      return {
        attemptId: input.attemptId,
        status: 'UNKNOWN',
        phase: 'TERMINAL',
        selection: this.identity,
        reason: 'CLI_GET_NOT_SUPPORTED'
      }
    }

    let snapshot: CliExecutionSnapshot
    try {
      snapshot = await cliService.get({ operationId: input.attemptId })
    } catch (err: any) {
      throw new Error(`CLI_GET_ERROR: ${err?.message ?? String(err)}`)
    }

    const observation = this.mapSnapshotToObservation(input.attemptId, snapshot)
    this.emitObservationEvent(observation)
    return observation
  }

  async cancelAttempt(input: CancelExecutorAttemptInput): Promise<ExecutorRunObservation> {
    const { cliService, availability } = await this.resolveCliService(input.repositoryId)
    if (!cliService) {
      return {
        attemptId: input.attemptId,
        status: 'UNAVAILABLE',
        phase: 'TERMINATION_UNCONFIRMED',
        selection: this.identity,
        reason: availability.reason ?? 'CLI_UNAVAILABLE',
        termination: {
          confirmed: false,
          reason: availability.reason ?? 'CLI_UNAVAILABLE'
        }
      }
    }

    if (!cliService.cancel) {
      return {
        attemptId: input.attemptId,
        status: 'UNKNOWN',
        phase: 'TERMINATION_UNCONFIRMED',
        selection: this.identity,
        reason: 'CLI_CANCEL_NOT_SUPPORTED',
        termination: {
          confirmed: false,
          reason: 'CLI_CANCEL_NOT_SUPPORTED'
        }
      }
    }

    let snapshot: CliExecutionSnapshot
    try {
      snapshot = await cliService.cancel({ operationId: input.attemptId })
    } catch (err: any) {
      throw new Error(`CLI_CANCEL_ERROR: ${err?.message ?? String(err)}`)
    }

    const observation = this.mapSnapshotToObservation(input.attemptId, snapshot)
    this.emitObservationEvent(observation)
    return observation
  }

  async confirmTermination(input: ObserveExecutorAttemptInput): Promise<ExecutorTerminationConfirmation> {
    const observation = await this.observeAttempt(input)
    if (observation.termination) {
      return observation.termination
    }
    return {
      confirmed: false,
      reason: observation.reason ?? 'TERMINATION_UNCONFIRMED'
    }
  }

  subscribe(attemptId: string, listener: (event: ExecutorEvent) => void): () => void {
    const cleanId = attemptId.trim().toLowerCase()
    let set = this.listeners.get(cleanId)
    if (!set) {
      set = new Set()
      this.listeners.set(cleanId, set)
    }
    set.add(listener)
    return () => {
      const current = this.listeners.get(cleanId)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) {
        this.listeners.delete(cleanId)
      }
    }
  }

  private emitObservationEvent(observation: ExecutorRunObservation): void {
    const set = this.listeners.get(observation.attemptId.trim().toLowerCase())
    if (!set || set.size === 0 || !observation.events?.length) return
    const event = observation.events[0]
    for (const listener of Array.from(set)) {
      try {
        listener(event)
      } catch {
        // Subscriber failure must never disrupt attempt lifecycle observation
      }
    }
  }

  private mapSnapshotToObservation(
    attemptId: string,
    snapshot: CliExecutionSnapshot
  ): ExecutorRunObservation {
    const status = mapSnapshotStatus(snapshot.status)
    const phase = mapSnapshotPhase(snapshot.phase, status)

    let reason: string | undefined
    if (status === 'REFUSED') {
      reason = snapshot.diagnostic ?? 'NATIVE_APPROVAL_REFUSED'
    } else if (status === 'FAILED' || status === 'TIMED_OUT' || status === 'CANCELLED' || status === 'INTERRUPTED') {
      reason = classifyObservedGrokOutcome(snapshot)
    } else if (typeof snapshot.diagnostic === 'string' && snapshot.diagnostic.trim()) {
      reason = snapshot.diagnostic.trim()
    }

    let termination: ExecutorTerminationConfirmation | undefined
    if (status === 'REFUSED') {
      termination = { confirmed: true }
    } else if (phase === 'TERMINATION_UNCONFIRMED') {
      termination = {
        confirmed: false,
        ...(snapshot.treeObservation?.activeProcesses !== undefined ? { activeProcesses: snapshot.treeObservation.activeProcesses } : {}),
        ...(snapshot.treeObservation?.handlesClosed !== undefined ? { handlesClosed: snapshot.treeObservation.handlesClosed } : {}),
        reason: 'TERMINATION_UNCONFIRMED'
      }
    } else if (isTerminalStatus(status)) {
      const cleanTree = Boolean(
        snapshot.treeObservation &&
        snapshot.treeObservation.activeProcesses === 0 &&
        snapshot.treeObservation.handlesClosed === true
      )
      const isTerminalPhase = phase === 'TERMINAL'
      const exitOk = status !== 'SUCCEEDED' || snapshot.exitCode === 0
      const confirmed = cleanTree && isTerminalPhase && exitOk
      termination = {
        confirmed,
        ...(snapshot.treeObservation?.activeProcesses !== undefined ? { activeProcesses: snapshot.treeObservation.activeProcesses } : {}),
        ...(snapshot.treeObservation?.handlesClosed !== undefined ? { handlesClosed: snapshot.treeObservation.handlesClosed } : {}),
        ...(!confirmed ? { reason: 'TERMINATION_UNCONFIRMED' } : {})
      }
    }

    const event: ExecutorEvent = {
      kind: mapStatusToEventKind(status),
      attemptId,
      timestamp: snapshot.finishedAt ?? snapshot.startedAt ?? new Date().toISOString(),
      phase,
      status,
      ...(reason ? { reason } : {}),
      provenance: {
        executorId: this.identity.executorId,
        providerId: this.identity.providerId ?? null,
        modelId: this.identity.modelId ?? null
      }
    }

    const terminal = isTerminalStatus(status)
    return {
      attemptId,
      status,
      phase,
      selection: this.identity,
      ...(reason ? { reason } : {}),
      ...(snapshot.exitCode !== undefined ? { exitCode: snapshot.exitCode } : {}),
      ...(snapshot.durationMs !== undefined ? { durationMs: snapshot.durationMs } : {}),
      ...(snapshot.timeoutProfile ? { timeoutProfile: snapshot.timeoutProfile } : {}),
      ...(snapshot.timeoutMs !== undefined ? { timeoutMs: snapshot.timeoutMs } : {}),
      ...(termination ? { termination } : {}),
      events: [event],
      ...(terminal
        ? {
            result: {
              usage: { provenance: 'UNAVAILABLE' },
              billing: { classification: 'UNKNOWN', provenance: 'UNAVAILABLE' },
              provenance: {
                executorId: this.identity.executorId,
                providerId: this.identity.providerId ?? null,
                modelId: this.identity.modelId ?? null,
                origin: snapshot.origin ?? 'CLI_EXECUTION_CAPABILITY'
              }
            }
          }
        : {}),
      legacyExecution: {
        status: snapshot.status,
        ...(snapshot.phase !== undefined ? { phase: snapshot.phase } : {}),
        ...(snapshot.treeObservation !== undefined ? { treeObservation: snapshot.treeObservation } : {}),
        ...(snapshot.diagnostic !== undefined ? { diagnostic: snapshot.diagnostic } : {})
      }
    }
  }
}
