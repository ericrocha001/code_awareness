import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { GitService } from '../core/git-service'
import type { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'
import type { CliResolvedWorktree, CliWorktreeSelector } from './cli-execution-types'

export async function resolveCliWorktree(
  registry: GitWorktreeRegistry,
  git: GitService,
  selector: CliWorktreeSelector
): Promise<CliResolvedWorktree> {
  if (!selector || Object.keys(selector).some(key => !['worktreeId', 'generation'].includes(key)) ||
    !/^[a-f0-9]{64}$/.test(selector.worktreeId) || !/^[a-f0-9]{64}$/.test(selector.generation)) {
    throw new Error('INVALID_WORKTREE_SELECTOR')
  }
  const { worktreeId, generation } = selector
  const select = async () => {
    const record = await registry.revalidateSelection(worktreeId)
    if (record.generation !== generation) throw new Error('WORKTREE_STALE')
    if (record.locked) throw new Error('WORKTREE_LOCKED')
    return record
  }
  const initial = await select()
  const directory = realpathSync(initial.path)
  const capture = async () => {
    const before = await select()
    if (realpathSync(before.path) !== directory) throw new Error('WORKTREE_IDENTITY_MISMATCH')
    const snapshot = await git.captureWorktreeReadSnapshot(directory)
    const after = await select()
    const head = after.head && !/^0+$/.test(after.head) ? after.head : null
    if (before.head !== after.head || before.branch !== after.branch || head !== snapshot.head ||
      after.branch !== snapshot.branch || realpathSync(after.path) !== directory) throw new Error('WORKTREE_STALE')
    if (snapshot.operation) throw new Error('GIT_OPERATION_IN_PROGRESS')
    return { worktreeId, generation, head, branch: snapshot.branch, indexRevision: snapshot.indexRevision }
  }
  const identity = await capture()
  const fingerprint = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  return {
    directory,
    identity,
    getFingerprint: async () => {
      const current = createHash('sha256').update(JSON.stringify(await capture())).digest('hex')
      if (current !== fingerprint) throw new Error('WORKTREE_STALE')
      return current
    }
  }
}
