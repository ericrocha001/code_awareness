import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import type { AcademyOpenAiDeletionSemantics, AcademyOpenAiPluginProfile, AcademyOpenAiPublicationState, AcademyOpenAiRelease, AcademyOpenAiSnapshotEntry } from '../../../shared/types/academy-types'
import { AcademyError, hashAcademyPackage } from '../academy-package'
import { readSkillDirectory } from '../academy-filesystem'
import type { AcademyStore } from '../academy-store'
import type { AcademyPluginPackageRevisionService } from './academy-plugin-package-revision-service'
import { createDeterministicZip, readZipEntries, type ZipEntry } from './deterministic-zip'
import { buildCanonicalOpenAiSnapshot, buildOpenAiManifest, calculateOpenAiDelta, canonicalJson, hashOpenAiSnapshot, sha256 } from './openai-plugin-model'
import { validateOpenAiPluginPackage } from './openai-plugin-validator'
import type { AcademyGitBuildReceipt, AcademyGitBuildSource } from '../../../shared/types/academy-git-source-types'
import type { AcademyBuildProjection, AcademyGitSnapshotHeader, AcademyPublicationOperation } from '../../../shared/types/academy-publication-types'
import { AcademyPluginExecutor, type AcademyPluginTaskResult } from './academy-plugin-executor'

export class OpenAiPluginPublicationService {
  readonly storageRoot: string
  private readonly executor: AcademyPluginExecutor
  private readonly inventoryFlights = new Map<string, Promise<AcademyBuildProjection>>()
  private readonly physicalFlights = new Map<string, Promise<AcademyPluginTaskResult>>()
  private operation: AcademyPublicationOperation | null = null
  private changed: () => void = () => {}

  constructor(
    private readonly store: AcademyStore,
    private readonly packageRevisions: AcademyPluginPackageRevisionService,
    academyDatabasePath: string,
    private readonly downloadsPath?: string,
    workerPath?: string
  ) {
    this.storageRoot = join(dirname(academyDatabasePath), 'openai-plugin')
    this.executor = new AcademyPluginExecutor(workerPath)
  }

  onOperationChange(listener: () => void): void { this.changed = listener }

  async drain(): Promise<void> {
    while (this.inventoryFlights.size || this.physicalFlights.size) await Promise.allSettled([...this.inventoryFlights.values(), ...this.physicalFlights.values()])
  }

  beginSourceCheck(): string {
    const requestId = randomUUID()
    this.operation = { requestId, phase: 'VERIFYING_SOURCE', phases: {} }; this.changed()
    return requestId
  }

  sourceCheckFailed(requestId: string, error: unknown): void {
    if (this.operation?.requestId !== requestId) return
    this.operation.phase = 'ERROR'; this.operation.error = error instanceof Error ? error.message : String(error); this.changed()
  }

  async bootstrapFromPluginDirectory(pluginRoot: string, publishedVersion?: string): Promise<AcademyOpenAiPluginProfile> {
    const existing = this.store.getOpenAiPluginProfile()
    if (existing && this.store.listOpenAiReleases().some((release) => release.baseline)) return existing
    const root = resolve(pluginRoot)
    const manifestPath = join(root, 'plugin.json')
    if (!existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink()) throw new AcademyError('OPENAI_PLUGIN_MANIFEST_MISSING')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as any
    if (manifest.name !== 'academy-skills') throw new AcademyError('OPENAI_PLUGIN_IDENTITY_IMMUTABLE')
    const version = publishedVersion ?? manifest.version
    if (typeof version !== 'string' || !version) throw new AcademyError('OPENAI_PLUGIN_PUBLISHED_VERSION_REQUIRED')
    const openAiInterface = manifest.extensions?.['com.openai']?.interface
    if (!openAiInterface || typeof openAiInterface.displayName !== 'string') throw new AcademyError('OPENAI_PLUGIN_INVALID_INTERFACE')
    let logoPath: string | null = null
    const logoReference = openAiInterface.logo ?? openAiInterface.composerIcon
    if (logoReference) {
      if (typeof logoReference !== 'string' || !logoReference.startsWith('./') || logoReference.includes('..')) throw new AcademyError('OPENAI_PLUGIN_INVALID_LOGO_PATH')
      const source = resolve(root, logoReference.slice(2))
      if (!source.startsWith(`${root}${sep}`) || !existsSync(source) || lstatSync(source).isSymbolicLink() || !lstatSync(source).isFile()) throw new AcademyError('OPENAI_PLUGIN_LOGO_MISSING')
      if (extname(source).toLowerCase() !== '.png') throw new AcademyError('OPENAI_PLUGIN_LOGO_UNSUPPORTED')
      logoPath = join(this.storageRoot, 'profile', 'assets', 'logo.png')
      mkdirSync(dirname(logoPath), { recursive: true })
      copyFileSync(source, logoPath)
    }
    const baselineSnapshot = await this.snapshotInstalledPlugin(root)
    const profile = existing ?? this.store.createOpenAiPluginProfile({
      name: 'academy-skills', displayName: openAiInterface.displayName,
      description: manifest.description, author: manifest.author,
      openAiInterface, logoPath, publishedVersion: version,
      deletionSemantics: 'UNKNOWN', deletionSemanticsEvidence: null
    })
    const now = new Date().toISOString()
    this.store.insertOpenAiRelease({
      id: randomUUID(), pluginVersion: version, createdAt: now, referenceReleaseId: null,
      snapshot: baselineSnapshot, snapshotHash: hashOpenAiSnapshot(baselineSnapshot),
      delta: calculateOpenAiDelta([], baselineSnapshot), manifest, artifactPath: null, artifactHash: null,
      status: 'UPLOADED_UNVERIFIED', blockedReason: null, baseline: true,
      uploadConfirmation: null, verificationEvidence: 'Administrative baseline imported from the existing plugin package.'
    })
    return profile
  }

  async bootstrapInstalledPlugin(publishedVersion?: string): Promise<AcademyOpenAiPluginProfile> {
    const root = findInstalledAcademyPluginRoot()
    if (!root) throw new AcademyError('OPENAI_PLUGIN_EXISTING_PACKAGE_NOT_FOUND')
    return this.bootstrapFromPluginDirectory(root, publishedVersion)
  }

  state(): AcademyOpenAiPublicationState {
    this.refreshDrift()
    const profile = this.store.getOpenAiPluginProfile()
    const releases = this.store.listOpenAiReleases()
    const nonBaseline = releases.filter((release) => !release.baseline)
    const latestPrepared = nonBaseline[0] ?? null
    const latestUploaded = releases.find((release) => ['UPLOADED_UNVERIFIED', 'VERIFIED', 'SUPERSEDED'].includes(release.status)) ?? null
    const selectedRelease = latestPrepared ?? releases[0] ?? null
    const header = this.currentHeader()
    const projection = header ? this.cachedProjection(header) : null
    const versionPreflight = this.store.usesGitFirst() ? this.packageRevisions.preflight(header, projection) : undefined
    const canonical = header?.snapshot ?? (profile && !this.store.usesGitFirst() ? buildCanonicalOpenAiSnapshot(this.store) : [])
    let sourceError: string | null = null
    let canonicalSnapshotHash: string | null = null
    let currentPackageRevision: AcademyOpenAiPublicationState['currentPackageRevision'] = null
    try {
      if (versionPreflight) this.packageRevisions.assertPreflight(versionPreflight)
      canonicalSnapshotHash = profile ? this.currentContentHash() : null
      currentPackageRevision = profile ? header && projection ? this.packageRevisions.resolveProjection(header, projection) : this.packageRevisions.resolveCurrent() : null
    } catch (error) { sourceError = error instanceof AcademyError ? error.code : 'GIT_SOURCE_UNAVAILABLE' }
    const hostedStatus = !profile
      ? 'UNCONFIGURED'
      : profile.publishedVersion === (currentPackageRevision?.version ?? header?.manifest?.version ?? profile.publishedVersion) && versionPreflight?.outcome !== 'VERSION_ALREADY_USED_FOR_OTHER_CONTENT' ? 'CURRENT' : 'HOSTED_UPDATE_AVAILABLE'
    return {
      profile, latestPrepared, latestUploaded, selectedRelease, sourceError, versionPreflight, operation: this.operation,
      publicSkillCount: canonical.length, canonicalSnapshotHash,
      drifted: Boolean(selectedRelease && canonicalSnapshotHash !== selectedRelease.snapshotHash),
      currentPackageRevision,
      hostedStatus
    }
  }

  getRelease(id: string): AcademyOpenAiRelease { this.refreshDrift(); return this.store.getOpenAiRelease(id) }
  listReleases(): AcademyOpenAiRelease[] { this.refreshDrift(); return this.store.listOpenAiReleases() }

  prepareRelease(): AcademyOpenAiRelease {
    if (this.store.usesGitFirst()) throw new AcademyError('GIT_SOURCE_SNAPSHOT_REQUIRED')
    const profile = this.store.getOpenAiPluginProfile()
    if (!profile) throw new AcademyError('OPENAI_PLUGIN_PROFILE_MISSING')
    this.refreshDrift()
    const snapshot = buildCanonicalOpenAiSnapshot(this.store)
    const snapshotHash = hashOpenAiSnapshot(snapshot)
    const packageRevision = this.packageRevisions.resolveCurrent()
    const releases = this.store.listOpenAiReleases()
    const existing = releases.find((release) => !release.baseline && release.pluginVersion === packageRevision.version)
    if (existing && existing.status !== 'BLOCKED') return existing
    const publishedReference = releases.find((release) => release.baseline || ['UPLOADED_UNVERIFIED', 'VERIFIED', 'SUPERSEDED'].includes(release.status)) ?? null
    if (!publishedReference) throw new AcademyError('OPENAI_PLUGIN_BASELINE_MISSING')
    const delta = packageRevision.delta
    const pluginVersion = packageRevision.version
    const releaseId = existing?.id ?? randomUUID()
    const createdAt = existing?.createdAt ?? new Date().toISOString()
    const manifest = buildOpenAiManifest(profile, pluginVersion)
    if (delta.destructive && profile.deletionSemantics !== 'PROVEN_REPLACE') {
      if (existing) return existing
      return this.store.insertOpenAiRelease({
        id: releaseId, pluginVersion, createdAt, referenceReleaseId: publishedReference.id,
        snapshot, snapshotHash, delta, manifest, artifactPath: null, artifactHash: null,
        status: 'BLOCKED', blockedReason: `DESTRUCTIVE_DELTA_${profile.deletionSemantics}`,
        baseline: false, uploadConfirmation: null, verificationEvidence: null
      })
    }
    const entries = this.buildPackageEntries(profile, snapshot, manifest)
    validateOpenAiPluginPackage(entries, profile, snapshot)
    const archive = createDeterministicZip(entries)
    validateOpenAiPluginPackage(readZipEntries(archive), profile, snapshot)
    const artifactHash = sha256(archive)
    const releaseDirectory = join(this.storageRoot, 'releases', releaseId)
    mkdirSync(releaseDirectory, { recursive: true })
    const artifactPath = join(releaseDirectory, `academy-skills-${pluginVersion}.zip`)
    writeFileSync(artifactPath, archive)
    this.copyToDownloads(artifactPath, pluginVersion, artifactHash)
    const currentHash = hashOpenAiSnapshot(buildCanonicalOpenAiSnapshot(this.store))
    if (existing) {
      return this.store.materializeBlockedOpenAiRelease(existing.id, {
        manifest, artifactPath, artifactHash,
        status: currentHash === snapshotHash ? 'READY_TO_UPLOAD' : 'STALE'
      })
    }
    return this.store.insertOpenAiRelease({
      id: releaseId, pluginVersion, createdAt, referenceReleaseId: publishedReference.id,
      snapshot, snapshotHash, delta, manifest, artifactPath, artifactHash,
      status: currentHash === snapshotHash ? 'READY_TO_UPLOAD' : 'STALE', blockedReason: null,
      baseline: false, uploadConfirmation: null, verificationEvidence: null
    })
  }

  async prepareGitRelease(source: AcademyGitBuildSource, requestId = this.beginSourceCheck(), gitMs = 0): Promise<AcademyOpenAiRelease> {
    const started = performance.now()
    const header = this.store.getGitSnapshotHeader(source.snapshot.repositoryId, source.snapshot.sourceCommitSha)
    const update = (phase: AcademyPublicationOperation['phase']) => {
      if (this.operation?.requestId !== requestId) return
      this.operation.phase = phase; this.operation.sourceCommitSha = header?.sourceCommitSha; this.changed()
    }
    const timings: Record<string, number> = { gitConfirmationMs: gitMs }
    const timed = (phase: string, duration: number) => { timings[phase] = duration }
    update('PREFLIGHT')
    let projection = header ? this.cachedProjection(header) : null
    this.packageRevisions.assertPreflight(this.packageRevisions.preflight(header, projection))
    if (!header) throw new AcademyError('GIT_SOURCE_SNAPSHOT_NOT_VERIFIED')
    const profile = this.store.getOpenAiPluginProfile()
    if (!profile) throw new AcademyError('OPENAI_PLUGIN_PROFILE_MISSING')
    const snapshotJson = this.store.getGitSnapshotPayload(header.repositoryId, header.sourceCommitSha)
    if (!snapshotJson) throw new AcademyError('GIT_SOURCE_SNAPSHOT_NOT_VERIFIED')
    timed('sqliteAndVersionMs', performance.now() - started)
    if (!projection) {
      const key = header.repositoryId + ':' + header.sourceCommitSha
      let pending = this.inventoryFlights.get(key)
      if (!pending) {
        pending = this.executor.run({ kind: 'inventory', snapshotJson, suppliedSnapshot: source.snapshot, profile }, timed).then(result => {
          const input = result.projection!
          this.packageRevisions.assertPreflight(this.packageRevisions.preflight(header, input))
          this.store.saveGitBuildProjection(input)
          return input
        })
        this.inventoryFlights.set(key, pending)
        void pending.then(() => this.inventoryFlights.delete(key), () => this.inventoryFlights.delete(key))
      }
      projection = await pending
    }
    this.packageRevisions.assertPreflight(this.packageRevisions.preflight(header, projection))
    const revision = this.packageRevisions.resolveProjection(header, projection)
    const existing = this.store.findOpenAiReleaseVersion(projection.pluginVersion)
    const reference = this.store.listOpenAiReleases().find(release => release.baseline || ['UPLOADED_UNVERIFIED', 'VERIFIED', 'SUPERSEDED'].includes(release.status))
    if (!reference) throw new AcademyError('OPENAI_PLUGIN_BASELINE_MISSING')
    const releaseId = existing?.id ?? sha256('GIT_RELEASE:' + projection.entriesFingerprint)
    const artifactPath = existing?.artifactPath ?? join(this.storageRoot, 'releases', releaseId, 'academy-skills-' + projection.pluginVersion + '.zip')
    const physicalKey = header.repositoryId + ':' + projection.entriesFingerprint
    update('PREPARING_PACKAGE')
    let physical = this.physicalFlights.get(physicalKey)
    if (!physical) {
      physical = this.executor.run({ kind: existing?.artifactHash && existsSync(artifactPath) ? 'verify' : 'build',
        snapshotJson, suppliedSnapshot: source.snapshot, projection, profile, storageRoot: this.storageRoot, artifactPath,
        expectedZipSha: existing?.artifactHash ?? undefined, downloadsPath: this.downloadsPath }, timed)
      this.physicalFlights.set(physicalKey, physical)
      void physical.then(() => this.physicalFlights.delete(physicalKey), () => this.physicalFlights.delete(physicalKey))
    } else {
      await this.executor.run({ kind: 'source-check', snapshotJson, suppliedSnapshot: source.snapshot, profile }, timed)
    }
    const artifact = await physical
    Object.assign(timings, artifact.phases)
    this.packageRevisions.assertPreflight(this.packageRevisions.preflight(header, projection))
    let currentHash: string | null = null
    try { currentHash = this.currentContentHash() } catch { }
    const release: AcademyOpenAiRelease = {
      id: releaseId, pluginVersion: projection.pluginVersion, createdAt: existing?.createdAt ?? new Date().toISOString(),
      referenceReleaseId: existing?.referenceReleaseId ?? reference.id, snapshot: projection.snapshot, snapshotHash: projection.entriesFingerprint,
      delta: calculateOpenAiDelta(reference.snapshot, projection.snapshot), manifest: projection.manifest,
      artifactPath: artifact.artifactPath!, artifactHash: artifact.artifactHash!,
      status: currentHash === projection.entriesFingerprint ? 'READY_TO_UPLOAD' : 'STALE',
      blockedReason: null, baseline: false, uploadConfirmation: null, verificationEvidence: null
    }
    const buildKey = sha256(canonicalJson({ buildSchema: 1, normalizationSchema: 1, sourceRepositoryId: header.repositoryId,
      sourceCommitSha: header.sourceCommitSha, pluginVersion: projection.pluginVersion, entriesFingerprint: projection.entriesFingerprint, compression: 'deflate-raw:9' }))
    const receipt: AcademyGitBuildReceipt = { id: '', releaseId, buildSchema: 1, buildKey,
      sourceRepositoryId: header.repositoryId, branch: header.branch, sourceCommitSha: header.sourceCommitSha, managedTreeHash: header.managedTreeHash,
      manifestFingerprint: projection.manifestFingerprint, assetFingerprint: projection.assetFingerprint, entriesFingerprint: projection.entriesFingerprint,
      pluginVersion: projection.pluginVersion, zipSha256: artifact.artifactHash!, remoteConfirmation: source.remoteConfirmation, confirmedAt: source.confirmedAt }
    receipt.id = sha256(canonicalJson(receipt))
    const result = this.store.persistGitBuild(release, { ...receipt, phases: timings }, revision)
    timed('responseMs', performance.now() - started)
    if (this.operation?.requestId === requestId) this.operation.phases = timings
    update('READY')
    console.info('[Academy package]', JSON.stringify({ requestId, buildKey, sourceCommitSha: header.sourceCommitSha, reused: artifact.reused, phases: timings }))
    return result
  }
  confirmUpload(releaseId: string, artifactHash: string): AcademyOpenAiRelease {
    this.refreshDrift()
    const release = this.store.getOpenAiRelease(releaseId)
    if (this.store.usesGitFirst()) {
      let current: string
      try { current = this.currentContentHash() } catch { throw new AcademyError('OPENAI_RELEASE_SOURCE_PREFLIGHT_REQUIRED') }
      if (current !== release.snapshotHash) throw new AcademyError('OPENAI_RELEASE_NOT_CONFIRMABLE')
    }
    const latestPrepared = this.store.listOpenAiReleases().find((item) => !item.baseline)
    if (latestPrepared?.id !== release.id) throw new AcademyError('OPENAI_RELEASE_NOT_SELECTED')
    if (release.status !== 'READY_TO_UPLOAD') throw new AcademyError('OPENAI_RELEASE_NOT_CONFIRMABLE')
    if (!release.artifactHash || release.artifactHash !== artifactHash) throw new AcademyError('OPENAI_RELEASE_HASH_MISMATCH')
    const confirmation = { releaseId, pluginVersion: release.pluginVersion, artifactHash, confirmedAt: new Date().toISOString(), method: 'MANUAL_UPLOAD' as const }
    this.store.supersedeOpenAiPublishedReleases(releaseId)
    const confirmed = this.store.transitionOpenAiRelease(releaseId, ['READY_TO_UPLOAD'], 'UPLOADED_UNVERIFIED', { uploadConfirmation: confirmation })
    this.store.setOpenAiPublishedVersion(release.pluginVersion)
    return confirmed
  }

  verifyRelease(releaseId: string, evidence: string): AcademyOpenAiRelease {
    if (!evidence.trim()) throw new AcademyError('OPENAI_RELEASE_VERIFICATION_EVIDENCE_REQUIRED')
    return this.store.transitionOpenAiRelease(releaseId, ['UPLOADED_UNVERIFIED'], 'VERIFIED', { verificationEvidence: evidence })
  }

  recordDeletionSemantics(value: Exclude<AcademyOpenAiDeletionSemantics, 'UNKNOWN'>, evidence: string): AcademyOpenAiPluginProfile {
    if (!evidence.trim()) throw new AcademyError('OPENAI_DELETION_EVIDENCE_REQUIRED')
    return this.store.setOpenAiDeletionSemantics(value, evidence)
  }

  refreshDrift(): void {
    if (!this.store.getOpenAiPluginProfile()) return
    let hash: string | null = null
    try { hash = this.currentContentHash() } catch { /* An unavailable source cannot establish freshness. */ }
    if (hash) this.store.markOpenAiReadyReleasesStaleExcept(hash)
  }

  private currentContentHash(): string {
    const authority = this.store.getGitAuthority()
    if (authority) {
      const header = this.store.getGitSnapshotHeader(authority.repositoryId, authority.processedCommitSha)
      const projection = header ? this.cachedProjection(header) : null
      if (!projection) throw new AcademyError('GIT_BUILD_PROJECTION_PENDING')
      return projection.entriesFingerprint
    }
    if (this.store.usesGitFirst()) throw new AcademyError('GIT_MIGRATION_REQUIRED')
    return hashOpenAiSnapshot(buildCanonicalOpenAiSnapshot(this.store))
  }

  private currentHeader(): AcademyGitSnapshotHeader | null {
    const authority = this.store.getGitAuthority()
    return authority ? this.store.getGitSnapshotHeader(authority.repositoryId, authority.processedCommitSha) : null
  }

  private cachedProjection(header: AcademyGitSnapshotHeader): AcademyBuildProjection | null {
    if (!header.manifest) return null
    const manifestFingerprint = sha256(canonicalJson(header.manifest))
    const cached = this.store.getGitBuildProjection(header.repositoryId, header.sourceCommitSha)
    if (cached?.schema === 1 && cached.normalizationSchema === 1 && cached.sourceRepositoryId === header.repositoryId && cached.sourceCommitSha === header.sourceCommitSha && cached.managedTreeHash === header.managedTreeHash && cached.manifestFingerprint === manifestFingerprint) return cached
    const receipt = this.store.findGitBuildReceipt(header.repositoryId, header.sourceCommitSha)
    if (!receipt || receipt.managedTreeHash !== header.managedTreeHash || receipt.manifestFingerprint !== manifestFingerprint || receipt.pluginVersion !== header.manifest.version) return null
    return { schema: 1, normalizationSchema: 1, sourceRepositoryId: header.repositoryId, sourceCommitSha: header.sourceCommitSha,
      managedTreeHash: header.managedTreeHash, manifest: header.manifest, pluginVersion: receipt.pluginVersion,
      manifestFingerprint, assetFingerprint: receipt.assetFingerprint, entriesFingerprint: receipt.entriesFingerprint,
      snapshot: header.snapshot, entryCount: header.entryCount }
  }

  private buildPackageEntries(profile: AcademyOpenAiPluginProfile, snapshot: AcademyOpenAiSnapshotEntry[], manifest: Record<string, unknown>, gitEntries?: ZipEntry[]): ZipEntry[] {
    if (gitEntries) return gitEntries
    const entries: ZipEntry[] = [{ path: `${profile.name}/plugin.json`, data: Buffer.from(`${canonicalJson(manifest)}\n`) }]
    for (const item of [...snapshot].sort((left, right) => left.name.localeCompare(right.name))) {
      const skill = this.store.get(item.skillId)
      if (skill.currentVersion !== item.academyVersion || skill.current.packageHash !== item.packageHash || skill.name !== item.name) throw new AcademyError('OPENAI_SNAPSHOT_CHANGED_DURING_PACKAGING')
      entries.push({ path: `${profile.name}/skills/${item.name}/SKILL.md`, data: Buffer.from(skill.current.package.skillMd) })
      for (const [path, content] of Object.entries(skill.current.package.artifacts).sort(([left], [right]) => left.localeCompare(right))) {
        entries.push({ path: `${profile.name}/skills/${item.name}/${path}`, data: Buffer.from(content) })
      }
    }
    if (profile.logoPath) {
      const stat = lstatSync(profile.logoPath)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new AcademyError('OPENAI_PLUGIN_LOGO_INVALID')
      entries.push({ path: `${profile.name}/assets/logo.png`, data: readFileSync(profile.logoPath) })
    }
    return entries
  }

  private copyToDownloads(artifactPath: string, pluginVersion: string, artifactHash: string): void {
    if (!this.downloadsPath) return
    mkdirSync(this.downloadsPath, { recursive: true })
    const downloadArtifactPath = join(this.downloadsPath, `academy-skills-${pluginVersion}.zip`)
    copyFileSync(artifactPath, downloadArtifactPath)
    if (sha256(readFileSync(downloadArtifactPath)) !== artifactHash) throw new AcademyError('OPENAI_PLUGIN_DOWNLOAD_COPY_MISMATCH')
  }

  private async snapshotInstalledPlugin(root: string): Promise<AcademyOpenAiSnapshotEntry[]> {
    const skillsRoot = join(root, 'skills')
    if (!existsSync(skillsRoot)) throw new AcademyError('OPENAI_PLUGIN_SKILLS_MISSING')
    const canonicalByName = new Map(this.store.list().map((skill) => [skill.name, skill]))
    const snapshot: AcademyOpenAiSnapshotEntry[] = []
    for (const name of readdirSync(skillsRoot).sort()) {
      const directory = join(skillsRoot, name)
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new AcademyError('OPENAI_PLUGIN_BASELINE_INVALID_SKILL', name)
      if (!existsSync(join(directory, 'SKILL.md'))) continue
      const skill = canonicalByName.get(name)
      if (!skill) throw new AcademyError('OPENAI_PLUGIN_BASELINE_SKILL_NOT_CANONICAL', name)
      const pkg = await readSkillDirectory(directory)
      snapshot.push({ skillId: skill.id, name, academyVersion: skill.currentVersion, packageHash: hashAcademyPackage(pkg) })
    }
    return snapshot.sort((left, right) => left.skillId.localeCompare(right.skillId))
  }
}

export function findInstalledAcademyPluginRoot(): string | null {
  const explicit = process.env.ACADEMY_OPENAI_PLUGIN_ROOT
  if (explicit && existsSync(join(explicit, 'plugin.json'))) return resolve(explicit)
  const base = join(homedir(), '.codex', 'plugins', 'cache', 'created-by-me-remote', 'academy-skills')
  if (!existsSync(base)) return null
  const versions = readdirSync(base).filter((entry) => /^\d+\.\d+\.\d+$/.test(entry) && existsSync(join(base, entry, 'plugin.json')))
    .sort((left, right) => compareSemver(right, left))
  return versions[0] ? join(base, versions[0]) : null
}

function compareSemver(left: string, right: string): number {
  const a = left.split('.').map(Number); const b = right.split('.').map(Number)
  return (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2])
}
