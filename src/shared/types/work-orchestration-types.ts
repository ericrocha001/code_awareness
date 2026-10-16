import type { LocalChange, LocalChangeSummary } from './local-change-types'
import type { WorktreeDocumentContext, WorktreeDocumentRequest } from './worktree-document-context-types'
import type { WorktreeCreationEstimate } from './worktree-creation-types'
import type { OrchestrationAttention } from './work-orchestration-attention-types'
import type { WorktreeTimelinePage, WorktreeTimelineQuery, IntegrationEvidenceRequest, IntegrationEvidence } from './worktree-integration-evidence-types'
import type { BranchPullRequests } from './github-pr-types'
export interface OrchestrationContext { projectId: string; revision: number }
export interface ObservableWorktree {
  worktreeId: string
  generation: string
  creation?: WorktreeCreationEstimate
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
export interface OrchestrationOverview {
  repositoryId: string
  worktrees: ObservableWorktree[]
  inventoryCoverage: 'COMPLETE'
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
  worktree?: { worktreeId: string }
  changes?: { worktreeId: string; generation: string; snapshotRevision: string; cursor?: string; pathPrefix?: string }
  documents?: WorktreeDocumentRequest
  attention?: true
  timeline?: WorktreeTimelineQuery
  integration?: IntegrationEvidenceRequest
  /** PR history projection per branch; selector may target one branch or omit for all. */
  pullRequests?: { repositoryId: string; branch?: string } | { repositoryId: string }
}
export interface PullRequestPreview {
  repositoryId: string
  branch: string
  origin: BranchPullRequests['origin']
  destination: BranchPullRequests['destination']
}
export type OrchestrationData = OrchestrationOverview | WorktreeObservation | LocalChangesPage | WorktreeDocumentContext | OrchestrationAttention | { repositoryId: string; timeline: WorktreeTimelinePage } | IntegrationEvidence | { repositoryId: string; pullRequests: PullRequestPreview[] }
export type OrchestrationResult<T> = { success: true; context: OrchestrationContext; data: T } | { success: false; code: string }
