import type { GitHubProductConfig } from './github-config'
import { GITHUB_OAUTH_BASE_URL } from './github-config'
import type { GitHubCredentialStore, GitHubCredentials } from './github-credential-store'
import { GitHubIntegrationError, githubErrorMessage } from './github-errors'

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval?: number
}

interface TokenResponse {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  refresh_token_expires_in?: number
  error?: string
}

export interface PendingGitHubAuthorization {
  userCode: string
  verificationUri: string
  completion: Promise<string>
}

export class GitHubAuthService {
  private cancellation: AbortController | null = null

  constructor(
    private readonly config: GitHubProductConfig,
    private readonly store: GitHubCredentialStore,
    private readonly fetcher: typeof fetch = fetch,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly now: () => number = Date.now
  ) {}

  async begin(): Promise<PendingGitHubAuthorization> {
    this.cancel()
    const response = await this.fetcher(`${GITHUB_OAUTH_BASE_URL}/device/code`, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.config.clientId }).toString()
    }).catch(() => { throw new GitHubIntegrationError('NETWORK_ERROR', githubErrorMessage('NETWORK_ERROR')) })
    if (!response.ok) throw new GitHubIntegrationError('NETWORK_ERROR', githubErrorMessage('NETWORK_ERROR'))
    const device = await response.json() as DeviceCodeResponse
    if (!device.device_code || !device.user_code || !device.verification_uri || !device.expires_in) {
      throw new GitHubIntegrationError('NETWORK_ERROR', 'GitHub returned an invalid device authorization response.')
    }
    const cancellation = new AbortController()
    this.cancellation = cancellation
    return {
      userCode: device.user_code,
      verificationUri: device.verification_uri,
      completion: this.poll(device, cancellation.signal)
    }
  }

  cancel(): void {
    this.cancellation?.abort()
    this.cancellation = null
  }

  disconnect(): void {
    this.cancel()
    this.store.clearCredentials()
    this.store.clearMetadata()
  }

  async getValidAccessToken(): Promise<string> {
    let credentials: GitHubCredentials | null
    try { credentials = this.store.loadCredentials() } catch (error) {
      if (error instanceof Error && error.message === 'SECURE_STORAGE_UNAVAILABLE') {
        throw new GitHubIntegrationError('SECURE_STORAGE_UNAVAILABLE', githubErrorMessage('SECURE_STORAGE_UNAVAILABLE'))
      }
      throw new GitHubIntegrationError('REAUTH_REQUIRED', githubErrorMessage('REAUTH_REQUIRED'))
    }
    if (!credentials) throw new GitHubIntegrationError('NOT_CONNECTED', githubErrorMessage('NOT_CONNECTED'))
    if (Date.parse(credentials.accessTokenExpiresAt) > this.now() + 60_000) return credentials.accessToken
    if (Date.parse(credentials.refreshTokenExpiresAt) <= this.now()) {
      throw new GitHubIntegrationError('REAUTH_REQUIRED', githubErrorMessage('REAUTH_REQUIRED'))
    }
    const refreshed = await this.exchange({
      client_id: this.config.clientId,
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken
    })
    if (!refreshed.access_token || !refreshed.refresh_token || !refreshed.expires_in || !refreshed.refresh_token_expires_in) {
      throw new GitHubIntegrationError('REAUTH_REQUIRED', githubErrorMessage('REAUTH_REQUIRED'))
    }
    const next = credentialsFromResponse(refreshed, this.now())
    this.store.saveCredentials(next)
    return next.accessToken
  }

  hasCredentials(): boolean {
    try { return this.store.loadCredentials() !== null } catch { return false }
  }

  private async poll(device: DeviceCodeResponse, signal: AbortSignal): Promise<string> {
    const deadline = this.now() + device.expires_in * 1000
    let interval = Math.max(device.interval ?? 5, 1) * 1000
    while (this.now() < deadline) {
      await this.sleep(interval)
      if (signal.aborted) throw new GitHubIntegrationError('AUTHORIZATION_CANCELLED', githubErrorMessage('AUTHORIZATION_CANCELLED'))
      const token = await this.exchange({
        client_id: this.config.clientId,
        device_code: device.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
      if (token.error === 'authorization_pending') continue
      if (token.error === 'slow_down') { interval += 5_000; continue }
      if (token.error === 'access_denied') throw new GitHubIntegrationError('AUTHORIZATION_DENIED', githubErrorMessage('AUTHORIZATION_DENIED'))
      if (token.error === 'expired_token') throw new GitHubIntegrationError('AUTHORIZATION_EXPIRED', githubErrorMessage('AUTHORIZATION_EXPIRED'))
      if (!token.access_token || !token.refresh_token || !token.expires_in || !token.refresh_token_expires_in) {
        throw new GitHubIntegrationError('NETWORK_ERROR', 'GitHub returned an invalid token response.')
      }
      const credentials = credentialsFromResponse(token, this.now())
      this.store.saveCredentials(credentials)
      this.cancellation = null
      return credentials.accessToken
    }
    throw new GitHubIntegrationError('AUTHORIZATION_EXPIRED', githubErrorMessage('AUTHORIZATION_EXPIRED'))
  }

  private async exchange(body: Record<string, string>): Promise<TokenResponse> {
    const response = await this.fetcher(`${GITHUB_OAUTH_BASE_URL}/oauth/access_token`, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString()
    }).catch(() => { throw new GitHubIntegrationError('NETWORK_ERROR', githubErrorMessage('NETWORK_ERROR')) })
    if (!response.ok) throw new GitHubIntegrationError('NETWORK_ERROR', githubErrorMessage('NETWORK_ERROR'))
    return response.json() as Promise<TokenResponse>
  }
}

function credentialsFromResponse(response: Required<Pick<TokenResponse, 'access_token' | 'expires_in' | 'refresh_token' | 'refresh_token_expires_in'>>, now: number): GitHubCredentials {
  return {
    accessToken: response.access_token!,
    accessTokenExpiresAt: new Date(now + response.expires_in! * 1000).toISOString(),
    refreshToken: response.refresh_token!,
    refreshTokenExpiresAt: new Date(now + response.refresh_token_expires_in! * 1000).toISOString()
  }
}
