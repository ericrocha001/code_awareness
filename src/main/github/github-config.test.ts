import { afterEach, describe, expect, it, vi } from 'vitest'
import { GITHUB_OFFICIAL_APP, loadGitHubProductConfig } from './github-config'
import { GitHubAuthService } from './github-auth-service'

afterEach(() => vi.unstubAllEnvs())

describe('permanent public GitHub App identity', () => {
  it('uses the official public identity without environment or checkout files', () => {
    expect(loadGitHubProductConfig({})).toEqual({ clientId: 'Iv23liiSmi57iYNQVgM2', appSlug: 'code-awareness-desktop' })
    expect(loadGitHubProductConfig({})).not.toBe(GITHUB_OFFICIAL_APP)
  })
  it('accepts an explicit complete custom identity', () => {
    expect(loadGitHubProductConfig({ CODE_AWARENESS_GITHUB_CLIENT_ID: ' custom-id ', CODE_AWARENESS_GITHUB_APP_SLUG: ' custom-slug ' })).toEqual({ clientId: 'custom-id', appSlug: 'custom-slug' })
  })
  it.each([
    { CODE_AWARENESS_GITHUB_CLIENT_ID: 'custom-id' }, { CODE_AWARENESS_GITHUB_APP_SLUG: 'custom-slug' },
    { CODE_AWARENESS_GITHUB_CLIENT_ID: '', CODE_AWARENESS_GITHUB_APP_SLUG: '' },
    { CODE_AWARENESS_GITHUB_CLIENT_ID: 'custom-id', CODE_AWARENESS_GITHUB_APP_SLUG: ' ' }
  ])('rejects partial or empty explicit overrides without mixing App identities', environment => {
    expect(loadGitHubProductConfig(environment)).toBeNull()
  })
  it('reuses the existing session after restart without starting Device Flow', async () => {
    vi.stubEnv('CODE_AWARENESS_GITHUB_CLIENT_ID', undefined)
    vi.stubEnv('CODE_AWARENESS_GITHUB_APP_SLUG', undefined)
    const store = { loadCredentials: vi.fn(() => ({ accessToken: 'existing-session', accessTokenExpiresAt: '2999-01-01', refreshToken: 'existing-refresh', refreshTokenExpiresAt: '2999-01-01' })), saveCredentials: vi.fn() }
    const fetcher = vi.fn()
    for (let restart = 0; restart < 2; restart++) {
      const auth = new GitHubAuthService(loadGitHubProductConfig()!, store as any, fetcher)
      expect(await auth.getValidAccessToken()).toBe('existing-session')
    }
    expect(fetcher).not.toHaveBeenCalled()
    expect(store.saveCredentials).not.toHaveBeenCalled()
  })
})
