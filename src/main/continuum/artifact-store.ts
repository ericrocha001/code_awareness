import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  AppendArtifactInput,
  Artifact,
  ArtifactSummary,
  ArtifactType,
  IArtifactStore,
  ListArtifactsFilter,
  ProducerRole
} from './continuum-types'
import { SUPPORTED_ARTIFACT_TYPES, SUPPORTED_PRODUCER_ROLES } from './continuum-types'

interface ArtifactRow {
  artifact_id: string
  type: string
  schema_version: number
  title: string
  producer_role: string
  repository_key: string
  created_at: string
  ingested_at: string
  source_fingerprint: string | null
  git_head: string | null
  content_hash: string
  raw_markdown: string
}

export class ArtifactIdentityConflictError extends Error {
  readonly artifactId: string
  constructor(artifactId: string) {
    super(`CONFLICT: Artifact "${artifactId}" already exists with different content`)
    this.name = 'ArtifactIdentityConflictError'
    this.artifactId = artifactId
  }
}

export class ArtifactContentIntegrityError extends Error {
  constructor(message = 'INTEGRITY_ERROR: contentHash does not match computed hash of rawMarkdown') {
    super(message)
    this.name = 'ArtifactContentIntegrityError'
  }
}

export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export class ArtifactStore implements IArtifactStore {
  private readonly db: BetterSqlite3Database

  constructor(dbPath: string) {
    const parentDir = dirname(dbPath)
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true })
    }

    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.ensureSchema()
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        title TEXT NOT NULL,
        producer_role TEXT NOT NULL,
        repository_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        source_fingerprint TEXT,
        git_head TEXT,
        content_hash TEXT NOT NULL,
        raw_markdown TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(type);
      CREATE INDEX IF NOT EXISTS idx_artifacts_producer_role ON artifacts(producer_role);
      CREATE INDEX IF NOT EXISTS idx_artifacts_repository_key ON artifacts(repository_key);
      CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at DESC);
    `)
  }

  private rowToArtifact(row: ArtifactRow): Artifact {
    return {
      artifactId: row.artifact_id,
      type: row.type as ArtifactType,
      schemaVersion: row.schema_version,
      title: row.title,
      producerRole: row.producer_role as ProducerRole,
      repositoryKey: row.repository_key,
      createdAt: row.created_at,
      ingestedAt: row.ingested_at,
      sourceFingerprint: row.source_fingerprint,
      gitHead: row.git_head,
      contentHash: row.content_hash,
      rawMarkdown: row.raw_markdown
    }
  }

  append(input: AppendArtifactInput): Artifact {
    if (typeof input.artifactId !== 'string' || input.artifactId.trim().length === 0) {
      throw new Error('INVALID_ARGUMENT: artifactId must be a non-empty string')
    }
    if (!SUPPORTED_ARTIFACT_TYPES.has(input.type)) {
      throw new Error(`INVALID_ARGUMENT: Unsupported artifact type "${input.type}"`)
    }
    if (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1) {
      throw new Error('INVALID_ARGUMENT: schemaVersion must be an integer >= 1')
    }
    if (typeof input.title !== 'string' || input.title.trim().length === 0) {
      throw new Error('INVALID_ARGUMENT: title must be a non-empty string')
    }
    if (!SUPPORTED_PRODUCER_ROLES.has(input.producerRole)) {
      throw new Error(`INVALID_ARGUMENT: Unsupported producer role "${input.producerRole}"`)
    }
    if (typeof input.repositoryKey !== 'string' || input.repositoryKey.trim().length === 0) {
      throw new Error('INVALID_ARGUMENT: repositoryKey must be a non-empty string')
    }
    if (typeof input.createdAt !== 'string' || input.createdAt.trim().length === 0) {
      throw new Error('INVALID_ARGUMENT: createdAt must be a non-empty string')
    }
    if (typeof input.rawMarkdown !== 'string') {
      throw new Error('INVALID_ARGUMENT: rawMarkdown must be a string')
    }

    const computedHash = computeContentHash(input.rawMarkdown)
    if (input.contentHash && input.contentHash !== computedHash) {
      throw new ArtifactContentIntegrityError('INTEGRITY_ERROR: contentHash does not match computed hash of rawMarkdown')
    }

    const contentHash = computedHash
    const ingestedAt = input.ingestedAt ?? new Date().toISOString()
    const sourceFingerprint = input.sourceFingerprint ?? null
    const gitHead = input.gitHead ?? null

    const appendTx = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM artifacts WHERE artifact_id = ?')
        .get(input.artifactId) as ArtifactRow | undefined

      if (existing) {
        if (existing.content_hash === contentHash && existing.raw_markdown === input.rawMarkdown) {
          return this.rowToArtifact(existing)
        }
        throw new ArtifactIdentityConflictError(input.artifactId)
      }

      this.db
        .prepare(`
          INSERT INTO artifacts (
            artifact_id, type, schema_version, title, producer_role, repository_key,
            created_at, ingested_at, source_fingerprint, git_head, content_hash, raw_markdown
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.artifactId,
          input.type,
          input.schemaVersion,
          input.title,
          input.producerRole,
          input.repositoryKey,
          input.createdAt,
          ingestedAt,
          sourceFingerprint,
          gitHead,
          contentHash,
          input.rawMarkdown
        )

      return {
        artifactId: input.artifactId,
        type: input.type,
        schemaVersion: input.schemaVersion,
        title: input.title,
        producerRole: input.producerRole,
        repositoryKey: input.repositoryKey,
        createdAt: input.createdAt,
        ingestedAt,
        sourceFingerprint,
        gitHead,
        contentHash,
        rawMarkdown: input.rawMarkdown
      }
    })

    return appendTx()
  }

  get(artifactId: string): Artifact | null {
    if (!artifactId || typeof artifactId !== 'string') return null
    const row = this.db
      .prepare('SELECT * FROM artifacts WHERE artifact_id = ?')
      .get(artifactId) as ArtifactRow | undefined
    return row ? this.rowToArtifact(row) : null
  }

  list(filter: ListArtifactsFilter = {}): ArtifactSummary[] {
    let query = `
      SELECT artifact_id, type, schema_version, title, producer_role, repository_key,
             created_at, ingested_at, source_fingerprint, git_head, content_hash
      FROM artifacts
      WHERE 1=1
    `
    const params: (string | number)[] = []

    if (filter.type) {
      query += ' AND type = ?'
      params.push(filter.type)
    }
    if (filter.producerRole) {
      query += ' AND producer_role = ?'
      params.push(filter.producerRole)
    }
    if (filter.repositoryKey) {
      query += ' AND repository_key = ?'
      params.push(filter.repositoryKey)
    }

    query += ' ORDER BY created_at DESC'

    if (filter.limit !== undefined && Number.isInteger(filter.limit) && filter.limit > 0) {
      query += ' LIMIT ?'
      params.push(filter.limit)
    }

    const rows = this.db.prepare(query).all(...params) as Omit<ArtifactRow, 'raw_markdown'>[]
    return rows.map((row) => ({
      artifactId: row.artifact_id,
      type: row.type as ArtifactType,
      schemaVersion: row.schema_version,
      title: row.title,
      producerRole: row.producer_role as ProducerRole,
      repositoryKey: row.repository_key,
      createdAt: row.created_at,
      ingestedAt: row.ingested_at,
      sourceFingerprint: row.source_fingerprint,
      gitHead: row.git_head,
      contentHash: row.content_hash
    }))
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // Ignore close errors
    }
  }
}
