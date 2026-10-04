import type { GitHubCreateRepositoryInput, GitHubOperationResult, GitHubPublishRepositoryInput, GitHubStatusProjection } from '../../shared/types/github-types'
import type { GitHubRepositoryIdentity, RepositoryRecord } from '../../shared/types/repository-catalog-types'
import type { GitService } from '../core/git-service'
import type { RepositoryCatalogService } from '../repository-catalog/repository-catalog-service'
import type { GitHubApiClient } from './github-api-client'
import type { GitHubAuthService, PendingGitHubAuthorization } from './github-auth-service'
import type { GitHubProductConfig } from './github-config'
import type { GitHubConnectionMetadata, GitHubCredentialStore } from './github-credential-store'
import { GitHubIntegrationError, githubErrorMessage, toGitHubIntegrationError } from './github-errors'

export interface ExternalUrlOpener { openExternal(url: string): Promise<unknown> }

export class GitHubIntegrationService {
  private pending: PendingGitHubAuthorization | null = null
  private authorizationError: GitHubIntegrationError | null = null
  private hasInstallation: boolean | null = null

  constructor(
    private readonly config: GitHubProductConfig | null,
    private readonly credentials: GitHubCredentialStore,
    private readonly auth: GitHubAuthService | null,
    private readonly api: GitHubApiClient | null,
    private readonly catalog: RepositoryCatalogService,
    private readonly git: GitService,
    private readonly external: ExternalUrlOpener
  ) {}

  getStatus(): GitHubStatusProjection {
    if (!this.config || !this.auth || !this.api) return { state: 'CONFIGURATION_REQUIRED', user: null }
    const metadata = this.credentials.loadMetadata()
    if (this.pending) return {
      state: 'AUTHORIZING', user: metadata.user,
      userCode: this.pending.userCode, verificationUri: this.pending.verificationUri
    }
    if (this.authorizationError?.code === 'REAUTH_REQUIRED') return this.statusFromMetadata('REAUTH_REQUIRED', metadata)
    if (!this.auth.hasCredentials()) return this.statusFromMetadata('DISCONNECTED', metadata)
    return this.statusFromMetadata(this.hasInstallation === false ? 'INSTALLATION_REQUIRED' : 'CONNECTED', metadata)
  }

  async connect(): Promise<GitHubStatusProjection> {
    this.requireConfigured()
    try {
      this.authorizationError = null
      this.pending = await this.auth!.begin()
      void this.completeAuthorization(this.pending)
      return this.getStatus()
    } catch (error) {
      this.authorizationError = toGitHubIntegrationError(error)
      throw this.authorizationError
    }
  }

  cancelConnect(): GitHubStatusProjection {
    this.auth?.cancel()
    this.pending = null
    this.authorizationError = null
    return this.getStatus()
  }

  disconnect(): GitHubStatusProjection {
    this.auth?.disconnect()
    this.pending = null
    this.authorizationError = null
    this.hasInstallation = null
    return this.getStatus()
  }

  async refresh(): Promise<RepositoryRecord[]> {
    this.requireConfigured()
    try {
      const user = await this.api!.getUser()
      const installations = await this.api!.listInstallations()
      this.hasInstallation = installations.length > 0
      if (!installations.length) {
        this.catalog.markGitHubUnavailableExcept([])
        const metadata = this.credentials.loadMetadata()
        this.credentials.saveMetadata({ ...metadata, user, lastSyncError: undefined })
        throw new GitHubIntegrationError('INSTALLATION_REQUIRED', githubErrorMessage('INSTALLATION_REQUIRED'))
      }
      const discovered = new Map<string, GitHubRepositoryIdentity>()
      for (const installation of installations) {
        for (const repository of await this.api!.listInstallationRepositories(installation.id)) {
          discovered.set(repository.repositoryId, repository)
        }
      }
      await this.reconcile([...discovered.values()])
      this.catalog.markGitHubUnavailableExcept([...discovered.keys()])
      const metadata: GitHubConnectionMetadata = {
        user,
        connectedAt: this.credentials.loadMetadata().connectedAt ?? new Date().toISOString(),
        lastSuccessfulSyncAt: new Date().toISOString()
      }
      this.credentials.saveMetadata(metadata)
      this.authorizationError = null
      return this.catalog.list()
    } catch (error) {
      const translated = toGitHubIntegrationError(error)
      if (translated.code === 'REAUTH_REQUIRED') this.authorizationError = translated
      const metadata = this.credentials.loadMetadata()
      this.credentials.saveMetadata({ ...metadata, lastSyncError: { code: translated.code, message: translated.message } })
      throw translated
    }
  }

  async cloneRepository(repositoryId: string, parentPath: string): Promise<GitHubOperationResult> {
    try {
      const repository = this.catalog.store.get(repositoryId)
      if (!repository.github || repository.github.accessState !== 'AVAILABLE') throw new GitHubIntegrationError('REPOSITORY_NOT_FOUND', githubErrorMessage('REPOSITORY_NOT_FOUND'))
      if (repository.localCheckout) throw new GitHubIntegrationError('LOCAL_PATH_CONFLICT', githubErrorMessage('LOCAL_PATH_CONFLICT'))
      const token = await this.auth!.getValidAccessToken()
      const checkoutPath = await this.git.cloneAuthenticated(repository.github.cloneUrl, parentPath, repository.github.name, token)
      await this.catalog.attachLocalCheckout(repository.id, checkoutPath)
      return { success: true, repositories: this.catalog.list() }
    } catch (error) { return failed(error) }
  }

  async createRepository(input: GitHubCreateRepositoryInput): Promise<GitHubOperationResult> {
    try {
      this.validateRepositoryName(input.name)
      const identity = await this.api!.createRepository(input.name, input.visibility)
      const record = this.catalog.createRemoteOnly(identity)
      if (!input.localParentPath) return { success: true, repositories: this.catalog.list() }
      const clone = await this.cloneRepository(record.id, input.localParentPath)
      if (!clone.success) return { ...clone, warning: 'Remote created; local checkout failed.' }
      return clone
    } catch (error) { return failed(error) }
  }

  async publishRepository(input: GitHubPublishRepositoryInput): Promise<GitHubOperationResult> {
    let record: RepositoryRecord | null = null
    try {
      this.validateRepositoryName(input.name)
      record = this.catalog.resolveAvailable(input.repositoryId)
      if (record.localCheckout!.gitState !== 'GIT') throw new GitHubIntegrationError('GIT_OPERATION_FAILED', 'Only Git repositories can be published.')
      if (record.github) throw new GitHubIntegrationError('REMOTE_CONFLICT', 'Repository is already linked to GitHub.')
      const origin = await this.git.getRemoteUrl(record.localCheckout!.path)
      const hadOrigin = Boolean(origin)
      let identity: GitHubRepositoryIdentity
      if (origin) {
        const fullName = normalizeGitHubOrigin(origin)
        if (!fullName) throw new GitHubIntegrationError('REMOTE_CONFLICT', githubErrorMessage('REMOTE_CONFLICT'))
        identity = await this.api!.getRepository(fullName)
        const owner = this.catalog.findByGitHubRepositoryId(identity.repositoryId)
        if (owner && owner.id !== record.id) throw new GitHubIntegrationError('REMOTE_CONFLICT', githubErrorMessage('REMOTE_CONFLICT'))
      } else {
        identity = await this.api!.createRepository(input.name, input.visibility)
        this.catalog.attachGitHub(record.id, identity)
        await this.git.addRemote(record.localCheckout!.path, 'origin', identity.cloneUrl)
      }
      if (!this.catalog.findByGitHubRepositoryId(identity.repositoryId)) this.catalog.attachGitHub(record.id, identity)
      if (await this.git.hasCommits(record.localCheckout!.path)) {
        const branch = await this.git.getCurrentBranch(record.localCheckout!.path)
        if (!branch) throw new GitHubIntegrationError('GIT_OPERATION_FAILED', githubErrorMessage('GIT_OPERATION_FAILED'))
        try {
          const token = await this.auth!.getValidAccessToken()
          if (hadOrigin) await this.git.pushUrlAuthenticated(record.localCheckout!.path, identity.cloneUrl, branch, token)
          else await this.git.pushAuthenticated(record.localCheckout!.path, 'origin', branch, token)
        } catch (error) {
          return { ...failed(error, 'GIT_OPERATION_FAILED'), repositories: this.catalog.list(), warning: 'Repository linked; push failed.' }
        }
      }
      return { success: true, repositories: this.catalog.list() }
    } catch (error) { return failed(error) }
  }

  async openAuthorization(): Promise<void> {
    const url = this.pending?.verificationUri
    if (!url) throw new GitHubIntegrationError('NOT_CONNECTED', githubErrorMessage('NOT_CONNECTED'))
    await this.external.openExternal(url)
  }

  async openInstallation(): Promise<void> {
    this.requireConfigured()
    await this.external.openExternal(this.installationUrl())
  }

  async openManageAccess(): Promise<void> {
    this.requireConfigured()
    await this.external.openExternal(`https://github.com/settings/installations`)
  }

  private async completeAuthorization(pending: PendingGitHubAuthorization): Promise<void> {
    try {
      await pending.completion
      if (this.pending !== pending) return
      this.pending = null
      await this.refresh()
    } catch (error) {
      if (this.pending !== pending) return
      this.pending = null
      this.authorizationError = toGitHubIntegrationError(error)
    }
  }

  private async reconcile(remotes: GitHubRepositoryIdentity[]): Promise<void> {
    const candidates = this.catalog.list(true).filter((record) =>
      !record.github && record.localCheckout?.availability === 'AVAILABLE' && record.localCheckout.gitState === 'GIT'
    )
    const localByRemote = new Map<string, RepositoryRecord[]>()
    for (const candidate of candidates) {
      const origin = await this.git.getRemoteUrl(candidate.localCheckout!.path)
      const fullName = origin ? normalizeGitHubOrigin(origin) : null
      if (!fullName) continue
      const key = fullName.toLocaleLowerCase('en-US')
      localByRemote.set(key, [...(localByRemote.get(key) ?? []), candidate])
    }
    for (const remote of remotes) {
      const known = this.catalog.findByGitHubRepositoryId(remote.repositoryId)
      if (known) { this.catalog.attachGitHub(known.id, remote); continue }
      const matches = localByRemote.get(remote.fullName.toLocaleLowerCase('en-US')) ?? []
      if (matches.length === 1) this.catalog.attachGitHub(matches[0].id, remote)
      else this.catalog.createRemoteOnly(remote)
    }
  }

  private statusFromMetadata(state: GitHubStatusProjection['state'], metadata: GitHubConnectionMetadata): GitHubStatusProjection {
    return {
      state, user: metadata.user,
      installationUrl: this.config ? this.installationUrl() : undefined,
      manageAccessUrl: this.config ? 'https://github.com/settings/installations' : undefined,
      lastSuccessfulSyncAt: metadata.lastSuccessfulSyncAt,
      lastSyncError: metadata.lastSyncError
    }
  }

  private installationUrl(): string { return `https://github.com/apps/${this.config!.appSlug}/installations/new` }
  private requireConfigured(): void {
    if (!this.config || !this.auth || !this.api) throw new GitHubIntegrationError('CONFIGURATION_REQUIRED', githubErrorMessage('CONFIGURATION_REQUIRED'))
  }
  private validateRepositoryName(name: string): void {
    if (!/^[A-Za-z0-9._-]+$/.test(name.trim())) throw new GitHubIntegrationError('REPOSITORY_NAME_CONFLICT', 'Repository name is invalid.')
  }
}

export function normalizeGitHubOrigin(value: string): string | null {
  const trimmed = value.trim()
  const match = trimmed.match(/^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/i)
  return match ? `${match[1]}/${match[2].replace(/\.git$/i, '')}` : null
}

function failed(error: unknown, fallback?: 'GIT_OPERATION_FAILED'): GitHubOperationResult {
  const translated = toGitHubIntegrationError(error, fallback ?? 'NETWORK_ERROR')
  return { success: false, error: { code: translated.code, message: translated.message, recoveryPath: translated.recoveryPath } }
}
