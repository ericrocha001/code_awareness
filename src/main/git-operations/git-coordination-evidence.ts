export interface CoordinationHistory {
  repositoryId?: string
  referenceHead: string
  head: string
  base: string
  relation: 'HEAD_INCLUDED' | 'EXCLUSIVE_COMMITS'
  provenance: 'EXACT_MERGE_BASE'
}

export interface CoordinationReference {
  repositoryId: string
  worktreeId: string
  generation: string
  head: string
}

export interface WorklineObservedState {
  repositoryId: string | null
  generation: string
  head: string
  localRevision: string
  clean: boolean
  stable: boolean
  changed: boolean
  history: (CoordinationHistory & { reference: CoordinationReference; observedAt: string }) | null
}
