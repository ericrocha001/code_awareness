import type { BranchWorktree } from './branch-orchestration-types'
export interface WorktreeRemovalPreview {
  previewId: string
  repositoryId: string
  worktree: BranchWorktree
  inventoryRevision: string
  snapshotRevision: string
  preservationRef: string | null
  preservationHead: string | null
  stagedCount: number | null
  unstagedCount: number | null
  untrackedCount: number | null
  ignoredCount: number | null
  blockers: string[]
  expiresAt: string
}
export interface WorktreeRemovalExecute {
  previewId: string
  operationId: string
  releasedByUser: true
}
