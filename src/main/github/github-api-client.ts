import type { GitHubRepositoryIdentity, GitHubRepositoryVisibility } from '../../shared/types/repository-catalog-types'
import type { GitHubUserProjection } from '../../shared/types/github-types'
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
  constructor(
    private readonly tokenProvider: () => Promise<string>,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async getUser(): Promise<GitHubUserProjection> {
    const value = await this.request<any>('/user')
    if (!value || value.id == null || typeof value.login !== 'string') throw malformed()
    return { id: String(value.id), login: value.login, avatarUrl: typeof value.avatar_url === 'string' ? value.avatar_url : '' }
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

  private async requestWithResponse<T>(path: string, init?: RequestInit): Promise<{ value: T; response: Response }> {
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
    } catch {
      throw new GitHubIntegrationError('NETWORK_ERROR', githubErrorMessage('NETWORK_ERROR'))
    }
    if (!response.ok) throw responseError(response)
    try { return { value: await response.json() as T, response } } catch { throw malformed() }
  }
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
