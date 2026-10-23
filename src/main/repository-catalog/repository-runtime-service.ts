import type { ActiveProjectState, CapabilityReadiness } from '../../shared/types/active-project-types'
import type { RepositoryCatalogService } from './repository-catalog-service'
import type { ActiveProjectService } from '../core/active-project-service'

interface CodeMapRepositoryRuntime {
  openRepository(path: string): Promise<unknown>
  getOpenProjects(): Array<{ id: string; path: string; name: string }>
  awaitMaintenance?(path: string): Promise<void>
  getReadiness?(path: string): CapabilityReadiness
}

type ActiveProjectRuntime = Pick<ActiveProjectService, 'getState' | 'bind' | 'updateCapability'>

export class RepositoryRuntimeService {
  private activationRevision = 0

  constructor(
    private readonly catalog: Pick<RepositoryCatalogService, 'resolveAvailable'>,
    private readonly codeMap: CodeMapRepositoryRuntime,
    private readonly activeProjects: ActiveProjectRuntime
  ) {}

  async activate(repositoryId: string): Promise<ActiveProjectState> {
    const repository = this.catalog.resolveAvailable(repositoryId)
    const revision = ++this.activationRevision
    const checkoutPath = repository.localCheckout!.path
    const state = await this.activeProjects.bind(repository, () => revision === this.activationRevision)
    if (revision !== this.activationRevision) return this.activeProjects.getState()
    const normalized = checkoutPath.replace(/\\/g, '/').replace(/\/$/, '')
    if (state.project?.id !== repository.id || state.project.path !== normalized) return this.activeProjects.getState()
    const current = () => revision === this.activationRevision && this.activeProjects.getState().revision === state.revision
    this.activeProjects.updateCapability(state.revision, 'codeMap', { state: 'INITIALIZING' })
    void Promise.resolve().then(async () => {
      if (!current()) return
      await this.codeMap.openRepository(checkoutPath)
      if (!current()) return
      const runtimeProject = this.codeMap.getOpenProjects().find(project => project.path === normalized)
      if (!runtimeProject) throw new Error('CODEMAP_REPOSITORY_NOT_OPEN')
      const readiness = () => this.codeMap.getReadiness?.(checkoutPath) ?? { state: 'UNINITIALIZED' as const, reasonCode: 'CODEMAP_READINESS_UNOBSERVED' }
      this.activeProjects.updateCapability(state.revision, 'codeMap', readiness(), runtimeProject.id)
      await this.codeMap.awaitMaintenance?.(checkoutPath)
      if (current()) this.activeProjects.updateCapability(state.revision, 'codeMap', readiness(), runtimeProject.id)
    }).catch(() => {
      if (current()) this.activeProjects.updateCapability(state.revision, 'codeMap', { state: 'UNAVAILABLE', reasonCode: 'CODEMAP_OPEN_FAILED' })
    })
    return this.activeProjects.getState()
  }
}
