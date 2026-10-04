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

export class OpenAiPluginPublicationService {
  readonly storageRoot: string

  constructor(
    private readonly store: AcademyStore,
    private readonly packageRevisions: AcademyPluginPackageRevisionService,
    academyDatabasePath: string,
    private readonly downloadsPath?: string
  ) {
    this.storageRoot = join(dirname(academyDatabasePath), 'openai-plugin')
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
    const canonical = profile ? buildCanonicalOpenAiSnapshot(this.store) : []
    const canonicalSnapshotHash = profile ? hashOpenAiSnapshot(canonical) : null
    const currentPackageRevision = profile ? this.packageRevisions.resolveCurrent() : null
    const hostedStatus = !profile || !currentPackageRevision
      ? 'UNCONFIGURED'
      : profile.publishedVersion === currentPackageRevision.version ? 'CURRENT' : 'HOSTED_UPDATE_AVAILABLE'
    return {
      profile, latestPrepared, latestUploaded, selectedRelease,
      publicSkillCount: canonical.length, canonicalSnapshotHash,
      drifted: Boolean(selectedRelease && canonicalSnapshotHash !== selectedRelease.snapshotHash),
      currentPackageRevision,
      hostedStatus
    }
  }

  getRelease(id: string): AcademyOpenAiRelease { this.refreshDrift(); return this.store.getOpenAiRelease(id) }
  listReleases(): AcademyOpenAiRelease[] { this.refreshDrift(); return this.store.listOpenAiReleases() }

  prepareRelease(): AcademyOpenAiRelease {
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

  confirmUpload(releaseId: string, artifactHash: string): AcademyOpenAiRelease {
    this.refreshDrift()
    const release = this.store.getOpenAiRelease(releaseId)
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
    this.store.markOpenAiReadyReleasesStaleExcept(hashOpenAiSnapshot(buildCanonicalOpenAiSnapshot(this.store)))
  }

  private buildPackageEntries(profile: AcademyOpenAiPluginProfile, snapshot: AcademyOpenAiSnapshotEntry[], manifest: Record<string, unknown>): ZipEntry[] {
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
