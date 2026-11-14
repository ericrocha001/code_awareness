import { realpathSync } from 'node:fs'
import { GitService } from '../core/git-service'
import { GitWorktreeRegistry, type WorktreeRecord } from '../git-operations/git-worktree-registry'
import type { LocalRequestContext } from '../local-agent-channel/local-channel-types'
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

interface ValidationSourceSelection {
  git: GitService
  registry: GitWorktreeRegistry
  record: WorktreeRecord
  mark?: LocalRequestContext['markSnapshotPhase']
}

export async function captureValidationSource(root: string, repositoryId: string | null = null,
  selection?: ValidationSourceSelection): Promise<ValidationSource> {
  const mark = selection?.mark
  mark?.('registry')
  const cwd = realpathSync(root)
  const git = selection?.git ?? new GitService()
  const repositoryDirectory = realpathSync(await git.getCommonDirectory(cwd))
  const registry = selection?.registry ?? new GitWorktreeRegistry(cwd, git, { repositoryId: repositoryId ?? repositoryDirectory, isActive: () => true })
  const record = selection?.record ?? await registry.resolveCheckout(cwd)
  if (!record.head) throw new Error('CHECKOUT_IDENTITY_UNAVAILABLE')
  mark?.('index')
  const indexRevision = await git.getIndexRevision(cwd)
  mark?.('worktree')
  const worktreeRevision = await git.getWorktreeRevision(cwd, false, true)
  mark?.('revalidate')
  const current = await registry.revalidateSelection(record.worktreeId)
  if (current.head !== record.head || current.branch !== record.branch || current.generation !== record.generation ||
    indexRevision !== await git.getIndexRevision(cwd)) throw new Error('GIT_STATE_CHANGED')
  return { version: 1, repositoryId, repositoryDirectory, cwd, worktreeId: record.worktreeId, generation: record.generation,
    head: record.head, branch: record.branch, indexRevision, worktreeRevision }
}

export function validationSourceFingerprint(source: ValidationSource): string {
  return ownershipDigest(source)
}
