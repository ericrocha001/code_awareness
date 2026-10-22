import type { ActiveContext, ActiveContextCapability, ActiveProject, ActiveProjectState, CapabilityReadiness } from '../../shared/types/active-project-types'
import type { RepositoryRecord } from '../../shared/types/repository-catalog-types'

interface OpenProjects {
  getOpenProjects(): ActiveProject[]
  closeRepository(repoPath: string): void
  getReadiness?(repoPath: string): CapabilityReadiness
}

type ProjectListener = (state: ActiveProjectState) => void | Promise<void>
export type ActiveInstance = { mode: 'HOST' } | { mode: 'PREVIEW'; sessionId: string }
const normalized = (path: string) => path.replace(/\\/g, '/').replace(/\/$/, '')
const emptyContext = (): ActiveContext => ({ revision: 0, mode: 'HOST', identity: 'UNBOUND', repositoryId: null, activeCheckout: null,
  legacyCodeMapProjectId: null, sessionId: null, dataPolicy: 'HOST_CANONICAL',
  capabilities: { codeMap: { state: 'UNINITIALIZED' }, continuum: { state: 'UNINITIALIZED' }, channel: { state: 'UNINITIALIZED' } } })

export class ActiveProjectService {
  private project: ActiveProject | null = null
  private context: ActiveContext
  private intention = 0
  private requestedPath: string | null = null
  private revision = 0
  private readonly listeners = new Set<ProjectListener>()
  private readonly beforeChange = new Set<() => Promise<void>>()
  private transition: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(private readonly projects: OpenProjects, private readonly repositoryByPath?: (path: string) => RepositoryRecord | null,
    private readonly instance: ActiveInstance = { mode: 'HOST' }) {
    this.context = this.initialContext()
  }

  private initialContext(): ActiveContext {
    return { ...emptyContext(), mode: this.instance.mode, sessionId: this.instance.mode === 'PREVIEW' ? this.instance.sessionId : null,
      dataPolicy: this.instance.mode === 'PREVIEW' ? 'EMPTY' : 'HOST_CANONICAL' }
  }

  getState(): ActiveProjectState {
    if (this.project && this.context.legacyCodeMapProjectId && this.projects.getReadiness) {
      const readiness = this.projects.getReadiness(this.project.path)
      if (JSON.stringify(readiness) !== JSON.stringify(this.context.capabilities.codeMap)) {
        this.context = { ...this.context, revision: this.context.revision + 1, capabilities: { ...this.context.capabilities, codeMap: { ...readiness } } }
      }
    }
    return { revision: this.revision, project: this.project ? { ...this.project } : null, context: structuredClone(this.context) }
  }

  onChanged(listener: ProjectListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onBeforeChange(listener: () => Promise<void>): () => void {
    this.beforeChange.add(listener)
    return () => this.beforeChange.delete(listener)
  }

  activate(projectId: string | null): Promise<ActiveProjectState> {
    if (projectId === null) return this.request(null, null, 'LEGACY_CODEMAP')
    const legacy = this.projects.getOpenProjects().find(entry => entry.id === projectId)
    if (!legacy) {
      if (this.project?.id === projectId) return this.request(this.project, this.context.repositoryId, this.context.activeCheckout!.basis)
      return Promise.reject(new Error('Project is not open'))
    }
    const repository = this.repositoryByPath?.(legacy.path)
    return repository ? this.bind(repository) : this.request(legacy, null, 'LEGACY_CODEMAP')
  }

  bind(repository: RepositoryRecord, isCurrent: () => boolean = () => true): Promise<ActiveProjectState> {
    if (!repository.localCheckout || repository.localCheckout.availability !== 'AVAILABLE') return Promise.reject(new Error('LOCAL_CHECKOUT_UNAVAILABLE'))
    return this.request({ id: repository.id, path: normalized(repository.localCheckout.path), name: repository.name }, repository.id, 'REPOSITORY_CATALOG', isCurrent)
  }

  updateCapability(selectionRevision: number, capability: ActiveContextCapability, readiness: CapabilityReadiness, legacyCodeMapProjectId?: string): void {
    if (this.disposed || !this.project || this.revision !== selectionRevision) return
    const next = { ...this.context, capabilities: { ...this.context.capabilities, [capability]: { ...readiness } },
      ...(legacyCodeMapProjectId !== undefined ? { legacyCodeMapProjectId } : {}) }
    if (JSON.stringify(next) === JSON.stringify(this.context)) return
    this.context = { ...next, revision: this.context.revision + 1 }
    void this.publish()
  }

  private request(project: ActiveProject | null, repositoryId: string | null, basis: 'REPOSITORY_CATALOG' | 'LEGACY_CODEMAP', isCurrent: () => boolean = () => true): Promise<ActiveProjectState> {
    if (this.disposed) return Promise.reject(new Error('Application is shutting down'))
    const intention = ++this.intention, current = () => !this.disposed && intention === this.intention && isCurrent()
    this.requestedPath = project?.path ?? null
    return this.enqueue(async () => {
      if (current()) await this.select(project, repositoryId, basis, current)
      return this.getState()
    })
  }

  closeRepository(repoPath: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Application is shutting down'))
    if (this.requestedPath === normalized(repoPath)) ++this.intention
    return this.enqueue(async () => {
      const normalizedPath = repoPath.replace(/\\/g, '/').replace(/\/$/, '')
      if (this.project?.path === normalizedPath) await this.select(null, null, 'LEGACY_CODEMAP')
      this.projects.closeRepository(repoPath)
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    ++this.intention
    await this.enqueue(() => this.select(null, null, 'LEGACY_CODEMAP'))
    this.listeners.clear()
    this.beforeChange.clear()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transition.then(operation)
    this.transition = result.catch(() => undefined)
    return result
  }

  private async select(project: ActiveProject | null, repositoryId: string | null, basis: 'REPOSITORY_CATALOG' | 'LEGACY_CODEMAP', isCurrent: () => boolean = () => true): Promise<void> {
    if (this.project?.id === project?.id && this.project?.path === project?.path) return
    for (const listener of this.beforeChange) { await listener(); if (!isCurrent()) return }
    if (!isCurrent()) return
    this.project = project ? { ...project } : null
    this.revision++
    this.context = { ...this.initialContext(), revision: this.context.revision + 1, repositoryId,
      identity: repositoryId ? 'IDENTITY_BOUND' : 'UNBOUND', activeCheckout: project ? { path: project.path, basis } : null,
      legacyCodeMapProjectId: project && !repositoryId ? project.id : null }
    await this.publish()
  }

  private async publish(): Promise<void> {
    const state = this.getState()
    await Promise.all(Array.from(this.listeners, async (listener) => {
      try { await listener(structuredClone(state)) } catch { console.error('[Active Project] Observer failed') }
    }))
  }
}
