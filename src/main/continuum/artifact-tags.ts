import type Database from 'better-sqlite3'
import { isMap, isScalar, parseDocument } from 'yaml'
import { artifactTags, validateTagSlug, type ContinuumTag, type ContinuumTagDefinition } from '../../shared/types/continuum-tag-types'
import { parseArtifactMarkdown } from './artifact-metadata'
import type { Artifact } from './continuum-types'

export function editArtifactTags(raw: string, tags: string[]): string {
  artifactTags(tags)
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
  if (!match) throw new Error('TAGS_FRONTMATTER_REQUIRED')
  const yaml = match[1], document = parseDocument(yaml)
  if (document.errors.length || !isMap(document.contents)) throw new Error('TAGS_YAML_UNEDITABLE')
  const pair = document.contents.items.find(item => isScalar(item.key) && item.key.value === 'tags')
  const value = JSON.stringify(tags)
  let updated: string
  if (pair) {
    const range = pair.value && typeof pair.value === 'object' && 'range' in pair.value ? pair.value.range : null
    if (!range) throw new Error('TAGS_YAML_UNEDITABLE')
    updated = yaml.slice(0, range[0]) + value + yaml.slice(range[1])
  } else if (document.contents.flow) {
    const end = document.contents.range![1] - 1
    updated = yaml.slice(0, end) + (document.contents.items.length ? ', ' : '') + 'tags: ' + value + yaml.slice(end)
  } else updated = yaml + (raw.includes('\r\n') ? '\r\n' : '\n') + 'tags: ' + value
  const start = match[0].indexOf(yaml)
  const result = raw.slice(0, start) + updated + raw.slice(start + yaml.length)
  const before = parseArtifactMarkdown(raw, true), after = parseArtifactMarkdown(result, true)
  const { tags: omittedBefore, ...prior } = before.metadata, { tags: omittedAfter, ...next } = after.metadata
  if (before.body !== after.body || JSON.stringify(prior) !== JSON.stringify(next) || JSON.stringify(after.metadata.tags) !== value) throw new Error('TAGS_YAML_UNEDITABLE')
  return result
}

export class ArtifactTags {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS continuum_tags (slug TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, description TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_tags (artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id), slug TEXT NOT NULL REFERENCES continuum_tags(slug), PRIMARY KEY(artifact_id, slug));
      CREATE INDEX IF NOT EXISTS tag_membership ON artifact_tags(slug, artifact_id);
      CREATE TABLE IF NOT EXISTS continuum_tag_migrations (version INTEGER PRIMARY KEY);`)
    if (!db.prepare('SELECT 1 FROM continuum_tag_migrations WHERE version = 1').get()) db.transaction(() => {
      const rows = db.prepare('SELECT artifact_id, metadata_json FROM artifacts').all() as { artifact_id: string; metadata_json: string }[]
      for (const row of rows) this.project(row.artifact_id, JSON.parse(row.metadata_json).tags)
      db.prepare('INSERT INTO continuum_tag_migrations VALUES (1)').run()
    }).immediate()
  }
  project(artifactId: string, value: unknown): void {
    const tags = artifactTags(value)
    this.db.prepare('DELETE FROM artifact_tags WHERE artifact_id = ?').run(artifactId)
    for (const slug of tags) {
      this.db.prepare("INSERT OR IGNORE INTO continuum_tags VALUES (?, ?, '#7852ee', '')").run(slug, slug)
      this.db.prepare('INSERT INTO artifact_tags VALUES (?, ?)').run(artifactId, slug)
    }
  }
  list(): ContinuumTag[] {
    return this.db.prepare('SELECT t.*, (SELECT count(*) FROM artifact_tags m WHERE m.slug = t.slug) AS count FROM continuum_tags t ORDER BY name COLLATE NOCASE, slug').all() as ContinuumTag[]
  }
  require(slug: string): void { validateTagSlug(slug); if (!this.db.prepare('SELECT 1 FROM continuum_tags WHERE slug = ?').get(slug)) throw new Error('TAG_NOT_FOUND: ' + slug) }
  save(tag: ContinuumTagDefinition, create: boolean): void {
    if (!tag || typeof tag !== 'object') throw new Error('INVALID_TAG')
    validateTagSlug(tag.slug)
    if (typeof tag.name !== 'string' || !tag.name.trim() || tag.name.length > 80 || typeof tag.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(tag.color) || tag.description !== undefined && (typeof tag.description !== 'string' || tag.description.length > 500)) throw new Error('INVALID_TAG')
    if (create) {
      if (this.db.prepare('SELECT 1 FROM continuum_tags WHERE slug = ?').get(tag.slug)) throw new Error('TAG_ALREADY_EXISTS')
      this.db.prepare('INSERT INTO continuum_tags VALUES (?, ?, ?, ?)').run(tag.slug, tag.name.trim(), tag.color, tag.description ?? '')
    } else { this.require(tag.slug); this.db.prepare('UPDATE continuum_tags SET name = ?, color = ?, description = ? WHERE slug = ?').run(tag.name.trim(), tag.color, tag.description ?? '', tag.slug) }
  }
  delete(slug: string): void {
    this.require(slug)
    if (this.db.prepare('SELECT 1 FROM artifact_tags WHERE slug = ?').get(slug)) throw new Error('TAG_IN_USE: remove associations explicitly before deleting')
    this.db.prepare('DELETE FROM continuum_tags WHERE slug = ?').run(slug)
  }
}
