import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubRepositoryIdentity } from '../../shared/types/repository-catalog-types'
import { WorkspaceService } from '../core/workspace-service'
import { RepositoryCatalogService } from '../repository-catalog/repository-catalog-service'
import { RepositoryCatalogStore } from '../repository-catalog/repository-catalog-store'
import { GitHubIntegrationService, normalizeGitHubOrigin } from './github-integration-service'
import { GitHubCredentialStore } from './github-credential-store'

const roots: string[] = []
const temp = () => { const value = mkdtempSync(join(tmpdir(), 'github-integration-')); roots.push(value); return value }
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }) })

describe('GitHub Repository Catalog integration', () => {
  it('reconciles HTTPS/SSH origins, deduplicates by GitHub ID, tracks rename/access loss, and survives reopen', async () => {
    const root = temp()
    const local = join(root, 'local-one'); mkdirSync(join(local, '.git'), { recursive: true })
    const storePath = join(temp(), 'catalog.db')
    let store = new RepositoryCatalogStore(storePath)
    let catalog = new RepositoryCatalogService(store, new WorkspaceService())
    const localRecord = await catalog.importLocal(local)
    let remotes = [identity('1', 'owner/local-one'), identity('2', 'owner/remote-only')]
    const api = {
      getUser: vi.fn(async () => ({ id: '7', login: 'owner', avatarUrl: '' })),
      listInstallations: vi.fn(async () => [{ id: 10 }, { id: 11 }]),
      listInstallationRepositories: vi.fn(async () => remotes)
    }
    const git = { getRemoteUrl: vi.fn(async () => 'git@github.com:owner/local-one.git') }
    const metadata = metadataStore()
    const service = integration(catalog, git, api, metadata)

    await service.refresh()
    expect(catalog.findByGitHubRepositoryId('1')).toMatchObject({ id: localRecord.id, github: { fullName: 'owner/local-one' } })
    const remoteOnly = catalog.findByGitHubRepositoryId('2')!
    expect(remoteOnly.localCheckout).toBeNull()
    expect(catalog.list(true)).toHaveLength(2)
    expect(api.listInstallationRepositories).toHaveBeenCalledTimes(2)

    remotes = [identity('2', 'renamed/remote')]
    await service.refresh()
    expect(catalog.findByGitHubRepositoryId('2')).toMatchObject({ id: remoteOnly.id, name: 'remote', github: { fullName: 'renamed/remote', accessState: 'AVAILABLE' } })
    expect(catalog.findByGitHubRepositoryId('1')?.github?.accessState).toBe('UNAVAILABLE')
    store.close()

    store = new RepositoryCatalogStore(storePath)
    catalog = new RepositoryCatalogService(store, new WorkspaceService())
    expect(catalog.findByGitHubRepositoryId('2')).toMatchObject({ id: remoteOnly.id, github: { fullName: 'renamed/remote' } })
    store.close()
  })

  it('preserves cached access on failed sync and preserves identity through clone/create/publish partial states', async () => {
    const root = temp()
    const data = temp()
    const destinations = { registerDestination: vi.fn(async () => undefined) }
    const store = new RepositoryCatalogStore(join(data, 'catalog.db'))
    const catalog = new RepositoryCatalogService(store, new WorkspaceService(), destinations)
    const remote = catalog.createRemoteOnly(identity('2', 'owner/remote'))
    const git = {
      getRemoteUrl: vi.fn(async () => null),
      cloneAuthenticated: vi.fn(async (_url: string, parent: string, name: string) => { const path = join(parent, name); mkdirSync(join(path, '.git'), { recursive: true }); return path }),
      hasCommits: vi.fn(async () => true), getCurrentBranch: vi.fn(async () => 'main'),
      addRemote: vi.fn(async () => undefined), pushAuthenticated: vi.fn(async () => { throw new Error('push failed') }), pushUrlAuthenticated: vi.fn()
    }
    const api = {
      getUser: vi.fn(async () => { throw new Error('offline') }),
      listInstallations: vi.fn(), listInstallationRepositories: vi.fn(),
      createRepository: vi.fn(async (name: string, visibility: string) => identity(name === 'created' ? '3' : '4', `owner/${name}`, visibility as any)),
      getRepository: vi.fn()
    }
    const metadata = metadataStore()
    const service = integration(catalog, git, api, metadata)
    await expect(service.refresh()).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(catalog.findByGitHubRepositoryId('2')?.github?.accessState).toBe('AVAILABLE')

    expect((await service.cloneRepository(remote.id, root)).success).toBe(true)
    expect(catalog.findByGitHubRepositoryId('2')).toMatchObject({ id: remote.id, localCheckout: { availability: 'AVAILABLE', gitState: 'GIT' } })
    expect(destinations.registerDestination).toHaveBeenCalledOnce()

    const created = await service.createRepository({ name: 'created', visibility: 'PRIVATE', localParentPath: root })
    expect(created.success).toBe(true)
    expect(catalog.findByGitHubRepositoryId('3')).toMatchObject({ github: { visibility: 'PRIVATE' }, localCheckout: { availability: 'AVAILABLE' } })

    const localPath = join(root, 'publish'); mkdirSync(join(localPath, '.git'), { recursive: true })
    const local = await catalog.importLocal(localPath)
    const publish = await service.publishRepository({ repositoryId: local.id, name: 'published', visibility: 'PUBLIC' })
    expect(publish).toMatchObject({ success: false, warning: 'Repository linked; push failed.' })
    expect(catalog.findByGitHubRepositoryId('4')?.id).toBe(local.id)
    expect(git.addRemote).toHaveBeenCalledWith(localPath, 'origin', 'https://github.com/owner/published.git')
    store.close()
  })

  it('normalizes only ordinary GitHub origin forms', () => {
    expect(normalizeGitHubOrigin('https://github.com/Owner/Repo.git')).toBe('Owner/Repo')
    expect(normalizeGitHubOrigin('git@github.com:owner/repo.git')).toBe('owner/repo')
    expect(normalizeGitHubOrigin('ssh://git@github.com/owner/repo')).toBe('owner/repo')
    expect(normalizeGitHubOrigin('https://gitlab.com/owner/repo.git')).toBeNull()
  })

  it('keeps secrets out of catalog and plaintext metadata', () => {
    const data = temp()
    const databasePath = join(data, 'catalog.db')
    const store = new RepositoryCatalogStore(databasePath)
    store.createRemoteOnly(identity('55', 'owner/secure'))
    const protection = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(Buffer.from(value).toString('base64')),
      decryptString: (value: Buffer) => Buffer.from(value.toString(), 'base64').toString(),
      getSelectedStorageBackend: () => 'dpapi'
    }
    const secrets = new GitHubCredentialStore(join(data, 'github'), protection)
    secrets.saveCredentials({ accessToken: 'ghu_secret_value', accessTokenExpiresAt: '2999-01-01', refreshToken: 'ghr_secret_value', refreshTokenExpiresAt: '2999-01-01' })
    secrets.saveMetadata({ user: { id: '7', login: 'owner', avatarUrl: '' } })
    expect(readFileSync(databasePath).toString()).not.toMatch(/gh[ur]_secret_value/)
    expect(readFileSync(join(data, 'github', 'metadata.json'), 'utf8')).not.toMatch(/gh[ur]_secret_value/)
    expect(readFileSync(join(data, 'github', 'credentials.bin'), 'utf8')).not.toMatch(/gh[ur]_secret_value/)
    store.close()
  })
})

function identity(repositoryId: string, fullName: string, visibility: 'PUBLIC' | 'PRIVATE' = 'PRIVATE'): GitHubRepositoryIdentity {
  const [ownerLogin, name] = fullName.split('/')
  return { repositoryId, ownerId: '7', ownerLogin, name, fullName, visibility, htmlUrl: `https://github.com/${fullName}`, cloneUrl: `https://github.com/${fullName}.git`, accessState: 'AVAILABLE', lastSeenAt: new Date().toISOString() }
}

function metadataStore() {
  let metadata: any = { user: null }
  return { loadMetadata: () => metadata, saveMetadata: (value: any) => { metadata = value }, loadCredentials: () => ({ accessToken: 'token', accessTokenExpiresAt: '2999-01-01', refreshToken: 'refresh', refreshTokenExpiresAt: '2999-01-01' }), clearCredentials: vi.fn(), clearMetadata: vi.fn() }
}

function integration(catalog: RepositoryCatalogService, git: any, api: any, credentials: any) {
  const auth = { hasCredentials: () => true, getValidAccessToken: async () => 'token', disconnect: vi.fn(), cancel: vi.fn(), begin: vi.fn() }
  return new GitHubIntegrationService({ clientId: 'client', appSlug: 'app' }, credentials, auth as any, api as any, catalog, git as any, { openExternal: vi.fn() })
}
