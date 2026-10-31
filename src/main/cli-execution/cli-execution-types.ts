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
  executable: string
  originalExecutable: string
  args: string[]
  cwd: string
  relativeCwd: string
  displayCommandLine: string
}

export interface CliProposal {
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
  proposalId: string
  operationId: string
  command: CliCommandDescriptor
  repositoryDirectory: string
  repositoryId: string | null
  risks: string[]
}

export type CliApprovalHandler = (request: CliApprovalRequest) => Promise<boolean>
