import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import type {
  AcademyOpenAiPluginProfile,
  AcademyOpenAiReleaseDelta,
  AcademyOpenAiSnapshotEntry,
  AcademyPluginPackageRevision
} from '../../../shared/types/academy-types'
import { AcademyError } from '../academy-package'
import type { AcademyStore } from '../academy-store'
import type { AcademyBuildProjection, AcademyGitSnapshotHeader, AcademyVersionPreflight } from '../../../shared/types/academy-publication-types'
import {
  buildCanonicalOpenAiSnapshot,
  buildOpenAiManifest,
  calculateOpenAiDelta,
  canonicalJson,
  hashOpenAiSnapshot,
  sha256
} from './openai-plugin-model'

const EMPTY_ASSET_HASH = sha256('NO_ASSET')

export class AcademyPluginPackageRevisionService {
  constructor(private readonly store: AcademyStore) {}

  bootstrapBaseline(): AcademyPluginPackageRevision {
    if (this.store.usesGitFirst()) return this.resolveCurrent()
    const profile = this.requireProfile()
    const releases = this.store.listOpenAiReleases()
    const baseline = releases.find((release) => release.pluginVersion === profile.publishedVersion)
      ?? releases.find((release) => release.baseline)
    const snapshot = baseline?.snapshot ?? buildCanonicalOpenAiSnapshot(this.store)
    const manifest = baseline?.manifest ?? buildOpenAiManifest(profile, profile.publishedVersion)
    const input = {
      version: baseline?.pluginVersion ?? profile.publishedVersion,
      profile,
      snapshot,
      manifest,
      delta: baseline?.delta ?? calculateOpenAiDelta([], snapshot)
    }
    const fingerprints = this.fingerprints(profile, snapshot, manifest)
    const existing = this.store.getCurrentPluginPackageRevision()
    if (!existing) return this.persistRevision(input)
    if (compareSemver(existing.version, input.version) > 0) return existing
    if (existing.version === input.version && existing.contentFingerprint === fingerprints.contentFingerprint) return existing

    const repaired: AcademyPluginPackageRevision = {
      id: randomUUID(),
      version: input.version,
      ...fingerprints,
      delta: input.delta,
      createdAt: new Date().toISOString()
    }
    return this.store.replaceCurrentPluginPackageRevision(existing.version, repaired, snapshot)
  }

  resolveCurrent(): AcademyPluginPackageRevision {
    const authority = this.store.getGitAuthority()
    if (authority) {
      const header = this.store.getGitSnapshotHeader(authority.repositoryId, authority.processedCommitSha)
      const projection = this.store.getGitBuildProjection(authority.repositoryId, authority.processedCommitSha)
      const preflight = this.preflight(header, projection)
      this.assertPreflight(preflight)
      if (!header || !projection) throw new AcademyError('GIT_BUILD_PROJECTION_PENDING')
      return this.resolveProjection(header, projection)
    }
    if (this.store.usesGitFirst()) throw new AcademyError('GIT_MIGRATION_REQUIRED')
    const profile = this.requireProfile()
    if (!this.store.getCurrentPluginPackageRevision()) this.bootstrapBaseline()
    const snapshot = buildCanonicalOpenAiSnapshot(this.store)
    const manifest = buildOpenAiManifest(profile, '0.0.0')
    const fingerprints = this.fingerprints(profile, snapshot, manifest)
    const existing = this.store.getPluginPackageRevisionByFingerprint(fingerprints.contentFingerprint)
    if (existing) return existing

    const previous = this.store.getCurrentPluginPackageRevision()
    if (!previous) throw new AcademyError('ACADEMY_PACKAGE_REVISION_BASELINE_MISSING')
    const previousSnapshot = this.store.getPluginPackageRevisionSnapshot(previous.id)
    const delta = calculateOpenAiDelta(previousSnapshot, snapshot)
    const version = bumpVersion(previous.version, delta)
    return this.persistRevision({ version, profile, snapshot, manifest, delta })
  }

  suggestedVersion(header: AcademyGitSnapshotHeader, kind?: 'PATCH' | 'MINOR' | 'MAJOR'): string {
    const versions = [...this.store.knownPluginVersions(), header.manifest?.version].filter((item): item is string => typeof item === 'string')
    const highest = versions.sort(compareSemver).at(-1) ?? '0.0.0'
    const [major, minor, patch] = highest.split('.').map(Number)
    if (kind === 'MAJOR') return `${major + 1}.0.0`
    if (kind === 'MINOR') return `${major}.${minor + 1}.0`
    if (kind === 'PATCH') return `${major}.${minor}.${patch + 1}`
    const reference = this.store.listOpenAiReleases().find(release => release.baseline || ['UPLOADED_UNVERIFIED', 'VERIFIED', 'SUPERSEDED'].includes(release.status))
    return bumpVersion(highest, calculateOpenAiDelta(reference?.snapshot ?? [], header.snapshot))
  }

  preflight(header: AcademyGitSnapshotHeader | null, projection?: AcademyBuildProjection | null): AcademyVersionPreflight {
    const versions = this.store.knownPluginVersions().sort(compareSemver)
    const version = header?.manifest?.version
    const result: AcademyVersionPreflight = { outcome: 'GIT_SOURCE_NOT_VERIFIED', manifestVersion: typeof version === 'string' ? version : null,
      highestKnownVersion: versions.at(-1) ?? null, suggestedVersion: null, registeredVersion: null, sourceCommitSha: header?.sourceCommitSha ?? null,
      message: 'Confirme uma fonte Git válida antes de preparar o pacote.' }
    if (!header || header.manifest?.name !== 'academy-skills' || typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return result
    result.suggestedVersion = this.suggestedVersion(header)
    const release = this.store.findOpenAiReleaseVersion(version)
    const revision = this.store.findPluginPackageRevisionVersion(version)
    result.registeredVersion = release?.pluginVersion ?? revision?.version ?? null
    const changedSkills = release && canonicalJson(release.snapshot.map(item => ({ name: item.name, hash: item.packageHash })).sort((a, b) => a.name.localeCompare(b.name))) !== canonicalJson(header.snapshot.map(item => ({ name: item.name, hash: item.packageHash })).sort((a, b) => a.name.localeCompare(b.name)))
    const conflict = release && (!release.source || changedSkills || release.source.manifestFingerprint !== sha256(canonicalJson(header.manifest))) ||
      projection && ((release && release.source?.entriesFingerprint !== projection.entriesFingerprint) || (revision && revision.contentFingerprint !== projection.entriesFingerprint))
    if (conflict) return { ...result, outcome: 'VERSION_ALREADY_USED_FOR_OTHER_CONTENT', message: `O manifesto declara ${version}, mas a release ${version} já está registrada com outra origem ou conteúdo. Prepare uma nova versão do manifesto no Git (${result.suggestedVersion}). O histórico será preservado.` }
    const reference = this.store.listOpenAiReleases().find(item => item.baseline || ['UPLOADED_UNVERIFIED', 'VERIFIED', 'SUPERSEDED'].includes(item.status))
    if (reference && calculateOpenAiDelta(reference.snapshot, header.snapshot).destructive && this.requireProfile().deletionSemantics !== 'PROVEN_REPLACE') return { ...result, outcome: 'DESTRUCTIVE_DELTA_BLOCKED', message: 'A remoção de conteúdo exige comprovação explícita da substituição do pacote antes de preparar a release.' }
    if (release || revision) {
      if (projection) return { ...result, outcome: 'REUSE_SAME_SOURCE', message: `A versão ${version} pode reutilizar o pacote após conferir sua integridade.` }
      return { ...result, outcome: 'CONTENT_CHECK_REQUIRED', message: `A versão ${version} requer conferência do inventário deste commit.` }
    }
    if (versions.some(item => compareSemver(version, item) <= 0)) return { ...result, outcome: 'VERSION_NOT_PROGRESSIVE', message: `O manifesto ${version} deve avançar além da versão ${result.highestKnownVersion} já registrada.` }
    return { ...result, outcome: 'NEW_RELEASE_ALLOWED', message: `Manifesto ${version}: uma nova release pode ser preparada deste commit.` }
  }

  assertPreflight(result: AcademyVersionPreflight): void {
    const codes = { VERSION_ALREADY_USED_FOR_OTHER_CONTENT: 'VERSION_REUSE_FOR_DIFFERENT_CONTENT', VERSION_NOT_PROGRESSIVE: 'OPENAI_PLUGIN_VERSION_NOT_PROGRESSIVE', GIT_SOURCE_NOT_VERIFIED: 'GIT_SOURCE_SNAPSHOT_NOT_VERIFIED', DESTRUCTIVE_DELTA_BLOCKED: 'OPENAI_DESTRUCTIVE_DELTA_BLOCKED' }
    const code = codes[result.outcome as keyof typeof codes]
    if (code) throw new AcademyError(code, result.message, { preflight: result })
  }

  resolveProjection(header: AcademyGitSnapshotHeader, projection: AcademyBuildProjection, persist = false): AcademyPluginPackageRevision {
    this.assertPreflight(this.preflight(header, projection))
    const existing = this.store.getPluginPackageRevisionByFingerprint(projection.entriesFingerprint)
    if (existing) return existing
    const reference = this.store.listOpenAiReleases().find(item => item.baseline || ['UPLOADED_UNVERIFIED', 'VERIFIED', 'SUPERSEDED'].includes(item.status))
    if (!reference) throw new AcademyError('OPENAI_PLUGIN_BASELINE_MISSING')
    const revision: AcademyPluginPackageRevision = { id: sha256(`GIT_PACKAGE:${projection.entriesFingerprint}`), version: projection.pluginVersion,
      contentFingerprint: projection.entriesFingerprint, skillSnapshotHash: hashOpenAiSnapshot(projection.snapshot), profileFingerprint: projection.manifestFingerprint,
      assetHash: projection.assetFingerprint, delta: calculateOpenAiDelta(reference.snapshot, projection.snapshot), createdAt: header.observedAt }
    return persist ? this.store.insertPluginPackageRevision(revision, projection.snapshot) : revision
  }

  private persistRevision(input: {
    version: string
    profile: AcademyOpenAiPluginProfile
    snapshot: AcademyOpenAiSnapshotEntry[]
    manifest: Record<string, unknown>
    delta: AcademyOpenAiReleaseDelta
  }): AcademyPluginPackageRevision {
    const fingerprints = this.fingerprints(input.profile, input.snapshot, input.manifest)
    const existing = this.store.getPluginPackageRevisionByFingerprint(fingerprints.contentFingerprint)
    if (existing) return existing
    return this.store.insertPluginPackageRevision({
      id: randomUUID(),
      version: input.version,
      ...fingerprints,
      delta: input.delta,
      createdAt: new Date().toISOString()
    }, input.snapshot)
  }

  private fingerprints(
    profile: AcademyOpenAiPluginProfile,
    snapshot: AcademyOpenAiSnapshotEntry[],
    manifest: Record<string, unknown>
  ): Pick<AcademyPluginPackageRevision, 'contentFingerprint' | 'skillSnapshotHash' | 'profileFingerprint' | 'assetHash'> {
    const portableManifest = structuredClone(manifest) as Record<string, any>
    delete portableManifest.version
    const profileFingerprint = sha256(canonicalJson(portableManifest))
    const assetHash = readAssetHash(profile)
    const skillSnapshotHash = hashOpenAiSnapshot(snapshot)
    const contentFingerprint = sha256(canonicalJson({
      skills: snapshot.map((item) => ({
        stableId: item.skillId,
        name: item.name,
        version: item.academyVersion,
        packageHash: item.packageHash
      })),
      metadata: portableManifest,
      assetHash
    }))
    return { contentFingerprint, skillSnapshotHash, profileFingerprint, assetHash }
  }

  private requireProfile(): AcademyOpenAiPluginProfile {
    const profile = this.store.getOpenAiPluginProfile()
    if (!profile) throw new AcademyError('OPENAI_PLUGIN_PROFILE_MISSING')
    return profile
  }
}

function readAssetHash(profile: AcademyOpenAiPluginProfile): string {
  if (!profile.logoPath) return EMPTY_ASSET_HASH
  if (!existsSync(profile.logoPath)) throw new AcademyError('OPENAI_PLUGIN_LOGO_INVALID')
  const stat = lstatSync(profile.logoPath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new AcademyError('OPENAI_PLUGIN_LOGO_INVALID')
  return sha256(readFileSync(profile.logoPath))
}

function bumpVersion(current: string, delta: AcademyOpenAiReleaseDelta): string {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(current)
  if (!match) throw new AcademyError('OPENAI_PLUGIN_INVALID_VERSION', current)
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (delta.added.length || delta.removed.length || delta.renamed.length) return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

export function compareSemver(left: string, right: string): number {
  const parse = (value: string): number[] => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
    if (!match) throw new AcademyError('OPENAI_PLUGIN_INVALID_VERSION', value)
    return match.slice(1).map(Number)
  }
  const leftParts = parse(left)
  const rightParts = parse(right)
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index]
  }
  return 0
}
