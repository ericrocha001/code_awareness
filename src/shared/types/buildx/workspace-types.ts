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
      readonly reason: string
    }
  | {
      readonly status: 'UNAVAILABLE'
      readonly binding: BuildXWorkspaceBindingRecord
      readonly reason: string
    }
