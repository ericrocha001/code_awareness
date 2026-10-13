import type { LocalChange, LocalChangeSummary } from './local-change-types'
import type { WorktreeDocumentContext, WorktreeDocumentRequest } from './worktree-document-context-types'
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
  observation: 'NOT_OBSERVED' | 'LAST_KNOWN' | 'REVALIDATING' | 'VERIFIED' | 'UNAVAILABLE' | 'STALE'
  localChanges?: LocalChangeSummary
  observedAt?: string
  snapshotRevision?: string
  stagedCount: number | null
  unstagedCount: number | null
  untrackedCount: number | null
  conflictCount: number | null
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
  inventoryCoverage: 'COMPLETE'
  relationsCoverage: 'NOT_EVALUATED' | 'PARTIAL' | 'COMPLETE' | 'STALE'
  observedAt: string
  revision: string
}
export interface WorktreeObservation {
  repositoryId: string
  worktree: ObservableWorktree
  observedAt: string
}
export interface OrchestrationRequest {
  context: OrchestrationContext
  pair?: { leftId: string; rightId: string; cursor?: string }
  worktree?: { worktreeId: string }
  changes?: { worktreeId: string; generation: string; snapshotRevision: string; cursor?: string; pathPrefix?: string }
  documents?: WorktreeDocumentRequest
}
export interface LocalChangesPage {
  repositoryId: string
  worktreeId: string
  generation: string
  snapshotRevision: string
  changes: LocalChange[]
  totalCount: number
  revision: string
  nextCursor: string | null
}
export type OrchestrationData = OrchestrationOverview | WorktreePair | WorktreeObservation | LocalChangesPage | WorktreeDocumentContext
export type OrchestrationResult<T> = { success: true; context: OrchestrationContext; data: T } | { success: false; code: string }
