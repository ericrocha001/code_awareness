import { expect, it, vi } from 'vitest'
import { inspectWorkBoard, type WorkBoardInspectionSources } from './work-board-inspection'
import type { SessionAssociation } from '../session-context/associations'
import type { ContinuumService } from '../continuum/continuum-service'

const context = { repositoryId: 'repo', projectId: 'project', revision: 1 }
const target = { worktreeId: 'tree', generation: 'generation' }
const request = { context, perspective: 'WORK' as const, column: 'PENDING' as const, inspect: { artifactId: 'plan', revision: 1 } }
const handoff = { artifactId: 'handoff', revision: 1, kind: 'IMPLEMENTATION_HANDOFF', status: 'VALIDATED', name: 'Handoff',
  updatedAt: new Date().toISOString(), incomingDegree: 0, outgoingDegree: 1, relationCount: 1 }
function setup(status = 'PENDING') {
  const read = (kind: string, metadata: object, provenance = {}) =>
    ({ revision: 1, contentHash: kind, metadata: { kind, name: kind, ...metadata }, provenance })
  const records = new Map([
    ['plan', read('EXECUTABLE_PLAN', { status, executionId: 'execution' })],
    ['binding', read('OBSERVATION', { repositoryId: 'repo', worktreeId: 'tree', worktreeGeneration: 'generation', branchRef: 'refs/heads/work',
      branchGeneration: 'branch-generation' }, { executionBranchBinding: true })],
    ['handoff', read('IMPLEMENTATION_HANDOFF', { proofIds: ['proof'], relations: [{ artifactId: 'plan', kind: 'implements' }] })]
  ])
  const continuum: Parameters<typeof inspectWorkBoard>[0] = {
    repositoryId: 'repo', indexedArtifact: id => records.get(id) as ReturnType<ContinuumService['indexedArtifact']> ?? null,
    listIndexedArtifacts: () => ({ artifacts: [{ ...handoff, artifactId: 'binding' }] }),
    readIndexedGraph: () => ({ repositoryId: 'repo', revision: 1, freshness: 'CURRENT', nodes: [handoff], executionGroups: [],
      edges: [{ sourceId: 'handoff', targetId: 'plan', kind: 'implements', nature: 'DECLARED', origin: 'metadata.relations', sourceRevision: 1, sourceHash: 'hash' }],
      truncated: { edges: false, nodes: false } })
  }
  const association: SessionAssociation = { ...target, repositoryId: 'repo', sessionId: 'session', providerSessionId: 'provider',
    provider: 'entire', artifactId: 'plan', executionId: 'execution', sourceArtifactId: 'handoff', sourceRevision: 1,
    sourceHash: 'IMPLEMENTATION_HANDOFF', evidence: 'HANDOFF_DECLARED', origin: 'CONTINUUM_HANDOFF' }
  const call = vi.fn(async () => ({ content: [{ type: 'text' as const, text: JSON.stringify({ source: 'ENTIRE_LIVE', providerSessionId: 'provider',
    state: 'ACTIVE', lastActive: new Date().toISOString() }) }] }))
  const readWorkAssociations = vi.fn(() => [association])
  const sources: WorkBoardInspectionSources = {
    git: { deliverySnapshot: async () => ({ repositoryId: 'repo', worktreeId: 'tree', worktreeGeneration: 'generation',
      branchRef: 'refs/heads/work', branchGeneration: 'branch-generation', head: 'head', branchRevision: 'branch', fingerprint: 'current' }) },
    sessions: { call, readWorkAssociations }, ledger: { getProof: vi.fn(() => null) }
  }
  return { continuum, sources, call, readWorkAssociations, association }
}

it('promotes only a current direct observation while preserving the documentary revision', async () => {
  const { continuum, sources, call } = setup()
  const result = await inspectWorkBoard(continuum, sources, request, () => {})
  expect(result).toMatchObject({ revision: 1, activity: { source: 'SESSION_CONTEXT', state: 'ACTIVE' } })
  expect(call).toHaveBeenCalledWith('inspect_entire_session', { ...target, providerSessionId: 'provider' })
})

it('leaves branch-only, another plan, historical association, stale activity and unavailable provider queued', async () => {
  const { continuum, sources, call, readWorkAssociations, association } = setup()
  const inspect = () => inspectWorkBoard(continuum, sources, request, () => {})
  for (const value of [[], [{ ...association, artifactId: 'another-plan' }], [{ ...association, sourceRevision: 0 }],
    [association, { ...association, providerSessionId: 'second' }]]) {
    readWorkAssociations.mockReturnValueOnce(value)
    expect(await inspect()).toMatchObject({ activity: { state: 'INCONCLUSIVE' } })
  }
  expect(call).not.toHaveBeenCalled()
  call.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify({ source: 'ENTIRE_LIVE', providerSessionId: 'provider',
    state: 'ACTIVE', lastActive: '2020-01-01T00:00:00Z' }) }] })
  expect((await inspect()).activity.state).toBe('INCONCLUSIVE')
  call.mockRejectedValueOnce(new Error('PROVIDER_UNAVAILABLE'))
  expect(await inspect()).toMatchObject({ activity: { state: 'UNAVAILABLE' } })
})

it('shows scoped passing proof as consultative reconciliation without changing documentary status', async () => {
  const { continuum, sources, readWorkAssociations } = setup()
  readWorkAssociations.mockReturnValue([])
  const ledger: WorkBoardInspectionSources['ledger'] = { getProof: () => ({ status: 'PASSED', evidenceFor: ['plan'] }) }
  const result = await inspectWorkBoard(continuum, { ...sources, ledger }, request, () => {})
  expect(result).not.toHaveProperty('column')
  expect(result.reconciliation.sources).toEqual([{ artifact: handoff, relation: 'implements', proofIds: ['proof'] }])
  expect(continuum.indexedArtifact('plan')?.metadata.status).toBe('PENDING')
})

it('keeps documentary completion and rejects a response after a project change', async () => {
  const completed = setup('COMPLETED')
  expect(await inspectWorkBoard(completed.continuum, completed.sources, { ...request, column: 'COMPLETED' }, () => {})).not.toHaveProperty('column')
  expect(completed.call).not.toHaveBeenCalled()
  const { continuum, sources, call } = setup()
  await expect(inspectWorkBoard(continuum, sources, request, () => {
    if (call.mock.calls.length) throw new Error('PROJECT_CONTEXT_CHANGED')
  })).rejects.toThrow('PROJECT_CONTEXT_CHANGED')
})
