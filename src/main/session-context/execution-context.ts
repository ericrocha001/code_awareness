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
  z.object({ type: z.literal('SESSION'), id: identifier, provider: z.enum(['entire', 'codex', 'codex-native']).optional(), agent: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/).optional() }).strict(),
  z.object({ type: z.literal('ARTIFACT'), id: z.string().regex(/^artifact-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/), revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional() }).strict(),
  z.object({ type: z.literal('PROOF'), id: z.string().regex(/^proof-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/) }).strict(),
  z.object({ type: z.literal('EXECUTION'), id: identifier }).strict(),
  z.object({ type: z.literal('INVOCATION'), id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ type: z.literal('WORKTREE'), id: z.string().regex(/^[a-f0-9]{64}$/), generation: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
]).refine(selector => selector.type !== 'SESSION' || !!selector.provider || z.string().uuid().safeParse(selector.id).success)
export const executionContextQuery = z.object({ selector: executionSelector, mode: z.enum(['MAP', 'RELATION_DETAIL']).default('MAP'),
  depth: z.number().int().min(1).max(4).default(4),
  limit: z.number().int().min(1).max(24).default(20), cursor: z.string().max(512).optional() }).strict()
export type ExecutionSelector = z.infer<typeof executionSelector>
export const EXECUTION_SELECTOR_SCHEMA = { type: 'object', properties: { generation: { type: 'string', pattern: '^[a-f0-9]{64}$' }, revision: { type: 'integer', minimum: 1, description: 'Exact Artifact revision when selecting publication provenance.' }, type: { type: 'string', enum: ['PR', 'COMMIT', 'CHECKPOINT', 'SESSION', 'ARTIFACT', 'PROOF', 'EXECUTION', 'INVOCATION', 'WORKTREE'] }, id: { type: 'string', minLength: 1, maxLength: 200 }, provider: { type: 'string', enum: ['entire', 'codex', 'codex-native'] }, agent: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,79}$' } }, required: ['type', 'id'], additionalProperties: false }
export function executionEntity(store: SessionStore, selector: ExecutionSelector, accountHash?: string): RegistryEntity | undefined {
  if (selector.type === 'INVOCATION') return { kind: 'EXECUTION', id: 'native-invocation:' + selector.id }
  if (selector.type === 'WORKTREE') return { kind: 'WORKTREE', id: selector.id + ':' + selector.generation }
  if (selector.type !== 'SESSION') return { kind: selector.type, id: selector.type === 'ARTIFACT' && selector.revision ? selector.id + ':' + selector.revision : selector.id }
  const entity = selector.provider ? { kind: 'SESSION' as const, id: sessionIdentity(selector.provider, selector.id, selector.agent) } : store.registry.sessionIdentity(selector.id)
  return entity && store.registry.visible(entity, accountHash) ? entity : undefined
}
export function discoverExecutionContext(store: SessionStore, query: z.infer<typeof executionContextQuery>, accountHash?: string, pageLimit = query.limit) {
  return store.registry.readSnapshot(() => contextSnapshot(store, query, accountHash, pageLimit))
}
function contextSnapshot(store: SessionStore, query: z.infer<typeof executionContextQuery>, accountHash: string | undefined, pageLimit: number) {
  const selector = executionEntity(store, query.selector, accountHash)
  const graph = selector ? store.registry.contextGraph(selector, accountHash, query.depth) : { nodes: [], edges: [], paths: [], bounded: false }
  const sourceCoverage = store.registry.coverageSources().map(s => {
    let diagnostic: { reasonCode?: string; stage?: string } = {}
    try { diagnostic = JSON.parse(store.registry.source(s.source + ':DIAGNOSTIC')?.cursor ?? '{}') } catch {}
    return { source: s.source, status: s.status, observedAt: s.observedAt,
      ...(typeof diagnostic.reasonCode === 'string' && /^[A-Z_]{1,80}$/.test(diagnostic.reasonCode) ? { reasonCode: diagnostic.reasonCode } : {}),
      ...(typeof diagnostic.stage === 'string' && /^[A-Z_]{1,80}$/.test(diagnostic.stage) ? { stage: diagnostic.stage } : {}) }
  })
  const reasons = new Set<string>()
  if (graph.bounded) reasons.add('GRAPH_LIMIT_REACHED')
  for (const source of sourceCoverage) if (['PARTIAL','UNAVAILABLE','UNSUPPORTED','NETWORK_NOT_AUTHORIZED'].includes(source.status)) reasons.add(source.source + '_' + source.status)
  for (const node of graph.nodes) if (node.type === 'WORKTREE' && node.generation) {
    try {
      const capture = JSON.parse(store.registry.source(`NATIVE_CAPTURE:${node.id}:${node.generation}`)?.cursor ?? '{}')
      if (capture.historicalCoverage?.state === 'PARTIAL') reasons.add('NATIVE_CAPTURE_HISTORICALLY_PARTIAL')
    } catch { reasons.add('NATIVE_CAPTURE_COVERAGE_UNAVAILABLE') }
  }
  const observedRelations = graph.edges.some(edge => edge.evidenceKind !== 'CONTINUUM_REVISION')
  if (!observedRelations) reasons.add('PROVENANCE_NOT_OBSERVED')
  const coverage = { state: reasons.size ? observedRelations ? 'PARTIAL' : 'UNKNOWN' : 'SELECTED_SCOPE', reasons: [...reasons].sort(), negativeInference: 'NOT_AUTHORIZED' }
  const revision = digest(JSON.stringify([graph, sourceCoverage.map(({ observedAt: _observedAt, ...source }) => source), coverage]))
  const scope = { name: 'discover_execution_context', repositoryId: store.repositoryId, selector: query.selector, mode: query.mode, depth: query.depth, limit: query.limit, revision, accountHash }
  const offset = store.offset(query.cursor, scope)
  if (offset > graph.edges.length) throw new Error('CURSOR_STALE')
  const edges = graph.edges.slice(offset, offset + pageLimit)
  const selectedNodes = new Set(edges.flatMap(edge => [edge.from, edge.to]))
  if (selector) selectedNodes.add(store.registry.key(selector))
  const nodes = graph.nodes.filter(node => selectedNodes.has(node.key))
  const more = offset + edges.length < graph.edges.length
  const deliveryLinks = graph.paths.map(path => path.edges.map(id => graph.edges.find(edge => edge.id === id)!))
  const isUsable = (link: (typeof graph.edges)[number]) => link.state !== 'STALE' && link.state !== 'UNKNOWN'
  const mixesDeclaredExecution = (links: typeof graph.edges) => links.some(link => link.evidenceKind === 'EXECUTION_MEMBERSHIP') &&
    links.some(link => link.evidenceKind === 'OPERATION_EXECUTION_CONTEXT')
  const documented = deliveryLinks.some(links => links.every(isUsable) && !mixesDeclaredExecution(links) && (
    links.some(link => link.evidenceKind === 'CONTINUUM_REVISIONED_RELATION') &&
    links.some(link => link.evidenceKind === 'OPERATION_EXECUTION_CONTEXT' && link.relation === 'delivery-context') ||
    links.some(link => link.evidenceKind === 'HANDOFF_DECLARED' && (link.to.startsWith('PR:') || link.to.startsWith('COMMIT:') && links.some(member => member.evidenceKind === 'GITHUB_COMMIT_LIST')))
  ))
  const branchContextOnly = graph.edges.some(link => link.evidenceKind === 'BRANCH_CONTEXT_ONLY' && isUsable(link))
  const result = { repositoryId: store.repositoryId, selector: query.selector, revision, mode: query.mode,
    state: graph.nodes.length ? 'INDEX_SNAPSHOT' : 'RECONCILIATION_PENDING', partial: more || graph.bounded || coverage.state === 'PARTIAL', coverage,
    counts: Object.fromEntries(['PR', 'COMMIT', 'CHECKPOINT', 'SESSION', 'ARTIFACT', 'PROOF', 'EXECUTION', 'WORKTREE'].map(type => [type, graph.nodes.filter(node => node.type === type).length])), countsCoverage: graph.bounded ? 'BOUNDED' : 'OBSERVED_INDEX',
    nodes, edges: edges.map(edge => query.mode === 'RELATION_DETAIL' ? edge : { id: edge.id, from: edge.from, to: edge.to, relation: edge.relation, state: edge.state, evidenceKind: edge.evidenceKind, source: edge.source, freshness: edge.freshness, confidenceClass: edge.confidenceClass, coverage: edge.coverage, revision: edge.revision, revisionScope: edge.revisionScope, evidenceRef: edge.evidenceRef }),
    paths: graph.paths.filter(path => edges.some(edge => edge.id === path.edges.at(-1))).map(path => {
      const links = path.edges.map(id => graph.edges.find(edge => edge.id === id)!)
      const first = links[0]
      const causal = links.length && links.every(edge => edge.confidenceClass === 'VERIFIED_CAUSAL' && edge.evidenceKind === first.evidenceKind && edge.evidenceRef === first.evidenceRef && edge.sourceRevision === first.sourceRevision)
      const rank = { UNKNOWN: 0, DECLARED: 1, DERIVED: 2, OBSERVED: 3, VERIFIED_CAUSAL: 4 }
      const weakest = links.reduce((current, edge) => rank[edge.confidenceClass] < rank[current] ? edge.confidenceClass : current, first.confidenceClass)
      return { ...path, ...(query.mode === 'RELATION_DETAIL' ? { evidenceClass: links.length > 1 ? 'DERIVED' : first.confidenceClass, weakestLink: weakest,
        links: links.map(edge => ({ id: edge.id, evidenceKind: edge.evidenceKind, evidenceRef: edge.evidenceRef, source: edge.source, sourceRevision: edge.sourceRevision, freshness: edge.freshness, confidenceClass: edge.confidenceClass, state: edge.state })),
        resolution: weakest === 'UNKNOWN' || !links.every(isUsable) || mixesDeclaredExecution(links) ? 'UNRESOLVED' : links.some(edge => edge.evidenceKind === 'BRANCH_CONTEXT_ONLY') ? 'BRANCH_CONTEXT_ONLY' : 'EVIDENCE_PATH' } : {}), confidenceClass: causal ? 'VERIFIED_CAUSAL' : links.length === 1 ? first.confidenceClass : 'CONTEXTUAL', meaning: causal ? 'SAME_OPERATION_EVIDENCE' : 'EXECUTION_CONTEXT_NOT_IMPLEMENTATION_PROOF' }
    }), sourceCoverage,
    ...(query.mode === 'RELATION_DETAIL' ? { delivery: { state: documented ? 'DOCUMENTED' : branchContextOnly ? 'BRANCH_CONTEXT_ONLY' : 'UNRESOLVED', coverage: documented ? coverage.state : 'PARTIAL' } } : {}),
    captureCoverage: graph.nodes.some(node => node.type === 'CHECKPOINT') ? 'CHECKPOINT_OBSERVED' : 'CHECKPOINT_NOT_OBSERVED',
    freshness: 'LAST_KNOWN_NOT_RECHECKED', authorship: 'NOT_INFERRED',
    reconciliation: { backlog: store.registry.reconciliationBacklog(), state: 'EXPLICIT_REFRESH_AVAILABLE', tool: 'refresh_agent_sessions', arguments: { contextSelector: query.selector } },
    ...(more ? { nextCursor: store.cursor(scope, offset + edges.length) } : {}),
    discovery: { depth: query.depth, nextStep: 'SELECT_NEIGHBOR', suggestions: 'SEPARATE_FROM_CONFIRMED_EDGES' },
    ...(graph.bounded ? { continuation: 'Select a node with depth=1 for its bounded immediate neighborhood.' } : {}) }
  return result
}
