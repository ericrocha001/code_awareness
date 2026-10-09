import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createTwoFilesPatch } from 'diff'
import { basename, join, resolve } from 'node:path'
import type { AcademyConflictBatch, AcademyConflictReview, AcademyCreateInput, AcademyPackage, AcademySnapshot, AcademyUpdateInput, AcademySkillDetail, AcademyMutationReceipt } from '../../shared/types/academy-types'
import { AcademyImporter } from './academy-importer'
import { AcademyProjectionService } from './academy-projection-service'
import { AcademyStore } from './academy-store'
import { AcademyWatcher } from './academy-watcher'
import { hashAcademyPackage, normalizeAcademyPackage, parseSkillMetadata } from './academy-package'
import { observeStableSkillDirectory, readSkillDirectory, removeSkillDirectory, replaceSkillDirectory } from './academy-filesystem'
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
  private readonly conflictReviews = new Map<string, AcademyConflictReview>()
  private readonly conflictReviewContexts = new Map<string, string>()
  private readonly conflictBatches = new Map<string, AcademyConflictBatch>()
  private readonly batchReviewTokens = new Map<string, Map<string, string>>()

  constructor(databasePath: string, downloadsPath?: string) {
    this.store = new AcademyStore(databasePath)
    this.projections = new AcademyProjectionService(this.store)
    this.distribution = new AcademyDistributionService(this.store)
    this.packageRevisions = new AcademyPluginPackageRevisionService(this.store)
    this.openAiPublication = new OpenAiPluginPublicationService(this.store, this.packageRevisions, databasePath, downloadsPath)
    this.importer = new AcademyImporter(this.store)
    this.watcher = new AcademyWatcher(this.store, this.projections)
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


  snapshot(): AcademySnapshot { return { skills: this.store.list(), destinations: this.store.listDestinations(), conflicts: this.store.conflictSummaries() } }
  list(status?: 'ACTIVE' | 'ARCHIVED') { return this.store.list(status) }
  get(id: string) { return this.store.get(id) }
  history(id: string) { return this.store.history(id) }
  async create(input: AcademyCreateInput): Promise<AcademySkillDetail>
  async create(input: AcademyCreateInput, mode: 'RECEIPT'): Promise<AcademyMutationReceipt>
  async create(input: AcademyCreateInput, mode?: 'RECEIPT') {
    const value = this.store.create(input)
    if (mode === 'RECEIPT') return this.reconcileReceipt(value)
    await this.reconcileAll(); return value
  }
  async update(input: AcademyUpdateInput): Promise<AcademySkillDetail>
  async update(input: AcademyUpdateInput, mode: 'RECEIPT'): Promise<AcademyMutationReceipt>
  async update(input: AcademyUpdateInput, mode?: 'RECEIPT') {
    const value = this.store.update(input)
    if (mode === 'RECEIPT') return this.reconcileReceipt(value)
    await this.reconcileAll(); return value
  }
  private async reconcileReceipt(value: AcademySkillDetail): Promise<AcademyMutationReceipt> {
    const receipt: AcademyMutationReceipt = { state: 'PERSISTED', skillId: value.id, name: value.name, version: value.currentVersion, packageHash: value.current.packageHash, scope: value.scope, projectIds: value.projectIds, distribution: { status: 'NOT_APPLICABLE' } }
    try {
      await this.reconcileAll()
      const destinations = this.store.listDestinations().filter(destination => destination.enabled && this.store.isAssigned(value.id, destination.id))
      const states = this.distribution.states(value.id).filter(state => destinations.some(destination => destination.id === state.destinationId))
      receipt.distribution.status = destinations.length === 0 ? 'NOT_APPLICABLE' : states.length === destinations.length * 2 && states.every(state => state.status === 'CURRENT' && state.canonicalVersion === value.currentVersion && state.distributedHash === value.current.packageHash) ? 'CONVERGED' : 'DEGRADED'
    } catch {
      receipt.distribution = { status: 'ERROR', errorCode: 'RECONCILIATION_FAILED' }
      this.emitCanonicalChange()
    }
    return receipt
  }
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
  async reviewConflict(id: string, reconciledPackage?: AcademyPackage): Promise<AcademyConflictReview> {
    const conflict = this.store.getConflict(id)
    if (conflict.status !== 'OPEN') throw new Error('CONFLICT_NOT_FOUND')
    const current = this.store.get(conflict.skillId)
    const destination = this.store.listDestinations().find((item) => item.id === conflict.projectId)
    const paths = new Set(this.store.history(current.id).map((version) => join(destination?.path ?? '', '.skills', this.skillName(version.package))))
    if (conflict.projectionPath && (!destination || !paths.has(conflict.projectionPath))) throw new Error('CONFLICT_PATH_INVALID')
    const disk = conflict.projectionPath ? await observeStableSkillDirectory(conflict.projectionPath) : null
    if (conflict.projectionPath && !disk) throw new Error('FILESYSTEM_UNSTABLE')
    const history = this.store.history(current.id)
    const knownEvidence = conflict.divergentPackage
      ? hashAcademyPackage(conflict.divergentPackage) === conflict.divergentHash && history.some((version) => version.packageHash === conflict.divergentHash)
      : conflict.divergentHash === 'DELETED' || conflict.divergentHash.includes('SKILL.md not found') || conflict.divergentHash.startsWith('INVALID:SKILL_MD_MISSING')
    const shouldExist = destination?.enabled && current.status === 'ACTIVE' && this.store.isAssigned(current.id, destination.id) && conflict.projectionPath === join(destination.path, '.skills', current.name)
    const diskKnown = disk?.hash === current.current.packageHash || Boolean(disk?.package && history.some((version) => version.packageHash === disk.hash))
    const safeCanonical = conflict.origin === 'FILESYSTEM' && Boolean(destination) && knownEvidence && (Boolean(shouldExist) && diskKnown || disk?.hash === 'DELETED' && !shouldExist)
    const divergent = reconciledPackage ? normalizeAcademyPackage(reconciledPackage) : conflict.divergentPackage
    const candidateHash = divergent ? hashAcademyPackage(divergent) : null
    const files = new Set(['SKILL.md', ...Object.keys(current.current.package.artifacts), ...Object.keys(divergent?.artifacts ?? {})])
    let diff = divergent ? [...files].map((file) => createTwoFilesPatch(`canonical/${file}`, `divergent/${file}`, file === 'SKILL.md' ? current.current.package.skillMd : current.current.package.artifacts[file] ?? '', file === 'SKILL.md' ? divergent.skillMd : divergent.artifacts[file] ?? '')).join('\n') : 'Nenhum pacote divergente válido. A ação mantém a versão canônica e restaura a projeção aplicável.'
    if (disk?.package && disk.hash !== conflict.divergentHash && disk.hash !== current.current.packageHash) {
      const local = disk.package
      const localFiles = new Set(['SKILL.md', ...Object.keys(current.current.package.artifacts), ...Object.keys(local.artifacts)])
      diff += '\n\nConteúdo atual do destino (diferente da ocorrência registrada):\n' + [...localFiles].map((file) => createTwoFilesPatch(`canonical/${file}`, `filesystem/${file}`, file === 'SKILL.md' ? current.current.package.skillMd : current.current.package.artifacts[file] ?? '', file === 'SKILL.md' ? local.skillMd : local.artifacts[file] ?? '')).join('\n')
    }
    const diskHash = disk?.hash ?? 'NO_PATH'
    const context = createHash('sha256').update(JSON.stringify([conflict, candidateHash, current.currentVersion, current.current.packageHash, current.status, destination && { id: destination.id, path: destination.path, enabled: destination.enabled }, current.projectIds])).digest('hex')
    const token = createHash('sha256').update(JSON.stringify([context, diskHash])).digest('hex')
    const summary = this.store.conflictSummaries().find((item) => item.id === id)!
    const value = { conflict, candidateHash, historicalVersion: summary.historicalVersion, cause: summary.cause, currentVersion: current.currentVersion, canonicalHash: current.current.packageHash, diskHash, diff, token, safeCanonical,
      reason: safeCanonical ? 'Evidência histórica/equivalente e destino compatível.' : 'Requer inspeção individual; ausência atual ou conteúdo não classificado.' }
    if (this.conflictReviews.size > 500) { this.conflictReviews.clear(); this.conflictReviewContexts.clear() }
    this.conflictReviews.set(token, value)
    this.conflictReviewContexts.set(token, context)
    return value
  }

  private skillName(pkg: AcademyPackage): string {
    return parseSkillMetadata(pkg.skillMd).name
  }

  async previewConflictBatch(): Promise<AcademyConflictBatch> {
    const entries: AcademyConflictBatch['entries'] = []
    const tokens: string[] = []
    const summaries = this.store.conflictSummaries()
    for (const summary of summaries) {
      let review: AcademyConflictReview
      try { review = await this.reviewConflict(summary.id) } catch (error: any) {
        if (['CONFLICT_PATH_INVALID', 'FILESYSTEM_UNSTABLE'].includes(error.message)) continue
        throw error
      }
      if (review.safeCanonical) {
        entries.push({ id: summary.id, skillName: summary.skillName, destination: summary.projectionPath, reason: review.reason, occurrences: summary.occurrenceCount })
        tokens.push(review.token)
      }
    }
    const token = createHash('sha256').update(JSON.stringify([entries, tokens])).digest('hex')
    const batch = { token, entries, excluded: summaries.length - entries.length }
    this.conflictBatches.clear(); this.conflictBatches.set(token, batch)
    this.batchReviewTokens.clear(); this.batchReviewTokens.set(token, new Map(entries.map((entry, index) => [entry.id, tokens[index]])))
    return batch
  }

  async resolveConflictBatch(token: string, confirmed: boolean): Promise<{ resolved: number; remaining: number }> {
    const batch = this.conflictBatches.get(token)
    if (!confirmed || !batch) throw new Error('CONFIRMED_BATCH_PREVIEW_REQUIRED')
    const next = await this.previewConflictBatch()
    if (next.token !== token) throw new Error('CONFLICT_STATE_CHANGED')
    const approvedTokens = this.batchReviewTokens.get(token)!
    const approvedContexts = new Map([...approvedTokens].map(([id, reviewToken]) => [id, this.conflictReviewContexts.get(reviewToken)]))
    let resolved = 0
    for (const entry of batch.entries) {
      const review = await this.reviewConflict(entry.id)
      const alreadyCanonical = review.diskHash === review.canonicalHash && this.conflictReviewContexts.get(review.token) === approvedContexts.get(entry.id)
      if (!review.safeCanonical || review.token !== approvedTokens.get(entry.id) && !alreadyCanonical) throw new Error('CONFLICT_STATE_CHANGED')
      await this.resolveConflictMutation(entry.id, 'CANONICAL', undefined, { token: review.token, confirmed: true })
      resolved += entry.occurrences
    }
    await this.reconcileAll()
    return { resolved, remaining: this.store.conflictSummaries().length }
  }

  async resolveConflict(id: string, resolution: 'CANONICAL' | 'DIVERGENT', reconciledPackage?: AcademyPackage, approval?: { token: string; confirmed: boolean }) {
    const skillId = await this.resolveConflictMutation(id, resolution, reconciledPackage, approval)
    await this.reconcileAll()
    return this.store.get(skillId)
  }

  private async resolveConflictMutation(id: string, resolution: 'CANONICAL' | 'DIVERGENT', reconciledPackage?: AcademyPackage, approval?: { token: string; confirmed: boolean }) {
    if (!approval?.confirmed || !this.conflictReviews.has(approval.token)) throw new Error('CONFIRMED_CONFLICT_REVIEW_REQUIRED')
    const reviewed = this.conflictReviews.get(approval.token)!
    if (reviewed.conflict.id !== id) throw new Error('CONFLICT_STATE_CHANGED')
    const resolveConflict = async () => {
      const review = await this.reviewConflict(id, reconciledPackage)
      if (review.token !== approval.token) throw new Error('CONFLICT_STATE_CHANGED')
      const conflict = review.conflict
      const current = this.store.get(conflict.skillId)
      const destination = this.store.listDestinations().find((item) => item.id === conflict.projectId)
      const shouldExist = destination?.enabled && current.status === 'ACTIVE' && this.store.isAssigned(current.id, destination.id) && conflict.projectionPath === join(destination.path, '.skills', current.name)
      const pkg = resolution === 'DIVERGENT' ? reconciledPackage ?? conflict.divergentPackage : current.current.package
      if (!pkg) throw new Error('DIVERGENT_PACKAGE_REQUIRED')
      if (resolution === 'DIVERGENT' && conflict.projectionPath && review.diskHash !== conflict.divergentHash && review.diskHash !== current.current.packageHash) throw new Error('DIVERGENCE_CHANGED')
      if (resolution === 'DIVERGENT' && hashAcademyPackage(pkg) !== review.candidateHash) throw new Error('RECONCILED_PACKAGE_REVIEW_REQUIRED')
      if (conflict.projectionPath) {
        if (shouldExist) {
          if (review.diskHash !== hashAcademyPackage(pkg)) await replaceSkillDirectory(conflict.projectionPath, pkg, review.diskHash)
          this.store.setProjection(current.id, destination!.id, current.currentVersion, hashAcademyPackage(pkg), current.name)
        } else if (review.diskHash !== 'DELETED') throw new Error('INACTIVE_PROJECTION_REQUIRES_REVIEW')
      }
      if (this.store.get(current.id).currentVersion !== review.currentVersion) throw new Error('CONFLICT_STATE_CHANGED')
      if (resolution === 'DIVERGENT') this.store.update({ skillId: current.id, expectedVersion: review.currentVersion, package: pkg, origin: conflict.origin })
      this.store.resolveConflict(id)
      this.conflictReviews.delete(approval.token)
      this.conflictReviewContexts.delete(approval.token)
    }
    if (reviewed.conflict.projectId) await this.projections.exclusive(reviewed.conflict.projectId, resolveConflict)
    else await resolveConflict()
    return reviewed.conflict.skillId
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
