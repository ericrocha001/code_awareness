import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import type { CreateArtifactInput } from './continuum-types'
import type { ContinuumService } from './continuum-service'
import type { ArtifactStore } from './artifact-store'

export interface LegacyArtifact {
  artifactId: string; type: string; title: string; rawMarkdown: string; createdAt: string
  repositoryKey: string; schemaVersion: number; producerRole: string; ingestedAt?: string
  contentHash: string; gitHead: string | null; sourceFingerprint: string | null
}
export function legacyInput(artifact: LegacyArtifact): CreateArtifactInput {
  return { artifactId: artifact.artifactId, metadata: { name: artifact.title, kind: artifact.type },
    rawMarkdown: artifact.rawMarkdown, createdAt: artifact.createdAt, updatedAt: artifact.ingestedAt ?? artifact.createdAt,
    contentHash: artifact.contentHash,
    provenance: { schemaVersion: artifact.schemaVersion, producerRole: artifact.producerRole,
      repositoryKey: artifact.repositoryKey, gitHead: artifact.gitHead, sourceFingerprint: artifact.sourceFingerprint,
      ...(artifact.ingestedAt ? { ingestedAt: artifact.ingestedAt } : {}) } }
}
export function migrateLegacyStore(dbPath: string, repositoryKey: string, store: ArtifactStore, service: ContinuumService): void {
  const source = 'legacy-db:' + repositoryKey
  if (!existsSync(dbPath) || store.migrationComplete(source)) return
  const legacy = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const rows = legacy.prepare('SELECT * FROM artifacts ORDER BY artifact_id').iterate() as Iterable<Record<string, unknown>>
    for (const row of rows) {
      if (row.repository_key !== repositoryKey) throw new Error('LEGACY_REPOSITORY_MISMATCH: locator does not match this checkout')
      service.importArtifact(source, legacyInput({ artifactId: row.artifact_id as string, type: row.type as string,
        title: row.title as string, rawMarkdown: row.raw_markdown as string, createdAt: row.created_at as string,
        ingestedAt: row.ingested_at as string, contentHash: row.content_hash as string, repositoryKey,
        schemaVersion: row.schema_version as number, producerRole: row.producer_role as string,
        gitHead: row.git_head as string | null, sourceFingerprint: row.source_fingerprint as string | null }))
    }
    store.completeMigration(source)
  } finally { legacy.close() }
}
