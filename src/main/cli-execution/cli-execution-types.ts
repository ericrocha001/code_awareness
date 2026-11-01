import type { CliPolicy } from '../../shared/types/cli-policy-types'

export type CliExecutionStatus =
  | 'AWAITING_APPROVAL'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'REFUSED'
  | 'INTERRUPTED'

export interface CliCommandDescriptor {
  originalArgs?: string[]
  windowsCommandLine?: string
  executable: string
  originalExecutable: string
  args: string[]
  cwd: string
  relativeCwd: string
  displayCommandLine: string
}

export interface CliProposal {
  worktree?: CliWorktreeIdentity
  policy?: CliPolicy
  autoAuthorized?: boolean
  commands?: CliCommandDescriptor[]
  manifestHash?: string
  budgets?: { commandTimeoutMs: number; totalTimeoutMs: number; stepOutputBytes: number; totalOutputBytes: number }
  proposalId: string
  createdAt: string
  expiresAt: string
  repositoryId: string | null
  repositoryDirectory: string
  checkoutFingerprint: string
  command: CliCommandDescriptor
  risks: string[]
  status: 'PENDING' | 'APPROVED' | 'REFUSED' | 'EXPIRED' | 'CONSUMED'
}

export interface CliOutputPage {
  stdout: string
  stderr: string
  cursor?: string
  nextCursor: string | null
  hasMore: boolean
  truncated: boolean
  totalStdoutBytes: number
  totalStderrBytes: number
}

export interface CliExecutionRecord {
  worktree?: CliWorktreeIdentity
  policy?: CliPolicy
  repositoryId?: string | null
  origin?: 'CLI_EXECUTION_CAPABILITY'
  treeObservation?: { activeProcesses: 0; handlesClosed: true }
  phase?: 'AWAITING_APPROVAL' | 'LAUNCHING' | 'RUNNING' | 'STOPPING' | 'TERMINAL' | 'TERMINATION_UNCONFIRMED'
  operationId: string
  proposalId: string
  status: CliExecutionStatus
  command: CliCommandDescriptor
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  exitCode?: number | null
  error?: string
  diagnostic?: string
}

export interface CliExecutionSnapshot extends CliExecutionRecord, CliOutputPage {}

export interface PrepareCliExecutionInput {
  worktree?: CliWorktreeSelector
  executable: string
  args?: string[]
  relativeCwd?: string
}

export interface StartCliExecutionInput {
  proposalId: string
  operationId: string
}

export interface GetCliExecutionInput {
  operationId: string
  cursor?: string
}

export interface CancelCliExecutionInput {
  operationId: string
}

export interface CliApprovalRequest {
  worktree?: CliWorktreeIdentity
  activeCheckoutDirectory?: string
  commands?: CliCommandDescriptor[]
  manifestHash?: string
  budgets?: CliProposal['budgets']
  proposalId: string
  operationId: string
  command: CliCommandDescriptor
  repositoryDirectory: string
  repositoryId: string | null
  risks: string[]
}

export type CliApprovalHandler = (request: CliApprovalRequest) => Promise<boolean>

export interface PrepareCliInvestigationInput { commands: Omit<PrepareCliExecutionInput, 'worktree'>[] }
export interface CliWorktreeSelector { worktreeId: string; generation: string }
export interface CliWorktreeIdentity extends CliWorktreeSelector {
  head: string | null
  branch: string | null
  indexRevision: string
}
export interface CliResolvedWorktree {
  directory: string
  identity: CliWorktreeIdentity
  getFingerprint: () => Promise<string>
}
export interface GetCliInvestigationInput extends GetCliExecutionInput { index?: number }
export interface CliInvestigationSummary {
  operationId: string
  proposalId: string
  manifestHash: string
  repositoryId: string | null
  policy: CliPolicy
  status: CliExecutionStatus
  phase: CliExecutionRecord['phase']
  diagnostic?: string
  durationMs?: number
  treeObservation?: CliExecutionRecord['treeObservation']
  steps: Array<{ index: number; operationId: string; status: CliExecutionStatus | 'NOT_STARTED'; phase?: CliExecutionRecord['phase']; exitCode?: number | null; durationMs?: number; diagnostic?: string; treeObservation?: CliExecutionRecord['treeObservation'] }>
}
