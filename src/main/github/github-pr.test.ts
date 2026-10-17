import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubApiClient } from './github-api-client'
import { GitHubIntegrationService } from './github-integration-service'
import { GitHubPullRequests } from './github-pull-requests'
import { executeGitHubPrTool, GITHUB_PR_TOOLS } from './github-pr-mcp'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import type { CreatePullRequestInput } from '../../shared/types/github-pr-types'
import { PullRequestError } from '../../shared/types/github-pr-types'

const roots: string[] = []
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const directory = () => { const root = mkdtempSync(join(tmpdir(), 'github-pr-')); roots.push(root); return root }
const sha = 'b'.repeat(40)
const input: CreatePullRequestInput = { headBranch: 'cline/feature', baseBranch: 'main', expectedHeadSha: sha, title: 'Implement feature', body: 'Validated change.', operationId: 'create-1', worktreeId: 'c'.repeat(64) }
const context = { repositoryId: 'selected-repository', repository: 'owner/repo' }
const summary = () => ({ number: 23, url: 'https://github.com/owner/repo/pull/23', title: input.title, state: 'open' as const, draft: false,
  head: { ref: input.headBranch, sha, repository: context.repository }, base: { ref: 'main', sha: 'a'.repeat(40), repository: context.repository }, mergedAt: null, mergeability: 'UNKNOWN' as const, observedAt: new Date().toISOString() })
const dto = () => ({ number: 23, html_url: summary().url, title: input.title, state: 'open', draft: false, head: { ref: input.headBranch, sha, repo: { full_name: context.repository } }, base: { ref: 'main', sha: 'a'.repeat(40), repo: { full_name: context.repository } }, merged_at: null, mergeable: null })
const response = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init)

function fixture() {
  const receiptDirectory = directory()
  let pulls: ReturnType<typeof summary>[] = []
  const api = {
    getPullRequestPermissions: vi.fn(async () => ({ read: true, create: true })),
    getBranchSha: vi.fn(async (_repo: string, branch: string) => branch === input.headBranch ? sha : 'a'.repeat(40)),
    listPullRequests: vi.fn(async () => ({ pullRequests: pulls, nextCursor: undefined as string | undefined })),
    getPullRequest: vi.fn(async () => pulls[0]),
    createPullRequest: vi.fn(async () => { pulls = [summary()]; return pulls[0] })
  }
  const approve = vi.fn(async () => true)
  const resolve = vi.fn(async () => context)
  const execution = { isActive: vi.fn(() => true), inspectWorktree: vi.fn(async () => ({ branch: input.headBranch, head: sha })) }
  const build = () => new GitHubPullRequests(api as any, resolve, { receiptDirectory, approve })
  return { api, approve, resolve, execution, build, receiptDirectory, setPulls: (values: ReturnType<typeof summary>[]) => { pulls = values } }
}

describe('authorized and idempotent PR creation', () => {
  it('creates and reads back a real non-draft PR from a Cline worktree while Desktop stays on main', async () => {
    const f = fixture()
    const result = await f.build().create(input, f.execution)
    expect(result).toMatchObject({ status: 'CREATED', pullRequest: { number: 23, draft: false, head: { ref: 'cline/feature', sha }, base: { ref: 'main' } } })
    expect(f.execution.inspectWorktree).toHaveBeenCalledWith(input.worktreeId)
    expect(f.approve).toHaveBeenCalledWith(expect.objectContaining({ ...input, ...context, operation: 'CREATE_PULL_REQUEST', expiresAt: expect.any(String) }))
    expect(f.api.createPullRequest).toHaveBeenCalledTimes(1)
    expect(f.api.getPullRequest).toHaveBeenCalledWith(context.repository, 23)
    expect(JSON.stringify(readdirSync(f.receiptDirectory, { recursive: true }).filter(path => String(path).endsWith('.json')).map(path => readFileSync(join(f.receiptDirectory, String(path)), 'utf8')))).not.toContain(input.body)
  })

  it('reconciles existing open PR without a POST or approval, persists identity and detects changed intent', async () => {
    const f = fixture(); f.setPulls([summary()])
    expect(await f.build().create(input, f.execution)).toMatchObject({ status: 'EXISTING_OPEN' })
    await expect(f.build().create({ ...input, body: 'Changed intent' }, f.execution)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect(f.approve).not.toHaveBeenCalled(); expect(f.api.createPullRequest).not.toHaveBeenCalled()
  })

  it.each([
    [{ state: 'closed' }, 'CLOSED_PR_REQUIRES_DECISION'],
    [{ mergedAt: '2026-10-17T00:00:00Z' }, 'CLOSED_PR_REQUIRES_DECISION'],
    [{ base: { ...summary().base, ref: 'release' } }, 'PR_IDENTITY_CONFLICT'],
    [{ head: { ...summary().head, sha: 'd'.repeat(40) } }, 'PR_IDENTITY_CONFLICT'],
    [{ draft: true }, 'PR_IDENTITY_CONFLICT']
  ])('blocks incompatible existing PR %j', async (patch, code) => {
    const f = fixture(); f.setPulls([{ ...summary(), ...patch } as any])
    await expect(f.build().create(input, f.execution)).rejects.toMatchObject({ code })
    expect(f.api.createPullRequest).not.toHaveBeenCalled()
  })

  it.each(['TIMEOUT', '422'])('reconciles after uncertain POST (%s) and replays after restart', async error => {
    const f = fixture()
    f.api.createPullRequest.mockImplementation(async () => { f.setPulls([summary()]); throw new Error(error) })
    expect(await f.build().create(input, f.execution)).toMatchObject({ status: 'EXISTING_OPEN', replayed: true })
    expect(await f.build().create(input, f.execution)).toMatchObject({ status: 'EXISTING_OPEN', replayed: true })
    expect(f.api.createPullRequest).toHaveBeenCalledTimes(1)
  })

  it('never repeats a POST after unknown outcome, even after restart or with another operationId', async () => {
    const f = fixture(); f.api.createPullRequest.mockRejectedValue(new Error('lost'))
    for (const operationId of [input.operationId, input.operationId, 'another-client']) await expect(f.build().create({ ...input, operationId }, f.execution)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    expect(f.api.createPullRequest).toHaveBeenCalledTimes(1)
  })

  it('fences concurrent clients before POST', async () => {
    const f = fixture()
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    f.api.createPullRequest.mockImplementation(async () => { await barrier; f.setPulls([summary()]); return summary() })
    const first = f.build().create(input, f.execution)
    await vi.waitFor(() => expect(f.api.createPullRequest).toHaveBeenCalledTimes(1))
    await expect(f.build().create({ ...input, operationId: 'competitor' }, f.execution)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    release(); await first
    expect(f.api.createPullRequest).toHaveBeenCalledTimes(1)
  })

  it('rechecks head/base discovery after POST and refuses an externally raced second PR', async () => {
    const f = fixture()
    f.api.createPullRequest.mockImplementation(async () => {
      f.setPulls([summary(), { ...summary(), number: 24, base: { ...summary().base, ref: 'release' } }])
      return summary()
    })
    await expect(f.build().create(input, f.execution)).rejects.toMatchObject({ code: 'PR_IDENTITY_CONFLICT' })
    expect(f.api.createPullRequest).toHaveBeenCalledTimes(1)
  })

  it.each(['denied', 'expired', 'head', 'worktree', 'project', 'permission'])('blocks %s before POST', async mode => {
    const f = fixture()
    const codes = { denied: 'AUTHORIZATION_DENIED', expired: 'AUTHORIZATION_EXPIRED', head: 'HEAD_DRIFT', worktree: 'WORKTREE_DRIFT', project: 'PROJECT_CHANGED', permission: 'PERMISSION_DENIED' }
    if (mode === 'denied') f.approve.mockResolvedValue(false)
    if (mode === 'expired') { vi.useFakeTimers(); f.approve.mockImplementation(async () => { vi.advanceTimersByTime(121000); return true }) }
    if (mode === 'head') f.api.getBranchSha.mockResolvedValue('d'.repeat(40))
    if (mode === 'worktree') f.execution.inspectWorktree.mockResolvedValue({ branch: 'main', head: sha })
    if (mode === 'project') f.approve.mockImplementation(async () => { f.execution.isActive.mockReturnValue(false); return true })
    if (mode === 'permission') f.api.getPullRequestPermissions.mockResolvedValue({ read: true, create: false })
    await expect(f.build().create(input, f.execution)).rejects.toMatchObject({ code: codes[mode as keyof typeof codes] })
    expect(f.api.createPullRequest).not.toHaveBeenCalled()
  })

  it('rechecks head after approval and fails closed when no approval port exists', async () => {
    const f = fixture(); f.approve.mockImplementation(async () => { f.api.getBranchSha.mockResolvedValue('d'.repeat(40)); return true })
    await expect(f.build().create(input, f.execution)).rejects.toMatchObject({ code: 'HEAD_DRIFT' })
    await expect(new GitHubPullRequests(f.api as any, f.resolve).create(input, f.execution)).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED' })
    expect(f.api.createPullRequest).not.toHaveBeenCalled()
  })

  it('refuses to POST when reconciliation cannot cover all PRs', async () => {
    const f = fixture(); f.api.listPullRequests.mockResolvedValue({ pullRequests: [], nextCursor: '2' })
    await expect(f.build().create(input, f.execution)).rejects.toMatchObject({ code: 'RECONCILIATION_LIMIT' })
    expect(f.api.createPullRequest).not.toHaveBeenCalled()
  })
})

describe('REST PR contract', () => {
  it('revalidates consent after asynchronous token acquisition, immediately before the POST', async () => {
    const fetcher = vi.fn()
    let tokenAcquired = false
    const api = new GitHubApiClient(async () => { tokenAcquired = true; return 'secret' }, fetcher)
    await expect(api.createPullRequest('owner/repo', input, () => {
      expect(tokenAcquired).toBe(true)
      throw new PullRequestError('AUTHORIZATION_EXPIRED')
    })).rejects.toMatchObject({ code: 'AUTHORIZATION_EXPIRED' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('bounds list output and reconstructs cursors without following provider URLs', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request) => response([dto()], { headers: { link: '<https://evil.example/secret>; rel="next"' } }))
    const api = new GitHubApiClient(async () => 'private-token', fetcher)
    expect(await api.listPullRequests('owner/repo', { headBranch: input.headBranch, state: 'all', pageSize: 1 })).toMatchObject({ nextCursor: '2', pullRequests: [{ number: 23, mergedAt: null }] })
    await api.listPullRequests('owner/repo', { cursor: '2' })
    expect(String(fetcher.mock.calls[1][0])).toContain('https://api.github.com/repos/owner/repo/pulls?')
    expect(String(fetcher.mock.calls[0][0])).toContain('head=owner%3Acline%2Ffeature')
  })

  it('POSTs only explicit head/base/title/body and forces draft false', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response(dto()))
    const api = new GitHubApiClient(async () => 'secret', fetcher)
    expect(await api.createPullRequest('owner/repo', input)).toMatchObject({ draft: false, url: summary().url })
    expect(JSON.parse((fetcher.mock.calls[0] as any)[1].body)).toEqual({ head: input.headBranch, base: 'main', title: input.title, body: input.body, draft: false })
    expect(JSON.stringify(await api.getPullRequest('owner/repo', 23))).not.toContain('secret')
  })

  it.each([{ html_url: 'https://github.com/owner/repo/pull/new/feature' }, { base: { ...dto().base, repo: { full_name: 'other/repo' } } }])('rejects malformed or redirected PR identity', async patch => {
    const api = new GitHubApiClient(async () => 'secret', vi.fn(async () => response({ ...dto(), ...patch })))
    await expect(api.getPullRequest('owner/repo', 23)).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
  })

  it('requires the configured App installation and both App write and user push permission', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const path = String(url)
      if (path.includes('/user/installations?')) return response({ installations: [{ id: 1, app_slug: 'different-app', account: { login: 'owner' }, permissions: { pull_requests: 'write' } }, { id: 2, app_slug: 'ours', account: { login: 'owner' }, permissions: { pull_requests: 'read' } }] })
      if (path.includes('/user/installations/2/')) return response({ repositories: [{ id: 7 }] })
      return response({ id: 7, full_name: 'owner/repo', permissions: { pull: true, push: true } })
    })
    const api = new GitHubApiClient(async () => 'secret', fetcher, 'ours')
    expect(await api.getPullRequestPermissions('owner/repo')).toEqual({ read: true, create: false })
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/installations/1/'))).toBe(false)
  })
})

describe('readiness and MCP binding', () => {
  function service(config: unknown = {}, auth: unknown = { hasCredentials: () => true }, origin = 'https://github.com/owner/repo.git', linked = 'owner/repo') {
    const api = { getRepository: vi.fn(async () => ({ fullName: 'owner/repo', repositoryId: '7' })), getPullRequestEndpointPermissions: vi.fn(async () => ({ read: true, close: true, checks: false, statuses: false, merge: false })), listPullRequests: vi.fn(async () => ({ pullRequests: [] })), getPullRequest: vi.fn(async () => summary()) }
    const integration = new GitHubIntegrationService(config as any, {} as any, auth as any, api as any, { findByPath: () => ({ id: context.repositoryId, github: { fullName: linked } }) } as any, { getRemoteUrl: vi.fn(async () => origin) } as any, {} as any, { receiptDirectory: directory(), approve: async () => false })
    return { integration, api }
  }

  it('reports configuration, disconnected, mismatch and ready without leaking credentials', async () => {
    expect(await service(null).integration.getPullRequestAccess('/active')).toMatchObject({ state: 'CONFIGURATION_REQUIRED', operations: { create: false } })
    expect(await service({}, { hasCredentials: () => false }).integration.getPullRequestAccess('/active')).toMatchObject({ state: 'NOT_CONNECTED' })
    expect(await service({}, undefined, 'https://example.com/owner/repo').integration.getPullRequestAccess('/active')).toMatchObject({ state: 'REMOTE_CONFLICT' })
    expect(await service({}, undefined, undefined, 'other/repo').integration.getPullRequestAccess('/active')).toMatchObject({ state: 'REMOTE_CONFLICT' })
    expect(await service().integration.getPullRequestAccess('/active')).toMatchObject({ state: 'READY', operations: { read: true, create: true } })
  })

  it.each(['REAUTH_REQUIRED', 'INSTALLATION_REQUIRED', 'PERMISSION_DENIED'])('preserves readiness %s', async code => {
    const f = service(); f.api.getPullRequestEndpointPermissions.mockRejectedValue(Object.assign(new Error(code), { code }))
    expect(await f.integration.getPullRequestAccess('/active')).toMatchObject({ state: code, operations: { create: false } })
  })

  it('routes every new tool to Git Operations and hides unavailable mutation', async () => {
    const f = service()
    const adapter = new ChannelMcpAdapter({ projectId: 'active', repoRoot: '/active-main', navigation: {} as any, githubIntegration: f.integration, githubPrIsActive: () => true })
    expect(adapter.listTools().map(tool => tool.name)).toEqual(expect.arrayContaining(GITHUB_PR_TOOLS.filter(tool => !['merge_pull_request', 'close_pull_request'].includes(tool.name)).map(tool => tool.name)))
    expect(adapter.listTools().some(tool => ['merge_pull_request', 'close_pull_request'].includes(tool.name))).toBe(false)
    for (const tool of GITHUB_PR_TOOLS) await adapter.callTool(tool.name, tool.name === 'get_pull_request' ? { prNumber: 23 } : tool.name === 'create_pull_request' ? input : {})
    expect(adapter.getActivityState().byCapability['Git Operations'].totalRequests).toBe(GITHUB_PR_TOOLS.length)
    expect(f.api.getPullRequest).toHaveBeenCalledWith('owner/repo', 23)
    const absent = new ChannelMcpAdapter({ projectId: 'active', repoRoot: '/active', navigation: {} as any, githubIntegration: service(null).integration, githubPrIsActive: () => true })
    expect(absent.listTools().some(tool => tool.name === 'create_pull_request')).toBe(false)
  })

  it.each([{ ...input, repository: 'other/repo' }, { ...input, headBranch: 'fork:feature' }, { ...input, expectedHeadSha: 'invalid' }, { ...input, baseBranch: input.headBranch }, { ...input, title: '' }, { ...input, body: '' }, { ...input, operationId: 123 }, { ...input, operationId: true }])('rejects invalid selectors and intent before dispatch', async values => {
    const createPullRequest = vi.fn()
    const result = await executeGitHubPrTool({ createPullRequest } as any, '/active', 'create_pull_request', values, { isActive: () => true })
    expect(result.isError).toBe(true); expect(createPullRequest).not.toHaveBeenCalled()
  })
})
