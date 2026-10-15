import type { ArtifactDiscoveryRecord, ArtifactMetadata, ListArtifactsFilter, ArtifactPage } from '../continuum/continuum-types'
import type { ContinuumGraph, ContinuumGraphQuery } from '../../shared/types/continuum-graph-types'
import type { WorktreeDocument, WorktreeDocumentContext, WorktreeDocumentRequest } from '../../shared/types/worktree-document-context-types'

export interface OrchestrationContinuumReader {
  repositoryId: string
  isCurrent(): boolean
  list(filter: ListArtifactsFilter): ArtifactPage
  declaration(artifactId: string): ArtifactMetadata | null
  graph(query: ContinuumGraphQuery): ContinuumGraph
}
export interface WorktreeIdentityReader {
  getCoordinationIdentity(worktreeId: string): Promise<{ repositoryId: string; record: { worktreeId: string; generation: string; path: string } }>
}
const project = (record: ArtifactDiscoveryRecord): WorktreeDocument => ({ artifactId: record.artifactId, name: record.name,
  description: record.description, kind: record.kind, status: record.status, updatedAt: record.updatedAt,
  ...(typeof record.metadata?.executionId === 'string' ? { executionId: record.metadata.executionId } : {}) })

export async function readWorktreeDocumentContext(git: WorktreeIdentityReader, continuum: OrchestrationContinuumReader | undefined,
  request: WorktreeDocumentRequest): Promise<WorktreeDocumentContext> {
  if (!continuum || !continuum.isCurrent()) throw new Error('CONTINUUM_UNAVAILABLE')
  const before = await git.getCoordinationIdentity(request.worktreeId)
  const check = (identity: typeof before) => {
    if (!continuum.isCurrent() || identity.repositoryId !== continuum.repositoryId) throw new Error('REPOSITORY_CONTEXT_CHANGED')
    if (identity.record.worktreeId !== request.worktreeId || identity.record.generation !== request.generation) throw new Error('WORKTREE_STALE')
  }
  check(before)
  const exact = { worktreeId: request.worktreeId, worktreeGeneration: request.generation }
  const base: WorktreeDocumentContext = { repositoryId: before.repositoryId, worktreeId: request.worktreeId, generation: request.generation,
    mode: request.mode, queriedAt: '', artifacts: [], relations: [], coverage: 'COMPLETE' }
  if (request.mode === 'RELATED') {
    const metadata = continuum.declaration(request.artifactId!)
    if (!metadata || metadata.worktreeId !== request.worktreeId || metadata.worktreeGeneration !== request.generation) throw new Error('DOCUMENT_ASSOCIATION_CHANGED')
    const graph = continuum.graph({ artifactIds: [request.artifactId!], expand: true, direction: 'both', nodeLimit: 21, edgeLimit: 30 })
    if (graph.repositoryId !== before.repositoryId) throw new Error('REPOSITORY_CONTEXT_CHANGED')
    const edges = graph.edges.filter(edge => edge.nature === 'DECLARED' && edge.origin === 'metadata.relations' &&
      (edge.sourceId === request.artifactId || edge.targetId === request.artifactId))
    const relatedIds = new Set(edges.flatMap(edge => [edge.sourceId, edge.targetId]).filter(id => id !== request.artifactId))
    base.artifacts = graph.nodes.filter(node => relatedIds.has(node.artifactId) && ['EXECUTABLE_PLAN', 'IMPLEMENTATION_HANDOFF', 'WORK_ITEM'].includes(node.kind)).map(project)
    const shown = new Set(base.artifacts.map(artifact => artifact.artifactId))
    base.relations = edges.filter(edge => shown.has(edge.sourceId) || shown.has(edge.targetId)).map(({ sourceId, targetId, kind }) => ({ sourceId, targetId, kind }))
    base.sourceArtifactId = request.artifactId
    base.coverage = graph.truncated.nodes || graph.truncated.edges || graph.freshness !== 'CURRENT' ? 'PARTIAL' : 'COMPLETE'
  } else {
    const page = continuum.list({ metadata: request.mode === 'EXACT' ? exact : { worktreePath: before.record.path },
      metadataKeys: ['worktreeId', 'worktreeGeneration', 'executionId'], limit: 10, ...(request.cursor ? { cursor: request.cursor } : {}) })
    base.artifacts = page.artifacts.filter(record => request.mode === 'EXACT' ? record.metadata?.worktreeId === request.worktreeId && record.metadata?.worktreeGeneration === request.generation :
      record.metadata?.worktreeId === undefined && record.metadata?.worktreeGeneration === undefined).map(project)
    if (request.mode === 'EXACT' && base.artifacts.length !== page.artifacts.length) throw new Error('DOCUMENT_ASSOCIATION_CHANGED')
    base.nextCursor = page.nextCursor
    base.coverage = page.nextCursor ? 'PARTIAL' : 'COMPLETE'
  }
  base.artifacts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.artifactId.localeCompare(a.artifactId))
  check(await git.getCoordinationIdentity(request.worktreeId))
  base.queriedAt = new Date().toISOString()
  return base
}
