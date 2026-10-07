import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitService } from '../core/git-service'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import { cleanupTempRepo, commit, createTempGitRepo, deleteFile, gitExec, stageAll, writeFile } from '../core/git-test-helpers'
import { GitHubGitTransport } from '../github/github-git-transport'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { createMcpHttpServer } from '../mcp/mcp-http-server'
import { executeGitOperationsTool } from './git-operations-mcp'
import { GitOperationsService } from './git-operations-service'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await cleanupTempRepo(root) })
async function fixture(head = true) {
  const root = await createTempGitRepo(); roots.push(root)
  await gitExec(root, ['config', 'core.autocrlf', 'false'])
  writeFile(root, 'a.txt', 'base\n'); writeFile(root, 'b.txt', 'base\n')
  await stageAll(root)
  if (head) await commit(root, 'base')
  const git = new GitService()
  const service = new GitOperationsService(root, git, new GitHubGitTransport(null, git))
  const request = async (mode: 'STAGE' | 'UNSTAGE', paths: string[]) => {
    const state = await service.getState()
    return { mode, paths, expectedIndexRevision: state.indexRevision, expectedWorktreeRevision: state.worktreeRevision, operationId: randomUUID() }
  }
  const call = async (args: Awaited<ReturnType<typeof request>>) => {
    const result = await executeGitOperationsTool(service, 'stage_git_changes', args)
    return { ...JSON.parse(result.content[0].text), isError: result.isError }
  }
  const index = () => readFileSync(join(root, '.git', 'index'))
  return { root, git, service, request, call, index }
}

describe('Git staging outcome safety', { timeout: 60000 }, () => {
  it.each(['STAGE', 'UNSTAGE'] as const)('keeps the index byte-identical when a multi-path %s fails', async (mode) => {
    const f = await fixture()
    writeFile(f.root, 'a.txt', 'changed a\n'); writeFile(f.root, 'b.txt', 'changed b\n')
    if (mode === 'UNSTAGE') await stageAll(f.root)
    const args = await f.request(mode, ['a.txt', 'b.txt', 'missing.txt'])
    const before = f.index(), staged = await f.service.getChanges('STAGED')
    expect(await f.call(args)).toMatchObject({ code: 'INDEX_MUTATION_FAILED', replayed: false, isError: true })
    expect(f.index()).toEqual(before)
    expect((await f.service.getState()).indexRevision).toBe(args.expectedIndexRevision)
    expect(await f.service.getChanges('STAGED')).toEqual(staged)
    expect((await f.git.readOperationReceipt(f.root, args.operationId))?.receipt.status).toBe('FAILED')
    expect(await f.call(args)).toMatchObject({ code: 'INDEX_MUTATION_FAILED', replayed: true })
  })

  it('rolls back after Git has changed the temporary index, including unborn unstage', async () => {
    for (const head of [true, false]) {
      const f = await fixture(head)
      writeFile(f.root, 'a.txt', 'changed\n'); await stageAll(f.root)
      const args = await f.request('UNSTAGE', ['a.txt', 'b.txt']), before = f.index()
      const runner = f.git as unknown as { runGit: (...args: any[]) => Promise<string> }
      const run = runner.runGit.bind(f.git)
      const spy = vi.spyOn(runner, 'runGit').mockImplementation(async (...args) => {
        const result = await run(...args)
        if (args[2]?.env?.GIT_INDEX_FILE && (args[0].includes('restore') || args[0].includes('rm'))) throw new Error('failure after temporary mutation')
        return result
      })
      expect(await f.call(args)).toMatchObject({ code: 'INDEX_MUTATION_FAILED' })
      expect(f.index()).toEqual(before)
      spy.mockRestore()
    }
  })

  it.each(['STAGE', 'UNSTAGE'] as const)('rejects stale index and worktree for %s without mutating', async (mode) => {
    const f = await fixture()
    writeFile(f.root, 'a.txt', 'changed\n')
    for (const kind of ['worktree', 'index']) {
      const args = await f.request(mode, ['a.txt'])
      if (kind === 'worktree') writeFile(f.root, 'b.txt', 'changed b\n')
      else await stageAll(f.root)
      const before = f.index()
      expect(await f.call(args)).toMatchObject({ code: 'GIT_STATE_CHANGED', replayed: false })
      expect(f.index()).toEqual(before)
    }
  })

  it.each([true, false])('stages literal paths and unstages without changing worktree (HEAD=%s)', async (head) => {
    const f = await fixture(head)
    writeFile(f.root, 'a.txt', 'changed\n'); deleteFile(f.root, 'b.txt')
    writeFile(f.root, 'novo espaço ç.txt', 'unicode\n'); writeFile(f.root, 'literal[1].txt', 'literal\n')
    const paths = ['a.txt', 'b.txt', 'novo espaço ç.txt', 'literal[1].txt']
    expect(await f.call(await f.request('STAGE', paths))).toMatchObject({ replayed: false })
    expect((await f.service.getChanges('STAGED')).map(change => change.path)).toEqual(expect.arrayContaining(head ? paths : paths.filter(path => path !== 'b.txt')))
    const bytes = readFileSync(join(f.root, 'novo espaço ç.txt'))
    expect(await f.call(await f.request('UNSTAGE', head ? paths : paths.filter(path => path !== 'b.txt')))).toMatchObject({ stagedCount: 0 })
    expect(readFileSync(join(f.root, 'novo espaço ç.txt'))).toEqual(bytes)
  })

  it('replays across service instances and rejects changed paths or preconditions', async () => {
    const f = await fixture(); writeFile(f.root, 'a.txt', 'changed\n')
    const args = await f.request('STAGE', ['a.txt'])
    const first = await f.call(args), before = f.index()
    const stage = vi.spyOn(f.git, 'stagePaths')
    const fresh = new GitOperationsService(f.root, f.git, new GitHubGitTransport(null, f.git))
    const replay = JSON.parse((await executeGitOperationsTool(fresh, 'stage_git_changes', args)).content[0].text)
    expect(replay).toMatchObject({ indexRevision: first.indexRevision, operationId: args.operationId, replayed: true })
    for (const change of [{ paths: ['b.txt'] }, { expectedIndexRevision: '0'.repeat(64) }, { expectedWorktreeRevision: '0'.repeat(64) }]) expect(await f.call({ ...args, ...change })).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect(stage).not.toHaveBeenCalled(); expect(f.index()).toEqual(before)
  })

  it.each(['observe', 'receipt'] as const)('leaves unknown outcomes PREPARED after %s failure and never reexecutes', async (failure) => {
    const f = await fixture(); writeFile(f.root, 'a.txt', 'changed\n')
    const args = await f.request('STAGE', ['a.txt'])
    if (failure === 'observe') vi.spyOn(f.service, 'getState').mockRejectedValueOnce(new Error('observation failed'))
    else vi.spyOn(f.git, 'completeOperationReceipt').mockRejectedValueOnce(new Error('persistence failed'))
    expect(await f.call(args)).toMatchObject({ code: 'OPERATION_OUTCOME_UNKNOWN', operationId: args.operationId, retryability: 'NOT_SAFE', recommendedAction: 'RECONCILE_OPERATION' })
    expect((await f.git.readOperationReceipt(f.root, args.operationId))?.receipt.status).toBe('PREPARED')
    expect((await f.service.getChanges('STAGED')).map(change => change.path)).toContain('a.txt')
    const stage = vi.spyOn(f.git, 'stagePaths')
    expect(await f.call(args)).toMatchObject({ code: 'OPERATION_OUTCOME_UNKNOWN' })
    expect(stage).not.toHaveBeenCalled()
  })

  it('recovers a lost multi-path staging acknowledgement through the real Channel HTTP adapter', async () => {
    const f = await fixture()
    writeFile(f.root, 'a.txt', 'changed\n'); writeFile(f.root, 'novo espaço ç.txt', 'new\n')
    const adapter = new ChannelMcpAdapter({ projectId: 'staging-proof', repoRoot: f.root, navigation: {} as ProjectContextNavigation, gitOperations: f.service })
    const server = createMcpHttpServer(adapter, () => {})
    let loseAck = false
    server.prependListener('request', (_request, response) => {
      const end = response.end.bind(response)
      response.end = ((...args: any[]) => { if (loseAck) { loseAck = false; response.destroy(); return response } return (end as any)(...args) }) as any
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing endpoint')
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
      const reply = await response.json() as { result: { content: Array<{ text: string }> } }
      return JSON.parse(reply.result.content[0].text)
    }
    try {
      const state = await call('get_git_state', {})
      const args = { mode: 'STAGE', paths: ['a.txt', 'novo espaço ç.txt'], expectedIndexRevision: state.indexRevision, expectedWorktreeRevision: state.worktreeRevision, operationId: randomUUID() }
      const stage = vi.spyOn(f.git, 'stagePaths')
      loseAck = true; await expect(call('stage_git_changes', args)).rejects.toThrow()
      expect(await call('stage_git_changes', args)).toMatchObject({ replayed: true, stagedCount: 2, operationId: args.operationId })
      expect(stage).toHaveBeenCalledTimes(1)
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
