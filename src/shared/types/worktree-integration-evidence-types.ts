export interface CommitNavigationIntent { projectId: string; revision: number; commitSha: string; requestId: string }
export interface WorktreeTimelineQuery { worktreeId: string; generation: string }
export type LocalCommitOperation = 'COMMIT' | 'INITIAL_COMMIT' | 'AMEND' | 'CHERRY_PICK' | 'REBASE_PICK'
export interface WorktreeTimelinePage {
  repositoryId: string
  worktreeId: string
  generation: string
  head: string | null
  source: 'HEAD_REFLOG'
  revision: string
  observedAt: string
  coverage: 'COMPLETE_OBSERVED_SINCE_CREATION' | 'PARTIAL' | 'UNAVAILABLE' | 'EMPTY_VERIFIED'
  reasons: string[]
  observedEvents: number
  identifiedCount: number
  omitted: number
  truncated: boolean
  items: Array<{ sha: string; title: string; reachability: 'HEAD_CURRENT' | 'REACHABLE' | 'NOT_REACHABLE' | 'UNKNOWN'; events: Array<{ operation: LocalCommitOperation; eventAt: string; sequence: number }> }>
}
export interface IntegrationEvidenceRequest {
  worktreeId: string
  generation: string
  targetBranch: string
  candidate?: { worktreeId: string; generation: string; head: string; sourceHead: string; targetHead: string; requirements: Array<{ profileId: string; proofIds: string[] }> }
}
export interface IntegrationEvidence {
  repositoryId: string
  revision: string
  observedAt: string
  state: 'BLOCKED' | 'EVIDENCE_PENDING' | 'ELIGIBLE_FOR_REVIEW' | 'STALE'
  source: { worktreeId: string; generation: string; head: string | null; branch: string | null; indexRevision: string; worktreeRevision: string }
  target: { branch: string; head: string; worktreeId: string | null; generation: string | null; snapshot: { head: string | null; branch: string | null; operation: string | null; indexRevision: string; worktreeRevision: string } | null }
  candidate: IntegrationEvidenceRequest['candidate'] | null
  mode: 'FF_ONLY' | 'MERGE'
  mergeBase: string | null
  compatibility: 'FAST_FORWARD_VERIFIED' | 'MERGE_COMPATIBILITY_NOT_VERIFIED' | 'CANDIDATE_VERIFIED'
  blockers: string[]
  missing: string[]
  commits: string[]
  coverage: 'COMPLETE' | 'PARTIAL'
  proofs: Array<{ proofId: string; profileId: string; freshness: 'CURRENT' | 'HISTORICAL' | 'UNVERIFIABLE' | 'NOT_AVAILABLE'; status: string; producer?: string; head?: string; runtimeInstanceId?: string | null; sourceFingerprint?: string | null; checkout?: { repositoryId: string; worktreeId: string; generation: string; head: string; runId: string; issuer: string } }>
  nextAction: string
}
