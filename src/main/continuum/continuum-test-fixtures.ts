import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { ArtifactStore, computeContentHash } from './artifact-store'
import { ContinuumService } from './continuum-service'
import { deriveRepositoryKey } from './repository-key'
import type { ArtifactEnvelope } from './artifact-envelope'
export function withFixtureDatabase<T>(path: string, inspect: (db: Database.Database) => T, readonly = true): T {
  const db = new Database(path, { readonly })
  try { return inspect(db) } finally { db.close() }
}
export function markdown(name = 'Decision', extra = '', body = '# Exact body\n\nç 🚀 ${literal}') { return `---\nname: ${name}\ndescription: Locate the ${name} runtime context\nkind: DECISION\n${extra}---\n${body}` }
export function fixture(repositoryId = 'catalog-A') {
  const dir = mkdtempSync(join(tmpdir(), 'continuum-'))
  const path = join(dir, 'continuum.db')
  const store = new ArtifactStore(path, repositoryId)
  const service = new ContinuumService(store)
  return { dir, path, store, service, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}
export function legacyEnvelope(root: string, artifactId = 'legacy'): ArtifactEnvelope {
  const rawMarkdown = '# Legacy\r\n\r\nUnicode ç 日本語 🚀 `${literal}` $(command)\t\r\n'
  return { protocol: 'continuum-artifact/v1', artifactId, type: 'IMPLEMENTATION_HANDOFF', schemaVersion: 1,
    title: 'Legacy handoff', producerRole: 'IMPLEMENTER', repositoryKey: deriveRepositoryKey(root),
    createdAt: '2026-09-01T00:00:00.000Z', rawMarkdown, contentHash: computeContentHash(rawMarkdown), gitHead: 'legacy-head', sourceFingerprint: 'legacy-fingerprint' }
}
export function legacyDatabase(storage: string, root: string, envelope = legacyEnvelope(root)): string {
  const path = join(storage, deriveRepositoryKey(root), 'continuum.db')
  mkdirSync(join(storage, deriveRepositoryKey(root)), { recursive: true })
  const db = new Database(path)
  try {
    db.exec(`CREATE TABLE artifacts(artifact_id TEXT PRIMARY KEY, type TEXT, schema_version INTEGER, title TEXT,
      producer_role TEXT, repository_key TEXT, created_at TEXT, ingested_at TEXT, source_fingerprint TEXT, git_head TEXT, content_hash TEXT, raw_markdown TEXT)`)
    db.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(envelope.artifactId, envelope.type,
      envelope.schemaVersion, envelope.title, envelope.producerRole, envelope.repositoryKey, envelope.createdAt,
      '2026-09-02T00:00:00.000Z', envelope.sourceFingerprint, envelope.gitHead, envelope.contentHash, envelope.rawMarkdown)
  } finally { db.close() }
  return path
}
