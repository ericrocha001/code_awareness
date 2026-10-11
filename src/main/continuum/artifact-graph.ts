import type Database from 'better-sqlite3'
import type { Artifact, ArtifactPage, ListArtifactsFilter } from './continuum-types'
import type { ContinuumGraph, ContinuumGraphEdge, ContinuumGraphQuery, ContinuumGraphNode } from '../../shared/types/continuum-graph-types'
import { extractArtifactReferences, REFERENCE_INDEX_VERSION } from './artifact-references'

export class ArtifactGraph {
  constructor(private readonly db: Database.Database, private readonly repositoryId: string) {
    db.transaction(() => {
      db.exec(`
      CREATE TABLE IF NOT EXISTS artifact_reference_sources (
        source_id TEXT PRIMARY KEY REFERENCES artifacts(artifact_id), source_revision INTEGER NOT NULL,
        source_hash TEXT NOT NULL, resolver_version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifact_references (
        source_id TEXT NOT NULL REFERENCES artifact_reference_sources(source_id) ON DELETE CASCADE,
        target_id TEXT NOT NULL, PRIMARY KEY(source_id, target_id), CHECK(source_id <> target_id)
      );
      CREATE INDEX IF NOT EXISTS references_target ON artifact_references(target_id, source_id);
      CREATE TABLE IF NOT EXISTS artifact_graph_state (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO artifact_graph_state VALUES (1, 0);
      `)
      const definition = `CREATE VIEW artifact_graph_edges AS
        SELECT r.source_id, r.target_id, r.kind, 'DECLARED' AS nature, 'metadata.relations' AS origin,
          a.revision AS source_revision, a.content_hash AS source_hash
        FROM artifact_relations r JOIN artifacts a ON a.artifact_id = r.source_id
        UNION ALL
        SELECT r.source_id, r.target_id, 'references', 'DERIVED', 'explicit-artifact-reference',
          s.source_revision, s.source_hash
        FROM artifact_references r JOIN artifact_reference_sources s ON s.source_id = r.source_id
          JOIN artifacts a ON a.artifact_id = r.source_id JOIN artifacts t ON t.artifact_id = r.target_id
        WHERE s.source_revision = a.revision AND s.source_hash = a.content_hash AND s.resolver_version = ${REFERENCE_INDEX_VERSION}`
      const current = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'artifact_graph_edges'").get() as { sql: string } | undefined
      if (current?.sql.trim() !== definition.trim()) {
        db.exec('DROP VIEW IF EXISTS artifact_graph_edges')
        db.exec(definition)
        if (current) db.prepare('UPDATE artifact_graph_state SET revision = revision + 1 WHERE id = 1').run()
      }
    }).immediate()
  }

  project(artifact: Pick<Artifact, 'artifactId' | 'revision' | 'contentHash' | 'rawMarkdown'>): void {
    this.db.prepare('DELETE FROM artifact_references WHERE source_id = ?').run(artifact.artifactId)
    this.db.prepare(`INSERT INTO artifact_reference_sources VALUES (?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET source_revision=excluded.source_revision,
      source_hash=excluded.source_hash, resolver_version=excluded.resolver_version`)
      .run(artifact.artifactId, artifact.revision, artifact.contentHash, REFERENCE_INDEX_VERSION)
    const insert = this.db.prepare('INSERT INTO artifact_references VALUES (?, ?)')
    for (const target of extractArtifactReferences(artifact.rawMarkdown)) if (target !== artifact.artifactId) insert.run(artifact.artifactId, target)
    this.db.prepare('UPDATE artifact_graph_state SET revision = revision + 1 WHERE id = 1').run()
  }

  backfill(limit = 100): { processed: number; pending: boolean } {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_ARGUMENT: backfill limit must be 1-100')
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT a.artifact_id, a.revision, a.content_hash, a.raw_markdown
        FROM artifacts a LEFT JOIN artifact_reference_sources s ON s.source_id = a.artifact_id
        WHERE s.source_id IS NULL OR s.source_revision <> a.revision OR s.source_hash <> a.content_hash
          OR s.resolver_version <> ? ORDER BY a.artifact_id LIMIT ?`).all(REFERENCE_INDEX_VERSION, limit + 1) as
        { artifact_id: string; revision: number; content_hash: string; raw_markdown: string }[]
      for (const row of rows.slice(0, limit)) this.project({ artifactId: row.artifact_id, revision: row.revision, contentHash: row.content_hash, rawMarkdown: row.raw_markdown })
      return { processed: Math.min(rows.length, limit), pending: rows.length > limit }
    }).immediate()
  }

  query(query: ContinuumGraphQuery, list: (filter: ListArtifactsFilter) => ArtifactPage): ContinuumGraph {
    if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error('INVALID_ARGUMENT: graph query required')
    const nodeLimit = query.nodeLimit ?? 50
    const edgeLimit = query.edgeLimit ?? 200
    if (!Number.isInteger(nodeLimit) || nodeLimit < 1 || nodeLimit > 100 || !Number.isInteger(edgeLimit) || edgeLimit < 1 || edgeLimit > 500) throw new Error('INVALID_ARGUMENT: graph caps must be nodes 1-100 and edges 1-500')
    if (query.artifactIds !== undefined && (!Array.isArray(query.artifactIds) || query.artifactIds.length > 100 || query.artifactIds.some(id => typeof id !== 'string' || !id.trim()))) throw new Error('INVALID_ARGUMENT: bounded artifactIds required')
    if (query.expand !== undefined && typeof query.expand !== 'boolean') throw new Error('INVALID_ARGUMENT: expand must be boolean')
    if (query.direction !== undefined && !['inbound', 'outbound', 'both'].includes(query.direction)) throw new Error('INVALID_ARGUMENT: invalid direction')
    for (const key of ['query', 'kind', 'status', 'relationKind'] as const) if (query[key] !== undefined && typeof query[key] !== 'string') throw new Error('INVALID_ARGUMENT: invalid ' + key)
    if (query.expectedRevision !== undefined && (!Number.isSafeInteger(query.expectedRevision) || query.expectedRevision < 0)) throw new Error('INVALID_ARGUMENT: invalid graph revision')
    const backfill = this.backfill()
    return this.db.transaction((): ContinuumGraph => {
      const revision = (this.db.prepare('SELECT revision FROM artifact_graph_state WHERE id = 1').get() as { revision: number }).revision
      if (query.expectedRevision !== undefined && query.expectedRevision !== revision) throw new Error('GRAPH_REVISION_CONFLICT')
      let ids: string[]
      let nodesTruncated = false
      if (query.artifactIds) {
        const exists = this.db.prepare('SELECT 1 FROM artifacts WHERE artifact_id = ?')
        ids = [...new Set(query.artifactIds)].sort()
        for (const id of ids) if (!exists.get(id)) throw new Error('ARTIFACT_NOT_FOUND: ' + id)
        if (query.query !== undefined || query.kind !== undefined || query.status !== undefined || query.metadata !== undefined || query.periods !== undefined) throw new Error('INVALID_ARGUMENT: select artifactIds or filters')
        nodesTruncated = ids.length > nodeLimit
        ids = ids.slice(0, nodeLimit)
      } else {
        const filter: ListArtifactsFilter = { limit: nodeLimit }
        for (const key of ['query', 'kind', 'status', 'metadata', 'periods'] as const) if (query[key] !== undefined) Object.assign(filter, { [key]: query[key] })
        const page = list(filter)
        ids = page.artifacts.map(a => a.artifactId); nodesTruncated = !!page.nextCursor
      }
      const placeholders = (values: string[]) => values.map(() => '?').join(',')
      const direction = query.direction ?? 'both'
      const seeds = [...ids]
      const kindClause = query.relationKind === undefined ? '' : ' AND kind = ?'
      const kindParams = query.relationKind === undefined ? [] : [query.relationKind]
      if (query.expand && ids.length) {
        const selections = direction === 'outbound' ? [['target_id', 'source_id']] : direction === 'inbound' ? [['source_id', 'target_id']] : [['target_id', 'source_id'], ['source_id', 'target_id']]
        const rows = this.db.prepare(`SELECT DISTINCT id FROM (${selections.map(([select, match]) => `SELECT ${select} AS id FROM artifact_graph_edges WHERE ${match} IN (${placeholders(ids)})${kindClause}`).join(' UNION ')}) ORDER BY id LIMIT ?`)
          .all(...selections.flatMap(() => [...ids, ...kindParams]), nodeLimit + 1) as { id: string }[]
        const combined = [...new Set([...ids, ...rows.map(row => row.id)])]
        nodesTruncated ||= combined.length > nodeLimit || rows.length > nodeLimit
        ids = combined.slice(0, nodeLimit)
      }
      const nodes: ContinuumGraphNode[] = ids.map(id => {
        const row = this.db.prepare(`SELECT a.artifact_id AS artifactId, a.name, a.description, a.kind, a.status,
          a.updated_at AS updatedAt, a.revision,
          (SELECT count(*) FROM artifact_graph_edges WHERE target_id = a.artifact_id) AS incomingDegree,
          (SELECT count(*) FROM artifact_graph_edges WHERE source_id = a.artifact_id) AS outgoingDegree
          FROM artifacts a WHERE a.artifact_id = ?`).get(id) as Omit<ContinuumGraphNode, 'description' | 'status'> & { description: string | null; status: string | null }
        const { description, status, ...node } = row
        return { ...node, ...(description !== null ? { description } : {}), ...(status !== null ? { status } : {}), relationCount: row.incomingDegree + row.outgoingDegree }
      })
      const directionClause = direction === 'both' ? '' : ` AND ${direction === 'inbound' ? 'target_id' : 'source_id'} IN (${placeholders(seeds)})`
      const rows = ids.length ? this.db.prepare(`SELECT source_id AS sourceId, target_id AS targetId, kind, nature, origin,
        source_revision AS sourceRevision, source_hash AS sourceHash FROM artifact_graph_edges
        WHERE source_id IN (${placeholders(ids)}) AND target_id IN (${placeholders(ids)})${kindClause}${directionClause}
        ORDER BY source_id, target_id, nature, kind LIMIT ?`).all(...ids, ...ids, ...kindParams, ...(direction === 'both' ? [] : seeds), edgeLimit + 1) as ContinuumGraphEdge[] : []
      const groups = new Map<string, string[]>()
      const execution = this.db.prepare("SELECT value_json FROM artifact_metadata WHERE artifact_id = ? AND key = 'executionId' AND json_type(value_json) = 'text'")
      for (const id of ids) {
        const membership = execution.get(id) as { value_json: string } | undefined
        if (!membership) continue
        const key = JSON.parse(membership.value_json) as string
        if (!key.trim()) continue
        groups.set(key, [...(groups.get(key) ?? []), id])
      }
      const count = this.db.prepare("SELECT count(*) AS total FROM artifact_metadata WHERE key = 'executionId' AND value_json = ?")
      return { repositoryId: this.repositoryId, revision, freshness: backfill.pending ? 'BACKFILL_PENDING' : 'CURRENT', nodes,
        edges: rows.slice(0, edgeLimit), executionGroups: [...groups].map(([executionId, memberIds]) => ({ executionId, memberIds,
          totalMembers: (count.get(JSON.stringify(executionId)) as { total: number }).total })),
        truncated: { nodes: nodesTruncated, edges: rows.length > edgeLimit } }
    })()
  }
}
