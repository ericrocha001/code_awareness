import { expect, it, vi } from 'vitest'
import { readBranchExecutions } from './branch-executions'
import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'
import type { BranchInventory } from '../../shared/types/branch-orchestration-types'

function setup(certified = true) {
  const branch = { ref: 'refs/heads/topic', revision: 'r', generation: 'g', worktrees: [] }
  const inventory = { repositoryId: 'repo', branches: [branch] } as unknown as BranchInventory
  const artifacts = ['a', 'b'].map(artifactId => ({ artifactId, provenance: { executionBranchBinding: certified }, metadata: {
    bindingRole: 'EXECUTION_BRANCH', repositoryId: 'repo', branchRef: branch.ref, branchGeneration: 'g', executionId: 'run', sourceArtifactId: 'plan', sourceHeadAtBinding: 'old-head'
  } }))
  const service = { list: vi.fn(() => ({ artifacts: artifacts.map(({ artifactId }) => ({ artifactId })), nextCursor: 'next' })), get: vi.fn(id => artifacts.find(a => a.artifactId === id)) }
  const active = { repositoryId: 'repo' }
  const session = { getActiveSession: () => active, getActiveService: () => service } as unknown as RepositoryContinuumSession
  const git = { getBranchInventory: vi.fn(async () => inventory) }
  return { git, session, service, branch, inventory, request: { ref: branch.ref, revision: branch.revision } }
}
it('keeps competing manual declarations ambiguous with partial coverage and one selective list', async () => {
  const { git, session, request, service } = setup(false)
  const page = await readBranchExecutions(git, session, request)
  expect('bindings' in page && page.bindings.map(b => b.classification)).toEqual(['AMBIGUOUS', 'AMBIGUOUS'])
  expect('coverage' in page && page.coverage).toBe('PARTIAL')
  expect(service.list).toHaveBeenCalledExactlyOnceWith({ kind: 'OBSERVATION', metadata: { bindingRole: 'EXECUTION_BRANCH', repositoryId: 'repo', branchRef: request.ref }, limit: 10, cursor: undefined })
})
it('marks unknown generation stale and checkout historical independently of HEAD', async () => {
  const { git, session, request, branch } = setup()
  branch.generation = 'UNKNOWN'
  const page = await readBranchExecutions(git, session, request)
  expect('bindings' in page && page.bindings.every(b => b.classification === 'STALE' && b.checkout === 'HISTORICAL')).toBe(true)
})
it('rejects drift and unavailable stores instead of returning an empty complete page', async () => {
  const { git, session, request, inventory } = setup()
  git.getBranchInventory.mockResolvedValueOnce(inventory).mockResolvedValueOnce({ ...inventory, branches: [] })
  await expect(readBranchExecutions(git, session, request)).rejects.toThrow('GIT_STATE_CHANGED')
  await expect(readBranchExecutions(git, undefined, request)).rejects.toThrow('CONTINUUM_UNAVAILABLE')
  const other = { ...session, getActiveSession: () => ({ repositoryId: 'other' }) } as unknown as RepositoryContinuumSession
  await expect(readBranchExecutions(git, other, request)).rejects.toThrow('REPOSITORY_CONTEXT_CHANGED')
})
