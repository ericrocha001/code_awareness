import type { ActiveProject, ActiveProjectState } from '../../shared/types/active-project-types'

interface OpenProjects {
  getOpenProjects(): ActiveProject[]
  closeRepository(repoPath: string): void
}

type ProjectListener = (state: ActiveProjectState) => void | Promise<void>

export class ActiveProjectService {
  private activeProjectId: string | null = null
  private revision = 0
  private readonly listeners = new Set<ProjectListener>()
  private readonly beforeChange = new Set<() => Promise<void>>()
  private transition: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(private readonly projects: OpenProjects) {}

  getState(): ActiveProjectState {
    const project = this.projects.getOpenProjects().find((entry) => entry.id === this.activeProjectId)
    return { revision: this.revision, project: project ? { ...project } : null }
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
    if (this.disposed) return Promise.reject(new Error('Application is shutting down'))
    return this.enqueue(async () => {
      if (this.disposed) throw new Error('Application is shutting down')
      if (projectId !== null && !this.projects.getOpenProjects().some((entry) => entry.id === projectId)) {
        throw new Error('Project is not open')
      }
      await this.select(projectId)
      return this.getState()
    })
  }

  closeRepository(repoPath: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Application is shutting down'))
    return this.enqueue(async () => {
      const normalizedPath = repoPath.replace(/\\/g, '/').replace(/\/$/, '')
      const project = this.projects.getOpenProjects().find((entry) => entry.path === normalizedPath)
      if (project && project.id === this.activeProjectId) await this.select(null)
      this.projects.closeRepository(repoPath)
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.enqueue(() => this.select(null))
    this.listeners.clear()
    this.beforeChange.clear()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transition.then(operation)
    this.transition = result.catch(() => undefined)
    return result
  }

  private async select(projectId: string | null): Promise<void> {
    if (this.activeProjectId === projectId) return
    for (const listener of this.beforeChange) await listener()
    this.activeProjectId = projectId
    this.revision++
    await Promise.all(Array.from(this.listeners, async (listener) => {
      try { await listener(this.getState()) } catch { console.error('[Active Project] Observer failed') }
    }))
  }
}
