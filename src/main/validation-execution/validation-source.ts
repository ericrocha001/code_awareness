import { realpathSync } from 'node:fs'
import { GitService } from '../core/git-service'
import { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'
import { ownershipDigest } from '../git-operations/git-worktree-ownership'

export interface ValidationSource {
  version: 1
  repositoryId: string | null
  repositoryDirectory: string
  cwd: string
  worktreeId: string
  generation: string
  head: string
  branch: string | null
  indexRevision: string
  worktreeRevision: string
}

export async function captureValidationSource(root: string, repositoryId: string | null = null): Promise<ValidationSource> {
  const cwd = realpathSync(root)
  const git = new GitService()
  const repositoryDirectory = realpathSync(await git.getCommonDirectory(cwd))
  const registry = new GitWorktreeRegistry(cwd, git, { repositoryId: repositoryId ?? repositoryDirectory, isActive: () => true })
  const { worktrees } = await registry.discover()
  const record = worktrees.find(tree => !tree.missing && !tree.prunable && realpathSync(tree.path) === cwd)
  if (!record?.head) throw new Error('CHECKOUT_IDENTITY_UNAVAILABLE')
  const indexRevision = await git.getIndexRevision(cwd)
  const worktreeRevision = await git.getWorktreeRevision(cwd, false, true)
  const current = await registry.revalidateSelection(record.worktreeId)
  if (current.head !== record.head || current.branch !== record.branch || current.generation !== record.generation ||
    indexRevision !== await git.getIndexRevision(cwd)) throw new Error('GIT_STATE_CHANGED')
  return { version: 1, repositoryId, repositoryDirectory, cwd, worktreeId: record.worktreeId, generation: record.generation,
    head: record.head, branch: record.branch, indexRevision, worktreeRevision }
}

export function validationSourceFingerprint(source: ValidationSource): string {
  return ownershipDigest(source)
}
