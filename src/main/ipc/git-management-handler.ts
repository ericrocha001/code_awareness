import { ipcMain } from 'electron'
import type { GitAtlasRequest, GitAtlasCompareRequest, GitAtlasScope } from '../../shared/types/git-atlas-types'
import type { GitAtlasCoreRequest, GitAtlasPrRequest } from '../../shared/types/git-atlas-evidence-types'
import type { AtlasCatalogRequest } from '../../shared/types/git-atlas-catalog-types'
import type { ActiveProjectService } from '../core/active-project-service'
import type { GitCommitCorrelationRequest, GitCommitCorrelationPage } from '../../shared/types/git-commit-correlation-types'
import {
  GitOperationsError,
  type GitOperationsService
} from '../git-operations/git-operations-service'
import type {
  GitHistoryRequest,
  GitManagementContext,
  GitManagementResult,
  GitCommitRequest,
  GitPatchRequest,
  GitMutationRequest,
  GitOperationalResult
} from '../../shared/types/git-management-types'

export class GitManagementController {
  private active: {
    context: GitManagementContext
    service: GitOperationsService
  } | null = null
  private readonly mutations = new Set<Promise<unknown>>()
  hasPendingMutations() { return this.mutations.size > 0 }
  constructor(
    private readonly projects: Pick<ActiveProjectService, 'getState'>
  ) {}
  bind(service: GitOperationsService | null): void {
    this.active?.service.clearAtlasCache()
    const state = this.projects.getState()
    this.active =
      state.project && service
        ? {
            context: { projectId: state.project.id, revision: state.revision },
            service
          }
        : null
  }
  async deactivate(): Promise<void> {
    this.active?.service.clearAtlasCache()
    this.active = null
    await Promise.allSettled([...this.mutations])
  }
  correlation(request: GitCommitCorrelationRequest): Promise<GitManagementResult<GitCommitCorrelationPage>> {
    if (!request || !['WORKTREE_COMMITS', 'COMMIT_WORKTREES'].includes(request.direction) || Object.keys(request).some(key =>
      !['context', 'direction', 'mode', 'reference', 'limit', 'cursor', ...(request.direction === 'WORKTREE_COMMITS' ? ['worktreeId', 'generation'] : ['sha'])].includes(key))) return Promise.resolve({ success: false, code: 'INVALID_ARGUMENT' })
    return this.read<GitCommitCorrelationPage>(request.context, service => {
      const contextKey = `${request.context.projectId}:${request.context.revision}`
      if (request.direction === 'WORKTREE_COMMITS') {
        const { context: _context, direction: _direction, ...query } = request
        return service.getWorktreeCommits({ ...query, contextKey })
      }
      const { context: _context, direction: _direction, ...query } = request
      return service.getCommitWorktrees({ ...query, contextKey })
    })
  }
  async mutate(
    request: GitMutationRequest
  ): Promise<GitManagementResult<GitOperationalResult>> {
    if (!validMutation(request))
      return { success: false, code: 'INVALID_ARGUMENT' }
    const selected = this.active
    const promise = this.read(request.context, (service) =>
      service.executeManagementMutation(request, () => {
        const state = this.projects.getState()
        if (
          this.active !== selected ||
          state.project?.id !== request.context.projectId ||
          state.revision !== request.context.revision
        )
          throw new Error('PROJECT_CONTEXT_CHANGED')
      })
    )
    this.mutations.add(promise)
    try {
      return await promise
    } finally {
      this.mutations.delete(promise)
    }
  }
  async read<T>(
    context: GitManagementContext,
    action: (service: GitOperationsService) => Promise<T>
  ): Promise<GitManagementResult<T>> {
    if (
      !context ||
      typeof context.projectId !== 'string' ||
      !context.projectId ||
      !Number.isSafeInteger(context.revision) ||
      context.revision < 0 ||
      Object.keys(context).some(
        (key) => !['projectId', 'revision'].includes(key)
      )
    )
      return { success: false, code: 'INVALID_ARGUMENT' }
    const selected = this.active
    const current = () => {
      const state = this.projects.getState()
      return (
        selected &&
        this.active === selected &&
        context?.projectId === state.project?.id &&
        context?.revision === state.revision &&
        selected.context.projectId === context.projectId &&
        selected.context.revision === context.revision
      )
    }
    if (!current()) return { success: false, code: 'PROJECT_CONTEXT_CHANGED' }
    const release = selected!.service.beginAtlasInteraction()
    try {
      const data = await action(selected!.service)
      return current()
        ? { success: true, context, data }
        : { success: false, code: 'PROJECT_CONTEXT_CHANGED' }
    } catch (error) {
      return {
        success: false,
        code:
          error instanceof GitOperationsError
            ? error.code
            : error instanceof Error &&
                error.message === 'PROJECT_CONTEXT_CHANGED'
              ? error.message
              : 'GIT_OPERATION_FAILED'
      }
    } finally { release() }
  }
}

function validMutation(value: GitMutationRequest): boolean {
  if (
    !value ||
    Object.keys(value).some(
      (key) =>
        !['context', 'operationId', 'snapshot', 'operation'].includes(key)
    )
  )
    return false
  if (
    typeof value.operationId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.operationId)
  )
    return false
  const snapshot = value.snapshot,
    operation = value.operation
  if (
    !snapshot ||
    !operation ||
    typeof snapshot.indexRevision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(snapshot.indexRevision) ||
    typeof snapshot.worktreeRevision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(snapshot.worktreeRevision)
  )
    return false
  if (
    (snapshot.head !== null &&
      (typeof snapshot.head !== 'string' ||
        !/^[a-f0-9]{40,64}$/.test(snapshot.head))) ||
    (snapshot.branch !== null && typeof snapshot.branch !== 'string') ||
    (snapshot.operation !== null && typeof snapshot.operation !== 'string')
  )
    return false
  const fields: Record<string, string[]> = {
    STAGE: ['action', 'paths'],
    UNSTAGE: ['action', 'paths'],
    COMMIT: ['action', 'message'],
    CREATE: ['action', 'branch'],
    SWITCH: ['action', 'branch'],
    FETCH: ['action'],
    PULL_FF_ONLY: ['action'],
    PUSH: ['action']
  }
  const allowed = fields[operation.action]
  if (
    !Array.isArray(allowed) ||
    Object.keys(operation).some((key) => !allowed.includes(key))
  )
    return false
  if (operation.action === 'STAGE' || operation.action === 'UNSTAGE')
    return (
      Array.isArray(operation.paths) &&
      operation.paths.length > 0 &&
      operation.paths.length <= 500 &&
      operation.paths.every((path) => typeof path === 'string')
    )
  if (operation.action === 'COMMIT')
    return (
      typeof operation.message === 'string' &&
      operation.message.trim().length > 0 &&
      operation.message.length <= 10000
    )
  if (operation.action === 'CREATE' || operation.action === 'SWITCH')
    return (
      typeof operation.branch === 'string' &&
      operation.branch.length > 0 &&
      operation.branch.length <= 250
    )
  return true
}

export function registerGitManagementHandlers(
  controller: GitManagementController
): void {
  const validScope = (scope: GitAtlasScope | undefined) => scope === undefined || !!scope && typeof scope === 'object' && !Array.isArray(scope) &&
    Object.keys(scope).every(key => ['kind', 'anchor', 'baseRef', 'focusRef'].includes(key)) &&
    ['CHECKOUT', 'ALL_REFS'].includes(scope.kind) && ['AUTO', 'PRESENT'].includes(scope.anchor) &&
    [scope.baseRef, scope.focusRef].every(ref => ref === undefined || typeof ref === 'string' && /^refs\/(heads|remotes)\/.+/.test(ref) && !/[\s~^:?*\[\]\\]/.test(ref) && ref.length <= 256)
  ipcMain.handle('git-management:atlas-checkout-state', (_event, context: GitManagementContext, lightweight?: boolean) => {
    if (lightweight !== undefined && typeof lightweight !== 'boolean') return { success: false, code: 'INVALID_ARGUMENT' }
    if (controller.hasPendingMutations()) return { success: false, code: 'GIT_OPERATION_IN_PROGRESS' }
    return controller.read(context, service => service.getAtlasCheckoutState(lightweight))
  })
  ipcMain.handle('git-management:atlas-catalog', (event, request: AtlasCatalogRequest) => {
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !['context', 'snapshot'].includes(key)) || typeof request.snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(request.snapshot)) return { success: false, code: 'INVALID_ARGUMENT' }
    const context = request.context
    return controller.read(context, service => service.getAtlasCatalog(request.snapshot, `${context.projectId}:${context.revision}`, state => {
      if (!event.sender.isDestroyed()) event.sender.send('git-management:atlas-catalog-changed', { context, state })
    }))
  })
  ipcMain.handle('git-management:atlas-catalog-stop', (_event, context: GitManagementContext) => controller.read(context, async service => { service.stopAtlasCollection() }))
  const validEvidenceRequest = (request: GitAtlasCoreRequest | GitAtlasPrRequest, enrichment: boolean) => {
    if (!request || typeof request !== 'object' || Array.isArray(request)) return false
    const keys = enrichment ? ['context', 'window', 'cursor', 'limit', 'snapshot', 'scope'] : ['context', 'window', 'cursor', 'limit', 'refresh', 'comparisonRef', 'scope']
    if (!validScope(request.scope)) return false
    if (Object.keys(request).some(key => !keys.includes(key)) || ![7, 15, 30, 60, 90, 'ALL'].includes(request.window) ||
      request.cursor !== undefined && (typeof request.cursor !== 'string' || request.cursor.length > 2048) ||
      request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100)) return false
    if (enrichment) return 'snapshot' in request && typeof request.snapshot === 'string' && /^[a-f0-9]{64}$/.test(request.snapshot)
    const core = request as GitAtlasCoreRequest
    return (core.refresh === undefined || typeof core.refresh === 'boolean') &&
      (core.comparisonRef === undefined || typeof core.comparisonRef === 'string' && core.comparisonRef.length > 0 && core.comparisonRef.length <= 256)
  }
  ipcMain.handle('git-management:atlas-core', (_event, request: GitAtlasCoreRequest) => {
    if (!validEvidenceRequest(request, false)) return { success: false, code: 'INVALID_ARGUMENT' }
    const { context, ...query } = request
    return controller.read(context, service => service.getAtlasCoreEvidence({ ...query, contextKey: `${context.projectId}:${context.revision}` }))
  })
  ipcMain.handle('git-management:atlas-pr-evidence', (_event, request: GitAtlasPrRequest) => {
    if (!validEvidenceRequest(request, true)) return { success: false, code: 'INVALID_ARGUMENT' }
    const { context, ...query } = request
    return controller.read(context, service => service.getAtlasPrEvidence({ ...query, contextKey: `${context.projectId}:${context.revision}` }))
  })
  ipcMain.handle('git-management:atlas', (_event, request: GitAtlasRequest) => {
    if (!request || !validScope(request.scope) || Object.keys(request).some(key => !['context', 'window', 'cursor', 'limit', 'refresh', 'scope'].includes(key)) ||
      request.refresh !== undefined && typeof request.refresh !== 'boolean' || ![7, 15, 30, 60, 90, 'ALL'].includes(request.window) || request.cursor !== undefined && (typeof request.cursor !== 'string' || request.cursor.length > 2048)) return { success: false, code: 'INVALID_ARGUMENT' }
    return controller.read(request.context, service => service.getAtlasHistory({ window: request.window, limit: request.limit, cursor: request.cursor, refresh: request.refresh, scope: request.scope, contextKey: `${request.context.projectId}:${request.context.revision}` }))
  })
  ipcMain.handle('git-management:atlas-compare', (_event, request: GitAtlasCompareRequest) => {
    if (!request || !validScope(request.scope) || Object.keys(request).some(key => !['context', 'snapshot', 'left', 'right', 'scope'].includes(key)) ||
      ![request.snapshot, request.left, request.right].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)) return { success: false, code: 'INVALID_ARGUMENT' }
    return controller.read(request.context, service => service.compareAtlas({ ...request, contextKey: `${request.context.projectId}:${request.context.revision}` }))
  })
  ipcMain.handle('git-operations:correlation', (_event, request: GitCommitCorrelationRequest) => controller.correlation(request))
  ipcMain.handle(
    'git-management:mutate',
    (_event, request: GitMutationRequest) => controller.mutate(request)
  )
  ipcMain.handle(
    'git-management:history',
    (_event, request: GitHistoryRequest) => {
      if (
        !request ||
        Object.keys(request).some(
          (key) => !['context', 'limit', 'cursor'].includes(key)
        ) ||
        (request.cursor !== undefined && typeof request.cursor !== 'string')
      )
        return { success: false, code: 'INVALID_ARGUMENT' }
      return controller.read(request.context, (service) =>
        service.getGraphHistory({
          limit: request.limit,
          cursor: request.cursor,
          contextKey: `${request.context.projectId}:${request.context.revision}`
        })
      )
    }
  )
  ipcMain.handle(
    'git-management:overview',
    (_event, context: GitManagementContext) =>
      controller.read(context, (service) => service.getManagementOverview())
  )
  ipcMain.handle(
    'git-management:commit-detail',
    (_event, request: GitCommitRequest) => {
      if (
        !request ||
        Object.keys(request).some(
          (key) => !['context', 'sha', 'cursor'].includes(key)
        ) ||
        (request.cursor !== undefined && typeof request.cursor !== 'string')
      )
        return { success: false, code: 'INVALID_ARGUMENT' }
      return controller.read(request.context, (service) =>
        service.getCommitDetail(request)
      )
    }
  )
  ipcMain.handle('git-management:patch', (_event, request: GitPatchRequest) => {
    if (
      !request ||
      Object.keys(request).some(
        (key) => !['context', 'path', 'mode', 'sha', 'cursor'].includes(key)
      ) ||
      (request.cursor !== undefined && typeof request.cursor !== 'string')
    )
      return { success: false, code: 'INVALID_ARGUMENT' }
    return controller.read(request.context, (service) =>
      service.getManagementPatch(request)
    )
  })
}
