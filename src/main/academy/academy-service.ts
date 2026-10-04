import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { AcademyCreateInput, AcademyPackage, AcademySnapshot, AcademyUpdateInput } from '../../shared/types/academy-types'
import { AcademyImporter } from './academy-importer'
import { AcademyProjectionService } from './academy-projection-service'
import { AcademyStore } from './academy-store'
import { AcademyWatcher } from './academy-watcher'
import { hashAcademyPackage } from './academy-package'
import { readSkillDirectory, removeSkillDirectory } from './academy-filesystem'
import { AcademyDistributionService } from './distribution/academy-distribution-service'
import { OpenAiPluginPublicationService } from './publication/openai-plugin-publication-service'
import { AcademyPluginPackageRevisionService } from './publication/academy-plugin-package-revision-service'
import type { AcademyGitSyncService } from './git/academy-git-sync-service'

export class AcademyService {
  readonly store: AcademyStore
  readonly projections: AcademyProjectionService
  readonly importer: AcademyImporter
  readonly watcher: AcademyWatcher
  readonly distribution: AcademyDistributionService
  readonly packageRevisions: AcademyPluginPackageRevisionService
  readonly openAiPublication: OpenAiPluginPublicationService
  gitSync: AcademyGitSyncService | null = null
  private readonly canonicalChangeListeners: Set<() => void> = new Set()

  constructor(databasePath: string, downloadsPath?: string) {
    this.store = new AcademyStore(databasePath)
    this.projections = new AcademyProjectionService(this.store)
    this.distribution = new AcademyDistributionService(this.store)
    this.packageRevisions = new AcademyPluginPackageRevisionService(this.store)
    this.openAiPublication = new OpenAiPluginPublicationService(this.store, this.packageRevisions, databasePath, downloadsPath)
    this.importer = new AcademyImporter(this.store)
    this.watcher = new AcademyWatcher(this.store, this.projections, 250, async () => {
      await this.distribution.reconcileAll()
      this.openAiPublication.refreshDrift()
      this.emitCanonicalChange()
    })
  }

  initializeGitSync(gitSync: AcademyGitSyncService): void {
    this.gitSync = gitSync
    this.onCanonicalChange(() => gitSync.notifyCanonicalChange())
  }

  onCanonicalChange(listener: () => void): () => void {
    this.canonicalChangeListeners.add(listener)
    return () => this.canonicalChangeListeners.delete(listener)
  }

  emitCanonicalChange(): void {
    for (const listener of this.canonicalChangeListeners) {
      try { listener() } catch (err) { console.error('[Academy] Canonical listener error:', err) }
    }
  }

  isGitPublicationPath(path: string): boolean {
    const gitRepoPath = this.gitSync?.getStatus().repository?.checkoutPath
    if (!gitRepoPath) return false
    return resolve(path).toLowerCase() === resolve(gitRepoPath).toLowerCase()
  }

  async excludeDestination(checkoutPath: string): Promise<void> {
    const normalized = resolve(checkoutPath).toLowerCase()
    const destination = this.store.listDestinations().find((item) => resolve(item.path).toLowerCase() === normalized)
    if (destination) {
      await this.setDestinationEnabled(destination.id, false)
    }
    const skillsRoot = join(checkoutPath, '.skills')
    if (existsSync(skillsRoot)) await removeSkillDirectory(skillsRoot).catch(() => {})
    const claudeRoot = join(checkoutPath, '.claude', 'skills')
    if (existsSync(claudeRoot)) await removeSkillDirectory(claudeRoot).catch(() => {})
  }


  snapshot(): AcademySnapshot { return { skills: this.store.list(), destinations: this.store.listDestinations(), conflicts: this.store.listConflicts() } }
  list(status?: 'ACTIVE' | 'ARCHIVED') { return this.store.list(status) }
  get(id: string) { return this.store.get(id) }
  history(id: string) { return this.store.history(id) }
  async create(input: AcademyCreateInput) { const value = this.store.create(input); await this.reconcileAll(); return value }
  async update(input: AcademyUpdateInput) { const value = this.store.update(input); await this.reconcileAll(); return value }
  async archive(id: string, expectedVersion: number) { const value = this.store.archive(id, expectedVersion); await this.reconcileAll(); return value }
  async restore(id: string, expectedVersion: number) { const value = this.store.restore(id, expectedVersion); await this.reconcileAll(); return value }
  async registerDestination(path: string, name: string, enabled = true) {
    const isGitRepo = this.isGitPublicationPath(path)
    const effectiveEnabled = isGitRepo ? false : enabled
    const value = this.store.upsertDestination(path, name, effectiveEnabled)
    await this.projections.reconcileDestination(value.id)
    await this.distribution.reconcileDestination(value.id)
    this.watcher.start()
    return value
  }
  async setDestinationEnabled(id: string, enabled: boolean) {
    const destination = this.store.listDestinations().find((d) => d.id === id)
    if (destination && this.isGitPublicationPath(destination.path) && enabled) {
      // publication repository must not be enabled as destination
      return destination
    }
    const value = this.store.setDestinationEnabled(id, enabled); await this.projections.reconcileDestination(id); await this.distribution.reconcileDestination(id); this.watcher.start(); return value
  }
  async import(skillsRoot: string, destinationId?: string) {
    const result = await this.importer.import(skillsRoot, 'GLOBAL', destinationId ? [destinationId] : [])
    await this.reconcileAll()
    const destination = destinationId ? this.store.listDestinations().find((item) => item.id === destinationId) : undefined
    if (destination && resolve(skillsRoot) === resolve(destination.path, '.skills')) {
      for (const item of result) {
        if (!item.name || !item.skillId || (item.result !== 'IMPORTED' && item.result !== 'UNCHANGED') || basename(item.directory) === item.name) continue
        const canonical = this.store.get(item.skillId)
        if (hashAcademyPackage(await readSkillDirectory(item.directory)) === canonical.current.packageHash) await removeSkillDirectory(item.directory)
      }
    }
    this.watcher.start(); return result
  }
  async resolveConflict(id: string, resolution: 'CANONICAL' | 'DIVERGENT', reconciledPackage?: AcademyPackage) {
    const conflict = this.store.listConflicts().find((item) => item.id === id)
    if (!conflict) throw new Error('CONFLICT_NOT_FOUND')
    if (resolution === 'DIVERGENT') {
      const pkg = reconciledPackage ?? conflict.divergentPackage
      if (!pkg) throw new Error('DIVERGENT_PACKAGE_REQUIRED')
      const current = this.store.get(conflict.skillId)
      this.store.update({ skillId: current.id, expectedVersion: current.currentVersion, package: pkg, origin: conflict.origin })
    }
    this.store.resolveConflict(id)
    await this.reconcileAll()
    return this.store.get(conflict.skillId)
  }
  async reconcileAll(): Promise<void> {
    await this.projections.reconcileAll()
    await this.distribution.reconcileAll()
    this.openAiPublication.refreshDrift()
    this.emitCanonicalChange()
  }
  async getDistributionHealth() { await this.distribution.verifyAll(); return this.distribution.health() }
  async listDistributionStates(skillId?: string) { await this.distribution.verifyAll(); return this.distribution.states(skillId) }
  async reconcileDistribution(destinationId?: string) {
    if (destinationId) { await this.projections.reconcileDestination(destinationId); await this.distribution.reconcileDestination(destinationId) }
    else await this.reconcileAll()
    return { health: this.distribution.health(), states: this.distribution.states() }
  }
  async bootstrapOpenAiPlugin(pluginRoot?: string, publishedVersion?: string) {
    return pluginRoot
      ? this.openAiPublication.bootstrapFromPluginDirectory(pluginRoot, publishedVersion)
      : this.openAiPublication.bootstrapInstalledPlugin(publishedVersion)
  }
  initializePluginPackage() {
    this.packageRevisions.bootstrapBaseline()
    const profile = this.store.getOpenAiPluginProfile()
    if (!profile) throw new Error('OPENAI_PLUGIN_PROFILE_MISSING')
    if (profile.openAiInterface.shortDescription !== 'Academy procedural skills') {
      this.store.setOpenAiInterface({ ...profile.openAiInterface, shortDescription: 'Academy procedural skills' })
    }
    return this.packageRevisions.resolveCurrent()
  }
  recordMarketplaceProbeUnsupported(): void {
    this.store.saveMarketplaceTakeoverState({
      takeoverStatus: 'TAKEOVER_UNSUPPORTED',
      observedPluginId: 'academy-skills@academy-marketplace-probe',
      evidence: 'Codex accepted the private Git marketplace but exposed academy-skills@academy-marketplace-probe as a distinct source identity; the USER plugin remained plugins_6ab584e0ea48819196b6069fe594f7b8 at 0.1.4.'
    })
  }
  getPackageDistributionState() {
    const publication = this.openAiPublication.state()
    return {
      packageRevision: publication.currentPackageRevision,
      skillCount: publication.publicSkillCount,
      git: this.gitSync?.getStatus() ?? {
        profile: null, repository: null, syncState: 'UNCONFIGURED' as const,
        lastSyncAt: null, lastCommitSha: null, lastError: null
      },
      marketplace: this.store.getMarketplaceState(),
      hosted: {
        status: publication.hostedStatus,
        label: 'Hosted Personal' as const,
        version: publication.profile?.publishedVersion ?? null
      }
    }
  }
  getOpenAiPublicationState() { return this.openAiPublication.state() }
  listOpenAiReleases() { return this.openAiPublication.listReleases() }
  getOpenAiRelease(id: string) { return this.openAiPublication.getRelease(id) }
  prepareOpenAiRelease() { this.initializePluginPackage(); return this.openAiPublication.prepareRelease() }
  confirmOpenAiUpload(releaseId: string, artifactHash: string) { return this.openAiPublication.confirmUpload(releaseId, artifactHash) }
  start(): void { this.watcher.start() }
  close(): void { this.watcher.stop(); this.store.close() }
}

export function academyDatabasePath(userData: string): string { return join(userData, 'academy', 'academy.db') }
