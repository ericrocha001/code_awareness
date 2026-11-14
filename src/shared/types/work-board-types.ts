import type { OrchestrationContext } from './work-orchestration-types'

export type WorkBoardColumn = 'QUEUED' | 'ACTIVE' | 'COMPLETED'
export type WorkBoardCoverage = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE'
export interface WorkBoardContext extends OrchestrationContext { repositoryId: string }

export interface WorkBoardRequest {
  context: WorkBoardContext
  column: WorkBoardColumn
  cursor?: string
  inspect?: { artifactId: string; revision: number }
}

export interface WorkBoardArtifact {
  artifactId: string
  revision: number
  name: string
  description?: string
  kind: string
  status?: string
  updatedAt: string
}

export interface WorkBoardRelation {
  artifact: WorkBoardArtifact
  kind: string
  direction: 'INBOUND' | 'OUTBOUND'
}

export interface WorkBoardCard {
  artifact: WorkBoardArtifact
  workItem?: WorkBoardArtifact
  relations: WorkBoardRelation[]
  relationCoverage: WorkBoardCoverage
  ambiguous: boolean
}

export interface WorkBoardPage {
  column: WorkBoardColumn
  documentaryRevision: number
  queriedAt: string
  cards: WorkBoardCard[]
  coverage: WorkBoardCoverage
  nextCursor?: string
  inspection?: WorkBoardInspection
}

export interface WorkBoardBranch {
  worktreeId: string
  generation: string
  ref: string
  branchGeneration: string
}

export interface WorkBoardInspection {
  artifactId: string
  revision: number
  column: WorkBoardColumn
  branch?: WorkBoardBranch
  bindingArtifactId?: string
  activity: {
    state: 'ACTIVE' | 'INCONCLUSIVE' | 'UNAVAILABLE'
    source: 'SESSION_CONTEXT'
    observedAt: string
    coverage: WorkBoardCoverage
  }
  reconciliation: {
    coverage: WorkBoardCoverage
    sources: { artifact: WorkBoardArtifact; relation: string; proofIds: string[] }[]
  }
}

export type WorkBoardResult =
  | { success: true; context: WorkBoardContext; page: WorkBoardPage }
  | { success: false; code: 'INVALID_ARGUMENT' | 'PROJECT_CONTEXT_CHANGED' | 'CONTINUUM_UNAVAILABLE' | 'BOARD_CHANGED' }
