import type { RemoteEvidence } from './git-evidence-types'

export interface GitManagementContext {
  projectId: string
  revision: number
}
export interface GitDecoration {
  name: string
  ref: string
  sha: string
  kind: 'LOCAL' | 'REMOTE' | 'HEAD'
  upstream: string | null
}
export interface GitHistoryNode {
  message?: string
  committer?: string
  authoredAt?: string
  authorEmail?: string
  committerEmail?: string
  sha: string
  parents: string[]
  author: string
  timestamp: string
  subject: string
  decorations: GitDecoration[]
}
export interface GitHistoryPage {
  snapshot: string
  head: string | null
  branch: string | null
  refs: GitDecoration[]
  nodes: GitHistoryNode[]
  pendingParents: string[]
  nextCursor: string | null
}
export type GitManagementResult<T> =
  | { success: true; context: GitManagementContext; data: T }
  | { success: false; code: string }
export interface GitHistoryRequest {
  context: GitManagementContext
  cursor?: string
  limit?: number
}
export interface GitLocalChange {
  path: string
  stagedState: string | null
  unstagedState: string | null
  untracked: boolean
  deleted: boolean
  renamed: boolean
  conflicted: boolean
  previousPath?: string
}
export interface GitManagementState {
  remoteEvidence?: RemoteEvidence
  branch: string | null
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  dirty: boolean
  stagedCount: number
  unstagedCount: number
  untrackedCount: number
  conflictCount: number
  operation: string | null
  indexRevision: string
  worktreeRevision: string
}
export interface GitOverview {
  state: GitManagementState
  changes: GitLocalChange[]
}
export interface GitCheckoutSynchronization {
  automaticFetch?: 'FETCHED' | 'FAILED' | 'PENDING'
  state: GitManagementState
  evidence: RemoteEvidence
  action: 'FETCH' | 'PULL_FF_ONLY' | 'COMPARE' | 'REVIEW_PUBLICATION' | null
  blockedReason: string | null
}
export interface GitCommitFile {
  path: string
  status: string
  previousPath?: string
}
export interface GitCommitDetail {
  commit: GitHistoryNode
  base: string | null
  comparison: 'ROOT' | 'FIRST_PARENT' | 'PARENT'
  files: GitCommitFile[]
  nextCursor: string | null
}
export interface GitPatch {
  patch: string
  binary: boolean
  truncated: boolean
  nextCursor: string | null
  revision: string
}
export interface GitCommitRequest {
  context: GitManagementContext
  sha: string
  cursor?: string
}
export interface GitPatchRequest {
  context: GitManagementContext
  path: string
  mode: 'WORKTREE' | 'STAGED' | 'COMMIT'
  sha?: string
  cursor?: string
}
export interface GitOperationalResult {
  value: Record<string, unknown>
  isError?: boolean
}
export type GitBasicAction =
  | { action: 'STAGE' | 'UNSTAGE'; paths: string[] }
  | { action: 'COMMIT'; message: string }
  | { action: 'CREATE' | 'SWITCH'; branch: string }
  | { action: 'FETCH' | 'PULL_FF_ONLY' | 'PUSH'; contextual?: true }
export interface GitMutationRequest {
  context: GitManagementContext
  operationId: string
  snapshot: GitManagementState
  operation: GitBasicAction
}
