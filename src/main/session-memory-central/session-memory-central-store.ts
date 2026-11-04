import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  CreateSmcSessionInput,
  ListSmcSessionsOptions,
  SmcSessionRecord,
  SmcSessionStatus
} from '../../shared/types/session-memory-central-types'
import { validateRepositoryId } from './session-memory-central-paths'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class SmcRepositoryScopeMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`REPOSITORY_SCOPE_MISMATCH: Store was initialized for repository "${expected}" but opened for "${actual}"`)
    this.name = 'SmcRepositoryScopeMismatchError'
  }
}

export class SmcInvalidSessionIdError extends Error {
  constructor(id: string) {
    super(`INVALID_SESSION_ID: sessionId must be a valid UUID format, received: "${id}"`)
    this.name = 'SmcInvalidSessionIdError'
  }
}

export class SmcSessionAlreadyExistsError extends Error {
  constructor(sessionId: string) {
    super(`SESSION_ALREADY_EXISTS: Session with id "${sessionId}" already exists`)
    this.name = 'SmcSessionAlreadyExistsError'
  }
}

interface RawSessionRow {
  session_id: string
  repository_id: string
  status: string
  revision: number
  created_at: string
  updated_at: string
}

export class SessionMemoryCentralStore {
  readonly repositoryId: string
  private readonly db: Database.Database

  constructor(readonly databasePath: string, repositoryId: string) {
    this.repositoryId = validateRepositoryId(repositoryId)
    mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new Database(databasePath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS smc_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS smc_sessions (
        session_id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('OPEN', 'CLOSED')),
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_smc_sessions_repo_created
        ON smc_sessions (repository_id, created_at DESC, session_id ASC);
    `)

    const row = this.db.prepare('SELECT value FROM smc_meta WHERE key = ?').get('repository_id') as { value: string } | undefined
    if (row) {
      if (row.value !== this.repositoryId) {
        this.db.close()
        throw new SmcRepositoryScopeMismatchError(row.value, this.repositoryId)
      }
    } else {
      this.db.prepare('INSERT INTO smc_meta (key, value) VALUES (?, ?)').run('repository_id', this.repositoryId)
      this.db.prepare('INSERT INTO smc_meta (key, value) VALUES (?, ?)').run('schema_version', '1')
    }
  }

  createSession(input?: CreateSmcSessionInput): SmcSessionRecord {
    let sessionId: string
    if (input?.sessionId !== undefined) {
      if (typeof input.sessionId !== 'string' || !UUID_REGEX.test(input.sessionId.trim())) {
        throw new SmcInvalidSessionIdError(String(input.sessionId))
      }
      sessionId = input.sessionId.trim().toLowerCase()
    } else {
      sessionId = randomUUID().toLowerCase()
    }

    const now = new Date().toISOString()
    const status: SmcSessionStatus = 'OPEN'
    const revision = 1

    try {
      this.db.prepare(`
        INSERT INTO smc_sessions (session_id, repository_id, status, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(sessionId, this.repositoryId, status, revision, now, now)
    } catch (error: any) {
      if (error?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error?.message?.includes('UNIQUE constraint failed')) {
        throw new SmcSessionAlreadyExistsError(sessionId)
      }
      throw error
    }

    return {
      sessionId,
      repositoryId: this.repositoryId,
      status,
      revision,
      createdAt: now,
      updatedAt: now
    }
  }

  getSession(sessionId: string): SmcSessionRecord | null {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return null
    }

    const row = this.db.prepare(`
      SELECT session_id, repository_id, status, revision, created_at, updated_at
      FROM smc_sessions
      WHERE session_id = ? AND repository_id = ?
    `).get(sessionId.trim().toLowerCase(), this.repositoryId) as RawSessionRow | undefined

    if (!row) {
      return null
    }

    return {
      sessionId: row.session_id,
      repositoryId: row.repository_id,
      status: row.status as SmcSessionStatus,
      revision: Number(row.revision),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  listSessions(options?: ListSmcSessionsOptions): SmcSessionRecord[] {
    const rawLimit = options?.limit
    const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(Math.floor(rawLimit), 100))
      : 50

    const rows = this.db.prepare(`
      SELECT session_id, repository_id, status, revision, created_at, updated_at
      FROM smc_sessions
      WHERE repository_id = ?
      ORDER BY created_at DESC, session_id ASC
      LIMIT ?
    `).all(this.repositoryId, limit) as RawSessionRow[]

    return rows.map((row) => ({
      sessionId: row.session_id,
      repositoryId: row.repository_id,
      status: row.status as SmcSessionStatus,
      revision: Number(row.revision),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  }

  close(): void {
    if (this.db && this.db.open) {
      this.db.close()
    }
  }

  isOpen(): boolean {
    return Boolean(this.db && this.db.open)
  }
}
