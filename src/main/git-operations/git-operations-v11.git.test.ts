import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import * as fs from 'fs'
import { basename, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitService } from '../core/git-service'
import { cleanupTempRepo, commit, createTempGitRepo, gitExec, stageAll, writeFile } from '../core/git-test-helpers'
import { GitHubGitTransport } from '../github/github-git-transport'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { createMcpHttpServer } from '../mcp/mcp-http-server'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import { executeGitOperationsTool as dispatchGitOperationsTool } from './git-operations-mcp'
import { randomUUID } from 'node:crypto'
import { isReceiptedGitMutation } from './git-operation-receipts'
import { GitOperationsService } from './git-operations-service'

vi.mock('fs', async (importOriginal) => ({ ...await importOriginal<typeof import('fs')>() }))

const roots: string[] = []
const executeGitOperationsTool = (service: GitOperationsService, name: string, args: Record<string, unknown>) => dispatchGitOperationsTool(service, name, isReceiptedGitMutation(name, args) ? { ...args, operationId: randomUUID() } : args)
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await cleanupTempRepo(root) })
async function fixture(files: Record<string, string | Buffer> = { 'a.txt': 'base\n', 'b.txt': 'base\n' }) {
  const root = await createTempGitRepo(); roots.push(root)
  await gitExec(root, ['config', 'core.autocrlf', 'false'])
  await gitExec(root, ['branch', '-m', 'main'])
  for (const [path, bytes] of Object.entries(files)) writeFileSync(join(root, path), bytes)
  await stageAll(root); await commit(root, 'base')
  const git = new GitService()
  return { root, git, service: new GitOperationsService(root, git, new GitHubGitTransport(null, git)) }
}
async function conflicts(files: Record<string, string | Buffer>, ours: Record<string, string | Buffer | null>, theirs: Record<string, string | Buffer | null>) {
  const fixtureResult = await fixture(files)
  const { root, service } = fixtureResult
  await service.manageBranch({ action: 'CREATE', branch: 'other', expectedHead: (await service.getState()).head })
  await service.manageBranch({ action: 'SWITCH', branch: 'other' })
  for (const [path, bytes] of Object.entries(theirs)) {
    if (bytes === null) await gitExec(root, ['rm', '--', path])
    else writeFileSync(join(root, path), bytes)
  }
  await stageAll(root); await commit(root, 'theirs')
  const otherHead = (await service.getState()).head
  await service.manageBranch({ action: 'SWITCH', branch: 'main' })
  for (const [path, bytes] of Object.entries(ours)) {
    if (bytes === null) await gitExec(root, ['rm', '--', path])
    else writeFileSync(join(root, path), bytes)
  }
  await stageAll(root); await commit(root, 'ours')
  const ourHead = (await service.getState()).head
  expect(await service.merge({ action: 'MERGE', source: 'other', mode: 'MERGE', expectedHead: ourHead })).toMatchObject({ result: 'CONFLICTS' })
  return { ...fixtureResult, ourHead, otherHead }
}

describe('Git Operations v1.1 safe shelving', () => {
  it('keeps public CREATE successful across post-commit concurrency and cleanup failure', async () => {
    const { root, git, service } = await fixture()
    writeFile(root, 'a.txt', 'selected literal ç🙂\r\n')
    const observed = await service.getState()
    const lockPath = join(root, '.git', 'index.lock')
    const rename = fs.renameSync
    const remove = fs.rmSync
    const revision = git.getWorktreeRevision.bind(git)
    let committed = false
    let temporary: string | undefined
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to)
      if (resolve(String(to)).toLowerCase() === resolve(root, '.git', 'index').toLowerCase()) {
        committed = true
        writeFile(root, 'b.txt', 'concurrent actor after commit\n')
        writeFileSync(lockPath, 'another Git owner')
      }
    })
    vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (committed && basename(String(path)).startsWith('git-operations-index-')) {
        temporary = String(path)
        throw new Error('GIT_STATE_CHANGED')
      }
      remove(path, options)
    })
    vi.spyOn(git, 'getWorktreeRevision').mockImplementation((...args) => committed ? Promise.reject(new Error('GIT_STATE_CHANGED')) : revision(...args))
    try {
      const reply = await executeGitOperationsTool(service, 'manage_git_shelf', { action: 'CREATE', paths: ['a.txt'], expectedWorktreeRevision: observed.worktreeRevision })
      expect(committed).toBe(true)
      expect(await service.manageShelf({ action: 'LIST' })).toEqual([expect.objectContaining({ pathCount: 1 })])
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('base\n')
      expect(reply.isError).not.toBe(true)
      const created = JSON.parse(reply.content[0].text)
      expect(created).toMatchObject({ pathCount: 1, observation: { status: 'UNAVAILABLE', code: 'GIT_STATE_CHANGED' } })
      expect(readFileSync(lockPath, 'utf8')).toBe('another Git owner')
      expect(warning).toHaveBeenCalled()
      vi.restoreAllMocks()
      remove(lockPath, { force: true })
      const state = await service.getState()
      expect(await service.manageShelf({ action: 'RESTORE', shelfId: created.shelfId, expectedHead: state.head, expectedWorktreeRevision: state.worktreeRevision })).toMatchObject({ result: 'RESTORED' })
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('selected literal ç🙂\r\n')
      expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('concurrent actor after commit\n')
    } finally {
      vi.restoreAllMocks()
      remove(lockPath, { force: true })
      if (temporary) remove(temporary, { recursive: true, force: true })
    }
  }, 60000)

  it('reports completed CREATE and RESTORE even when post-mutation observation fails', async () => {
    const { root, git, service } = await fixture()
    writeFile(root, 'a.txt', 'staged\n'); await service.stage({ mode: 'STAGE', paths: ['a.txt'] })
    writeFile(root, 'a.txt', 'literal ç🙂\r\nunstaged\n')
    writeFile(root, 'new.txt', 'untracked\r\n')
    const bytes = readFileSync(join(root, 'a.txt'))
    const changes = await service.getChanges()
    const observed = await service.getState()
    const create = git.createShelf.bind(git)
    const revision = vi.spyOn(git, 'getWorktreeRevision')
    const createSpy = vi.spyOn(git, 'createShelf').mockImplementation(async (...args) => {
      const shelf = await create(...args)
      revision.mockRejectedValueOnce(new Error('GIT_STATE_CHANGED'))
      return shelf
    })
    const reply = await executeGitOperationsTool(service, 'manage_git_shelf', { action: 'CREATE', paths: ['a.txt', 'new.txt'], expectedWorktreeRevision: observed.worktreeRevision })
    expect(reply.isError).not.toBe(true)
    const created = JSON.parse(reply.content[0].text)
    expect(created).toMatchObject({ pathCount: 2, baseHead: observed.head, worktreeRevision: null, observation: { status: 'UNAVAILABLE', code: 'GIT_STATE_CHANGED' } })
    createSpy.mockRestore(); revision.mockRestore()
    if (!('shelfId' in created)) throw new Error('Missing shelf')
    expect(await service.getChanges()).toEqual([])
    expect(await service.manageShelf({ action: 'LIST' })).toEqual([expect.objectContaining({ shelfId: created.shelfId, pathCount: 2 })])
    const clean = await service.getState()
    const stateSpy = vi.spyOn(service, 'getState').mockRejectedValueOnce(new Error('GIT_STATE_CHANGED'))
    const restoreReply = await executeGitOperationsTool(service, 'manage_git_shelf', { action: 'RESTORE', shelfId: created.shelfId, expectedHead: clean.head, expectedWorktreeRevision: clean.worktreeRevision })
    expect(restoreReply.isError).not.toBe(true)
    const restored = JSON.parse(restoreReply.content[0].text)
    expect(restored).toMatchObject({ result: 'RESTORED', shelfId: created.shelfId, worktreeRevision: null, observation: { status: 'UNAVAILABLE', code: 'GIT_STATE_CHANGED' } })
    stateSpy.mockRestore()
    expect(await service.getChanges()).toEqual(changes)
    expect(readFileSync(join(root, 'a.txt'))).toEqual(bytes)
    expect(await gitExec(root, ['show', ':a.txt'])).toBe('staged\n')
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('untracked\r\n')
    expect(await service.manageShelf({ action: 'LIST' })).toHaveLength(1)
    const current = await service.getState()
    vi.spyOn(git, 'createShelf').mockRejectedValueOnce(new Error('mutation failed'))
    const failedCreate = await executeGitOperationsTool(service, 'manage_git_shelf', { action: 'CREATE', paths: ['a.txt', 'new.txt'], expectedWorktreeRevision: current.worktreeRevision })
    expect(failedCreate).toMatchObject({ isError: true })
    expect(JSON.parse(failedCreate.content[0].text)).toMatchObject({ code: 'OPERATION_OUTCOME_UNKNOWN' })
    vi.spyOn(git, 'restoreShelf').mockRejectedValueOnce(new Error('mutation failed'))
    const failedRestore = await executeGitOperationsTool(service, 'manage_git_shelf', { action: 'RESTORE', shelfId: created.shelfId, expectedHead: current.head, expectedWorktreeRevision: current.worktreeRevision })
    expect(failedRestore).toMatchObject({ isError: true })
    expect(JSON.parse(failedRestore.content[0].text)).toMatchObject({ code: 'OPERATION_OUTCOME_UNKNOWN' })
    expect(await service.getChanges()).toEqual(changes)
    expect(readFileSync(join(root, 'a.txt'))).toEqual(bytes)
    expect(await service.manageShelf({ action: 'LIST' })).toHaveLength(1)
  }, 60000)

  it('rejects a content race during preparation without publishing or cleaning a shelf', async () => {
    const { root, git, service } = await fixture()
    writeFile(root, 'a.txt', 'selected\n')
    const observed = await service.getState()
    const revision = git.getWorktreeRevision.bind(git)
    let reads = 0
    const spy = vi.spyOn(git, 'getWorktreeRevision').mockImplementation(async (...args) => {
      if (++reads === 3) writeFile(root, 'a.txt', 'concurrent change\n')
      return revision(...args)
    })
    await expect(service.manageShelf({ action: 'CREATE', paths: ['a.txt'], expectedWorktreeRevision: observed.worktreeRevision })).rejects.toThrow('GIT_STATE_CHANGED')
    spy.mockRestore()
    expect(await service.manageShelf({ action: 'LIST' })).toEqual([])
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('concurrent change\n')
    expect(await gitExec(root, ['show', ':a.txt'])).toBe('base\n')
  }, 60000)

  it('preserves staged additions, renames and deletions without capturing an unselected rename side', async () => {
    const { root, service } = await fixture()
    await gitExec(root, ['mv', 'a.txt', 'renamed.txt'])
    await gitExec(root, ['rm', 'b.txt'])
    writeFile(root, 'added.txt', 'added staged\n'); await service.stage({ mode: 'STAGE', paths: ['added.txt'] })
    const state = await service.getState()
    const before = await service.getChanges()
    await expect(service.manageShelf({ action: 'CREATE', paths: ['renamed.txt'], expectedWorktreeRevision: state.worktreeRevision })).rejects.toThrow('INVALID_ARGUMENT')
    const created = await service.manageShelf({ action: 'CREATE', paths: ['a.txt', 'renamed.txt', 'b.txt', 'added.txt'], expectedWorktreeRevision: state.worktreeRevision })
    if (!('shelfId' in created)) throw new Error('Missing shelf')
    expect((await service.getState()).dirty).toBe(false)
    const clean = await service.getState()
    await service.manageShelf({ action: 'RESTORE', shelfId: created.shelfId, expectedHead: clean.head, expectedWorktreeRevision: clean.worktreeRevision })
    expect(await service.getChanges()).toEqual(before)
    expect(readFileSync(join(root, 'added.txt'), 'utf8')).toBe('added staged\n')
  }, 60000)

  it('preserves selected MM/untracked byte-for-byte, leaves unrelated staged changes and external stashes alone', async () => {
    const { root, service } = await fixture()
    writeFile(root, 'b.txt', 'external stash\n'); await gitExec(root, ['stash', 'push', '-m', 'user-owned'])
    const external = await gitExec(root, ['rev-parse', 'refs/stash'])
    writeFile(root, 'a.txt', 'staged\n'); await service.stage({ mode: 'STAGE', paths: ['a.txt'] })
    const staged = await gitExec(root, ['show', ':a.txt'])
    writeFile(root, 'a.txt', 'staged\nunstaged\r\nç Ω\n')
    writeFile(root, 'b.txt', 'unselected staged\n'); await service.stage({ mode: 'STAGE', paths: ['b.txt'] })
    writeFile(root, 'new[1].txt', 'untracked\r\n')
    const original = readFileSync(join(root, 'a.txt'))
    const before = await service.getState()
    const created = await service.manageShelf({ action: 'CREATE', paths: ['a.txt', 'new[1].txt'], expectedWorktreeRevision: before.worktreeRevision, label: 'selected' })
    if (!('shelfId' in created)) throw new Error('Missing shelf')
    expect(await service.getChanges()).toEqual([expect.objectContaining({ path: 'b.txt', stagedState: 'M' })])
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('base\n')
    expect(existsSync(join(root, 'new[1].txt'))).toBe(false)
    const state = await service.getState()
    expect(await service.manageShelf({ action: 'RESTORE', shelfId: created.shelfId, expectedHead: state.head, expectedWorktreeRevision: state.worktreeRevision })).toMatchObject({ result: 'RESTORED' })
    expect(readFileSync(join(root, 'a.txt'))).toEqual(original)
    expect(await gitExec(root, ['show', ':a.txt'])).toBe(staged)
    expect(await service.getChanges()).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'a.txt', stagedState: 'M', unstagedState: 'M' }),
      expect.objectContaining({ path: 'b.txt', stagedState: 'M' }),
      expect.objectContaining({ path: 'new[1].txt', untracked: true })
    ]))
    expect(await service.manageShelf({ action: 'LIST' })).toHaveLength(1)
    const revision = (await service.getState()).worktreeRevision
    await service.manageShelf({ action: 'DROP', shelfId: created.shelfId })
    expect(await service.manageShelf({ action: 'LIST' })).toEqual([])
    expect((await service.getState()).worktreeRevision).toBe(revision)
    expect(await gitExec(root, ['rev-parse', 'refs/stash'])).toBe(external)
    await expect(service.manageShelf({ action: 'DROP', shelfId: external.trim() })).rejects.toThrow('SHELF_NOT_FOUND')
  }, 60000)

  it('detects same-status content changes, refuses stale CREATE/RESTORE and keeps stable shelf ids', async () => {
    const { root, service } = await fixture()
    writeFile(root, 'a.txt', 'version one\n')
    const first = await service.getState()
    writeFile(root, 'a.txt', 'version two\n')
    const second = await service.getState()
    expect(second.worktreeRevision).not.toBe(first.worktreeRevision)
    await expect(service.manageShelf({ action: 'CREATE', paths: ['a.txt'], expectedWorktreeRevision: first.worktreeRevision })).rejects.toThrow('GIT_STATE_CHANGED')
    expect(await service.manageShelf({ action: 'LIST' })).toEqual([])
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('version two\n')
    const shelfA = await service.manageShelf({ action: 'CREATE', paths: ['a.txt'], expectedWorktreeRevision: second.worktreeRevision })
    if (!('shelfId' in shelfA)) throw new Error('Missing shelf')
    writeFile(root, 'b.txt', 'other shelf\n')
    const shelfB = await service.manageShelf({ action: 'CREATE', paths: ['b.txt'], expectedWorktreeRevision: (await service.getState()).worktreeRevision })
    if (!('shelfId' in shelfB)) throw new Error('Missing shelf')
    const state = await service.getState()
    writeFile(root, 'untracked.txt', 'concurrent actor\n')
    const unchanged = await service.getState()
    await expect(service.manageShelf({ action: 'RESTORE', shelfId: shelfA.shelfId, expectedHead: state.head, expectedWorktreeRevision: state.worktreeRevision })).rejects.toThrow('GIT_STATE_CHANGED')
    expect((await service.getState()).worktreeRevision).toBe(unchanged.worktreeRevision)
    expect(await service.manageShelf({ action: 'LIST' })).toHaveLength(2)
    const current = await service.getState()
    await service.manageShelf({ action: 'RESTORE', shelfId: shelfA.shelfId, expectedHead: current.head, expectedWorktreeRevision: current.worktreeRevision })
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('version two\n')
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('base\n')
    await expect(service.manageShelf({ action: 'CREATE', paths: ['missing.txt'], expectedWorktreeRevision: (await service.getState()).worktreeRevision })).rejects.toThrow('NOTHING_TO_SHELVE')
  }, 60000)

  it('shelves unstaged changes, switches/merges, restores conflicts without MERGE_HEAD, and retains the copy', async () => {
    const { root, service } = await fixture()
    await service.manageBranch({ action: 'CREATE', branch: 'other', expectedHead: (await service.getState()).head })
    writeFile(root, 'a.txt', 'local shelf\n')
    const created = await service.manageShelf({ action: 'CREATE', paths: ['a.txt'], expectedWorktreeRevision: (await service.getState()).worktreeRevision })
    if (!('shelfId' in created)) throw new Error('Missing shelf')
    expect((await service.getState()).dirty).toBe(false)
    await service.manageBranch({ action: 'SWITCH', branch: 'other' })
    writeFile(root, 'a.txt', 'upstream\n'); await stageAll(root); await commit(root, 'upstream')
    const state = await service.getState()
    const observation = vi.spyOn(service, 'getState').mockRejectedValueOnce(new Error('GIT_STATE_CHANGED'))
    expect(await service.manageShelf({ action: 'RESTORE', shelfId: created.shelfId, expectedHead: state.head, expectedWorktreeRevision: state.worktreeRevision })).toMatchObject({ result: 'CONFLICTS', observation: { status: 'UNAVAILABLE', code: 'GIT_STATE_CHANGED' } })
    observation.mockRestore()
    const conflict = await service.getConflict({ path: 'a.txt' })
    await service.resolveConflict({ path: 'a.txt', resolution: 'CONTENT', content: 'upstream + local\n', expectedHead: state.head, expectedConflictRevision: conflict.conflictRevision! })
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('upstream + local\n')
    expect(await service.manageShelf({ action: 'LIST' })).toHaveLength(1)
  }, 60000)
})

describe('Git Operations v1.1 typed conflicts', () => {
  it('executes the shelf/switch/restore/conflict/commit lifecycle through MCP HTTP, including a complete large literal resolution', async () => {
    const { root, service } = await fixture()
    await gitExec(root, ['checkout', '-b', 'other'])
    writeFile(root, 'a.txt', 'upstream\n'); await stageAll(root); await commit(root, 'upstream')
    await gitExec(root, ['checkout', 'main'])
    writeFile(root, 'a.txt', 'local\n'); writeFile(root, 'untracked.txt', 'untracked\n')
    const server = createMcpHttpServer(new ChannelMcpAdapter({ projectId: 'fixture', repoRoot: root, navigation: {} as ProjectContextNavigation, gitOperations: service }), () => {})
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No MCP endpoint')
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: isReceiptedGitMutation(name, args) ? { ...args, operationId: randomUUID() } : args } }) })
        const reply = await response.json()
        if (reply.error || reply.result.isError) throw new Error(JSON.stringify(reply))
        return JSON.parse(reply.result.content[0].text)
      }
      const observed = await call('get_git_state')
      const shelf = await call('manage_git_shelf', { action: 'CREATE', paths: ['a.txt', 'untracked.txt'], expectedWorktreeRevision: observed.worktreeRevision })
      expect(await call('get_git_changes')).toEqual([])
      await call('manage_git_branch', { action: 'SWITCH', branch: 'other' })
      const clean = await call('get_git_state')
      expect(await call('manage_git_shelf', { action: 'RESTORE', shelfId: shelf.shelfId, expectedHead: clean.head, expectedWorktreeRevision: clean.worktreeRevision })).toMatchObject({ result: 'CONFLICTS' })
      expect(await call('get_git_changes', { filter: 'CONFLICTED' })).toHaveLength(1)
      const metadata = await call('get_git_conflict', { path: 'a.txt' })
      expect(await call('get_git_conflict', { path: 'a.txt', side: 'OURS' })).toMatchObject({ content: 'upstream\n' })
      expect(await call('get_git_conflict', { path: 'a.txt', side: 'THEIRS' })).toMatchObject({ content: 'local\n' })
      const content = 'literal ç🙂\r\n'.repeat(10000)
      await call('resolve_git_conflict', { path: 'a.txt', resolution: 'CONTENT', content, expectedHead: clean.head, expectedConflictRevision: metadata.conflictRevision })
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe(content)
      const resolved = await call('get_git_state')
      await call('commit_git_changes', { message: 'resolution through MCP', expectedHead: resolved.head, expectedIndexRevision: resolved.indexRevision })
      expect(await call('manage_git_shelf', { action: 'LIST' })).toHaveLength(1)
      await call('manage_git_shelf', { action: 'DROP', shelfId: shelf.shelfId })
      expect(await call('get_git_changes', { filter: 'UNTRACKED' })).toEqual([expect.objectContaining({ path: 'untracked.txt' })])
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
  }, 90000)

  it('progressively inspects and resolves CONTENT/OURS/THEIRS/DELETE, keeps merge parents, rejects non-conflicts and stale evidence', async () => {
    const large = 'base\n'.repeat(8000)
    const files = { 'content.txt': large, 'ours.txt': 'base\n', 'theirs.txt': 'base\n', 'delete.txt': 'base\n', 'ordinary.txt': 'ordinary\n' }
    const { root, service, ourHead, otherHead } = await conflicts(files,
      { 'content.txt': 'OURS\n' + large, 'ours.txt': 'ours\n', 'theirs.txt': 'ours\n', 'delete.txt': 'modified\n' },
      { 'content.txt': 'THEIRS\n' + large, 'ours.txt': 'theirs\n', 'theirs.txt': 'theirs\n', 'delete.txt': null })
    const metadata = await service.getConflict({ path: 'content.txt' })
    expect(metadata).not.toHaveProperty('content')
    const page = await service.getConflict({ path: 'content.txt', side: 'OURS' })
    expect(page.content).toContain('OURS'); expect(page.truncated).toBe(true)
    const continuation = await service.getConflict({ path: 'content.txt', side: 'OURS', cursor: page.nextCursor! })
    expect(continuation.content!.length).toBeLessThanOrEqual(24000)
    writeFile(root, 'content.txt', 'concurrent change\n')
    await expect(service.getConflict({ path: 'content.txt', side: 'OURS', cursor: page.nextCursor! })).rejects.toThrow('CONFLICT_STATE_CHANGED')
    await expect(service.resolveConflict({ path: 'content.txt', resolution: 'CONTENT', content: 'stale', expectedHead: ourHead, expectedConflictRevision: metadata.conflictRevision! })).rejects.toThrow('CONFLICT_STATE_CHANGED')
    const fresh = await service.getConflict({ path: 'content.txt' })
    const literal = 'resolved\r\nç Ω🙂\n'
    await service.resolveConflict({ path: 'content.txt', resolution: 'CONTENT', content: literal, expectedHead: ourHead, expectedConflictRevision: fresh.conflictRevision! })
    expect(readFileSync(join(root, 'content.txt'), 'utf8')).toBe(literal)
    for (const [path, resolution] of [['ours.txt', 'OURS'], ['theirs.txt', 'THEIRS'], ['delete.txt', 'DELETE']] as const) {
      const conflict = await service.getConflict({ path })
      if (resolution === 'DELETE') {
        expect(conflict.sides).toContainEqual({ side: 'THEIRS', available: false, classification: null })
        await expect(service.getConflict({ path, side: 'THEIRS' })).rejects.toThrow('CONFLICT_SIDE_UNAVAILABLE')
        await expect(service.resolveConflict({ path, resolution: 'THEIRS', expectedHead: ourHead, expectedConflictRevision: conflict.conflictRevision! })).rejects.toThrow('CONFLICT_SIDE_UNAVAILABLE')
      }
      await service.resolveConflict({ path, resolution, expectedHead: ourHead, expectedConflictRevision: conflict.conflictRevision! })
    }
    expect(readFileSync(join(root, 'ours.txt'), 'utf8')).toBe('ours\n')
    expect(readFileSync(join(root, 'theirs.txt'), 'utf8')).toBe('theirs\n')
    expect(existsSync(join(root, 'delete.txt'))).toBe(false)
    await expect(service.resolveConflict({ path: 'ordinary.txt', resolution: 'CONTENT', content: 'forbidden', expectedHead: ourHead, expectedConflictRevision: '0'.repeat(64) })).rejects.toThrow('CONFLICT_NOT_FOUND')
    expect(readFileSync(join(root, 'ordinary.txt'), 'utf8')).toBe('ordinary\n')
    const state = await service.getState()
    expect(state.conflictCount).toBe(0)
    await service.commit({ message: 'resolve merge', expectedHead: state.head, expectedIndexRevision: state.indexRevision })
    expect((await service.getHistory({ limit: 1 }))[0].parents).toEqual([ourHead, otherHead])
  }, 90000)

  it('does not serialize binary sides and rejects CONTENT while allowing THEIRS', async () => {
    const { root, service, ourHead } = await conflicts({ 'binary.bin': Buffer.from([0, 1]) }, { 'binary.bin': Buffer.from([0, 2]) }, { 'binary.bin': Buffer.from([0, 3]) })
    const conflict = await service.getConflict({ path: 'binary.bin' })
    expect(await service.getConflict({ path: 'binary.bin', side: 'OURS' })).toMatchObject({ classification: 'BINARY', content: null })
    await expect(service.resolveConflict({ path: 'binary.bin', resolution: 'CONTENT', content: 'text', expectedHead: ourHead, expectedConflictRevision: conflict.conflictRevision! })).rejects.toThrow('BINARY_CONFLICT_CONTENT_UNSUPPORTED')
    await service.resolveConflict({ path: 'binary.bin', resolution: 'THEIRS', expectedHead: ourHead, expectedConflictRevision: conflict.conflictRevision! })
    expect(readFileSync(join(root, 'binary.bin'))).toEqual(Buffer.from([0, 3]))
  }, 60000)

  it('continues or aborts an interrupted revert with HEAD and index preconditions', async () => {
    const { root, service } = await fixture()
    writeFile(root, 'a.txt', 'target\n'); await stageAll(root); await commit(root, 'target')
    const target = (await service.getState()).head!
    writeFile(root, 'a.txt', 'later\n'); await stageAll(root); await commit(root, 'later')
    const head = (await service.getState()).head
    expect(await service.revert({ commit: target, expectedHead: head })).toMatchObject({ result: 'CONFLICTS' })
    expect(await service.revert({ action: 'ABORT', expectedHead: head })).toMatchObject({ result: 'ABORTED', head })
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('later\n')
    await service.revert({ action: 'START', commit: target, expectedHead: head })
    const metadata = await service.getConflict({ path: 'a.txt' })
    await service.resolveConflict({ path: 'a.txt', resolution: 'CONTENT', content: 'resolved revert\n', expectedHead: head, expectedConflictRevision: metadata.conflictRevision! })
    const state = await service.getState()
    await expect(service.revert({ action: 'CONTINUE', expectedHead: head, expectedIndexRevision: '0'.repeat(64) })).rejects.toThrow('GIT_STATE_CHANGED')
    expect(await service.revert({ action: 'CONTINUE', expectedHead: head, expectedIndexRevision: state.indexRevision })).toMatchObject({ result: 'REVERTED' })
    expect((await service.getState()).operation).toBe(null)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('resolved revert\n')
    const invalid = await executeGitOperationsTool(service, 'resolve_git_conflict', { path: 'a.txt', resolution: 'OURS', expectedHead: head, expectedConflictRevision: '0'.repeat(64), content: 'forbidden' })
    expect(invalid.isError).toBe(true)
  }, 60000)
})

