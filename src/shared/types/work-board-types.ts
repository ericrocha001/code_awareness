import type { OrchestrationContext } from './work-orchestration-types'

export type WorkBoardSelection =
  | { perspective: 'WORK'; column: 'PENDING' | 'COMPLETED' }
  | { perspective: 'IDEAS'; column: 'NOT_IMPLEMENTED' | 'IMPLEMENTED' }
export type WorkBoardColumn = WorkBoardSelection['column']
export type WorkBoardCoverage = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE'
export interface WorkBoardContext extends OrchestrationContext { repositoryId: string }

export type WorkBoardRequest = WorkBoardSelection & {
  context: WorkBoardContext
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
  perspective: WorkBoardSelection['perspective']
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
