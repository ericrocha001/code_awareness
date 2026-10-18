export interface PullRequestSummary {
  number: number
  url: string
  state: 'open' | 'closed'
  draft: boolean
  title: string
  head: { ref: string; sha: string; repository: string }
  base: { ref: string; sha: string; repository: string }
  mergedAt: string | null
  mergeability: 'MERGEABLE' | 'NOT_MERGEABLE' | 'UNKNOWN'
  observedAt: string
  lifecycle?: 'OPEN' | 'CLOSED' | 'MERGED'
  mergeCommitSha?: string | null
  stack?: 'NONE' | 'PRESENT' | 'UNKNOWN'
}

export interface PullRequestQuery {
  state?: 'open' | 'closed' | 'all'
  headBranch?: string
  baseBranch?: string
  cursor?: string
  pageSize?: number
}

export interface CreatePullRequestInput {
  headBranch: string
  baseBranch: string
  expectedHeadSha: string
  title: string
  body: string
  operationId: string
  worktreeId?: string
}

export interface PullRequestApproval extends CreatePullRequestInput {
  repositoryId: string
  repository: string
  operation: 'CREATE_PULL_REQUEST'
  expiresAt: string
}

export interface PullRequestContext {
  repositoryId: string
  repository: string
}

export type PullRequestFailureCode = 'INVALID_ARGUMENT' | 'HEAD_DRIFT' | 'WORKTREE_DRIFT' |
  'IDEMPOTENCY_CONFLICT' | 'AUTHORIZATION_REQUIRED' | 'AUTHORIZATION_DENIED' |
  'AUTHORIZATION_EXPIRED' | 'PR_IDENTITY_CONFLICT' | 'CLOSED_PR_REQUIRES_DECISION' |
  'OUTCOME_UNKNOWN' | 'RECONCILIATION_LIMIT' | 'RECEIPT_UNAVAILABLE' | 'PROJECT_CHANGED' |
  'BASE_DRIFT' | 'PR_NOT_OPEN' | 'DRAFT_PR' | 'STACKED_PR_UNSUPPORTED' | 'STACK_UNKNOWN' |
  'POLICY_UNKNOWN' | 'POLICY_BLOCKED' | 'METHOD_NOT_ALLOWED' | 'CHECKS_NOT_READY' |
  'REVIEWS_NOT_READY' | 'OPERATION_NOT_FOUND' | 'OPERATION_CONFLICT' | 'PERMISSION_REQUIRED'

export class PullRequestError extends Error {
  constructor(readonly code: PullRequestFailureCode) { super(code) }
}

export interface PullRequestReview {
  id: number
  reviewer: string
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'DISMISSED' | 'COMMENTED' | 'PENDING'
  commitSha: string
  submittedAt: string | null
}

export interface PullRequestCheck {
  id: number
  name: string
  kind: 'CHECK_RUN' | 'COMMIT_STATUS'
  sha: string
  appId: number | null
  status: 'PASSED' | 'PENDING' | 'FAILED' | 'UNKNOWN'
  providerStatus: string
  conclusion: string | null
  updatedAt: string
}

export interface RequiredPullRequestCheck { name: string; appId: number | null }
export interface PullRequestPolicy {
  coverage: 'COMPLETE' | 'INCOMPLETE' | 'UNAVAILABLE'
  requiredChecks: RequiredPullRequestCheck[]
  requiredApprovals: number
  queue: boolean
  mergeCommitAllowed: boolean
  queueMethod: 'merge' | 'squash' | 'rebase' | 'UNKNOWN' | null
  limitations: string[]
  observedAt: string
}

export interface PullRequestMutationInput {
  prNumber: number
  operationId: string
  expectedHeadSha: string
  expectedBaseSha?: string
}

export interface PullRequestMutationApproval extends PullRequestMutationInput, PullRequestContext {
  expectedBaseSha: string
  operation: 'MERGE_PULL_REQUEST' | 'CLOSE_PULL_REQUEST'
  headBranch: string
  baseBranch: string
  observedState: 'OPEN'
  mergeMethod?: 'merge' | 'QUEUE_CONTROLLED'
  mergeAction?: 'default'
  mayEnqueue: boolean
  baseConcurrency: 'PROVIDER_RULES_NO_ATOMIC_BASE_CAS'
  expiresAt: string
}

export type PullRequestOperationStatus = 'PENDING' | 'ENQUEUED' | 'MERGED' | 'CLOSED' | 'FAILED' | 'OUTCOME_UNKNOWN'
export interface PullRequestOperationResult {
  operationId: string
  operation: 'MERGE_PULL_REQUEST' | 'CLOSE_PULL_REQUEST'
  repository: string
  prNumber: number
  status: PullRequestOperationStatus
  head: PullRequestSummary['head']
  base: PullRequestSummary['base']
  uuid?: string
  mergeCommitSha?: string
  reason?: string
  observedAt: string
  nextAction: 'READ_OPERATION_STATUS' | 'INSPECT_PR' | 'NONE'
  localGitChanged: false
  baseConcurrency: 'PROVIDER_RULES_NO_ATOMIC_BASE_CAS'
}

export interface AsyncPullRequestMerge {
  httpStatus: number
  status: 'pending' | 'enqueued' | 'merged' | 'failed' | 'unknown'
  uuid?: string
  expectedHeadSha?: string
  method?: string
  action?: string
  bypassRules?: boolean
  mergeCommitSha?: string
}
