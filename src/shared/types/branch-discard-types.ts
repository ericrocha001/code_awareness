import type { BranchRecord, BranchInventory } from './branch-orchestration-types'
export interface BranchDiscardRemoteEvidence {
  repositoryId: string
  coverage: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE'
  observedAt: string
  revision: string
  defaultBranch: string | null
  protected: boolean | null
  openPullRequests: number[]
  knownPullRequests: Array<{ number: number; state: string; merged: boolean }>
  reason: string | null
}
export type BranchDiscardRemoteReader = (inventory: BranchInventory, branch: BranchRecord) => Promise<BranchDiscardRemoteEvidence>
export interface BranchDiscardPreview {
  previewId: string
  repositoryId: string
  branch: BranchRecord
  inventoryRevision: string
  base: { ref: string; head: string }
  integrated: boolean
  exclusiveCount: number
  exclusiveSample: string[]
  worktrees: BranchInventory['worktrees']
  checkouts: Array<{ worktreeId: string; path: string; coverage: 'OBSERVED' | 'UNAVAILABLE'; stagedCount: number | null; unstagedCount: number | null; untrackedCount: number | null; ignoredCount: number | null }>
  remote: BranchDiscardRemoteEvidence
  blockers: string[]
  recoveryRequired: boolean
  expiresAt: string
}
export interface BranchDiscardExecute {
  previewId: string
  operationId: string
  confirmed: true
  preserveExclusive: boolean
}
