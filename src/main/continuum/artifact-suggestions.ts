import type Database from 'better-sqlite3'
import type { ContinuumSuggestionQuery, ContinuumSuggestionReason, ContinuumSuggestions, ContinuumSuggestion } from '../../shared/types/continuum-suggestion-types'
import { REFERENCE_INDEX_VERSION } from './artifact-references'

const CANDIDATE_LIMIT = 100
const SIGNAL_LIMIT = 40
const PROJECTION_VERSION = 1
const stopwords = new Set('a an and are as at be by com como da das de do dos e em for from in is it no nos na nas o of on or os para por que the to um uma with plano plan artifact artifacts artefato artefatos implementation implementacao system sistema service servico document documento context contexto selection selecao locate read find'.split(' '))
const excludedMetadata = new Set(['name', 'description', 'kind', 'status', 'relations', 'media', 'date', 'worktreeId', 'worktreePath', 'gitHead', 'sourceFingerprint', 'contentHash', 'schemaVersion', 'producerRole'])
function normalize(text: string): string { return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase() }
function terms(text: string): string[] {
  return [...new Set(normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [])].filter(word => word.length >= 3 && !stopwords.has(word)).sort()
}
interface Header { artifactId: string; name: string; description: string | null; kind: string; revision: number }
interface Scalar { key: string; value_json: string }

export function validateSuggestionQuery(input: unknown): ContinuumSuggestionQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_ARGUMENT: suggestion query required')
  const query = input as ContinuumSuggestionQuery
  if (Object.keys(input).some(key => !['artifactId', 'limit', 'expectedSourceRevision', 'expectedGraphRevision'].includes(key))) throw new Error('INVALID_ARGUMENT: unknown suggestion option')
  if (typeof query.artifactId !== 'string' || !query.artifactId.trim()) throw new Error('INVALID_ARGUMENT: artifactId required')
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 10)) throw new Error('INVALID_ARGUMENT: suggestion limit must be 1-10')
  for (const key of ['expectedSourceRevision', 'expectedGraphRevision'] as const) {
    if (query[key] !== undefined && (!Number.isSafeInteger(query[key]) || query[key]! < (key === 'expectedSourceRevision' ? 1 : 0))) throw new Error('INVALID_ARGUMENT: invalid ' + key)
  }
  return query
}

export class ArtifactSuggestions {
  constructor(private readonly db: Database.Database, private readonly repositoryId: string) {}

  query(input: ContinuumSuggestionQuery): ContinuumSuggestions {
    const query = validateSuggestionQuery(input)
    return this.db.transaction((): ContinuumSuggestions => {
      const header = this.db.prepare('SELECT artifact_id AS artifactId, substr(name, 1, 160) AS name, substr(description, 1, 2000) AS description, kind, revision FROM artifacts WHERE artifact_id = ?')
      const source = header.get(query.artifactId) as Header | undefined
      if (!source) throw new Error('ARTIFACT_NOT_FOUND: ' + query.artifactId)
      const graphRevision = (this.db.prepare('SELECT revision FROM artifact_graph_state WHERE id = 1').get() as { revision: number }).revision
      if (query.expectedSourceRevision !== undefined && query.expectedSourceRevision !== source.revision) throw new Error('REVISION_CONFLICT')
      if (query.expectedGraphRevision !== undefined && query.expectedGraphRevision !== graphRevision) throw new Error('GRAPH_REVISION_CONFLICT')
      const freshness = this.db.prepare(`SELECT 1 FROM artifacts a LEFT JOIN artifact_reference_sources s ON s.source_id = a.artifact_id
        WHERE s.source_id IS NULL OR s.source_revision <> a.revision OR s.source_hash <> a.content_hash OR s.resolver_version <> ? LIMIT 1`).get(REFERENCE_INDEX_VERSION) ? 'BACKFILL_PENDING' : 'CURRENT'
      const connected = `SELECT target_id AS id FROM artifact_graph_edges WHERE source_id = ? UNION SELECT source_id AS id FROM artifact_graph_edges WHERE target_id = ?`
      const eligible = `a.artifact_id <> ? AND a.artifact_id NOT IN (${connected})`
      const exclusionParams = [source.artifactId, source.artifactId, source.artifactId]
      const candidates = new Map<string, ContinuumSuggestionReason[]>()
      let truncated = false
      const add = (id: string, reason?: ContinuumSuggestionReason) => {
        if (!candidates.has(id)) {
          if (candidates.size >= CANDIDATE_LIMIT) { truncated = true; return }
          candidates.set(id, [])
        }
        if (reason && candidates.get(id)!.length < 3) candidates.get(id)!.push(reason)
      }
      const neighbors = this.db.prepare(`${connected} ORDER BY id LIMIT ?`).all(source.artifactId, source.artifactId, SIGNAL_LIMIT + 1) as { id: string }[]
      truncated ||= neighbors.length > SIGNAL_LIMIT
      const witness = new Map<string, Set<string>>()
      for (const { id } of neighbors.slice(0, SIGNAL_LIMIT)) {
        const rows = this.db.prepare(`SELECT a.artifact_id AS id FROM artifacts a WHERE ${eligible}
          AND a.artifact_id IN (${connected}) ORDER BY a.artifact_id LIMIT ?`).all(...exclusionParams, id, id, SIGNAL_LIMIT + 1) as { id: string }[]
        truncated ||= rows.length > SIGNAL_LIMIT
        for (const row of rows.slice(0, SIGNAL_LIMIT)) {
          if (!witness.has(row.id) && witness.size >= CANDIDATE_LIMIT) { truncated = true; continue }
          const paths = witness.get(row.id) ?? new Set<string>()
          if (paths.size < 3) paths.add(id)
          witness.set(row.id, paths)
        }
      }
      for (const [id, paths] of witness) add(id, { signal: 'shared-neighbor', artifactIds: [...paths].sort() })
      const scalars = this.db.prepare(`SELECT key, value_json FROM artifact_metadata WHERE artifact_id = ?
        AND json_type(value_json) IN ('text', 'integer', 'real', 'true', 'false') AND length(key) <= 80 AND length(value_json) <= 160
        AND key NOT IN (${[...excludedMetadata].map(() => '?').join(',')}) ORDER BY key = 'executionId' DESC, key LIMIT 9`).all(source.artifactId, ...excludedMetadata) as Scalar[]
      truncated ||= scalars.length > 8
      for (const scalar of scalars.slice(0, 8)) {
        const matches = this.db.prepare('SELECT artifact_id AS id FROM artifact_metadata WHERE key = ? AND value_json = ? ORDER BY artifact_id LIMIT ?').all(scalar.key, scalar.value_json, SIGNAL_LIMIT + 1) as { id: string }[]
        if (matches.length > SIGNAL_LIMIT) { truncated = true; continue }
        const value = JSON.parse(scalar.value_json) as string | number | boolean
        if (typeof value === 'string' && !value.trim()) continue
        const rows = this.db.prepare(`SELECT a.artifact_id AS id FROM artifacts a WHERE ${eligible}
          AND a.artifact_id IN (SELECT artifact_id FROM artifact_metadata WHERE key = ? AND value_json = ?) ORDER BY a.artifact_id LIMIT ?`)
          .all(...exclusionParams, scalar.key, scalar.value_json, SIGNAL_LIMIT) as { id: string }[]
        for (const { id } of rows) add(id, scalar.key === 'executionId' ? { signal: 'shared-execution', executionId: String(value) } : { signal: 'shared-metadata', key: scalar.key, value })
      }
      const sourceTerms = terms(source.name + ' ' + (source.description ?? '')).slice(0, 16)
      const fragments = new Set<string>()
      for (const word of (source.name + ' ' + (source.description ?? '')).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        if (!sourceTerms.includes(normalize(word))) continue
        for (const variant of [word, normalize(word)]) { fragments.add(variant.slice(0, 3)); fragments.add(variant.slice(-3)) }
      }
      if (fragments.size) {
        const match = [...fragments].sort().map(fragment => '"' + fragment + '"').join(' OR ')
        const rows = this.db.prepare(`SELECT a.artifact_id AS id FROM artifact_search JOIN artifacts a ON a.rowid = artifact_search.rowid
          WHERE artifact_search MATCH ? AND ${eligible} ORDER BY bm25(artifact_search), a.artifact_id LIMIT ?`)
          .all(match, ...exclusionParams, CANDIDATE_LIMIT + 1) as { id: string }[]
        truncated ||= rows.length > CANDIDATE_LIMIT
        for (const { id } of rows.slice(0, CANDIDATE_LIMIT)) add(id)
      }
      const kindCount = (this.db.prepare('SELECT count(*) AS n FROM (SELECT 1 FROM artifacts WHERE kind = ? LIMIT 11)').get(source.kind) as { n: number }).n
      const ranked: ContinuumSuggestion[] = []
      for (const [id, signals] of candidates) {
        const target = header.get(id) as Header
        const targetTerms = terms(target.name + ' ' + (target.description ?? ''))
        const shared = sourceTerms.filter(word => targetTerms.includes(word)).slice(0, 6)
        let score = 0
        const reasons = [...signals]
        if (shared.length >= 2) { reasons.push({ signal: 'shared-terms', terms: shared }); score += shared.length * 3 }
        for (const reason of signals) score += reason.signal === 'shared-neighbor' ? 6 : reason.signal === 'shared-metadata' ? 4 : 3
        if (!score) continue
        if (target.kind === source.kind && kindCount <= 10 && reasons.length < 4) { reasons.push({ signal: 'same-kind', kind: source.kind }); score++ }
        ranked.push({ targetArtifactId: id, name: target.name, kind: target.kind, targetRevision: target.revision, origin: 'SUGGESTED', proposedKind: 'related-to', score, reasons })
      }
      ranked.sort((a, b) => b.score - a.score || a.targetArtifactId.localeCompare(b.targetArtifactId, 'en'))
      const topN = query.limit ?? 5
      return { repositoryId: this.repositoryId, sourceArtifactId: source.artifactId, sourceRevision: source.revision, graphRevision,
        projectionVersion: PROJECTION_VERSION, referenceIndexVersion: REFERENCE_INDEX_VERSION, freshness, ranking: 'RELATIVE_EVIDENCE',
        limits: { candidateLimit: CANDIDATE_LIMIT, candidatesExamined: candidates.size, topN }, truncated: truncated || ranked.length > topN,
        suggestions: ranked.slice(0, topN) }
    })()
  }
}
