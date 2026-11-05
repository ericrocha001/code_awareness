import type { BranchInventory } from '../../../shared/types/branch-orchestration-types'
import type {
  BuildXInspectWorkspaceResult,
  BuildXWorkspaceBindingRecord
} from '../../../shared/types/buildx/workspace-types'
import {
  SmcInvalidSessionIdError,
  SmcSessionClosedError,
  SmcSessionNotFoundError
} from '../smc/session-memory-central-store'
import { validateRepositoryId } from '../smc/session-memory-central-paths'
import type { SessionMemoryCentralService } from '../smc/session-memory-central-service'
import { SessionMemoryCentralService as SmcServiceImpl } from '../smc/session-memory-central-service'
import {
  BuildXWorkspaceInvalidError,
  BuildXWorkspaceNotFoundError,
  BuildXWorkspaceRepositoryMismatchError
} from './workspace-binding-errors'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface GitOperationsPort {
  getBranchInventory(): Promise<BranchInventory>
  isReference?(worktreeId: string): boolean
}

export type GitOperationsResolver =
  | GitOperationsPort
  | ((repositoryId: string) => GitOperationsPort | Promise<GitOperationsPort>)

export class WorkspaceBindingService {
  private readonly smcService: SessionMemoryCentralService
  private readonly ownsService: boolean

  constructor(
    serviceOrBaseDir: SessionMemoryCentralService | string,
    private readonly gitOperations: GitOperationsResolver
  ) {
    if (typeof serviceOrBaseDir === 'string') {
      this.smcService = new SmcServiceImpl(serviceOrBaseDir)
      this.ownsService = true
    } else {
      this.smcService = serviceOrBaseDir
      this.ownsService = false
    }
  }

  private async resolveGitPort(repositoryId: string): Promise<GitOperationsPort> {
    if (typeof this.gitOperations === 'function') {
      return await this.gitOperations(repositoryId)
    }
    return this.gitOperations
  }

  async bindWorkspace(
    repositoryId: string,
    sessionId: string,
    worktreeId: string
  ): Promise<BuildXWorkspaceBindingRecord> {
    const validRepoId = validateRepositoryId(repositoryId)
    if (typeof sessionId !== 'string' || !sessionId.trim() || !UUID_REGEX.test(sessionId.trim())) {
      throw new SmcInvalidSessionIdError(sessionId ?? '')
    }
    const cleanSessionId = sessionId.trim().toLowerCase()

    if (typeof worktreeId !== 'string' || !worktreeId.trim()) {
      throw new BuildXWorkspaceInvalidError('worktreeId must be a non-empty string')
    }
    const cleanWorktreeId = worktreeId.trim()

    // 1. Revalidação antes da chamada assíncrona do Git
    const sessionBefore = this.smcService.getSession(validRepoId, cleanSessionId)
    if (!sessionBefore) {
      throw new SmcSessionNotFoundError(cleanSessionId)
    }
    if (sessionBefore.status === 'CLOSED') {
      throw new SmcSessionClosedError(cleanSessionId)
    }

    // 2. Consulta assíncrona ao Git Operations
    const gitPort = await this.resolveGitPort(validRepoId)
    const inventory = await gitPort.getBranchInventory()

    // 3. Revalidação após chamada assíncrona do Git
    if (!inventory || typeof inventory !== 'object' || inventory.repositoryId !== validRepoId) {
      throw new BuildXWorkspaceRepositoryMismatchError(validRepoId, inventory?.repositoryId ?? 'unknown')
    }

    const sessionAfter = this.smcService.getSession(validRepoId, cleanSessionId)
    if (!sessionAfter) {
      throw new SmcSessionNotFoundError(cleanSessionId)
    }
    if (sessionAfter.status === 'CLOSED') {
      throw new SmcSessionClosedError(cleanSessionId)
    }

    // 4. Localização e validação da Worktree no inventário
    const worktree = inventory.worktrees.find(w => w.worktreeId === cleanWorktreeId)
    if (!worktree) {
      throw new BuildXWorkspaceNotFoundError(cleanWorktreeId)
    }

    // Checkout de referência principal
    const isRef =
      (worktree as any).reference === true ||
      (worktree as any).isReference === true ||
      (gitPort.isReference && gitPort.isReference(cleanWorktreeId)) === true

    if (isRef) {
      throw new BuildXWorkspaceInvalidError('Cannot bind primary or reference worktree checkout')
    }

    if (worktree.missing === true) {
      throw new BuildXWorkspaceInvalidError(`Worktree "${cleanWorktreeId}" is missing on disk`)
    }
    if (worktree.locked === true) {
      throw new BuildXWorkspaceInvalidError(`Worktree "${cleanWorktreeId}" is locked`)
    }
    if (worktree.prunable === true) {
      throw new BuildXWorkspaceInvalidError(`Worktree "${cleanWorktreeId}" is prunable`)
    }
    if (worktree.detached === true) {
      throw new BuildXWorkspaceInvalidError(`Worktree "${cleanWorktreeId}" is in detached HEAD state`)
    }
    if (!worktree.generation || worktree.generation === 'UNKNOWN') {
      throw new BuildXWorkspaceInvalidError(`Worktree "${cleanWorktreeId}" has invalid or UNKNOWN generation`)
    }
    if (!worktree.branch || typeof worktree.branch !== 'string' || !worktree.branch.trim()) {
      throw new BuildXWorkspaceInvalidError(`Worktree "${cleanWorktreeId}" has no active branch`)
    }
    if (!worktree.head || typeof worktree.head !== 'string' || !worktree.head.trim()) {
      throw new BuildXWorkspaceInvalidError(`Worktree "${cleanWorktreeId}" has no confirmed HEAD commit`)
    }

    // Garantir branch local do inventário vinculada exatamente à identidade Worktree+generation observada
    const localBranch = inventory.branches.find(
      b => b.namespace === 'LOCAL' && (b.name === worktree.branch || b.ref === `refs/heads/${worktree.branch}`)
    )
    if (!localBranch) {
      throw new BuildXWorkspaceInvalidError(`Worktree branch "${worktree.branch}" is not a verified local branch in inventory`)
    }
    const isLinked = localBranch.worktrees.some(
      bw => bw.worktreeId === cleanWorktreeId && bw.generation === worktree.generation
    )
    if (!isLinked) {
      throw new BuildXWorkspaceInvalidError(
        `Branch "${worktree.branch}" is not linked to worktree "${cleanWorktreeId}" with generation "${worktree.generation}"`
      )
    }

    // 5. Persiste vínculo durável no SMC
    return this.smcService.saveWorkspaceBinding(validRepoId, cleanSessionId, {
      repositoryId: validRepoId,
      worktreeId: cleanWorktreeId,
      generation: worktree.generation,
      branch: worktree.branch,
      headAtBind: worktree.head
    })
  }

  async inspectBoundWorkspace(
    repositoryId: string,
    sessionId: string
  ): Promise<BuildXInspectWorkspaceResult> {
    const validRepoId = validateRepositoryId(repositoryId)
    if (typeof sessionId !== 'string' || !sessionId.trim() || !UUID_REGEX.test(sessionId.trim())) {
      throw new SmcInvalidSessionIdError(sessionId ?? '')
    }
    const cleanSessionId = sessionId.trim().toLowerCase()

    const session = this.smcService.getSession(validRepoId, cleanSessionId)
    if (!session) {
      throw new SmcSessionNotFoundError(cleanSessionId)
    }

    const binding = this.smcService.getWorkspaceBinding(validRepoId, cleanSessionId)
    if (!binding) {
      return { status: 'UNBOUND' }
    }

    let inventory: BranchInventory
    try {
      const gitPort = await this.resolveGitPort(validRepoId)
      inventory = await gitPort.getBranchInventory()
    } catch (error: any) {
      return {
        status: 'UNAVAILABLE',
        binding,
        reason: error?.message || 'GIT_INVENTORY_UNAVAILABLE'
      }
    }

    if (!inventory || inventory.repositoryId !== validRepoId) {
      return {
        status: 'UNAVAILABLE',
        binding,
        reason: 'REPOSITORY_CONTEXT_CHANGED'
      }
    }

    const worktree = inventory.worktrees.find(w => w.worktreeId === binding.worktreeId)
    if (!worktree) {
      return {
        status: 'STALE',
        binding,
        reason: 'WORKTREE_NOT_FOUND'
      }
    }
    if (worktree.missing === true) {
      return {
        status: 'STALE',
        binding,
        reason: 'WORKTREE_MISSING'
      }
    }
    if (worktree.generation !== binding.generation) {
      return {
        status: 'STALE',
        binding,
        reason: 'GENERATION_CHANGED'
      }
    }
    if (worktree.branch !== binding.branch) {
      return {
        status: 'STALE',
        binding,
        reason: 'BRANCH_CHANGED'
      }
    }
    if (worktree.detached === true) {
      return {
        status: 'STALE',
        binding,
        reason: 'DETACHED_HEAD'
      }
    }

    return {
      status: 'CURRENT',
      binding,
      currentHead: worktree.head ?? binding.headAtBind
    }
  }

  getWorkspaceBinding(
    repositoryId: string,
    sessionId: string
  ): BuildXWorkspaceBindingRecord | null {
    const validRepoId = validateRepositoryId(repositoryId)
    return this.smcService.getWorkspaceBinding(validRepoId, sessionId)
  }

  close(): void {
    if (this.ownsService) {
      this.smcService.close()
    }
  }
}
