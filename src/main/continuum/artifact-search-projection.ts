import type Database from 'better-sqlite3'
import { artifactTags } from '../../shared/types/continuum-tag-types'
import { extractSearchUnits, structuralBody, STRUCTURE_VERSION } from './artifact-structure'
import type { ArtifactMetadata } from './continuum-types'

export const SEARCH_PROJECTION_VERSION = 1
const projectionVersion = `${SEARCH_PROJECTION_VERSION}:${STRUCTURE_VERSION}`
const batchSize = 4

interface Source {
  artifact_id: string
  revision: number
  content_hash: string
  metadata_json: string
  raw_markdown: string
}

interface Unit {
  field: 'title' | 'description' | 'headings' | 'body' | 'tags'
  text: string
  section?: number
  block?: number
  type?: string
  path?: string
}

function project(source: Source): { units: Unit[]; fallback: boolean } {
  const metadata: ArtifactMetadata = JSON.parse(source.metadata_json)
  const units: Unit[] = [{ field: 'title', text: metadata.name }]
  if (metadata.description) units.push({ field: 'description', text: metadata.description })
  for (const tag of artifactTags(metadata.tags)) units.push({ field: 'tags', text: tag })
  try {
    const { sections, units: structural } = extractSearchUnits(source.raw_markdown)
    for (const unit of structural) {
      const path: string[] = []
      for (let index: number | null = unit.section; index !== null; index = sections[index].parent) {
        if (sections[index].level) path.unshift(sections[index].title)
      }
      units.push({ ...unit, path: path.join(' / ') })
    }
    return { units, fallback: false }
  } catch {
    units.push({ field: 'body', text: structuralBody(source.raw_markdown) })
    return { units, fallback: true }
  }
}

export class ArtifactSearchProjection {
  private timer: NodeJS.Immediate | undefined
  private unavailable = false

  constructor(private readonly db: Database.Database) {
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS artifact_search_generation (
            id INTEGER PRIMARY KEY CHECK(id = 1), version TEXT NOT NULL,
            generation INTEGER NOT NULL, checkpoint INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS artifact_search_projection (
            artifact_id TEXT PRIMARY KEY REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
            revision INTEGER NOT NULL, content_hash TEXT NOT NULL, version TEXT NOT NULL, state TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS artifact_search_pending
            ON artifact_search_projection(state, artifact_id);
          CREATE TABLE IF NOT EXISTS artifact_search_units (
            id INTEGER PRIMARY KEY, artifact_id TEXT NOT NULL,
            field TEXT NOT NULL, section INTEGER, block INTEGER, block_type TEXT, path TEXT, text TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS artifact_search_units_owner ON artifact_search_units(artifact_id);
          CREATE VIRTUAL TABLE IF NOT EXISTS artifact_search_lexical
            USING fts5(title, description, headings, body, tags, tokenize='unicode61 remove_diacritics 2');
          CREATE VIRTUAL TABLE IF NOT EXISTS artifact_search_literal USING fts5(text, tokenize='trigram');
          CREATE TRIGGER IF NOT EXISTS artifact_search_unit_delete AFTER DELETE ON artifact_search_units BEGIN
            DELETE FROM artifact_search_lexical WHERE rowid = old.id;
            DELETE FROM artifact_search_literal WHERE rowid = old.id;
          END;
          CREATE TRIGGER IF NOT EXISTS artifact_search_artifact_insert AFTER INSERT ON artifacts BEGIN
            INSERT OR REPLACE INTO artifact_search_projection VALUES (new.artifact_id, new.revision, new.content_hash, (SELECT version FROM artifact_search_generation WHERE id=1), 'PENDING');
            UPDATE artifact_search_generation SET generation = generation + 1 WHERE id = 1;
          END;
          CREATE TRIGGER IF NOT EXISTS artifact_search_artifact_update AFTER UPDATE ON artifacts BEGIN
            INSERT OR REPLACE INTO artifact_search_projection VALUES (new.artifact_id, new.revision, new.content_hash, (SELECT version FROM artifact_search_generation WHERE id=1), 'PENDING');
            UPDATE artifact_search_generation SET generation = generation + 1 WHERE id = 1;
          END;
          CREATE TRIGGER IF NOT EXISTS artifact_search_artifact_delete AFTER DELETE ON artifacts BEGIN
            DELETE FROM artifact_search_units WHERE artifact_id = old.artifact_id;
            UPDATE artifact_search_generation SET generation = generation + 1 WHERE id = 1;
          END;
        `)
        db.prepare('INSERT OR IGNORE INTO artifact_search_generation VALUES (1, ?, 0, 0)').run(projectionVersion)
        db.prepare('UPDATE artifact_search_generation SET version=?, generation=generation+1, checkpoint=0 WHERE id=1 AND version<>?')
          .run(projectionVersion, projectionVersion)

      }).immediate()
    } catch {
      this.unavailable = true
    }
  }

  get available(): boolean { return !this.unavailable }

  health() {
    if (!this.available) return { state: 'UNAVAILABLE' as const }
    const counts = this.db.prepare(`
      SELECT
        count(CASE WHEN p.state IS NULL OR p.state='PENDING' THEN 1 END) AS pending,
        count(CASE WHEN p.state='FAILED' THEN 1 END) AS failed,
        count(CASE WHEN p.state='FALLBACK' THEN 1 END) AS fallback
      FROM artifacts a LEFT JOIN artifact_search_projection p ON p.artifact_id=a.artifact_id
        AND p.revision=a.revision AND p.content_hash=a.content_hash AND p.version=?
    `).get(projectionVersion) as { pending: number; failed: number; fallback: number }
    return { state: counts.pending || counts.failed || counts.fallback ? 'PARTIAL' as const : 'COMPLETE' as const, ...counts }
  }

  schedule(): void {
    if (this.timer || this.unavailable) return
    this.timer = setImmediate(() => {
      this.timer = undefined
      try {
        if (this.backfillBatch()) this.schedule()
      } catch {
        this.unavailable = true
      }
    }).unref()
  }

  stop(): void {
    if (this.timer) clearImmediate(this.timer)
    this.timer = undefined
  }

  backfillBatch(): boolean {
    if (this.unavailable) return false
    this.db.transaction(() => {
      if (this.db.prepare('SELECT version FROM artifact_search_generation WHERE id=1').pluck().get() !== projectionVersion) {
        this.unavailable = true
        return
      }
      const candidates = this.db.prepare(`
        SELECT a.rowid, a.artifact_id, a.revision, a.content_hash
        FROM artifacts a WHERE a.rowid > (SELECT checkpoint FROM artifact_search_generation WHERE id=1)
        ORDER BY a.rowid LIMIT ?
      `).all(batchSize) as Array<Pick<Source, 'artifact_id' | 'revision' | 'content_hash'> & { rowid: number }>
      const pending = this.db.prepare(`
        INSERT INTO artifact_search_projection VALUES (?, ?, ?, ?, 'PENDING')
        ON CONFLICT(artifact_id) DO UPDATE SET revision=excluded.revision, content_hash=excluded.content_hash,
          version=excluded.version, state=excluded.state WHERE artifact_search_projection.version<>excluded.version
      `)
      for (const candidate of candidates) pending.run(candidate.artifact_id, candidate.revision, candidate.content_hash, projectionVersion)
      if (candidates.length) this.db.prepare('UPDATE artifact_search_generation SET checkpoint=? WHERE id=1').run(candidates.at(-1)!.rowid)
    }).immediate()
    if (!this.available) return false
    const work = this.db.prepare(`
      SELECT a.artifact_id, a.revision, a.content_hash, a.metadata_json, a.raw_markdown
      FROM artifact_search_projection p JOIN artifacts a USING (artifact_id)
      WHERE p.state='PENDING' AND p.version=? ORDER BY p.artifact_id LIMIT ?
    `).all(projectionVersion, batchSize) as Source[]
    for (const source of work) {
      try {
        this.persist(source, project(source))
      } catch {
        this.persist(source, undefined)
      }
    }
    return work.length === batchSize || !!this.db.prepare(`
      SELECT 1 FROM artifacts WHERE rowid > (SELECT checkpoint FROM artifact_search_generation WHERE id=1) LIMIT 1
    `).get()
  }

  private persist(source: Source, projection: ReturnType<typeof project> | undefined): void {
    this.db.transaction(() => {
      if (this.db.prepare('SELECT version FROM artifact_search_generation WHERE id=1').pluck().get() !== projectionVersion) return
      const current = this.db.prepare('SELECT revision, content_hash, metadata_json FROM artifacts WHERE artifact_id=?')
        .get(source.artifact_id) as Pick<Source, 'revision' | 'content_hash' | 'metadata_json'> | undefined
      if (current?.revision !== source.revision || current.content_hash !== source.content_hash || current.metadata_json !== source.metadata_json) return
      this.db.prepare('DELETE FROM artifact_search_units WHERE artifact_id=?').run(source.artifact_id)
      if (projection) {
        const insertUnit = this.db.prepare('INSERT INTO artifact_search_units(artifact_id, field, section, block, block_type, path, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
        const insertLexical = this.db.prepare('INSERT INTO artifact_search_lexical(rowid, title, description, headings, body, tags) VALUES (?, ?, ?, ?, ?, ?)')
        const insertLiteral = this.db.prepare('INSERT INTO artifact_search_literal(rowid, text) VALUES (?, ?)')
        for (const unit of projection.units) {
          const row = insertUnit.run(source.artifact_id, unit.field, unit.section ?? null, unit.block ?? null, unit.type ?? null, unit.path ?? null, unit.text)
          insertLexical.run(row.lastInsertRowid, ...['title', 'description', 'headings', 'body', 'tags'].map(field => field === unit.field ? unit.text : null))
          insertLiteral.run(row.lastInsertRowid, unit.text)
        }
      }
      const state = projection ? (projection.fallback ? 'FALLBACK' : 'CURRENT') : 'FAILED'
      this.db.prepare('UPDATE artifact_search_projection SET state=? WHERE artifact_id=?').run(state, source.artifact_id)
      this.db.prepare('UPDATE artifact_search_generation SET generation=generation+1 WHERE id=1').run()
    }).immediate()
  }
}