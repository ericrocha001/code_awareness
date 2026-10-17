import type { GitHubRepositoryIdentity, GitHubRepositoryVisibility } from '../../shared/types/repository-catalog-types'
import type { GitHubUserProjection } from '../../shared/types/github-types'
import type { PullRequestMergeability } from '../../shared/types/git-evidence-types'
import { GITHUB_API_BASE_URL, GITHUB_API_VERSION, GITHUB_USER_AGENT } from './github-config'
import { GitHubIntegrationError, githubErrorMessage } from './github-errors'
import { PullRequestError, type PullRequestSummary, type PullRequestQuery, type CreatePullRequestInput } from '../../shared/types/github-pr-types'
import type { PullRequestReview, PullRequestCheck } from '../../shared/types/github-pr-types'
import { effectivePullRequestReviews, summarizePullRequestChecks, evaluatePullRequestPolicy } from './github-pr-evidence'

interface GitHubInstallation { id: number; app_slug?: string; account?: { login: string }; html_url?: string; permissions?: { pull_requests?: string; contents?: string; checks?: string; statuses?: string } }
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
  constructor(
    private readonly tokenProvider: () => Promise<string>,
    private readonly fetcher: typeof fetch = fetch,
    private readonly appSlug?: string
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

  async getPullRequestPermissions(fullName: string): Promise<{ read: boolean; create: boolean }> {
    const permissions = await this.getPullRequestEndpointPermissions(fullName)
    return { read: permissions.read, create: permissions.close }
  }

  async getPullRequestEndpointPermissions(fullName: string) {
    if (!this.appSlug) throw new GitHubIntegrationError('CONFIGURATION_REQUIRED', githubErrorMessage('CONFIGURATION_REQUIRED'))
    const repository = await this.request<GitHubRepositoryDto & { permissions?: { pull?: boolean; push?: boolean } }>(`/repos/${encodeRepositoryFullName(fullName)}`)
    if (repository.full_name?.toLowerCase() !== fullName.toLowerCase()) throw new GitHubIntegrationError('REMOTE_CONFLICT', githubErrorMessage('REMOTE_CONFLICT'))
    for (let page = 1; page <= 10; page++) {
      const installations = await this.request<{ installations: GitHubInstallation[] }>(`/user/installations?per_page=100&page=${page}`)
      if (!Array.isArray(installations.installations)) throw malformed()
      for (const installation of installations.installations) {
        if (installation.app_slug !== this.appSlug || installation.account?.login.toLowerCase() !== fullName.split('/')[0].toLowerCase()) continue
        for (let repoPage = 1; repoPage <= 10; repoPage++) {
          const repos = await this.request<{ repositories: GitHubRepositoryDto[] }>(`/user/installations/${installation.id}/repositories?per_page=100&page=${repoPage}`)
          if (!Array.isArray(repos.repositories)) throw malformed()
          if (repos.repositories.some(repo => repo.id === repository.id)) {
            const permission = installation.permissions?.pull_requests
            const readable = (value?: string) => repository.permissions?.pull === true && ['read', 'write'].includes(value ?? '')
            return { read: readable(permission), close: repository.permissions?.push === true && permission === 'write', merge: repository.permissions?.push === true && installation.permissions?.contents === 'write', checks: readable(installation.permissions?.checks), statuses: readable(installation.permissions?.statuses) }
          }
          if (repos.repositories.length < 100) break
          if (repoPage === 10) throw new PullRequestError('RECONCILIATION_LIMIT')
        }
      }
      if (installations.installations.length < 100) throw new GitHubIntegrationError('INSTALLATION_REQUIRED', githubErrorMessage('INSTALLATION_REQUIRED'))
    }
    throw new PullRequestError('RECONCILIATION_LIMIT')
  }

  async listPullRequests(fullName: string, query: PullRequestQuery = {}) {
    const page = query.cursor ? Number(query.cursor) : 1
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new PullRequestError('INVALID_ARGUMENT')
    const params = new URLSearchParams({ state: query.state ?? 'open', per_page: String(query.pageSize ?? 30), page: String(page), sort: 'created', direction: 'desc' })
    if (query.headBranch) params.set('head', `${fullName.split('/')[0]}:${query.headBranch}`)
    if (query.baseBranch) params.set('base', query.baseBranch)
    const { value, response } = await this.requestWithResponse<unknown>(`/repos/${encodeRepositoryFullName(fullName)}/pulls?${params}`)
    if (!Array.isArray(value) || value.length > (query.pageSize ?? 30)) throw malformed()
    return { pullRequests: value.map(item => toPullRequest(item, fullName)), ...(nextLink(response.headers.get('link')) ? { nextCursor: String(page + 1) } : {}) }
  }

  async getPullRequest(fullName: string, number: number): Promise<PullRequestSummary> {
    const result = toPullRequest(await this.request(`/repos/${encodeRepositoryFullName(fullName)}/pulls/${number}`), fullName)
    if (result.number !== number) throw malformed()
    return result
  }

  async getPullRequestReviews(fullName: string, number: number) {
    const pr = await this.getPullRequest(fullName, number)
    const page = await this.boundedPrEvidence(`/repos/${encodeRepositoryFullName(fullName)}/pulls/${number}/reviews`)
    const reviews: PullRequestReview[] = page.items.map(value => {
      if (!Number.isSafeInteger(value.id) || typeof value.user?.login !== 'string' || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED', 'COMMENTED', 'PENDING'].includes(value.state) || !/^[a-f0-9]{40}$/.test(value.commit_id) || !(value.submitted_at === null || typeof value.submitted_at === 'string')) throw malformed()
      return { id: value.id, reviewer: value.user.login, state: value.state, commitSha: value.commit_id, submittedAt: value.submitted_at }
    })
    return { headSha: pr.head.sha, reviews, ...effectivePullRequestReviews(reviews, pr.head.sha, page.complete), observedAt: new Date().toISOString() }
  }

  async getPullRequestChecks(fullName: string, number: number) {
    const pr = await this.getPullRequest(fullName, number)
    const root = `/repos/${encodeRepositoryFullName(fullName)}/commits/${pr.head.sha}`
    const sources = await Promise.allSettled([this.boundedPrEvidence(`${root}/check-runs`, 'check_runs'), this.boundedPrEvidence(`${root}/statuses`)])
    const checks: PullRequestCheck[] = []
    const availability: Record<string, string> = {}
    let complete = true
    sources.forEach((source, index) => {
      const kind = index === 0 ? 'CHECK_RUN' : 'COMMIT_STATUS'
      if (source.status === 'rejected') { complete = false; availability[kind] = 'UNAVAILABLE'; return }
      availability[kind] = source.value.complete ? 'COMPLETE' : 'INCOMPLETE'
      complete &&= source.value.complete
      for (const value of source.value.items) {
        if (!Number.isSafeInteger(value.id)) throw malformed()
        if (index === 0) {
          if (value.head_sha !== pr.head.sha || typeof value.name !== 'string' || typeof value.status !== 'string' || !Number.isSafeInteger(value.app?.id) || typeof value.updated_at !== 'string') throw malformed()
          const conclusion = typeof value.conclusion === 'string' ? value.conclusion : null
          const status = value.status !== 'completed' ? 'PENDING' : ['success', 'neutral', 'skipped'].includes(conclusion ?? '') ? 'PASSED' : ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'].includes(conclusion ?? '') ? 'FAILED' : 'UNKNOWN'
          checks.push({ id: value.id, name: value.name, kind, sha: pr.head.sha, appId: value.app.id, status, providerStatus: value.status, conclusion, updatedAt: value.updated_at })
        } else {
          if (typeof value.context !== 'string' || typeof value.state !== 'string' || typeof value.updated_at !== 'string') throw malformed()
          checks.push({ id: value.id, name: value.context, kind, sha: pr.head.sha, appId: null, status: value.state === 'success' ? 'PASSED' : value.state === 'pending' ? 'PENDING' : ['failure', 'error'].includes(value.state) ? 'FAILED' : 'UNKNOWN', providerStatus: value.state, conclusion: value.state, updatedAt: value.updated_at })
        }
      }
    })
    let policy: Awaited<ReturnType<GitHubApiClient['getPullRequestPolicy']>> | null = null
    try { policy = await this.getPullRequestPolicy(fullName, pr.base.ref) } catch { availability.POLICY = 'UNAVAILABLE' }
    return { headSha: pr.head.sha, checks, availability, policy, completeness: complete ? 'COMPLETE' : 'INCOMPLETE', ...summarizePullRequestChecks(checks, complete, policy?.coverage === 'COMPLETE' ? policy.requiredChecks : null), observedAt: new Date().toISOString() }
  }

  private async boundedPrEvidence(path: string, field?: string) {
    const items: any[] = []
    for (let page = 1; page <= 5; page++) {
      const { value, response } = await this.requestWithResponse<any>(`${path}?per_page=100&page=${page}`)
      const rows = field ? value?.[field] : value
      if (!Array.isArray(rows) || rows.length > 100) throw malformed()
      items.push(...rows)
      if (!nextLink(response.headers.get('link'))) return { items, complete: true }
    }
    return { items, complete: false }
  }

  async getPullRequestPolicy(fullName: string, branch: string) {
    const root = `/repos/${encodeRepositoryFullName(fullName)}`
    const repository = await this.request<any>(root)
    const branchState = await this.request<any>(`${root}/branches/${encodeURIComponent(branch)}`)
    const rules = await this.boundedPrEvidence(`${root}/rules/branches/${encodeURIComponent(branch)}`)
    const protection = await this.requestWithResponse<any>(`${root}/branches/${encodeURIComponent(branch)}/protection`, undefined, undefined, [404])
    const result = evaluatePullRequestPolicy(rules.items, protection.response.status === 404 ? null : protection.value, repository)
    if (!rules.complete || (protection.response.status === 404 && branchState.protected !== false)) {
      result.coverage = 'INCOMPLETE'
      result.limitations.push('POLICY_COVERAGE_UNKNOWN')
    }
    return result
  }

  async requestPullRequestMerge(fullName: string, number: number, headSha: string, queue: boolean, beforeSend: () => void | Promise<void>) {
    const result = await this.requestWithResponse<any>(`/repos/${encodeRepositoryFullName(fullName)}/pulls/${number}/merge-async`, {
      method: 'PUT', body: JSON.stringify({ sha: headSha, bypass_rules: false, merge_action: 'default', ...(!queue ? { merge_method: 'merge' } : {}) })
    }, beforeSend, [400, 403, 404, 409, 422])
    return { httpStatus: result.response.status, value: result.value }
  }

  async getPullRequestMergeRequest(fullName: string, number: number, uuid: string) {
    return this.requestWithResponse<any>(`/repos/${encodeRepositoryFullName(fullName)}/pulls/${number}/merge-async/${encodeURIComponent(uuid)}`, undefined, undefined, [404])
  }

  async closePullRequest(fullName: string, number: number, beforeSend: () => void | Promise<void>) {
    return toPullRequest(await this.request(`/repos/${encodeRepositoryFullName(fullName)}/pulls/${number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) }, beforeSend), fullName)
  }

  async getBranchSha(fullName: string, branch: string): Promise<string> {
    const ref = await this.request<any>(`/repos/${encodeRepositoryFullName(fullName)}/git/ref/heads/${encodeURIComponent(branch)}`)
    if (ref?.ref !== `refs/heads/${branch}` || ref.object?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(ref.object.sha)) throw malformed()
    return ref.object.sha
  }

  async createPullRequest(fullName: string, input: CreatePullRequestInput, beforeSend?: () => void | Promise<void>): Promise<PullRequestSummary> {
    return toPullRequest(await this.request(`/repos/${encodeRepositoryFullName(fullName)}/pulls`, {
      method: 'POST', body: JSON.stringify({ head: input.headBranch, base: input.baseBranch, title: input.title, body: input.body, draft: false })
    }, beforeSend), fullName)
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

  private async request<T>(path: string, init?: RequestInit, beforeSend?: () => void | Promise<void>): Promise<T> {
    return (await this.requestWithResponse<T>(path, init, beforeSend)).value
  }

  private async requestWithResponse<T>(path: string, init?: RequestInit, beforeSend?: () => void | Promise<void>, acceptedStatuses: number[] = []): Promise<{ value: T; response: Response }> {
    const token = await this.tokenProvider()
    await beforeSend?.()
    let response: Response
    try {
      response = await this.fetcher(path.startsWith('http') ? path : `${GITHUB_API_BASE_URL}${path}`, {
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
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
    if (!response.ok && !acceptedStatuses.includes(response.status)) throw responseError(response)
    try { return { value: await response.json() as T, response } } catch { throw malformed() }
  }
}

function toPullRequest(value: any, fullName: string): PullRequestSummary {
  const ref = (item: any) => item && typeof item.ref === 'string' && /^[a-f0-9]{40}$/.test(item.sha) && typeof item.repo?.full_name === 'string'
  if (!value || !Number.isSafeInteger(value.number) || value.number <= 0 || !['open', 'closed'].includes(value.state) || typeof value.draft !== 'boolean' || typeof value.title !== 'string' || !ref(value.head) || !ref(value.base) || value.base.repo.full_name.toLowerCase() !== fullName.toLowerCase() || value.html_url?.toLowerCase() !== `https://github.com/${fullName}/pull/${value.number}`.toLowerCase() || !(value.merged_at === null || typeof value.merged_at === 'string')) throw malformed()
  return { number: value.number, url: value.html_url, title: value.title, state: value.state, draft: value.draft,
    lifecycle: value.merged_at ? 'MERGED' : value.state === 'open' ? 'OPEN' : 'CLOSED',
    mergeCommitSha: /^[a-f0-9]{40}$/.test(value.merge_commit_sha ?? '') ? value.merge_commit_sha : null,
    stack: value.stack === null ? 'NONE' : value.stack && typeof value.stack === 'object' ? 'PRESENT' : 'UNKNOWN',
    head: { ref: value.head.ref, sha: value.head.sha, repository: value.head.repo.full_name }, base: { ref: value.base.ref, sha: value.base.sha, repository: value.base.repo.full_name },
    mergedAt: value.merged_at, mergeability: value.mergeable === true ? 'MERGEABLE' : value.mergeable === false ? 'NOT_MERGEABLE' : 'UNKNOWN', observedAt: new Date().toISOString() }
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
