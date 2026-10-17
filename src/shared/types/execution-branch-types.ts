export interface ExecutionBranchSnapshot {
  repositoryId: string
  branchRef: string
  branchGeneration: string
  branchRevision: string
  head: string
  worktreeId: string
  worktreeGeneration: string
  fingerprint: string
}
export type ExecutionBindingClass = 'VERIFIED_CURRENT' | 'HISTORICAL' | 'DECLARED_UNVERIFIED' | 'STALE' | 'UNAVAILABLE' | 'AMBIGUOUS'
export interface ExecutionBinding {
  artifactId: string
  executionId: string
  sourceArtifactId: string
  branchRef: string
  branchGeneration: string
  sourceHeadAtBinding: string
  observedAt: string
  classification: ExecutionBindingClass
  checkout: 'CURRENT' | 'HISTORICAL' | 'UNVERIFIED'
}
export interface ExecutionBindingPage {
  repositoryId: string
  branchRef: string
  branchRevision: string
  bindings: ExecutionBinding[]
  coverage: 'COMPLETE' | 'PARTIAL'
  nextCursor?: string
}
export interface ExecutionDocument {
  artifactId: string
  name: string
  kind: string
  status?: string
  updatedAt: string
}
export interface ExecutionDocumentPage {
  repositoryId: string
  executionId: string
  artifacts: ExecutionDocument[]
  nextCursor?: string
}
