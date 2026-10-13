export interface OrchestrationContext { projectId: string; revision: number }
export interface ObservableWorktree {
  worktreeId: string
  generation: string
  path: string
  branch: string | null
  head: string | null
  detached: boolean
  locked: boolean
  missing: boolean
  prunable: boolean
  reference: boolean
  snapshot: { head: string | null; branch: string | null; operation: string | null; indexRevision: string; worktreeRevision: string } | null
  stagedCount: number
  unstagedCount: number
  untrackedCount: number
  conflictCount: number
  reason: string | null
}
export interface WorktreePair {
  repositoryId: string
  left: ObservableWorktree
  right: ObservableWorktree
  base: string | null
  category: 'PATH_OVERLAP' | 'NO_PATH_OVERLAP' | 'INDETERMINATE' | 'STALE'
  reason: string | null
  totalPaths: number
  paths: string[]
  revision: string
  nextCursor: string | null
}
export interface OrchestrationOverview {
  repositoryId: string
  worktrees: ObservableWorktree[]
  pairs: WorktreePair[]
  coverage: 'COMPLETE' | 'PARTIAL'
  reason: string | null
  automaticLimit: number
}
export interface OrchestrationRequest {
  context: OrchestrationContext
  pair?: { leftId: string; rightId: string; cursor?: string }
}
export type OrchestrationResult<T> = { success: true; context: OrchestrationContext; data: T } | { success: false; code: string }
