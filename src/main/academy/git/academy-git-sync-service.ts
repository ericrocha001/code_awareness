import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AcademyGitPublicationState, AcademyGitStatusProjection } from '../../../shared/types/academy-types'
import type { RepositoryRecord } from '../../../shared/types/repository-catalog-types'
import type { GitService } from '../../core/git-service'
import type { GitRemoteTransport } from '../../core/git-remote-transport'
import type { AcademyStore } from '../academy-store'
import { AcademyGitMaterializer, assertPublicationPaths, computeGitSnapshotHash, validateGitSnapshot } from './academy-git-materializer'
import type { AcademyGitSnapshotEntry } from './academy-git-materializer'
import type { AcademyPluginRepositoryProjection } from './academy-plugin-repository-projection'
import { AcademyMarketplaceProjection } from './academy-marketplace-projection'
import { AcademyPluginPackageRevisionService } from '../publication/academy-plugin-package-revision-service'
import { sha256 } from '../publication/openai-plugin-model'
import { withPublicationLock } from './academy-publication-lock'
import { decideAcademyReconciliation, managedConflictPaths } from './academy-git-reconciliation'

export type { GitRemoteTransport } from '../../core/git-remote-transport'
export interface AcademyGitRepositoryPort {
  resolveRepository(id: string): RepositoryRecord | null
  findByGitHubId(githubRepositoryId: string): RepositoryRecord | null
  listEligibleRepositories(): RepositoryRecord[]
}
export interface AcademyDestinationExcluder { excludeDestination(checkoutPath: string): Promise<void> }

export class AcademyGitSyncService {
  private activeSyncPromise: Promise<AcademyGitStatusProjection> | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private pendingNextSync = false
  private readonly packageRevisions: AcademyPluginPackageRevisionService
  private readonly marketplaceProjection: AcademyMarketplaceProjection
  private readonly publicationRoot: string
  private readonly debounceMs: number

  constructor(
    private readonly store: AcademyStore,
    private readonly materializer: AcademyGitMaterializer,
    private readonly git: GitService,
    private readonly transport: GitRemoteTransport,
    private readonly repositories: AcademyGitRepositoryPort,
    private readonly excluder?: AcademyDestinationExcluder,
    private readonly pluginProjection?: AcademyPluginRepositoryProjection,
    options?: { debounceMs?: number; publicationRoot?: string; packageRevisions?: AcademyPluginPackageRevisionService; marketplaceProjection?: AcademyMarketplaceProjection }
  ) {
    this.publicationRoot = options?.publicationRoot ?? join(dirname(store.databasePath), 'github-publication')
    this.debounceMs = options?.debounceMs ?? 500
    this.packageRevisions = options?.packageRevisions ?? new AcademyPluginPackageRevisionService(store)
    this.marketplaceProjection = options?.marketplaceProjection ?? new AcademyMarketplaceProjection()
    if (store.getGitProfile()?.syncState === 'SYNCED') store.updateGitSyncState({ syncState: 'DIRTY' })
  }

  private destinationKey(): string {
    const profile = this.store.getGitProfile()!
    return sha256(`${profile.githubRepositoryId}:${profile.branch}`)
  }

  getStatus(): AcademyGitStatusProjection {
    const profile = this.store.getGitProfile()
    const record = profile ? this.repositories.resolveRepository(profile.repositoryCatalogId) : null
    const publication = profile ? this.store.getGitPublication(this.destinationKey()) : null
    return {
      profile, publication,
      repository: record && profile ? { id: record.id, name: record.name, fullName: record.github?.fullName ?? record.name,
        visibility: record.github?.visibility ?? 'PUBLIC', checkoutPath: publication?.checkoutPath ?? record.localCheckout?.path ?? '', branch: profile.branch } : null,
      syncState: profile?.syncState ?? 'UNCONFIGURED', lastSyncAt: publication?.verifiedAt ?? null,
      lastCommitSha: profile?.lastCommitSha ?? null, lastError: profile?.lastError ?? null
    }
  }

  listEligibleRepositories(): RepositoryRecord[] { return this.repositories.listEligibleRepositories() }

  async bindRepository(id: string): Promise<AcademyGitStatusProjection> {
    if (this.activeSyncPromise) throw new Error('ACADEMY_SYNC_IN_PROGRESS')
    const record = this.repositories.resolveRepository(id)
    if (!record?.github || !record.localCheckout || record.localCheckout.availability !== 'AVAILABLE' || record.localCheckout.gitState !== 'GIT') throw new Error('REPOSITORY_NOT_ELIGIBLE')
    const previous = this.store.getGitProfile()
    if (previous && previous.repositoryCatalogId !== id) throw new Error('PUBLICATION_DESTINATION_CHANGE_REQUIRES_RECONCILIATION')
    if (!previous) {
      const branch = await this.git.getCurrentBranch(record.localCheckout.path)
      if (!branch) throw new Error('PUBLICATION_BRANCH_REQUIRED')
      this.store.saveGitProfile({ repositoryCatalogId: id, githubRepositoryId: record.github.repositoryId, branch,
        lastSnapshotHash: null, lastCommitSha: null, lastPushedCommitSha: null, syncState: 'DIRTY', lastError: null })
    }
    if (this.excluder) await this.excluder.excludeDestination(join(this.publicationRoot, this.destinationKey(), 'checkout'))
    return this.syncNow()
  }

  notifyCanonicalChange(): void {
    if (!this.store.getGitProfile()) return
    this.store.updateGitSyncState({ syncState: 'DIRTY' })
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => { this.debounceTimer = null; void this.sync() }, this.debounceMs)
  }

  async syncNow(): Promise<AcademyGitStatusProjection> {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null }
    return this.sync()
  }

  async sync(): Promise<AcademyGitStatusProjection> {
    if (this.activeSyncPromise) { this.pendingNextSync = true; return this.activeSyncPromise }
    this.activeSyncPromise = (async () => {
      let result: AcademyGitStatusProjection
      let passes = 0
      do {
        this.pendingNextSync = false
        result = this.store.getGitProfile()
          ? await withPublicationLock(join(this.publicationRoot, this.destinationKey()), () => this.executeSync()).catch(error => ({ ...this.getStatus(), syncState: error.message === 'PUBLICATION_BUSY' ? 'SYNCING' as const : 'ERROR' as const, lastError: String(error.message) }))
          : this.getStatus()
      } while (this.pendingNextSync && ++passes < 2)
      return result
    })()
    try { return await this.activeSyncPromise } finally { this.activeSyncPromise = null }
  }

  async recoverOnStartup(): Promise<void> { if (this.store.getGitProfile()) await this.sync() }

  async resolveManagedConflict(expectedRemoteHead: string | null, expectedDesiredTree: string): Promise<AcademyGitStatusProjection> {
    if (this.activeSyncPromise) throw new Error('ACADEMY_SYNC_IN_PROGRESS')
    const state = this.store.getGitPublication(this.destinationKey())
    if (!state || state.phase !== 'CONFLICT' || state.remoteHead !== expectedRemoteHead || state.desiredTree !== expectedDesiredTree) throw new Error('CONFLICT_STATE_CHANGED')
    state.authorizedRemoteHead = expectedRemoteHead
    state.authorizedDesiredTree = expectedDesiredTree
    this.store.saveGitPublication(state)
    return this.syncNow()
  }

  private async executeSync(): Promise<AcademyGitStatusProjection> {
    const profile = this.store.getGitProfile()
    if (!profile) return this.getStatus()
    const record = this.repositories.resolveRepository(profile.repositoryCatalogId)
    if (!record?.github) { this.store.updateGitSyncState({ syncState: 'ERROR', lastError: 'PUBLICATION_DESTINATION_UNAVAILABLE' }); return this.getStatus() }
    const key = this.destinationKey()
    const state: AcademyGitPublicationState = this.store.getGitPublication(key) ?? {
      destinationKey: key, checkoutPath: join(this.publicationRoot, key, 'checkout'), baselineTree: null,
      desiredRevision: null, desiredTree: null, localHead: null, remoteHead: null, verifiedAt: null,
      operationId: null, pendingCommit: null, legacyPendingHead: null, migrationComplete: false, conflictPaths: [], phase: 'RECONCILING'
    }
    const save = () => this.store.saveGitPublication(state)
    const root = state.checkoutPath
    const projection = join(this.publicationRoot, key, 'projection')
    const openAi = this.pluginProjection ? this.store.getOpenAiPluginProfile() : null
    const paths = openAi ? ['skills', 'plugin.json', 'assets/logo.png', '.agents/plugins/marketplace.json'] : ['skills']
    state.phase = 'RECONCILING'; state.conflictPaths = []; save()
    this.store.updateGitSyncState({ syncState: 'SYNCING', lastError: null })
    try {
      const entries: AcademyGitSnapshotEntry[] = this.store.list('ACTIVE').filter(s => s.scope === 'GLOBAL').sort((a, b) => a.name.localeCompare(b.name)).map(s => {
        const d = this.store.get(s.id)
        return { skillId: d.id, name: d.name, version: d.currentVersion, packageHash: d.current.packageHash, package: d.current.package }
      })
      validateGitSnapshot(entries, { isPublic: record.github.visibility === 'PUBLIC' })
      const revision = openAi ? this.packageRevisions.resolveCurrent() : null
      const inputRevision = computeGitSnapshotHash(entries)
      const project = async (destination: string) => {
        assertPublicationPaths(destination, paths)
        await this.materializer.materialize(destination, entries)
        if (openAi && this.pluginProjection && revision) {
          if (!openAi.logoPath) await rm(join(destination, 'assets', 'logo.png'), { force: true })
          const snapshot = entries.map(e => ({ skillId: e.skillId, name: e.name, academyVersion: e.version, packageHash: e.packageHash }))
          await this.pluginProjection.project(destination, openAi, snapshot, revision)
          await this.marketplaceProjection.project(destination, record, profile, openAi, this.store.getMarketplaceState())
          await this.pluginProjection.validate(destination, openAi, snapshot)
        }
      }
      await mkdir(projection, { recursive: true })
      await this.git.initializePublicationRepository(projection, record.github.cloneUrl)
      await project(projection)
      await this.git.stagePaths(projection, ['.'])
      const desired = await this.git.readManagedTree(projection, await this.git.writeIndexTree(projection), paths)
      state.desiredRevision = revision?.contentFingerprint ?? computeGitSnapshotHash(entries)
      state.desiredTree = desired; save()
      await this.git.initializePublicationRepository(root, record.github.cloneUrl)
      if (!this.transport.fetch || !this.transport.readRemoteHead) throw new Error('REMOTE_OBSERVATION_UNSUPPORTED')
      const observe = async () => {
        try {
          await this.transport.fetch!(root, 'origin')
          const head = await this.transport.readRemoteHead!(root, 'origin', `refs/heads/${profile.branch}`)
          if (head) await this.git.resolveCommit(root, head)
          state.remoteHead = head; save()
          return { head, tree: head ? await this.git.readManagedTree(root, head, paths) : '' }
        } catch (error) { state.phase = 'REMOTE_UNAVAILABLE'; save(); throw error }
      }
      let remote = await observe()
      if (!state.migrationComplete && record.localCheckout && existsSync(join(record.localCheckout.path, '.git'))) {
        const legacyHead = await this.git.resolveCommit(record.localCheckout.path, 'HEAD')
        await this.git.preserveLegacyCommits(root, record.localCheckout.path, legacyHead)
        if (!remote.head || !await this.git.isAncestor(root, legacyHead, remote.head)) state.legacyPendingHead = legacyHead
        if (profile.lastPushedCommitSha && remote.head && await this.git.isAncestor(root, profile.lastPushedCommitSha, remote.head)) state.baselineTree = await this.git.readManagedTree(root, profile.lastPushedCommitSha, paths)
        state.migrationComplete = true; save()
      }
      const branchRefs = await this.git.listBranches(root)
      if (!branchRefs.split('\n').some(line => line.split('\0')[0] === profile.branch)) await this.git.createPublicationBranch(root, profile.branch, remote.head)
      else if (await this.git.getCurrentBranch(root) !== profile.branch) throw new Error('PUBLICATION_BRANCH_MISMATCH')
      const conflict = (message: string, conflictingTree = remote.tree) => {
        state.phase = 'CONFLICT'; state.conflictPaths = managedConflictPaths(conflictingTree, desired); save()
        this.store.updateGitSyncState({ syncState: 'REMOTE_DIVERGED', lastError: message })
        return this.getStatus()
      }
      const prepareCommit = async () => {
        const status = await this.git.getOperationsStatus(root)
        if (status) {
          const changed = status.split('\0').filter(Boolean).map(line => line.slice(3))
          if (!state.operationId || changed.some(path => !paths.some(managed => path === managed || path.startsWith(`${managed}/`)))) throw new Error('PUBLICATION_WORKTREE_DIRTY')
        }
        state.operationId ??= randomUUID(); state.operationTree = desired; save()
        await project(root)
        await this.git.stagePaths(root, ['.'])
        const stagedTree = await this.git.writeIndexTree(root)
        if (await this.git.readManagedTree(root, stagedTree, paths) !== desired) throw new Error('PROJECTION_CONTENT_MISMATCH')
        const local = await this.git.readPublicationHead(root)
        if (!local || stagedTree !== await this.git.resolveTree(root, 'HEAD')) state.pendingCommit = await this.git.commitInspectedIndex(root, `Academy sync: ${entries.length} skills (${state.desiredRevision!.slice(0, 8)})`, local, await this.git.getIndexRevision(root))
        state.localHead = await this.git.resolveCommit(root, 'HEAD'); save()
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const authorized = state.authorizedDesiredTree === desired && state.authorizedRemoteHead === remote.head
        if (decideAcademyReconciliation(state.baselineTree, remote.tree, desired, Boolean(remote.head)) === 'CONFLICT' && !authorized) return conflict('Managed remote content differs from the confirmed baseline and canonical projection.')
        if (await this.git.getOperationsStatus(root)) await prepareCommit()
        if (state.legacyPendingHead) {
          const legacyTree = await this.git.readManagedTree(root, state.legacyPendingHead, paths)
          if (legacyTree !== desired && legacyTree !== state.baselineTree && !authorized) return conflict('Legacy unpublished commits preserved; explicit reconciliation is required.', legacyTree)
          if (!await this.git.readPublicationHead(root)) await this.git.mergeBranch(root, state.legacyPendingHead, 'FF_ONLY')
          else if (!await this.git.isAncestor(root, state.legacyPendingHead, await this.git.resolveCommit(root, 'HEAD'))) await this.git.mergePublication(root, state.legacyPendingHead, authorized ? paths : undefined)
          state.legacyPendingHead = null; save()
        }
        if (remote.head && (!await this.git.readPublicationHead(root) || !await this.git.isAncestor(root, remote.head, await this.git.resolveCommit(root, 'HEAD')))) {
          if (!await this.git.readPublicationHead(root)) await this.git.mergeBranch(root, remote.head, 'FF_ONLY')
          else {
            const localTree = await this.git.readManagedTree(root, await this.git.resolveCommit(root, 'HEAD'), paths)
            if (localTree !== desired && localTree !== state.baselineTree && localTree !== remote.tree && localTree !== state.operationTree && !authorized) return conflict('Unreconciled local publication content preserved.', localTree)
            try { await this.git.mergePublication(root, remote.head, authorized || remote.tree === desired ? paths : undefined) } catch (error) {
              if (await this.git.getGitOperation(root) === 'MERGE') await this.git.abortMerge(root)
              return conflict(`History integration requires explicit reconciliation: ${String(error)}`)
            }
          }
        }
        await prepareCommit()
        state.pendingCommit = state.localHead; state.phase = 'PUSH_PENDING'; save()
        this.store.updateGitSyncState({ syncState: 'PUSH_PENDING', lastCommitSha: state.localHead, lastSnapshotHash: state.desiredRevision })
        if (remote.head !== state.localHead) {
          const beforePush = await observe()
          if (beforePush.head !== remote.head) { remote = beforePush; continue }
          try { await this.transport.push(root, profile.branch, 'origin', state.localHead!) } catch (error) {
            const afterError = await observe()
            if (afterError.head !== state.localHead && afterError.head === remote.head) throw error
            remote = afterError; continue
          }
        }
        remote = await observe()
        if (remote.tree !== desired || !remote.head || !await this.git.isAncestor(root, state.localHead!, remote.head)) continue
        state.baselineTree = desired; state.verifiedAt = new Date().toISOString(); state.phase = 'CONFIRMED'
        state.pendingCommit = null; state.operationId = null; save()
        state.authorizedRemoteHead = null; state.authorizedDesiredTree = null; state.operationTree = null; save()
        this.store.updateGitSyncState({ syncState: 'SYNCED', lastPushedCommitSha: remote.head, lastError: null })
        const currentEntries = this.store.list('ACTIVE').filter(skill => skill.scope === 'GLOBAL').map(skill => {
          const detail = this.store.get(skill.id)
          return { skillId: detail.id, name: detail.name, version: detail.currentVersion, packageHash: detail.current.packageHash }
        })
        if (computeGitSnapshotHash(currentEntries) !== inputRevision || (revision && this.packageRevisions.resolveCurrent().contentFingerprint !== revision.contentFingerprint)) {
          this.pendingNextSync = true
          state.phase = 'RECONCILING'; save()
          this.store.updateGitSyncState({ syncState: 'DIRTY', lastError: null })
        }
        return this.getStatus()
      }
      throw new Error('REMOTE_ADVANCED_RETRY_PENDING')
    } catch (error) {
      if ((state as AcademyGitPublicationState).phase !== 'REMOTE_UNAVAILABLE') state.phase = state.pendingCommit ? 'PUSH_PENDING' : 'ERROR'
      save()
      this.store.updateGitSyncState({ syncState: state.pendingCommit ? 'PUSH_PENDING' : 'ERROR', lastError: error instanceof Error ? error.message : String(error) })
      return this.getStatus()
    }
  }
}
