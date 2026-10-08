import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GitService } from '../core/git-service'
import { createTempGitRepo, cleanupTempRepo, gitExec, stageAll, commit } from '../core/git-test-helpers'
import { GitOperationsService } from './git-operations-service'
import { GitHubGitTransport } from '../github/github-git-transport'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await cleanupTempRepo(root) })
async function fixture() {
  const root = await createTempGitRepo(); roots.push(root)
  await gitExec(root, ['config', 'core.autocrlf', 'false'])
  const parent = mkdtempSync(join(tmpdir(), 'structural capture ')); roots.push(parent)
  writeFileSync(join(root, 'file.ts'), '\ufeffexport function value() { return "Δ 🚀" }\r\n')
  await stageAll(root); await commit(root, 'base')
  const git = new GitService()
  const base = await git.getCurrentCommitHash(root)
  const a = join(parent, 'a'); const b = join(parent, 'b')
  await gitExec(root, ['worktree', 'add', '-b', 'a', a]); await gitExec(root, ['worktree', 'add', '-b', 'b', b])
  writeFileSync(join(a, 'file.ts'), 'export function value(x: number) { return x }\n')
  await stageAll(a); await commit(a, 'a committed')
  writeFileSync(join(a, 'file.ts'), 'export function value(x: number) { return x + 1 }\n')
  writeFileSync(join(b, 'file.ts'), 'export function value() { return "B" }\n'); await stageAll(b)
  writeFileSync(join(root, 'file.ts'), 'canonical dirty must not leak\n')
  const service = new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'generic-app', isActive: () => true })
  const worktrees = (await service.discoverWorktrees()).worktrees
  return { root, a, b, base, git, service, aId: worktrees.find(w => w.branch === 'a')!.worktreeId, bId: worktrees.find(w => w.branch === 'b')!.worktreeId }
}
describe('secure structural capture', () => {
  it('selects merge-base and exact bytes independently for divergent dirty worktrees without writing', async () => {
    const f = await fixture()
    const before = await f.git.captureWorktreeReadSnapshot(f.a)
    const [a, b] = await Promise.all([f.service.captureWorktreeStructure({ worktreeId: f.aId, paths: ['file.ts'] }, async c => c), f.service.captureWorktreeStructure({ worktreeId: f.bId, paths: ['file.ts'] }, async c => c)])
    expect(a.baseCommit).toBe(f.base); expect(b.baseCommit).toBe(f.base)
    expect(a.files[0].base?.content).toBe('\ufeffexport function value() { return "Δ 🚀" }\r\n')
    expect(a.files[0].committedStatus).toBe('M')
    expect(a.files[0].current?.content).toContain('x + 1')
    expect(b.files[0].current?.content).toContain('"B"')
    expect(b.files[0].change?.stagedState).toBe('M')
    expect(await f.git.captureWorktreeReadSnapshot(f.a)).toEqual(before)
  }, 60000)
  it('rejects content and Git drift during processing, unsafe paths and symbolic bases', async () => {
    const f = await fixture()
    await expect(f.service.captureWorktreeStructure({ worktreeId: f.aId, paths: ['file.ts'] }, async () => { writeFileSync(join(f.a, 'file.ts'), 'drift'); return 'invalid' })).rejects.toMatchObject({ code: 'GIT_STATE_CHANGED' })
    await expect(f.service.captureWorktreeStructure({ worktreeId: f.bId, paths: ['file.ts'] }, async () => { await gitExec(f.b, ['reset']); return 'invalid' })).rejects.toMatchObject({ code: 'GIT_STATE_CHANGED' })
    await expect(f.service.captureWorktreeStructure({ worktreeId: f.aId, paths: ['file.ts'] }, async () => { await gitExec(f.root, ['commit', '--allow-empty', '-m', 'canonical head drift']); return 'invalid' })).rejects.toMatchObject({ code: 'GIT_STATE_CHANGED' })
    for (const path of ['../file.ts', '.git/config', 'C:/file.ts', 'file.ts:other']) await expect(f.service.captureWorktreeStructure({ worktreeId: f.aId, paths: [path] }, async c => c)).rejects.toBeDefined()
    await expect(f.service.captureWorktreeStructure({ worktreeId: f.aId, paths: ['file.ts'], baseCommit: 'HEAD' }, async c => c)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  }, 60000)
  it('bounds files, rejects binary and irregular contents, and revalidates a replaced physical worktree', async () => {
    const f = await fixture()
    writeFileSync(join(f.a, 'binary.bin'), Buffer.from([0, 1, 2]))
    writeFileSync(join(f.a, 'large.txt'), 'a'.repeat(1048577))
    mkdirSync(join(f.a, 'directory'))
    symlinkSync(f.b, join(f.a, 'junction'), 'junction')
    for (const [path, code] of [['binary.bin', 'WORKTREE_FILE_BINARY'], ['large.txt', 'WORKTREE_FILE_BYTE_LIMIT'], ['directory', 'WORKTREE_FILE_UNSUPPORTED'], ['junction/file.ts', 'PATH_OUTSIDE_REPOSITORY']]) {
      await expect(f.service.captureWorktreeStructure({ worktreeId: f.aId, paths: [path] }, async c => c)).rejects.toMatchObject({ code })
    }
    await expect(f.service.captureWorktreeStructure({ worktreeId: f.aId, paths: ['file.ts'] }, async c => {
      const metadata = readFileSync(join(f.a, '.git'))
      renameSync(f.a, f.a + ' old'); mkdirSync(f.a); writeFileSync(join(f.a, '.git'), metadata)
      writeFileSync(join(f.a, 'file.ts'), c.files[0].current!.content)
      return c
    })).rejects.toBeDefined()
  }, 60000)
  it('reports an unavailable base for unborn and unrelated histories and accepts an exact same-repository base', async () => {
    const root = await createTempGitRepo(); roots.push(root)
    const git = new GitService(); const service = new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'unborn', isActive: () => true })
    writeFileSync(join(root, 'file.txt'), 'unborn\n')
    const id = (await service.discoverWorktrees()).worktrees[0].worktreeId
    const capture = await service.captureWorktreeStructure({ worktreeId: id, paths: ['file.txt'] }, async c => c)
    expect(capture).toMatchObject({ baseCommit: null, baseSelection: 'UNAVAILABLE' })
    const f = await fixture()
    const explicit = await f.service.captureWorktreeStructure({ worktreeId: f.aId, paths: ['file.ts'], baseCommit: f.base! }, async c => c)
    expect(explicit.baseSelection).toBe('EXPLICIT')
    await gitExec(f.b, ['checkout', '--orphan', 'unrelated']); await gitExec(f.b, ['rm', '-rf', '.'])
    writeFileSync(join(f.b, 'file.ts'), 'export const separate = 1\n'); await stageAll(f.b); await commit(f.b, 'unrelated root')
    await f.service.discoverWorktrees()
    expect(await f.service.captureWorktreeStructure({ worktreeId: f.bId, paths: ['file.ts'] }, async c => c)).toMatchObject({ baseCommit: null, baseSelection: 'UNAVAILABLE' })
  }, 60000)
})
