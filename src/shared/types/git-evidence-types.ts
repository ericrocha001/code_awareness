export type RemoteEvidence =
  | { status: 'NOT_CHECKED'; source: 'LOCAL_TRACKING' }
  | { status: 'UNAVAILABLE'; source: 'GIT_LS_REMOTE'; reason: 'NO_UPSTREAM' | 'REMOTE_MISSING' | 'REMOTE_REF_MISSING' | 'TIMEOUT' | 'ACCESS_DENIED' | 'NETWORK_ERROR' | 'INVALID_REMOTE_RESPONSE'; observedAt: string }
  | { status: 'VERIFIED'; source: 'GIT_LS_REMOTE'; remote: string; ref: string; localHead: string | null; trackingHead: string | null; remoteHead: string; observedAt: string; tracking: 'TRACKING_CURRENT' | 'TRACKING_STALE'; relationship: 'IN_SYNC' | 'AHEAD' | 'BEHIND' | 'DIVERGED' | 'UNKNOWN'; remoteCounts: { ahead: number; behind: number } | null }

export interface PullRequestMergeability {
  status: 'OBSERVED'
  source: 'GITHUB_REST'
  repository: string
  prNumber: number
  state: 'open' | 'closed'
  draft: boolean
  base: { ref: string; sha: string }
  head: { ref: string; sha: string }
  mergeability: 'MERGEABLE' | 'NOT_MERGEABLE' | 'UNKNOWN'
  conflict: 'CONFLICT_CONFIRMED' | 'NOT_CONFIRMED'
  providerStatus?: string
  observedAt: string
}
