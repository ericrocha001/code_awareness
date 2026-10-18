import type { ObservableWorktree } from './work-orchestration-types'
export type BranchWorktree = Pick<ObservableWorktree, 'worktreeId' | 'generation' | 'path' | 'head' | 'branch' | 'detached' | 'locked' | 'missing' | 'prunable' | 'creation'>

export interface BranchDate {
  at: string | null
  source: 'APP_RECEIPT' | 'LOCAL_REFLOG' | 'UNKNOWN'
}
export interface BranchRecord {
  key: string
  repositoryId: string
  ref: string
  name: string
  namespace: 'LOCAL' | 'TRACKING'
  head: string
  upstream: string | null
  generation: string
  revision: string
  creation: BranchDate
  lastCommitAt: string | null
  worktrees: Array<{ worktreeId: string; generation: string }>
}
export interface BranchInventory {
  repositoryId: string
  source: 'GIT_LOCAL'
  coverage: 'COMPLETE'
  observedAt: string
  revision: string
  branches: BranchRecord[]
  worktrees: BranchWorktree[]
  unassignedWorktrees: BranchWorktree[]
}
export interface BranchHistoryQuery {
  ref: string
  revision: string
  mode: 'REACHABLE' | 'EXCLUSIVE'
  baseRef?: string
  cursor?: string
}
export interface BranchHistoryPage {
  repositoryId: string
  ref: string
  head: string
  revision: string
  mode: BranchHistoryQuery['mode']
  base: { ref: string; head: string } | null
  observedAt: string
  commits: Array<{ sha: string; parents: string[]; author: string; committedAt: string; title: string }>
  nextCursor: string | null
}
