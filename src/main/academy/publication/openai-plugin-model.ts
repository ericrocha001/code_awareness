import { createHash } from 'node:crypto'
import type { AcademyOpenAiPluginProfile, AcademyOpenAiReleaseDelta, AcademyOpenAiSnapshotEntry } from '../../../shared/types/academy-types'
import type { AcademyStore } from '../academy-store'
import { AcademyError } from '../academy-package'

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

export function buildCanonicalOpenAiSnapshot(store: AcademyStore): AcademyOpenAiSnapshotEntry[] {
  return store.list('ACTIVE').filter((skill) => skill.scope === 'GLOBAL').map((skill) => {
    const detail = store.get(skill.id)
    return { skillId: skill.id, name: skill.name, academyVersion: skill.currentVersion, packageHash: detail.current.packageHash }
  }).sort((left, right) => left.skillId.localeCompare(right.skillId))
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
