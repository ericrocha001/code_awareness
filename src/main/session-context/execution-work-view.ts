import type { CheckpointRegistry } from './checkpoint-registry'
import type { SessionStore } from './store'
import type { ExecutionSelector } from './execution-context'
import { digest } from './privacy'

type Graph = ReturnType<CheckpointRegistry['contextGraph']>
type Edge = Graph['edges'][number]
const workEvidence = new Set([
  'GITHUB_PR_MERGE', 'GITHUB_COMMIT_LIST', 'HANDOFF_DECLARED', 'CONTINUUM_REVISION',
  'CONTINUUM_REVISIONED_RELATION', 'CONTINUUM_TYPED_RELATION', 'OPERATION_EXECUTION_CONTEXT',
  'LEDGER_EVIDENCE_FOR', 'CHECKPOINT_VERIFIED', 'CHECKPOINT_SESSION_METADATA', 'NATIVE_GIT_CAUSAL'
])
const workRelations = new Set(['implements', 'resolved-by', 'validates'])
const usable = (edge: Pick<Edge, 'state'>) => edge.state !== 'STALE' && edge.state !== 'UNKNOWN'
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

function pathsFrom(graph: Graph, root: string, depth: number, allowArtifactMetadata: boolean, includeStale: boolean) {
  const adjacency = new Map<string, Edge[]>()
  const types = new Map(graph.nodes.map(node => [node.key, node.type]))
  for (const edge of [...graph.edges].sort((a, b) => order(a.id, b.id))) {
    if (!workEvidence.has(edge.evidenceKind) || !includeStale && !usable(edge)) continue
    if (edge.evidenceKind === 'CONTINUUM_TYPED_RELATION' && !workRelations.has(edge.relation)) continue
    if (!allowArtifactMetadata && (types.get(edge.from) === 'PROOF' || types.get(edge.to) === 'PROOF')) continue
    for (const key of [edge.from, edge.to]) {
      if (!adjacency.has(key)) adjacency.set(key, [])
      adjacency.get(key)!.push(edge)
    }
  }
  const paths = new Map<string, Edge[]>([[root, []]])
  for (const [key, path] of paths) {
    const kind = types.get(key)
    if (path.length === depth || key !== root && (kind === 'PROOF' || kind === 'SESSION')) continue
    for (const edge of adjacency.get(key) ?? []) {
      const next = edge.from === key ? edge.to : edge.from
      if (!paths.has(next)) paths.set(next, [...path, edge])
    }
  }
  return paths
}

const confidenceRank = { UNKNOWN: 0, DECLARED: 1, DERIVED: 2, OBSERVED: 3, VERIFIED_CAUSAL: 4 }

function workDiagnostics(graph: Graph, root: string, selector: ExecutionSelector, work: {
  role: string; witness: { confidenceClass: Edge['confidenceClass']; state: string }[]
}[], sourceCoverage: readonly { source: string; status: string }[], allowed: boolean, expand: object) {
  const coverageFor = (scope: (source: string) => boolean) => {
    const limited = sourceCoverage.filter(row => scope(row.source) &&
      ['PARTIAL','UNAVAILABLE','UNSUPPORTED','NETWORK_NOT_AUTHORIZED','CONFLICT'].includes(row.status))
    return [...(graph.bounded ? ['GRAPH_LIMIT_REACHED'] : []), ...(!allowed ? ['GATE_REQUIRED'] : []),
      ...limited.flatMap(row => [(row as any).reasonCode ? `${row.source}_${(row as any).reasonCode}` : null, row.source + '_' + row.status].filter(Boolean) as string[])]
  }
  const workCoverage = coverageFor(source => ['CONTINUUM','GITHUB','DELIVERY_GIT','DELIVERY_PR'].includes(source))
  const causalCoverage = coverageFor(source => source.startsWith('NATIVE_') || selector.type === 'PR' && source === 'GITHUB')
  const material = work.filter(item => item.role === 'PLAN' || item.role === 'HANDOFF')
  const usableWork = allowed && material.find(item => item.witness.length && item.witness.every(usable))
  const workLink = usableWork
    ? { state: 'FOUND', weakestLink: usableWork.witness.reduce((current, edge) =>
        confidenceRank[edge.confidenceClass] < confidenceRank[current] ? edge.confidenceClass : current, usableWork.witness[0].confidenceClass) }
    : { state: workCoverage.length || material.length || work.some(item => item.witness.length) ? 'UNRESOLVED' : 'NOT_OBSERVED',
        reason: workCoverage[0] ?? (work.some(item => item.witness.length) ? 'SOURCE_STALE_OR_NOT_INDEXED' : 'NO_INDEXED_EDGE') }

  const appropriate = selector.type === 'COMMIT' || selector.type === 'PR'
  const commits = new Set<string>()
  if (selector.type === 'COMMIT' && graph.nodes.some(node => node.key === root)) commits.add(root)
  if (selector.type === 'PR') for (const edge of graph.edges) {
    if (!usable(edge)) continue
    if (edge.to === root && edge.relation === 'member-of' && edge.evidenceKind === 'GITHUB_COMMIT_LIST') commits.add(edge.from)
    if (edge.from === root && edge.relation === 'merged-as' && edge.evidenceKind === 'GITHUB_PR_MERGE') commits.add(edge.to)
  }
  const native = graph.edges.filter(edge => edge.source === 'NATIVE_GIT' && edge.evidenceKind === 'NATIVE_GIT_CAUSAL' && edge.confidenceClass === 'VERIFIED_CAUSAL')
  const sessionNodes = new Set(graph.nodes.filter(node => node.type === 'SESSION').map(node => node.key))
  const verified = allowed ? native.filter(edge => edge.relation === 'committed' && commits.has(edge.to) &&
    native.some(earlier => earlier.relation === 'invoked' && earlier.to === edge.from && sessionNodes.has(earlier.from) &&
      earlier.evidenceRef === edge.evidenceRef && earlier.sourceRevision === edge.sourceRevision && earlier.digest === edge.digest)) : []
  const edges = new Map(graph.edges.map(edge => [edge.id, edge]))
  const contextual = graph.paths.some(path => sessionNodes.has(path.target) && path.edges.every(id => {
    const edge = edges.get(id)
    return !!edge && usable(edge)
  }))
  if (!appropriate || !commits.size) causalCoverage.push('COMMIT_SCOPE_NOT_OBSERVED')
  const causalSession = verified.length ? { state: 'VERIFIED_CAUSAL', evidenceRefs: [...new Set(verified.map(edge => edge.evidenceRef))].sort().slice(0, 6) }
    : { state: causalCoverage.length ? 'UNRESOLVED' : contextual ? 'CONTEXTUAL_ONLY' : 'NOT_OBSERVED_IN_SNAPSHOT', ...(causalCoverage.length ? { reason: causalCoverage[0] } : {}), nextStep: expand }
  return { workLink, causalSession, relevantCoverage: {
    workLink: { state: workCoverage.length ? 'PARTIAL' : 'SELECTED_SCOPE', reasons: workCoverage },
    causalSession: { state: causalCoverage.length ? 'PARTIAL' : 'SELECTED_SCOPE', reasons: causalCoverage }
  } }
}

export function projectWorkView(store: SessionStore, graph: Graph, root: string, options: {
  selector: ExecutionSelector; mode: string; depth: number; limit: number; cursor?: string
}, pageLimit: number, allowArtifactMetadata: boolean, accountHash: string | undefined, indexRevision: string, sourceCoverage: readonly { source: string; status: string }[]) {
  const currentPaths = pathsFrom(graph, root, options.depth, allowArtifactMetadata, false)
  const allPaths = pathsFrom(graph, root, options.depth, allowArtifactMetadata, true)
  const grouped = new Map<string, Edge[][]>()
  for (const node of graph.nodes) {
    if (node.type !== 'ARTIFACT') continue
    const path = currentPaths.get(node.key) ?? allPaths.get(node.key)
    if (!path) continue
    if (!grouped.has(node.id)) grouped.set(node.id, [])
    grouped.get(node.id)!.push(path)
  }
  const work = [...grouped].sort(([a], [b]) => order(a,b)).map(([artifactId, candidates]) => {
    const path = candidates.sort((a, b) => Number(!a.every(usable)) - Number(!b.every(usable)) || a.length - b.length ||
      order(a.map(edge => edge.id).join(':'), b.map(edge => edge.id).join(':')))[0]
    const { title, artifactKind, status, artifactRevision: currentRevision, metadataCoverage, metadataFreshness } =
      store.registry.artifactLabel(artifactId, allowArtifactMetadata)
    const role = artifactKind === 'EXECUTABLE_PLAN' ? 'PLAN' : artifactKind === 'IMPLEMENTATION_HANDOFF' ? 'HANDOFF' : 'OTHER'
    const witness = path.map(({ from, to, evidenceKind, evidenceRef, confidenceClass, state, freshness, sourceRevision }) =>
      ({ from, to, evidenceKind, evidenceRef, confidenceClass, state, freshness, sourceRevision }))
    return { artifactId, title, artifactKind, status, currentRevision, metadataCoverage, metadataFreshness, role, witness, historicalWitnessCount: candidates.length - 1 }
  })
  const related = Object.fromEntries((['COMMIT','PR','PROOF','SESSION'] as const).map(kind => {
    const nodes = graph.nodes.filter(node => node.type === kind && allPaths.has(node.key) && (allowArtifactMetadata || kind !== 'PROOF'))
    return [kind, [...new Map(nodes.sort((a, b) => order(a.key,b.key)).map(node =>
      [node.key, node.selector])).values()].slice(0, 6)]
  }))
  const expand = { tool: 'discover_execution_context', arguments: { selector: options.selector, view: 'GRAPH', depth: 1 } }
  const diagnostics = workDiagnostics(graph, root, options.selector, work, sourceCoverage, allowArtifactMetadata, expand)
  const revision = digest(JSON.stringify([indexRevision, work, related, diagnostics]))
  const scope = { name: 'discover_execution_context', repositoryId: store.repositoryId, selector: options.selector, view: 'WORK', mode: options.mode, depth: options.depth, limit: options.limit, revision, accountHash, allowArtifactMetadata }
  const offset = store.offset(options.cursor, scope)
  if (offset > work.length) throw new Error('CURSOR_STALE')
  const page = work.slice(offset, offset + pageLimit)
  return { revision, work: page, related, graphBounded: graph.bounded,
    expand, ...diagnostics,
    ...(offset + page.length < work.length ? { nextCursor: store.cursor(scope, offset + page.length) } : {}) }
}
