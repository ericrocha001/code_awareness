export interface BuildXWorkspaceBindingRecord {
  readonly sessionId: string
  readonly repositoryId: string
  readonly worktreeId: string
  readonly generation: string
  readonly branch: string
  readonly headAtBind: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface SaveWorkspaceBindingInput {
  readonly repositoryId: string
  readonly worktreeId: string
  readonly generation: string
  readonly branch: string
  readonly headAtBind: string
}

export type BuildXBoundWorkspaceStatus = 'CURRENT' | 'STALE' | 'UNAVAILABLE' | 'UNBOUND'

export type BuildXWorkspaceStaleReason =
  | 'WORKTREE_NOT_FOUND'
  | 'WORKTREE_MISSING'
  | 'WORKTREE_LOCKED'
  | 'WORKTREE_PRUNABLE'
  | 'DETACHED_HEAD'
  | 'GENERATION_CHANGED'
  | 'BRANCH_CHANGED'
  | 'HEAD_UNAVAILABLE'
  | 'BRANCH_NOT_IN_INVENTORY'
  | 'BRANCH_NOT_LINKED'
  | 'HEAD_DIVERGED'
  | 'PRIMARY_CHECKOUT'

export type BuildXWorkspaceUnavailableReason =
  | 'GIT_PORT_UNAVAILABLE'
  | 'GIT_INVENTORY_UNAVAILABLE'
  | 'REPOSITORY_CONTEXT_CHANGED'
  | 'EVIDENCE_UNAVAILABLE'
  | 'COORDINATION_SNAPSHOT_FAILED'

export type BuildXInspectWorkspaceResult =
  | { readonly status: 'UNBOUND' }
  | {
      readonly status: 'CURRENT'
      readonly binding: BuildXWorkspaceBindingRecord
      readonly currentHead: string
    }
  | {
      readonly status: 'STALE'
      readonly binding: BuildXWorkspaceBindingRecord
      readonly reason: BuildXWorkspaceStaleReason | string
    }
  | {
      readonly status: 'UNAVAILABLE'
      readonly binding: BuildXWorkspaceBindingRecord
      readonly reason: BuildXWorkspaceUnavailableReason | string
    }
