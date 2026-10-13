import { expect, it, vi } from 'vitest'
import { GitHubApiClient } from './github-api-client'
import { GitHubIntegrationService } from './github-integration-service'
import { executeInspectPullRequestMergeability } from './github-mergeability-mcp'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'

const dto = { number: 23, state: 'open', draft: false, base: { ref: 'main', sha: 'a'.repeat(40) }, head: { ref: 'feature', sha: 'b'.repeat(40) } }

it.each([
  [true, 'clean', 'MERGEABLE', 'NOT_CONFIRMED'],
  [true, 'blocked', 'MERGEABLE', 'NOT_CONFIRMED'],
  [false, 'blocked', 'NOT_MERGEABLE', 'NOT_CONFIRMED'],
  [false, 'dirty', 'NOT_MERGEABLE', 'CONFLICT_CONFIRMED'],
  [false, 'future', 'NOT_MERGEABLE', 'NOT_CONFIRMED'],
  [null, 'unknown', 'UNKNOWN', 'NOT_CONFIRMED'],
  [undefined, undefined, 'UNKNOWN', 'NOT_CONFIRMED']
])('preserves provider tri-state %s/%s', async (mergeable, mergeable_state, mergeability, conflict) => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...dto, mergeable, mergeable_state })))
  const api = new GitHubApiClient(async () => 'secret', fetcher)
  const result = await api.inspectPullRequestMergeability('owner/repo', 23)
  expect(result).toMatchObject({ mergeability, conflict, base: dto.base, head: dto.head, source: 'GITHUB_REST' })
  expect(JSON.stringify(result)).not.toContain('secret')
  expect(fetcher.mock.calls[0][1].method).toBeUndefined()
})

it('reads again after base/head changes and preserves draft', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...dto, mergeable: null })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...dto, base: { ref: 'main', sha: 'c'.repeat(40) }, head: { ref: 'feature', sha: 'd'.repeat(40) }, draft: true, mergeable: true, mergeable_state: 'blocked' })))
  const api = new GitHubApiClient(async () => 'secret', fetcher)
  expect((await api.inspectPullRequestMergeability('owner/repo', 23)).mergeability).toBe('UNKNOWN')
  expect(await api.inspectPullRequestMergeability('owner/repo', 23)).toMatchObject({ draft: true, mergeability: 'MERGEABLE', base: { sha: 'c'.repeat(40) }, head: { sha: 'd'.repeat(40) } })
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it.each([[401, 'REAUTH_REQUIRED'], [403, 'PERMISSION_DENIED'], [404, 'REPOSITORY_NOT_FOUND'], [429, 'RATE_LIMITED']])('preserves HTTP failure %s', async (status, code) => {
  const api = new GitHubApiClient(async () => 'secret', vi.fn().mockResolvedValue(new Response('{}', { status })))
  await expect(api.inspectPullRequestMergeability('owner/repo', 23)).rejects.toMatchObject({ code })
})

it('preserves rate limit and network/timeout failures without polling', async () => {
  for (const [fetcher, code] of [[vi.fn().mockResolvedValue(new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })), 'RATE_LIMITED'], [vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError')), 'TIMEOUT'], [vi.fn().mockRejectedValue(new Error('network')), 'NETWORK_ERROR']] as const) {
    const api = new GitHubApiClient(async () => 'secret', fetcher)
    await expect(api.inspectPullRequestMergeability('owner/repo', 23)).rejects.toMatchObject({ code })
    expect(fetcher).toHaveBeenCalledTimes(1)
  }
})

it('advertises and dispatches the read-only tool through the Channel', async () => {
  const service = { inspectPullRequestMergeability: vi.fn().mockResolvedValue({ ...dto, mergeability: 'UNKNOWN' }) }
  const adapter = new ChannelMcpAdapter({ projectId: 'active', repoRoot: '/active', navigation: {} as any, githubIntegration: service as any })
  expect(adapter.listTools().find(tool => tool.name === 'inspect_pull_request_mergeability')).toBeDefined()
  const response = await adapter.callTool('inspect_pull_request_mergeability', { prNumber: 23 })
  expect(response.isError).toBeUndefined()
  expect(service.inspectPullRequestMergeability).toHaveBeenCalledWith('/active', 23)
  expect(JSON.parse((response.content[0] as { text: string }).text).mergeability).toBe('UNKNOWN')
})

it('binds routing to active repository and rejects selectors and invalid numbers', async () => {
  const inspect = vi.fn().mockResolvedValue({ status: 'UNAVAILABLE', reason: 'NOT_CONNECTED' })
  const service = { inspectPullRequestMergeability: inspect } as unknown as GitHubIntegrationService
  for (const args of [{}, { prNumber: 0 }, { prNumber: 1.5 }, { prNumber: 23, repository: 'other/repo' }, { prNumber: '23' }]) expect((await executeInspectPullRequestMergeability(service, '/active', args)).isError).toBe(true)
  expect(inspect).not.toHaveBeenCalled()
  await executeInspectPullRequestMergeability(service, '/active', { prNumber: 23 })
  expect(inspect).toHaveBeenCalledWith('/active', 23)
})

it('rejects unconfigured, disconnected, non-GitHub and mismatched linked repositories', async () => {
  const api = { inspectPullRequestMergeability: vi.fn() }, auth = { hasCredentials: () => true }
  const catalog = { findByPath: () => ({ github: { fullName: 'other/repo' } }) }
  const git = { getRemoteUrl: vi.fn().mockResolvedValue('https://github.com/owner/repo.git') }
  const build = (config: unknown = {}, authentication: unknown = auth) => new GitHubIntegrationService(config as any, {} as any, authentication as any, api as any, catalog as any, git as any, {} as any)
  expect(await build(null).inspectPullRequestMergeability('/active', 23)).toMatchObject({ status: 'UNAVAILABLE', reason: 'CONFIGURATION_REQUIRED' })
  expect(await build({}, { hasCredentials: () => false }).inspectPullRequestMergeability('/active', 23)).toMatchObject({ reason: 'NOT_CONNECTED' })
  expect(await build().inspectPullRequestMergeability('/active', 23)).toMatchObject({ reason: 'REMOTE_CONFLICT' })
  git.getRemoteUrl.mockResolvedValue('https://example.com/owner/repo.git')
  expect(await build().inspectPullRequestMergeability('/active', 23)).toMatchObject({ reason: 'REMOTE_CONFLICT' })
  expect(api.inspectPullRequestMergeability).not.toHaveBeenCalled()
})
