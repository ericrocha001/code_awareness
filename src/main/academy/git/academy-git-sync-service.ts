import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AcademyGitProfile,
  AcademyGitStatusProjection,
  AcademyGitSyncState
} from '../../../shared/types/academy-types'
import type { RepositoryRecord } from '../../../shared/types/repository-catalog-types'
import type { GitService } from '../../core/git-service'
import type { AcademyStore } from '../academy-store'
import {
  AcademyGitMaterializer,
  computeGitSnapshotHash,
  validateGitSnapshot
} from './academy-git-materializer'
import type { AcademyGitSnapshotEntry } from './academy-git-materializer'
import type { AcademyPluginRepositoryProjection } from './academy-plugin-repository-projection'
import { AcademyMarketplaceProjection } from './academy-marketplace-projection'
import { AcademyPluginPackageRevisionService } from '../publication/academy-plugin-package-revision-service'
import { canonicalJson, sha256 } from '../publication/openai-plugin-model'

import type { GitRemoteTransport } from '../../core/git-remote-transport'
export type { GitRemoteTransport } from '../../core/git-remote-transport'

export interface AcademyGitRepositoryPort {
  resolveRepository(id: string): RepositoryRecord | null
  findByGitHubId(githubRepositoryId: string): RepositoryRecord | null
  listEligibleRepositories(): RepositoryRecord[]
}

export interface AcademyDestinationExcluder {
  excludeDestination(checkoutPath: string): Promise<void>
}

export class AcademyGitSyncService {
  private activeSyncPromise: Promise<AcademyGitStatusProjection> | null = null
  private pendingNextSync = false
  private debounceTimer: NodeJS.Timeout | null = null
  private readonly debounceMs: number
  private readonly packageRevisions: AcademyPluginPackageRevisionService
  private readonly marketplaceProjection: AcademyMarketplaceProjection

  constructor(
    private readonly store: AcademyStore,
    private readonly materializer: AcademyGitMaterializer,
    private readonly git: GitService,
    private readonly transport: GitRemoteTransport,
    private readonly repositories: AcademyGitRepositoryPort,
    private readonly excluder?: AcademyDestinationExcluder,
    private readonly pluginProjection?: AcademyPluginRepositoryProjection,
    options?: {
      debounceMs?: number
      packageRevisions?: AcademyPluginPackageRevisionService
      marketplaceProjection?: AcademyMarketplaceProjection
    }
  ) {
    this.debounceMs = options?.debounceMs ?? 500
    this.packageRevisions = options?.packageRevisions ?? new AcademyPluginPackageRevisionService(store)
    this.marketplaceProjection = options?.marketplaceProjection ?? new AcademyMarketplaceProjection()
  }

  getStatus(): AcademyGitStatusProjection {
    const profile = this.store.getGitProfile()
    if (!profile) {
      return {
        profile: null,
        repository: null,
        syncState: 'UNCONFIGURED',
        lastSyncAt: null,
        lastCommitSha: null,
        lastError: null
      }
    }

    const record = this.repositories.resolveRepository(profile.repositoryCatalogId)
    return {
      profile,
      repository: record && record.localCheckout ? {
        id: record.id,
        name: record.name,
        fullName: record.github?.fullName ?? record.name,
        visibility: record.github?.visibility ?? 'PUBLIC',
        checkoutPath: record.localCheckout.path,
        branch: profile.branch
      } : null,
      syncState: profile.syncState,
      lastSyncAt: profile.lastSnapshotHash ? profile.updatedAt : null,
      lastCommitSha: profile.lastCommitSha,
      lastError: profile.lastError
    }
  }

  listEligibleRepositories(): RepositoryRecord[] {
    return this.repositories.listEligibleRepositories()
  }

  async bindRepository(catalogRepositoryId: string): Promise<AcademyGitStatusProjection> {
    const record = this.repositories.resolveRepository(catalogRepositoryId)
    if (!record || !record.github || !record.localCheckout || record.localCheckout.availability !== 'AVAILABLE' || record.localCheckout.gitState !== 'GIT') {
      throw new Error('REPOSITORY_NOT_ELIGIBLE: Repository must have GitHub link, available local checkout, and Git initialized')
    }

    const branch = (await this.git.getCurrentBranch(record.localCheckout.path)) || 'main'

    this.store.saveGitProfile({
      repositoryCatalogId: record.id,
      githubRepositoryId: record.github.repositoryId,
      branch,
      lastSnapshotHash: null,
      lastCommitSha: null,
      lastPushedCommitSha: null,
      syncState: 'DIRTY',
      lastError: null
    })

    if (this.excluder) {
      await this.excluder.excludeDestination(record.localCheckout.path)
    }

    // Clean up any historical .skills or .claude/skills in this repo checkout
    const skillsPath = join(record.localCheckout.path, '.skills')
    if (existsSync(skillsPath)) {
      await rm(skillsPath, { recursive: true, force: true }).catch(() => {})
    }
    const claudeSkillsPath = join(record.localCheckout.path, '.claude', 'skills')
    if (existsSync(claudeSkillsPath)) {
      await rm(claudeSkillsPath, { recursive: true, force: true }).catch(() => {})
    }

    return await this.syncNow()
  }

  notifyCanonicalChange(): void {
    const profile = this.store.getGitProfile()
    if (!profile || profile.syncState === 'UNCONFIGURED') return

    if (profile.syncState !== 'LOCAL_DRIFT' && profile.syncState !== 'REMOTE_DIVERGED') {
      this.store.updateGitSyncState({ syncState: 'DIRTY' })
    }

    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.sync()
    }, this.debounceMs)
  }

  async syncNow(): Promise<AcademyGitStatusProjection> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    return this.sync()
  }

  async sync(): Promise<AcademyGitStatusProjection> {
    if (this.activeSyncPromise) {
      this.pendingNextSync = true
      return this.activeSyncPromise
    }

    this.activeSyncPromise = this.executeSync()
    try {
      return await this.activeSyncPromise
    } finally {
      this.activeSyncPromise = null
      if (this.pendingNextSync) {
        this.pendingNextSync = false
        void this.sync()
      }
    }
  }

  async recoverOnStartup(): Promise<void> {
    const profile = this.store.getGitProfile()
    if (!profile || profile.syncState === 'UNCONFIGURED') return

    try {
      const record = this.repositories.resolveRepository(profile.repositoryCatalogId)
      if (!record || !record.localCheckout || record.localCheckout.availability !== 'AVAILABLE') return

      if (profile.syncState === 'PUSH_PENDING' || profile.syncState === 'DIRTY') {
        await this.sync()
        return
      }

      const activeGlobal = this.store.list('ACTIVE').filter((s) => s.scope === 'GLOBAL')
      let currentHash = computeGitSnapshotHash(activeGlobal.map((s) => {
        const d = this.store.get(s.id)
        return { skillId: d.id, name: d.name, version: d.currentVersion, packageHash: d.current.packageHash }
      }))
      const openAiProfile = this.pluginProjection ? this.store.getOpenAiPluginProfile() : null
      const recordForHash = this.repositories.resolveRepository(profile.repositoryCatalogId)
      if (openAiProfile && recordForHash) {
        const revision = this.packageRevisions.resolveCurrent()
        const marketplaceHash = this.marketplaceProjection.fingerprint(recordForHash, profile, openAiProfile, this.store.getMarketplaceState())
        currentHash = sha256(canonicalJson({ package: revision.contentFingerprint, marketplace: marketplaceHash }))
      }

      if (currentHash !== profile.lastSnapshotHash) {
        this.store.updateGitSyncState({ syncState: 'DIRTY' })
        await this.sync()
      }
    } catch (error) {
      console.warn('[AcademyGitSync] Startup recovery encountered a transient issue:', error)
    }
  }

  private async executeSync(): Promise<AcademyGitStatusProjection> {
    const profile = this.store.getGitProfile()
    if (!profile || profile.syncState === 'UNCONFIGURED') return this.getStatus()

    const record = this.repositories.resolveRepository(profile.repositoryCatalogId)
    if (!record || !record.localCheckout || record.localCheckout.availability !== 'AVAILABLE' || record.localCheckout.gitState !== 'GIT') {
      this.store.updateGitSyncState({
        syncState: 'ERROR',
        lastError: 'Local checkout is unavailable or not a valid Git repository.'
      })
      return this.getStatus()
    }

    const repoPath = record.localCheckout.path

    // Step 1: Detect LOCAL_DRIFT before materialization
    const openAiProfile = this.pluginProjection ? this.store.getOpenAiPluginProfile() : null
    const managedPaths = this.pluginProjection && openAiProfile
      ? ['skills', 'plugin.json', 'assets/logo.png', '.agents/plugins/marketplace.json']
      : ['skills']

    for (const path of managedPaths) {
      const hasUncommitted = await this.git.hasWorkingTreeChanges(repoPath, path)
      if (hasUncommitted) {
        this.store.updateGitSyncState({
          syncState: 'LOCAL_DRIFT',
          lastError: `Local uncommitted drift detected inside managed path: ${path}`
        })
        return this.getStatus()
      }
    }

    if (profile.lastCommitSha) {
      const headSha = await this.git.getCurrentCommitHash(repoPath)
      if (headSha && headSha !== profile.lastCommitSha) {
        this.store.updateGitSyncState({
          syncState: 'LOCAL_DRIFT',
          lastError: 'Local commit drift detected: HEAD differs from last published Academy commit.'
        })
        return this.getStatus()
      }
    }

    // Step 2: Snapshot GLOBAL + ACTIVE
    const activeGlobal = this.store.list('ACTIVE')
      .filter((s) => s.scope === 'GLOBAL')
      .sort((a, b) => a.name.localeCompare(b.name))

    const snapshotEntries: AcademyGitSnapshotEntry[] = activeGlobal.map((s) => {
      const detail = this.store.get(s.id)
      return {
        skillId: detail.id,
        name: detail.name,
        version: detail.currentVersion,
        packageHash: detail.current.packageHash,
        package: detail.current.package
      }
    })

    let snapshotHash = computeGitSnapshotHash(snapshotEntries)
    let packageRevision = null
    if (openAiProfile) {
      try {
        packageRevision = this.packageRevisions.resolveCurrent()
        const marketplaceHash = this.marketplaceProjection.fingerprint(record, profile, openAiProfile, this.store.getMarketplaceState())
        snapshotHash = sha256(canonicalJson({ package: packageRevision.contentFingerprint, marketplace: marketplaceHash }))
      } catch (error) {
        this.store.updateGitSyncState({
          syncState: 'ERROR',
          lastError: `Plugin validation failed: ${error instanceof Error ? error.message : String(error)}`
        })
        return this.getStatus()
      }
    }

    // Step 3: Check if already committed and push was pending
    const pluginMissing = Boolean(
      this.pluginProjection && openAiProfile &&
      (!existsSync(join(repoPath, 'plugin.json')) ||
        (openAiProfile.logoPath && !existsSync(join(repoPath, 'assets', 'logo.png'))) ||
        !existsSync(join(repoPath, '.agents', 'plugins', 'marketplace.json')))
    )

    if (!pluginMissing && profile.lastSnapshotHash === snapshotHash && profile.lastCommitSha) {
      if (profile.lastPushedCommitSha === profile.lastCommitSha) {
        this.store.updateGitSyncState({ syncState: 'SYNCED', lastError: null })
        return this.getStatus()
      }

      // Offline push retry
      try {
        await this.transport.push(repoPath, profile.branch)
        this.store.updateGitSyncState({
          syncState: 'SYNCED',
          lastPushedCommitSha: profile.lastCommitSha,
          lastError: null
        })
      } catch (error: any) {
        const isDiverged = this.isDivergedError(error)
        this.store.updateGitSyncState({
          syncState: isDiverged ? 'REMOTE_DIVERGED' : 'PUSH_PENDING',
          lastError: error instanceof Error ? error.message : String(error)
        })
      }
      return this.getStatus()
    }

    // Step 4: Safety Gate (Public repository gate)
    try {
      validateGitSnapshot(snapshotEntries, { isPublic: record.github?.visibility === 'PUBLIC' })
    } catch (error) {
      this.store.updateGitSyncState({
        syncState: 'ERROR',
        lastError: error instanceof Error ? error.message : String(error)
      })
      return this.getStatus()
    }

    this.store.updateGitSyncState({ syncState: 'SYNCING', lastError: null })

    // Step 5: Materialize strictly under skills/
    await this.materializer.materialize(repoPath, snapshotEntries)

    // Step 5b: Project plugin.json + assets/logo.png when plugin profile is available
    let pluginVersion: string | undefined
    if (this.pluginProjection) {
      if (openAiProfile) {
        const openAiSnapshot = snapshotEntries.map((e) => ({
          skillId: e.skillId,
          name: e.name,
          academyVersion: e.version,
          packageHash: e.packageHash
        }))
        try {
          packageRevision = packageRevision ?? this.packageRevisions.resolveCurrent()
          const result = await this.pluginProjection.project(repoPath, openAiProfile, openAiSnapshot, packageRevision)
          pluginVersion = result.version
          await this.marketplaceProjection.project(repoPath, record, profile, openAiProfile, this.store.getMarketplaceState())
          await this.pluginProjection.validate(repoPath, openAiProfile, openAiSnapshot)
        } catch (error) {
          this.store.updateGitSyncState({
            syncState: 'ERROR',
            lastError: `Plugin validation failed: ${error instanceof Error ? error.message : String(error)}`
          })
          return this.getStatus()
        }
      }
    }

    // Step 6: Verify working tree changes across all managed paths
    let hasChanges = false
    for (const path of managedPaths) {
      if (await this.git.hasWorkingTreeChanges(repoPath, path)) { hasChanges = true; break }
    }

    if (!hasChanges) {
      this.store.updateGitSyncState({
        syncState: 'SYNCED',
        lastSnapshotHash: snapshotHash,
        lastError: null
      })
      return this.getStatus()
    }

    // Step 7: Stage only managed paths
    await this.git.stagePaths(repoPath, managedPaths)

    // Step 8: Commit
    const versionLabel = pluginVersion ? ` v${pluginVersion}` : ''
    const commitMessage = `Academy sync${versionLabel}: ${snapshotEntries.length} skills (${snapshotHash.slice(0, 8)})`
    const commitSha = await this.git.commit(repoPath, commitMessage)
    if (!commitSha) {
      this.store.updateGitSyncState({
        syncState: 'SYNCED',
        lastSnapshotHash: snapshotHash,
        lastError: null
      })
      return this.getStatus()
    }

    this.store.updateGitSyncState({
      syncState: 'PUSH_PENDING',
      lastCommitSha: commitSha,
      lastSnapshotHash: snapshotHash,
      lastError: null
    })

    // Step 9: Authenticated push
    try {
      await this.transport.push(repoPath, profile.branch)
      this.store.updateGitSyncState({
        syncState: 'SYNCED',
        lastPushedCommitSha: commitSha,
        lastError: null
      })
    } catch (error: any) {
      const isDiverged = this.isDivergedError(error)
      this.store.updateGitSyncState({
        syncState: isDiverged ? 'REMOTE_DIVERGED' : 'PUSH_PENDING',
        lastError: error instanceof Error ? error.message : String(error)
      })
    }

    return this.getStatus()
  }

  private isDivergedError(error: unknown): boolean {
    const msg = String(error instanceof Error ? error.message : error).toLowerCase()
    return (
      msg.includes('non-fast-forward') ||
      msg.includes('fetch first') ||
      msg.includes('[rejected]') ||
      msg.includes('behind') ||
      msg.includes('remote contains work that you do not have locally')
    )
  }
}
