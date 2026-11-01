import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { CliPolicy } from '../../shared/types/cli-policy-types'
import type { CancelCliExecutionInput, CliApprovalHandler, CliCommandDescriptor, CliExecutionRecord, CliExecutionSnapshot, CliInvestigationSummary, CliProposal, GetCliExecutionInput, GetCliInvestigationInput, PrepareCliExecutionInput, PrepareCliInvestigationInput, StartCliExecutionInput } from './cli-execution-types'
import { detectRisks, resolveCliCommand } from './cli-command-resolver'
import { isConsultativeCommand } from './cli-consultative-policy'
import { CliProcessSupervisor } from './cli-process-supervisor'
import { CliOutputBuffer } from './cli-output-buffer'

export interface CliExecutionServiceOptions {
  repoRoot: string
  repositoryId?: string | null
  getFingerprint?: () => Promise<string>
  getPolicy?: () => CliPolicy
  approvalHandler?: CliApprovalHandler
  defaultTimeoutMs?: number
  enabledByDefault?: boolean
  ownerPath?: string
}
const supervised: CliPolicy = { mode: 'SUPERVISED', revision: 'default', rule: 'native-command-consent' }
const budgets = { commandTimeoutMs: 30000, totalTimeoutMs: 90000, stepOutputBytes: 65536, totalOutputBytes: 262144 }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export class CliExecutionService {
  private readonly repoRoot: string
  private readonly repositoryId: string | null
  private readonly getFingerprintFn: () => Promise<string>
  private readonly getPolicyFn: () => CliPolicy
  private observedPolicy: string
  private approvalHandler: CliApprovalHandler
  private readonly supervisor: CliProcessSupervisor
  private enabled: boolean
  private readonly ownerPath?: string
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
    this.getPolicyFn = options.getPolicy ?? (() => supervised)
    this.observedPolicy = digest(this.getPolicyFn())
    this.approvalHandler = options.approvalHandler ?? (async () => false)
    this.supervisor = new CliProcessSupervisor(options.defaultTimeoutMs)
    this.enabled = options.enabledByDefault ?? false
    this.ownerPath = options.ownerPath
  }
  setApprovalHandler(handler: CliApprovalHandler): void { this.approvalHandler = handler }
  isEnabled(): boolean { return this.enabled }
  getActiveOperationId(): string | null { return this.activeOperationId }
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
    return this.prepareCommands(input.commands, true)
  }
  private async prepareCommands(inputs: PrepareCliExecutionInput[], investigation: boolean): Promise<CliProposal> {
    this.assertEnabled()
    const policy = { ...this.getPolicyFn() }
    const commands = inputs.map(input => resolveCliCommand(this.repoRoot, input.executable, input.args ?? [], input.relativeCwd))
    if (investigation && Buffer.byteLength(JSON.stringify(commands)) > 6144) throw new Error('MANIFEST_SIZE_LIMIT')
    if (investigation) {
      for (const command of commands) { Object.freeze(command.args); Object.freeze(command.originalArgs); Object.freeze(command) }
      Object.freeze(commands)
    }
    const fingerprint = await this.getFingerprintFn()
    this.assertEnabled()
    if (digest(policy) !== digest(this.getPolicyFn())) throw new Error('POLICY_CHANGED')
    const proposal: CliProposal = {
      proposalId: `prop-${randomUUID()}`, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString(),
      repositoryId: this.repositoryId, repositoryDirectory: this.repoRoot, checkoutFingerprint: fingerprint,
      command: commands[0], risks: [...new Set(commands.flatMap(command => detectRisks(command.executable, command.originalExecutable, command.args)))],
      policy, autoAuthorized: policy.mode === 'AUTONOMOUS_TRUSTED' || policy.mode === 'AUTONOMOUS_CONSULTATIVE' && commands.every(isConsultativeCommand), status: 'PENDING',
      ...(investigation ? { commands, budgets: { ...budgets }, manifestHash: digest({ commands, budgets, fingerprint, policy, repositoryId: this.repositoryId }) } : {})
    }
    this.proposals.set(proposal.proposalId, proposal)
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
    if (digest(proposal.policy) !== digest(this.getPolicyFn())) throw new Error('POLICY_CHANGED')
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
      origin: 'CLI_EXECUTION_CAPABILITY', status: 'AWAITING_APPROVAL', phase: 'AWAITING_APPROVAL', startedAt: new Date().toISOString() }
  }
  private current(record: CliExecutionRecord, proposal: CliProposal, token: string): boolean {
    try {
      return this.enabled && this.activeOperationId === record.operationId && this.activeExecutionToken === token &&
        digest(proposal.policy) === digest(this.getPolicyFn()) && Date.now() <= Date.parse(proposal.expiresAt)
    } catch { return false }
  }
  private async authorize(record: CliExecutionRecord, proposal: CliProposal, token: string, command?: CliCommandDescriptor): Promise<boolean> {
    const fingerprint = await this.getFingerprintFn()
    if (!this.current(record, proposal, token)) return false
    if (fingerprint !== proposal.checkoutFingerprint) throw new Error('CHECKOUT_CHANGED')
    if (command) {
      const effective = resolveCliCommand(this.repoRoot, command.originalExecutable, command.originalArgs ?? command.args, command.relativeCwd)
      if (JSON.stringify(effective) !== JSON.stringify(command)) throw new Error('COMMAND_CHANGED')
      if (proposal.policy?.mode === 'AUTONOMOUS_CONSULTATIVE' && !isConsultativeCommand(effective)) throw new Error('NOT_AUTO_AUTHORIZED')
    }
    return true
  }
  private async run(record: CliExecutionRecord, proposal: CliProposal, token: string): Promise<void> {
    const steps = this.investigationSteps.get(record.operationId)
    let monitor: NodeJS.Timeout | undefined
    try {
      let approved = true
      if (proposal.policy?.mode === 'SUPERVISED') {
        try { approved = await this.approvalHandler({ proposalId: proposal.proposalId, operationId: record.operationId,
          command: proposal.command, commands: proposal.commands, manifestHash: proposal.manifestHash, budgets: proposal.budgets,
          repositoryDirectory: this.repoRoot, repositoryId: this.repositoryId, risks: proposal.risks }) } catch { approved = false }
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
        if (steps && !await this.authorize(record, proposal, token, command)) break
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
          void this.authorize(record, proposal, token).then(allowed => {
            if (!allowed && this.activeOperationId === record.operationId && this.activeExecutionToken === token) return this.abortActive('POLICY_CHANGED')
          }).catch(() => {
            if (this.activeOperationId === record.operationId && this.activeExecutionToken === token) return this.abortActive('CHECKOUT_CHANGED')
          }).finally(() => { monitoring = false })
        }, 500)
        const completion = this.supervisor.launch(command, {
          ownerPath: this.ownerPath,
          ...(steps ? { timeoutMs: Math.min(budgets.commandTimeoutMs, deadline - Date.now()), maxTotalOutputBytes: Math.min(budgets.stepOutputBytes, budgets.totalOutputBytes - outputBytes) } : {}),
          authorizeResume: () => this.authorize(record, proposal, token, command),
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
    const summary: CliInvestigationSummary = { operationId: record.operationId, proposalId: record.proposalId, manifestHash: proposal.manifestHash!, repositoryId: this.repositoryId,
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
  private invalidateAllProposals(): void { for (const proposal of this.proposals.values()) if (proposal.status === 'PENDING') proposal.status = 'EXPIRED' }
  private getSnapshot(operationId: string, cursor?: string): CliExecutionSnapshot {
    const record = this.executions.get(operationId)
    if (!record) throw new Error('OPERATION_NOT_FOUND')
    return { ...record, ...(this.executionBuffers.get(operationId) ?? new CliOutputBuffer()).readPage(cursor) }
  }
}
