import { describe, expect, it, vi } from 'vitest'
import { GitHubApiClient } from './github-api-client'
import { GitHubIntegrationService } from './github-integration-service'
import { GITHUB_OFFICIAL_APP } from './github-config'

const repo = { id: 7, name: 'repo', full_name: 'owner/repo', owner: { id: 9, login: 'owner' }, private: false, html_url: 'https://github.com/owner/repo', clone_url: 'https://github.com/owner/repo.git', permissions: { pull: true, push: true } }
const allGrants = { pull_requests: 'write', checks: 'read', statuses: 'read', contents: 'write' }
function fixture() {
  const state = {
    installations: [{ id: 1, app_slug: GITHUB_OFFICIAL_APP.appSlug, account: { login: 'owner' }, permissions: { ...allGrants }, suspended_at: null as string | null }],
    repositories: [{ id: 7, full_name: 'owner/repo', permissions: { pull: true, push: true } }],
    registration: { slug: GITHUB_OFFICIAL_APP.appSlug, permissions: { ...allGrants } },
    failure: null as { path: string; status: number; headers?: Record<string, string> } | null,
    malformed: false,
    incomplete: false
  }
  const fetcher = vi.fn(async (url: any, init: any) => {
    expect(init.headers.Authorization).toBe('Bearer user-token-secret')
    const path = new URL(String(url)).pathname
    if (state.failure?.path === path) return new Response(JSON.stringify({ message: 'secret-provider-message' }), { status: state.failure.status, headers: state.failure.headers })
    let value: unknown
    if (path === '/repos/owner/repo') value = repo
    else if (path === '/user/installations') value = state.malformed ? {} : { installations: state.installations }
    else if (path === '/user/installations/1/repositories') value = { repositories: state.repositories }
    else if (path === `/apps/${GITHUB_OFFICIAL_APP.appSlug}`) value = state.registration
    else if (path === '/repos/owner/repo/pulls/24') value = { number: 24, html_url: 'https://github.com/owner/repo/pull/24', title: 'Public PR', state: 'open', draft: false, merged_at: null, head: { ref: 'feature', sha: 'a'.repeat(40), repo: { full_name: 'owner/repo' } }, base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'owner/repo' } } }
    else throw new Error('Unexpected endpoint')
    return new Response(JSON.stringify(value), { headers: state.incomplete && path === '/user/installations' ? { link: '<https://evil.example/secret>; rel="next"' } : {} })
  })
  const api = new GitHubApiClient(async () => 'user-token-secret', fetcher as any, GITHUB_OFFICIAL_APP.appSlug)
  const service = (native = true) => new GitHubIntegrationService({ ...GITHUB_OFFICIAL_APP }, {} as any, { hasCredentials: () => true } as any, api,
    { findByPath: () => ({ id: 'selected', github: { fullName: 'owner/repo', repositoryId: '7' } }) } as any,
    { getRemoteUrl: async () => 'https://github.com/owner/repo.git' } as any, {} as any,
    native ? { receiptDirectory: '/unused-read-only', approve: async () => false, approveMutation: async () => false } : undefined)
  return { state, api, service, fetcher }
}

describe('GitHub App scoped grant evidence', () => {
  it('reports an App authorized but not observably installed without inventing the cause', async () => {
    const f = fixture(); f.state.installations = []
    expect(await f.service().getPullRequestAccess('/active')).toMatchObject({ state: 'INSTALLATION_REQUIRED', operations: { read: false, create: false, merge: false }, evidence: { installation: 'NOT_OBSERVED' }, diagnostics: [{ cause: 'APP_INSTALLATION_NOT_ACCESSIBLE', nextAction: 'VERIFY_APP_INSTALLATION_AND_ACCOUNT_ACCESS' }] })
  })
  it('distinguishes installation visible from repository absent in user-token scope', async () => {
    const f = fixture(); f.state.repositories = []
    expect(await f.service().getPullRequestAccess('/active')).toMatchObject({ state: 'PERMISSION_DENIED', evidence: { installation: 'OBSERVED', repositoryScope: 'NOT_OBSERVED' }, diagnostics: [{ cause: 'REPOSITORY_NOT_ACCESSIBLE_IN_INSTALLATION' }] })
  })
  it('does not grant App permissions from a successful public PR read', async () => {
    const f = fixture(); f.state.installations[0].permissions = {} as any
    expect(await f.api.getPullRequest('owner/repo', 24)).toMatchObject({ number: 24 })
    const access = await f.service().getPullRequestAccess('/active')
    expect(access).toMatchObject({ state: 'PERMISSION_DENIED', operations: { read: false, create: false, close: false, merge: false }, evidence: { publicResourceReadIsGrantEvidence: false } })
    expect(access.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ cause: 'INSTALLATION_PERMISSION_UPDATE_NOT_GRANTED', requiredGrant: 'Pull requests: read' })]))
  })
  it('identifies requested App permissions that the installation has not granted', async () => {
    const f = fixture(); f.state.installations[0].permissions.pull_requests = 'read'
    const access = await f.service().getPullRequestAccess('/active')
    expect(access.operations).toMatchObject({ read: true, create: false, close: false })
    expect(access.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ cause: 'INSTALLATION_PERMISSION_UPDATE_NOT_GRANTED', requiredGrant: 'Pull requests: write', nextAction: 'REVIEW_AND_APPROVE_INSTALLATION_PERMISSION_UPDATE' })]))
  })
  it('diagnoses missing registration grants without claiming an unobservable pending approval', async () => {
    const f = fixture(); f.state.installations[0].permissions = {} as any; f.state.registration.permissions = {} as any
    const access = await f.service().getPullRequestAccess('/active')
    expect(access.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ cause: 'INSTALLATION_GRANT_MISSING', nextAction: 'REVIEW_APP_REQUESTED_PERMISSIONS_THEN_INSTALLATION' })]))
  })
  it('exposes partial per-endpoint permissions and never upgrades a read grant to write', async () => {
    const f = fixture(); f.state.installations[0].permissions = { pull_requests: 'read', statuses: 'read' } as any
    expect(await f.service().getPullRequestAccess('/active')).toMatchObject({ operations: { read: true, reviews: true, checks: false, statuses: true, create: false, close: false, merge: false } })
  })
  it('uses user permissions from installation scope rather than the public repository GET', async () => {
    const f = fixture(); f.state.repositories[0].permissions.push = false
    expect(await f.service().getPullRequestAccess('/active')).toMatchObject({ operations: { read: true, create: false, close: false, merge: false }, evidence: { userPermissions: { pull: true, push: false } }, diagnostics: [{ cause: 'USER_REPOSITORY_PERMISSION_MISSING' }] })
  })
  it('keeps missing user permission evidence inconclusive even with public pull/push metadata', async () => {
    const f = fixture(); delete (f.state.repositories[0] as any).permissions
    expect(await f.service().getPullRequestAccess('/active')).toMatchObject({ operations: { read: false, create: false, close: false, merge: false }, diagnostics: [{ cause: 'USER_REPOSITORY_PERMISSIONS_NOT_OBSERVED' }] })
  })
  it.each([
    [401, 'REAUTH_REQUIRED', 'USER_TOKEN_REAUTH_REQUIRED'],
    [403, 'PERMISSION_DENIED', 'PROVIDER_ACCESS_DENIED'],
    [404, 'REPOSITORY_NOT_FOUND', 'ACCESS_NOT_ESTABLISHED'],
    [429, 'RATE_LIMITED', 'PROVIDER_RATE_LIMITED']
  ])('classifies installation-list HTTP %s without leaking provider body or tokens', async (status, resultState, cause) => {
    const f = fixture(); f.state.failure = { path: '/user/installations', status: status as number }
    const access = await f.service().getPullRequestAccess('/active')
    expect(access).toMatchObject({ state: resultState, operations: { read: false, create: false, close: false, merge: false }, diagnostics: [{ cause, source: 'APP_INSTALLATIONS' }] })
    expect(JSON.stringify(access)).not.toMatch(/user-token-secret|secret-provider-message/)
  })
  it('reports incomplete provider data without inferring installation absence', async () => {
    const f = fixture(); f.state.malformed = true
    expect(await f.service().getPullRequestAccess('/active')).toMatchObject({ diagnostics: [{ cause: 'PROVIDER_RESPONSE_INCONCLUSIVE' }], operations: { read: false, merge: false } })
  })
  it('bounds paging and never follows provider-controlled Link URLs', async () => {
    const f = fixture(); f.state.incomplete = true
    expect(await f.service().getPullRequestAccess('/active')).toMatchObject({ diagnostics: [{ cause: 'ACCESS_PAGINATION_INCOMPLETE' }], operations: { read: false, merge: false } })
    expect(f.fetcher.mock.calls.every(([url]) => new URL(String(url)).hostname === 'api.github.com')).toBe(true)
    expect(f.fetcher.mock.calls.filter(([url]) => String(url).includes('/user/installations?'))).toHaveLength(10)
  })
  it('observes revocation on the next call without reusing an earlier successful grant', async () => {
    const f = fixture()
    expect(await f.service().getPullRequestAccess('/active')).toMatchObject({ state: 'READY', operations: { read: true, create: true, close: true, merge: true } })
    f.state.installations = []
    expect(await f.service().getPullRequestAccess('/active')).toMatchObject({ state: 'INSTALLATION_REQUIRED', operations: { read: false, create: false, close: false, merge: false } })
  })
  it('keeps native mutation gates mandatory even with every grant', async () => {
    const f = fixture()
    expect(await f.service(false).getPullRequestAccess('/active')).toMatchObject({ state: 'READY', operations: { read: true, create: false, close: false, merge: false } })
    expect(f.fetcher.mock.calls.every(([, init]) => !init.method || init.method === 'GET')).toBe(true)
  })
  it('blocks a suspended installation and missing grant evidence', async () => {
    const f = fixture(); f.state.installations[0].suspended_at = '2026-10-17T12:00:00Z'
    expect(await f.service().getPullRequestAccess('/active')).toMatchObject({ diagnostics: [{ cause: 'INSTALLATION_SUSPENDED' }], operations: { read: false, merge: false } })
    f.state.installations[0].suspended_at = null; delete (f.state.installations[0] as any).permissions
    expect(await f.service().getPullRequestAccess('/active')).toMatchObject({ state: 'UNAVAILABLE', diagnostics: [{ cause: 'INSTALLATION_GRANTS_NOT_OBSERVED' }] })
  })
})
