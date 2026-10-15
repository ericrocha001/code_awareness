import type { GitManagementContext } from './git-management-types'

export interface GitCorrelationQuery {
  mode?: 'REACHABLE' | 'EXCLUSIVE'
  reference?: string
  limit?: number
  cursor?: string
  contextKey?: string
}
export interface GitWorktreeCommitsQuery extends GitCorrelationQuery { worktreeId: string; generation: string }
export interface GitCommitWorktreesQuery extends GitCorrelationQuery { sha: string }
export interface GitCorrelationWorktree {
  worktreeId: string
  generation: string
  branch: string | null
  detached: boolean
  head: string
}
export interface GitCommitAssociation {
  sha: string
  relation: 'HEAD_EXACT' | 'REACHABLE_FROM_HEAD'
  referenceRelation: 'EXCLUSIVE_RELATIVE_TO_REFERENCE' | null
}
interface GitCorrelationObservation {
  repositoryId: string
  revision: string
  observedAt: string
  reference: { ref: string; sha: string } | null
  mode: 'REACHABLE' | 'EXCLUSIVE'
  coverage: 'COMPLETE' | 'PARTIAL'
  outcome: 'MATCHES' | 'NONE_VERIFIED' | 'UNKNOWN'
  nextCursor: string | null
}
export interface GitWorktreeCommitsPage extends GitCorrelationObservation {
  direction: 'WORKTREE_COMMITS'
  worktree: GitCorrelationWorktree
  items: GitCommitAssociation[]
}
export interface GitCommitWorktreesPage extends GitCorrelationObservation {
  direction: 'COMMIT_WORKTREES'
  sha: string
  items: Array<GitCorrelationWorktree & GitCommitAssociation>
  scope: { total: number; start: number; end: number; matched: number; unavailable: number }
  unavailable: Array<{ worktreeId: string; generation: string; reason: string }>
}
export type GitCommitCorrelationRequest = { context: GitManagementContext } & (
  | { direction: 'WORKTREE_COMMITS' } & Omit<GitWorktreeCommitsQuery, 'contextKey'>
  | { direction: 'COMMIT_WORKTREES' } & Omit<GitCommitWorktreesQuery, 'contextKey'>
)
export type GitCommitCorrelationPage = GitWorktreeCommitsPage | GitCommitWorktreesPage
