import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitService } from '../core/git-service'
import { cleanupTempRepo, commit, createTempGitRepo, gitExec, stageAll, writeFile } from '../core/git-test-helpers'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import { GitHubGitTransport } from '../github/github-git-transport'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { createMcpHttpServer } from '../mcp/mcp-http-server'
import { McpWorkloadGovernor } from '../mcp/mcp-workload-governor'
import { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'
import { SystemHealthCore } from '../system-health/system-health-core'
import { ValidationExecution } from '../validation-execution/validation-execution'
import type { ValidationLedger } from '../validation-ledger/validation-ledger'
import { GitOperationsService } from './git-operations-service'
import { executeGitOperationsTool } from './git-operations-mcp'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await cleanupTempRepo(root) })
async function fixture() {
  const root = await createTempGitRepo(); roots.push(root)
  await gitExec(root, ['config', 'core.autocrlf', 'false'])
  writeFile(root, 'a.txt', 'base\n')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "setTimeout(() => process.exit(0), 300)"' } }))
  await stageAll(root); await commit(root, 'base')
  const git = new GitService()
  const service = () => new GitOperationsService(root, git, new GitHubGitTransport(null, git))
  return { root, git, service }
}

describe('Operational reliability through real MCP HTTP', () => {
  it('replays commit and push once without publishing receipt refs', async () => {
    const { root, git, service } = await fixture()
    const remote = mkdtempSync(join(tmpdir(), 'receipt-remote-')); roots.push(remote)
    await gitExec(root, ['init', '--bare', remote])
    await gitExec(root, ['remote', 'add', 'origin', remote])
    writeFile(root, 'a.txt', 'new commit\n')
    await service().stage({ ...await stagingRevisions(service()), mode: 'STAGE', paths: ['a.txt'] })
    const state = await service().getState()
    const args = { message: 'receipted commit', expectedHead: state.head, expectedIndexRevision: state.indexRevision, operationId: randomUUID() }
    const commitSpy = vi.spyOn(git, 'commitInspectedIndex')
    const first = JSON.parse((await executeGitOperationsTool(service(), 'commit_git_changes', args)).content[0].text)
    expect(first).toMatchObject({ replayed: false })
    const replay = JSON.parse((await executeGitOperationsTool(service(), 'commit_git_changes', args)).content[0].text)
    expect(replay).toMatchObject({ sha: first.sha, replayed: true })
    expect(commitSpy).toHaveBeenCalledTimes(1)
    expect((await gitExec(root, ['rev-list', '--count', 'HEAD'])).trim()).toBe('2')
    const pushSpy = vi.spyOn(git, 'push')
    const push = { action: 'PUSH', expectedHead: first.sha, operationId: randomUUID() }
    expect(JSON.parse((await executeGitOperationsTool(service(), 'sync_git_remote', push)).content[0].text)).toMatchObject({ pushedHead: first.sha, replayed: false })
    expect(JSON.parse((await executeGitOperationsTool(service(), 'sync_git_remote', push)).content[0].text)).toMatchObject({ pushedHead: first.sha, replayed: true })
    expect(pushSpy).toHaveBeenCalledTimes(1)
    expect((await gitExec(remote, ['for-each-ref', '--format=%(refname)', 'refs/code-awareness/'])).trim()).toBe('')
  }, 60000)

  it('keeps post-mutation observation failures PREPARED instead of recording a precommit failure', async () => {
    const { root, git, service } = await fixture()
    const operations = service()
    vi.spyOn(operations, 'getState').mockRejectedValueOnce(new Error('GIT_STATE_CHANGED'))
    const args = { action: 'CREATE', branch: 'already-created', expectedHead: await git.getCurrentCommitHash(root), operationId: randomUUID() }
    const result = JSON.parse((await executeGitOperationsTool(operations, 'manage_git_branch', args)).content[0].text)
    expect(result).toMatchObject({ code: 'OPERATION_OUTCOME_UNKNOWN', retryability: 'NOT_SAFE' })
    expect((await gitExec(root, ['show-ref', '--verify', 'refs/heads/already-created'])).trim()).not.toBe('')
    expect((await git.readOperationReceipt(root, args.operationId))?.receipt.status).toBe('PREPARED')
    const create = vi.spyOn(git, 'createBranch')
    expect(JSON.parse((await executeGitOperationsTool(service(), 'manage_git_branch', args)).content[0].text).code).toBe('OPERATION_OUTCOME_UNKNOWN')
    expect(create).not.toHaveBeenCalled()
  }, 60000)

  it('recovers lost Git acknowledgements and follows validation while navigation calls time out independently', async () => {
    const { root, git, service } = await fixture()
    const identity = new RuntimeIdentityProvider({ rootDir: root, includedDirectories: [], includedRootFiles: ['package.json'], mode: 'development' })
    const proofs: unknown[] = []
    const ledger = { recordProof: (input: unknown) => { proofs.push(input); return { proofId: 'proof-one' } } } as unknown as ValidationLedger
    const validation = new ValidationExecution(root, ledger, identity)
    const releases: Array<(value: []) => void> = []
    const navigation = { readCode: vi.fn(() => new Promise<[]>((resolve) => { releases.push(resolve) })) } as unknown as ProjectContextNavigation
    const health = new SystemHealthCore({ runtimeIdentityProvider: identity })
    const adapter = new ChannelMcpAdapter({ projectId: 'fixture', repoRoot: root, navigation, gitOperations: service(), validationExecution: validation }, health, identity, ledger)
    adapter.setWorkloadGovernor(new McpWorkloadGovernor(50, 25))
    const server = createMcpHttpServer(adapter, () => {})
    let loseAck = false
    server.prependListener('request', (_request, response) => {
      const end = response.end.bind(response)
      response.end = ((...args: any[]) => { if (loseAck) { loseAck = false; response.destroy(); return response } return (end as any)(...args) }) as any
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing endpoint')
    let calls = 0
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++calls, method: 'tools/call', params: { name, arguments: args } }) })
      const reply = await response.json()
      if (reply.error) throw new Error(JSON.stringify(reply.error))
      return { ...JSON.parse(reply.result.content[0].text), isError: reply.result.isError }
    }
    try {
      writeFile(root, 'a.txt', 'literal ç🙂\r\n')
      const bytes = readFileSync(join(root, 'a.txt'))
      const changed = await call('get_git_state')
      const createArgs = { action: 'CREATE', paths: ['a.txt'], expectedWorktreeRevision: changed.worktreeRevision, operationId: randomUUID() }
      loseAck = true
      await expect(call('manage_git_shelf', createArgs)).rejects.toThrow()
      const created = await call('manage_git_shelf', createArgs)
      expect(created).toMatchObject({ replayed: true, pathCount: 1, operationId: createArgs.operationId })
      expect(await service().manageShelf({ action: 'LIST' })).toHaveLength(1)
      expect((await git.readOperationReceipt(root, createArgs.operationId))?.receipt.status).toBe('COMPLETED')
      expect(await call('manage_git_shelf', { ...createArgs, paths: ['other.txt'] })).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
      const clean = await call('get_git_state')
      const restoreArgs = { action: 'RESTORE', shelfId: created.shelfId, expectedHead: clean.head, expectedWorktreeRevision: clean.worktreeRevision, operationId: randomUUID() }
      loseAck = true
      await expect(call('manage_git_shelf', restoreArgs)).rejects.toThrow()
      const restored = await executeGitOperationsTool(service(), 'manage_git_shelf', restoreArgs)
      expect(JSON.parse(restored.content[0].text)).toMatchObject({ replayed: true, result: 'RESTORED' })
      expect(readFileSync(join(root, 'a.txt'))).toEqual(bytes)
      expect((await call('get_git_state')).worktreeRevision).toBe(changed.worktreeRevision)
      const dropArgs = { action: 'DROP', shelfId: created.shelfId, operationId: randomUUID() }
      expect(await call('manage_git_shelf', dropArgs)).toMatchObject({ replayed: false })
      expect(await call('manage_git_shelf', dropArgs)).toMatchObject({ replayed: true })
      expect(await service().manageShelf({ action: 'LIST' })).toEqual([])

      const started = await call('start_validation', { profileId: 'typecheck', producer: 'TESTER' })
      expect(started).toMatchObject({ status: 'RUNNING', retryAfterMs: 2000 })
      expect(await call('start_validation', { profileId: 'typecheck', producer: 'TESTER' })).toMatchObject({ code: 'VALIDATION_BUSY', activeRunId: started.runId, recommendedAction: 'FOLLOW_ACTIVE_RUN' })
      expect(await call('read_code', { targetIds: ['target'] })).toMatchObject({ code: 'REQUEST_TIMEOUT' })
      expect(await call('read_code', { targetIds: ['target'] })).toMatchObject({ code: 'REQUEST_TIMEOUT' })
      expect(navigation.readCode).toHaveBeenCalledTimes(2)
      expect(await call('get_git_state')).toMatchObject({ head: changed.head })
      expect(await call('get_runtime_identity')).toBeDefined()
      const snapshot = await call('get_system_health')
      expect(snapshot.activeRunId).toBe(started.runId)
      expect(snapshot.workloadGovernor.events.map((event: any) => event.event)).toContain('EXECUTION_FAILED')
      expect(snapshot.workloadGovernor.lanes.some((lane: any) => lane.lane === 'NAVIGATION')).toBe(false)
      expect(await call('get_validation_run', { runId: started.runId, waitMs: 5000 })).toMatchObject({ status: 'PASSED', proofId: 'proof-one' })
      expect(proofs).toHaveLength(1)
      releases.forEach(release => release([]))
      await new Promise((resolve) => setTimeout(resolve, 30))
      vi.mocked(navigation.readCode).mockRejectedValueOnce(new Error('controlled execution failure'))
      await call('read_code', { targetIds: ['target'] }).catch(() => {})
      const failed = await call('get_system_health')
      expect(failed.workloadGovernor.events.map((event: any) => event.event)).toContain('EXECUTION_FAILED')
    } finally {
      releases.forEach(release => release([]))
      await validation.shutdown()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 60000)

  it('never executes PREPARED receipts and preserves deterministic failures across fresh services', async () => {
    const { root, git, service } = await fixture()
    writeFile(root, 'a.txt', 'local\n')
    const args = { action: 'CREATE', paths: ['a.txt'], expectedWorktreeRevision: (await service().getState()).worktreeRevision }
    const unknownId = randomUUID()
    const mutate = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{"code":"GIT_OPERATION_FAILED"}' }], isError: true as const }))
    expect(JSON.parse((await service().executeReceipted(unknownId, 'manage_git_shelf', args, mutate)).content[0].text).code).toBe('OPERATION_OUTCOME_UNKNOWN')
    const noExecution = vi.fn(async () => { throw new Error('must not execute') })
    expect(JSON.parse((await service().executeReceipted(unknownId, 'manage_git_shelf', args, noExecution)).content[0].text)).toMatchObject({ code: 'OPERATION_OUTCOME_UNKNOWN', retryability: 'NOT_SAFE' })
    expect(noExecution).not.toHaveBeenCalled()
    expect((await git.readOperationReceipt(root, unknownId))?.receipt.status).toBe('PREPARED')
    const failedArgs = { ...args, expectedWorktreeRevision: '0'.repeat(64), operationId: randomUUID() }
    const failed = await executeGitOperationsTool(service(), 'manage_git_shelf', failedArgs)
    expect(JSON.parse(failed.content[0].text)).toMatchObject({ code: 'GIT_STATE_CHANGED', retryability: 'AFTER_STATE_REFRESH' })
    expect((await git.readOperationReceipt(root, failedArgs.operationId))?.receipt.status).toBe('FAILED')
    expect(JSON.parse((await executeGitOperationsTool(service(), 'manage_git_shelf', failedArgs)).content[0].text)).toMatchObject({ code: 'GIT_STATE_CHANGED', replayed: true })
    expect(await service().manageShelf({ action: 'LIST' })).toEqual([])
  }, 60000)
})

async function stagingRevisions(service: GitOperationsService) {
  const state = await service.getState()
  return { expectedIndexRevision: state.indexRevision, expectedWorktreeRevision: state.worktreeRevision }
}
