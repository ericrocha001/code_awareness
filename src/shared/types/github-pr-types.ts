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
  'OUTCOME_UNKNOWN' | 'RECONCILIATION_LIMIT' | 'RECEIPT_UNAVAILABLE' | 'PROJECT_CHANGED'

export class PullRequestError extends Error {
  constructor(readonly code: PullRequestFailureCode) { super(code) }
}
