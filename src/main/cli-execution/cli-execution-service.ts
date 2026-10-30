import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type {
  CancelCliExecutionInput,
  CliApprovalHandler,
  CliExecutionRecord,
  CliExecutionSnapshot,
  CliProposal,
  GetCliExecutionInput,
  PrepareCliExecutionInput,
  StartCliExecutionInput
} from './cli-execution-types'
import { detectRisks, resolveCliCommand } from './cli-command-resolver'
import { CliProcessSupervisor } from './cli-process-supervisor'
import { CliOutputBuffer } from './cli-output-buffer'

export interface CliExecutionServiceOptions {
  repoRoot: string
  repositoryId?: string | null
  getFingerprint?: () => Promise<string>
  approvalHandler?: CliApprovalHandler
  defaultTimeoutMs?: number
  enabledByDefault?: boolean
}

export class CliExecutionService {
  private readonly repoRoot: string
  private readonly repositoryId: string | null
  private readonly getFingerprintFn: () => Promise<string>
  private approvalHandler: CliApprovalHandler
  private readonly supervisor: CliProcessSupervisor
  private enabled: boolean

  private readonly proposals = new Map<string, CliProposal>()
  private readonly executions = new Map<string, CliExecutionRecord>()
  private readonly executionBuffers = new Map<string, CliOutputBuffer>()
  private activeOperationId: string | null = null
  private activeExecutionToken: string | null = null

  constructor(options: CliExecutionServiceOptions) {
    this.repoRoot = realpathSync(options.repoRoot)
    this.repositoryId = options.repositoryId ?? null
    this.getFingerprintFn = options.getFingerprint ?? (async () => 'DEFAULT_CHECKOUT_FINGERPRINT')
    this.approvalHandler = options.approvalHandler ?? (async () => false)
    this.supervisor = new CliProcessSupervisor(options.defaultTimeoutMs)
    this.enabled = options.enabledByDefault ?? false
  }

  setApprovalHandler(handler: CliApprovalHandler): void {
    this.approvalHandler = handler
  }

  isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.activeExecutionToken = null
      void this.abortActive('CLI_EXECUTION_DISABLED')
      this.invalidateAllProposals()
    }
  }

  getActiveOperationId(): string | null {
    return this.activeOperationId
  }

  async prepare(input: PrepareCliExecutionInput): Promise<CliProposal> {
    if (!this.enabled) {
      throw new Error('CLI_EXECUTION_DISABLED: Local execution capability is currently disabled')
    }

    const command = resolveCliCommand(
      this.repoRoot,
      input.executable,
      input.args ?? [],
      input.relativeCwd
    )

    const risks = detectRisks(command.executable, command.originalExecutable, command.args)
    const fingerprint = await this.getFingerprintFn()

    const proposalId = `prop-${randomUUID()}`
    const createdAt = new Date().toISOString()
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()

    const proposal: CliProposal = {
      proposalId,
      createdAt,
      expiresAt,
      repositoryId: this.repositoryId,
      repositoryDirectory: this.repoRoot,
      checkoutFingerprint: fingerprint,
      command,
      risks,
      status: 'PENDING'
    }

    this.proposals.set(proposalId, proposal)
    return proposal
  }

  start(input: StartCliExecutionInput): CliExecutionSnapshot {
    if (!this.enabled) {
      throw new Error('CLI_EXECUTION_DISABLED: Local execution capability is currently disabled')
    }

    if (!input.operationId || typeof input.operationId !== 'string') {
      throw new Error('INVALID_ARGUMENT: operationId is required')
    }
    if (!input.proposalId || typeof input.proposalId !== 'string') {
      throw new Error('INVALID_ARGUMENT: proposalId is required')
    }

    // Check idempotency for existing operationId synchronously
    const existing = this.executions.get(input.operationId)
    if (existing) {
      if (existing.proposalId !== input.proposalId) {
        throw new Error('OPERATION_ID_CONFLICT: operationId already used with different proposal')
      }
      return this.getSnapshot(input.operationId)
    }

    // Enforce single execution concurrency synchronously
    if (this.activeOperationId !== null) {
      throw new Error(`CLI_EXECUTION_BUSY: active operation ${this.activeOperationId} in progress`)
    }

    const proposal = this.proposals.get(input.proposalId)
    if (!proposal) {
      throw new Error(`PROPOSAL_NOT_FOUND: ${input.proposalId}`)
    }

    if (Date.now() > Date.parse(proposal.expiresAt) || proposal.status === 'EXPIRED') {
      proposal.status = 'EXPIRED'
      throw new Error(`PROPOSAL_EXPIRED: proposal expired at ${proposal.expiresAt}`)
    }

    if (proposal.status === 'CONSUMED') {
      throw new Error('PROPOSAL_ALREADY_CONSUMED: Proposal has already been executed')
    }

    if (proposal.status === 'REFUSED') {
      throw new Error('PROPOSAL_REFUSED: Proposal was rejected')
    }

    // Atomic reservation before any await
    const token = randomUUID()
    this.activeOperationId = input.operationId
    this.activeExecutionToken = token

    const record: CliExecutionRecord = {
      operationId: input.operationId,
      proposalId: input.proposalId,
      status: 'AWAITING_APPROVAL',
      command: proposal.command,
      startedAt: new Date().toISOString()
    }

    this.executions.set(input.operationId, record)

    // Trigger approval and execution flow asynchronously in background (non-blocking MCP)
    void this.runApprovalAndExecution(input.operationId, input.proposalId, token)

    return this.getSnapshot(input.operationId)
  }

  private async runApprovalAndExecution(
    operationId: string,
    proposalId: string,
    token: string
  ): Promise<void> {
    const record = this.executions.get(operationId)
    const proposal = this.proposals.get(proposalId)
    if (!record || !proposal) return

    let approved = false
    try {
      approved = await this.approvalHandler({
        proposalId: proposal.proposalId,
        operationId,
        command: proposal.command,
        repositoryDirectory: this.repoRoot,
        repositoryId: this.repositoryId,
        risks: proposal.risks
      })
    } catch {
      approved = false
    }

    // CRITICAL: Revalidate everything after the approval await
    if (this.activeOperationId !== operationId || this.activeExecutionToken !== token) {
      // Operation was cancelled, project changed, or shutdown occurred during dialog
      return
    }

    if (record.status !== 'AWAITING_APPROVAL') {
      return
    }

    if (!this.enabled) {
      record.status = 'CANCELLED'
      record.diagnostic = 'SERVICE_DISABLED_DURING_APPROVAL'
      record.finishedAt = new Date().toISOString()
      this.activeOperationId = null
      this.activeExecutionToken = null
      return
    }

    if (proposal.status !== 'PENDING' || Date.now() > Date.parse(proposal.expiresAt)) {
      proposal.status = 'EXPIRED'
      record.status = 'REFUSED'
      record.diagnostic = 'PROPOSAL_EXPIRED_DURING_APPROVAL'
      record.finishedAt = new Date().toISOString()
      this.activeOperationId = null
      this.activeExecutionToken = null
      return
    }

    // Revalidate repository checkout fingerprint
    let currentFingerprint = ''
    try {
      currentFingerprint = await this.getFingerprintFn()
    } catch {
      currentFingerprint = 'CHECKOUT_FINGERPRINT_ERROR'
    }

    if (this.activeOperationId !== operationId || this.activeExecutionToken !== token) {
      return
    }

    if (currentFingerprint !== proposal.checkoutFingerprint) {
      record.status = 'REFUSED'
      proposal.status = 'REFUSED'
      record.diagnostic = 'CHECKOUT_CHANGED'
      record.finishedAt = new Date().toISOString()
      this.activeOperationId = null
      this.activeExecutionToken = null
      return
    }

    if (!approved) {
      record.status = 'REFUSED'
      proposal.status = 'REFUSED'
      record.diagnostic = 'NATIVE_APPROVAL_REFUSED'
      record.finishedAt = new Date().toISOString()
      this.activeOperationId = null
      this.activeExecutionToken = null
      return
    }

    // Consume proposal and transition to RUNNING
    proposal.status = 'CONSUMED'
    record.status = 'RUNNING'

    try {
      const completionPromise = this.supervisor.launch(proposal.command)
      if (this.supervisor.output) {
        this.executionBuffers.set(operationId, this.supervisor.output)
      }

      completionPromise
        .then((res) => {
          record.status = res.status
          record.exitCode = res.exitCode
          record.durationMs = res.durationMs
          record.finishedAt = new Date().toISOString()
          if (res.diagnostic) record.diagnostic = res.diagnostic
        })
        .catch((err) => {
          record.status = 'FAILED'
          record.finishedAt = new Date().toISOString()
          record.diagnostic = `EXECUTION_FAILED: ${err instanceof Error ? err.message : String(err)}`
        })
        .finally(() => {
          if (this.activeOperationId === operationId) {
            this.activeOperationId = null
            this.activeExecutionToken = null
          }
        })
    } catch (err) {
      record.status = 'FAILED'
      record.finishedAt = new Date().toISOString()
      record.diagnostic = `SPAWN_FAILED: ${err instanceof Error ? err.message : String(err)}`
      this.activeOperationId = null
      this.activeExecutionToken = null
    }
  }

  get(input: GetCliExecutionInput): CliExecutionSnapshot {
    if (!input.operationId || typeof input.operationId !== 'string') {
      throw new Error('INVALID_ARGUMENT: operationId is required')
    }
    return this.getSnapshot(input.operationId, input.cursor)
  }

  async cancel(input: CancelCliExecutionInput): Promise<CliExecutionSnapshot> {
    if (!input.operationId || typeof input.operationId !== 'string') {
      throw new Error('INVALID_ARGUMENT: operationId is required')
    }

    const record = this.executions.get(input.operationId)
    if (!record) {
      throw new Error(`OPERATION_NOT_FOUND: ${input.operationId}`)
    }

    if (record.status === 'AWAITING_APPROVAL') {
      record.status = 'CANCELLED'
      record.diagnostic = 'CANCELLED_BEFORE_APPROVAL'
      record.finishedAt = new Date().toISOString()
      this.activeExecutionToken = null
      if (this.activeOperationId === input.operationId) {
        this.activeOperationId = null
      }
      return this.getSnapshot(input.operationId)
    }

    if (record.status === 'RUNNING') {
      const res = await this.supervisor.cancel()
      record.status = res.status
      record.exitCode = res.exitCode
      record.durationMs = res.durationMs
      record.finishedAt = new Date().toISOString()
      if (res.diagnostic) record.diagnostic = res.diagnostic
      this.activeExecutionToken = null
      if (this.activeOperationId === input.operationId) {
        this.activeOperationId = null
      }
      return this.getSnapshot(input.operationId)
    }

    return this.getSnapshot(input.operationId)
  }

  async shutdown(): Promise<void> {
    this.activeExecutionToken = null
    await this.abortActive('SERVICE_SHUTDOWN')
    this.invalidateAllProposals()
  }

  private async abortActive(reason: string): Promise<void> {
    if (this.activeOperationId) {
      const record = this.executions.get(this.activeOperationId)
      if (record && record.status === 'AWAITING_APPROVAL') {
        record.status = 'CANCELLED'
        record.diagnostic = reason
        record.finishedAt = new Date().toISOString()
      } else if (record && record.status === 'RUNNING') {
        await this.supervisor.cancel()
        record.status = 'CANCELLED'
        record.diagnostic = reason
        record.finishedAt = new Date().toISOString()
      }
      this.activeOperationId = null
      this.activeExecutionToken = null
    }
  }

  private invalidateAllProposals(): void {
    for (const proposal of this.proposals.values()) {
      if (proposal.status === 'PENDING') {
        proposal.status = 'EXPIRED'
      }
    }
  }

  private getSnapshot(operationId: string, cursor?: string): CliExecutionSnapshot {
    const record = this.executions.get(operationId)
    if (!record) {
      throw new Error(`OPERATION_NOT_FOUND: ${operationId}`)
    }

    const buffer = this.executionBuffers.get(operationId)
    const page = buffer
      ? buffer.readPage(cursor)
      : {
          stdout: '',
          stderr: '',
          cursor: cursor ?? '0',
          nextCursor: null,
          hasMore: false,
          truncated: false,
          totalStdoutBytes: 0,
          totalStderrBytes: 0
        }

    return {
      ...record,
      ...page
    }
  }
}
