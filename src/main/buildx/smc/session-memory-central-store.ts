import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  AppendSmcEntryInput,
  CreateSmcSessionInput,
  ListSmcEntriesOptions,
  ListSmcSessionsOptions,
  SmcEmitterRole,
  SmcEntryHeaderRecord,
  SmcEntryKind,
  SmcEntryPage,
  SmcEntryRecord,
  SmcReference,
  SmcReferenceKind,
  SmcSessionRecord,
  SmcSessionStatus
} from '../../../shared/types/buildx/session-memory-central-types'
import type {
  RegisterUnitFlowPlanInput,
  UnitFlowPlanRecord,
  UnitFlowPlanStatus
} from '../../../shared/types/unitflow-types'
import {
  UnitFlowActivePlanAlreadyExistsError,
  UnitFlowInvalidPlanError,
  UnitFlowPlanConflictError
} from '../../unitflow/unitflow-errors'
import { validateRepositoryId } from './session-memory-central-paths'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const VALID_ENTRY_KINDS: ReadonlySet<SmcEntryKind> = new Set([
  'DECISION',
  'EVIDENCE',
  'RESULT',
  'PENDING',
  'INTERVENTION'
])

const VALID_EMITTER_ROLES: ReadonlySet<SmcEmitterRole> = new Set([
  'HUMAN',
  'AGENT',
  'SYSTEM'
])

const VALID_REFERENCE_KINDS: ReadonlySet<SmcReferenceKind> = new Set([
  'COMMIT',
  'PROOF',
  'ARTIFACT',
  'OTHER'
])

const MAX_TITLE_LENGTH = 300
const MAX_BODY_LENGTH = 1024 * 1024 // 1 MiB
const MAX_REFERENCES_COUNT = 50
const MAX_REFERENCE_TARGET_LENGTH = 500
const MAX_EMITTER_ID_LENGTH = 200

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

export class SmcSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`SESSION_NOT_FOUND: Session with id "${sessionId}" not found`)
    this.name = 'SmcSessionNotFoundError'
  }
}

export class SmcSessionClosedError extends Error {
  constructor(sessionId: string) {
    super(`SESSION_CLOSED: Cannot append entry to closed session "${sessionId}"`)
    this.name = 'SmcSessionClosedError'
  }
}

export class SmcInvalidEntryError extends Error {
  constructor(reason: string) {
    super(`INVALID_ENTRY: ${reason}`)
    this.name = 'SmcInvalidEntryError'
  }
}

export class SmcEntryConflictError extends Error {
  constructor(reason: string) {
    super(`ENTRY_ID_CONFLICT: ${reason}`)
    this.name = 'SmcEntryConflictError'
  }
}

export class SmcInvalidSupersedesError extends Error {
  constructor(reason: string) {
    super(`INVALID_SUPERSEDES: ${reason}`)
    this.name = 'SmcInvalidSupersedesError'
  }
}

export class SmcUnsupportedSchemaError extends Error {
  constructor(version: number) {
    super(`SCHEMA_UNSUPPORTED: Database schema version ${version} is newer than supported version 3`)
    this.name = 'SmcUnsupportedSchemaError'
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

interface RawEntryRow {
  order_seq: number
  entry_id: string
  session_id: string
  kind: string
  title: string
  body: string
  emitter_role: string
  emitter_id: string | null
  references_json: string | null
  supersedes_entry_id: string | null
  created_at: string
}

interface RawPlanRow {
  plan_id: string
  session_id: string
  repository_id: string
  title: string
  source_artifact_id: string | null
  status: string
  revision: number
  created_at: string
  updated_at: string
}

interface SmcCursorPayload {
  orderSeq: number
  direction: 'ASC' | 'DESC'
  kind?: string
}

function encodeCursor(payload: SmcCursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

function decodeCursor(cursor: string): SmcCursorPayload {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.orderSeq !== 'number' || !Number.isFinite(parsed.orderSeq)) {
      throw new Error('Invalid cursor structure')
    }
    return parsed
  } catch {
    throw new SmcInvalidEntryError('Malformed or invalid pagination cursor')
  }
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

    this.initializeAndMigrate()
  }

  private initializeAndMigrate(): void {
    // 1. Cria tabela smc_meta se ainda não existir
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS smc_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)

    // 2. Valida ou define repositoryId
    const repoRow = this.db.prepare('SELECT value FROM smc_meta WHERE key = ?').get('repository_id') as { value: string } | undefined
    if (repoRow) {
      if (repoRow.value !== this.repositoryId) {
        this.db.close()
        throw new SmcRepositoryScopeMismatchError(repoRow.value, this.repositoryId)
      }
    } else {
      this.db.prepare('INSERT INTO smc_meta (key, value) VALUES (?, ?)').run('repository_id', this.repositoryId)
    }

    // 3. Verifica versão do esquema
    const versionRow = this.db.prepare('SELECT value FROM smc_meta WHERE key = ?').get('schema_version') as { value: string } | undefined
    const currentVersion = versionRow ? parseInt(versionRow.value, 10) : 0

    if (currentVersion > 3) {
      this.db.close()
      throw new SmcUnsupportedSchemaError(currentVersion)
    }

    // 4. Migração atômica de v0/v1/v2 para v3
    if (currentVersion < 3) {
      this.db.transaction(() => {
        if (currentVersion < 2) {
          // Tabelas base v1
          this.db.exec(`
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

          // Adições v2 (registros cumulativos de engenharia)
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS smc_entries (
              order_seq INTEGER PRIMARY KEY AUTOINCREMENT,
              entry_id TEXT UNIQUE NOT NULL,
              session_id TEXT NOT NULL,
              kind TEXT NOT NULL CHECK(kind IN ('DECISION', 'EVIDENCE', 'RESULT', 'PENDING', 'INTERVENTION')),
              title TEXT NOT NULL,
              body TEXT NOT NULL,
              emitter_role TEXT NOT NULL CHECK(emitter_role IN ('HUMAN', 'AGENT', 'SYSTEM')),
              emitter_id TEXT,
              references_json TEXT,
              supersedes_entry_id TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY (session_id) REFERENCES smc_sessions(session_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_smc_entries_session_order
              ON smc_entries (session_id, order_seq ASC);

            CREATE INDEX IF NOT EXISTS idx_smc_entries_session_kind
              ON smc_entries (session_id, kind, order_seq ASC);

            CREATE INDEX IF NOT EXISTS idx_smc_entries_supersedes
              ON smc_entries (supersedes_entry_id) WHERE supersedes_entry_id IS NOT NULL;
          `)
        }

        // Adições v3 (UnitFlow-01: Planos de sessão com constraint atômica de plano ativo único)
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS smc_plans (
            plan_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            repository_id TEXT NOT NULL,
            title TEXT NOT NULL,
            source_artifact_id TEXT,
            status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'COMPLETED', 'CANCELLED')),
            revision INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES smc_sessions(session_id) ON DELETE CASCADE
          );

          CREATE UNIQUE INDEX IF NOT EXISTS idx_smc_plans_active_session
            ON smc_plans (session_id) WHERE status = 'ACTIVE';

          CREATE INDEX IF NOT EXISTS idx_smc_plans_session_created
            ON smc_plans (session_id, created_at DESC);
        `)

        if (!versionRow) {
          this.db.prepare('INSERT INTO smc_meta (key, value) VALUES (?, ?)').run('schema_version', '3')
        } else {
          this.db.prepare('UPDATE smc_meta SET value = ? WHERE key = ?').run('3', 'schema_version')
        }
      })()
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

  appendEntry(sessionId: string, input: AppendSmcEntryInput): SmcEntryRecord {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new SmcInvalidEntryError('sessionId is required')
    }
    const cleanSessionId = sessionId.trim().toLowerCase()

    // 1. Valida existência e estado da sessão (OPEN)
    const sessionRow = this.db.prepare(`
      SELECT status FROM smc_sessions WHERE session_id = ? AND repository_id = ?
    `).get(cleanSessionId, this.repositoryId) as { status: string } | undefined

    if (!sessionRow) {
      throw new SmcSessionNotFoundError(cleanSessionId)
    }
    if (sessionRow.status === 'CLOSED') {
      throw new SmcSessionClosedError(cleanSessionId)
    }

    // 2. Validações defensivas de campos
    if (!input || typeof input !== 'object') {
      throw new SmcInvalidEntryError('Input payload is required')
    }

    if (!VALID_ENTRY_KINDS.has(input.kind)) {
      throw new SmcInvalidEntryError(`Invalid entry kind: "${input.kind}"`)
    }

    if (typeof input.title !== 'string' || !input.title.trim()) {
      throw new SmcInvalidEntryError('Entry title must be a non-empty string')
    }
    const cleanTitle = input.title.trim()
    if (cleanTitle.length > MAX_TITLE_LENGTH) {
      throw new SmcInvalidEntryError(`Entry title exceeds maximum length of ${MAX_TITLE_LENGTH} characters`)
    }

    if (typeof input.body !== 'string') {
      throw new SmcInvalidEntryError('Entry body must be a string')
    }
    if (input.body.length > MAX_BODY_LENGTH) {
      throw new SmcInvalidEntryError(`Entry body exceeds maximum length of ${MAX_BODY_LENGTH} characters`)
    }

    if (!input.provenance || typeof input.provenance !== 'object') {
      throw new SmcInvalidEntryError('Entry provenance is required')
    }
    if (!VALID_EMITTER_ROLES.has(input.provenance.role)) {
      throw new SmcInvalidEntryError(`Invalid provenance role: "${input.provenance.role}"`)
    }
    let cleanEmitterId: string | undefined
    if (input.provenance.emitterId !== undefined) {
      if (typeof input.provenance.emitterId !== 'string' || !input.provenance.emitterId.trim()) {
        throw new SmcInvalidEntryError('provenance.emitterId must be a non-empty string when provided')
      }
      cleanEmitterId = input.provenance.emitterId.trim()
      if (cleanEmitterId.length > MAX_EMITTER_ID_LENGTH) {
        throw new SmcInvalidEntryError(`provenance.emitterId exceeds maximum length of ${MAX_EMITTER_ID_LENGTH} characters`)
      }
    }

    let sanitizedReferences: SmcReference[] | undefined
    if (input.references !== undefined) {
      if (!Array.isArray(input.references)) {
        throw new SmcInvalidEntryError('references must be an array')
      }
      if (input.references.length > MAX_REFERENCES_COUNT) {
        throw new SmcInvalidEntryError(`references count exceeds maximum of ${MAX_REFERENCES_COUNT}`)
      }
      sanitizedReferences = input.references.map((ref, idx) => {
        if (!ref || typeof ref !== 'object') {
          throw new SmcInvalidEntryError(`Reference at index ${idx} must be an object`)
        }
        if (!VALID_REFERENCE_KINDS.has(ref.kind)) {
          throw new SmcInvalidEntryError(`Reference at index ${idx} has invalid kind: "${ref.kind}"`)
        }
        if (typeof ref.target !== 'string' || !ref.target.trim()) {
          throw new SmcInvalidEntryError(`Reference at index ${idx} target must be a non-empty string`)
        }
        const cleanTarget = ref.target.trim()
        if (cleanTarget.length > MAX_REFERENCE_TARGET_LENGTH) {
          throw new SmcInvalidEntryError(`Reference target at index ${idx} exceeds maximum length of ${MAX_REFERENCE_TARGET_LENGTH}`)
        }
        return { kind: ref.kind, target: cleanTarget }
      })
    }

    let cleanSupersedesId: string | undefined
    if (input.supersedesEntryId !== undefined) {
      if (typeof input.supersedesEntryId !== 'string' || !UUID_REGEX.test(input.supersedesEntryId.trim())) {
        throw new SmcInvalidSupersedesError(`supersedesEntryId must be a valid UUID format, received: "${input.supersedesEntryId}"`)
      }
      cleanSupersedesId = input.supersedesEntryId.trim().toLowerCase()

      // Valida que o registro supersedido existe na mesma sessão
      const existingSuper = this.db.prepare(`
        SELECT entry_id FROM smc_entries WHERE entry_id = ? AND session_id = ?
      `).get(cleanSupersedesId, cleanSessionId) as { entry_id: string } | undefined

      if (!existingSuper) {
        throw new SmcInvalidSupersedesError(`SUPERSEDES_ENTRY_NOT_FOUND: Referenced supersedesEntryId "${cleanSupersedesId}" does not exist in session "${cleanSessionId}"`)
      }
    }

    // 3. Trata ID e idempotência / divergência
    let entryId: string
    if (input.entryId !== undefined) {
      if (typeof input.entryId !== 'string' || !UUID_REGEX.test(input.entryId.trim())) {
        throw new SmcInvalidEntryError(`entryId must be a valid UUID format, received: "${input.entryId}"`)
      }
      entryId = input.entryId.trim().toLowerCase()

      const existing = this.db.prepare(`
        SELECT order_seq, entry_id, session_id, kind, title, body, emitter_role, emitter_id, references_json, supersedes_entry_id, created_at
        FROM smc_entries
        WHERE entry_id = ?
      `).get(entryId) as RawEntryRow | undefined

      if (existing) {
        if (existing.session_id !== cleanSessionId) {
          throw new SmcEntryConflictError(`Entry "${entryId}" belongs to another session`)
        }

        // Compara conteúdo para verificar se é replay idêntico ou divergência
        const existingRefs = existing.references_json ? (JSON.parse(existing.references_json) as SmcReference[]) : undefined
        const isIdentical =
          existing.kind === input.kind &&
          existing.title === cleanTitle &&
          existing.body === input.body &&
          existing.emitter_role === input.provenance.role &&
          (existing.emitter_id || undefined) === cleanEmitterId &&
          (existing.supersedes_entry_id || undefined) === cleanSupersedesId &&
          JSON.stringify(existingRefs ?? []) === JSON.stringify(sanitizedReferences ?? [])

        if (isIdentical) {
          // Replay idêntico: não duplica, retorna registro existente
          return this.mapRawToRecord(existing)
        } else {
          throw new SmcEntryConflictError(`An entry with id "${entryId}" already exists with divergent content`)
        }
      }
    } else {
      entryId = randomUUID().toLowerCase()
    }

    const now = new Date().toISOString()
    const referencesJson = sanitizedReferences && sanitizedReferences.length > 0 ? JSON.stringify(sanitizedReferences) : null

    this.db.prepare(`
      INSERT INTO smc_entries (
        entry_id, session_id, kind, title, body, emitter_role, emitter_id, references_json, supersedes_entry_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entryId,
      cleanSessionId,
      input.kind,
      cleanTitle,
      input.body,
      input.provenance.role,
      cleanEmitterId ?? null,
      referencesJson,
      cleanSupersedesId ?? null,
      now
    )

    return {
      entryId,
      sessionId: cleanSessionId,
      repositoryId: this.repositoryId,
      kind: input.kind,
      title: cleanTitle,
      body: input.body,
      provenance: {
        role: input.provenance.role,
        ...(cleanEmitterId ? { emitterId: cleanEmitterId } : {})
      },
      ...(sanitizedReferences && sanitizedReferences.length > 0 ? { references: sanitizedReferences } : {}),
      ...(cleanSupersedesId ? { supersedesEntryId: cleanSupersedesId } : {}),
      createdAt: now
    }
  }

  getEntry(sessionId: string, entryId: string): SmcEntryRecord | null {
    if (typeof sessionId !== 'string' || !sessionId.trim() || typeof entryId !== 'string' || !entryId.trim()) {
      return null
    }

    const row = this.db.prepare(`
      SELECT order_seq, entry_id, session_id, kind, title, body, emitter_role, emitter_id, references_json, supersedes_entry_id, created_at
      FROM smc_entries
      WHERE session_id = ? AND entry_id = ?
    `).get(sessionId.trim().toLowerCase(), entryId.trim().toLowerCase()) as RawEntryRow | undefined

    if (!row) {
      return null
    }

    return this.mapRawToRecord(row)
  }

  listEntries(sessionId: string, options?: ListSmcEntriesOptions): SmcEntryPage {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new SmcInvalidEntryError('sessionId is required')
    }
    const cleanSessionId = sessionId.trim().toLowerCase()

    const rawLimit = options?.limit
    const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(Math.floor(rawLimit), 100))
      : 50

    const direction: 'ASC' | 'DESC' = options?.direction === 'DESC' ? 'DESC' : 'ASC'

    const whereClauses: string[] = ['session_id = ?']
    const params: (string | number)[] = [cleanSessionId]

    if (options?.kind) {
      if (!VALID_ENTRY_KINDS.has(options.kind)) {
        throw new SmcInvalidEntryError(`Invalid filter kind: "${options.kind}"`)
      }
      whereClauses.push('kind = ?')
      params.push(options.kind)
    }

    if (options?.cursor) {
      const cursorPayload = decodeCursor(options.cursor)
      if (direction === 'ASC') {
        whereClauses.push('order_seq > ?')
      } else {
        whereClauses.push('order_seq < ?')
      }
      params.push(cursorPayload.orderSeq)
    }

    const orderOperator = direction === 'ASC' ? 'ASC' : 'DESC'
    // Bounded fetch: busca limit + 1 para identificar se há próxima página
    params.push(limit + 1)

    // Note: SELECT NÃO traz body, apenas projeção metadata compacta
    const rows = this.db.prepare(`
      SELECT order_seq, entry_id, session_id, kind, title, emitter_role, emitter_id, references_json, supersedes_entry_id, created_at
      FROM smc_entries
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY order_seq ${orderOperator}
      LIMIT ?
    `).all(...params) as Omit<RawEntryRow, 'body'>[]

    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows

    const entries = pageRows.map((row) => this.mapRawToHeader(row))

    let nextCursor: string | undefined
    if (hasMore && pageRows.length > 0) {
      const lastRow = pageRows[pageRows.length - 1]
      nextCursor = encodeCursor({
        orderSeq: lastRow.order_seq,
        direction,
        ...(options?.kind ? { kind: options.kind } : {})
      })
    }

    return {
      entries,
      ...(nextCursor ? { nextCursor } : {})
    }
  }

  private mapRawToHeader(row: Omit<RawEntryRow, 'body'>): SmcEntryHeaderRecord {
    const references = row.references_json ? (JSON.parse(row.references_json) as SmcReference[]) : undefined
    return {
      entryId: row.entry_id,
      sessionId: row.session_id,
      repositoryId: this.repositoryId,
      kind: row.kind as SmcEntryKind,
      title: row.title,
      provenance: {
        role: row.emitter_role as SmcEmitterRole,
        ...(row.emitter_id ? { emitterId: row.emitter_id } : {})
      },
      ...(references && references.length > 0 ? { references } : {}),
      ...(row.supersedes_entry_id ? { supersedesEntryId: row.supersedes_entry_id } : {}),
      createdAt: row.created_at
    }
  }

  private mapRawToRecord(row: RawEntryRow): SmcEntryRecord {
    return {
      ...this.mapRawToHeader(row),
      body: row.body
    }
  }

  registerPlan(sessionId: string, input: RegisterUnitFlowPlanInput): UnitFlowPlanRecord {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new SmcInvalidSessionIdError(String(sessionId))
    }
    const cleanSessionId = sessionId.trim().toLowerCase()
    if (!UUID_REGEX.test(cleanSessionId)) {
      throw new SmcInvalidSessionIdError(cleanSessionId)
    }

    if (!input || typeof input !== 'object') {
      throw new UnitFlowInvalidPlanError('Input payload is required')
    }

    if (typeof input.planId !== 'string' || !input.planId.trim()) {
      throw new UnitFlowInvalidPlanError('planId is required')
    }
    const cleanPlanId = input.planId.trim().toLowerCase()
    if (!UUID_REGEX.test(cleanPlanId)) {
      throw new UnitFlowInvalidPlanError(`planId must be a valid UUID format, received: "${input.planId}"`)
    }

    if (typeof input.title !== 'string' || !input.title.trim()) {
      throw new UnitFlowInvalidPlanError('Plan title must be a non-empty string')
    }
    const cleanTitle = input.title.trim()
    if (cleanTitle.length > MAX_TITLE_LENGTH) {
      throw new UnitFlowInvalidPlanError(`Plan title exceeds maximum length of ${MAX_TITLE_LENGTH} characters`)
    }

    let cleanSourceArtifactId: string | undefined
    if (input.sourceArtifactId !== undefined) {
      if (typeof input.sourceArtifactId !== 'string' || !input.sourceArtifactId.trim()) {
        throw new UnitFlowInvalidPlanError('sourceArtifactId must be a non-empty string when provided')
      }
      cleanSourceArtifactId = input.sourceArtifactId.trim()
      if (cleanSourceArtifactId.length > 200) {
        throw new UnitFlowInvalidPlanError('sourceArtifactId exceeds maximum length of 200 characters')
      }
    }

    return this.db.transaction(() => {
      // 1. Valida existência e estado da sessão
      const sessionRow = this.db.prepare(`
        SELECT status FROM smc_sessions WHERE session_id = ? AND repository_id = ?
      `).get(cleanSessionId, this.repositoryId) as { status: string } | undefined

      if (!sessionRow) {
        throw new SmcSessionNotFoundError(cleanSessionId)
      }
      if (sessionRow.status === 'CLOSED') {
        throw new SmcSessionClosedError(cleanSessionId)
      }

      // 2. Trata replay idempotente e divergência pelo mesmo planId
      const existingByPlanId = this.db.prepare(`
        SELECT plan_id, session_id, repository_id, title, source_artifact_id, status, revision, created_at, updated_at
        FROM smc_plans
        WHERE plan_id = ?
      `).get(cleanPlanId) as RawPlanRow | undefined

      if (existingByPlanId) {
        if (existingByPlanId.session_id !== cleanSessionId) {
          throw new UnitFlowPlanConflictError(`Plan "${cleanPlanId}" belongs to another session "${existingByPlanId.session_id}"`)
        }

        const isIdentical =
          existingByPlanId.title === cleanTitle &&
          (existingByPlanId.source_artifact_id || undefined) === cleanSourceArtifactId

        if (isIdentical) {
          return this.mapRawToPlanRecord(existingByPlanId)
        } else {
          throw new UnitFlowPlanConflictError(`Plan with id "${cleanPlanId}" already exists in session "${cleanSessionId}" with divergent content`)
        }
      }

      // 3. Verifica se a sessão já possui um plano ACTIVE
      const existingActive = this.db.prepare(`
        SELECT plan_id FROM smc_plans WHERE session_id = ? AND status = 'ACTIVE'
      `).get(cleanSessionId) as { plan_id: string } | undefined

      if (existingActive) {
        throw new UnitFlowActivePlanAlreadyExistsError(cleanSessionId, existingActive.plan_id)
      }

      // 4. Insere o novo plano ACTIVE
      const now = new Date().toISOString()
      try {
        this.db.prepare(`
          INSERT INTO smc_plans (
            plan_id, session_id, repository_id, title, source_artifact_id, status, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', 1, ?, ?)
        `).run(
          cleanPlanId,
          cleanSessionId,
          this.repositoryId,
          cleanTitle,
          cleanSourceArtifactId ?? null,
          now,
          now
        )
      } catch (error: any) {
        if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || error?.message?.includes('UNIQUE constraint failed')) {
          if (error?.message?.includes('idx_smc_plans_active_session') || error?.message?.includes('smc_plans.session_id')) {
            const active = this.db.prepare('SELECT plan_id FROM smc_plans WHERE session_id = ? AND status = "ACTIVE"').get(cleanSessionId) as { plan_id: string } | undefined
            throw new UnitFlowActivePlanAlreadyExistsError(cleanSessionId, active?.plan_id ?? 'unknown')
          }
          if (error?.message?.includes('smc_plans.plan_id') || error?.message?.includes('PRIMARYKEY')) {
            throw new UnitFlowPlanConflictError(`Plan with id "${cleanPlanId}" already exists`)
          }
          throw new UnitFlowPlanConflictError(`Database constraint violation: ${error.message}`)
        }
        throw error
      }

      const status: UnitFlowPlanStatus = 'ACTIVE'
      return {
        planId: cleanPlanId,
        sessionId: cleanSessionId,
        repositoryId: this.repositoryId,
        title: cleanTitle,
        ...(cleanSourceArtifactId ? { sourceArtifactId: cleanSourceArtifactId } : {}),
        status,
        revision: 1,
        createdAt: now,
        updatedAt: now
      }
    })()
  }

  getActivePlan(sessionId: string): UnitFlowPlanRecord | null {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return null
    }
    const cleanSessionId = sessionId.trim().toLowerCase()
    if (!UUID_REGEX.test(cleanSessionId)) {
      return null
    }

    const row = this.db.prepare(`
      SELECT plan_id, session_id, repository_id, title, source_artifact_id, status, revision, created_at, updated_at
      FROM smc_plans
      WHERE session_id = ? AND repository_id = ? AND status = 'ACTIVE'
    `).get(cleanSessionId, this.repositoryId) as RawPlanRow | undefined

    if (!row) {
      return null
    }

    return this.mapRawToPlanRecord(row)
  }

  getPlan(planId: string): UnitFlowPlanRecord | null {
    if (typeof planId !== 'string' || !planId.trim()) {
      return null
    }
    const cleanPlanId = planId.trim().toLowerCase()
    if (!UUID_REGEX.test(cleanPlanId)) {
      return null
    }

    const row = this.db.prepare(`
      SELECT plan_id, session_id, repository_id, title, source_artifact_id, status, revision, created_at, updated_at
      FROM smc_plans
      WHERE plan_id = ? AND repository_id = ?
    `).get(cleanPlanId, this.repositoryId) as RawPlanRow | undefined

    if (!row) {
      return null
    }

    return this.mapRawToPlanRecord(row)
  }

  private mapRawToPlanRecord(row: RawPlanRow): UnitFlowPlanRecord {
    return {
      planId: row.plan_id,
      sessionId: row.session_id,
      repositoryId: row.repository_id || this.repositoryId,
      title: row.title,
      ...(row.source_artifact_id ? { sourceArtifactId: row.source_artifact_id } : {}),
      status: row.status as UnitFlowPlanStatus,
      revision: Number(row.revision),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
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
