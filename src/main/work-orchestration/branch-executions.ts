import { projectDocument } from './worktree-document-context'
import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'
import type { GitOperationsService } from '../git-operations/git-operations-service'
import type { ExecutionBinding, ExecutionBindingPage, ExecutionDocumentPage } from '../../shared/types/execution-branch-types'

export async function readBranchExecutions(git: Pick<GitOperationsService, 'getBranchInventory'>, session: RepositoryContinuumSession | undefined,
  request: { ref: string; revision: string; cursor?: string; bindingId?: string; executionId?: string }): Promise<ExecutionBindingPage | ExecutionDocumentPage> {
  const active = session?.getActiveSession(), service = session?.getActiveService()
  if (!active || !service) throw new Error('CONTINUUM_UNAVAILABLE')
  const before = await git.getBranchInventory(), branch = before.branches.find(b => b.ref === request.ref)
  const guard = () => {
    if (session?.getActiveSession() !== active || session.getActiveService() !== service || before.repositoryId !== active.repositoryId) throw new Error('REPOSITORY_CONTEXT_CHANGED')
    if (!branch || branch.revision !== request.revision) throw new Error('GIT_STATE_CHANGED')
  }
  guard()
  const qualify = (id: string): ExecutionBinding => {
    const artifact = service.get(id), m = artifact?.metadata
    if (!artifact || m?.bindingRole !== 'EXECUTION_BRANCH' || m.repositoryId !== before.repositoryId || m.branchRef !== request.ref || typeof m.executionId !== 'string') throw new Error('EXECUTION_BINDING_CHANGED')
    const certified = artifact.provenance.executionBranchBinding === true && m.branchGeneration !== 'UNKNOWN'
    const current = certified && branch!.generation !== 'UNKNOWN' && branch!.generation === m.branchGeneration
    return { artifactId: id, executionId: m.executionId, sourceArtifactId: String(m.sourceArtifactId ?? ''), branchRef: request.ref,
      branchGeneration: String(m.branchGeneration ?? 'UNKNOWN'), sourceHeadAtBinding: String(m.sourceHeadAtBinding ?? ''), observedAt: String(m.observedAt ?? ''),
      classification: !certified ? 'DECLARED_UNVERIFIED' : branch!.generation === 'UNKNOWN' ? 'STALE' : current ? 'VERIFIED_CURRENT' : 'HISTORICAL',
      checkout: !certified ? 'UNVERIFIED' : current && branch!.worktrees.some(w => w.worktreeId === m.worktreeId && w.generation === m.worktreeGeneration) ? 'CURRENT' : 'HISTORICAL' }
  }
  let result: ExecutionBindingPage | ExecutionDocumentPage
  if (request.executionId !== undefined) {
    if (!request.bindingId || qualify(request.bindingId).executionId !== request.executionId) throw new Error('EXECUTION_BINDING_CHANGED')
    const page = service.list({ metadata: { executionId: request.executionId }, limit: 10, cursor: request.cursor })
    result = { repositoryId: before.repositoryId, executionId: request.executionId, artifacts: page.artifacts.map(projectDocument), nextCursor: page.nextCursor }
  } else {
    const page = service.list({ kind: 'OBSERVATION', metadata: { bindingRole: 'EXECUTION_BRANCH', repositoryId: before.repositoryId, branchRef: request.ref }, limit: 10, cursor: request.cursor })
    const bindings = page.artifacts.map(a => qualify(a.artifactId))
    const declarations = new Map<string, number>()
    for (const binding of bindings) if (binding.classification === 'DECLARED_UNVERIFIED') declarations.set(binding.executionId, (declarations.get(binding.executionId) ?? 0) + 1)
    for (const binding of bindings) {
      if (binding.classification === 'DECLARED_UNVERIFIED' && declarations.get(binding.executionId)! > 1) binding.classification = 'AMBIGUOUS'
    }
    result = { repositoryId: before.repositoryId, branchRef: request.ref, branchRevision: branch!.revision, bindings, nextCursor: page.nextCursor, coverage: page.nextCursor ? 'PARTIAL' : 'COMPLETE' }
  }
  const after = await git.getBranchInventory()
  guard()
  if (after.repositoryId !== before.repositoryId || after.branches.find(b => b.ref === request.ref)?.revision !== branch!.revision) throw new Error('GIT_STATE_CHANGED')
  return result
}
