import { describe, expect, it, vi } from 'vitest'
import { GitHubGitTransport } from '../github/github-git-transport'
import type { GitService } from '../core/git-service'
import type { GitHubAuthService } from '../github/github-auth-service'
import { executeGitOperationsTool } from './git-operations-mcp'
import { GitOperationsError, type GitOperationsService } from './git-operations-service'

describe('Git MCP contract', () => {
  it('projects v1.1 typed actions without repository/command inputs and keeps legacy revert dispatch', async () => {
    const service = { manageShelf: vi.fn(async () => []), getConflict: vi.fn(async () => ({})), resolveConflict: vi.fn(async () => ({})), revert: vi.fn(async () => ({})) }
    const typed = service as unknown as GitOperationsService
    const head = 'a'.repeat(40), revision = 'b'.repeat(64)
    for (const [name, args] of [
      ['manage_git_shelf', { action: 'CREATE', paths: ['file'], expectedWorktreeRevision: revision }],
      ['manage_git_shelf', { action: 'RESTORE', shelfId: 'owned', expectedHead: head, expectedWorktreeRevision: revision }],
      ['get_git_conflict', { path: 'file', side: 'OURS' }],
      ['resolve_git_conflict', { path: 'file', resolution: 'CONTENT', content: '', expectedHead: head, expectedConflictRevision: revision }],
      ['revert_git_commit', { commit: head, expectedHead: head }],
      ['revert_git_commit', { action: 'CONTINUE', expectedHead: head, expectedIndexRevision: revision }],
      ['revert_git_commit', { action: 'ABORT', expectedHead: head }]
    ] as const) expect((await executeGitOperationsTool(typed, name, args)).isError).toBeUndefined()
    expect(service.revert).toHaveBeenCalledWith({ commit: head, expectedHead: head })
    for (const [name, args] of [
      ['manage_git_shelf', { action: 'CREATE', paths: ['file'] }],
      ['manage_git_shelf', { action: 'RESTORE', shelfId: 'owned', expectedHead: head }],
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
})
