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

function compareSemver(left: string, right: string): number {
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
