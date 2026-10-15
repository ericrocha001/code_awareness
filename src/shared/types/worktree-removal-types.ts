export interface PullRequestDelivery {
  repositoryId: string
  repository: string
  prNumber: number
  prId: string
  sourceRepositoryId: string
  sourceBranch: string
  head: string
  targetBranch: string
}

export type PullRequestDeliveryEvidence = {
  status: 'OBSERVED'
  source: 'GITHUB_REST'
  delivery: PullRequestDelivery
  state: 'open' | 'closed'
  merged: boolean
  mergedAt: string | null
  mergeCommit: string | null
  observedAt: string
} | { status: 'UNAVAILABLE'; source: 'GITHUB_REST'; reason: string; observedAt: string }

export interface RemovalContent {
  path: string
  kind: 'TRACKED' | 'UNTRACKED' | 'IGNORED'
  sha256: string
  bytes: number
}

export interface RemovalIntent {
  mode: 'INTEGRATED' | 'ABANDONED'
  delivery: PullRequestDelivery | null
  noPullRequestConfirmed: boolean
  abandonmentReason: string
}

export interface RemovalPreview {
  managed: boolean
  preparationId: string
  repositoryId: string
  worktreeId: string
  generation: string
  path: string
  branch: string | null
  head: string | null
  fingerprint: string
  expiresAt: string
  state: 'BLOCKED' | 'PREPARING'
  blockers: string[]
  content: RemovalContent[]
  preservedRef: string | null
  intent: RemovalIntent
  observedAt: string
}

export interface RemovalConsent {
  fingerprint: string
  exactPath: string
  ownerReleased: boolean
  operatorIsOwner: boolean
  noKnownWriter: boolean
  discardPaths: string[]
}

export type RemovalAction =
  | { action: 'POLICY'; enabled?: boolean }
  | { action: 'RECOVER'; worktreeId: string; generation: string }
  | { action: 'ENROLL'; preparationId: string; consent: RemovalConsent }
  | { action: 'PREPARE'; worktreeId: string; generation: string; intent: RemovalIntent; prNumber?: number }
  | { action: 'CANCEL'; preparationId: string }
  | { action: 'EXECUTE'; preparationId: string; operationId: string; consent: RemovalConsent }
  | { action: 'RECONCILE'; preparationId: string; operationId: string }

export interface RemovalRequest {
  context: { projectId: string; revision: number }
  operation: RemovalAction
}

export interface RemovalReceipt {
  operationId: string
  preparationId: string
  state: 'CLOSED' | 'BLOCKED' | 'UNKNOWN'
  code?: string
  path: string
  preservedRef: string | null
}

export interface RemovalPolicy { enabled: boolean; revision: string; enrolled: number; candidates?: Array<{ path: string; state: string; code?: string }> }
export type RemoteRemovalCapability = { provider: 'REMOTE_GIT_WORKTREE' | 'REMOTE_SANDBOX'; state: 'UNSUPPORTED' | 'UNAVAILABLE'; mutationAllowed: false }
export type RemovalResponse = { success: true; data: RemovalPreview | RemovalReceipt | RemovalPolicy | { state: 'CANCELLED' | 'ENROLLED' | 'NO_PENDING_REMOVAL' } } | { success: false; code: string }
