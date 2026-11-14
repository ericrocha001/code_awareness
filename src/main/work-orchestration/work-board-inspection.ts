import type { ContinuumService } from '../continuum/continuum-service'
import type { SessionContextClient } from '../session-context/client'
import type { SessionAssociation } from '../session-context/associations'
import type { GitOperationsService } from '../git-operations/git-operations-service'
import type { ValidationProof } from '../validation-ledger/validation-ledger-types'
import type { WorkBoardInspection, WorkBoardRequest } from '../../shared/types/work-board-types'
import type { ExecutionBranchSnapshot } from '../../shared/types/execution-branch-types'

type Continuum = Pick<ContinuumService, 'repositoryId' | 'indexedArtifact' | 'listIndexedArtifacts' | 'readIndexedGraph'>
export interface WorkBoardInspectionSources {
  git?: Pick<GitOperationsService, 'deliverySnapshot'>
  sessions?: Pick<SessionContextClient, 'readWorkAssociations' | 'call'>
  ledger: { getProof(id: string): Pick<ValidationProof, 'status' | 'evidenceFor'> | null }
}

export function currentSession(value: unknown, providerSessionId: string, now: number): boolean {
  if (!value || typeof value !== 'object') return false
  const observation = value as Record<string, unknown>
  const lastActive = typeof observation.lastActive === 'string' ? Date.parse(observation.lastActive) : NaN
  return observation.source === 'ENTIRE_LIVE' && observation.providerSessionId === providerSessionId &&
    observation.state === 'ACTIVE' && !observation.endedAt && lastActive <= now && now - lastActive <= 300_000
}

export async function inspectWorkBoard(continuum: Continuum, sources: WorkBoardInspectionSources, request: WorkBoardRequest,
  assertCurrent: () => void): Promise<WorkBoardInspection> {
  const { artifactId, revision } = request.inspect!
  const selected = continuum.indexedArtifact(artifactId)
  if (!selected || selected.revision !== revision || !['WORK_ITEM', 'EXECUTABLE_PLAN'].includes(selected.metadata.kind) ||
    request.perspective !== 'WORK' || selected.metadata.status !== request.column) throw new Error('BOARD_CHANGED')
  const pending = selected.metadata.status === 'PENDING'
  const result: WorkBoardInspection = { artifactId, revision,
    activity: { state: 'INCONCLUSIVE', source: 'SESSION_CONTEXT', observedAt: new Date().toISOString(), coverage: 'PARTIAL' },
    reconciliation: { coverage: 'PARTIAL', sources: [] } }
  const graph = continuum.readIndexedGraph({ artifactIds: [artifactId], expand: true, nodeLimit: 30, edgeLimit: 60 })
  const handoffs = new Map(graph.nodes.filter(node => node.kind === 'IMPLEMENTATION_HANDOFF' && node.status === 'VALIDATED').map(node => [node.artifactId, node]))
  try {
    for (const edge of graph.edges) {
      if (edge.nature !== 'DECLARED' || edge.origin !== 'metadata.relations') continue
      const id = edge.kind === 'implements' && edge.targetId === artifactId ? edge.sourceId
        : edge.kind === 'resolved-by' && edge.sourceId === artifactId ? edge.targetId : undefined
      const handoff = id ? handoffs.get(id) : undefined
      if (!handoff) continue
      const metadata = continuum.indexedArtifact(handoff.artifactId)?.metadata
      const proofIds = Array.isArray(metadata?.proofIds) ? metadata.proofIds.slice(0, 10) : []
      const confirmed = proofIds.flatMap(proofId => {
        if (typeof proofId !== 'string') return []
        const proof = sources.ledger.getProof(proofId)
        return proof?.status === 'PASSED' && proof.evidenceFor.some(id => id === handoff.artifactId || id === artifactId) ? [proofId] : []
      })
      if (confirmed.length) result.reconciliation.sources.push({ artifact: handoff, relation: edge.kind, proofIds: confirmed })
    }
  } catch {
    result.reconciliation.coverage = result.reconciliation.sources.length ? 'PARTIAL' : 'UNAVAILABLE'
  }
  const executionId = selected.metadata.executionId
  if (typeof executionId !== 'string' || !executionId) return result
  try {
    const bindings = continuum.listIndexedArtifacts({ metadata: { bindingRole: 'EXECUTION_BRANCH', executionId, sourceArtifactId: artifactId },
      limit: 8 }, ['OBSERVATION'])
    if (bindings.nextCursor) return result
    const match = async () => {
      const current: { artifactId: string; snapshot: ExecutionBranchSnapshot }[] = []
      for (const binding of bindings.artifacts) {
        const record = continuum.indexedArtifact(binding.artifactId)
        if (!record || record.provenance.executionBranchBinding !== true || record.metadata.repositoryId !== continuum.repositoryId ||
          typeof record.metadata.worktreeId !== 'string') continue
        result.bindingArtifactId ??= binding.artifactId
        if (!sources.git) continue
        const observed = await sources.git.deliverySnapshot(record.metadata.worktreeId).catch(() => undefined)
        assertCurrent()
        if (observed && observed.repositoryId === continuum.repositoryId && observed.worktreeId === record.metadata.worktreeId &&
          observed.worktreeGeneration === record.metadata.worktreeGeneration && observed.branchRef === record.metadata.branchRef &&
          observed.branchGeneration === record.metadata.branchGeneration) current.push({ artifactId: binding.artifactId, snapshot: observed })
      }
      return current.length === 1 ? current[0] : undefined
    }
    const binding = await match()
    if (!binding) return result
    const { snapshot } = binding
    const target = { worktreeId: snapshot.worktreeId, generation: snapshot.worktreeGeneration }
    result.bindingArtifactId = binding.artifactId
    result.branch = { ...target, ref: snapshot.branchRef, branchGeneration: snapshot.branchGeneration }
    if (!pending) return result
    if (!sources.sessions) throw new Error('SESSION_CONTEXT_UNAVAILABLE')
    const scope = { ...target, artifactId, executionId }
    const associationCurrent = (association: SessionAssociation) => {
      if (association.repositoryId !== continuum.repositoryId || association.artifactId !== artifactId || association.executionId !== executionId ||
        association.worktreeId !== target.worktreeId || association.generation !== target.generation || association.archived ||
        association.provider !== 'entire' || association.evidence !== 'HANDOFF_DECLARED' || !association.sourceArtifactId) return false
      const source = continuum.indexedArtifact(association.sourceArtifactId)
      return source?.metadata.kind === 'IMPLEMENTATION_HANDOFF' && source.revision === association.sourceRevision && source.contentHash === association.sourceHash &&
        source.metadata.relations?.some(relation => relation.kind === 'implements' && relation.artifactId === artifactId)
    }
    const associations = sources.sessions.readWorkAssociations(scope).filter(associationCurrent)
    const sessions = [...new Set(associations.map(association => association.providerSessionId))]
    if (sessions.length !== 1) return result
    const live = await sources.sessions.call('inspect_entire_session', { ...target, providerSessionId: sessions[0] })
    assertCurrent()
    const block = live.content[0]
    if (live.isError || block?.type !== 'text') throw new Error('SESSION_CONTEXT_UNAVAILABLE')
    const now = Date.now()
    const rechecked = await match()
    if (rechecked?.artifactId !== binding.artifactId || rechecked.snapshot.fingerprint !== snapshot.fingerprint) {
      delete result.branch
      return result
    }
    if (continuum.indexedArtifact(artifactId)?.revision !== revision) throw new Error('BOARD_CHANGED')
    const latestSessions = [...new Set(sources.sessions.readWorkAssociations(scope).filter(associationCurrent).map(association => association.providerSessionId))]
    if (latestSessions.length === 1 && latestSessions[0] === sessions[0] && currentSession(JSON.parse(block.text), sessions[0], now)) {
      result.activity = { state: 'ACTIVE', source: 'SESSION_CONTEXT', coverage: 'COMPLETE', observedAt: new Date(now).toISOString() }
    }
  } catch (error) {
    assertCurrent()
    if (error instanceof Error && error.message === 'BOARD_CHANGED') throw error
    result.activity = { ...result.activity, state: 'UNAVAILABLE', coverage: 'UNAVAILABLE' }
  }
  return result
}
