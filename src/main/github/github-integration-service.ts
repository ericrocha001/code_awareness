import type { GitHubCreateRepositoryInput, GitHubOperationResult, GitHubPublishRepositoryInput, GitHubStatusProjection } from '../../shared/types/github-types'
import type { GitHubRepositoryIdentity, RepositoryRecord } from '../../shared/types/repository-catalog-types'
import type { GitService } from '../core/git-service'
import type { RepositoryCatalogService } from '../repository-catalog/repository-catalog-service'
import type { GitHubApiClient } from './github-api-client'
import type { GitHubAuthService, PendingGitHubAuthorization } from './github-auth-service'
import type { GitHubProductConfig } from './github-config'
import type { GitHubConnectionMetadata, GitHubCredentialStore } from './github-credential-store'
import { GitHubIntegrationError, githubErrorMessage, toGitHubIntegrationError } from './github-errors'
import { GitHubPullRequests, type PullRequestDependencies, type PullRequestExecutionContext } from './github-pull-requests'
import { GitHubPrIntegration } from './github-pr-integration'
import type { PullRequestMutationInput } from '../../shared/types/github-pr-types'
import { PullRequestError, type CreatePullRequestInput, type PullRequestQuery } from '../../shared/types/github-pr-types'
import { GitHubPrAccessError, pullRequestAccessFailure } from './github-pr-access'
import { GitHubPullRequestCatalog } from './github-pull-request-catalog'
import { createHash } from 'node:crypto'
import type { BranchRecord } from '../../shared/types/branch-orchestration-types'
import type { BranchDiscardRemoteEvidence } from '../../shared/types/branch-discard-types'
import type { BranchInventory } from '../../shared/types/branch-orchestration-types'
import type { BranchPullRequests, PullRequestCatalog, PullRequestCommitsPage } from '../../shared/types/branch-pull-request-types'

export interface ExternalUrlOpener { openExternal(url: string): Promise<unknown> }

export class GitHubIntegrationService {
  private connectionRevision = 0
  async assessBranchDiscard(repoPath: string, inventory: BranchInventory, branch: BranchRecord): Promise<BranchDiscardRemoteEvidence> {
    const origin = await this.git.getRemoteUrl(repoPath)
    if (!origin) return { repositoryId: inventory.repositoryId, coverage: 'COMPLETE', observedAt: new Date().toISOString(), revision: 'LOCAL_ONLY', defaultBranch: 'main', protected: false, openPullRequests: [], knownPullRequests: [], reason: null }
    const { catalog } = await this.branchPullRequests(repoPath, inventory, true)
    let coverage = catalog.coverage, reason = catalog.reason
    let protection: boolean | null = null
    try { protection = await this.branchProtection(repoPath, branch.name) } catch {}
    const prs = catalog.items.filter(pr => pr.head.repositoryId === catalog.providerRepositoryId && pr.head.repository?.toLowerCase() === catalog.repository?.toLowerCase() && pr.head.ref === branch.name)
    if (prs.length > 20) { coverage = 'PARTIAL'; reason = 'PR_CONFIRMATION_LIMIT' }
    else for (const pr of prs) {
      try {
        const confirmed = await this.api!.getPullRequestCatalogRecord(catalog.repository!, pr.number)
        if (confirmed.id !== pr.id || confirmed.updatedAt !== pr.updatedAt || confirmed.head.sha !== pr.head.sha || confirmed.head.ref !== branch.name || confirmed.head.repositoryId !== catalog.providerRepositoryId || confirmed.base.repositoryId !== catalog.providerRepositoryId || confirmed.state !== pr.state) { coverage = 'PARTIAL'; reason = 'PR_CHANGED_DURING_REVALIDATION' }
      } catch { coverage = 'PARTIAL'; reason = 'PR_CONFIRMATION_UNAVAILABLE' }
    }
    const evidence = { repositoryId: inventory.repositoryId, coverage, defaultBranch: catalog.defaultBranch, protected: protection,
      openPullRequests: prs.filter(pr => pr.state === 'open').map(pr => pr.number), knownPullRequests: prs.map(pr => ({ number: pr.number, state: pr.state, merged: pr.merged })), reason }
    return { ...evidence, observedAt: catalog.observedAt, revision: createHash('sha256').update(JSON.stringify([evidence, prs])).digest('hex') }
  }
  private pullRequestCatalog: GitHubPullRequestCatalog | null = null

  private async pullRequestOrigin(repoPath: string) {
    this.requireConfigured()
    if (!this.auth!.hasCredentials()) throw new GitHubIntegrationError('NOT_CONNECTED', githubErrorMessage('NOT_CONNECTED'))
    const remote = await this.git.getRemoteUrl(repoPath), fullName = remote ? normalizeGitHubOrigin(remote) : null
    if (!fullName) throw new Error('REMOTE_CONFLICT')
    const record = this.catalog.findByPath(repoPath)
    if (!record || record.github && record.github.fullName.toLowerCase() !== fullName.toLowerCase()) throw new Error('REMOTE_CONFLICT')
    return { fullName, repositoryId: record.id, providerRepositoryId: record.github?.repositoryId }
  }

  async branchPullRequests(repoPath: string, inventory: BranchInventory, force = false): Promise<BranchPullRequests> {
    try {
      const connection = this.connectionRevision
      const origin = await this.pullRequestOrigin(repoPath)
      if (origin.repositoryId !== inventory.repositoryId) throw new Error('REPOSITORY_CONTEXT_CHANGED')
      const reader = this.pullRequestCatalog ??= new GitHubPullRequestCatalog(this.api!)
      const catalog = await reader.read(inventory.repositoryId, origin.fullName, force)
      const after = await this.pullRequestOrigin(repoPath)
      if (connection !== this.connectionRevision || after.repositoryId !== origin.repositoryId || after.fullName !== origin.fullName) throw new Error('REMOTE_CONTEXT_CHANGED')
      if (origin.providerRepositoryId && catalog.providerRepositoryId !== origin.providerRepositoryId) throw new Error('REMOTE_IDENTITY_MISMATCH')
      return reader.project(inventory, catalog)
    } catch (error) {
      const catalog: PullRequestCatalog = { repositoryId: inventory.repositoryId, repository: null, providerRepositoryId: null, defaultBranch: null,
        source: 'GITHUB_REST', coverage: 'UNAVAILABLE', observedAt: new Date().toISOString(), revision: 'UNAVAILABLE', items: [], reason: error instanceof Error ? error.message : 'GITHUB_UNAVAILABLE' }
      return { repositoryId: inventory.repositoryId, catalog, relations: [], received: [], orphaned: [] }
    }
  }

  async branchProtection(repoPath: string, branch: string) {
    const origin = await this.pullRequestOrigin(repoPath)
    return this.api!.getBranchProtection(origin.fullName, branch)
  }

  async pullRequestCommits(repoPath: string, number: number, head: string, page = 1): Promise<PullRequestCommitsPage> {
    const origin = await this.pullRequestOrigin(repoPath)
    const before = await this.api!.getPullRequestCatalogRecord(origin.fullName, number)
    if (before.head.sha !== head || before.base.repository.toLowerCase() !== origin.fullName.toLowerCase()) throw new Error('PR_STATE_CHANGED')
    const commits = await this.api!.getPullRequestCommits(origin.fullName, number, page)
    const after = await this.api!.getPullRequestCatalogRecord(origin.fullName, number)
    if (after.head.sha !== head || after.updatedAt !== before.updatedAt) throw new Error('PR_STATE_CHANGED')
    return { repositoryId: origin.repositoryId, prNumber: number, head, source: 'GITHUB_REST', observedAt: new Date().toISOString(), ...commits }
  }
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
    private readonly external: ExternalUrlOpener,
    private readonly pullRequestDependencies?: PullRequestDependencies
  ) {}

  canCreatePullRequests(): boolean { return !!(this.config && this.auth && this.api && this.pullRequestDependencies) }
  canIntegratePullRequests(): boolean { return this.canCreatePullRequests() && !!this.pullRequestDependencies?.approveMutation }

  async getPullRequestReviews(repoPath: string, number: number) {
    const context = await this.pullRequestContext(repoPath)
    return { ...context, ...await this.api!.getPullRequestReviews(context.repository, number) }
  }

  async getPullRequestChecks(repoPath: string, number: number) {
    const context = await this.pullRequestContext(repoPath)
    return { ...context, ...await this.api!.getPullRequestChecks(context.repository, number) }
  }

  async mutatePullRequest(repoPath: string, operation: 'MERGE_PULL_REQUEST' | 'CLOSE_PULL_REQUEST', input: PullRequestMutationInput, execution: PullRequestExecutionContext) {
    this.requireConfigured()
    return new GitHubPrIntegration(this.api!, () => this.pullRequestContext(repoPath), this.pullRequestDependencies).mutate(operation, input, execution)
  }

  async getPullRequestOperation(repoPath: string, operationId: string) {
    this.requireConfigured()
    return new GitHubPrIntegration(this.api!, () => this.pullRequestContext(repoPath), this.pullRequestDependencies).status(operationId)
  }

  private async pullRequestContext(repoPath: string) {
    this.requireConfigured()
    if (!this.auth!.hasCredentials()) throw new GitHubIntegrationError('NOT_CONNECTED', githubErrorMessage('NOT_CONNECTED'))
    const remote = await this.git.getRemoteUrl(repoPath)
    const repository = remote ? normalizeGitHubOrigin(remote) : null
    const record = this.catalog.findByPath(repoPath)
    if (!repository || !record || (record.github && record.github.fullName.toLowerCase() !== repository.toLowerCase())) throw new GitHubIntegrationError('REMOTE_CONFLICT', githubErrorMessage('REMOTE_CONFLICT'))
    const remoteIdentity = await this.api!.getRepository(repository)
    if (remoteIdentity.fullName.toLowerCase() !== repository.toLowerCase() || (record.github?.repositoryId && record.github.repositoryId !== remoteIdentity.repositoryId)) throw new GitHubIntegrationError('REMOTE_CONFLICT', githubErrorMessage('REMOTE_CONFLICT'))
    return { repositoryId: record.id, repository }
  }

  async getPullRequestAccess(repoPath: string) {
    try {
      const context = await this.pullRequestContext(repoPath)
      const permissions = await this.api!.getPullRequestEndpointPermissions(context.repository)
      return { ...context, state: permissions.accessState ?? (permissions.read ? 'READY' : 'PERMISSION_DENIED'), diagnostics: permissions.diagnostics ?? [], evidence: permissions.evidence, operations: { read: permissions.read, reviews: permissions.read, checks: permissions.checks, statuses: permissions.statuses, create: permissions.read && permissions.close && this.canCreatePullRequests(), close: permissions.read && permissions.close && this.canIntegratePullRequests(), merge: permissions.merge && permissions.read && permissions.checks && permissions.statuses && this.canIntegratePullRequests() },
        restrictions: ['DESKTOP_APPROVAL_REQUIRED', 'SAME_REPOSITORY_ONLY', 'NO_LOCAL_GIT_SYNC', 'NO_ATOMIC_BASE_CAS'], requiredPermissions: { read: 'Pull requests: read', reviews: 'Pull requests: read', checks: 'Checks: read', statuses: 'Commit statuses: read', create: 'Pull requests: write', close: 'Pull requests: write', merge: 'Contents: write' }, observedAt: new Date().toISOString() }
    } catch (error) {
      const code = error instanceof PullRequestError ? error.code : toGitHubIntegrationError(error).code
      return { state: code, operations: { read: false, reviews: false, checks: false, statuses: false, create: false, close: false, merge: false }, diagnostics: [error instanceof GitHubPrAccessError ? error.diagnostic : pullRequestAccessFailure(code)], configurationRequired: !this.config ? ['CODE_AWARENESS_GITHUB_CLIENT_ID', 'CODE_AWARENESS_GITHUB_APP_SLUG'] : [], recovery: 'Use GitHub settings in Desktop to configure, connect or manage installation access.', observedAt: new Date().toISOString() }
    }
  }

  async listPullRequests(repoPath: string, query: PullRequestQuery) {
    const context = await this.pullRequestContext(repoPath)
    return { ...context, ...await this.api!.listPullRequests(context.repository, query) }
  }

  async getPullRequest(repoPath: string, number: number) {
    const context = await this.pullRequestContext(repoPath)
    return { ...context, pullRequest: await this.api!.getPullRequest(context.repository, number) }
  }

  async createPullRequest(repoPath: string, input: CreatePullRequestInput, execution: PullRequestExecutionContext) {
    this.requireConfigured()
    return new GitHubPullRequests(this.api!, () => this.pullRequestContext(repoPath), this.pullRequestDependencies).create(input, execution)
  }

  getStatus(): GitHubStatusProjection {
    if (!this.config || !this.auth || !this.api) return { state: 'CONFIGURATION_REQUIRED', user: null, lastSyncError: { code: 'CONFIGURATION_REQUIRED', message: 'Provide both GitHub App overrides or remove both to use the official product identity.' } }
    const metadata = this.credentials.loadMetadata()
    if (this.pending) return {
      state: 'AUTHORIZING', user: metadata.user,
      userCode: this.pending.userCode, verificationUri: this.pending.verificationUri
    }
    if (this.authorizationError?.code === 'REAUTH_REQUIRED') return this.statusFromMetadata('REAUTH_REQUIRED', metadata)
    if (!this.auth.hasCredentials()) return this.statusFromMetadata('DISCONNECTED', metadata)
    return this.statusFromMetadata(this.hasInstallation === false ? 'INSTALLATION_REQUIRED' : 'CONNECTED', metadata)
  }

  async inspectPullRequestMergeability(repoPath: string, prNumber: number) {
    try {
      this.requireConfigured()
      if (!this.auth!.hasCredentials()) throw new GitHubIntegrationError('NOT_CONNECTED', githubErrorMessage('NOT_CONNECTED'))
      const remote = await this.git.getRemoteUrl(repoPath)
      const fullName = remote ? normalizeGitHubOrigin(remote) : null
      if (!fullName) throw new GitHubIntegrationError('REMOTE_CONFLICT', githubErrorMessage('REMOTE_CONFLICT'))
      const record = this.catalog.findByPath(repoPath)
      if (record?.github && record.github.fullName.toLowerCase() !== fullName.toLowerCase()) throw new GitHubIntegrationError('REMOTE_CONFLICT', githubErrorMessage('REMOTE_CONFLICT'))
      return await this.api!.inspectPullRequestMergeability(fullName, prNumber)
    } catch (error) {
      return { status: 'UNAVAILABLE' as const, source: 'GITHUB_REST' as const, prNumber,
        reason: toGitHubIntegrationError(error).code, observedAt: new Date().toISOString() }
    }
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
    this.connectionRevision++
    this.api?.clearPullRequestCache()
    this.pullRequestCatalog?.clear()
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
