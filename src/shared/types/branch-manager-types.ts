import type { OrchestrationContext, OrchestrationResult } from './work-orchestration-types'
import type { BranchHistoryPage, BranchHistoryQuery, BranchInventory } from './branch-orchestration-types'
import type { BranchPullRequests, PullRequestCommitsPage } from './branch-pull-request-types'
import type { BranchDiscardExecute, BranchDiscardPreview } from './branch-discard-types'
import type { WorktreeRemovalExecute, WorktreeRemovalPreview } from './worktree-removal-types'
import type { GitOperationalResult } from './git-management-types'
export type BranchManagerOperation =
  | { action: 'INVENTORY' }
  | { action: 'PULL_REQUESTS'; inventoryRevision: string }
  | { action: 'COMMITS'; query: BranchHistoryQuery }
  | { action: 'PR_COMMITS'; number: number; head: string; page: number }
  | { action: 'PREPARE_DISCARD'; ref: string; revision: string; baseRef: string }
  | { action: 'EXECUTE_DISCARD'; request: BranchDiscardExecute }
  | { action: 'PREPARE_REMOVAL'; worktreeId: string; generation: string }
  | { action: 'EXECUTE_REMOVAL'; request: WorktreeRemovalExecute }
export interface BranchManagerRequest { context: OrchestrationContext; operation: BranchManagerOperation }
export type BranchManagerData =
  | { kind: 'INVENTORY'; inventory: BranchInventory }
  | { kind: 'PULL_REQUESTS'; pullRequests: BranchPullRequests; inventoryRevision: string }
  | { kind: 'COMMITS'; page: BranchHistoryPage }
  | { kind: 'PR_COMMITS'; page: PullRequestCommitsPage }
  | { kind: 'DISCARD_PREVIEW'; preview: BranchDiscardPreview }
  | { kind: 'REMOVAL_PREVIEW'; preview: WorktreeRemovalPreview }
  | { kind: 'MUTATION'; result: GitOperationalResult }
export type BranchManagerResult = OrchestrationResult<BranchManagerData>
