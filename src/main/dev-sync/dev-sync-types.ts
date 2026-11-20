export type DevSyncStatus =
  | 'NONE'
  | 'IDLE'
  | 'SYNCING'
  | 'RESTARTING'
  | 'SCHEDULED'
  | 'COMPLETED'
  | 'ALREADY_CURRENT'
  | 'FAILED'
  | 'PARTIAL'
  | 'UNSUPPORTED'
  | 'INSTANCE_MISMATCH'
  | 'BUSY'
  | 'DIRTY_WORKTREE'
  | 'DETACHED_HEAD'
  | 'UPSTREAM_UNAVAILABLE'
  | 'AHEAD_OR_DIVERGED'
  | 'EXPECTED_COMMIT_NOT_INTEGRATED'
  | 'ASYMMETRIC_TRACKING_UNSUPPORTED'

export interface DevSyncRequest {
  operationId: string
  expectedInstanceId: string
  expectedIntegratedCommit?: string
  caller?: 'UI' | 'MCP'
}

export interface DevSyncResult {
  operationId: string
  status: DevSyncStatus
  message: string
  head?: string
  oldInstanceId?: string
  newInstanceId?: string
  details?: Record<string, unknown>
  postResponse?: () => Promise<void>
}

export interface DevSyncSupervisorReceipt {
  operationId: string
  status: DevSyncStatus
  expectedHead?: string
  head?: string
  oldInstanceId?: string
  newInstanceId?: string
  error?: string
  details?: Record<string, unknown>
  committedAt?: number
  completedAt?: number
}

export interface DevSyncAvailability {
  available: boolean
  reason?: string
  branch?: string
  head?: string
  supervisorConnected: boolean
  lastResult?: DevSyncResult | null
}
