import { z } from 'zod'
import type { RegistryEntity } from './checkpoint-registry'
import type { SessionStore } from './store'
import { digest } from './privacy'
import { sessionIdentity } from './session-identity'

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
export const executionSelector = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PR'), id: z.string().regex(/^[1-9][0-9]{0,9}$/) }).strict(),
  z.object({ type: z.literal('COMMIT'), id: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  z.object({ type: z.literal('CHECKPOINT'), id: z.string().regex(/^(?:[a-f0-9]{10,40}|[0-9A-HJKMNP-TV-Z]{26})$/) }).strict(),
  z.object({ type: z.literal('SESSION'), id: identifier, provider: z.enum(['entire', 'codex']).optional(), agent: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/).optional() }).strict(),
  z.object({ type: z.literal('ARTIFACT'), id: z.string().regex(/^artifact-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/) }).strict(),
  z.object({ type: z.literal('PROOF'), id: z.string().regex(/^proof-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/) }).strict(),
  z.object({ type: z.literal('EXECUTION'), id: identifier }).strict()
]).refine(selector => selector.type !== 'SESSION' || !!selector.provider || z.string().uuid().safeParse(selector.id).success)
export const executionContextQuery = z.object({ selector: executionSelector, mode: z.enum(['MAP', 'RELATION_DETAIL']).default('MAP'),
  limit: z.number().int().min(1).max(24).default(20), cursor: z.string().max(512).optional() }).strict()
export type ExecutionSelector = z.infer<typeof executionSelector>
export const EXECUTION_SELECTOR_SCHEMA = { type: 'object', properties: { type: { type: 'string', enum: ['PR', 'COMMIT', 'CHECKPOINT', 'SESSION', 'ARTIFACT', 'PROOF', 'EXECUTION'] }, id: { type: 'string', minLength: 1, maxLength: 200 }, provider: { type: 'string', enum: ['entire', 'codex'] }, agent: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,79}$' } }, required: ['type', 'id'], additionalProperties: false }
export function executionEntity(store: SessionStore, selector: ExecutionSelector, accountHash?: string): RegistryEntity | undefined {
  if (selector.type !== 'SESSION') return { kind: selector.type, id: selector.id }
  const entity = selector.provider ? { kind: 'SESSION' as const, id: sessionIdentity(selector.provider, selector.id, selector.agent) } : store.registry.sessionIdentity(selector.id)
  return entity && store.registry.visible(entity, accountHash) ? entity : undefined
}
export function discoverExecutionContext(store: SessionStore, query: z.infer<typeof executionContextQuery>, accountHash?: string, pageLimit = query.limit) {
  return store.registry.readSnapshot(() => contextSnapshot(store, query, accountHash, pageLimit))
}
function contextSnapshot(store: SessionStore, query: z.infer<typeof executionContextQuery>, accountHash: string | undefined, pageLimit: number) {
  const selector = executionEntity(store, query.selector, accountHash)
  const graph = selector ? store.registry.contextGraph(selector, accountHash) : { nodes: [], edges: [], paths: [], bounded: false }
  const sourceCoverage = store.registry.sources().filter(s => !s.source.includes(':')).map(s => ({ source: s.source, status: s.status, observedAt: s.observedAt }))
  const revision = digest(JSON.stringify([graph, sourceCoverage]))
  const scope = { name: 'discover_execution_context', repositoryId: store.repositoryId, selector: query.selector, mode: query.mode, limit: query.limit, revision, accountHash }
  const offset = store.offset(query.cursor, scope)
  if (offset > graph.edges.length) throw new Error('CURSOR_STALE')
  const edges = graph.edges.slice(offset, offset + pageLimit)
  const selectedNodes = new Set(edges.flatMap(edge => [edge.from, edge.to]))
  if (selector) selectedNodes.add(store.registry.key(selector))
  const nodes = graph.nodes.filter(node => selectedNodes.has(node.key))
  const more = offset + edges.length < graph.edges.length
  const result = { repositoryId: store.repositoryId, selector: query.selector, revision, mode: query.mode,
    state: graph.nodes.length ? 'INDEX_SNAPSHOT' : 'RECONCILIATION_PENDING', partial: more || graph.bounded,
    counts: Object.fromEntries(['PR', 'COMMIT', 'CHECKPOINT', 'SESSION', 'ARTIFACT', 'PROOF', 'EXECUTION'].map(type => [type, graph.nodes.filter(node => node.type === type).length])), countsCoverage: graph.bounded ? 'BOUNDED' : 'OBSERVED_INDEX',
    nodes, edges: edges.map(edge => query.mode === 'RELATION_DETAIL' ? edge : { id: edge.id, from: edge.from, to: edge.to, relation: edge.relation, state: edge.state, evidenceKind: edge.evidenceKind, source: edge.source, freshness: edge.freshness }),
    paths: graph.paths.filter(path => path.edges.every(id => edges.some(edge => edge.id === id))), sourceCoverage,
    captureCoverage: graph.nodes.some(node => node.type === 'CHECKPOINT') ? 'CHECKPOINT_OBSERVED' : 'CHECKPOINT_NOT_OBSERVED',
    freshness: 'LAST_KNOWN_NOT_RECHECKED', authorship: 'NOT_INFERRED',
    reconciliation: { state: 'EXPLICIT_REFRESH_AVAILABLE', tool: 'refresh_agent_sessions', arguments: { contextSelector: query.selector } },
    ...(more ? { nextCursor: store.cursor(scope, offset + edges.length) } : {}),
    ...(graph.bounded ? { continuation: 'Select a node and query its exact selector to continue within four hops.' } : {}) }
  return result
}
