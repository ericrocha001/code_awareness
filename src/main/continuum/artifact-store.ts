import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Artifact, ArtifactDiscoveryRecord, ArtifactPage, CreateArtifactInput, UpdateArtifactInput, ListArtifactsFilter, MetadataValue } from './continuum-types'
import { canonicalJson, normalizeMetadataValue, relationsOf, validateMetadata, validateMarkdown } from './artifact-metadata'

export class ArtifactIdentityConflictError extends Error {
  constructor(readonly artifactId: string) { super(`IDENTITY_CONFLICT: Artifact "${artifactId}" already exists`); this.name = 'ArtifactIdentityConflictError' }
}
export class ArtifactRevisionConflictError extends Error {
  constructor(readonly artifactId: string, readonly currentRevision: number) {
    super(`REVISION_CONFLICT: Artifact "${artifactId}" is at revision ${currentRevision}; read again before updating`)
    this.name = 'ArtifactRevisionConflictError'
  }
}
export class ArtifactContentIntegrityError extends Error {
  constructor() { super('INTEGRITY_ERROR: contentHash does not match rawMarkdown'); this.name = 'ArtifactContentIntegrityError' }
}
export function computeContentHash(content: string): string { return createHash('sha256').update(content, 'utf8').digest('hex') }

interface ArtifactRow {
  artifact_id: string; revision: number; metadata_json: string; name: string; description: string | null
  kind: string; status: string | null; created_at: string; updated_at: string; raw_markdown: string
  content_hash: string; provenance_json: string
}
interface DiscoveryRow {
  artifact_id: string; name: string; description: string | null; kind: string; status: string | null
  updated_at: string; relation_count: number
}

export class ArtifactStore {
  private readonly db: Database.Database
  constructor(dbPath: string, readonly repositoryId: string) {
    if (!repositoryId?.trim()) throw new Error('INVALID_ARGUMENT: canonical repositoryId is required')
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    try {
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('foreign_keys = ON')
      this.db.exec(`CREATE TABLE IF NOT EXISTS repository_scope (id INTEGER PRIMARY KEY CHECK(id = 1), repository_id TEXT NOT NULL)`)
      const scope = this.db.prepare('SELECT repository_id FROM repository_scope WHERE id = 1').get() as { repository_id: string } | undefined
      if (scope && scope.repository_id !== repositoryId) throw new Error('REPOSITORY_SCOPE_MISMATCH: Store belongs to another repository')
      this.db.prepare('INSERT OR IGNORE INTO repository_scope VALUES (1, ?)').run(repositoryId)
      this.ensureSchema()
    } catch (error) { this.db.close(); throw error }
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision >= 1),
        metadata_json TEXT NOT NULL, name TEXT NOT NULL, description TEXT, kind TEXT NOT NULL, status TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, raw_markdown TEXT NOT NULL,
        content_hash TEXT NOT NULL, provenance_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS artifacts_order ON artifacts(updated_at DESC, artifact_id DESC);
      CREATE INDEX IF NOT EXISTS artifacts_kind ON artifacts(kind, updated_at DESC, artifact_id DESC);
      CREATE INDEX IF NOT EXISTS artifacts_status ON artifacts(status, updated_at DESC, artifact_id DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS artifact_search USING fts5(name, description, content='artifacts', content_rowid='rowid', tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS artifacts_search_insert AFTER INSERT ON artifacts BEGIN
        INSERT INTO artifact_search(rowid, name, description) VALUES (new.rowid, new.name, new.description);
      END;
      CREATE TRIGGER IF NOT EXISTS artifacts_search_update AFTER UPDATE ON artifacts BEGIN
        INSERT INTO artifact_search(artifact_search, rowid, name, description) VALUES ('delete', old.rowid, old.name, old.description);
        INSERT INTO artifact_search(rowid, name, description) VALUES (new.rowid, new.name, new.description);
      END;
      CREATE TABLE IF NOT EXISTS artifact_revisions (
        artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id), revision INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL, PRIMARY KEY(artifact_id, revision)
      );
      CREATE TRIGGER IF NOT EXISTS revisions_no_update BEFORE UPDATE ON artifact_revisions
        BEGIN SELECT RAISE(ABORT, 'Immutable revision'); END;
      CREATE TRIGGER IF NOT EXISTS revisions_no_delete BEFORE DELETE ON artifact_revisions
        BEGIN SELECT RAISE(ABORT, 'Immutable revision'); END;
      CREATE TABLE IF NOT EXISTS artifact_relations (
        source_id TEXT NOT NULL REFERENCES artifacts(artifact_id), target_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
        kind TEXT NOT NULL, PRIMARY KEY(source_id, target_id, kind), CHECK(source_id <> target_id)
      );
      CREATE INDEX IF NOT EXISTS relations_target ON artifact_relations(target_id, kind, source_id);
      CREATE TABLE IF NOT EXISTS artifact_metadata (
        artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id), key TEXT NOT NULL, value_json TEXT NOT NULL,
        PRIMARY KEY(artifact_id, key)
      );
      CREATE INDEX IF NOT EXISTS metadata_lookup ON artifact_metadata(key, value_json, artifact_id);
      CREATE TABLE IF NOT EXISTS transport_imports (
        source TEXT NOT NULL, artifact_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(source, artifact_id)
      );
      CREATE TABLE IF NOT EXISTS legacy_migrations (source TEXT PRIMARY KEY, completed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repository_locators (locator TEXT PRIMARY KEY);
    `)
  }

  private decode(row: ArtifactRow): Artifact {
    return { artifactId: row.artifact_id, revision: row.revision, metadata: JSON.parse(row.metadata_json),
      createdAt: row.created_at, updatedAt: row.updated_at, rawMarkdown: row.raw_markdown,
      contentHash: row.content_hash, provenance: JSON.parse(row.provenance_json) }
  }

  private validate(input: CreateArtifactInput, legacy: boolean): CreateArtifactInput {
    if (typeof input.artifactId !== 'string' || !input.artifactId.trim()) throw new Error('INVALID_ARGUMENT: artifactId is required')
    if (legacy) {
      if (typeof input.rawMarkdown !== 'string') throw new Error('INVALID_ARGUMENT: legacy Markdown must be a string')
    } else validateMarkdown(input.rawMarkdown)
    for (const timestamp of [input.createdAt, input.updatedAt]) if (timestamp !== undefined && !Number.isFinite(Date.parse(timestamp))) throw new Error('INVALID_ARGUMENT: invalid timestamp')
    if (input.contentHash !== undefined && input.contentHash !== computeContentHash(input.rawMarkdown)) throw new ArtifactContentIntegrityError()
    return { ...input, metadata: validateMetadata(input.metadata, legacy) }
  }

  private writeIndexes(artifact: Artifact): void {
    this.db.prepare('DELETE FROM artifact_relations WHERE source_id = ?').run(artifact.artifactId)
    const relationInsert = this.db.prepare('INSERT INTO artifact_relations(source_id, target_id, kind) VALUES (?, ?, ?)')
    for (const relation of relationsOf(artifact.metadata)) {
      if (relation.artifactId === artifact.artifactId) throw new Error('INVALID_RELATION: self relation')
      if (!this.db.prepare('SELECT 1 FROM artifacts WHERE artifact_id = ?').get(relation.artifactId)) throw new Error(`INVALID_RELATION: target "${relation.artifactId}" does not exist in this repository`)
      relationInsert.run(artifact.artifactId, relation.artifactId, relation.kind)
    }
    this.db.prepare('DELETE FROM artifact_metadata WHERE artifact_id = ?').run(artifact.artifactId)
    const insert = this.db.prepare('INSERT INTO artifact_metadata(artifact_id, key, value_json) VALUES (?, ?, ?)')
    for (const [key, value] of Object.entries(artifact.metadata)) if (value !== undefined) insert.run(artifact.artifactId, key, canonicalJson(value as MetadataValue))
    this.db.prepare('INSERT INTO artifact_revisions(artifact_id, revision, snapshot_json) VALUES (?, ?, ?)').run(artifact.artifactId, artifact.revision, JSON.stringify(artifact))
  }

  private createInsideTransaction(input: CreateArtifactInput, legacy = false): Artifact {
    input = this.validate(input, legacy)
    if (this.db.prepare('SELECT 1 FROM artifacts WHERE artifact_id = ?').get(input.artifactId)) throw new ArtifactIdentityConflictError(input.artifactId)
    const now = new Date().toISOString()
    const artifact: Artifact = { artifactId: input.artifactId, revision: 1, metadata: input.metadata,
      rawMarkdown: input.rawMarkdown, contentHash: computeContentHash(input.rawMarkdown), createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now, provenance: input.provenance ?? {} }
    this.db.prepare(`INSERT INTO artifacts(artifact_id, revision, metadata_json, name, description, kind, status,
      created_at, updated_at, raw_markdown, content_hash, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(artifact.artifactId, 1, JSON.stringify(artifact.metadata), artifact.metadata.name, artifact.metadata.description ?? null,
        artifact.metadata.kind, artifact.metadata.status ?? null, artifact.createdAt, artifact.updatedAt,
        artifact.rawMarkdown, artifact.contentHash, JSON.stringify(artifact.provenance))
    this.writeIndexes(artifact)
    return artifact
  }
  create(input: CreateArtifactInput): Artifact { return this.db.transaction(() => this.createInsideTransaction(input)).immediate() }

  update(input: UpdateArtifactInput): Artifact {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error('INVALID_ARGUMENT: expectedRevision must be an integer >= 1')
    return this.db.transaction(() => {
      const current = this.get(input.artifactId)
      if (!current) throw new Error('ARTIFACT_NOT_FOUND: ' + input.artifactId)
      if (current.revision !== input.expectedRevision) throw new ArtifactRevisionConflictError(input.artifactId, current.revision)
      const checked = this.validate(input, false)
      const artifact: Artifact = { ...current, metadata: checked.metadata, rawMarkdown: checked.rawMarkdown,
        revision: current.revision + 1, updatedAt: new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString(),
        contentHash: computeContentHash(checked.rawMarkdown) }
      this.db.prepare(`UPDATE artifacts SET revision = ?, metadata_json = ?, name = ?, description = ?, kind = ?, status = ?,
        updated_at = ?, raw_markdown = ?, content_hash = ? WHERE artifact_id = ? AND revision = ?`)
        .run(artifact.revision, JSON.stringify(artifact.metadata), artifact.metadata.name, artifact.metadata.description ?? null,
          artifact.metadata.kind, artifact.metadata.status ?? null, artifact.updatedAt, artifact.rawMarkdown,
          artifact.contentHash, artifact.artifactId, input.expectedRevision)
      this.writeIndexes(artifact)
      return artifact
    }).immediate()
  }
  get(artifactId: string): Artifact | null {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE artifact_id = ?').get(artifactId) as ArtifactRow | undefined
    return row ? this.decode(row) : null
  }

  list(filter: ListArtifactsFilter = {}): ArtifactPage {
    const limit = filter.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_ARGUMENT: limit must be 1-100')
    if (filter.direction && !['inbound', 'outbound', 'both'].includes(filter.direction)) throw new Error('INVALID_ARGUMENT: invalid direction')
    if (filter.metadataKeys && (filter.metadataKeys.length > 20 || filter.metadataKeys.some(key => typeof key !== 'string' || !key.trim() || ['__proto__', 'constructor', 'prototype'].includes(key)))) throw new Error('INVALID_ARGUMENT: invalid metadataKeys')
    const clauses: string[] = []
    const params: (string | number)[] = []
    for (const key of ['kind', 'status'] as const) if (filter[key] !== undefined) { clauses.push(`a.${key} = ?`); params.push(filter[key]!) }
    if (filter.query) {
      if ([...filter.query].length >= 3) { clauses.push('a.rowid IN (SELECT rowid FROM artifact_search WHERE artifact_search MATCH ?)'); params.push('"' + filter.query.replace(/"/g, '""') + '"') }
      clauses.push('(instr(lower(a.name), lower(?)) > 0 OR instr(lower(coalesce(a.description, \'\')), lower(?)) > 0)')
      params.push(filter.query, filter.query)
    }
    for (const [key, value] of Object.entries(filter.metadata ?? {})) {
      clauses.push('a.artifact_id IN (SELECT artifact_id FROM artifact_metadata WHERE key = ? AND value_json = ?)')
      params.push(key, canonicalJson(normalizeMetadataValue(value)))
    }
    for (const [key, operator] of [['updatedAfter', '>='], ['updatedBefore', '<=']] as const) {
      if (filter[key]) {
        if (!Number.isFinite(Date.parse(filter[key]!))) throw new Error('INVALID_ARGUMENT: invalid ' + key)
        clauses.push(`a.updated_at ${operator} ?`); params.push(new Date(filter[key]!).toISOString())
      }
    }
    if (filter.relatedToArtifactId) {
      if (!this.db.prepare('SELECT 1 FROM artifacts WHERE artifact_id = ?').get(filter.relatedToArtifactId)) throw new Error('ARTIFACT_NOT_FOUND: ' + filter.relatedToArtifactId)
      const direction = filter.direction ?? 'both'
      const parts: string[] = []
      for (const [selection, match] of direction === 'outbound' ? [['target_id', 'source_id']] : direction === 'inbound' ? [['source_id', 'target_id']] : [['target_id', 'source_id'], ['source_id', 'target_id']]) {
        parts.push(`SELECT ${selection} FROM artifact_relations WHERE ${match} = ?${filter.relationKind ? ' AND kind = ?' : ''}`)
        params.push(filter.relatedToArtifactId)
        if (filter.relationKind) params.push(filter.relationKind)
      }
      clauses.push(`a.artifact_id IN (${parts.join(' UNION ')})`)
    } else if (filter.direction || filter.relationKind) throw new Error('INVALID_ARGUMENT: relation filters require relatedToArtifactId')
    const { cursor: omittedCursor, limit: omittedLimit, metadataKeys: omittedKeys, ...selection } = filter
    const signature = computeContentHash(this.repositoryId + ':' + canonicalJson(normalizeMetadataValue(selection)))
    if (filter.cursor) {
      let cursor: { updatedAt: string; artifactId: string; signature: string }
      try { cursor = JSON.parse(Buffer.from(filter.cursor, 'base64url').toString('utf8')) } catch { throw new Error('INVALID_ARGUMENT: invalid cursor') }
      if (!cursor || cursor.signature !== signature || typeof cursor.updatedAt !== 'string' || typeof cursor.artifactId !== 'string') throw new Error('INVALID_ARGUMENT: cursor does not match repository or filters')
      clauses.push('(a.updated_at < ? OR (a.updated_at = ? AND a.artifact_id < ?))'); params.push(cursor.updatedAt, cursor.updatedAt, cursor.artifactId)
    }
    const rows = this.db.prepare(`SELECT a.artifact_id, a.name, a.description, a.kind, a.status, a.updated_at,
      (SELECT count(*) FROM artifact_relations r WHERE r.source_id = a.artifact_id OR r.target_id = a.artifact_id) AS relation_count
      FROM artifacts a ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
      ORDER BY a.updated_at DESC, a.artifact_id DESC LIMIT ?`).all(...params, limit + 1) as DiscoveryRow[]
    const more = rows.length > limit
    const selected = rows.slice(0, limit)
    const artifacts: ArtifactDiscoveryRecord[] = selected.map(row => {
      const record: ArtifactDiscoveryRecord = { artifactId: row.artifact_id, name: row.name, kind: row.kind,
        updatedAt: row.updated_at, relationCount: row.relation_count,
        ...(row.description !== null ? { description: row.description } : {}), ...(row.status !== null ? { status: row.status } : {}) }
      if (filter.metadataKeys?.length) {
        record.metadata = Object.create(null) as Record<string, MetadataValue>
        const find = this.db.prepare('SELECT value_json FROM artifact_metadata WHERE artifact_id = ? AND key = ?')
        for (const key of filter.metadataKeys) { const value = find.get(row.artifact_id, key) as { value_json: string } | undefined; if (value) record.metadata[key] = JSON.parse(value.value_json) }
      }
      return record
    })
    const last = selected[selected.length - 1]
    return { artifacts, ...(more ? { nextCursor: Buffer.from(JSON.stringify({ updatedAt: last.updated_at, artifactId: last.artifact_id, signature })).toString('base64url') } : {}) }
  }

  importArtifact(source: string, input: CreateArtifactInput): Artifact {
    input = this.validate(input, input.metadata.description === undefined)
    const fingerprint = computeContentHash(canonicalJson(normalizeMetadataValue(input)))
    return this.db.transaction(() => {
      const receipt = this.db.prepare('SELECT fingerprint FROM transport_imports WHERE source = ? AND artifact_id = ?').get(source, input.artifactId) as { fingerprint: string } | undefined
      if (receipt) { if (receipt.fingerprint !== fingerprint) throw new ArtifactIdentityConflictError(input.artifactId); return this.get(input.artifactId)! }
      const existing = this.get(input.artifactId)
      let artifact: Artifact
      if (existing) {
        const original = this.db.prepare('SELECT snapshot_json FROM artifact_revisions WHERE artifact_id = ? AND revision = 1').get(input.artifactId) as { snapshot_json: string }
        const initial = JSON.parse(original.snapshot_json) as Artifact
        const { ingestedAt, ...initialProvenance } = initial.provenance
        const { ingestedAt: incomingIngestedAt, ...incomingProvenance } = input.provenance ?? {}
        if (initial.rawMarkdown !== input.rawMarkdown || initial.createdAt !== input.createdAt ||
          canonicalJson(initial.metadata as MetadataValue) !== canonicalJson(input.metadata as MetadataValue) ||
          canonicalJson(initialProvenance) !== canonicalJson(incomingProvenance)) throw new ArtifactIdentityConflictError(input.artifactId)
        artifact = existing
      } else artifact = this.createInsideTransaction(input, input.metadata.description === undefined)
      this.db.prepare('INSERT INTO transport_imports VALUES (?, ?, ?)').run(source, input.artifactId, fingerprint)
      return artifact
    }).immediate()
  }
  migrationComplete(source: string): boolean { return !!this.db.prepare('SELECT 1 FROM legacy_migrations WHERE source = ?').get(source) }
  completeMigration(source: string): void { this.db.prepare('INSERT OR IGNORE INTO legacy_migrations VALUES (?, ?)').run(source, new Date().toISOString()) }
  registerLocator(locator: string): void { this.db.prepare('INSERT OR IGNORE INTO repository_locators VALUES (?)').run(locator) }
  hasLocator(locator: string): boolean { return !!this.db.prepare('SELECT 1 FROM repository_locators WHERE locator = ?').get(locator) }
  close(): void { if (this.db.open) this.db.close() }
}
