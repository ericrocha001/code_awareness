import { z } from 'zod'
import type { ContinuumService } from '../continuum/continuum-service'
import type { ContinuumGraph } from '../../shared/types/continuum-graph-types'
import type { WorkBoardArtifact, WorkBoardCard, WorkBoardPage, WorkBoardRequest } from '../../shared/types/work-board-types'

const identifier = z.string().min(1).max(256)
const revision = z.number().int().nonnegative().safe()
export const workBoardRequest = z.object({
  context: z.object({ repositoryId: identifier, projectId: identifier, revision }).strict(),
  column: z.enum(['QUEUED', 'ACTIVE', 'COMPLETED']),
  cursor: z.string().min(1).max(2048).optional(),
  inspect: z.object({ artifactId: identifier, revision: revision.positive() }).strict().optional()
}).strict()
const pageCursor = workBoardRequest.omit({ cursor: true, inspect: true }).extend({ documentaryRevision: revision, position: z.string().min(1).max(1024) })
const kinds = ['EXECUTABLE_PLAN', 'WORK_ITEM']
export type WorkBoardContinuum = Pick<ContinuumService, 'repositoryId' | 'listIndexedArtifacts' | 'readIndexedGraph'>

const complete = (graph: ContinuumGraph) => graph.freshness === 'CURRENT' && !graph.truncated.edges && !graph.truncated.nodes
const declared = (graph: ContinuumGraph) => graph.edges.filter(edge => edge.nature === 'DECLARED' && edge.origin === 'metadata.relations')

function projectCards(artifacts: WorkBoardArtifact[], relationships: ContinuumGraph, scope: ContinuumGraph): WorkBoardCard[] {
  const nodes = new Map([...relationships.nodes, ...scope.nodes].map(node => [node.artifactId, node]))
  const edges = declared(relationships)
  const details = declared(scope).filter(edge => edge.kind === 'derived-from' &&
    nodes.get(edge.sourceId)?.kind === 'EXECUTABLE_PLAN' && nodes.get(edge.targetId)?.kind === 'WORK_ITEM')
  const plansByItem = new Map<string, string[]>()
  const itemsByPlan = new Map<string, string[]>()
  for (const { sourceId, targetId } of details) {
    plansByItem.set(targetId, [...(plansByItem.get(targetId) ?? []), sourceId])
    itemsByPlan.set(sourceId, [...(itemsByPlan.get(sourceId) ?? []), targetId])
  }
  const scopeComplete = complete(scope)
  return artifacts.flatMap(artifact => {
    const id = artifact.artifactId
    const isPlan = artifact.kind === 'EXECUTABLE_PLAN'
    const counterparts = (isPlan ? itemsByPlan : plansByItem).get(id) ?? []
    const counterpart = counterparts.length === 1 ? nodes.get(counterparts[0]) : undefined
    const reverse = counterpart && (isPlan ? plansByItem : itemsByPlan).get(counterpart.artifactId)
    const paired = scopeComplete && counterpart && reverse?.length === 1 && counterpart.status === artifact.status
    if (!isPlan && paired) return []
    const relations = edges.flatMap(edge => {
      const inbound = edge.targetId === id
      if (!inbound && edge.sourceId !== id) return []
      const related = nodes.get(inbound ? edge.sourceId : edge.targetId)
      return related ? [{ artifact: related, kind: edge.kind, direction: inbound ? 'INBOUND' as const : 'OUTBOUND' as const }] : []
    })
    return [{ artifact, ...(isPlan && paired ? { workItem: counterpart } : {}), relations,
      relationCoverage: scopeComplete && complete(relationships) ? 'COMPLETE' as const : 'PARTIAL' as const,
      ambiguous: counterparts.length > 1 || (reverse?.length ?? 0) > 1 }]
  })
}

export function readWorkBoard(continuum: WorkBoardContinuum, request: WorkBoardRequest): WorkBoardPage {
  const { context, column, cursor } = request
  if (continuum.repositoryId !== context.repositoryId) throw new Error('PROJECT_CONTEXT_CHANGED')
  const snapshot = continuum.readIndexedGraph({ artifactIds: [] })
  if (snapshot.repositoryId !== context.repositoryId) throw new Error('PROJECT_CONTEXT_CHANGED')
  const graphRevision = snapshot.revision
  let position: string | undefined
  if (cursor) {
    let decoded: z.infer<typeof pageCursor>
    try { decoded = pageCursor.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))) }
    catch { throw new Error('INVALID_ARGUMENT') }
    if (decoded.column !== column || decoded.context.repositoryId !== context.repositoryId ||
      decoded.context.projectId !== context.projectId || decoded.context.revision !== context.revision) throw new Error('INVALID_ARGUMENT')
    if (decoded.documentaryRevision !== graphRevision) throw new Error('BOARD_CHANGED')
    position = decoded.position
  }
  const page: WorkBoardPage = { column, documentaryRevision: graphRevision, queriedAt: new Date().toISOString(),
    cards: [], coverage: column === 'ACTIVE' ? 'UNAVAILABLE' : 'COMPLETE' }
  if (column === 'ACTIVE' || request.inspect) return page
  const candidates = continuum.listIndexedArtifacts({
    status: column === 'COMPLETED' ? 'COMPLETED' : 'PENDING', limit: 20, cursor: position
  }, kinds)
  const artifacts = candidates.artifacts.map(record => ({ artifactId: record.artifactId, revision: record.revision!,
    name: record.name, description: record.description, kind: record.kind, status: record.status, updatedAt: record.updatedAt }))
  const ids = artifacts.map(artifact => artifact.artifactId)
  if (ids.length) {
    const graph = (artifactIds: string[], relationKind?: string) => continuum.readIndexedGraph({
      artifactIds, relationKind, expand: true, nodeLimit: 100, edgeLimit: 200, expectedRevision: graphRevision
    })
    const relationships = graph(ids)
    const firstHop = graph(ids, 'derived-from')
    const endpoints = firstHop.nodes.filter(node => kinds.includes(node.kind)).map(node => node.artifactId)
    const scope = graph(endpoints, 'derived-from')
    if (relationships.repositoryId !== context.repositoryId || scope.repositoryId !== context.repositoryId || firstHop.repositoryId !== context.repositoryId)
      throw new Error('PROJECT_CONTEXT_CHANGED')
    if (!complete(firstHop)) scope.truncated.nodes = true
    page.cards = projectCards(artifacts, relationships, scope)
    if (!complete(scope) || !complete(relationships)) page.coverage = 'PARTIAL'
  }
  if (candidates.nextCursor) {
    page.nextCursor = Buffer.from(JSON.stringify({ context, column, documentaryRevision: graphRevision, position: candidates.nextCursor })).toString('base64url')
    page.coverage = 'PARTIAL'
  }
  return page
}
