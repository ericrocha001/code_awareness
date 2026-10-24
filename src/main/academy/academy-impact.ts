import { createHash } from 'node:crypto'
import type { AcademyImpactInput, AcademyImpactSnapshot, AcademyImpactWindow, AcademyPackage, AcademySkillDetail } from '../../shared/types/academy-types'
import { AcademyError, hashAcademyPackage, normalizeAcademyPackage, parseSkillMetadata } from './academy-package'
import { compareAcademyPackages, excerpt, page, windowNumber } from './academy-change-evidence'
import type { AcademyStore } from './academy-store'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AcademyError('INVALID_ARGUMENT')
  return value as Record<string, unknown>
}

function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new AcademyError('INVALID_ARGUMENT')
  return Number(value)
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new AcademyError('INVALID_ARGUMENT')
  return value
}

function window(value: unknown): AcademyImpactWindow | undefined {
  if (value === undefined) return undefined
  const raw = record(value)
  if (Object.keys(raw).some(key => !['offset', 'limit', 'textOffset', 'textLimit'].includes(key))) throw new AcademyError('INVALID_ARGUMENT')
  for (const [key, item] of Object.entries(raw)) windowNumber(item as number, 0, key === 'limit' ? 50 : key === 'textLimit' ? 4000 : Number.MAX_SAFE_INTEGER)
  if (raw.limit === 0 || raw.textLimit === 0) throw new AcademyError('INVALID_ARGUMENT')
  return raw as AcademyImpactWindow
}

export function parseImpactInput(value: unknown): AcademyImpactInput {
  const raw = record(value)
  if (Object.keys(raw).some(key => !['skillId', 'expectedVersion', 'package', 'baseVersion', 'targetVersion', 'changes', 'consumers', 'consumerId', 'evidence'].includes(key))) throw new AcademyError('INVALID_ARGUMENT')
  const common = { skillId: text(raw.skillId), changes: window(raw.changes), consumers: window(raw.consumers), consumerId: raw.consumerId === undefined ? undefined : text(raw.consumerId), evidence: window(raw.evidence) }
  if (raw.package !== undefined) {
    if (raw.baseVersion !== undefined || raw.targetVersion !== undefined) throw new AcademyError('INVALID_ARGUMENT')
    const pkg = record(raw.package)
    if (Object.keys(pkg).some(key => !['skillMd', 'artifacts'].includes(key))) throw new AcademyError('INVALID_PACKAGE')
    record(pkg.artifacts)
    return { ...common, expectedVersion: positive(raw.expectedVersion), package: normalizeAcademyPackage(pkg as unknown as AcademyPackage) }
  }
  if (raw.expectedVersion !== undefined) throw new AcademyError('INVALID_ARGUMENT')
  return { ...common, baseVersion: positive(raw.baseVersion), targetVersion: positive(raw.targetVersion) }
}

function reach(source: AcademySkillDetail, consumer: AcademySkillDetail, destinations: Array<{ id: string; enabled: boolean }>): 'OVERLAP' | 'AMBIGUOUS' | null {
  if (source.scope === 'GLOBAL' && consumer.scope === 'GLOBAL') return 'OVERLAP'
  const projects = source.scope === 'GLOBAL' ? consumer.projectIds : consumer.scope === 'GLOBAL' ? source.projectIds : source.projectIds.filter(id => consumer.projectIds.includes(id))
  if (!projects.length) return source.scope === 'PROJECT' && consumer.scope === 'PROJECT' && source.projectIds.length && consumer.projectIds.length ? null : 'AMBIGUOUS'
  return projects.some(id => destinations.some(destination => destination.id === id && destination.enabled)) ? 'OVERLAP' : 'AMBIGUOUS'
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const identity = (skill: AcademySkillDetail) => ({ id: skill.id, name: skill.name, version: skill.currentVersion, status: skill.status, scope: skill.scope, projects: [...skill.projectIds].sort() })

function coverageHashes(catalog: ReturnType<AcademyStore['readImpactCatalog']>, names: string[]) {
  const eligible = catalog.skills.filter(skill => skill.id !== catalog.source.id && reach(catalog.source, skill, catalog.destinations)).sort((a, b) => a.id.localeCompare(b.id))
  const consumers = eligible.filter(skill => consumerEvidence(skill, names, new Set(), new Set(), { limit: 1, textLimit: 1 }).total > 0)
  return { sourceHash: fingerprint(identity(catalog.source)), baseHash: hashAcademyPackage(catalog.base.package), catalogHash: fingerprint({ skills: eligible.map(identity), destinations: [...catalog.destinations].sort((a, b) => a.id.localeCompare(b.id)) }), consumerHash: fingerprint(consumers.map(identity)) }
}

export function verifyAcademyImpact(store: AcademyStore, input: unknown) {
  const raw = record(input)
  if (Object.keys(raw).some(key => !['snapshot', 'candidateHash'].includes(key))) throw new AcademyError('INVALID_ARGUMENT')
  const value = record(raw.snapshot)
  const keys = ['schema', 'skillId', 'baseVersion', 'targetVersion', 'candidateHash', 'sourceHash', 'baseHash', 'catalogHash', 'consumerHash', 'names', 'fingerprint']
  if (value.schema !== 1 || Object.keys(value).some(key => !keys.includes(key))) throw new AcademyError('INVALID_ARGUMENT')
  text(value.skillId); positive(value.baseVersion)
  if (value.targetVersion !== undefined) positive(value.targetVersion)
  for (const key of ['candidateHash', 'sourceHash', 'baseHash', 'catalogHash', 'consumerHash', 'fingerprint']) if (typeof value[key] !== 'string' || !/^[a-f0-9]{64}$/.test(value[key] as string)) throw new AcademyError('INVALID_ARGUMENT')
  if (!Array.isArray(value.names) || !value.names.length || value.names.length > 3 || value.names.some(name => typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(name))) throw new AcademyError('INVALID_ARGUMENT')
  if (raw.candidateHash !== undefined && (typeof raw.candidateHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.candidateHash))) throw new AcademyError('INVALID_ARGUMENT')
  const snapshot = value as unknown as AcademyImpactSnapshot
  const { fingerprint: expected, ...parts } = snapshot
  // Reconstruct field order independently of JSON key order supplied by either transport.
  const canonical = { schema: 1, skillId: parts.skillId, baseVersion: parts.baseVersion, targetVersion: parts.targetVersion, candidateHash: parts.candidateHash, sourceHash: parts.sourceHash, baseHash: parts.baseHash, catalogHash: parts.catalogHash, consumerHash: parts.consumerHash, names: parts.names }
  if (fingerprint(canonical) !== expected) return { state: 'UNKNOWN', reasons: ['SNAPSHOT_INVALID'], atomicUntilUpdate: false }
  try {
    const catalog = store.readImpactCatalog(snapshot.skillId, snapshot.baseVersion, snapshot.targetVersion)
    const hashes = coverageHashes(catalog, snapshot.names)
    const reasons: string[] = []
    if (hashes.sourceHash !== snapshot.sourceHash || hashes.baseHash !== snapshot.baseHash) reasons.push('BASE_CHANGED')
    if (hashes.consumerHash !== snapshot.consumerHash) reasons.push('CONSUMER_CHANGED')
    if (hashes.catalogHash !== snapshot.catalogHash) reasons.push('CATALOG_OR_REACH_CHANGED')
    const candidateHash = raw.candidateHash ?? (catalog.target && hashAcademyPackage(catalog.target.package)) ?? snapshot.candidateHash
    if (candidateHash !== snapshot.candidateHash) reasons.push('CANDIDATE_CHANGED')
    return { state: reasons.length ? 'STALE' : 'CURRENT', reasons, candidateHash, candidateCheck: raw.candidateHash === undefined && !catalog.target ? 'PROVIDED_IDENTITY_ONLY' : 'COMPARED', atomicUntilUpdate: false }
  } catch (error) {
    return { state: 'UNKNOWN', reasons: [(error as { code?: string }).code ?? 'CATALOG_UNAVAILABLE'], atomicUntilUpdate: false }
  }
}

function consumerEvidence(skill: AcademySkillDetail, names: string[], changedPaths: Set<string>, resources: Set<string>, options?: AcademyImpactWindow) {
  const found: Array<{ path: string; line: number; column: number; nature: 'EXPLICIT_REFERENCE' | 'CANONICAL_MENTION' | 'AMBIGUOUS'; changeLink: 'EXATO' | 'POR_SKILL' | 'INDETERMINADO'; resource?: string; excerpt: ReturnType<typeof excerpt> }> = []
  const pattern = new RegExp(`(?<![a-zA-Z0-9_-])(?:${names.map(escapeRegex).join('|')})(?![a-zA-Z0-9_-])`, 'g')
  for (const [path, content] of Object.entries({ 'SKILL.md': skill.current.package.skillMd, ...skill.current.package.artifacts }).sort(([a], [b]) => a.localeCompare(b))) {
    content.split(/\r?\n/).forEach((line, index) => {
      for (const match of line.matchAll(pattern)) {
        const tail = line.slice(match.index! + match[0].length)
        const resource = /^\/([^\s)\]#?`"<>]+)/.exec(tail)?.[1]
        const explicit = resource !== undefined || /[`\[]$/.test(line.slice(0, match.index))
        const unknownResource = resource !== undefined && !resources.has(resource)
        found.push({ path, line: index + 1, column: match.index! + 1, nature: unknownResource ? 'AMBIGUOUS' : explicit ? 'EXPLICIT_REFERENCE' : 'CANONICAL_MENTION', changeLink: unknownResource ? 'INDETERMINADO' : resource && changedPaths.has(resource) ? 'EXATO' : 'POR_SKILL', resource, excerpt: excerpt(line, options) })
      }
    })
  }
  return page(found, { limit: 2, ...options })
}

export function analyzeAcademyImpact(store: AcademyStore, input: unknown) {
  const request = parseImpactInput(input)
  const baseVersion = request.expectedVersion ?? request.baseVersion
  const catalog = store.readImpactCatalog(request.skillId, baseVersion, request.targetVersion)
  if (request.expectedVersion !== undefined && request.expectedVersion !== catalog.source.currentVersion) throw new AcademyError('VERSION_CONFLICT')
  const candidate = request.package ?? catalog.target!.package
  const diff = compareAcademyPackages(catalog.base.package, candidate, request.changes)
  const oldFiles = new Map(Object.entries({ 'SKILL.md': catalog.base.package.skillMd, ...catalog.base.package.artifacts }))
  const newFiles = new Map(Object.entries({ 'SKILL.md': candidate.skillMd, ...candidate.artifacts }))
  const resources = new Set([...oldFiles.keys(), ...newFiles.keys()])
  const changedPaths = new Set([...resources].filter(path => oldFiles.get(path) !== newFiles.get(path)))
  const names = [...new Set([catalog.source.name, parseSkillMetadata(catalog.base.package.skillMd).name, parseSkillMetadata(candidate.skillMd).name])]
  const candidates = catalog.skills.filter(skill => skill.id !== catalog.source.id && reach(catalog.source, skill, catalog.destinations)).map(skill => {
    const evidence = consumerEvidence(skill, names, changedPaths, resources, request.evidence)
    return { skillId: skill.id, name: skill.name, version: skill.currentVersion, scope: skill.scope, projectIds: skill.projectIds, reach: reach(catalog.source, skill, catalog.destinations), evidence }
  }).filter(consumer => consumer.evidence.total > 0).sort((a, b) => a.skillId.localeCompare(b.skillId))
  if (request.consumerId && !candidates.some(c => c.skillId === request.consumerId)) throw new AcademyError('CONSUMER_NOT_FOUND')
  const snapshotParts = { schema: 1 as const, skillId: catalog.source.id, baseVersion, targetVersion: request.targetVersion, candidateHash: hashAcademyPackage(candidate), ...coverageHashes(catalog, names), names }
  const snapshot: AcademyImpactSnapshot = { ...snapshotParts, fingerprint: fingerprint(snapshotParts) }
  return {
    source: { skillId: catalog.source.id, name: catalog.source.name, baseVersion, observedVersion: catalog.source.currentVersion, scope: catalog.source.scope, projectIds: catalog.source.projectIds },
    candidateHash: hashAcademyPackage(candidate),
    snapshot,
    diff,
    consumers: page(request.consumerId ? candidates.filter(c => c.skillId === request.consumerId) : candidates, request.consumers),
    totalCandidates: candidates.length,
    coverage: { status: 'ACTIVE', snapshotRead: 'CONSISTENT_SQLITE_TRANSACTION', eligibleSkills: catalog.skills.filter(skill => skill.id !== catalog.source.id && reach(catalog.source, skill, catalog.destinations)).length, traversal: 'DIRECT', limitations: ['Literal canonical names and declared resource paths only; aliases and implicit dependencies may be missed.', 'Mentions, including negation and examples, are evidence for review, not operational dependencies.', 'No detected references does not establish absence of impact.', 'Scope uses current canonical associations; historical scope is not reconstructed. Disabled or unknown project destinations retain ambiguous candidates.', 'Freshness is advisory. No lock spans verification and update; expectedVersion protects only the source.', 'Candidate freshness without a new hash checks the supplied content identity only.'] }
  }
}
