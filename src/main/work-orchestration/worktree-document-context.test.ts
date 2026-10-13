import { expect, it, vi } from 'vitest'
import { readWorktreeDocumentContext, type OrchestrationContinuumReader } from './worktree-document-context'
import type { ArtifactDiscoveryRecord, ListArtifactsFilter } from '../continuum/continuum-types'
const identity = { repositoryId: 'repo', record: { worktreeId: 'a'.repeat(64), generation: 'g', path: 'C:\\work\\tree' } }
const request = { worktreeId: identity.record.worktreeId, generation: 'g', mode: 'EXACT' as const }
const document = (id: string, generation = 'g'): ArtifactDiscoveryRecord => ({ artifactId: id, name: id, kind: 'OBSERVATION', updatedAt: '2026-10-13T12:00:00Z', relationCount: 1,
  metadata: { worktreeId: identity.record.worktreeId, worktreeGeneration: generation, executionId: 'shared-execution' } })
function fixture(records: ArtifactDiscoveryRecord[] = [document('artifact-one')]) {
  const git = { getCoordinationIdentity: vi.fn().mockResolvedValue(identity) }
  const reader = { repositoryId: 'repo', isCurrent: vi.fn(() => true), list: vi.fn((_filter: ListArtifactsFilter) => ({ artifacts: records })),
    declaration: vi.fn(() => ({ name: 'one', kind: 'OBSERVATION', worktreeId: request.worktreeId, worktreeGeneration: 'g' })),
    graph: vi.fn(() => ({ repositoryId: 'repo', revision: 1, freshness: 'CURRENT' as const, nodes: [], edges: [], executionGroups: [], truncated: { nodes: false, edges: false } })) } satisfies OrchestrationContinuumReader
  return { git, reader }
}
it('queries only exact indexed identity with bounded discovery and verifies registry before and after', async () => {
  const { git, reader } = fixture([document('artifact-one'), document('artifact-two')])
  const result = await readWorktreeDocumentContext(git, reader, request)
  expect(result).toMatchObject({ mode: 'EXACT', repositoryId: 'repo', generation: 'g', coverage: 'COMPLETE' })
  expect(result.artifacts.map(record => record.artifactId)).toEqual(['artifact-two', 'artifact-one'])
  expect(reader.list).toHaveBeenCalledExactlyOnceWith({ metadata: { worktreeId: request.worktreeId, worktreeGeneration: 'g' }, metadataKeys: ['worktreeId', 'worktreeGeneration', 'executionId'], limit: 10 })
  expect(git.getCoordinationIdentity).toHaveBeenCalledTimes(2)
  expect(reader.graph).not.toHaveBeenCalled(); expect(reader.declaration).not.toHaveBeenCalled()
})
it('does not attribute a reused generation or incompatible repository and preserves failure rather than empty success', async () => {
  const { git, reader } = fixture([document('old', 'old-generation')])
  await expect(readWorktreeDocumentContext(git, reader, request)).rejects.toThrow('DOCUMENT_ASSOCIATION_CHANGED')
  await expect(readWorktreeDocumentContext(git, { ...reader, repositoryId: 'other' }, request)).rejects.toThrow('REPOSITORY_CONTEXT_CHANGED')
  reader.list.mockImplementation(() => { throw new Error('CONTINUUM_FAILURE') })
  await expect(readWorktreeDocumentContext(git, reader, request)).rejects.toThrow('CONTINUUM_FAILURE')
})
it('reports an empty completed exact query and forwards only matching continuation filters', async () => {
  const { git, reader } = fixture([])
  const empty = await readWorktreeDocumentContext(git, reader, request)
  expect(empty.artifacts).toEqual([]); expect(empty.coverage).toBe('COMPLETE')
  reader.list.mockReturnValue({ artifacts: [document('page-two')] })
  const page = await readWorktreeDocumentContext(git, reader, { ...request, cursor: 'cursor-2' })
  expect(page.artifacts).toHaveLength(1); expect(reader.list.mock.lastCall?.[0]).toMatchObject({ cursor: 'cursor-2', limit: 10, metadata: { worktreeId: request.worktreeId, worktreeGeneration: 'g' } })
})
it('keeps path-only references separate and never promotes old exact declarations into historical evidence', async () => {
  const { git, reader } = fixture([{ ...document('path-only'), metadata: {} }, document('old-exact', 'old')])
  const historical = await readWorktreeDocumentContext(git, reader, { ...request, mode: 'HISTORICAL' })
  expect(historical.mode).toBe('HISTORICAL'); expect(historical.artifacts.map(record => record.artifactId)).toEqual(['path-only'])
  expect(reader.list.mock.lastCall?.[0].metadata).toEqual({ worktreePath: identity.record.path })
})
it('follows only explicit one-hop edges from a selected declaration and ignores execution peers and inferred edges', async () => {
  const { git, reader } = fixture()
  const node = (id: string) => ({ artifactId: id, name: id, kind: 'EXECUTABLE_PLAN', updatedAt: '2026-10-13T12:00:00Z', relationCount: 0, revision: 1, incomingDegree: 0, outgoingDegree: 0 })
  const edge = (id: string, nature: 'DECLARED' | 'DERIVED' = 'DECLARED') => ({ sourceId: 'artifact-one', targetId: id, kind: 'derived-from', nature,
    origin: nature === 'DECLARED' ? 'metadata.relations' as const : 'explicit-artifact-reference' as const, sourceRevision: 1, sourceHash: 'hash' })
  reader.graph.mockReturnValue({ repositoryId: 'repo', revision: 1, freshness: 'CURRENT', nodes: [node('plan'), node('execution-peer'), node('inferred')], edges: [edge('plan'), edge('inferred', 'DERIVED')],
    executionGroups: [{ executionId: 'shared-execution', memberIds: ['artifact-one', 'execution-peer'], totalMembers: 2 }], truncated: { nodes: false, edges: false } } as any)
  const result = await readWorktreeDocumentContext(git, reader, { ...request, mode: 'RELATED', artifactId: 'artifact-one' })
  expect(result.artifacts.map(record => record.artifactId)).toEqual(['plan']); expect(result.relations).toEqual([{ sourceId: 'artifact-one', targetId: 'plan', kind: 'derived-from' }])
  reader.declaration.mockReturnValue({ name: 'another', kind: 'OBSERVATION', worktreeId: 'b'.repeat(64), worktreeGeneration: 'g' })
  await expect(readWorktreeDocumentContext(git, reader, { ...request, mode: 'RELATED', artifactId: 'artifact-one' })).rejects.toThrow('DOCUMENT_ASSOCIATION_CHANGED')
})
it('discards context changed during worktree revalidation after the Continuum query', async () => {
  const { git, reader } = fixture()
  git.getCoordinationIdentity.mockResolvedValueOnce(identity).mockResolvedValueOnce({ ...identity, record: { ...identity.record, generation: 'replacement' } })
  await expect(readWorktreeDocumentContext(git, reader, request)).rejects.toThrow('WORKTREE_STALE')
  git.getCoordinationIdentity.mockResolvedValue(identity)
  reader.isCurrent.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false)
  await expect(readWorktreeDocumentContext(git, reader, request)).rejects.toThrow('REPOSITORY_CONTEXT_CHANGED')
})
