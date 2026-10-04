import { describe, expect, it, vi } from 'vitest'
import { GitHubGitTransport } from '../github/github-git-transport'
import type { GitService } from '../core/git-service'
import type { GitHubAuthService } from '../github/github-auth-service'
import { executeGitOperationsTool } from './git-operations-mcp'
import { GitOperationsError, type GitOperationsService } from './git-operations-service'

describe('Git MCP contract', () => {
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
