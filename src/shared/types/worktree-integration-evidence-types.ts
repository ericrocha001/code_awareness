import type { GitWorktreeCommitsPage } from './git-commit-correlation-types'
export interface CommitNavigationIntent { projectId: string; revision: number; commitSha: string; requestId: string }
export interface WorktreeTimelinePage extends Omit<GitWorktreeCommitsPage, 'items'> {
  items: Array<GitWorktreeCommitsPage['items'][number] & { title: string; committerDate: string }>
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
