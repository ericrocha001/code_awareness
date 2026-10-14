import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GitService } from '../core/git-service'
import { createTempGitRepo, cleanupTempRepo, gitExec, stageAll, commit } from '../core/git-test-helpers'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await cleanupTempRepo(root) })
async function legacySnapshot(git: GitService, root: string) {
  const [head, indexRevision, status, branch, operation] = await Promise.all([
    git.getCurrentCommitHash(root), git.getIndexRevision(root), git.getOperationsStatus(root, true), git.getCurrentBranch(root), git.getGitOperation(root)
  ])
  return { head, indexRevision, status, branch, operation, worktreeRevision: (git as any).worktreeRevision(root, head, indexRevision, status, true) }
}
async function equivalent(git: GitService, root: string) {
  expect(await git.captureWorktreeReadSnapshot(root)).toEqual(await legacySnapshot(git, root))
  expect(await git.getIndexRevision(root)).toBe(createHash('sha256').update(await gitExec(root, ['ls-files', '--stage', '-z'])).digest('hex'))
  const dirs = await git.getRepositoryDirectories(root)
  expect(dirs).toEqual({ common: await git.getCommonDirectory(root), admin: await git.getWorktreeDirectory(root) })
}
it('preserves exact snapshot/index semantics for unborn, linked, detached, staged/unstaged, rename and operation states', async () => {
  const root = await createTempGitRepo(); roots.push(root)
  const git = new GitService()
  writeFileSync(join(root, 'file.txt'), 'first\n')
  await equivalent(git, root)
  await stageAll(root); await equivalent(git, root); await commit(root, 'base')
  const parent = mkdtempSync(join(tmpdir(), 'snapshot economy ')); roots.push(parent)
  const linked = join(parent, 'linked')
  await gitExec(root, ['worktree', 'add', '-b', 'nested/topic', linked]); await equivalent(git, linked)
  await gitExec(linked, ['mv', 'file.txt', 'renamed.txt'])
  writeFileSync(join(linked, 'renamed.txt'), 'second\n'); writeFileSync(join(linked, 'untracked.txt'), 'third\n')
  await equivalent(git, linked)
  await gitExec(linked, ['checkout', '--detach']); await equivalent(git, linked)
  const admin = await git.getWorktreeDirectory(linked)
  for (const [marker, operation] of [['rebase-merge', 'REBASE'], ['rebase-apply', 'REBASE'], ['MERGE_HEAD', 'MERGE'], ['CHERRY_PICK_HEAD', 'CHERRY_PICK'], ['REVERT_HEAD', 'REVERT']]) {
    const target = join(admin, marker)
    if (marker.startsWith('rebase')) mkdirSync(target); else writeFileSync(target, (await git.getCurrentCommitHash(linked))! + '\n')
    expect(await git.getGitOperation(linked)).toBe(operation)
    await equivalent(git, linked)
    rmSync(target, { recursive: marker.startsWith('rebase') })
  }
}, 120000)
it('preserves unmerged index entries and reset/rebase HEAD state in real Git', async () => {
  const root = await createTempGitRepo(); roots.push(root)
  const git = new GitService()
  writeFileSync(join(root, 'file.txt'), 'base\n'); await stageAll(root); await commit(root, 'base')
  const main = (await git.getCurrentBranch(root))!, base = (await git.getCurrentCommitHash(root))!
  await gitExec(root, ['checkout', '-b', 'other'])
  writeFileSync(join(root, 'file.txt'), 'other\n'); await stageAll(root); await commit(root, 'other')
  await gitExec(root, ['checkout', main])
  writeFileSync(join(root, 'file.txt'), 'main\n'); await stageAll(root); await commit(root, 'main')
  await gitExec(root, ['merge', 'other'], { allowExitOne: true }); await equivalent(git, root)
  expect((await git.captureWorktreeReadSnapshot(root)).operation).toBe('MERGE')
  await gitExec(root, ['merge', '--abort']); await gitExec(root, ['rebase', 'other'], { allowExitOne: true })
  await equivalent(git, root); expect((await git.captureWorktreeReadSnapshot(root)).operation).toBe('REBASE')
  await gitExec(root, ['rebase', '--abort']); await gitExec(root, ['reset', '--hard', base]); await equivalent(git, root)
}, 120000)
