export interface WorktreeDocumentRequest {
  worktreeId: string
  generation: string
  mode: 'EXACT' | 'HISTORICAL' | 'RELATED'
  artifactId?: string
  cursor?: string
}
export interface WorktreeDocument {
  artifactId: string
  name: string
  description?: string
  kind: string
  status?: string
  updatedAt: string
  executionId?: string
}
export interface WorktreeDocumentContext {
  repositoryId: string
  worktreeId: string
  generation: string
  mode: WorktreeDocumentRequest['mode']
  queriedAt: string
  artifacts: WorktreeDocument[]
  sourceArtifactId?: string
  relations: Array<{ sourceId: string; targetId: string; kind: string }>
  coverage: 'COMPLETE' | 'PARTIAL'
  nextCursor?: string
}
