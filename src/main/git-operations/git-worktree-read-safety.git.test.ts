import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GitService } from '../core/git-service'
import { createTempGitRepo, cleanupTempRepo, gitExec, stageAll, commit } from '../core/git-test-helpers'
import { GitOperationsService } from './git-operations-service'
import { GitHubGitTransport } from '../github/github-git-transport'
import { executeGitOperationsTool } from './git-operations-mcp'

const roots: string[] = []
const duringRead = vi.hoisted(() => ({ effect: null as (() => void) | null }))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, readSync: (...args: Parameters<typeof fs.readSync>) => {
    const result = fs.readSync(...args)
    const effect = duringRead.effect
    duringRead.effect = null
    effect?.()
    return result
  } }
})
afterEach(async () => { duringRead.effect = null; vi.restoreAllMocks(); for (const root of roots.splice(0)) await cleanupTempRepo(root) })

async function fixture() {
  const root = await createTempGitRepo(); roots.push(root)
  const parent = mkdtempSync(join(tmpdir(), 'read safety ')); roots.push(parent)
  writeFileSync(join(root, 'file.txt'), '\ufefffirst\r\nΔ 🚀 second\r\nthird\r\n')
  await stageAll(root); await commit(root, 'initial')
  const external = join(parent, 'external')
  await gitExec(root, ['worktree', 'add', '-b', 'external', external])
  writeFileSync(join(external, 'dirty.txt'), 'dirty\n')
  const git = new GitService()
  const service = new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'read-safety', isActive: () => true })
  const call = async (name: string, args = {}) => JSON.parse((await executeGitOperationsTool(service, name, args)).content[0].text)
  const id = (await call('discover_worktrees')).worktrees.find((w: any) => w.branch === 'external').worktreeId
  return { root, external, git, service, call, id }
}

describe('request-scoped worktree read safety', () => {
  it('exposes file-scoped preconditions and actionable source-free bounds', async () => {
    const f = await fixture()
    const request = { worktreeId: f.id, path: 'file.txt', startLine: 1, endLine: 3 }
    const initial = await f.call('read_worktree_file', request)
    expect(initial).toMatchObject({ fileRevision: initial.revision, revisionKind: 'FILE_BYTES_SHA256', totalLines: 3 })
    expect(await f.call('read_worktree_file', { ...request, expectedFileRevision: initial.fileRevision })).toEqual(initial)
    expect(await f.call('read_worktree_file', { ...request, expectedRevision: initial.revision, expectedFileRevision: initial.fileRevision })).toEqual(initial)
    expect(await f.call('read_worktree_file', { ...request, expectedRevision: initial.revision, expectedFileRevision: '0'.repeat(64) })).toEqual({ code: 'INVALID_ARGUMENT' })
    const inspected = await f.call('inspect_worktree', { worktreeId: f.id })
    expect(await f.call('read_worktree_file', { ...request, expectedFileRevision: inspected.worktreeRevision })).toMatchObject({ code: 'GIT_STATE_CHANGED', revisionKind: 'FILE_BYTES_SHA256' })
    const bounds = await f.call('read_worktree_file', { ...request, endLine: 90 })
    expect(bounds).toEqual({ code: 'WORKTREE_LINE_OUT_OF_BOUNDS', totalLines: 3, validRange: { startLine: 1, endLine: 3 }, maxLines: 400 })
    expect(await f.call('read_worktree_file', { ...request, startLine: 4, endLine: 5 })).toEqual(bounds)
    expect(await f.call('read_worktree_file', { ...request, endLine: bounds.totalLines })).toEqual(initial)
    writeFileSync(join(f.external, 'empty.txt'), '')
    expect(await f.call('read_worktree_file', { ...request, path: 'empty.txt', endLine: 1 })).toEqual({ code: 'WORKTREE_LINE_OUT_OF_BOUNDS', totalLines: 0, validRange: null, maxLines: 400 })
    expect(await f.call('read_worktree_file', { ...request, path: '../file.txt', endLine: 90 })).toEqual({ code: 'PATH_OUTSIDE_REPOSITORY' })
    writeFileSync(join(f.external, 'file.txt'), 'changed\n')
    expect(await f.call('read_worktree_file', { ...request, expectedFileRevision: initial.fileRevision })).toMatchObject({ code: 'GIT_STATE_CHANGED', revisionKind: 'FILE_BYTES_SHA256' })
    expect(await f.call('inspect_worktree', { worktreeId: f.id })).toMatchObject({ ownership: 'NOT_GRANTED', mutationAllowed: false })
  }, 60000)

  it('filters a ninety-change fixture before paging and binds cursors to selection and state', async () => {
    const f = await fixture()
    await gitExec(f.external, ['clean', '-f'])
    for (const directory of ['src/main/core/dash', 'src/main/core/dash-other', 'src/renderer/views']) {
      mkdirSync(join(f.external, directory), { recursive: true })
      for (let i = 0; i < 30; i++) writeFileSync(join(f.external, directory, `${String(i).padStart(2, '0')}.ts`), 'fixture\n')
    }
    await gitExec(f.external, ['add', '--', 'src/main/core/dash/00.ts'])
    const legacy = await f.call('get_worktree_changes', { worktreeId: f.id })
    expect(legacy.changes).toHaveLength(90)
    expect(legacy.nextCursor).toBeNull()
    const args = { worktreeId: f.id, pathPrefixes: ['src/main/core/dash/'], pageSize: 7 }
    let page = await f.call('get_worktree_changes', args)
    const first = page
    const selected = [...page.changes]
    while (page.nextCursor) { page = await f.call('get_worktree_changes', { ...args, cursor: page.nextCursor }); selected.push(...page.changes) }
    expect(selected).toHaveLength(30)
    expect(selected.every(change => change.path.startsWith('src/main/core/dash/'))).toBe(true)
    expect(new Set(selected.map(change => change.path)).size).toBe(30)
    expect(await f.call('get_worktree_changes', { ...args, cursor: first.nextCursor, pathPrefixes: ['src/renderer/views'] })).toMatchObject({ code: 'GIT_STATE_CHANGED' })
    expect(await f.call('get_worktree_changes', { ...args, categories: ['STAGED'] })).toMatchObject({ changes: [{ path: 'src/main/core/dash/00.ts' }], nextCursor: null })
    expect((await f.call('get_worktree_changes', { ...args, categories: ['UNTRACKED'], pageSize: 100 })).changes).toHaveLength(29)
    expect(await f.call('get_worktree_changes', { ...args, pathPrefixes: ['../outside'] })).toEqual({ code: 'PATH_OUTSIDE_REPOSITORY' })
    expect(await f.call('get_worktree_changes', { ...args, pathPrefixes: ['src/*'] })).toEqual({ code: 'INVALID_ARGUMENT' })
    expect(JSON.stringify(first)).not.toMatch(/fixture|content|patch/)
    console.log('worktree-read-precision bytes', JSON.stringify({ legacy: Buffer.byteLength(JSON.stringify(legacy)), filtered: Buffer.byteLength(JSON.stringify(await f.call('get_worktree_changes', { ...args, pageSize: 100 }))) }))
    writeFileSync(join(f.external, 'src/main/core/dash/new.ts'), 'new\n')
    expect(await f.call('get_worktree_changes', { ...args, cursor: first.nextCursor })).toMatchObject({ code: 'GIT_STATE_CHANGED' })
  }, 60000)

  it('keeps reads available before the repository has its first commit', async () => {
    const root = await createTempGitRepo(); roots.push(root)
    writeFileSync(join(root, 'file.txt'), 'unborn\r\n')
    const git = new GitService()
    const service = new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'unborn-read', isActive: () => true })
    const id = (await service.discoverWorktrees()).worktrees[0].worktreeId
    const result = await executeGitOperationsTool(service, 'inspect_worktree', { worktreeId: id })
    expect(JSON.parse(result.content[0].text)).toMatchObject({ head: null, dirty: true, untrackedCount: 1 })
    expect(await service.readWorktreeFile({ worktreeId: id, path: 'file.txt', startLine: 1, endLine: 1 })).toMatchObject({ content: 'unborn\r\n' })
  }, 60000)

  it('withholds bounds metadata when the final snapshot detects drift', async () => {
    const f = await fixture()
    const capture = f.git.captureWorktreeReadSnapshot.bind(f.git)
    let captures = 0
    vi.spyOn(f.git, 'captureWorktreeReadSnapshot').mockImplementation(async path => {
      if (++captures === 2) writeFileSync(join(f.external, 'file.txt'), 'new content\n')
      return capture(path)
    })
    const result = await f.call('read_worktree_file', { worktreeId: f.id, path: 'file.txt', startLine: 1, endLine: 90 })
    expect(result).toMatchObject({ code: 'GIT_STATE_CHANGED' })
    expect(result).not.toHaveProperty('totalLines')
    expect(result).not.toHaveProperty('content')
  }, 60000)

  it('keeps file hashes distinct from worktree revisions and preserves read-only state', async () => {
    const f = await fixture()
    const selected = await f.service.selectWorktree(f.id)
    const before = await selected.service.getState()
    const request = { worktreeId: f.id, path: 'file.txt', startLine: 1, endLine: 3 }
    const read = await f.call('read_worktree_file', request)
    expect(read.content).toBe(readFileSync(join(f.external, 'file.txt'), 'utf8'))
    expect(await f.call('read_worktree_file', { ...request, expectedRevision: read.revision })).toEqual(read)
    expect(await f.call('read_worktree_file', { ...request, expectedRevision: before.worktreeRevision })).toMatchObject({ code: 'GIT_STATE_CHANGED' })
    expect(await f.call('inspect_worktree', { worktreeId: f.id })).toMatchObject({ ...before, ownership: 'NOT_GRANTED', mutationAllowed: false })
    expect(await selected.service.getState()).toEqual(before)
  }, 60000)

  it.each(['HEAD', 'INDEX', 'DIRTY', 'UNTRACKED', 'BRANCH', 'OPERATION'])('fails closed when %s changes between reading and returning', async kind => {
    const f = await fixture()
    const original = (GitOperationsService.prototype as any).readLiteralFile
    vi.spyOn(GitOperationsService.prototype as any, 'readLiteralFile').mockImplementation(async function (this: any, request: any) {
      const value = await original.call(this, request)
      if (kind === 'HEAD') await gitExec(f.external, ['commit', '--allow-empty', '-m', 'drift'])
      if (kind === 'INDEX') await gitExec(f.external, ['add', '--', 'dirty.txt'])
      if (kind === 'DIRTY') writeFileSync(join(f.external, 'file.txt'), 'changed after read\n')
      if (kind === 'UNTRACKED') writeFileSync(join(f.external, 'new.txt'), 'new\n')
      if (kind === 'BRANCH') await gitExec(f.external, ['switch', '-c', 'same-head-new-branch'])
      if (kind === 'OPERATION') writeFileSync(join(await f.git.getWorktreeDirectory(f.external), 'MERGE_HEAD'), await f.git.getCurrentCommitHash(f.external) ?? '')
      return value
    })
    expect(await f.call('read_worktree_file', { worktreeId: f.id, path: 'file.txt', startLine: 1, endLine: 1 })).toMatchObject({ code: 'GIT_STATE_CHANGED' })
  }, 60000)

  it('rejects changes made while the file descriptor is being read', async () => {
    const f = await fixture()
    duringRead.effect = () => writeFileSync(join(f.external, 'file.txt'), 'different length while reading\n')
    expect(await f.call('read_worktree_file', { worktreeId: f.id, path: 'file.txt', startLine: 1, endLine: 1 })).toMatchObject({ code: 'GIT_STATE_CHANGED' })
  }, 60000)

  it('rechecks physical generation after the final state capture', async () => {
    const f = await fixture()
    const capture = f.git.captureWorktreeReadSnapshot.bind(f.git)
    let captures = 0
    vi.spyOn(f.git, 'captureWorktreeReadSnapshot').mockImplementation(async path => {
      const snapshot = await capture(path)
      if (++captures === 2) {
        const metadata = readFileSync(join(f.external, '.git'))
        const content = readFileSync(join(f.external, 'file.txt'))
        renameSync(f.external, f.external + ' old')
        mkdirSync(f.external)
        writeFileSync(join(f.external, '.git'), metadata)
        writeFileSync(join(f.external, 'file.txt'), content)
        writeFileSync(join(f.external, 'dirty.txt'), 'dirty\n')
      }
      return snapshot
    })
    expect(await f.call('read_worktree_file', { worktreeId: f.id, path: 'file.txt', startLine: 1, endLine: 1 })).toMatchObject({ code: 'WORKTREE_STALE' })
  }, 60000)
})
