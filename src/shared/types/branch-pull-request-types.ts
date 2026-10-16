import type { BranchRecord } from './branch-orchestration-types'

export interface PullRequestRecord {
  id: string
  number: number
  url: string
  title: string
  state: 'open' | 'closed'
  draft: boolean
  merged: boolean
  mergedAt: string | null
  mergeCommit: string | null
  createdAt: string
  updatedAt: string
  base: { repositoryId: string; repository: string; ref: string; sha: string }
  head: { repositoryId: string | null; repository: string | null; ref: string; sha: string }
}
export interface PullRequestCatalog {
  repositoryId: string
  repository: string | null
  providerRepositoryId: string | null
  defaultBranch: string | null
  source: 'GITHUB_REST'
  coverage: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE'
  observedAt: string
  revision: string
  reason: string | null
  items: PullRequestRecord[]
}
export interface BranchPullRequestRelation {
  branchKey: string
  branchRevision: string
  branchGeneration: string
  repositoryId: string
  ref: string
  head: string
  source: 'GITHUB_REST'
  observedAt: string
  catalogRevision: string
  coverage: PullRequestCatalog['coverage']
  classification: 'CONFIRMED_CURRENT' | 'CONFIRMED_HISTORICAL' | 'CANDIDATE' | 'AMBIGUOUS' | 'UNKNOWN'
  historicalEvidence?: { sha: string; observedAt: string }
  pullRequest: PullRequestRecord
}
export interface BranchPullRequests {
  repositoryId: string
  catalog: PullRequestCatalog
  relations: BranchPullRequestRelation[]
  orphaned: PullRequestRecord[]
}
export interface PullRequestCommitsPage {
  repositoryId: string
  prNumber: number
  head: string
  source: 'GITHUB_REST'
  observedAt: string
  commits: Array<{ sha: string; title: string; committedAt: string }>
  nextPage: number | null
}
export type BranchWithPullRequests = BranchRecord & { pullRequests: BranchPullRequestRelation[] }
