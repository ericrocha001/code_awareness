import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitWorktreeLifecycle } from './git-worktree-lifecycle'
import { GitService } from '../core/git-service'
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it('does not materialize managed metadata when only reading an absent record', () => {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-read-')); roots.push(root)
  const lifecycle = new GitWorktreeLifecycle(root), worktreeId = 'a'.repeat(64)
  expect(lifecycle.get({ worktreeId } as any)).toBeNull()
  expect(lifecycle.closed(worktreeId)).toBeNull()
  expect(existsSync(join(root, 'code-awareness-managed-worktrees'))).toBe(false)
})
it('disables optional status writes in diagnostic and validation fingerprint reads', async () => {
  const git = new GitService()
  vi.spyOn(git, 'getCurrentCommitHash').mockResolvedValue('a'.repeat(40))
  vi.spyOn(git, 'getIndexRevision').mockResolvedValue('index')
  const status = vi.spyOn(git, 'getOperationsStatus').mockResolvedValue('')
  vi.spyOn(git as any, 'worktreeRevision').mockReturnValue('revision')
  expect(await git.getWorktreeRevision('/unused', true)).toBe('revision')
  expect(await git.getWorktreeRevision('/unused', false, true)).toBe('revision')
  expect(status.mock.calls.every(([, readOnly]) => readOnly === true)).toBe(true)
})
