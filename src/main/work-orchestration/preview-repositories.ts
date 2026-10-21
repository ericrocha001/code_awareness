import { resolve } from 'node:path'
import type { RepositoryCatalogService } from '../repository-catalog/repository-catalog-service'
import type { GitOperationsService } from '../git-operations/git-operations-service'
import type { WorktreeIdentity } from '../git-operations/git-worktree-registry'
import type { BranchWorktree } from '../../shared/types/branch-orchestration-types'

export class PreviewRepositories {
  constructor(private readonly catalog: Pick<RepositoryCatalogService, 'resolveAvailable'>,
    private readonly createGit: (path: string, identity: WorktreeIdentity) => GitOperationsService) {}

  resolve(repositoryId: string) {
    const repository = this.catalog.resolveAvailable(repositoryId)
    if (repository.id !== repositoryId || repository.localCheckout?.gitState !== 'GIT') throw new Error('REPOSITORY_MISMATCH')
    const path = resolve(repository.localCheckout.path), revision = repository.updatedAt
    const guard = () => {
      const current = this.catalog.resolveAvailable(repositoryId)
      if (current.id !== repositoryId || current.localCheckout?.gitState !== 'GIT' || resolve(current.localCheckout.path) !== path || current.updatedAt !== revision) throw new Error('REPOSITORY_CONTEXT_CHANGED')
    }
    return { path, guard }
  }

  async open(repositoryId: string, worktreeId?: string) {
    const { path, guard } = this.resolve(repositoryId)
    const git = this.createGit(path, { repositoryId, isActive: () => { try { guard(); return true } catch { return false } } })
    const worktrees: BranchWorktree[] = []
    let cursor: string | undefined
    do {
      guard()
      const page = await git.discoverWorktrees({ cursor })
      if (page.repositoryId !== repositoryId) throw new Error('REPOSITORY_MISMATCH')
      worktrees.push(...page.worktrees)
      cursor = page.nextCursor ?? undefined
      if (worktreeId && page.worktrees.some(w => w.worktreeId === worktreeId)) break
    } while (cursor)
    guard()
    if (worktreeId && !worktrees.some(w => w.worktreeId === worktreeId)) throw new Error('WORKTREE_STALE')
    return { git, worktrees, guard }
  }
}
