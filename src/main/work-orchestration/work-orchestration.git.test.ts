import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GitService } from '../core/git-service'
import { createTempGitRepo, cleanupTempRepo, gitExec, stageAll, commit } from '../core/git-test-helpers'
import { GitOperationsService } from '../git-operations/git-operations-service'
import { GitHubGitTransport } from '../github/github-git-transport'
import { WorkOrchestrationService } from './work-orchestration-service'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await cleanupTempRepo(root) })
async function fixture() {
  const root = await createTempGitRepo(); roots.push(root)
  const parent = mkdtempSync(join(tmpdir(), 'orchestration-')); roots.push(parent)
  for (const path of ['shared.txt', 'other.txt', 'rename.txt']) writeFileSync(join(root, path), 'base\n')
  await stageAll(root); await commit(root, 'base')
  const a = join(parent, 'a'), b = join(parent, 'b')
  await gitExec(root, ['worktree', 'add', '-b', 'a', a])
  await gitExec(root, ['worktree', 'add', '--detach', b])
  const git = new GitService()
  const reader = new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'orchestration', isActive: () => true })
  return { root, parent, a, b, git, reader, service: new WorkOrchestrationService(reader) }
}
async function pairOverview(f: Awaited<ReturnType<typeof fixture>>) {
  const inventory = await f.service.inventory()
  const [a, b] = [f.a, f.b].map(path => inventory.worktrees.find(w => w.path === path)!.worktreeId)
  const pair = await f.service.pair(a, b)
  return { worktrees: inventory.worktrees.map(w => [pair.left, pair.right].find(side => side.worktreeId === w.worktreeId) ?? w),
    pairs: [pair], coverage: ['STALE', 'INDETERMINATE'].includes(pair.category) ? 'PARTIAL' : 'COMPLETE' }
}
async function editCommit(root: string, path: string, text: string) {
  writeFileSync(join(root, path), text); await stageAll(root); await commit(root, text)
}
it('uses the full pair divergence, preserves detached identity and performs no mutations', async () => {
  const f = await fixture()
  await editCommit(f.a, 'shared.txt', 'a first\n'); await editCommit(f.a, 'other.txt', 'a second\n')
  await editCommit(f.b, 'shared.txt', 'b\n')
  const before = await Promise.all([f.root, f.a, f.b].map(async path => [await f.git.captureWorktreeReadSnapshot(path), await gitExec(path, ['show-ref']), readFileSync(join(await f.git.getWorktreeDirectory(path), 'index')).toString('hex')]))
  const overview = await pairOverview(f)
  expect(overview.coverage).toBe('COMPLETE')
  expect(overview.worktrees.filter(w => w.reference)).toHaveLength(1)
  expect(overview.pairs).toHaveLength(1)
  expect(overview.pairs[0]).toMatchObject({ category: 'PATH_OVERLAP', paths: ['shared.txt'], totalPaths: 1 })
  expect(overview.worktrees.find(w => w.path === f.b)?.detached).toBe(true)
  expect(await pairOverview(f)).toEqual(overview)
  const after = await Promise.all([f.root, f.a, f.b].map(async path => [await f.git.captureWorktreeReadSnapshot(path), await gitExec(path, ['show-ref']), readFileSync(join(await f.git.getWorktreeDirectory(path), 'index')).toString('hex')]))
  expect(after).toEqual(before)
}, 30000)
it('combines staged, unstaged, untracked and both rename paths, excluding ignored files', async () => {
  const f = await fixture()
  await gitExec(f.a, ['mv', 'rename.txt', 'renamed.txt'])
  writeFileSync(join(f.a, 'shared.txt'), 'unstaged\n')
  writeFileSync(join(f.a, 'new.txt'), 'untracked\n')
  writeFileSync(join(f.a, '.gitignore'), 'ignored.txt\n'); writeFileSync(join(f.a, 'ignored.txt'), 'ignore\n')
  await editCommit(f.b, 'rename.txt', 'b rename\n')
  writeFileSync(join(f.b, 'shared.txt'), 'staged\n'); await gitExec(f.b, ['add', 'shared.txt'])
  writeFileSync(join(f.b, 'new.txt'), 'untracked\n'); writeFileSync(join(f.b, 'ignored.txt'), 'untracked\n')
  const result = await pairOverview(f)
  expect(result.pairs[0].paths).toEqual(['new.txt', 'rename.txt', 'shared.txt'])
  expect(result.worktrees.find(w => w.path === f.a)).toMatchObject({ stagedCount: 1, unstagedCount: 1, untrackedCount: 2 })
}, 30000)
it('reports verified absence and uses a pair base newer than the main checkout', async () => {
  const f = await fixture()
  await editCommit(f.a, 'shared.txt', 'common\n')
  await gitExec(f.b, ['reset', '--hard', (await gitExec(f.a, ['rev-parse', 'HEAD'])).trim()])
  const base = (await gitExec(f.a, ['rev-parse', 'HEAD'])).trim()
  await editCommit(f.a, 'other.txt', 'a\n'); await editCommit(f.b, 'rename.txt', 'b\n')
  expect((await pairOverview(f)).pairs[0]).toMatchObject({ base, category: 'NO_PATH_OVERLAP', paths: [] })
}, 30000)
it('does not invent absence for unrelated history, unborn HEAD, limits or drift', async () => {
  const f = await fixture()
  await gitExec(f.b, ['switch', '--orphan', 'unborn'])
  expect((await pairOverview(f)).pairs[0]).toMatchObject({ category: 'INDETERMINATE', reason: 'HEAD_UNAVAILABLE' })
  writeFileSync(join(f.b, 'orphan.txt'), 'orphan\n'); await stageAll(f.b); await commit(f.b, 'orphan')
  expect((await pairOverview(f)).pairs[0].category).toBe('INDETERMINATE')
  await gitExec(f.b, ['switch', '--detach', (await gitExec(f.a, ['rev-parse', 'HEAD'])).trim()])
  const read = f.reader.getCoordinationCommitPaths.bind(f.reader)
  vi.spyOn(f.reader, 'getCoordinationCommitPaths').mockImplementation(async (...args) => {
    const value = await read(...args); writeFileSync(join(f.a, 'drift.txt'), 'drift\n'); return value
  })
  expect((await pairOverview(f)).pairs[0].category).toBe('STALE')
  vi.spyOn(f.reader, 'getCoordinationCommitPaths').mockRejectedValue(new Error('GIT_OUTPUT_BYTE_LIMIT'))
  expect((await pairOverview(f)).pairs[0]).toMatchObject({ category: 'INDETERMINATE', reason: 'GIT_OUTPUT_BYTE_LIMIT' })
}, 90000)
it('keeps a complete inventory above budget, supports explicit pairs and paginates without losing count', async () => {
  const f = await fixture()
  for (let i = 0; i < 10; i++) await gitExec(f.root, ['worktree', 'add', '--detach', join(f.parent, `extra-${i}`)])
  const overview = await pairOverview(f)
  expect((await f.service.inventory()).relationsCoverage).toBe('NOT_EVALUATED')
  expect(overview.worktrees).toHaveLength(13)
  for (let i = 0; i < 105; i++) for (const path of [f.a, f.b]) writeFileSync(join(path, `common-${i}.txt`), 'new\n')
  const [a, b] = [f.a, f.b].map(path => overview.worktrees.find(w => w.path === path)!.worktreeId)
  const first = await f.service.pair(a, b)
  expect(first.totalPaths).toBe(105); expect(first.paths).toHaveLength(100)
  const second = await f.service.pair(a, b, first.nextCursor!)
  expect(second.totalPaths).toBe(105); expect(second.paths).toHaveLength(5)
  writeFileSync(join(f.a, 'common-0.txt'), 'changed size\n')
  await expect(f.service.pair(a, b, first.nextCursor!)).rejects.toThrow('GIT_STATE_CHANGED')
}, 60000)

it('includes deletions and conflicts and invalidates a worktree removed during comparison', async () => {
  const f = await fixture()
  await editCommit(f.a, 'shared.txt', 'ours\n'); await editCommit(f.b, 'shared.txt', 'theirs\n')
  await gitExec(f.b, ['merge', 'a'], { allowExitOne: true })
  await gitExec(f.a, ['rm', 'other.txt']); unlinkSync(join(f.b, 'other.txt'))
  const overview = await pairOverview(f)
  expect(overview.pairs[0].paths).toEqual(['other.txt', 'shared.txt'])
  expect(overview.worktrees.find(w => w.path === f.b)?.conflictCount).toBe(1)
  const read = f.reader.getCoordinationCommitPaths.bind(f.reader)
  vi.spyOn(f.reader, 'getCoordinationCommitPaths').mockImplementation(async (...args) => {
    const value = await read(...args)
    await gitExec(f.root, ['worktree', 'remove', '--force', f.b])
    return value
  })
  expect((await pairOverview(f)).pairs[0]).toMatchObject({ category: 'STALE', totalPaths: 0, paths: [] })
}, 60000)

it('rejects repository identity changes during observation', async () => {
  const f = await fixture()
  let active = true
  const reader = new GitOperationsService(f.root, f.git, new GitHubGitTransport(null, f.git), { repositoryId: 'correct-repository', isActive: () => active })
  const read = reader.getCoordinationCommitPaths.bind(reader)
  vi.spyOn(reader, 'getCoordinationCommitPaths').mockImplementation(async (...args) => { const value = await read(...args); active = false; return value })
  const overview = await pairOverview({ ...f, service: new WorkOrchestrationService(reader) })
  expect(overview.coverage).toBe('PARTIAL')
  expect(overview.pairs[0].category).toBe('STALE')
  await expect(reader.discoverWorktrees()).rejects.toThrow('WORKTREE_REPOSITORY_CHANGED')
}, 30000)
