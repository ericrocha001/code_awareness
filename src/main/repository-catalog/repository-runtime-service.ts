import type { ActiveProjectState } from '../../shared/types/active-project-types'
import type { RepositoryCatalogService } from './repository-catalog-service'

interface CodeMapRepositoryRuntime {
  openRepository(path: string): Promise<unknown>
  getOpenProjects(): Array<{ id: string; path: string; name: string }>
}

interface ActiveProjectRuntime {
  getState(): ActiveProjectState
  activate(projectId: string | null): Promise<ActiveProjectState>
}

export class RepositoryRuntimeService {
  private activationRevision = 0

  constructor(
    private readonly catalog: RepositoryCatalogService,
    private readonly codeMap: CodeMapRepositoryRuntime,
    private readonly activeProjects: ActiveProjectRuntime
  ) {}

  async activate(repositoryId: string): Promise<ActiveProjectState> {
    const revision = ++this.activationRevision
    const repository = this.catalog.resolveAvailable(repositoryId)
    const checkoutPath = repository.localCheckout!.path
    await this.codeMap.openRepository(checkoutPath)
    if (revision !== this.activationRevision) return this.activeProjects.getState()
    const normalized = checkoutPath.replace(/\\/g, '/').replace(/\/$/, '')
    const runtimeProject = this.codeMap.getOpenProjects().find((project) => project.path === normalized)
    if (!runtimeProject) throw new Error('CODEMAP_REPOSITORY_NOT_OPEN')
    return this.activeProjects.activate(runtimeProject.id)
  }
}
