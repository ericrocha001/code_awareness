import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubApiClient } from './github-api-client'
import { GitHubAuthService } from './github-auth-service'
import { GitHubCredentialStore } from './github-credential-store'

const roots: string[] = []
const root = () => { const value = mkdtempSync(join(tmpdir(), 'github-auth-')); roots.push(value); return value }
const protection = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
  decryptString: (value: Buffer) => Buffer.from(value.toString().slice('encrypted:'.length), 'base64').toString(),
  getSelectedStorageBackend: () => 'dpapi'
}
const response = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init })

afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }) })

describe('GitHub authentication and secure identity', () => {
  it('handles pending and slow_down before persisting encrypted rotating credentials', async () => {
    const directory = root()
    const store = new GitHubCredentialStore(directory, protection)
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ device_code: 'device', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }))
      .mockResolvedValueOnce(response({ error: 'authorization_pending' }))
      .mockResolvedValueOnce(response({ error: 'slow_down' }))
      .mockResolvedValueOnce(response({ access_token: 'access-one', expires_in: 60, refresh_token: 'refresh-one', refresh_token_expires_in: 600 }))
      .mockResolvedValueOnce(response({ access_token: 'access-two', expires_in: 600, refresh_token: 'refresh-two', refresh_token_expires_in: 1200 }))
    let now = 1_000_000
    const auth = new GitHubAuthService({ clientId: 'client', appSlug: 'app' }, store, fetcher, async (ms) => { now += ms }, () => now)
    const pending = await auth.begin()
    expect(pending).toMatchObject({ userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device' })
    await expect(pending.completion).resolves.toBe('access-one')
    expect(readFileSync(join(directory, 'credentials.bin'), 'utf8')).not.toContain('access-one')
    now += 61_000
    await expect(auth.getValidAccessToken()).resolves.toBe('access-two')
    expect(store.loadCredentials()).toMatchObject({ accessToken: 'access-two', refreshToken: 'refresh-two' })
  })

  it.each([
    ['access_denied', 'AUTHORIZATION_DENIED'],
    ['expired_token', 'AUTHORIZATION_EXPIRED']
  ])('translates device flow %s', async (oauthError, expected) => {
    const store = new GitHubCredentialStore(root(), protection)
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ device_code: 'device', user_code: 'CODE', verification_uri: 'https://github.com/login/device', expires_in: 30, interval: 1 }))
      .mockResolvedValueOnce(response({ error: oauthError }))
    const auth = new GitHubAuthService({ clientId: 'client', appSlug: 'app' }, store, fetcher, async () => undefined)
    await expect((await auth.begin()).completion).rejects.toMatchObject({ code: expected })
  })

  it('cancels pending authorization without persisting credentials', async () => {
    const store = new GitHubCredentialStore(root(), protection)
    let release!: () => void
    const fetcher = vi.fn().mockResolvedValueOnce(response({ device_code: 'device', user_code: 'CODE', verification_uri: 'https://github.com/login/device', expires_in: 30, interval: 1 }))
    const auth = new GitHubAuthService({ clientId: 'client', appSlug: 'app' }, store, fetcher, () => new Promise<void>((resolve) => { release = resolve }))
    const pending = await auth.begin()
    auth.cancel()
    release()
    await expect(pending.completion).rejects.toMatchObject({ code: 'AUTHORIZATION_CANCELLED' })
    expect(store.loadCredentials()).toBeNull()
  })

  it('refuses insecure storage and disconnect removes credentials without repository side effects', () => {
    const directory = root()
    const store = new GitHubCredentialStore(directory, { ...protection, getSelectedStorageBackend: () => 'basic_text' })
    expect(() => store.saveCredentials({ accessToken: 'a', accessTokenExpiresAt: 'x', refreshToken: 'r', refreshTokenExpiresAt: 'y' }))
      .toThrow('SECURE_STORAGE_UNAVAILABLE')
  })
})

describe('GitHub API boundary', () => {
  it('centralizes headers and consumes all installation repository pages', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ repositories: [repository(1, 'one')] }, { headers: { link: '<https://api.github.com/page-2>; rel="next"' } }))
      .mockResolvedValueOnce(response({ repositories: [repository(2, 'two')] }))
    const api = new GitHubApiClient(async () => 'secret-token', fetcher)
    const result = await api.listInstallationRepositories(9)
    expect(result.map((item) => item.repositoryId)).toEqual(['1', '2'])
    expect(fetcher).toHaveBeenCalledTimes(2)
    for (const [, init] of fetcher.mock.calls) {
      expect(init.headers).toMatchObject({ Authorization: 'Bearer secret-token', 'X-GitHub-Api-Version': '2026-03-10' })
    }
  })

  it.each([
    [401, {}, 'REAUTH_REQUIRED'],
    [403, {}, 'PERMISSION_DENIED'],
    [403, { 'x-ratelimit-remaining': '0' }, 'RATE_LIMITED'],
    [404, {}, 'REPOSITORY_NOT_FOUND'],
    [422, {}, 'REPOSITORY_NAME_CONFLICT']
  ])('translates HTTP %s without exposing authorization', async (status, headers, code) => {
    const api = new GitHubApiClient(async () => 'do-not-leak', vi.fn(async () => response({}, { status, headers })))
    await expect(api.getRepository('owner/repo')).rejects.toMatchObject({ code })
    await expect(api.getRepository('owner/repo')).rejects.not.toThrow(/do-not-leak/)
  })
})

function repository(id: number, name: string) {
  return { id, name, full_name: `owner/${name}`, visibility: 'private', private: true, html_url: `https://github.com/owner/${name}`, clone_url: `https://github.com/owner/${name}.git`, owner: { id: 7, login: 'owner' } }
}
