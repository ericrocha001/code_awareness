import { ipcMain } from 'electron'
import type { ActiveProjectService } from '../core/active-project-service'
import type { GitOperationsService } from '../git-operations/git-operations-service'
import type { GitHubIntegrationService } from '../github/github-integration-service'
import type { BranchManagerRequest, BranchManagerResult, BranchManagerData } from '../../shared/types/branch-manager-types'
import type { WorktreeRemovalPreview } from '../../shared/types/worktree-removal-types'
import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'
import { readBranchExecutions } from '../work-orchestration/branch-executions'
import type { ExecutionBindingPage, ExecutionDocumentPage } from '../../shared/types/execution-branch-types'
import { PreviewPreflightService } from '../work-orchestration/preview-preflight'
import { PreviewProfileStore } from '../work-orchestration/preview-profile-store'
import { previewFingerprint, type PreviewProfile } from '../work-orchestration/preview-profile'
import type { PreviewRepositories } from '../work-orchestration/preview-repositories'
import { previewRequestSchema, type RuntimePreviewOperations } from '../work-orchestration/runtime-preview/operations'

export class BranchOrchestrationController {
  private active: { git: GitOperationsService; github: Pick<GitHubIntegrationService, 'branchPullRequests' | 'pullRequestCommits' | 'assessBranchDiscard'>; path: string; projectId: string; revision: number } | null = null
  private readonly mutations = new Set<Promise<unknown>>()
  private readonly previewPreflight: PreviewPreflightService | undefined
  constructor(private readonly projects: Pick<ActiveProjectService, 'getState'>, private readonly confirmRelease: (preview: WorktreeRemovalPreview) => Promise<boolean>, private readonly continuum?: RepositoryContinuumSession,
    private readonly previewStore?: PreviewProfileStore, private readonly confirmProfile?: (profile: PreviewProfile) => Promise<boolean>, private readonly previewRepositories?: PreviewRepositories, private readonly runtimePreview?: RuntimePreviewOperations) {
    this.previewPreflight = runtimePreview?.preflightService ?? (previewStore ? new PreviewPreflightService(previewStore) : undefined)
  }
  bind(git: GitOperationsService, github: Pick<GitHubIntegrationService, 'branchPullRequests' | 'pullRequestCommits' | 'assessBranchDiscard'>, path: string) {
    const state = this.projects.getState()
    this.active = state.project ? { git, github, path, projectId: state.project.id, revision: state.revision } : null
  }
  async deactivate() { this.active = null; await Promise.allSettled([...this.mutations]) }
  async request(request: BranchManagerRequest): Promise<BranchManagerResult> {
    if (!valid(request)) return { success: false, code: 'INVALID_ARGUMENT' }
    const selected = this.active, { context, operation } = request
    const guard = () => {
      const state = this.projects.getState()
      if (!selected || selected !== this.active || state.project?.id !== context.projectId || state.revision !== context.revision || selected.projectId !== context.projectId || selected.revision !== context.revision) throw new Error('PROJECT_CONTEXT_CHANGED')
    }
    const run = async (): Promise<BranchManagerResult> => {
      try {
        guard()
        const { git, github, path } = selected!
        const remote = (inventory: Parameters<GitHubIntegrationService['assessBranchDiscard']>[1], branch: Parameters<GitHubIntegrationService['assessBranchDiscard']>[2]) => github.assessBranchDiscard(path, inventory, branch)
        let data: BranchManagerData
        switch (operation.action) {
          case 'PREVIEW_RUNTIME': {
            if (!this.runtimePreview) throw new Error('PREVIEW_UNAVAILABLE')
            data = { kind: 'PREVIEW_RUNTIME', result: await this.runtimePreview.handle(operation.request, guard) }; break
          }
          case 'PREVIEW_PROFILES': {
            if (!this.previewPreflight || !this.previewRepositories) throw new Error('PREVIEW_UNAVAILABLE')
            const target = this.previewRepositories.resolve(operation.repositoryId)
            data = { kind: 'PREVIEW_PROFILES', profiles: await this.previewPreflight.list(operation.repositoryId) }
            target.guard(); break
          }
          case 'PREVIEW_WORKTREES': {
            if (!this.previewRepositories) throw new Error('PREVIEW_UNAVAILABLE')
            const target = await this.previewRepositories.open(operation.repositoryId)
            data = { kind: 'PREVIEW_WORKTREES', repositoryId: operation.repositoryId, worktrees: target.worktrees }
            target.guard(); break
          }
          case 'PREVIEW_APPROVE':
          case 'PREVIEW_PREFLIGHT': {
            if (!this.previewStore || !this.previewRepositories || !this.previewPreflight) throw new Error('PREVIEW_UNAVAILABLE')
            const selection = operation.selection
            const target = await this.previewRepositories.open(selection.repositoryId, selection.worktreeId)
            const targetGuard = () => { guard(); target.guard() }
            const identity = await target.git.getCoordinationIdentity(selection.worktreeId)
            if (identity.repositoryId !== selection.repositoryId || identity.record.generation !== selection.generation) throw new Error('WORKTREE_IDENTITY_MISMATCH')
            await this.previewStore.assertExternal(identity.record.path)
            if (operation.action === 'PREVIEW_APPROVE') {
              const profile = (await this.previewStore.profiles(selection.repositoryId)).find(p => p.profileId === selection.profileId)
              if (!profile || previewFingerprint(profile) !== selection.fingerprint) throw new Error('PROFILE_CHANGED')
              targetGuard()
              await this.previewStore.approve(profile, async p => { const approved = await this.confirmProfile?.(p); targetGuard(); return approved === true }, targetGuard)
            }
            data = { kind: 'PREVIEW_PREFLIGHT', preflight: await this.previewPreflight.check(target.git, selection) }
            targetGuard(); break
          }
          case 'INVENTORY': data = { kind: 'INVENTORY', inventory: await git.getBranchInventory() }; break
          case 'EXECUTIONS': data = { kind: 'EXECUTIONS', page: await readBranchExecutions(git, this.continuum, operation) as ExecutionBindingPage }; break
          case 'EXECUTION_DOCUMENTS': data = { kind: 'EXECUTION_DOCUMENTS', page: await readBranchExecutions(git, this.continuum, operation) as ExecutionDocumentPage }; break
          case 'PULL_REQUESTS': {
            const inventory = await git.getBranchInventory()
            if (inventory.revision !== operation.inventoryRevision) throw new Error('GIT_STATE_CHANGED')
            const pullRequests = await github.branchPullRequests(path, inventory)
            if ((await git.getBranchInventory()).revision !== inventory.revision) throw new Error('GIT_STATE_CHANGED')
            data = { kind: 'PULL_REQUESTS', pullRequests, inventoryRevision: inventory.revision }; break
          }
          case 'COMMITS': data = { kind: 'COMMITS', page: await git.getBranchCommits(operation.query) }; break
          case 'PR_COMMITS': data = { kind: 'PR_COMMITS', page: await github.pullRequestCommits(path, operation.number, operation.head, operation.page) }; break
          case 'PREPARE_DISCARD': data = { kind: 'DISCARD_PREVIEW', preview: await git.prepareBranchDiscard(operation.ref, operation.revision, operation.baseRef, remote) }; break
          case 'EXECUTE_DISCARD': data = { kind: 'MUTATION', result: await git.executeBranchDiscard(operation.request, remote, guard) }; break
          case 'PREPARE_REMOVAL': data = { kind: 'REMOVAL_PREVIEW', preview: await git.prepareWorktreeRemoval(operation.worktreeId, operation.generation) }; break
          case 'EXECUTE_REMOVAL': data = { kind: 'MUTATION', result: await git.executeWorktreeRemoval(operation.request, this.confirmRelease, guard) }; break
        }
        guard()
        return { success: true, context, data }
      } catch (error) { return { success: false, code: error instanceof Error ? error.message : 'BRANCH_MANAGER_UNAVAILABLE' } }
    }
    const promise = run()
    if (operation.action.startsWith('EXECUTE_') || operation.action === 'PREVIEW_APPROVE') {
      this.mutations.add(promise)
      void promise.finally(() => this.mutations.delete(promise))
    }
    return promise
  }
}

function valid(value: BranchManagerRequest): boolean {
  const keys = (object: unknown, allowed: string[]) => !!object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(k => allowed.includes(k))
  const text = (value: unknown, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value)
  if (!keys(value, ['context', 'operation']) || !keys(value.context, ['projectId', 'revision']) || !text(value.context.projectId) || !Number.isSafeInteger(value.context.revision) || value.context.revision < 0) return false
  const op = value.operation
  if (!op || typeof op !== 'object') return false
  if (op.action === 'PREVIEW_RUNTIME') return keys(op, ['action', 'request']) && previewRequestSchema.safeParse(op.request).success
  if (op.action === 'PREVIEW_PROFILES' || op.action === 'PREVIEW_WORKTREES') return keys(op, ['action', 'repositoryId']) && text(op.repositoryId)
  if (op.action === 'PREVIEW_PREFLIGHT' || op.action === 'PREVIEW_APPROVE') return keys(op, ['action', 'selection']) && keys(op.selection, ['repositoryId', 'worktreeId', 'generation', 'profileId', 'fingerprint']) && [op.selection.repositoryId, op.selection.worktreeId, op.selection.generation, op.selection.profileId, op.selection.fingerprint].every(v => text(v))
  if (op.action === 'INVENTORY') return keys(op, ['action'])
  if (op.action === 'EXECUTIONS' || op.action === 'EXECUTION_DOCUMENTS') return keys(op, ['action', 'ref', 'revision', 'cursor', ...(op.action === 'EXECUTION_DOCUMENTS' ? ['bindingId', 'executionId'] : [])]) && text(op.ref) && text(op.revision) && (op.cursor === undefined || text(op.cursor, 4096)) && (op.action === 'EXECUTIONS' || text(op.bindingId) && text(op.executionId))
  if (op.action === 'PULL_REQUESTS') return keys(op, ['action', 'inventoryRevision']) && text(op.inventoryRevision)
  if (op.action === 'PR_COMMITS') return keys(op, ['action', 'number', 'head', 'page']) && Number.isSafeInteger(op.number) && op.number > 0 && /^[a-f0-9]{40,64}$/.test(op.head) && Number.isSafeInteger(op.page) && op.page > 0 && op.page <= 1000
  if (op.action === 'COMMITS') return keys(op, ['action', 'query']) && keys(op.query, ['ref', 'revision', 'mode', 'baseRef', 'cursor']) && text(op.query.ref) && text(op.query.revision) && ['REACHABLE', 'EXCLUSIVE'].includes(op.query.mode) && (op.query.baseRef === undefined || text(op.query.baseRef)) && (op.query.cursor === undefined || text(op.query.cursor, 4096))
  if (op.action === 'PREPARE_DISCARD') return keys(op, ['action', 'ref', 'revision', 'baseRef']) && [op.ref, op.revision, op.baseRef].every(v => text(v))
  if (op.action === 'PREPARE_REMOVAL') return keys(op, ['action', 'worktreeId', 'generation']) && /^[a-f0-9]{64}$/.test(op.worktreeId) && text(op.generation)
  if (op.action === 'EXECUTE_DISCARD' || op.action === 'EXECUTE_REMOVAL') {
    const r = op.request
    if (!keys(op, ['action', 'request']) || !text(r?.previewId) || !text(r?.operationId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(r.operationId)) return false
    return op.action === 'EXECUTE_DISCARD' ? keys(r, ['previewId', 'operationId', 'confirmed', 'preserveExclusive']) && op.request.confirmed === true && typeof op.request.preserveExclusive === 'boolean' : keys(r, ['previewId', 'operationId', 'releasedByUser']) && op.request.releasedByUser === true
  }
  return false
}
export function registerBranchOrchestrationHandlers(controller: BranchOrchestrationController) {
  ipcMain.handle('work-orchestration:branches', (_event, request: BranchManagerRequest) => controller.request(request))
}
