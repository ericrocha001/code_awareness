import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { CliPolicy, CliTrustScope } from '../../shared/types/cli-policy-types'
import { CLI_TRUST_SCOPES } from '../../shared/types/cli-policy-types'
import type { CancelCliExecutionInput, CliApprovalHandler, CliCommandDescriptor, CliExecutionRecord, CliExecutionSnapshot, CliInvestigationSummary, CliProposal, CliTimeoutProfile, GetCliExecutionInput, GetCliInvestigationInput, PrepareCliExecutionInput, PrepareCliInvestigationInput, StartCliExecutionInput } from './cli-execution-types'
import { detectRisks, resolveCliCommand } from './cli-command-resolver'
import { isConsultativeCommand } from './cli-consultative-policy'
import { CliProcessSupervisor } from './cli-process-supervisor'
import { CliOutputBuffer } from './cli-output-buffer'
import type { CliResolvedWorktree, CliWorktreeSelector } from './cli-execution-types'

export interface CliExecutionServiceOptions {
  repoRoot: string
  repositoryId?: string | null
  getFingerprint?: () => Promise<string>
  getRuntimeIdentity?: () => Promise<string>
  getPolicy?: (target?: CliResolvedWorktree) => CliPolicy
  approvalHandler?: CliApprovalHandler
  defaultTimeoutMs?: number
  enabledByDefault?: boolean
  ownerPath?: string
  resolveWorktree?: (selector: CliWorktreeSelector) => Promise<CliResolvedWorktree>
}
const supervised: CliPolicy = { mode: 'SUPERVISED', scope: 'ACTIVE_CHECKOUT_ONLY', revision: 'default', rule: 'native-command-consent' }
const budgets = { commandTimeoutMs: 30000, totalTimeoutMs: 90000, stepOutputBytes: 65536, totalOutputBytes: 262144 }
const STANDARD_MAX_TIMEOUT_MS = 120000
const AGENTIC_DEFAULT_TIMEOUT_MS = 600000
const AGENTIC_MAX_TIMEOUT_MS = 900000
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export class CliExecutionService {
  private readonly repoRoot: string
  private readonly repositoryId: string | null
  private readonly getFingerprintFn: () => Promise<string>
  private readonly hasCustomRuntimeIdentity: boolean
  private readonly getRuntimeIdentityFn: () => Promise<string>
  private readonly getPolicyFn: (target?: CliResolvedWorktree) => CliPolicy
  private observedPolicy: string
  private approvalHandler: CliApprovalHandler
  private readonly defaultTimeoutMs: number
  private readonly supervisor: CliProcessSupervisor
  private enabled: boolean
  private readonly ownerPath?: string
  private readonly resolveWorktree?: CliExecutionServiceOptions['resolveWorktree']
  private readonly proposalWorktrees = new Map<string, CliResolvedWorktree>()
  private readonly proposalRuntimeIdentities = new Map<string, string>()
  private readonly proposals = new Map<string, CliProposal>()
  private readonly executions = new Map<string, CliExecutionRecord>()
  private readonly executionBuffers = new Map<string, CliOutputBuffer>()
  private readonly investigationSteps = new Map<string, CliExecutionRecord[]>()
  private readonly investigationBuffers = new Map<string, Map<number, CliOutputBuffer>>()
  private activeOperationId: string | null = null
  private activeExecutionToken: string | null = null
  private activeRecord: CliExecutionRecord | null = null

  constructor(options: CliExecutionServiceOptions) {
    this.repoRoot = realpathSync(options.repoRoot)
    this.repositoryId = options.repositoryId ?? null
    this.getFingerprintFn = options.getFingerprint ?? (async () => 'DEFAULT_CHECKOUT_FINGERPRINT')
    this.hasCustomRuntimeIdentity = typeof options.getRuntimeIdentity === 'function'
    this.getRuntimeIdentityFn = options.getRuntimeIdentity ?? this.getFingerprintFn
    this.getPolicyFn = options.getPolicy ?? (() => supervised)
    this.observedPolicy = digest(this.getPolicyFn())
    this.approvalHandler = options.approvalHandler ?? (async () => false)
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60000
    this.supervisor = new CliProcessSupervisor(this.defaultTimeoutMs)
    this.enabled = options.enabledByDefault ?? false
    this.ownerPath = options.ownerPath
    this.resolveWorktree = options.resolveWorktree
  }
  setApprovalHandler(handler: CliApprovalHandler): void { this.approvalHandler = handler }
  isEnabled(): boolean { return this.enabled }
  getRepositoryId(): string | null { return this.repositoryId }
  getActiveOperationId(): string | null { return this.activeOperationId }
  async getPolicyForWorktree(selector?: CliWorktreeSelector): Promise<CliPolicy> {
    if (!this.enabled) return { ...supervised, revision: 'disabled' }
    if (selector === undefined) return this.policyForTarget(undefined)
    if (!this.resolveWorktree) throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
    const target = await this.resolveWorktree({ ...selector })
    return this.policyForTarget(target)
  }
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) { this.activeExecutionToken = null; void this.abortActive('CLI_EXECUTION_DISABLED'); this.invalidateAllProposals() }
  }
  refreshPolicy(): void {
    const current = digest(this.getPolicyFn())
    if (current === this.observedPolicy) return
    this.observedPolicy = current
    this.activeExecutionToken = null
    this.invalidateAllProposals()
    void this.abortActive('POLICY_CHANGED')
  }
  async prepare(input: PrepareCliExecutionInput): Promise<CliProposal> { return this.prepareCommands([input], false) }
  async prepareInvestigation(input: PrepareCliInvestigationInput): Promise<CliProposal> {
    if (!Array.isArray(input.commands) || input.commands.length < 2 || input.commands.length > 5) throw new Error('INVESTIGATION_COMMAND_LIMIT')
    return this.prepareCommands(input.commands, true, input.worktree)
  }
  private async prepareCommands(inputs: PrepareCliExecutionInput[], investigation: boolean, topLevelWorktree?: CliWorktreeSelector): Promise<CliProposal> {
    this.assertEnabled()
    if (investigation && inputs.some(input => input.worktree !== undefined)) throw new Error('INVALID_WORKTREE_SELECTOR')
    const selector = investigation ? topLevelWorktree : inputs[0].worktree
    if (selector !== undefined) {
      if (!selector || typeof selector !== 'object' || Array.isArray(selector)) throw new Error('INVALID_WORKTREE_SELECTOR')
      if (!this.resolveWorktree) throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
    }
    const target = selector !== undefined ? await this.resolveWorktree!({ ...selector }) : undefined
    const directory = target?.directory ?? this.repoRoot
    const policy = this.policyForTarget(target)
    const timeoutBudget = this.resolveTimeoutBudget(inputs[0].executionProfile, inputs[0].timeoutMs, investigation)
    const commands = inputs.map(input => resolveCliCommand(directory, input.executable, input.args ?? [], input.relativeCwd))
    if (investigation && Buffer.byteLength(JSON.stringify(commands)) > 6144) throw new Error('MANIFEST_SIZE_LIMIT')
    if (investigation) {
      for (const command of commands) { Object.freeze(command.args); Object.freeze(command.originalArgs); Object.freeze(command) }
      Object.freeze(commands)
    }
    const fingerprint = await this.captureFingerprint(target)
    const runtimeIdentity = (this.hasCustomRuntimeIdentity || target?.getRuntimeIdentity)
      ? await this.captureRuntimeIdentity(target)
      : fingerprint
    this.assertEnabled()
    if (digest(policy) !== digest(this.policyForTarget(target))) throw new Error('POLICY_CHANGED')
    const proposal: CliProposal = {
      proposalId: `prop-${randomUUID()}`, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString(),
      repositoryId: this.repositoryId, repositoryDirectory: directory, checkoutFingerprint: fingerprint,
      ...(target ? { worktree: { ...target.identity } } : {}),
      command: commands[0], risks: [...new Set(commands.flatMap(command => detectRisks(command.executable, command.originalExecutable, command.args)))],
      policy, timeoutProfile: timeoutBudget.timeoutProfile, timeoutMs: timeoutBudget.timeoutMs,
      autoAuthorized: policy.mode === 'AUTONOMOUS_TRUSTED' || policy.mode === 'AUTONOMOUS_CONSULTATIVE' && commands.every(isConsultativeCommand), status: 'PENDING',
      ...(investigation ? { commands, budgets: { ...budgets }, manifestHash: digest({ commands, budgets, fingerprint, policy, repositoryId: this.repositoryId }) } : {})
    }
    this.proposals.set(proposal.proposalId, proposal)
    this.proposalRuntimeIdentities.set(proposal.proposalId, runtimeIdentity)
    if (target) {
      proposal.risks.push('SELECTED_WORKTREE_GENERAL_CLI_NO_GIT_LEASE_GRANTED')
      this.proposalWorktrees.set(proposal.proposalId, target)
    }
    return proposal
  }
  start(input: StartCliExecutionInput): CliExecutionSnapshot { this.reserve(input, false); return this.get(input) }
  startInvestigation(input: StartCliExecutionInput): CliInvestigationSummary { this.reserve(input, true); return this.getInvestigation(input) as CliInvestigationSummary }
  private reserve(input: StartCliExecutionInput, investigation: boolean): void {
    this.assertEnabled()
    if (!input.operationId || typeof input.operationId !== 'string' || !input.proposalId || typeof input.proposalId !== 'string') throw new Error('INVALID_ARGUMENT')
    if (investigation && input.operationId.length > 128) throw new Error('INVALID_ARGUMENT')
    const existing = this.executions.get(input.operationId)
    if (existing) {
      if (existing.proposalId !== input.proposalId) throw new Error('OPERATION_ID_CONFLICT')
      if (this.investigationSteps.has(input.operationId) !== investigation) throw new Error('OPERATION_KIND_CONFLICT')
      return
    }
    if (this.activeOperationId !== null) throw new Error(`CLI_EXECUTION_BUSY: active operation ${this.activeOperationId} in progress`)
    const proposal = this.proposals.get(input.proposalId)
    if (!proposal) throw new Error('PROPOSAL_NOT_FOUND')
    if (!!proposal.commands !== investigation) throw new Error('OPERATION_KIND_CONFLICT')
    if (Date.now() > Date.parse(proposal.expiresAt) || proposal.status === 'EXPIRED') throw new Error('PROPOSAL_EXPIRED')
    if (proposal.status === 'CONSUMED') throw new Error('PROPOSAL_ALREADY_CONSUMED')
    if (proposal.status === 'REFUSED') throw new Error('PROPOSAL_REFUSED')
    if (digest(proposal.policy) !== digest(this.policyForTarget(this.proposalWorktrees.get(proposal.proposalId)))) throw new Error('POLICY_CHANGED')
    if (proposal.policy?.mode === 'AUTONOMOUS_CONSULTATIVE' && !(proposal.commands ?? [proposal.command]).every(isConsultativeCommand)) throw new Error('NOT_AUTO_AUTHORIZED: Select SUPERVISED locally for native command approval')
    const record = this.record(input.operationId, proposal, proposal.command)
    this.executions.set(input.operationId, record)
    if (investigation) { this.investigationSteps.set(input.operationId, []); this.investigationBuffers.set(input.operationId, new Map()) }
    const token = randomUUID()
    this.activeOperationId = input.operationId; this.activeExecutionToken = token
    void this.run(record, proposal, token)
  }
  private record(operationId: string, proposal: CliProposal, command: CliCommandDescriptor): CliExecutionRecord {
    return { operationId, proposalId: proposal.proposalId, command, policy: proposal.policy, repositoryId: this.repositoryId,
      ...(proposal.timeoutProfile ? { timeoutProfile: proposal.timeoutProfile } : {}),
      ...(proposal.timeoutMs !== undefined ? { timeoutMs: proposal.timeoutMs } : {}),
      ...(proposal.worktree ? { worktree: { ...proposal.worktree } } : {}),
      origin: 'CLI_EXECUTION_CAPABILITY', status: 'AWAITING_APPROVAL', phase: 'AWAITING_APPROVAL', startedAt: new Date().toISOString() }
  }
  private current(record: CliExecutionRecord, proposal: CliProposal, token: string): boolean {
    try {
      return this.enabled && this.activeOperationId === record.operationId && this.activeExecutionToken === token &&
        digest(proposal.policy) === digest(this.policyForTarget(this.proposalWorktrees.get(proposal.proposalId))) && Date.now() <= Date.parse(proposal.expiresAt)
    } catch { return false }
  }
  private async authorize(record: CliExecutionRecord, proposal: CliProposal, token: string, command?: CliCommandDescriptor): Promise<boolean> {
    let fingerprint: string
    try { fingerprint = await this.captureFingerprint(this.proposalWorktrees.get(proposal.proposalId)) }
    catch { throw new Error('CHECKOUT_CHANGED') }
    if (!this.current(record, proposal, token)) return false
    if (fingerprint !== proposal.checkoutFingerprint) throw new Error('CHECKOUT_CHANGED')
    return this.authorizeCommandAndMode(proposal, command)
  }
  private async authorizeRuntime(record: CliExecutionRecord, proposal: CliProposal, token: string, command?: CliCommandDescriptor): Promise<boolean> {
    let runtimeIdentity: string
    try { runtimeIdentity = await this.captureRuntimeIdentity(this.proposalWorktrees.get(proposal.proposalId)) }
    catch { throw new Error('CHECKOUT_CHANGED') }
    if (!this.current(record, proposal, token)) return false
    if (runtimeIdentity !== this.proposalRuntimeIdentities.get(proposal.proposalId)) throw new Error('CHECKOUT_CHANGED')
    return this.authorizeCommandAndMode(proposal, command)
  }
  private authorizeCommandAndMode(proposal: CliProposal, command?: CliCommandDescriptor): boolean {
    if (command) {
      const effective = resolveCliCommand(proposal.repositoryDirectory, command.originalExecutable, command.originalArgs ?? command.args, command.relativeCwd)
      if (JSON.stringify(effective) !== JSON.stringify(command)) throw new Error('COMMAND_CHANGED')
      if (proposal.policy?.mode === 'AUTONOMOUS_CONSULTATIVE' && !isConsultativeCommand(effective)) throw new Error('NOT_AUTO_AUTHORIZED')
    }
    return true
  }
  private async run(record: CliExecutionRecord, proposal: CliProposal, token: string): Promise<void> {
    const steps = this.investigationSteps.get(record.operationId)
    let monitor: NodeJS.Timeout | undefined
    const stepAuthorize = (index: number, stepCommand: CliCommandDescriptor) =>
      index > 0 && proposal.policy?.mode === 'AUTONOMOUS_TRUSTED'
        ? this.authorizeRuntime(record, proposal, token, stepCommand)
        : this.authorize(record, proposal, token, stepCommand)
    try {
      if (proposal.worktree && !await this.authorize(record, proposal, token)) return
      let approved = true
      if (proposal.policy?.mode === 'SUPERVISED') {
        try { approved = await this.approvalHandler({ proposalId: proposal.proposalId, operationId: record.operationId,
          command: proposal.command, commands: proposal.commands, manifestHash: proposal.manifestHash, budgets: proposal.budgets,
          repositoryDirectory: proposal.repositoryDirectory, repositoryId: this.repositoryId, risks: proposal.risks,
          worktree: proposal.worktree, activeCheckoutDirectory: this.repoRoot }) } catch { approved = false }
      }
      if (!this.current(record, proposal, token)) {
        if (record.status === 'AWAITING_APPROVAL') { record.status = 'CANCELLED'; record.diagnostic = 'POLICY_CHANGED_OR_PROPOSAL_EXPIRED' }
        return
      }
      if (!await this.authorize(record, proposal, token)) return
      if (!approved) { proposal.status = 'REFUSED'; record.status = 'REFUSED'; record.diagnostic = 'NATIVE_APPROVAL_REFUSED'; return }
      if (!this.current(record, proposal, token)) return
      proposal.status = 'CONSUMED'
      const deadline = steps ? Date.now() + budgets.totalTimeoutMs : Infinity
      let outputBytes = 0
      const commands = proposal.commands ?? [proposal.command]
      for (let index = 0; index < commands.length; index++) {
        if (!this.current(record, proposal, token)) break
        if (Date.now() >= deadline) { record.status = 'TIMED_OUT'; record.diagnostic = 'INVESTIGATION_TIME_BUDGET'; break }
        const command = commands[index]
        if (steps && !await stepAuthorize(index, command)) break
        if (!this.current(record, proposal, token)) break
        const step = steps ? this.record(`${record.operationId}:${index}`, proposal, command) : record
        steps?.push(step); this.activeRecord = step
        step.phase = record.phase = 'LAUNCHING'
        let monitoring = false
        if (proposal.policy?.mode !== 'SUPERVISED') monitor = setInterval(() => {
          if (monitoring || !this.current(record, proposal, token)) {
            if (!this.current(record, proposal, token) && this.activeOperationId === record.operationId) void this.abortActive('POLICY_CHANGED')
            return
          }
          monitoring = true
          void this.authorizeRuntime(record, proposal, token).then(allowed => {
            if (!allowed && this.activeOperationId === record.operationId && this.activeExecutionToken === token) return this.abortActive('POLICY_CHANGED')
          }).catch(() => {
            if (this.activeOperationId === record.operationId && this.activeExecutionToken === token) return this.abortActive('CHECKOUT_CHANGED')
          }).finally(() => { monitoring = false })
        }, 500)
        const unitTimeoutMaxMs = proposal.timeoutProfile === 'BUILDX_AGENTIC_UNIT' ? AGENTIC_MAX_TIMEOUT_MS : STANDARD_MAX_TIMEOUT_MS
        const completion = this.supervisor.launch(command, {
          ownerPath: this.ownerPath,
          ...(steps
            ? { timeoutMs: Math.min(budgets.commandTimeoutMs, deadline - Date.now()), maxTimeoutMs: STANDARD_MAX_TIMEOUT_MS, maxTotalOutputBytes: Math.min(budgets.stepOutputBytes, budgets.totalOutputBytes - outputBytes) }
            : { timeoutMs: Math.min(proposal.timeoutMs ?? this.defaultTimeoutMs, unitTimeoutMaxMs), maxTimeoutMs: unitTimeoutMaxMs }),
          authorizeResume: () => stepAuthorize(index, command),
          onRunning: () => { step.status = record.status = 'RUNNING'; step.phase = record.phase = 'RUNNING' }
        })
        const buffer = this.supervisor.output
        if (buffer) {
          if (steps) this.investigationBuffers.get(record.operationId)!.set(index, buffer)
          else this.executionBuffers.set(record.operationId, buffer)
        }
        const result = await completion
        clearInterval(monitor); monitor = undefined
        Object.assign(step, result, { phase: this.supervisor.isRunning ? 'TERMINATION_UNCONFIRMED' : 'TERMINAL' })
        if (!this.supervisor.isRunning) step.finishedAt = new Date().toISOString()
        if (step !== record) Object.assign(record, { status: step.status === 'SUCCEEDED' ? 'RUNNING' : step.status,
          phase: step.status === 'SUCCEEDED' ? 'RUNNING' : step.phase, diagnostic: step.diagnostic, exitCode: step.exitCode, treeObservation: step.treeObservation })
        const output = buffer?.readPage()
        outputBytes += (output?.totalStdoutBytes ?? 0) + (output?.totalStderrBytes ?? 0)
        if (result.status !== 'SUCCEEDED' || result.treeObservation?.activeProcesses !== 0 || result.treeObservation.handlesClosed !== true || this.supervisor.isRunning) break
      }
    } catch (error) {
      record.status = this.supervisor.isRunning ? 'FAILED' : 'REFUSED'
      record.diagnostic = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'CHECKOUT_CHANGED'
      proposal.status = 'REFUSED'
    } finally {
      clearInterval(monitor)
      if (!this.supervisor.isRunning) {
        if (steps && steps.length === proposal.commands!.length && steps.every(step => step.status === 'SUCCEEDED') && record.status === 'RUNNING') record.status = 'SUCCEEDED'
        if (record.status === 'AWAITING_APPROVAL' || record.status === 'RUNNING') { record.status = 'CANCELLED'; record.diagnostic ??= 'AUTHORITY_CHANGED' }
        record.phase = 'TERMINAL'; record.finishedAt = new Date().toISOString()
        record.durationMs = Date.parse(record.finishedAt) - Date.parse(record.startedAt!)
        if (this.activeOperationId === record.operationId) { this.activeOperationId = null; this.activeExecutionToken = null; this.activeRecord = null }
      } else record.phase = 'TERMINATION_UNCONFIRMED'
    }
  }
  get(input: GetCliExecutionInput): CliExecutionSnapshot {
    if (this.investigationSteps.has(input.operationId)) throw new Error('OPERATION_KIND_CONFLICT')
    return this.getSnapshot(input.operationId, input.cursor)
  }
  getInvestigation(input: GetCliInvestigationInput): CliInvestigationSummary | (CliInvestigationSummary & { output: ReturnType<CliOutputBuffer['readBoundedPage']>; index: number }) {
    const record = this.executions.get(input.operationId), steps = this.investigationSteps.get(input.operationId)
    if (!record || !steps) throw new Error('OPERATION_NOT_FOUND: UNKNOWN_NOT_RECOVERABLE_AFTER_RESTART')
    const proposal = this.proposals.get(record.proposalId)!
    const summary: CliInvestigationSummary = {
      ...(proposal.worktree ? { worktree: { ...proposal.worktree } } : {}),
      operationId: record.operationId, proposalId: record.proposalId, manifestHash: proposal.manifestHash!, repositoryId: this.repositoryId,
      policy: proposal.policy!, status: record.status, phase: record.phase, diagnostic: record.diagnostic, durationMs: record.durationMs, treeObservation: record.treeObservation,
      steps: proposal.commands!.map((_, index) => { const step = steps[index]; return { index, operationId: `${record.operationId}:${index}`,
        status: step?.status ?? 'NOT_STARTED', phase: step?.phase, exitCode: step?.exitCode, durationMs: step?.durationMs, diagnostic: step?.diagnostic, treeObservation: step?.treeObservation } }) }
    if (Buffer.byteLength(JSON.stringify(summary)) > 8192) throw new Error('SUMMARY_SIZE_LIMIT')
    if (input.index === undefined) { if (input.cursor !== undefined) throw new Error('OUTPUT_INDEX_REQUIRED'); return summary }
    if (!Number.isInteger(input.index) || input.index < 0 || input.index >= proposal.commands!.length) throw new Error('INVALID_OUTPUT_INDEX')
    const buffer = this.investigationBuffers.get(record.operationId)?.get(input.index) ?? new CliOutputBuffer()
    return { ...summary, index: input.index, output: buffer.readBoundedPage(input.cursor) }
  }
  async cancel(input: CancelCliExecutionInput): Promise<CliExecutionSnapshot> {
    const record = this.executions.get(input.operationId)
    if (!record) throw new Error('OPERATION_NOT_FOUND: UNKNOWN_NOT_RECOVERABLE_AFTER_RESTART')
    if (this.activeOperationId === input.operationId) {
      this.activeExecutionToken = null
      if (this.supervisor.isRunning) {
        record.phase = 'STOPPING'
        const result = await this.supervisor.cancel()
        Object.assign(record, result)
        if (this.activeRecord) Object.assign(this.activeRecord, result, { phase: this.supervisor.isRunning ? 'TERMINATION_UNCONFIRMED' : 'TERMINAL' })
      } else { record.status = 'CANCELLED'; record.diagnostic = 'CANCELLED_BEFORE_APPROVAL'; this.proposals.get(record.proposalId)!.status = 'REFUSED' }
      record.phase = this.supervisor.isRunning ? 'TERMINATION_UNCONFIRMED' : 'TERMINAL'
      if (!this.supervisor.isRunning) { record.finishedAt = new Date().toISOString(); this.activeOperationId = null; this.activeRecord = null }
    }
    return this.getSnapshot(input.operationId)
  }
  async cancelInvestigation(input: CancelCliExecutionInput): Promise<CliInvestigationSummary> {
    if (!this.investigationSteps.has(input.operationId)) throw new Error('OPERATION_NOT_FOUND')
    await this.cancel(input)
    return this.getInvestigation(input) as CliInvestigationSummary
  }
  async shutdown(): Promise<void> {
    this.enabled = false; this.activeExecutionToken = null
    await this.abortActive('SERVICE_SHUTDOWN'); this.invalidateAllProposals()
    if (this.supervisor.isRunning) throw new Error('TERMINATION_UNCONFIRMED')
  }
  private async abortActive(reason: string): Promise<void> {
    const operationId = this.activeOperationId
    if (!operationId) return
    await this.cancel({ operationId })
    const record = this.executions.get(operationId)
    if (record?.phase === 'TERMINAL') record.diagnostic = reason
  }
  private assertEnabled(): void { if (!this.enabled) throw new Error('CLI_EXECUTION_DISABLED') }
  private resolveTimeoutBudget(
    executionProfile: PrepareCliExecutionInput['executionProfile'] | undefined,
    requestedTimeoutMs: number | undefined,
    investigation: boolean
  ): { timeoutProfile: CliTimeoutProfile; timeoutMs: number; maxTimeoutMs: number } {
    if (investigation) {
      return { timeoutProfile: 'INVESTIGATION_STEP', timeoutMs: budgets.commandTimeoutMs, maxTimeoutMs: STANDARD_MAX_TIMEOUT_MS }
    }
    if (executionProfile !== undefined && executionProfile !== 'STANDARD_CLI' && executionProfile !== 'BUILDX_AGENTIC_UNIT') {
      throw new Error('INVALID_EXECUTION_PROFILE')
    }
    const requested = typeof requestedTimeoutMs === 'number' && Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? Math.floor(requestedTimeoutMs)
      : undefined
    if (executionProfile === 'BUILDX_AGENTIC_UNIT') {
      return {
        timeoutProfile: 'BUILDX_AGENTIC_UNIT',
        timeoutMs: Math.min(requested ?? AGENTIC_DEFAULT_TIMEOUT_MS, AGENTIC_MAX_TIMEOUT_MS),
        maxTimeoutMs: AGENTIC_MAX_TIMEOUT_MS
      }
    }
    return {
      timeoutProfile: 'STANDARD_CLI',
      timeoutMs: Math.min(requested ?? this.defaultTimeoutMs, STANDARD_MAX_TIMEOUT_MS),
      maxTimeoutMs: STANDARD_MAX_TIMEOUT_MS
    }
  }
  private policyForTarget(target?: CliResolvedWorktree): CliPolicy {
    const raw = this.getPolicyFn(target)
    if (raw.scope !== undefined && !CLI_TRUST_SCOPES.includes(raw.scope)) {
      return { mode: 'SUPERVISED', scope: 'ACTIVE_CHECKOUT_ONLY', revision: `invalid:${raw.revision}`, rule: supervised.rule }
    }
    const scope: CliTrustScope = raw.scope ?? 'ACTIVE_CHECKOUT_ONLY'
    if (scope === 'REPOSITORY_WORKTREES' && raw.mode !== 'AUTONOMOUS_TRUSTED') {
      return { mode: 'SUPERVISED', scope: 'ACTIVE_CHECKOUT_ONLY', revision: `invalid:${raw.revision}`, rule: supervised.rule }
    }
    const policy: CliPolicy = { ...raw, scope }
    if (target && target.directory !== this.repoRoot) {
      if (policy.mode === 'AUTONOMOUS_TRUSTED' && policy.scope === 'REPOSITORY_WORKTREES') return policy
      return { ...policy, mode: 'SUPERVISED', scope: 'ACTIVE_CHECKOUT_ONLY', rule: 'native-worktree-command-consent' }
    }
    return policy
  }
  private async captureFingerprint(target?: CliResolvedWorktree): Promise<string> {
    const active = await this.getFingerprintFn()
    if (!target) return active
    const selected = await target.getFingerprint()
    if (active !== await this.getFingerprintFn()) throw new Error('PROJECT_CONTEXT_CHANGED')
    return digest([active, target.directory, selected])
  }
  private async captureRuntimeIdentity(target?: CliResolvedWorktree): Promise<string> {
    const active = await this.getRuntimeIdentityFn()
    if (!target) return active
    const selected = await (target.getRuntimeIdentity ? target.getRuntimeIdentity() : target.getFingerprint())
    if (active !== await this.getRuntimeIdentityFn()) throw new Error('PROJECT_CONTEXT_CHANGED')
    return digest([active, target.directory, selected])
  }
  private invalidateAllProposals(): void { for (const proposal of this.proposals.values()) if (proposal.status === 'PENDING') proposal.status = 'EXPIRED' }
  private getSnapshot(operationId: string, cursor?: string): CliExecutionSnapshot {
    const record = this.executions.get(operationId)
    if (!record) throw new Error('OPERATION_NOT_FOUND')
    return { ...record, ...(this.executionBuffers.get(operationId) ?? new CliOutputBuffer()).readPage(cursor) }
  }
}
