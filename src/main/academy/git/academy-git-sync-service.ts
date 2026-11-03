import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AcademyCreateInput, AcademyDraftReceipt, AcademyGitConflictReview, AcademyGitPublicationState, AcademyGitStatusProjection, AcademyGitSyncState, AcademyUpdateInput } from '../../../shared/types/academy-types'
import type { AcademyGitBuildSource, AcademyGitSourceSnapshot } from '../../../shared/types/academy-git-source-types'
import type { AcademyManifestPreview } from '../../../shared/types/academy-publication-types'
import type { RepositoryRecord } from '../../../shared/types/repository-catalog-types'
import type { GitService } from '../../core/git-service'
import type { GitRemoteTransport } from '../../core/git-remote-transport'
import type { AcademyStore } from '../academy-store'
import { AcademyError, hashAcademyPackage, normalizeAcademyPackage, parseSkillMetadata } from '../academy-package'
import { observeSkillDirectory, readSkillDirectory, removeSkillDirectory, replaceSkillDirectory, writeSkillDirectory } from '../academy-filesystem'
import { AcademyGitMaterializer, assertPublicationPaths, validateGitSnapshot } from './academy-git-materializer'
import type { AcademyPluginRepositoryProjection } from './academy-plugin-repository-projection'
import type { AcademyPluginPackageRevisionService } from '../publication/academy-plugin-package-revision-service'
import type { AcademyMarketplaceProjection } from './academy-marketplace-projection'
import { canonicalJson, sha256 } from '../publication/openai-plugin-model'
import { compareSemver } from '../publication/academy-plugin-package-revision-service'
import { withPublicationLock } from './academy-publication-lock'
import { ACADEMY_AUTHORED_PATHS, assertSourcePath, readAcademyGitSnapshot, verifyStagedAcademyPackage } from './academy-git-snapshot'

export type { GitRemoteTransport } from '../../core/git-remote-transport'
export interface AcademyGitRepositoryPort {
  resolveRepository(id: string): RepositoryRecord | null
  findByGitHubId(githubRepositoryId: string): RepositoryRecord | null
  listEligibleRepositories(): RepositoryRecord[]
}
export interface AcademyDestinationExcluder { excludeDestination(checkoutPath: string): Promise<void> }

export function projectAcademyGitStatus(status: AcademyGitStatusProjection) {
  return { state: status.syncState, repositoryId: status.profile?.githubRepositoryId ?? null, branch: status.profile?.branch ?? null,
    sourceCommitSha: status.lastCommitSha, observedRemoteHead: status.publication?.remoteHead ?? null, remoteObservedAt: status.lastSyncAt,
    workspaceCommitSha: status.publication?.localHead ?? null, migrationComplete: status.publication?.migrationComplete ?? false,
    candidateBranch: status.publication?.candidateBranch ?? null, candidateCommitSha: status.publication?.candidateCommitSha ?? null,
    conflictPaths: status.publication?.conflictPaths ?? [], error: status.lastError }
}

export class AcademyGitSyncService {
  private active: Promise<AcademyGitStatusProjection> | null = null
  private closing = false
  private latestSource: Promise<AcademyGitStatusProjection> | null = null
  private observation: { policy: string; head: string; at: number } | null = null
  private readonly publicationRoot: string
  private accepted: (ids: string[]) => void = () => {}
  private statusChanged: () => void = () => {}

  constructor(
    private readonly store: AcademyStore,
    _materializer: AcademyGitMaterializer,
    private readonly git: GitService,
    private readonly transport: GitRemoteTransport,
    private readonly repositories: AcademyGitRepositoryPort,
    private readonly excluder?: AcademyDestinationExcluder,
    _pluginProjection?: AcademyPluginRepositoryProjection,
    options?: { debounceMs?: number; publicationRoot?: string; packageRevisions?: AcademyPluginPackageRevisionService; marketplaceProjection?: AcademyMarketplaceProjection }
  ) {
    this.publicationRoot = options?.publicationRoot ?? join(dirname(store.databasePath), 'github-publication')
    if (store.getGitProfile()) { const state = this.state(); this.save(state, 'UNKNOWN') }
  }

  onAccepted(listener: (ids: string[]) => void): void { this.accepted = listener }
  onStatusChange(listener: () => void): void { this.statusChanged = listener }
  private key(): string { const p = this.store.getGitProfile(); if (!p) throw new AcademyError('GIT_PROFILE_NOT_CONFIGURED'); return sha256(`${p.githubRepositoryId}:${p.branch}`) }
  private policyIdentity(): string {
    const { repositoryId, remoteUrl, profile } = this.identity()
    return sha256(`${repositoryId}:${profile.branch}:${remoteUrl}:${this.transport.authorizationIdentity?.() ?? 'READ_ONLY'}`)
  }
  private state(): AcademyGitPublicationState {
    const old = this.store.getGitPublication(this.key())
    if (old?.sourceMode === 'GIT_FIRST') return old
    if (old) this.store.saveGitPublication({ ...old, destinationKey: `legacy:${this.key()}` })
    return {
      destinationKey: this.key(), sourceMode: 'GIT_FIRST', checkoutPath: join(this.publicationRoot, this.key(), 'source'),
      workspacePath: join(this.publicationRoot, this.key(), 'workspace'), baselineTree: null, desiredRevision: null, desiredTree: null,
      localHead: null, remoteHead: null, verifiedAt: null, operationId: null, pendingCommit: null, legacyPendingHead: old?.pendingCommit ?? null,
      migrationComplete: false, conflictPaths: [], phase: 'RECONCILING', businessState: 'UNKNOWN', autoPublish: false, autoUpdate: false
    }
  }
  private save(state: AcademyGitPublicationState, businessState: AcademyGitSyncState, error: string | null = null): void {
    state.businessState = businessState
    this.store.saveGitPublication(state)
    this.store.updateGitSyncState({ syncState: businessState === 'SYNCED' ? 'SYNCED' : businessState === 'SYNCING' ? 'SYNCING' : businessState === 'CONFLICT' ? 'REMOTE_DIVERGED' : 'DIRTY', lastError: error })
  }
  getStatus(): AcademyGitStatusProjection {
    const profile = this.store.getGitProfile()
    const record = profile ? this.repositories.resolveRepository(profile.repositoryCatalogId) : null
    const publication = profile ? this.store.getGitPublication(this.key()) : null
    return { profile, publication, repository: record && profile ? { id: record.id, name: record.name, fullName: record.github?.fullName ?? record.name,
      visibility: record.github?.visibility ?? 'PUBLIC', checkoutPath: publication?.migrationComplete ? publication.workspacePath! : publication?.migrationCandidatePath ?? '', branch: profile.branch } : null,
      syncState: publication?.businessState ?? (profile ? 'UNKNOWN' : 'UNCONFIGURED'), lastSyncAt: publication?.verifiedAt ?? null,
      lastCommitSha: this.store.getGitAuthority()?.processedCommitSha ?? null, lastError: profile?.lastError ?? null }
  }
  listEligibleRepositories(): RepositoryRecord[] { return this.repositories.listEligibleRepositories() }
  async bindRepository(id: string): Promise<AcademyGitStatusProjection> {
    if (this.active) throw new AcademyError('ACADEMY_SYNC_IN_PROGRESS')
    const record = this.repositories.resolveRepository(id)
    if (!record?.github || !record.localCheckout || record.localCheckout.availability !== 'AVAILABLE') throw new AcademyError('REPOSITORY_NOT_ELIGIBLE')
    const previous = this.store.getGitProfile()
    if (previous && previous.repositoryCatalogId !== id) throw new AcademyError('PUBLICATION_DESTINATION_CHANGE_REQUIRES_RECONCILIATION')
    if (!previous) this.store.saveGitProfile({ repositoryCatalogId: id, githubRepositoryId: record.github.repositoryId, branch: 'main',
      lastSnapshotHash: null, lastCommitSha: null, lastPushedCommitSha: null, syncState: 'DIRTY', lastError: null })
    return this.syncNow()
  }
  private async exclusive(action: (state: AcademyGitPublicationState) => Promise<void>): Promise<AcademyGitStatusProjection> {
    while (this.active) await this.active
    if (this.closing) throw new AcademyError('ACADEMY_SERVICE_CLOSED')
    if (!this.store.getGitProfile()) throw new AcademyError('GIT_PROFILE_NOT_CONFIGURED')
    this.active = withPublicationLock(join(this.publicationRoot, this.key()), async () => {
      const state = this.state()
      try { await action(state) }
      catch (error) {
        this.observation = null
        const message = error instanceof AcademyError ? error.code : error instanceof Error ? error.message : String(error)
        this.save(state, state.phase === 'CONFLICT' ? 'CONFLICT' : state.phase === 'REMOTE_UNAVAILABLE' ? 'OFFLINE' : 'UNKNOWN', message)
      }
      if (state.verifiedAt && state.remoteHead && !this.store.getGitProfile()?.lastError && this.store.getGitAuthority()?.processedCommitSha === state.remoteHead) {
        this.observation = { policy: this.policyIdentity(), head: state.remoteHead, at: Date.parse(state.verifiedAt) }
      }
      this.statusChanged()
      return this.getStatus()
    })
    try { return await this.active } finally { this.active = null }
  }
  private identity() {
    const profile = this.store.getGitProfile()!
    const record = this.repositories.resolveRepository(profile.repositoryCatalogId)
    if (!record?.github || record.github.repositoryId !== profile.githubRepositoryId) throw new AcademyError('GIT_SOURCE_IDENTITY_CHANGED')
    return { profile, record, repositoryId: profile.githubRepositoryId, remoteUrl: record.github.cloneUrl }
  }
  private async observe(state: AcademyGitPublicationState): Promise<AcademyGitSourceSnapshot> {
    const { profile, repositoryId, remoteUrl } = this.identity()
    assertPublicationPaths(state.checkoutPath, [...ACADEMY_AUTHORED_PATHS, '.git'])
    await this.git.initializePublicationRepository(state.checkoutPath, remoteUrl)
    if (!this.transport.fetch || !this.transport.readRemoteHead) throw new AcademyError('REMOTE_OBSERVATION_UNSUPPORTED')
    let head: string | null
    try {
      await this.transport.fetch(state.checkoutPath, 'origin')
      head = await this.transport.readRemoteHead(state.checkoutPath, 'origin', `refs/heads/${profile.branch}`)
    } catch (error) { state.phase = 'REMOTE_UNAVAILABLE'; throw error }
    if (!head) throw new AcademyError('GIT_SOURCE_BRANCH_MISSING')
    const snapshot = await readAcademyGitSnapshot(this.git, state.checkoutPath, { repositoryId, remoteUrl, branch: profile.branch, sourceCommitSha: head, observedAt: new Date().toISOString() })
    state.remoteHead = head; state.verifiedAt = snapshot.observedAt
    return snapshot
  }
  private async ensureWorkspace(state: AcademyGitPublicationState, snapshot: AcademyGitSourceSnapshot): Promise<void> {
    const root = state.workspacePath!
    assertPublicationPaths(root, [...ACADEMY_AUTHORED_PATHS, '.git'])
    await this.git.initializePublicationRepository(root, snapshot.remoteUrl)
    await this.git.preserveLegacyCommits(root, state.checkoutPath, snapshot.sourceCommitSha)
    if (!await this.git.readPublicationHead(root)) await this.git.createPublicationBranch(root, snapshot.branch, snapshot.sourceCommitSha)
    if (await this.git.getCurrentBranch(root) !== snapshot.branch) throw new AcademyError('PUBLICATION_BRANCH_MISMATCH')
    state.localHead = await this.git.resolveCommit(root, 'HEAD')
  }
  private async preserveMigration(state: AcademyGitPublicationState, snapshot: AcademyGitSourceSnapshot): Promise<void> {
    const candidates = this.store.list().filter(skill => skill.scope === 'GLOBAL').map(skill => this.store.get(skill.id))
    const catalogHash = this.store.gitMigrationHash(snapshot)
    const legacy = this.store.getGitPublication(`legacy:${this.key()}`)
    let legacyEvidence: unknown = null
    state.conflictPaths = this.store.migrationDifferences(snapshot)
    if (legacy && !existsSync(join(legacy.checkoutPath, '.git')) && (legacy.pendingCommit || legacy.localHead || legacy.legacyPendingHead)) throw new AcademyError('LEGACY_CHECKOUT_UNAVAILABLE')
    if (legacy && existsSync(join(legacy.checkoutPath, '.git'))) {
      assertPublicationPaths(legacy.checkoutPath, ['skills', '.git'])
      const captured = await this.git.captureWorktreeReadSnapshot(legacy.checkoutPath)
      legacyEvidence = { checkoutPath: legacy.checkoutPath, ...captured, contentRevision: await this.git.getWorktreeRevision(legacy.checkoutPath, false, true) }
      if (captured.head) {
        await this.git.preserveLegacyCommits(state.checkoutPath, legacy.checkoutPath, captured.head)
        if (!await this.git.isAncestor(state.checkoutPath, captured.head, snapshot.sourceCommitSha)) state.conflictPaths.push('legacy-publication:unpublished-commits')
      }
      if (captured.status || captured.operation) state.conflictPaths.push('legacy-publication:working-changes')
    }
    const hash = legacyEvidence ? sha256(JSON.stringify({ catalogHash, legacyEvidence })) : catalogHash
    const root = join(this.publicationRoot, this.key(), 'migration-candidates')
    await mkdir(root, { recursive: true })
    const file = join(root, `${hash}.json`)
    if (!existsSync(file)) writeFileSync(file, JSON.stringify({ sourceCommitSha: snapshot.sourceCommitSha, candidates, legacyEvidence }), { flag: 'wx' })
    state.migrationCandidateHash = hash
    const privateRoot = join(root, hash.slice(0, 16))
    assertPublicationPaths(privateRoot, ['skills', '.git'])
    await this.git.initializePublicationRepository(privateRoot)
    const marker = join(privateRoot, '.git', 'academy-migration')
    if (!existsSync(marker)) {
      if (await this.git.readPublicationHead(privateRoot)) throw new AcademyError('MIGRATION_CANDIDATE_UNOWNED')
      writeFileSync(marker, hash, { flag: 'wx' })
    } else if (readFileSync(marker, 'utf8') !== hash) throw new AcademyError('MIGRATION_CANDIDATE_IDENTITY_COLLISION')
    if (await this.git.getRemoteUrl(privateRoot)) throw new AcademyError('PRIVATE_MIGRATION_CANDIDATE_HAS_REMOTE')
    if (!await this.git.readPublicationHead(privateRoot)) {
      if (await this.git.getCurrentBranch(privateRoot) !== 'legacy-candidate') await this.git.createPublicationBranch(privateRoot, 'legacy-candidate', null)
      const paths: string[] = []
      for (const skill of candidates) {
        const path = `skills/${skill.name}`
        assertPublicationPaths(privateRoot, [path])
        const disk = await observeSkillDirectory(join(privateRoot, path))
        if (disk.hash !== 'DELETED' && disk.hash !== skill.current.packageHash) throw new AcademyError('MIGRATION_CANDIDATE_CHANGED')
        if (disk.hash === 'DELETED') await writeSkillDirectory(join(privateRoot, path), skill.current.package)
        paths.push(path)
      }
      if (paths.length) {
        await this.git.stagePaths(privateRoot, paths)
        await this.git.commitInspectedIndex(privateRoot, 'Academy: preserve private legacy migration candidates', null, await this.git.getIndexRevision(privateRoot))
      }
    }
    await this.git.preserveLegacyCommits(privateRoot, state.checkoutPath, snapshot.sourceCommitSha, 'refs/academy/source-main')
    state.migrationCandidatePath = privateRoot
  }
  private async applyRemote(state: AcademyGitPublicationState, snapshot: AcademyGitSourceSnapshot, reviewedMigrationHash?: string): Promise<void> {
    const authority = this.store.getGitAuthority()
    if (!authority) {
      await this.preserveMigration(state, snapshot)
      if (state.conflictPaths.length && reviewedMigrationHash !== state.migrationCandidateHash) {
        state.phase = 'CONFLICT'; this.save(state, 'CONFLICT', 'GIT_MIGRATION_RECONCILIATION_REQUIRED'); return
      }
    }
    const commits = authority ? await this.git.firstParentTransitions(state.checkoutPath, authority.processedCommitSha, snapshot.sourceCommitSha) : [snapshot.sourceCommitSha]
    const snapshots: AcademyGitSourceSnapshot[] = []
    for (const commit of commits) snapshots.push(commit === snapshot.sourceCommitSha ? snapshot : await readAcademyGitSnapshot(this.git, state.checkoutPath, { repositoryId: snapshot.repositoryId, remoteUrl: snapshot.remoteUrl, branch: snapshot.branch, sourceCommitSha: commit, observedAt: snapshot.observedAt }))
    if (await this.git.getOperationsStatus(state.checkoutPath)) throw new AcademyError('GIT_SOURCE_CHECKOUT_DIRTY')
    if (!await this.git.readPublicationHead(state.checkoutPath)) await this.git.createPublicationBranch(state.checkoutPath, snapshot.branch, snapshot.sourceCommitSha)
    else {
      if (await this.git.getCurrentBranch(state.checkoutPath) !== snapshot.branch) throw new AcademyError('PUBLICATION_BRANCH_MISMATCH')
      await this.git.mergeBranch(state.checkoutPath, snapshot.sourceCommitSha, 'FF_ONLY')
    }
    const ids = this.store.acceptGitSnapshots(snapshots, authority?.processedCommitSha ?? null, reviewedMigrationHash ? this.store.gitMigrationHash(snapshot) : undefined)
    state.migrationComplete = true; state.baselineTree = snapshot.managedTreeHash; state.phase = 'CONFIRMED'; state.conflictPaths = []
    this.store.updateGitSyncState({ syncState: 'DIRTY', lastCommitSha: snapshot.sourceCommitSha, lastSnapshotHash: snapshot.managedTreeHash })
    await this.ensureWorkspace(state, snapshot)
    if (this.excluder) for (const path of [state.checkoutPath, state.workspacePath!]) await this.excluder.excludeDestination(path)
    await this.classify(state, snapshot)
    const pendingDelivery = this.store.listDestinations().some(destination => destination.enabled && destination.reconciliationStatus !== 'SYNCED')
    this.accepted(ids.length ? ids : pendingDelivery ? this.store.list().filter(skill => skill.scope === 'GLOBAL').map(skill => skill.id) : [])
  }
  private async classify(state: AcademyGitPublicationState, snapshot: AcademyGitSourceSnapshot): Promise<void> {
    if (!state.migrationComplete) return
    const root = state.workspacePath!
    if (await this.git.getGitOperation(root) === 'MERGE') {
      state.conflictPaths = await this.git.unmergedPaths(root)
      state.phase = 'CONFLICT'; this.save(state, 'CONFLICT', 'GIT_RESOLUTION_REVIEW_REQUIRED'); return
    }
    if (await this.git.getOperationsStatus(root)) { this.save(state, 'LOCAL_CHANGES', 'WORKSPACE_UNCOMMITTED_RECOVERY_REQUIRED'); return }
    state.localHead = await this.git.resolveCommit(root, 'HEAD')
    if (state.localHead === snapshot.sourceCommitSha) { state.pendingCommit = null; this.save(state, 'SYNCED'); return }
    if (await this.git.isAncestor(root, snapshot.sourceCommitSha, state.localHead)) { state.pendingCommit = state.localHead; this.save(state, state.candidateCommitSha === state.localHead ? 'PR_PENDING' : 'LOCAL_CHANGES'); return }
    if (await this.git.isAncestor(root, state.localHead, snapshot.sourceCommitSha)) { this.save(state, 'REMOTE_CHANGES'); return }
    state.conflictPaths = await this.git.previewPublicationMerge(root, state.localHead, snapshot.sourceCommitSha)
    state.phase = state.conflictPaths.length ? 'CONFLICT' : 'CONFIRMED'
    this.save(state, state.conflictPaths.length ? 'CONFLICT' : 'MERGEABLE_BOTH')
  }
  async fetch(): Promise<AcademyGitStatusProjection> {
    return this.exclusive(async state => {
      const snapshot = await this.observe(state)
      if (this.store.getGitAuthority()?.processedCommitSha !== snapshot.sourceCommitSha) this.save(state, 'REMOTE_CHANGES')
      else { await this.ensureWorkspace(state, snapshot); await this.classify(state, snapshot) }
    })
  }
  async syncNow(): Promise<AcademyGitStatusProjection> {
    return this.exclusive(async state => {
      const snapshot = await this.observe(state)
      await this.applyRemote(state, snapshot)
      if (state.businessState === 'REMOTE_CHANGES') {
        await this.git.mergeBranch(state.workspacePath!, snapshot.sourceCommitSha, 'FF_ONLY')
        await this.classify(state, snapshot)
      } else if (state.businessState === 'MERGEABLE_BOTH') await this.mergeWorkspace(state, snapshot)
    })
  }
  async sync(): Promise<AcademyGitStatusProjection> { return this.syncNow() }

  async getSourceSnapshot(input: { mode: 'LATEST'; force?: boolean } | { mode: 'REBUILD'; sourceCommitSha: string }): Promise<AcademyGitBuildSource> {
    if (input.mode === 'LATEST') {
      if (this.active) await this.active
      const observed = this.observation
      const now = Date.now()
      const reusable = !input.force && observed && observed.policy === this.policyIdentity() && now - observed.at >= 0 && now - observed.at <= 30000 &&
        this.store.getGitAuthority()?.processedCommitSha === observed.head && this.state().remoteHead === observed.head && !this.store.getGitProfile()?.lastError
      if (!reusable && !this.latestSource) {
        const pending = this.syncNow()
        this.latestSource = pending
        void pending.then(() => { if (this.latestSource === pending) this.latestSource = null }, () => { if (this.latestSource === pending) this.latestSource = null })
      }
      const status = this.latestSource ? await this.latestSource : this.getStatus()
      const authority = this.store.getGitAuthority()
      if (!authority || status.publication?.remoteHead !== authority.processedCommitSha || ['UNKNOWN', 'OFFLINE'].includes(status.syncState)) throw new AcademyError('GIT_SOURCE_LATEST_UNVERIFIED')
    }
    const authority = this.store.getGitAuthority()
    if (!authority) throw new AcademyError('GIT_MIGRATION_REQUIRED')
    const commit = input.mode === 'REBUILD' ? input.sourceCommitSha : authority.processedCommitSha
    const snapshot = this.store.getGitSnapshot(authority.repositoryId, commit)
    if (!snapshot || !snapshot.canonicalVersions) throw new AcademyError('GIT_SOURCE_SNAPSHOT_NOT_VERIFIED')
    if (input.mode === 'LATEST' && await this.git.getOperationsStatus(this.state().checkoutPath)) throw new AcademyError('GIT_SOURCE_CHECKOUT_DIRTY')
    return { snapshot, remoteConfirmation: input.mode === 'LATEST' ? 'OBSERVED' : 'CACHED', confirmedAt: input.mode === 'LATEST' ? this.getStatus().lastSyncAt! : snapshot.observedAt }
  }

  async saveDraft(input: AcademyCreateInput | AcademyUpdateInput): Promise<AcademyDraftReceipt> {
    let receipt: AcademyDraftReceipt | undefined
    const status = await this.exclusive(async state => {
      const authority = this.store.getGitAuthority()
      if (!authority) throw new AcademyError('GIT_MIGRATION_REQUIRED')
      const snapshot = this.store.getGitSnapshot(authority.repositoryId, authority.processedCommitSha)!
      await this.ensureWorkspace(state, snapshot)
      const root = state.workspacePath!
      if (await this.git.getOperationsStatus(root)) throw new AcademyError('WORKSPACE_UNCOMMITTED_RECOVERY_REQUIRED')
      const pkg = normalizeAcademyPackage(input.package)
      const name = parseSkillMetadata(pkg.skillMd).name
      const current = 'skillId' in input ? this.store.get(input.skillId) : null
      if (current && (current.scope !== 'GLOBAL' || current.name !== name || !('expectedVersion' in input) ||
        (current.currentVersion !== input.expectedVersion && (!input.expectedDraftCommitSha || current.current.gitSource?.sourceCommitSha !== input.expectedDraftCommitSha)))) throw new AcademyError('GIT_DRAFT_BASE_CHANGED')
      if (!current && this.store.findByName(name)) throw new AcademyError('DUPLICATE_SKILL_NAME')
      if (input.scope && input.scope !== 'GLOBAL') throw new AcademyError('GIT_SCOPE_CHANGE_REQUIRES_REVIEW')
      const localHead = await this.git.resolveCommit(root, 'HEAD')
      if (input.expectedDraftCommitSha ? input.expectedDraftCommitSha !== localHead : localHead !== authority.processedCommitSha) throw new AcademyError('DRAFT_REVISION_REQUIRED')
      validateGitSnapshot([{ name, package: pkg, packageHash: hashAcademyPackage(pkg), skillId: current?.id ?? name, version: 0 }])
      const path = `skills/${name}`
      assertPublicationPaths(root, [path])
      const previous = await observeSkillDirectory(join(root, path))
      await replaceSkillDirectory(join(root, path), pkg, previous.hash)
      await this.git.stagePaths(root, [path])
      const stagedTree = await this.git.writeIndexTree(root)
      await verifyStagedAcademyPackage(this.git, root, stagedTree, name, pkg)
      let head = localHead
      if (stagedTree !== await this.git.resolveTree(root, 'HEAD')) head = await this.git.commitInspectedIndex(root, `Academy: save ${name}`, localHead, await this.git.getIndexRevision(root))
      state.localHead = head; state.pendingCommit = head; state.desiredTree = head
      this.save(state, head === authority.processedCommitSha ? 'SYNCED' : 'LOCAL_CHANGES')
      receipt = { state: 'DRAFT_SAVED', skillId: current?.id ?? null, name, baseVersion: current?.currentVersion ?? null,
        sourceBaseCommitSha: authority.processedCommitSha, workspaceCommitSha: head, packageHash: hashAcademyPackage(pkg), distribution: { status: 'NOT_APPLICABLE' } }
    })
    if (!receipt) throw new AcademyError(status.lastError ?? 'DRAFT_SAVE_FAILED')
    if (this.state().autoPublish) void this.publish().catch(() => {})
    return receipt
  }

  async getDraft(name: string): Promise<{ package: import('../../../shared/types/academy-types').AcademyPackage | null; workspaceCommitSha: string; sourceBaseCommitSha: string }> {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new AcademyError('INVALID_SKILL_NAME')
    const state = this.state(), authority = this.store.getGitAuthority()
    if (!authority || !state.workspacePath) throw new AcademyError('GIT_MIGRATION_REQUIRED')
    assertPublicationPaths(state.workspacePath, [`skills/${name}`, '.git'])
    const disk = await observeSkillDirectory(join(state.workspacePath, 'skills', name))
    return { package: disk.package, workspaceCommitSha: await this.git.resolveCommit(state.workspacePath, 'HEAD'), sourceBaseCommitSha: authority.processedCommitSha }
  }

  async previewManifestUpdate(newVersion: string, sourceCommitSha: string): Promise<AcademyManifestPreview> {
    let preview: AcademyManifestPreview | undefined
    const status = await this.exclusive(async state => {
      const { profile, repositoryId } = this.identity()
      const source = this.store.getGitSnapshot(repositoryId, sourceCommitSha)
      if (!source || this.store.getGitAuthority()?.processedCommitSha !== sourceCommitSha || state.remoteHead !== sourceCommitSha) throw new AcademyError('MANIFEST_SOURCE_CHANGED')
      await this.ensureWorkspace(state, source)
      const root = state.workspacePath!
      assertPublicationPaths(root, ['plugin.json', '.git'])
      if (await this.git.getOperationsStatus(root)) throw new AcademyError('WORKSPACE_UNCOMMITTED_RECOVERY_REQUIRED')
      const head = await this.git.resolveCommit(root, 'HEAD')
      const bytes = await this.git.readCommitFile(root, head, 'plugin.json', 1024 * 1024)
      if (!bytes) throw new AcademyError('OPENAI_PLUGIN_MANIFEST_MISSING')
      const manifest = JSON.parse(bytes.toString('utf8'))
      if (manifest.name !== 'academy-skills' || compareSemver(newVersion, manifest.version) <= 0) throw new AcademyError('OPENAI_PLUGIN_VERSION_NOT_PROGRESSIVE')
      const fields = { repositoryId, branch: profile.branch, sourceCommitSha, workspaceCommitSha: head,
        manifestHash: sha256(bytes), previousVersion: manifest.version, newVersion, before: bytes.toString('utf8'),
        after: `${JSON.stringify({ ...manifest, version: newVersion }, null, 2)}\n` }
      preview = { ...fields, token: sha256(canonicalJson({ ...fields, policy: this.policyIdentity() })) }
    })
    if (!preview) throw new AcademyError(status.lastError ?? 'MANIFEST_PREVIEW_FAILED')
    return preview
  }

  async saveManifestDraft(input: { preview: AcademyManifestPreview; confirmed: boolean }): Promise<AcademyGitStatusProjection> {
    if (input.confirmed !== true) throw new AcademyError('MANIFEST_EDIT_AUTHORIZATION_REQUIRED')
    return this.exclusive(async state => {
      const { token, ...preview } = input.preview
      if (token !== sha256(canonicalJson({ ...preview, policy: this.policyIdentity() }))) throw new AcademyError('MANIFEST_REVIEW_STALE')
      const source = await this.observe(state)
      await this.applyRemote(state, source)
      const { profile, repositoryId } = this.identity()
      if (preview.repositoryId !== repositoryId || preview.branch !== profile.branch || source.sourceCommitSha !== preview.sourceCommitSha) throw new AcademyError('MANIFEST_SOURCE_CHANGED')
      const root = state.workspacePath!
      assertPublicationPaths(root, ['plugin.json', '.git'])
      if (await this.git.getOperationsStatus(root) || await this.git.resolveCommit(root, 'HEAD') !== preview.workspaceCommitSha) throw new AcademyError('MANIFEST_REVIEW_STALE')
      const before = readFileSync(join(root, 'plugin.json'))
      if (sha256(before) !== preview.manifestHash) throw new AcademyError('MANIFEST_REVIEW_STALE')
      const manifest = JSON.parse(before.toString('utf8'))
      const after = `${JSON.stringify({ ...manifest, version: preview.newVersion }, null, 2)}\n`
      if (manifest.name !== 'academy-skills' || compareSemver(preview.newVersion, manifest.version) <= 0 || after !== preview.after) throw new AcademyError('MANIFEST_REVIEW_STALE')
      const revision = this.store.knownPluginVersions()
      if (revision.some(version => compareSemver(preview.newVersion, version) <= 0)) throw new AcademyError('MANIFEST_VERSION_NO_LONGER_AVAILABLE')
      writeFileSync(join(root, 'plugin.json'), after)
      await this.git.stagePaths(root, ['plugin.json'])
      const tree = await this.git.writeIndexTree(root)
      const staged = await this.git.readCommitFile(root, tree, 'plugin.json', 1024 * 1024)
      if (!staged?.equals(Buffer.from(after))) throw new AcademyError('GIT_DRAFT_CONTENT_CHANGED_BY_FILTER')
      state.localHead = await this.git.commitInspectedIndex(root, `Academy: prepare plugin version ${preview.newVersion}`, preview.workspaceCommitSha, await this.git.getIndexRevision(root))
      state.pendingCommit = state.localHead; state.desiredTree = state.localHead
      this.save(state, 'LOCAL_CHANGES')
    })
  }

  async publish(expected?: { localHead: string; remoteHead: string | null }): Promise<AcademyGitStatusProjection> {
    return this.exclusive(async state => {
      if (expected && await this.git.resolveCommit(state.workspacePath!, 'HEAD') !== expected.localHead) throw new AcademyError('WORKSPACE_REVISION_CHANGED')
      const snapshot = await this.observe(state)
      await this.applyRemote(state, snapshot)
      if (expected && snapshot.sourceCommitSha !== expected.remoteHead) throw new AcademyError('REMOTE_CHANGED_REVIEW_REQUIRED')
      if (state.businessState === 'SYNCED') return
      if (state.businessState !== 'LOCAL_CHANGES' || await this.git.getOperationsStatus(state.workspacePath!)) throw new AcademyError('GIT_PUBLICATION_REQUIRES_RECONCILIATION')
      const authority = this.store.getGitAuthority()
      if (!authority || !state.migrationComplete) throw new AcademyError('GIT_MIGRATION_REQUIRED')
      const { profile, repositoryId, remoteUrl } = this.identity()
      if (state.autoPublish && (!this.transport.authorizationIdentity?.() || state.policyIdentity !== this.policyIdentity())) throw new AcademyError('AUTOMATION_AUTHORIZATION_STALE')
      const head = state.localHead!
      await readAcademyGitSnapshot(this.git, state.workspacePath!, { repositoryId, remoteUrl, branch: profile.branch, sourceCommitSha: head, observedAt: snapshot.observedAt })
      state.phase = 'PUSH_PENDING'; state.pendingCommit = head
      this.save(state, 'LOCAL_CHANGES')
      try { await this.transport.push(state.workspacePath!, profile.branch, 'origin', head) }
      catch (error) {
        const observed = await this.observe(state)
        if (observed.sourceCommitSha !== head) {
          const message = error instanceof Error ? error.message : String(error)
          if (/protected|GH006|GH013|pull request/i.test(message)) { state.phase = 'PUSH_PENDING'; this.save(state, 'PR_PENDING', message); return }
          throw error
        }
      }
      const observed = await this.observe(state)
      if (!await this.git.isAncestor(state.checkoutPath, head, observed.sourceCommitSha)) throw new AcademyError('PUSH_CONFIRMATION_PENDING')
      await this.applyRemote(state, observed)
      this.store.updateGitSyncState({ syncState: 'SYNCED', lastPushedCommitSha: head })
    })
  }

  async publishCandidate(input: { branch: string; expectedHead: string; confirmed: boolean }): Promise<AcademyGitStatusProjection> {
    if (input.confirmed !== true) throw new AcademyError('CANDIDATE_PUBLICATION_REVIEW_REQUIRED')
    return this.exclusive(async state => {
      const { profile, repositoryId, remoteUrl } = this.identity()
      if (!state.migrationComplete || input.branch === profile.branch) throw new AcademyError('CANDIDATE_BRANCH_REQUIRED')
      assertPublicationPaths(state.workspacePath!, [...ACADEMY_AUTHORED_PATHS, '.git'])
      await this.git.initializePublicationRepository(state.workspacePath!, remoteUrl)
      await this.git.validateBranch(state.workspacePath!, input.branch)
      if (await this.git.resolveCommit(state.workspacePath!, 'HEAD') !== input.expectedHead || await this.git.getOperationsStatus(state.workspacePath!)) throw new AcademyError('WORKSPACE_REVISION_CHANGED')
      await readAcademyGitSnapshot(this.git, state.workspacePath!, { repositoryId, remoteUrl, branch: profile.branch, sourceCommitSha: input.expectedHead, observedAt: new Date().toISOString() })
      if (!this.transport.readRemoteHead) throw new AcademyError('REMOTE_OBSERVATION_UNSUPPORTED')
      const ref = `refs/heads/${input.branch}`
      const observe = () => this.transport.readRemoteHead!(state.workspacePath!, 'origin', ref)
      if (await observe() !== input.expectedHead) {
        try { await this.transport.push(state.workspacePath!, input.branch, 'origin', input.expectedHead) }
        catch (error) { if (await observe() !== input.expectedHead) throw error }
      }
      if (await observe() !== input.expectedHead) throw new AcademyError('CANDIDATE_PUBLICATION_UNVERIFIED')
      state.candidateBranch = input.branch; state.candidateCommitSha = input.expectedHead
      this.save(state, 'PR_PENDING')
    })
  }

  async deleteDraft(input: { skillId: string; expectedVersion: number; expectedDraftCommitSha: string; confirmed: boolean }): Promise<AcademyGitStatusProjection> {
    if (input.confirmed !== true) throw new AcademyError('GIT_DELETION_REVIEW_REQUIRED')
    return this.exclusive(async state => {
      const current = this.store.get(input.skillId), root = state.workspacePath!
      if (!state.migrationComplete || current.scope !== 'GLOBAL' || current.currentVersion !== input.expectedVersion || await this.git.resolveCommit(root, 'HEAD') !== input.expectedDraftCommitSha) throw new AcademyError('GIT_DRAFT_BASE_CHANGED')
      if (await this.git.getOperationsStatus(root)) throw new AcademyError('WORKSPACE_UNCOMMITTED_RECOVERY_REQUIRED')
      const path = `skills/${current.name}`
      assertPublicationPaths(root, [path, '.git'])
      await this.git.initializePublicationRepository(root, this.identity().remoteUrl)
      await removeSkillDirectory(join(root, path))
      await this.git.stagePaths(root, [path])
      state.localHead = await this.git.commitInspectedIndex(root, `Academy: remove ${current.name} from publication`, input.expectedDraftCommitSha, await this.git.getIndexRevision(root))
      state.pendingCommit = state.localHead
      this.save(state, 'LOCAL_CHANGES')
    })
  }
  async completeMigration(expectedRemoteHead: string, reviewedCandidateHash: string, confirmed: boolean): Promise<AcademyGitStatusProjection> {
    if (!confirmed) throw new AcademyError('MIGRATION_REVIEW_REQUIRED')
    return this.exclusive(async state => {
      const snapshot = await this.observe(state)
      await this.preserveMigration(state, snapshot)
      if (snapshot.sourceCommitSha !== expectedRemoteHead || state.migrationCandidateHash !== reviewedCandidateHash) throw new AcademyError('MIGRATION_REVIEW_STALE')
      await this.applyRemote(state, snapshot, reviewedCandidateHash)
    })
  }
  private async mergeWorkspace(state: AcademyGitPublicationState, snapshot: AcademyGitSourceSnapshot): Promise<void> {
    try {
      const root = state.workspacePath!, head = await this.git.resolveCommit(root, 'HEAD')
      await this.git.beginPublicationMerge(root, snapshot.sourceCommitSha)
      state.localHead = await this.git.commitInspectedIndex(root, 'Academy: integrate independent remote changes', head, await this.git.getIndexRevision(root), { firstParent: snapshot.sourceCommitSha })
    }
    catch { state.phase = 'CONFLICT'; this.save(state, 'CONFLICT', 'GIT_WORKSPACE_CONFLICT_REVIEW_REQUIRED'); return }
    await this.classify(state, snapshot)
  }
  async resolveManagedConflict(expectedRemoteHead: string | null, expectedDesiredTree: string): Promise<AcademyGitStatusProjection> {
    return this.exclusive(async state => {
      const snapshot = await this.observe(state)
      if (snapshot.sourceCommitSha !== expectedRemoteHead || state.localHead !== expectedDesiredTree) throw new AcademyError('CONFLICT_STATE_CHANGED')
      await this.ensureWorkspace(state, snapshot)
      if (await this.git.getGitOperation(state.workspacePath!) === 'MERGE') return
      if (await this.git.getOperationsStatus(state.workspacePath!)) throw new AcademyError('WORKSPACE_UNCOMMITTED_RECOVERY_REQUIRED')
      try { await this.git.beginPublicationMerge(state.workspacePath!, snapshot.sourceCommitSha) }
      catch (error) { if (await this.git.getGitOperation(state.workspacePath!) !== 'MERGE') throw error }
      state.conflictPaths = await this.git.unmergedPaths(state.workspacePath!)
      state.phase = 'CONFLICT'; this.save(state, 'CONFLICT')
    })
  }

  async reviewGitConflict(path: string): Promise<AcademyGitConflictReview> {
    assertSourcePath(path)
    const state = this.state(), root = state.workspacePath!
    if (!state.conflictPaths.includes(path)) throw new AcademyError('GIT_CONFLICT_NOT_FOUND')
    assertPublicationPaths(root, [path, '.git'])
    const revision = await this.git.getConflictRevision(root, path)
    if (!revision) throw new AcademyError('CONFLICT_STATE_CHANGED')
    const sides = await Promise.all(['BASE', 'OURS', 'THEIRS', 'WORKTREE'].map(side => this.git.readConflictSide(root, path, side as 'BASE' | 'OURS' | 'THEIRS' | 'WORKTREE')))
    const texts = sides.map(bytes => {
      if (bytes && (bytes.length > 1024 * 1024 || bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes))) throw new AcademyError('GIT_CONFLICT_REQUIRES_EXTERNAL_REVIEW')
      return bytes?.toString('utf8') ?? null
    })
    return { path, revision, head: await this.git.resolveCommit(root, 'HEAD'), base: texts[0], local: texts[1], remote: texts[2], working: texts[3] }
  }

  async resolveGitConflict(input: { path: string; head: string; revision: string; content: string; confirmed: boolean }): Promise<AcademyGitStatusProjection> {
    if (input.confirmed !== true || typeof input.content !== 'string' || input.content.includes('\0') || /^(?:<{7}|={7}|>{7})(?: |$)/m.test(input.content)) throw new AcademyError('GIT_RESOLUTION_REVIEW_REQUIRED')
    return this.exclusive(async state => {
      assertSourcePath(input.path)
      if (!state.conflictPaths.includes(input.path) || !input.path.startsWith('skills/')) throw new AcademyError('GIT_CONFLICT_REQUIRES_EXTERNAL_REVIEW')
      const root = state.workspacePath!
      assertPublicationPaths(root, [input.path, '.git'])
      await this.git.initializePublicationRepository(root, this.identity().remoteUrl)
      const [, name, ...parts] = input.path.split('/')
      const localSnapshot = await readAcademyGitSnapshot(this.git, root, { repositoryId: this.identity().repositoryId, remoteUrl: this.identity().remoteUrl, branch: this.identity().profile.branch, sourceCommitSha: input.head, observedAt: new Date().toISOString() })
      const previous = localSnapshot.skills.find(skill => skill.name === name)
      if (!previous) throw new AcademyError('GIT_CONFLICT_REQUIRES_EXTERNAL_REVIEW')
      const candidate = structuredClone(previous.package)
      if (parts.join('/') === 'SKILL.md') candidate.skillMd = input.content
      else candidate.artifacts[parts.join('/')] = input.content
      validateGitSnapshot([{ name, skillId: name, version: 0, package: candidate, packageHash: hashAcademyPackage(candidate) }])
      await this.git.resolveConflict(root, input.path, 'CONTENT', input.head, input.revision, input.content)
      state.conflictPaths = await this.git.unmergedPaths(root)
      if (state.conflictPaths.length) { this.save(state, 'CONFLICT'); return }
      for (const name of new Set([...localSnapshot.skills.map(skill => skill.name), ...this.store.getGitSnapshot(this.identity().repositoryId, state.remoteHead!)!.skills.map(skill => skill.name)])) {
        if (!existsSync(join(root, 'skills', name))) continue
        const pkg = await readSkillDirectory(join(root, 'skills', name))
        validateGitSnapshot([{ name, skillId: name, version: 0, package: pkg, packageHash: hashAcademyPackage(pkg) }])
      }
      state.localHead = await this.git.commitInspectedIndex(root, 'Academy: reconcile reviewed Git conflicts', input.head, await this.git.getIndexRevision(root), { firstParent: state.remoteHead! })
      state.phase = 'CONFIRMED'; state.pendingCommit = state.localHead
      this.save(state, 'LOCAL_CHANGES')
    })
  }
  async recoverOnStartup(): Promise<void> {
    if (this.store.getGitProfile()) {
      const state = this.state()
      this.save(state, 'UNKNOWN')
      if (state.autoUpdate) await this.syncNow()
    }
  }
  async configureAutomation(input: { autoPublish: boolean; autoUpdate: boolean; confirmed: boolean; expectedRepositoryId: string; expectedBranch: string }): Promise<AcademyGitStatusProjection> {
    const { profile } = this.identity()
    if (input.confirmed !== true || typeof input.autoPublish !== 'boolean' || typeof input.autoUpdate !== 'boolean' || input.expectedRepositoryId !== profile.githubRepositoryId || input.expectedBranch !== profile.branch) throw new AcademyError('AUTOMATION_AUTHORIZATION_REQUIRED')
    const result = await this.exclusive(async state => {
      if (input.autoPublish && !this.transport.authorizationIdentity?.()) throw new AcademyError('AUTOMATION_CREDENTIAL_IDENTITY_REQUIRED')
      state.autoPublish = input.autoPublish; state.autoUpdate = input.autoUpdate
      state.policyIdentity = this.policyIdentity()
      this.save(state, state.businessState ?? 'UNKNOWN')
    })
    return result
  }
  async refreshAutomatically(): Promise<void> { if (!this.closing && !this.active && this.store.getGitProfile() && this.state().autoUpdate) await this.syncNow() }
  async close(): Promise<void> { this.closing = true; if (this.active) await this.active }
}
