import { describe, expect, it, vi } from 'vitest'
import { GitHubApiClient } from './github-api-client'
import { GitHubPullRequestCatalog } from './github-pull-request-catalog'
import { GitHubIntegrationService } from './github-integration-service'
import type { BranchInventory, BranchRecord } from '../../shared/types/branch-orchestration-types'

const sha = 'a'.repeat(40), other = 'b'.repeat(40)
const dto = (number: number, overrides: Record<string, unknown> = {}) => ({ id: number, number, html_url: `https://github.com/owner/repo/pull/${number}`, title: 'Delivery', state: 'open', draft: false, merged_at: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', base: { repo: { id: 1, full_name: 'owner/repo' }, ref: 'main', sha: other }, head: { repo: { id: 1, full_name: 'owner/repo' }, ref: 'topic', sha }, ...overrides })
const branch: BranchRecord = { key: 'branch', repositoryId: 'local', ref: 'refs/heads/topic', name: 'topic', namespace: 'LOCAL', head: sha, upstream: null, generation: 'generation', revision: 'one', creation: { source: 'UNKNOWN', at: null }, lastCommitAt: null, worktrees: [] }
const inventory = (branches = [branch]): BranchInventory => ({ repositoryId: 'local', source: 'GIT_LOCAL', coverage: 'COMPLETE', revision: 'inventory', observedAt: new Date().toISOString(), branches, worktrees: [], unassignedWorktrees: [] })
const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), init)

describe('repository pull request catalog', () => {
  it('keeps cached branch catalog separate from fresh PR summaries and post-token mutation approval', async () => {
    let head = sha
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/merge-async')) return json({ status: 'pending', details: { uuid: 'owned-request' } }, { status: 202 })
      if (url.pathname.endsWith('/pulls/7')) return json(dto(7, { stack: null, head: { repo: { id: 1, full_name: 'owner/repo' }, ref: 'topic', sha: head } }))
      const headers = init?.headers as Record<string, string>
      if (headers['If-None-Match']) return new Response(null, { status: 304 })
      return json([dto(7)], { headers: { etag: 'catalog-version' } })
    })
    const api = new GitHubApiClient(async () => 'secret', fetcher)
    expect((await api.listPullRequestCatalogPage('owner/repo', 1)).items[0].head.sha).toBe(sha)
    head = other
    expect((await api.listPullRequestCatalogPage('owner/repo', 1)).items[0].head.sha).toBe(sha)
    expect((await api.listPullRequests('owner/repo', { state: 'all' })).pullRequests[0].number).toBe(7)
    expect((await api.getPullRequest('owner/repo', 7)).head.sha).toBe(other)
    expect((await api.getPullRequestCatalogRecord('owner/repo', 7)).head.sha).toBe(other)
    const approval = vi.fn()
    expect(await api.requestPullRequestMerge('owner/repo', 7, other, false, approval)).toMatchObject({ httpStatus: 202 })
    expect(approval).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string)).toEqual({ sha: other, bypass_rules: false, merge_action: 'default', merge_method: 'merge' })
  })
  it('paginates state=all, deduplicates concurrent reads and caches one repository snapshot', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      return !url.includes('/pulls') ? json({ id: 1, full_name: 'owner/repo', default_branch: 'main' }) : url.includes('page=2') ? json([dto(2, { state: 'closed', merged_at: '2026-01-03T00:00:00Z' })]) : json([dto(1)], { headers: { link: '<https://api.github.com/repos/owner/repo/pulls?page=2>; rel="next"' } })
    })
    const reader = new GitHubPullRequestCatalog(new GitHubApiClient(async () => 'secret', fetcher))
    const [first, second] = await Promise.all([reader.read('local', 'owner/repo'), reader.read('local', 'owner/repo')])
    expect(first).toBe(second); expect(first.coverage).toBe('COMPLETE'); expect(first.items).toHaveLength(2)
    const projected = reader.project(inventory(), first)
    expect(projected.relations.map(r => r.classification)).toEqual(['CONFIRMED_CURRENT', 'CONFIRMED_CURRENT'])
    expect(projected.relations[1].pullRequest.merged).toBe(true)
    await reader.read('local', 'owner/repo')
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(String(fetcher.mock.calls[1][0])).toContain('state=all')
    expect(JSON.stringify(first)).not.toContain('secret')
  })
  it.each([
    ['open', false, null], ['open', true, null], ['closed', false, null], ['closed', false, '2026-01-03T00:00:00Z']
  ])('keeps provider state %s draft %s merged %s separate from checkout safety', async (state, draft, merged_at) => {
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).includes('/pulls') ? json([dto(1, { state, draft, merged_at })]) : json({ id: 1, full_name: 'owner/repo', default_branch: 'main' }))
    const reader = new GitHubPullRequestCatalog(new GitHubApiClient(async () => 'secret', fetcher))
    const result = reader.project(inventory(), await reader.read('local', 'owner/repo'))
    expect(result.relations[0]).toMatchObject({ classification: 'CONFIRMED_CURRENT', pullRequest: { state, draft, merged: !!merged_at } })
    expect(result).not.toHaveProperty('canDelete')
  })
  it('does not confirm matching names from forks, other repos, divergent heads, or recreated generations', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).includes('/pulls') ? json([dto(1), dto(2, { head: { repo: { id: 2, full_name: 'fork/repo' }, ref: 'topic', sha } }), dto(3, { head: { repo: { id: 3, full_name: 'other/repo' }, ref: 'topic', sha } })]) : json({ id: 1, full_name: 'owner/repo', default_branch: 'main' }))
    const reader = new GitHubPullRequestCatalog(new GitHubApiClient(async () => 'secret', fetcher))
    const catalog = await reader.read('local', 'owner/repo')
    const first = reader.project(inventory(), catalog)
    expect(first.relations.filter(r => r.classification === 'CONFIRMED_CURRENT').map(r => r.pullRequest.number)).toEqual([1])
    const moved = reader.project(inventory([{ ...branch, head: other, revision: 'two' }]), catalog)
    expect(moved.relations[0]).toMatchObject({ classification: 'CONFIRMED_HISTORICAL', historicalEvidence: { sha } })
    const recreated = reader.project(inventory([{ ...branch, head: other, generation: 'new' }]), catalog)
    expect(recreated.relations.every(r => r.classification === 'AMBIGUOUS')).toBe(true)
    expect(reader.project(inventory([]), catalog).orphaned).toHaveLength(3)
  })
  it('keeps partial/rate limited coverage inconclusive and never emits absence', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => !String(input).includes('/pulls') ? json({ id: 1, full_name: 'owner/repo', default_branch: 'main' }) : String(input).includes('page=2') ? json({}, { status: 429 }) : json([dto(1)], { headers: { link: '<https://api.github.com/repos/owner/repo/pulls?page=2>; rel="next"' } }))
    const reader = new GitHubPullRequestCatalog(new GitHubApiClient(async () => 'secret', fetcher))
    expect(await reader.read('local', 'owner/repo')).toMatchObject({ coverage: 'PARTIAL', reason: 'RATE_LIMITED', items: [expect.anything()] })
    const disconnected = new GitHubPullRequestCatalog(new GitHubApiClient(async () => { throw new Error('NOT_CONNECTED') }, fetcher))
    expect(await disconnected.read('local', 'owner/repo')).toMatchObject({ coverage: 'UNAVAILABLE', items: [] })
  })
  it('retains head/base and commit pagination from the provider', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(dto(7))).mockResolvedValueOnce(json([{ sha, commit: { message: 'own\nbody', committer: { date: '2026-01-01T00:00:00Z' } } }], { headers: { link: '<https://api.github.com/next>; rel="next"' } }))
    const api = new GitHubApiClient(async () => 'secret', fetcher)
    expect(await api.getPullRequestCatalogRecord('owner/repo', 7)).toMatchObject({ head: { sha }, base: { sha: other } })
    expect(await api.getPullRequestCommits('owner/repo', 7, 1)).toMatchObject({ commits: [{ sha, title: 'own' }], nextPage: 2 })
  })
  it('uses conditional page revalidation without losing pagination or origin evidence', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json([dto(1)], { headers: { etag: '"snapshot"', link: '<https://api.github.com/next>; rel="next"' } })).mockResolvedValueOnce(new Response(null, { status: 304 }))
    const api = new GitHubApiClient(async () => 'secret', fetcher)
    const first = await api.listPullRequestCatalogPage('owner/repo', 1)
    const second = await api.listPullRequestCatalogPage('owner/repo', 1)
    expect(second).toEqual(first); expect(second.hasNext).toBe(true)
    expect(fetcher.mock.calls[1][1].headers['If-None-Match']).toBe('"snapshot"')
    api.clearPullRequestCache()
    fetcher.mockResolvedValueOnce(json([dto(2)]))
    expect((await api.listPullRequestCatalogPage('owner/repo', 1)).items[0].number).toBe(2)
    expect(fetcher.mock.calls[2][1].headers['If-None-Match']).toBeUndefined()
  })
  it('invalidates in-flight catalogs on connection changes', async () => {
    let release!: (value: Response) => void
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve })).mockResolvedValue(json([]))
    const reader = new GitHubPullRequestCatalog(new GitHubApiClient(async () => 'secret', fetcher))
    const pending = reader.read('local', 'owner/repo')
    await vi.waitFor(() => expect(release).toBeDefined())
    reader.clear()
    release(json({ id: 1, full_name: 'owner/repo', default_branch: 'main' }))
    await expect(pending).rejects.toThrow('REMOTE_CONTEXT_CHANGED')
  })
  it('confirms known PRs individually before branch discard and refuses drift', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      return json(url.includes('/branches/') ? { name: 'topic', protected: false } : url.endsWith('/pulls/1') ? dto(1, { head: { repo: { id: 1, full_name: 'owner/repo' }, ref: 'topic', sha: other } }) : url.includes('/pulls?') ? [dto(1)] : { id: 1, full_name: 'owner/repo', default_branch: 'main' })
    })
    const api = new GitHubApiClient(async () => 'secret', fetcher)
    const service = new GitHubIntegrationService({} as any, {} as any, { hasCredentials: () => true } as any, api,
      { findByPath: () => ({ id: 'local', github: { repositoryId: '1', fullName: 'owner/repo' } }) } as any, { getRemoteUrl: async () => 'https://github.com/owner/repo.git' } as any, {} as any)
    expect(await service.assessBranchDiscard('/fixture', inventory(), branch)).toMatchObject({ coverage: 'PARTIAL', reason: 'PR_CHANGED_DURING_REVALIDATION', openPullRequests: [1], protected: false })
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/pulls/1'))).toBe(true)
  })
})
