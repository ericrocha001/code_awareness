import { createHash } from 'node:crypto'
import type { AcademyOpenAiPluginProfile, AcademyOpenAiReleaseDelta, AcademyOpenAiSnapshotEntry } from '../../../shared/types/academy-types'
import type { AcademyStore } from '../academy-store'
import { AcademyError, hashAcademyPackage } from '../academy-package'
import type { AcademyGitSourceSnapshot } from '../../../shared/types/academy-git-source-types'
import type { ZipEntry } from './deterministic-zip'
import { assertSourcePath } from '../git/academy-git-materializer'

export const OPENAI_PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function sha256(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex') }

export function buildCanonicalOpenAiSnapshot(store: AcademyStore, source?: AcademyGitSourceSnapshot): AcademyOpenAiSnapshotEntry[] {
  const authority = store.getGitAuthority()
  const git = source ?? (authority ? store.getGitSnapshot(authority.repositoryId, authority.processedCommitSha) : null)
  if (git) return git.skills.map(skill => {
    const binding = git.canonicalVersions?.[skill.path]
    if (!binding || hashAcademyPackage(skill.package) !== skill.packageHash) throw new AcademyError('GIT_SOURCE_VERSION_BINDING_REQUIRED')
    return { skillId: binding.skillId, name: skill.name, academyVersion: binding.version, packageHash: skill.packageHash }
  }).sort((left, right) => left.skillId.localeCompare(right.skillId))
  if (store.usesGitFirst()) return []
  return store.list('ACTIVE').filter((skill) => skill.scope === 'GLOBAL').map((skill) => {
    const detail = store.get(skill.id)
    return { skillId: skill.id, name: skill.name, academyVersion: skill.currentVersion, packageHash: detail.current.packageHash }
  }).sort((left, right) => left.skillId.localeCompare(right.skillId))
}

export function buildGitOpenAiInput(store: AcademyStore, source: AcademyGitSourceSnapshot) {
  const snapshot = buildCanonicalOpenAiSnapshot(store, source)
  const manifestBytes = source.authoredFiles['plugin.json']
  if (!manifestBytes) throw new AcademyError('OPENAI_PLUGIN_MANIFEST_MISSING')
  let manifest: Record<string, any>
  try { manifest = JSON.parse(Buffer.from(manifestBytes, 'base64').toString('utf8')) } catch { throw new AcademyError('OPENAI_PLUGIN_INVALID_MANIFEST') }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new AcademyError('OPENAI_PLUGIN_INVALID_MANIFEST')
  if (manifest.name !== 'academy-skills') throw new AcademyError('OPENAI_PLUGIN_IDENTITY_IMMUTABLE')
  if (typeof manifest.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)) throw new AcademyError('OPENAI_PLUGIN_INVALID_VERSION')
  const expected = new Map<string, Buffer>([['plugin.json', Buffer.from(`${canonicalJson(manifest)}\n`)]])
  for (const skill of source.skills) {
    if (skill.path !== `skills/${skill.name}`) throw new AcademyError('GIT_SOURCE_INVENTORY_MISMATCH')
    for (const [path, text] of Object.entries({ 'SKILL.md': skill.package.skillMd, ...skill.package.artifacts })) expected.set(`${skill.path}/${path}`, Buffer.from(text))
  }
  if (source.authoredFiles['assets/logo.png']) expected.set('assets/logo.png', Buffer.from(source.authoredFiles['assets/logo.png'], 'base64'))
  if (Object.keys(source.authoredFiles).length !== expected.size) throw new AcademyError('GIT_SOURCE_INVENTORY_MISMATCH')
  const entries: ZipEntry[] = []
  const folded = new Set<string>()
  for (const [path, data] of expected) {
    assertSourcePath(path)
    if (folded.has(path.toLowerCase())) throw new AcademyError('GIT_SOURCE_DUPLICATE_PATH')
    folded.add(path.toLowerCase())
    const raw = source.authoredFiles[path]
    if (!raw || path !== 'plugin.json' && !Buffer.from(raw, 'base64').equals(data)) throw new AcademyError('GIT_SOURCE_INVENTORY_MISMATCH')
    entries.push({ path: `academy-skills/${path}`, data })
  }
  entries.sort((a, b) => a.path.localeCompare(b.path))
  const manifestFingerprint = sha256(canonicalJson(manifest))
  const assetFingerprint = sha256(expected.get('assets/logo.png') ?? 'NO_ASSET')
  const entriesFingerprint = sha256(canonicalJson(entries.map(entry => ({ path: entry.path, sha256: sha256(entry.data) }))))
  return { snapshot, manifest, pluginVersion: manifest.version as string, entries, manifestFingerprint, assetFingerprint, entriesFingerprint }
}

export function gitOpenAiValidationProfile(profile: AcademyOpenAiPluginProfile, input: ReturnType<typeof buildGitOpenAiInput>): AcademyOpenAiPluginProfile {
  return { ...profile, name: 'academy-skills', description: input.manifest.description,
    author: input.manifest.author, openAiInterface: input.manifest.extensions?.['com.openai']?.interface,
    logoPath: input.entries.some(entry => entry.path === 'academy-skills/assets/logo.png') ? 'git:assets/logo.png' : null }
}

export function hashOpenAiSnapshot(snapshot: AcademyOpenAiSnapshotEntry[]): string { return sha256(canonicalJson(snapshot)) }

export function calculateOpenAiDelta(before: AcademyOpenAiSnapshotEntry[], after: AcademyOpenAiSnapshotEntry[]): AcademyOpenAiReleaseDelta {
  const previous = new Map(before.map((entry) => [entry.skillId, entry]))
  const current = new Map(after.map((entry) => [entry.skillId, entry]))
  const added: AcademyOpenAiSnapshotEntry[] = []
  const removed: AcademyOpenAiSnapshotEntry[] = []
  const renamed: AcademyOpenAiReleaseDelta['renamed'] = []
  const updated: AcademyOpenAiReleaseDelta['updated'] = []
  for (const entry of after) {
    const old = previous.get(entry.skillId)
    if (!old) { added.push(entry); continue }
    if (old.name !== entry.name) renamed.push({ before: old, after: entry })
    else if (old.packageHash !== entry.packageHash || old.academyVersion !== entry.academyVersion) updated.push({ before: old, after: entry })
  }
  for (const entry of before) if (!current.has(entry.skillId)) removed.push(entry)
  const byName = (left: AcademyOpenAiSnapshotEntry, right: AcademyOpenAiSnapshotEntry) => left.name.localeCompare(right.name)
  added.sort(byName); removed.sort(byName); renamed.sort((left, right) => byName(left.after, right.after)); updated.sort((left, right) => byName(left.after, right.after))
  return { added, updated, removed, renamed, destructive: removed.length > 0 || renamed.length > 0 }
}

export function nextOpenAiPluginVersion(current: string, delta: AcademyOpenAiReleaseDelta, firstManagedRelease: boolean): string {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(current)
  if (!match) throw new AcademyError('OPENAI_PLUGIN_INVALID_VERSION', current)
  const major = Number(match[1]); const minor = Number(match[2]); const patch = Number(match[3])
  if (delta.added.length || delta.removed.length || delta.renamed.length) return `${major}.${minor + 1}.0`
  if (delta.updated.length || firstManagedRelease) return `${major}.${minor}.${patch + 1}`
  throw new AcademyError('OPENAI_RELEASE_NO_CHANGES')
}

export function buildOpenAiManifest(profile: AcademyOpenAiPluginProfile, version: string): Record<string, unknown> {
  const openAiInterface = { ...profile.openAiInterface }
  if (profile.logoPath) {
    openAiInterface.composerIcon = './assets/logo.png'
    openAiInterface.logo = './assets/logo.png'
  } else {
    delete openAiInterface.composerIcon
    delete openAiInterface.logo
  }
  return {
    $schema: OPENAI_PLUGIN_SCHEMA,
    name: profile.name,
    version,
    description: profile.description,
    author: profile.author,
    extensions: { 'com.openai': { interface: openAiInterface } }
  }
}
