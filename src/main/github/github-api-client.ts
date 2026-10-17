import type { GitHubRepositoryIdentity, GitHubRepositoryVisibility } from '../../shared/types/repository-catalog-types'
import type { GitHubUserProjection } from '../../shared/types/github-types'
import type { PullRequestMergeability } from '../../shared/types/git-evidence-types'
import type { PullRequestRecord } from '../../shared/types/branch-pull-request-types'
import { GITHUB_API_BASE_URL, GITHUB_API_VERSION, GITHUB_USER_AGENT } from './github-config'
import { GitHubIntegrationError, githubErrorMessage } from './github-errors'

interface GitHubInstallation { id: number; html_url?: string }
interface GitHubRepositoryDto {
  id: number
  name: string
  full_name: string
  visibility?: string
  private?: boolean
  html_url: string
  clone_url: string
  owner: { id: number; login: string }
}

export class GitHubApiClient {
  private readonly pullRequestPages = new Map<string, { etag: string; items: PullRequestRecord[]; hasNext: boolean }>()
  private pullRequestCacheRevision = 0
  clearPullRequestCache() { this.pullRequestCacheRevision++; this.pullRequestPages.clear() }
  async getPullRequestRepository(fullName: string) {
    const value = await this.request<any>(`/repos/${encodeRepositoryFullName(fullName)}`, { signal: AbortSignal.timeout(10_000) })
    if (!value || value.id == null || typeof value.full_name !== 'string' || typeof value.default_branch !== 'string' || value.full_name.toLowerCase() !== fullName.toLowerCase()) throw malformed()
    return { id: String(value.id), fullName: value.full_name as string, defaultBranch: value.default_branch as string }
  }

  async listPullRequests(fullName: string, page: number) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw malformed()
    const path = `/repos/${encodeRepositoryFullName(fullName)}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`
    const cached = this.pullRequestPages.get(path)
    const version = this.pullRequestCacheRevision
    const { value, response } = await this.requestWithResponse<any>(path, { signal: AbortSignal.timeout(10_000), ...(cached ? { headers: { 'If-None-Match': cached.etag } } : {}) }, cached?.items)
    if (response.status === 304 && cached) return { items: cached.items, hasNext: cached.hasNext }
    if (!Array.isArray(value)) throw malformed()
    const result = { items: value.map(parsePullRequest), hasNext: !!nextLink(response.headers.get('link')) }
    const etag = response.headers.get('etag')
    if (etag && version === this.pullRequestCacheRevision) {
      if (this.pullRequestPages.size >= 100) this.pullRequestPages.delete(this.pullRequestPages.keys().next().value!)
      this.pullRequestPages.set(path, { ...result, etag })
    }
    return result
  }

  async getPullRequest(fullName: string, number: number): Promise<PullRequestRecord> {
    if (!Number.isSafeInteger(number) || number < 1) throw malformed()
    return parsePullRequest(await this.request(`/repos/${encodeRepositoryFullName(fullName)}/pulls/${number}`, { signal: AbortSignal.timeout(10_000) }))
  }

  async getPullRequestCommits(fullName: string, number: number, page: number) {
    if (!Number.isSafeInteger(number) || number < 1 || !Number.isSafeInteger(page) || page < 1 || page > 1000) throw malformed()
    const { value, response } = await this.requestWithResponse<any>(`/repos/${encodeRepositoryFullName(fullName)}/pulls/${number}/commits?per_page=100&page=${page}`, { signal: AbortSignal.timeout(10_000) })
    if (!Array.isArray(value) || value.some(v => !/^[a-f0-9]{40,64}$/.test(v?.sha) || typeof v.commit?.message !== 'string' || !Number.isFinite(Date.parse(v.commit?.committer?.date)))) throw malformed()
    return { commits: value.map(v => ({ sha: v.sha as string, title: v.commit.message.split('\n')[0] as string, committedAt: v.commit.committer.date as string })), nextPage: nextLink(response.headers.get('link')) ? page + 1 : null }
  }

  async getBranchProtection(fullName: string, branch: string): Promise<boolean> {
    const value = await this.request<any>(`/repos/${encodeRepositoryFullName(fullName)}/branches/${encodeURIComponent(branch)}`, { signal: AbortSignal.timeout(10_000) })
    if (!value || typeof value.protected !== 'boolean' || value.name !== branch) throw malformed()
    return value.protected
  }
  constructor(
    private readonly tokenProvider: () => Promise<string>,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async getUser(): Promise<GitHubUserProjection> {
    const value = await this.request<any>('/user')
    if (!value || value.id == null || typeof value.login !== 'string') throw malformed()
    return { id: String(value.id), login: value.login, avatarUrl: typeof value.avatar_url === 'string' ? value.avatar_url : '' }
  }

  async inspectPullRequestMergeability(fullName: string, prNumber: number): Promise<PullRequestMergeability> {
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) throw malformed()
    const value = await this.request<any>(`/repos/${encodeRepositoryFullName(fullName)}/pulls/${prNumber}`, { signal: AbortSignal.timeout(10_000) })
    const validRef = (ref: any) => ref && typeof ref.ref === 'string' && /^[a-f0-9]{40,64}$/.test(ref.sha)
    if (!value || value.number !== prNumber || !['open', 'closed'].includes(value.state) || typeof value.draft !== 'boolean' || !validRef(value.base) || !validRef(value.head)) throw malformed()
    return { status: 'OBSERVED', source: 'GITHUB_REST', repository: fullName, prNumber, state: value.state, draft: value.draft,
      base: { ref: value.base.ref, sha: value.base.sha }, head: { ref: value.head.ref, sha: value.head.sha },
      mergeability: value.mergeable === true ? 'MERGEABLE' : value.mergeable === false ? 'NOT_MERGEABLE' : 'UNKNOWN',
      conflict: value.mergeable === false && value.mergeable_state === 'dirty' ? 'CONFLICT_CONFIRMED' : 'NOT_CONFIRMED',
      ...(typeof value.mergeable_state === 'string' ? { providerStatus: value.mergeable_state } : {}), observedAt: new Date().toISOString() }
  }

  async listInstallations(): Promise<GitHubInstallation[]> {
    return this.paginate<GitHubInstallation>('/user/installations', 'installations')
  }

  async listInstallationRepositories(installationId: number): Promise<GitHubRepositoryIdentity[]> {
    const values = await this.paginate<GitHubRepositoryDto>(`/user/installations/${installationId}/repositories`, 'repositories')
    return values.map(toIdentity)
  }

  async getRepository(fullName: string): Promise<GitHubRepositoryIdentity> {
    return toIdentity(await this.request<GitHubRepositoryDto>(`/repos/${encodeRepositoryFullName(fullName)}`))
  }

  async createRepository(name: string, visibility: 'PUBLIC' | 'PRIVATE'): Promise<GitHubRepositoryIdentity> {
    return toIdentity(await this.request<GitHubRepositoryDto>('/user/repos', {
      method: 'POST', body: JSON.stringify({ name, private: visibility === 'PRIVATE' })
    }))
  }

  private async paginate<T>(path: string, field: string): Promise<T[]> {
    const result: T[] = []
    let next: string | null = `${path}${path.includes('?') ? '&' : '?'}per_page=100`
    while (next) {
      const { value, response } = await this.requestWithResponse<any>(next)
      if (!value || !Array.isArray(value[field])) throw malformed()
      result.push(...value[field])
      next = nextLink(response.headers.get('link'))
    }
    return result
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    return (await this.requestWithResponse<T>(path, init)).value
  }

  private async requestWithResponse<T>(path: string, init?: RequestInit, notModified?: T): Promise<{ value: T; response: Response }> {
    const token = await this.tokenProvider()
    let response: Response
    try {
      response = await this.fetcher(path.startsWith('http') ? path : `${GITHUB_API_BASE_URL}${path}`, {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          'User-Agent': GITHUB_USER_AGENT,
          ...(init?.headers ?? {})
        }
      })
    } catch (error) {
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new GitHubIntegrationError('TIMEOUT', githubErrorMessage('TIMEOUT'))
      throw new GitHubIntegrationError('NETWORK_ERROR', githubErrorMessage('NETWORK_ERROR'))
    }
    if (response.status === 304 && notModified !== undefined) return { value: notModified, response }
    if (!response.ok) throw responseError(response)
    try { return { value: await response.json() as T, response } } catch { throw malformed() }
  }
}

function parsePullRequest(value: any): PullRequestRecord {
  const validRef = (ref: any) => ref && typeof ref.ref === 'string' && /^[a-f0-9]{40,64}$/.test(ref.sha)
  if (!value || value.id == null || !Number.isSafeInteger(value.number) || !['open', 'closed'].includes(value.state) || typeof value.draft !== 'boolean' || !validRef(value.head) || !validRef(value.base) || value.base.repo?.id == null || typeof value.base.repo.full_name !== 'string' || typeof value.html_url !== 'string' || typeof value.title !== 'string' || !Number.isFinite(Date.parse(value.created_at)) || !Number.isFinite(Date.parse(value.updated_at))) throw malformed()
  const mergedAt = typeof value.merged_at === 'string' && Number.isFinite(Date.parse(value.merged_at)) ? value.merged_at : null
  return { id: String(value.id), number: value.number, url: value.html_url, title: value.title, state: value.state, draft: value.draft,
    merged: value.merged === true || mergedAt !== null, mergedAt, mergeCommit: typeof value.merge_commit_sha === 'string' ? value.merge_commit_sha : null,
    createdAt: value.created_at, updatedAt: value.updated_at,
    base: { repositoryId: String(value.base.repo.id), repository: value.base.repo.full_name, ref: value.base.ref, sha: value.base.sha },
    head: { repositoryId: value.head.repo?.id == null ? null : String(value.head.repo.id), repository: typeof value.head.repo?.full_name === 'string' ? value.head.repo.full_name : null, ref: value.head.ref, sha: value.head.sha } }
}

function toIdentity(value: GitHubRepositoryDto): GitHubRepositoryIdentity {
  if (!value || value.id == null || !value.owner || value.owner.id == null || typeof value.owner.login !== 'string' ||
      typeof value.name !== 'string' || typeof value.full_name !== 'string' || typeof value.html_url !== 'string' || typeof value.clone_url !== 'string') {
    throw malformed()
  }
  const visibility = normalizeVisibility(value.visibility, value.private)
  return {
    repositoryId: String(value.id), ownerId: String(value.owner.id), ownerLogin: value.owner.login,
    name: value.name, fullName: value.full_name, visibility, htmlUrl: value.html_url,
    cloneUrl: value.clone_url, accessState: 'AVAILABLE', lastSeenAt: new Date().toISOString()
  }
}

function normalizeVisibility(value: string | undefined, isPrivate: boolean | undefined): GitHubRepositoryVisibility {
  const normalized = value?.toUpperCase()
  if (normalized === 'PUBLIC' || normalized === 'PRIVATE' || normalized === 'INTERNAL') return normalized
  return isPrivate ? 'PRIVATE' : 'PUBLIC'
}

function nextLink(header: string | null): string | null {
  if (!header) return null
  for (const entry of header.split(',')) {
    const match = entry.match(/<([^>]+)>;\s*rel="next"/)
    if (match) return match[1]
  }
  return null
}

function responseError(response: Response): GitHubIntegrationError {
  if (response.status === 429) return new GitHubIntegrationError('RATE_LIMITED', githubErrorMessage('RATE_LIMITED'))
  if (response.status === 401) return new GitHubIntegrationError('REAUTH_REQUIRED', githubErrorMessage('REAUTH_REQUIRED'))
  if (response.status === 404) return new GitHubIntegrationError('REPOSITORY_NOT_FOUND', githubErrorMessage('REPOSITORY_NOT_FOUND'))
  if (response.status === 422) return new GitHubIntegrationError('REPOSITORY_NAME_CONFLICT', githubErrorMessage('REPOSITORY_NAME_CONFLICT'))
  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
    return new GitHubIntegrationError('RATE_LIMITED', githubErrorMessage('RATE_LIMITED'))
  }
  if (response.status === 403) return new GitHubIntegrationError('PERMISSION_DENIED', githubErrorMessage('PERMISSION_DENIED'))
  return new GitHubIntegrationError('NETWORK_ERROR', githubErrorMessage('NETWORK_ERROR'))
}

function malformed(): GitHubIntegrationError {
  return new GitHubIntegrationError('NETWORK_ERROR', 'GitHub returned an invalid response.')
}

function encodeRepositoryFullName(fullName: string): string {
  return fullName.split('/').map(encodeURIComponent).join('/')
}
