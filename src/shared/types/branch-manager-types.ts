import type { OrchestrationContext, OrchestrationResult } from './work-orchestration-types'
import type { BranchHistoryPage, BranchHistoryQuery, BranchInventory } from './branch-orchestration-types'
import type { BranchPullRequests, PullRequestCommitsPage } from './branch-pull-request-types'
import type { BranchDiscardExecute, BranchDiscardPreview } from './branch-discard-types'
import type { WorktreeRemovalExecute, WorktreeRemovalPreview } from './worktree-removal-types'
import type { GitOperationalResult } from './git-management-types'
import type { ExecutionBindingPage, ExecutionDocumentPage } from './execution-branch-types'
export type BranchManagerOperation =
  | { action: 'PREVIEW_RUNTIME'; request: import('./runtime-preview-operations').RuntimePreviewRequest }
  | { action: 'PREVIEW_PROFILES'; repositoryId: string }
  | { action: 'PREVIEW_WORKTREES'; repositoryId: string }
  | { action: 'PREVIEW_PREFLIGHT'; selection: import('./runtime-preview-types').PreviewSelection }
  | { action: 'PREVIEW_APPROVE'; selection: import('./runtime-preview-types').PreviewSelection }
  | { action: 'INVENTORY' }
  | { action: 'EXECUTIONS'; ref: string; revision: string; cursor?: string }
  | { action: 'EXECUTION_DOCUMENTS'; ref: string; revision: string; bindingId: string; executionId: string; cursor?: string }
  | { action: 'PULL_REQUESTS'; inventoryRevision: string }
  | { action: 'COMMITS'; query: BranchHistoryQuery }
  | { action: 'PR_COMMITS'; number: number; head: string; page: number }
  | { action: 'PREPARE_DISCARD'; ref: string; revision: string; baseRef: string }
  | { action: 'EXECUTE_DISCARD'; request: BranchDiscardExecute }
  | { action: 'PREPARE_REMOVAL'; worktreeId: string; generation: string }
  | { action: 'EXECUTE_REMOVAL'; request: WorktreeRemovalExecute }
export interface BranchManagerRequest { context: OrchestrationContext; operation: BranchManagerOperation }
export type BranchManagerData =
  | { kind: 'PREVIEW_RUNTIME'; result: import('./runtime-preview-operations').RuntimePreviewResult }
  | { kind: 'PREVIEW_PROFILES'; profiles: import('./runtime-preview-types').PreviewProfileSummary[] }
  | { kind: 'PREVIEW_WORKTREES'; repositoryId: string; worktrees: import('./branch-orchestration-types').BranchWorktree[] }
  | { kind: 'PREVIEW_PREFLIGHT'; preflight: import('./runtime-preview-types').PreviewPreflight }
  | { kind: 'INVENTORY'; inventory: BranchInventory }
  | { kind: 'EXECUTIONS'; page: ExecutionBindingPage }
  | { kind: 'EXECUTION_DOCUMENTS'; page: ExecutionDocumentPage }
  | { kind: 'PULL_REQUESTS'; pullRequests: BranchPullRequests; inventoryRevision: string }
  | { kind: 'COMMITS'; page: BranchHistoryPage }
  | { kind: 'PR_COMMITS'; page: PullRequestCommitsPage }
  | { kind: 'DISCARD_PREVIEW'; preview: BranchDiscardPreview }
  | { kind: 'REMOVAL_PREVIEW'; preview: WorktreeRemovalPreview }
  | { kind: 'MUTATION'; result: GitOperationalResult }
export type BranchManagerResult = OrchestrationResult<BranchManagerData>
