import type { GitAtlasComparison, GitAtlasPage, GitAtlasQuery } from './git-atlas-types'
import type { BranchPullRequests, PullRequestRecord } from './branch-pull-request-types'

export interface GitAtlasEvidenceQuery extends GitAtlasQuery {
  comparisonRef?: string
}

export type CheckoutRelation = 'EQUAL' | 'BEHIND_ONLY' | 'AHEAD_ONLY' | 'DIVERGED' | 'UNRELATED' | 'UNKNOWN'

export type GitAtlasEvidenceEvent =
  | { kind: 'GIT_MERGE_COMMIT'; evidenceSource: 'GIT_LOCAL'; confidence: 'CONFIRMED'; sha: string; parents: string[]; firstParent: string; committedAt: string; observedAt: string }
  | { kind: 'PR_CREATED'; evidenceSource: 'GITHUB_REST'; confidence: 'CONFIRMED'; prNumber: number; url: string; at: string; observedAt: string }
  | { kind: 'PR_MERGED'; evidenceSource: 'GITHUB_REST'; confidence: 'CONFIRMED'; prNumber: number; url: string; at: string; mergeCommitSha: string | null; observedAt: string; integrationMethod: 'MERGE_COMMIT' | 'MERGED_METHOD_UNKNOWN'; methodEvidenceSource: 'GIT_AND_GITHUB' | 'UNKNOWN' }

export interface GitAtlasCoreEvidence {
  phase: 'CORE'
  repositoryId: string
  worktreeId: string
  worktreeGeneration: string
  observedAt: string
  gitSnapshot: string
  source: 'GIT_LOCAL'
  coverage: { git: 'COMPLETE' | 'PARTIAL'; github: 'NOT_REQUESTED' }
  gitCoverageScope: 'REQUESTED_WINDOW'
  git: GitAtlasPage
  checkout: {
    head: string | null
    ref: string | null
    detached: boolean
    upstream: string | null
    comparisonRef: string | null
    comparisonSource: 'LOCAL_REF_OR_OBJECT' | 'LOCAL_REMOTE_TRACKING' | 'NOT_REQUESTED'
    relation: CheckoutRelation
    ahead: number | null
    behind: number | null
    comparison: GitAtlasComparison | null
  }
  worktrees: Array<{ worktreeId: string; generation: string; head: string | null; branch: string | null; detached: boolean; available: boolean }>
  events: GitAtlasEvidenceEvent[]
  historicalIntegrationCoverage: 'UNKNOWN'
}

export interface GitAtlasPrEvidence {
  phase: 'PR_ENRICHMENT'
  repositoryId: string
  worktreeId: string
  worktreeGeneration: string
  gitSnapshot: string
  observedAt: string
  source: 'GITHUB_REST'
  providerRevision: string | null
  coverage: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE'
  reason: string | null
  branches: BranchPullRequests | null
  pullRequests: Array<{ record: PullRequestRecord; lifecycle: 'OPEN' | 'CLOSED_UNMERGED' | 'MERGED'; openInterval: 'UNKNOWN'; localInclusion: 'UNKNOWN' }>
  events: GitAtlasEvidenceEvent[]
}
