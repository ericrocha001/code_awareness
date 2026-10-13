import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'
import type { OrchestrationContinuumReader } from '../work-orchestration/worktree-document-context'

export function orchestrationContinuumReader(session: RepositoryContinuumSession): OrchestrationContinuumReader | undefined {
  const current = session.getActiveSession(), service = session.getActiveService()
  if (!current || !service) return undefined
  return { repositoryId: current.repositoryId,
    isCurrent: () => session.getActiveSession() === current && session.getActiveService() === service,
    list: filter => service.list(filter), declaration: artifactId => service.get(artifactId)?.metadata ?? null, graph: query => service.graph(query) }
}
