import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createTwoFilesPatch } from 'diff'
import { basename, join, resolve } from 'node:path'
import type { AcademyConflictBatch, AcademyConflictReview, AcademyCreateInput, AcademyPackage, AcademySnapshot, AcademyUpdateInput, AcademySkillDetail, AcademyMutationReceipt, AcademySkillDeliveryStatus, AcademySkillDeliveryDestinationStatus, AcademyDeliveryConvergence, AcademyDistributionTarget } from '../../shared/types/academy-types'
import { AcademyImporter } from './academy-importer'
import { AcademyProjectionService } from './academy-projection-service'
import { AcademyStore } from './academy-store'
import { AcademyWatcher } from './academy-watcher'
import { AcademyError, hashAcademyPackage, normalizeAcademyPackage, parseSkillMetadata } from './academy-package'
import { observeStableSkillDirectory, readSkillDirectory, removeSkillDirectory, replaceSkillDirectory } from './academy-filesystem'
import { AcademyDistributionService } from './distribution/academy-distribution-service'
import { OpenAiPluginPublicationService } from './publication/openai-plugin-publication-service'
import { AcademyPluginPackageRevisionService } from './publication/academy-plugin-package-revision-service'
import type { AcademyGitSyncService } from './git/academy-git-sync-service'
import { analyzeAcademyImpact, verifyAcademyImpact } from './academy-impact'
import type { AcademyHistoryOptions, AcademyHistoryResult, AcademySkillVersion, AcademySkillVersionMetadata } from '../../shared/types/academy-types'

const TARGETS: AcademyDistributionTarget[] = ['FILESYSTEM_NATIVE', 'CLAUDE_CODE', 'ANTIGRAVITY']

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
  private readonly distributionChangeListeners: Set<() => void> = new Set()
  private isClosed = false
  private readonly reconcilingDestinations = new Set<string>()
  private readonly dirtyDestinations = new Set<string>()
  private readonly destinationPassPromises = new Map<string, Promise<void>>()
  private readonly conflictReviews = new Map<string, AcademyConflictReview>()
  private readonly conflictReviewContexts = new Map<string, string>()
  private readonly conflictBatches = new Map<string, AcademyConflictBatch>()
  private readonly batchReviewTokens = new Map<string, Map<string, string>>()

  constructor(databasePath: string, downloadsPath?: string, private readonly closeTimeoutMs = 2000) {
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

  private assertNotClosed(): void {
    if (this.isClosed) throw new Error('ACADEMY_SERVICE_CLOSED')
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

  onDistributionChange(listener: () => void): () => void {
    this.distributionChangeListeners.add(listener)
    return () => this.distributionChangeListeners.delete(listener)
  }

  emitDistributionChange(): void {
    for (const listener of this.distributionChangeListeners) {
      try { listener() } catch (err) { console.error('[Academy] Distribution listener error:', err) }
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
  list(status?: 'ACTIVE' | 'DISABLED' | 'ARCHIVED') { return this.store.list(status === 'ARCHIVED' ? 'DISABLED' : status) }
  get(id: string) { return this.store.get(id) }
  history(id: string): AcademySkillVersion[]
  history(id: string, options: { metadataOnly: true }): AcademySkillVersionMetadata[]
  history(id: string, options: { version: number }): AcademySkillVersion
  history(id: string, options: AcademyHistoryOptions): AcademyHistoryResult
  history(id: string, options: AcademyHistoryOptions = {}): AcademyHistoryResult {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['metadataOnly', 'version'].includes(key))) throw new AcademyError('INVALID_ARGUMENT')
    const hasMetadata = Object.hasOwn(options, 'metadataOnly'), hasVersion = Object.hasOwn(options, 'version')
    if (hasMetadata && (hasVersion || typeof options.metadataOnly !== 'boolean')) throw new AcademyError('INVALID_ARGUMENT')
    if (hasVersion && (!Number.isSafeInteger(options.version) || Number(options.version) < 1)) throw new AcademyError('INVALID_ARGUMENT')
    return this.store.history(id, options)
  }
  analyzeChangeImpact(input: unknown) { this.assertNotClosed(); return analyzeAcademyImpact(this.store, input) }
  verifyChangeImpact(input: unknown) { return verifyAcademyImpact(this.store, input) }
  scheduleDestinationReconciliation(destinationId: string): Promise<void> {
    if (this.isClosed || this.store.isClosed) return Promise.resolve()
    if (this.reconcilingDestinations.has(destinationId)) {
      this.dirtyDestinations.add(destinationId)
      return this.destinationPassPromises.get(destinationId) ?? Promise.resolve()
    }
    this.reconcilingDestinations.add(destinationId)
    const promise = (async () => {
      try {
        while (!this.isClosed && !this.store.isClosed) {
          this.dirtyDestinations.delete(destinationId)
          try {
            await this.projections.reconcileDestination(destinationId)
            if (this.isClosed || this.store.isClosed) break
            await this.distribution.reconcileDestination(destinationId)
          } catch (error) {
            if (this.isClosed || this.store.isClosed) break
            console.error(`[Academy] Reconciliation error for destination ${destinationId}:`, error)
            try {
              if (!this.isClosed && !this.store.isClosed) {
                this.store.markDestination(destinationId, 'ERROR', error instanceof Error ? error.message : String(error))
              }
            } catch {}
          }
          if (!this.dirtyDestinations.has(destinationId) || this.isClosed || this.store.isClosed) {
            break
          }
        }
      } finally {
        this.reconcilingDestinations.delete(destinationId)
        this.destinationPassPromises.delete(destinationId)
        if (!this.isClosed && !this.store.isClosed) {
          try {
            this.openAiPublication.refreshDrift()
            this.emitDistributionChange()
          } catch {}
        }
      }
    })()
    this.destinationPassPromises.set(destinationId, promise)
    return promise
  }

  scheduleReconciliationForSkill(skillId: string): void {
    if (this.isClosed || this.store.isClosed) return
    const destinations = this.store.listDestinations().filter(d =>
      d.enabled && (
        this.store.isAssigned(skillId, d.id) ||
        this.store.getProjection(skillId, d.id) !== null ||
        this.store.listDistributionStates(skillId).some(s => s.destinationId === d.id)
      )
    )
    for (const destination of destinations) {
      this.scheduleDestinationReconciliation(destination.id)
    }
    if (!this.isClosed && !this.store.isClosed) {
      try {
        this.openAiPublication.refreshDrift()
      } catch {}
    }
  }

  async waitForReconciliation(): Promise<void> {
    while (this.destinationPassPromises.size > 0) {
      const promises = [...this.destinationPassPromises.values()]
      await Promise.allSettled(promises)
    }
  }

  private immediateReceipt(value: AcademySkillDetail): AcademyMutationReceipt {
    const destinations = this.store.listDestinations().filter(
      destination => destination.enabled && this.store.isAssigned(value.id, destination.id)
    )
    const distributionStatus = destinations.length === 0 ? 'NOT_APPLICABLE' : 'PENDING'
    return {
      state: 'PERSISTED',
      skillId: value.id,
      name: value.name,
      version: value.currentVersion,
      packageHash: value.current.packageHash,
      scope: value.scope,
      projectIds: value.projectIds,
      distribution: { status: distributionStatus }
    }
  }

  async create(input: AcademyCreateInput): Promise<AcademySkillDetail>
  async create(input: AcademyCreateInput, mode: 'RECEIPT'): Promise<AcademyMutationReceipt>
  async create(input: AcademyCreateInput, mode?: 'RECEIPT') {
    this.assertNotClosed()
    const value = this.store.create(input)
    this.emitCanonicalChange()
    this.scheduleReconciliationForSkill(value.id)
    if (mode === 'RECEIPT') return this.immediateReceipt(value)
    return value
  }

  async update(input: AcademyUpdateInput): Promise<AcademySkillDetail>
  async update(input: AcademyUpdateInput, mode: 'RECEIPT'): Promise<AcademyMutationReceipt>
  async update(input: AcademyUpdateInput, mode?: 'RECEIPT') {
    this.assertNotClosed()
    const value = this.store.update(input)
    this.emitCanonicalChange()
    this.scheduleReconciliationForSkill(value.id)
    if (mode === 'RECEIPT') return this.immediateReceipt(value)
    return value
  }

  async setEnabled(id: string, enabled: boolean, expectedStateRevision: number) {
    this.assertNotClosed()
    const value = this.store.setEnabled(id, enabled, expectedStateRevision)
    this.emitCanonicalChange()
    this.scheduleReconciliationForSkill(value.id)
    return value
  }

  async archive(id: string, expectedVersion: number) {
    this.assertNotClosed()
    const value = this.store.archive(id, expectedVersion)
    this.emitCanonicalChange()
    this.scheduleReconciliationForSkill(value.id)
    return value
  }

  async restore(id: string, expectedVersion: number) {
    this.assertNotClosed()
    const value = this.store.restore(id, expectedVersion)
    this.emitCanonicalChange()
    this.scheduleReconciliationForSkill(value.id)
    return value
  }
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
    this.assertNotClosed()
    for (const destination of this.store.listDestinations().filter((item) => item.enabled)) {
      this.scheduleDestinationReconciliation(destination.id)
    }
    await this.waitForReconciliation()
    this.openAiPublication.refreshDrift()
    this.emitCanonicalChange()
  }

  getDeliveryStatus(skillId: string, expectedVersion?: number): AcademySkillDeliveryStatus {
    this.assertNotClosed()
    const skill = this.store.get(skillId)
    if (!skill) {
      const error = new Error(`SKILL_NOT_FOUND: Skill ${skillId} not found`)
      ;(error as any).code = 'SKILL_NOT_FOUND'
      throw error
    }

    if (expectedVersion !== undefined) {
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || expectedVersion > skill.currentVersion) {
        const error = new Error(`VERSION_NOT_FOUND: Version ${expectedVersion} does not exist for skill ${skillId}`)
        ;(error as any).code = 'VERSION_NOT_FOUND'
        throw error
      }
    }

    const targetVersion = expectedVersion ?? skill.currentVersion
    const isSuperseded = targetVersion < skill.currentVersion
    let targetHash: string
    if (targetVersion === skill.currentVersion) {
      targetHash = skill.current.packageHash
    } else {
      const historical = this.store.history(skillId).find(v => v.version === targetVersion)
      if (!historical) {
        const error = new Error(`VERSION_NOT_FOUND: Version ${targetVersion} not found in history for skill ${skillId}`)
        ;(error as any).code = 'VERSION_NOT_FOUND'
        throw error
      }
      targetHash = historical.packageHash
    }

    const destinations = this.store.listDestinations().filter(d =>
      d.enabled && (
        this.store.isAssigned(skill.id, d.id) ||
        this.store.getProjection(skill.id, d.id) !== null ||
        this.store.listDistributionStates(skill.id).some(s => s.destinationId === d.id)
      )
    )

    if (destinations.length === 0) {
      return {
        skillId: skill.id,
        version: targetVersion,
        packageHash: targetHash,
        status: 'NOT_APPLICABLE',
        destinations: []
      }
    }

    const items: AcademySkillDeliveryDestinationStatus[] = []

    if (skill.status === 'DISABLED') {
      for (const destination of destinations) {
        const isReconciling = this.reconcilingDestinations.has(destination.id) || this.dirtyDestinations.has(destination.id)
        const hasProjection = this.store.getProjection(skill.id, destination.id) !== null
        const states = this.store.listDistributionStates(skill.id).filter(s => s.destinationId === destination.id)
        const hasError = destination.reconciliationStatus === 'ERROR' || states.some(s => s.status === 'ERROR')

        for (const target of TARGETS) {
          const state = states.find(s => s.target === target)
          if (hasError) {
            items.push({
              destinationId: destination.id,
              destinationName: destination.name,
              target,
              status: 'ERROR',
              canonicalVersion: targetVersion,
              distributedVersion: state?.distributedVersion ?? null,
              distributedHash: state?.distributedHash ?? null,
              errorCode: state?.errorCode ?? 'RECONCILIATION_FAILED',
              errorMessage: state?.errorMessage ?? destination.lastError ?? 'Reconciliation failed for destination',
              checkedAt: state?.checkedAt ?? new Date().toISOString()
            })
          } else if (isReconciling || hasProjection || state !== undefined) {
            items.push({
              destinationId: destination.id,
              destinationName: destination.name,
              target,
              status: 'PENDING',
              canonicalVersion: targetVersion,
              distributedVersion: state?.distributedVersion ?? null,
              distributedHash: state?.distributedHash ?? null,
              errorCode: null,
              errorMessage: null,
              checkedAt: state?.checkedAt ?? new Date().toISOString()
            })
          } else {
            items.push({
              destinationId: destination.id,
              destinationName: destination.name,
              target,
              status: 'CURRENT',
              canonicalVersion: targetVersion,
              distributedVersion: null,
              distributedHash: null,
              errorCode: null,
              errorMessage: null,
              checkedAt: new Date().toISOString()
            })
          }
        }
      }
    } else {
      const activeDestinations = destinations.filter(d => this.store.isAssigned(skill.id, d.id))
      if (activeDestinations.length === 0) {
        return {
          skillId: skill.id,
          version: targetVersion,
          packageHash: targetHash,
          status: 'NOT_APPLICABLE',
          destinations: []
        }
      }

      for (const destination of activeDestinations) {
        const isReconciling = this.reconcilingDestinations.has(destination.id) || this.dirtyDestinations.has(destination.id)
        const destError = destination.reconciliationStatus === 'ERROR' ? destination.lastError : null

        for (const target of TARGETS) {
          const state = this.store.getDistributionState(skill.id, destination.id, target)
          if (state?.status === 'ERROR') {
            items.push({
              destinationId: destination.id,
              destinationName: destination.name,
              target,
              status: 'ERROR',
              canonicalVersion: state.canonicalVersion,
              distributedVersion: state.distributedVersion,
              distributedHash: state.distributedHash,
              errorCode: state.errorCode,
              errorMessage: state.errorMessage,
              checkedAt: state.checkedAt
            })
          } else if (destError && (!state || state.canonicalVersion !== targetVersion || state.canonicalHash !== targetHash)) {
            items.push({
              destinationId: destination.id,
              destinationName: destination.name,
              target,
              status: 'ERROR',
              canonicalVersion: targetVersion,
              distributedVersion: state?.distributedVersion ?? null,
              distributedHash: state?.distributedHash ?? null,
              errorCode: 'RECONCILIATION_FAILED',
              errorMessage: destError,
              checkedAt: state?.checkedAt ?? new Date().toISOString()
            })
          } else if (!state || state.canonicalVersion !== targetVersion || state.canonicalHash !== targetHash || isReconciling) {
            items.push({
              destinationId: destination.id,
              destinationName: destination.name,
              target,
              status: 'PENDING',
              canonicalVersion: targetVersion,
              distributedVersion: state?.distributedVersion ?? null,
              distributedHash: state?.distributedHash ?? null,
              errorCode: null,
              errorMessage: null,
              checkedAt: state?.checkedAt ?? new Date().toISOString()
            })
          } else {
            items.push({
              destinationId: destination.id,
              destinationName: destination.name,
              target,
              status: state.status,
              canonicalVersion: state.canonicalVersion,
              distributedVersion: state.distributedVersion,
              distributedHash: state.distributedHash,
              errorCode: state.errorCode,
              errorMessage: state.errorMessage,
              checkedAt: state.checkedAt
            })
          }
        }
      }
    }

    let overallStatus: AcademyDeliveryConvergence
    if (isSuperseded) {
      overallStatus = 'DEGRADED'
    } else if (items.some(i => i.status === 'ERROR')) {
      overallStatus = items.every(i => i.status === 'ERROR') ? 'ERROR' : 'DEGRADED'
    } else if (items.some(i => i.status === 'DRIFTED' || i.status === 'MISSING')) {
      overallStatus = 'DEGRADED'
    } else if (items.some(i => i.status === 'PENDING')) {
      overallStatus = 'PENDING'
    } else if (items.every(i => i.status === 'CURRENT')) {
      overallStatus = 'CONVERGED'
    } else {
      overallStatus = 'PENDING'
    }

    return {
      skillId: skill.id,
      version: targetVersion,
      packageHash: targetHash,
      status: overallStatus,
      destinations: items
    }
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
  start(): void {
    this.assertNotClosed()
    this.watcher.start()
    this.recoverPendingReconciliations()
  }

  private recoverPendingReconciliations(): void {
    const destinations = this.store.listDestinations().filter(d => d.enabled)
    for (const destination of destinations) {
      let needsReconcile = false
      for (const summary of this.store.list()) {
        const skill = this.store.get(summary.id)
        const shouldExist = destination.enabled && skill.status === 'ACTIVE' && this.store.isAssigned(skill.id, destination.id)
        const projection = this.store.getProjection(skill.id, destination.id)
        if (shouldExist) {
          if (!projection || projection.version !== skill.currentVersion || projection.packageHash !== skill.current.packageHash) {
            needsReconcile = true
            break
          }
          for (const target of TARGETS) {
            const state = this.store.getDistributionState(skill.id, destination.id, target)
            if (!state || state.canonicalVersion !== skill.currentVersion || state.canonicalHash !== skill.current.packageHash || state.status !== 'CURRENT') {
              needsReconcile = true
              break
            }
          }
        } else {
          if (projection || TARGETS.some(t => this.store.getDistributionState(skill.id, destination.id, t) !== null)) {
            needsReconcile = true
            break
          }
        }
        if (needsReconcile) break
      }
      if (needsReconcile) {
        this.scheduleDestinationReconciliation(destination.id)
      }
    }
  }

  async close(): Promise<void> {
    this.isClosed = true
    this.watcher.stop()
    this.dirtyDestinations.clear()
    if (this.destinationPassPromises.size > 0) {
      const activePromises = [...this.destinationPassPromises.values()]
      await Promise.race([
        Promise.allSettled(activePromises),
        new Promise(resolve => setTimeout(resolve, this.closeTimeoutMs))
      ])
    }
    this.destinationPassPromises.clear()
    this.reconcilingDestinations.clear()
    this.store.close()
  }
}

export function academyDatabasePath(userData: string): string { return join(userData, 'academy', 'academy.db') }
