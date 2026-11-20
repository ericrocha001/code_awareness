import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { isReceiptedGitMutation } from './git-operation-receipts'
import { GitHubGitTransport } from '../github/github-git-transport'
import type { GitService } from '../core/git-service'
import type { GitHubAuthService } from '../github/github-auth-service'
import { executeGitOperationsTool, GIT_OPERATIONS_TOOLS } from './git-operations-mcp'
import { GitOperationsError, type GitOperationsService } from './git-operations-service'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../continuum/agent-authority'

describe('Git MCP contract', () => {
  it('requires staging identity and both observed revisions before dispatch', async () => {
    const stage = vi.fn(async () => ({}))
    const executeReceipted = vi.fn(async (_id, _name, _args, mutate) => mutate())
    const service = { stage, executeReceipted } as unknown as GitOperationsService
    const args = { mode: 'STAGE', paths: ['literal[1].txt'], expectedIndexRevision: 'a'.repeat(64), expectedWorktreeRevision: 'b'.repeat(64), operationId: randomUUID() }
    const definition = GIT_OPERATIONS_TOOLS.find(tool => tool.name === 'stage_git_changes')!
    expect(definition.inputSchema.required).toEqual(expect.arrayContaining(['operationId', 'expectedIndexRevision', 'expectedWorktreeRevision']))
    for (const key of ['mode', 'paths', 'operationId', 'expectedIndexRevision', 'expectedWorktreeRevision']) {
      const missing: Record<string, unknown> = { ...args }; delete missing[key]
      expect((await executeGitOperationsTool(service, 'stage_git_changes', missing)).isError).toBe(true)
    }
    for (const key of ['operationId', 'expectedIndexRevision', 'expectedWorktreeRevision']) expect((await executeGitOperationsTool(service, 'stage_git_changes', { ...args, [key]: 'invalid value' })).isError).toBe(true)
    expect(executeReceipted).not.toHaveBeenCalled()
    expect((await executeGitOperationsTool(service, 'stage_git_changes', args)).isError).toBeUndefined()
    expect(stage).toHaveBeenCalledWith({ mode: args.mode, paths: args.paths, expectedIndexRevision: args.expectedIndexRevision, expectedWorktreeRevision: args.expectedWorktreeRevision })
    expect(executeReceipted).toHaveBeenCalledWith(args.operationId, 'stage_git_changes', expect.any(Object), expect.any(Function))
  })
  it('requires explicit upstream inputs and operationId without expanding the catalog', async () => {
    const manageBranch = vi.fn(async () => ({}))
    const service = { manageBranch, executeReceipted: async (_id: string, _name: string, _args: Record<string, unknown>, mutate: Parameters<GitOperationsService['executeReceipted']>[3]) => mutate() } as unknown as GitOperationsService
    const args: Record<string, unknown> = { action: 'SET_UPSTREAM', branch: 'main', remote: 'origin', remoteBranch: 'main', expectedHead: 'a'.repeat(40), operationId: randomUUID() }
    expect(GIT_OPERATIONS_TOOLS.filter(tool => tool.name.includes('upstream'))).toHaveLength(0)
    expect((await executeGitOperationsTool(service, 'manage_git_branch', args)).isError).toBeUndefined()
    expect(manageBranch).toHaveBeenCalledWith({ action: 'SET_UPSTREAM', branch: 'main', remote: 'origin', remoteBranch: 'main', expectedHead: 'a'.repeat(40) })
    manageBranch.mockClear()
    for (const key of ['branch', 'remote', 'remoteBranch', 'expectedHead', 'operationId']) {
      const missing = { ...args }; delete missing[key]
      expect((await executeGitOperationsTool(service, 'manage_git_branch', missing)).isError).toBe(true)
    }
    for (const key of ['command', 'refspec', 'config', 'startPoint', 'newBranch']) {
      expect((await executeGitOperationsTool(service, 'manage_git_branch', { ...args, [key]: 'forbidden' })).isError).toBe(true)
    }
    expect(manageBranch).not.toHaveBeenCalled()
  })
  it('projects v1.1 typed actions without repository/command inputs and keeps legacy revert dispatch', async () => {
    const service = { executeReceipted: vi.fn(async (_id, _name, _args, mutate) => mutate()), manageShelf: vi.fn(async () => []), analyzeHygiene: vi.fn(async () => ({})), manageGitignore: vi.fn(async () => ({})), getConflict: vi.fn(async () => ({})), resolveConflict: vi.fn(async () => ({})), revert: vi.fn(async () => ({})) }
    const typed = service as unknown as GitOperationsService
    const head = 'a'.repeat(40), revision = 'b'.repeat(64)
    for (const [name, args] of [
      ['manage_git_shelf', { action: 'CREATE', paths: ['file'], expectedWorktreeRevision: revision }],
      ['manage_git_shelf', { action: 'RESTORE', shelfId: 'owned', expectedHead: head, expectedWorktreeRevision: revision }],
      ['analyze_git_hygiene', {}],
      ['manage_gitignore', { action: 'PREVIEW_ADD', rules: ['generated/'] }],
      ['manage_gitignore', { action: 'ADD', rules: ['generated/'], expectedWorktreeRevision: revision, expectedPreviewId: revision }],
      ['get_git_conflict', { path: 'file', side: 'OURS' }],
      ['resolve_git_conflict', { path: 'file', resolution: 'CONTENT', content: '', expectedHead: head, expectedConflictRevision: revision }],
      ['revert_git_commit', { commit: head, expectedHead: head }],
      ['revert_git_commit', { action: 'CONTINUE', expectedHead: head, expectedIndexRevision: revision }],
      ['revert_git_commit', { action: 'ABORT', expectedHead: head }]
    ] as const) expect((await executeGitOperationsTool(typed, name, isReceiptedGitMutation(name, args) ? { ...args, operationId: randomUUID() } : args)).isError).toBeUndefined()
    expect(service.revert).toHaveBeenCalledWith({ commit: head, expectedHead: head })
    for (const [name, args] of [
      ['manage_git_shelf', { action: 'CREATE', paths: ['file'] }],
      ['manage_git_shelf', { action: 'RESTORE', shelfId: 'owned', expectedHead: head }],
      ['manage_gitignore', { action: 'ADD', rules: ['generated/'], expectedWorktreeRevision: revision }],
      ['manage_gitignore', { action: 'PREVIEW_ADD', rules: [] }],
      ['get_git_conflict', { path: 'file', cursor: 'stale' }],
      ['resolve_git_conflict', { path: 'file', resolution: 'CONTENT', expectedHead: head, expectedConflictRevision: revision }],
      ['revert_git_commit', { action: 'CONTINUE', expectedHead: head }]
    ] as const) expect((await executeGitOperationsTool(typed, name, args)).isError).toBe(true)
    for (const name of ['manage_git_shelf', 'get_git_conflict', 'resolve_git_conflict']) for (const field of ['repoPath', 'cwd', 'command', 'flags', 'credential']) {
      expect((await executeGitOperationsTool(typed, name, { action: 'LIST', path: 'file', [field]: 'forbidden' })).isError).toBe(true)
    }
  })

  it('validates typed arguments before dispatch and sanitizes unexpected errors', async () => {
    const getState = vi.fn(async () => { throw new Error('credential=secret-token https://user:password@host') })
    const service = { getState } as unknown as GitOperationsService
    for (const [name, args] of [
      ['get_git_state', { cwd: '/elsewhere' }],
      ['manage_git_branch', { action: 'CREATE', branch: 'feature' }],
      ['merge_git_branch', { action: 'MERGE', source: 'main' }],
      ['sync_git_remote', { action: 'PUSH' }],
      ['sync_git_remote', { action: 'PUSH', expectedHead: 'bad-head' }],
      ['stage_git_changes', { mode: 'STAGE', paths: [] }],
      ['get_git_diff', { mode: 'BETWEEN_REFS', paths: ['one'] }],
      ['get_git_history', { limit: 101 }],
      ['commit_git_changes', { message: 'commit', expectedHead: null }]
    ] as const) expect(await executeGitOperationsTool(service, name, args)).toMatchObject({ isError: true, content: [{ text: '{"code":"INVALID_ARGUMENT"}' }] })
    expect(getState).not.toHaveBeenCalled()
    expect(await executeGitOperationsTool(service, 'get_git_state', {})).toMatchObject({ isError: true, content: [{ text: '{"code":"GIT_OPERATION_FAILED"}' }] })
  })

  it('preserves stable domain errors', async () => {
    const service = { getState: async () => { throw new GitOperationsError('NOT_GIT_REPOSITORY') } } as unknown as GitOperationsService
    expect(await executeGitOperationsTool(service, 'get_git_state', {})).toMatchObject({ isError: true, content: [{ text: '{"code":"NOT_GIT_REPOSITORY"}' }] })
  })
})

describe('shared GitHub remote authentication', () => {
  it('does not repeat a failed authenticated push with ambient credentials', async () => {
    const auth = { getValidAccessToken: vi.fn(async () => 'private-token') } as unknown as GitHubAuthService
    const git = { getRemoteUrl: vi.fn(async () => 'https://github.com/owner/repository.git'), pushAuthenticated: vi.fn(async () => { throw new Error('confirmation lost') }), push: vi.fn() }
    const transport = new GitHubGitTransport(auth, git as unknown as GitService)
    await expect(transport.push('/project', 'main')).rejects.toThrow('confirmation lost')
    expect(git.pushAuthenticated).toHaveBeenCalledTimes(1)
    expect(git.push).not.toHaveBeenCalled()
  })
  it('uses existing ephemeral credentials for GitHub HTTPS only and forwards the pinned push SHA', async () => {
    const auth = { getValidAccessToken: vi.fn(async () => 'private-token') } as unknown as GitHubAuthService
    const git = {
      getRemoteUrl: vi.fn(async () => 'https://github.com/owner/repository.git'),
      pushAuthenticated: vi.fn(async () => {}), push: vi.fn(async () => {}),
      fetchRemote: vi.fn(async () => {}), pullFastForward: vi.fn(async () => {})
    }
    const transport = new GitHubGitTransport(auth, git as unknown as GitService)
    await transport.push('/project', 'main', 'origin', 'a'.repeat(40))
    expect(git.pushAuthenticated).toHaveBeenCalledWith('/project', 'origin', 'main', 'private-token', 'a'.repeat(40))
    await transport.fetch('/project', 'origin')
    expect(git.fetchRemote).toHaveBeenCalledWith('/project', 'origin', 'private-token')
    await transport.pullFastForward('/project', 'origin', 'main')
    expect(git.pullFastForward).toHaveBeenCalledWith('/project', 'origin', 'main', 'private-token')
    const calls = vi.mocked(auth.getValidAccessToken).mock.calls.length
    git.getRemoteUrl.mockResolvedValue('https://other-host/repository.git')
    await transport.push('/project', 'main')
    expect(auth.getValidAccessToken).toHaveBeenCalledTimes(calls)
    expect(git.push).toHaveBeenCalledWith('/project', 'origin', 'main', undefined)
  })
  it('propagates authority deliveryContext into commit_git_changes and worktree mutations and rejects conflicts before effect', async () => {
    const request = { bindingArtifactId: 'artifact-execution-branch-' + '1'.repeat(64), bindingRevision: 1, planArtifactId: 'artifact-11111111-1111-4111-8111-111111111111', planRevision: 1, executionId: 'execution-A' }
    const anchor = { ...request, schemaVersion: 1 as const, repositoryId: 'repo-1', planDigest: '2'.repeat(64), bindingDigest: '3'.repeat(64), classification: 'AUTHENTICATED_EXECUTION_CONTEXT' as const,
      snapshot: { repositoryId: 'repo-1', worktreeId: 'a'.repeat(64), worktreeGeneration: '4'.repeat(64), branchRef: 'refs/heads/feat', branchGeneration: '5'.repeat(64), branchRevision: '6'.repeat(64), fingerprint: '7'.repeat(64), head: 'b'.repeat(40) } }
    const authority = authorizeArtifactAgent(authenticatedAgentPrincipal('MCP', () => true), 'repo-1', () => true, 'a'.repeat(64), { deliveryContext: request })
    const prepareDelivery = vi.fn(async () => anchor)
    const commit = vi.fn(async () => ({ sha: 'c'.repeat(40), parent: 'b'.repeat(40) }))
    const executeReceipted = vi.fn(async (_id, _name, args, mutate, prep) => {
      expect(args.deliveryContext).toBeUndefined()
      expect(await prep?.()).toEqual(anchor)
      return mutate()
    })
    const service = { commit, executeReceipted, mutateWorktree: vi.fn(async (_req, prep) => ({ content: [{ type: 'text', text: JSON.stringify(await prep?.()) }] })) } as unknown as GitOperationsService
    const commitArgs = { message: 'msg', expectedHead: 'b'.repeat(40), expectedIndexRevision: 'd'.repeat(64), operationId: 'op-1' }
    const okResult = await executeGitOperationsTool(service, 'commit_git_changes', commitArgs, prepareDelivery, authority)
    expect(okResult.isError).toBeUndefined()
    expect(prepareDelivery).toHaveBeenCalledWith(request, 'a'.repeat(64))

    const conflicting = await executeGitOperationsTool(service, 'commit_git_changes', { ...commitArgs, operationId: 'op-2', deliveryContext: { ...request, executionId: 'execution-OTHER' } }, prepareDelivery, authority)
    expect(conflicting.isError).toBe(true)
    expect(JSON.parse(conflicting.content[0].text)).toMatchObject({ code: 'DELIVERY_CONTEXT_CONFLICT' })
    expect(commit).toHaveBeenCalledTimes(1)

    const badAuthority = authorizeArtifactAgent(authenticatedAgentPrincipal('MCP', () => true), 'repo-1', () => true, 'a'.repeat(64), { deliveryContextError: 'DELIVERY_CONTEXT_MALFORMED' })
    const rejectedBad = await executeGitOperationsTool(service, 'commit_git_changes', { ...commitArgs, operationId: 'op-3' }, prepareDelivery, badAuthority)
    expect(rejectedBad.isError).toBe(true)
    expect(JSON.parse(rejectedBad.content[0].text)).toMatchObject({ code: 'DELIVERY_CONTEXT_INVALID' })
    expect(commit).toHaveBeenCalledTimes(1)

    const mismatchedWorktree = await executeGitOperationsTool(service, 'mutate_worktree', {
      action: 'COMMIT', worktreeId: 'f'.repeat(64), leaseId: 'l1', leaseCredential: 'e'.repeat(64), operationId: 'op-4', message: 'msg',
      snapshot: { branch: 'feat', head: 'b'.repeat(40), indexRevision: 'd'.repeat(64), worktreeRevision: '1'.repeat(64), operation: null }
    }, prepareDelivery, authority)
    expect(mismatchedWorktree.isError).toBe(true)
    expect(JSON.parse(mismatchedWorktree.content[0].text)).toMatchObject({ code: 'DELIVERY_CONTEXT_INVALID', reason: 'WORKTREE_SCOPE_CONFLICT' })
    expect(service.mutateWorktree).not.toHaveBeenCalled()
  })
})
