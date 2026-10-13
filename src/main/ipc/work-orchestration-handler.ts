import { ipcMain } from 'electron'
import type { ActiveProjectService } from '../core/active-project-service'
import { WorkOrchestrationService, type OrchestrationGitReader } from '../work-orchestration/work-orchestration-service'
import type { OrchestrationContinuumReader } from '../work-orchestration/worktree-document-context'
import type { OrchestrationRequest, OrchestrationResult, OrchestrationData } from '../../shared/types/work-orchestration-types'

export class WorkOrchestrationController {
  private active: { service: WorkOrchestrationService; projectId: string; revision: number } | null = null
  constructor(private readonly projects: Pick<ActiveProjectService, 'getState'>) {}
  bind(git: OrchestrationGitReader | null, continuum?: OrchestrationContinuumReader): void {
    const state = this.projects.getState()
    this.active = git && state.project ? { service: new WorkOrchestrationService(git, continuum), projectId: state.project.id, revision: state.revision } : null
  }
  deactivate(): void { this.active = null }
  async read(request: OrchestrationRequest): Promise<OrchestrationResult<OrchestrationData>> {
    const context = request?.context
    const pair = request?.pair
    const worktree = request?.worktree
    const changes = request?.changes
    const documents = request?.documents
    if (!request || Object.keys(request).some(k => !['context', 'pair', 'worktree', 'changes', 'documents'].includes(k)) || !context ||
      Object.keys(context).some(k => !['projectId', 'revision'].includes(k)) || typeof context.projectId !== 'string' || !context.projectId ||
      !Number.isSafeInteger(context.revision) || context.revision < 0 ||
      ([pair, worktree, changes, documents].filter(value => value !== undefined).length > 1) ||
      (documents !== undefined && (!documents || Object.keys(documents).some(k => !['worktreeId', 'generation', 'mode', 'artifactId', 'cursor'].includes(k)) ||
        typeof documents.worktreeId !== 'string' || !/^[a-f0-9]{64}$/.test(documents.worktreeId) || typeof documents.generation !== 'string' || !documents.generation ||
        !['EXACT', 'HISTORICAL', 'RELATED'].includes(documents.mode) || (documents.cursor !== undefined && (typeof documents.cursor !== 'string' || documents.mode === 'RELATED')) ||
        (documents.mode === 'RELATED' ? typeof documents.artifactId !== 'string' || !documents.artifactId || documents.artifactId.length > 256 : documents.artifactId !== undefined))) ||
      (changes !== undefined && (!changes || Object.keys(changes).some(k => !['worktreeId', 'generation', 'snapshotRevision', 'cursor', 'pathPrefix'].includes(k)) ||
        ![changes.worktreeId, changes.snapshotRevision].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) ||
        typeof changes.generation !== 'string' || !changes.generation || (changes.cursor !== undefined && typeof changes.cursor !== 'string') ||
        (changes.pathPrefix !== undefined && typeof changes.pathPrefix !== 'string'))) ||
      (worktree !== undefined && (!worktree || Object.keys(worktree).some(k => k !== 'worktreeId') || typeof worktree.worktreeId !== 'string' || !/^[a-f0-9]{64}$/.test(worktree.worktreeId))) ||
      (pair !== undefined && (!pair || Object.keys(pair).some(k => !['leftId', 'rightId', 'cursor'].includes(k)) ||
        ![pair.leftId, pair.rightId].every(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)) ||
        (pair.cursor !== undefined && typeof pair.cursor !== 'string')))) return { success: false, code: 'INVALID_ARGUMENT' }
    const selected = this.active
    const current = () => {
      const state = this.projects.getState()
      return selected && this.active === selected && state.project?.id === context.projectId && state.revision === context.revision &&
        selected.projectId === context.projectId && selected.revision === context.revision
    }
    if (!current()) return { success: false, code: 'PROJECT_CONTEXT_CHANGED' }
    try {
      const data = documents ? await selected!.service.documents(documents) : changes ? await selected!.service.changes(changes) : pair ? await selected!.service.pair(pair.leftId, pair.rightId, pair.cursor) : worktree ? await selected!.service.observe(worktree.worktreeId) : await selected!.service.inventory()
      return current() ? { success: true, context, data } : { success: false, code: 'PROJECT_CONTEXT_CHANGED' }
    } catch (error) {
      return { success: false, code: current() ? error instanceof Error ? error.message : 'GIT_READ_UNAVAILABLE' : 'PROJECT_CONTEXT_CHANGED' }
    }
  }
}
export function registerWorkOrchestrationHandlers(controller: WorkOrchestrationController): void {
  ipcMain.handle('work-orchestration:read', (_event, request: OrchestrationRequest) => controller.read(request))
}
