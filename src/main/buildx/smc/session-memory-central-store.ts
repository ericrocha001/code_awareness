import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
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
  DefineUnitFlowUnitInput,
  RegisterUnitFlowPlanInput,
  UnitFlowEligibilityResult,
  UnitFlowPlanRecord,
  UnitFlowPlanStatus,
  UnitFlowReservationRecord,
  UnitFlowReservationResult,
  UnitFlowReservationStatus,
  UnitFlowUnitHeaderRecord,
  UnitFlowUnitRecord,
  UnitFlowUnitStateRecord,
  UnitFlowUnitStatus,
  AcceptUnitFlowUnitStoreInput,
  AcceptUnitFlowUnitStoreResult,
  ReconcileUnitFlowUnitStoreInput,
  ReconcileUnitFlowUnitStoreResult
} from '../../../shared/types/buildx/unitflow-types'
import type {
  BuildXWorkspaceBindingRecord,
  SaveWorkspaceBindingInput
} from '../../../shared/types/buildx/workspace-types'
import type {
  ExecutionAttemptRecord,
  ExecutionAttemptStatus,
  SettleExecutionAttemptStoreInput
} from '../../../shared/types/buildx/execution-types'
import {
  BuildXWorkspaceBindingConflictError
} from '../execution/workspace-binding-errors'
import {
  ExecutionAttemptConflictError,
  ExecutionAttemptIdConflictError,
  ExecutionInvalidAttemptIdError,
  ExecutionAttemptNotFoundError
} from '../execution/execution-errors'
import {
  UnitFlowActivePlanAlreadyExistsError,
  UnitFlowInvalidPlanError,
  UnitFlowInvalidReservationIdError,
  UnitFlowInvalidUnitError,
  UnitFlowManifestConflictError,
  UnitFlowPlanConflictError,
  UnitFlowPlanNotFoundError,
  UnitFlowReservationConflictError,
  UnitFlowReservationIdConflictError,
  UnitFlowReservationNotFoundError,
  UnitFlowUnitConflictError,
  UnitFlowAcceptanceConflictError,
  UnitFlowReconciliationConflictError
} from '../unitflow/unitflow-errors'
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

const MAX_UNITS_COUNT = 100
const MAX_UNIT_TITLE_LENGTH = 300
const MAX_UNIT_TEXT_LENGTH = 64 * 1024

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
    super(`SCHEMA_UNSUPPORTED: Database schema version ${version} is newer than supported version 8`)
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

interface RawUnitRow {
  unit_id: string
  plan_id: string
  position: number
  title: string
  objective?: string
  acceptance_criteria?: string
  depends_on_json: string | null
  created_at: string
}

interface RawUnitStateRow {
  unit_id: string
  plan_id: string
  status: string
  revision: number
  created_at: string
  updated_at: string
}

interface RawWorkspaceBindingRow {
  session_id: string
  repository_id: string
  worktree_id: string
  generation: string
  branch: string
  head_at_bind: string
  created_at: string
  updated_at: string
}

interface RawReservationRow {
  reservation_id: string
  repository_id: string
  session_id: string
  plan_id: string
  unit_id: string
  worktree_id: string
  generation: string
  branch: string
  head_observed_at_reservation: string
  unit_state_revision: number
  status: string
  created_at: string
  updated_at: string
}

export interface ReserveEligibleUnitInput {
  readonly reservationId: string
  readonly sessionId: string
  readonly planId: string
  readonly expectedBinding: {
    readonly worktreeId: string
    readonly generation: string
    readonly branch: string
  }
  readonly headObserved: string
}

interface RawExecutionAttemptRow {
  attempt_id: string
  repository_id: string
  session_id: string
  plan_id: string
  unit_id: string
  reservation_id: string
  worktree_id: string
  generation: string
  branch: string
  head_observed_at_preparation: string
  status: string
  revision: number
  created_at: string
  updated_at: string
}

export interface PrepareExecutionAttemptInput {
  readonly attemptId: string
  readonly sessionId: string
  readonly reservationId: string
  readonly expectedBinding: {
    readonly worktreeId: string
    readonly generation: string
    readonly branch: string
  }
  readonly headObserved: string
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


export function deterministicEntryId(prefix: string, attemptId: string): string {
  const hash = createHash('sha256').update(`${prefix}:${attemptId}`).digest('hex')
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    '8' + hash.slice(17, 20),
    hash.slice(20, 32)
  ].join('-')
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

    if (currentVersion > 8) {
      this.db.close()
      throw new SmcUnsupportedSchemaError(currentVersion)
    }

    // 4. Migração atômica de v0..v7 para v8
    if (currentVersion < 8) {
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

        if (currentVersion < 3) {
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
        }

        if (currentVersion < 4) {
          // Adições v4 (UnitFlow-02: Definição ordenada de unidades e dependências)
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS smc_plan_units (
              unit_id TEXT PRIMARY KEY,
              plan_id TEXT NOT NULL,
              position INTEGER NOT NULL,
              title TEXT NOT NULL,
              objective TEXT NOT NULL,
              acceptance_criteria TEXT NOT NULL,
              depends_on_json TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY (plan_id) REFERENCES smc_plans(plan_id) ON DELETE CASCADE,
              UNIQUE (plan_id, position)
            );

            CREATE INDEX IF NOT EXISTS idx_smc_plan_units_plan_pos
              ON smc_plan_units (plan_id, position ASC);
          `)
        }

        if (currentVersion < 5) {
          // Adições v5 (UnitFlow-03: Estado operacional inicial por unidade)
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS smc_unit_states (
              unit_id TEXT PRIMARY KEY,
              plan_id TEXT NOT NULL,
              status TEXT NOT NULL CHECK(status IN ('AVAILABLE', 'RESERVED', 'EXECUTING', 'VALIDATING', 'COMPLETED', 'RECONCILING')),
              revision INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY (unit_id) REFERENCES smc_plan_units(unit_id) ON DELETE CASCADE,
              FOREIGN KEY (plan_id) REFERENCES smc_plans(plan_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_smc_unit_states_plan
              ON smc_unit_states (plan_id, unit_id ASC);
          `)

          // Para unidades já existentes em v4, criar estados iniciais AVAILABLE
          const existingUnits = this.db.prepare(`
            SELECT unit_id, plan_id FROM smc_plan_units
          `).all() as { unit_id: string; plan_id: string }[]

          if (existingUnits.length > 0) {
            const now = new Date().toISOString()
            const insertState = this.db.prepare(`
              INSERT OR IGNORE INTO smc_unit_states (unit_id, plan_id, status, revision, created_at, updated_at)
              VALUES (?, ?, 'AVAILABLE', 1, ?, ?)
            `)
            for (const u of existingUnits) {
              insertState.run(u.unit_id, u.plan_id, now, now)
            }
          }
        }

        if (currentVersion < 6) {
          // Adições v6 (Workspace-01: Vínculo durável de sessão à Worktree Git)
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS smc_session_worktrees (
              session_id TEXT PRIMARY KEY,
              repository_id TEXT NOT NULL,
              worktree_id TEXT NOT NULL,
              generation TEXT NOT NULL,
              branch TEXT NOT NULL,
              head_at_bind TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY (session_id) REFERENCES smc_sessions(session_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_smc_session_worktrees_repo_tree
              ON smc_session_worktrees (repository_id, worktree_id);
          `)
        }

        if (currentVersion < 7) {
          // Adições v7 (UnitFlow-04: Recibos duráveis de reserva atômica de unidades)
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS smc_unit_reservations (
              reservation_id TEXT PRIMARY KEY,
              repository_id TEXT NOT NULL,
              session_id TEXT NOT NULL,
              plan_id TEXT NOT NULL,
              unit_id TEXT NOT NULL,
              worktree_id TEXT NOT NULL,
              generation TEXT NOT NULL,
              branch TEXT NOT NULL,
              head_observed_at_reservation TEXT NOT NULL,
              unit_state_revision INTEGER NOT NULL,
              status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'CONSUMED', 'CANCELLED')),
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY (session_id) REFERENCES smc_sessions(session_id) ON DELETE CASCADE,
              FOREIGN KEY (plan_id) REFERENCES smc_plans(plan_id) ON DELETE CASCADE,
              FOREIGN KEY (unit_id) REFERENCES smc_plan_units(unit_id) ON DELETE CASCADE
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_smc_unit_reservations_active_session
              ON smc_unit_reservations (session_id) WHERE status = 'ACTIVE';

            CREATE UNIQUE INDEX IF NOT EXISTS idx_smc_unit_reservations_active_unit
              ON smc_unit_reservations (unit_id) WHERE status = 'ACTIVE';

            CREATE UNIQUE INDEX IF NOT EXISTS idx_smc_unit_reservations_active_worktree
              ON smc_unit_reservations (repository_id, worktree_id, generation) WHERE status = 'ACTIVE';

            CREATE INDEX IF NOT EXISTS idx_smc_unit_reservations_repo_session
              ON smc_unit_reservations (repository_id, session_id);
          `)
        }

        if (currentVersion < 8) {
          // Adições v8 (Execution-01: Preparação durável de tentativa vinculada à reserva)
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS smc_execution_attempts (
              attempt_id TEXT PRIMARY KEY,
              repository_id TEXT NOT NULL,
              session_id TEXT NOT NULL,
              plan_id TEXT NOT NULL,
              unit_id TEXT NOT NULL,
              reservation_id TEXT NOT NULL,
              worktree_id TEXT NOT NULL,
              generation TEXT NOT NULL,
              branch TEXT NOT NULL,
              head_observed_at_preparation TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'PREPARED' CHECK(status IN ('PREPARED', 'STARTING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
              revision INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY (session_id) REFERENCES smc_sessions(session_id) ON DELETE CASCADE,
              FOREIGN KEY (plan_id) REFERENCES smc_plans(plan_id) ON DELETE CASCADE,
              FOREIGN KEY (unit_id) REFERENCES smc_plan_units(unit_id) ON DELETE CASCADE,
              FOREIGN KEY (reservation_id) REFERENCES smc_unit_reservations(reservation_id) ON DELETE CASCADE
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_smc_execution_attempts_prepared_session
              ON smc_execution_attempts (session_id) WHERE status = 'PREPARED';

            CREATE UNIQUE INDEX IF NOT EXISTS idx_smc_execution_attempts_prepared_reservation
              ON smc_execution_attempts (reservation_id) WHERE status = 'PREPARED';

            CREATE INDEX IF NOT EXISTS idx_smc_execution_attempts_repo_session
              ON smc_execution_attempts (repository_id, session_id);

            CREATE INDEX IF NOT EXISTS idx_smc_execution_attempts_reservation
              ON smc_execution_attempts (reservation_id);
          `)
        }

        if (!versionRow) {
          this.db.prepare('INSERT INTO smc_meta (key, value) VALUES (?, ?)').run('schema_version', '8')
        } else {
          this.db.prepare('UPDATE smc_meta SET value = ? WHERE key = ?').run('8', 'schema_version')
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

  definePlanUnits(sessionId: string, planId: string, units: DefineUnitFlowUnitInput[]): UnitFlowUnitRecord[] {
    if (typeof sessionId !== 'string' || !sessionId.trim() || !UUID_REGEX.test(sessionId.trim())) {
      throw new SmcInvalidSessionIdError(sessionId ?? '')
    }
    const cleanSessionId = sessionId.trim().toLowerCase()

    if (typeof planId !== 'string' || !planId.trim() || !UUID_REGEX.test(planId.trim())) {
      throw new UnitFlowInvalidPlanError(`planId must be a valid UUID format, received: "${planId}"`)
    }
    const cleanPlanId = planId.trim().toLowerCase()

    if (!Array.isArray(units) || units.length === 0) {
      throw new UnitFlowInvalidUnitError('Units manifest must be a non-empty array')
    }
    if (units.length > MAX_UNITS_COUNT) {
      throw new UnitFlowInvalidUnitError(`Units manifest exceeds maximum allowed count of ${MAX_UNITS_COUNT}`)
    }

    const seenUnitIds = new Set<string>()
    const sanitizedUnits: Array<{
      unitId: string
      title: string
      objective: string
      acceptanceCriteria: string
      dependsOnUnitIds: string[]
    }> = []

    for (let i = 0; i < units.length; i++) {
      const u = units[i]
      if (!u || typeof u !== 'object') {
        throw new UnitFlowInvalidUnitError(`Unit at index ${i} must be an object`)
      }

      if (typeof u.unitId !== 'string' || !u.unitId.trim() || !UUID_REGEX.test(u.unitId.trim())) {
        throw new UnitFlowInvalidUnitError(`Unit at index ${i} has invalid unitId UUID format: "${u.unitId}"`)
      }
      const cleanUnitId = u.unitId.trim().toLowerCase()

      if (seenUnitIds.has(cleanUnitId)) {
        throw new UnitFlowInvalidUnitError(`Duplicate unitId in manifest: "${cleanUnitId}" at index ${i}`)
      }

      if (typeof u.title !== 'string' || !u.title.trim()) {
        throw new UnitFlowInvalidUnitError(`Unit "${cleanUnitId}" title must be a non-empty string`)
      }
      const cleanTitle = u.title.trim()
      if (cleanTitle.length > MAX_UNIT_TITLE_LENGTH) {
        throw new UnitFlowInvalidUnitError(`Unit "${cleanUnitId}" title exceeds maximum length of ${MAX_UNIT_TITLE_LENGTH} characters`)
      }

      if (typeof u.objective !== 'string' || !u.objective.trim()) {
        throw new UnitFlowInvalidUnitError(`Unit "${cleanUnitId}" objective must be a non-empty string`)
      }
      const cleanObjective = u.objective.trim()
      if (cleanObjective.length > MAX_UNIT_TEXT_LENGTH) {
        throw new UnitFlowInvalidUnitError(`Unit "${cleanUnitId}" objective exceeds maximum length of ${MAX_UNIT_TEXT_LENGTH} characters`)
      }

      if (typeof u.acceptanceCriteria !== 'string' || !u.acceptanceCriteria.trim()) {
        throw new UnitFlowInvalidUnitError(`Unit "${cleanUnitId}" acceptanceCriteria must be a non-empty string`)
      }
      const cleanAcceptanceCriteria = u.acceptanceCriteria.trim()
      if (cleanAcceptanceCriteria.length > MAX_UNIT_TEXT_LENGTH) {
        throw new UnitFlowInvalidUnitError(`Unit "${cleanUnitId}" acceptanceCriteria exceeds maximum length of ${MAX_UNIT_TEXT_LENGTH} characters`)
      }

      let sanitizedDeps: string[] = []
      if (u.dependsOnUnitIds !== undefined) {
        if (!Array.isArray(u.dependsOnUnitIds)) {
          throw new UnitFlowInvalidUnitError(`Unit "${cleanUnitId}" dependsOnUnitIds must be an array when provided`)
        }
        const seenDepsForUnit = new Set<string>()
        for (const dep of u.dependsOnUnitIds) {
          if (typeof dep !== 'string' || !dep.trim() || !UUID_REGEX.test(dep.trim())) {
            throw new UnitFlowInvalidUnitError(`Unit "${cleanUnitId}" has invalid dependency UUID format: "${dep}"`)
          }
          const cleanDepId = dep.trim().toLowerCase()
          if (cleanDepId === cleanUnitId) {
            throw new UnitFlowInvalidUnitError(`Unit "${cleanUnitId}" cannot depend on itself`)
          }
          if (!seenUnitIds.has(cleanDepId)) {
            throw new UnitFlowInvalidUnitError(`Dependency "${cleanDepId}" of unit "${cleanUnitId}" must point to a preceding unit in the same manifest`)
          }
          if (!seenDepsForUnit.has(cleanDepId)) {
            seenDepsForUnit.add(cleanDepId)
            sanitizedDeps.push(cleanDepId)
          }
        }
      }

      seenUnitIds.add(cleanUnitId)
      sanitizedUnits.push({
        unitId: cleanUnitId,
        title: cleanTitle,
        objective: cleanObjective,
        acceptanceCriteria: cleanAcceptanceCriteria,
        dependsOnUnitIds: sanitizedDeps
      })
    }

    try {
      return this.db.transaction(() => {
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

        // 2. Valida existência e propriedade do plano na sessão
        const planRow = this.db.prepare(`
          SELECT plan_id, session_id, repository_id, status FROM smc_plans WHERE plan_id = ? AND repository_id = ?
        `).get(cleanPlanId, this.repositoryId) as { plan_id: string, session_id: string, repository_id: string, status: string } | undefined

        if (!planRow) {
          throw new UnitFlowPlanNotFoundError(cleanPlanId)
        }
        if (planRow.session_id !== cleanSessionId) {
          throw new UnitFlowPlanConflictError(`Plan "${cleanPlanId}" belongs to another session "${planRow.session_id}"`)
        }
        if (planRow.status !== 'ACTIVE') {
          throw new UnitFlowPlanConflictError(`Plan "${cleanPlanId}" is not ACTIVE (status: ${planRow.status})`)
        }

        // 3. Verifica se o plano já possui unidades definidas
        const existingRows = this.db.prepare(`
          SELECT unit_id, plan_id, position, title, objective, acceptance_criteria, depends_on_json, created_at
          FROM smc_plan_units
          WHERE plan_id = ?
          ORDER BY position ASC
        `).all(cleanPlanId) as RawUnitRow[]

        if (existingRows.length > 0) {
          const isIdentical = this.checkManifestIdentical(existingRows, sanitizedUnits)
          if (isIdentical) {
            return existingRows.map(r => this.mapRawToUnitRecord(r))
          }
          throw new UnitFlowManifestConflictError(cleanPlanId, 'manifest already defined with divergent content')
        }

        // 4. Insere o manifesto ordenado em transação atômica única, com estados iniciais AVAILABLE
        const now = new Date().toISOString()
        const insertStmt = this.db.prepare(`
          INSERT INTO smc_plan_units (
            unit_id, plan_id, position, title, objective, acceptance_criteria, depends_on_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        const insertStateStmt = this.db.prepare(`
          INSERT INTO smc_unit_states (unit_id, plan_id, status, revision, created_at, updated_at)
          VALUES (?, ?, 'AVAILABLE', 1, ?, ?)
        `)

        const records: UnitFlowUnitRecord[] = []
        for (let i = 0; i < sanitizedUnits.length; i++) {
          const item = sanitizedUnits[i]
          const position = i + 1
          const depsJson = item.dependsOnUnitIds.length > 0 ? JSON.stringify(item.dependsOnUnitIds) : null
          insertStmt.run(
            item.unitId,
            cleanPlanId,
            position,
            item.title,
            item.objective,
            item.acceptanceCriteria,
            depsJson,
            now
          )
          insertStateStmt.run(item.unitId, cleanPlanId, now, now)
          records.push({
            unitId: item.unitId,
            planId: cleanPlanId,
            position,
            title: item.title,
            objective: item.objective,
            acceptanceCriteria: item.acceptanceCriteria,
            dependsOnUnitIds: item.dependsOnUnitIds,
            createdAt: now
          })
        }

        return records
      })()
    } catch (error: any) {
      if (
        error?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
        error?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        error?.message?.includes('UNIQUE constraint failed')
      ) {
        const existingRows = this.db.prepare(`
          SELECT unit_id, plan_id, position, title, objective, acceptance_criteria, depends_on_json, created_at
          FROM smc_plan_units
          WHERE plan_id = ?
          ORDER BY position ASC
        `).all(cleanPlanId) as RawUnitRow[]
        if (existingRows.length > 0) {
          const isIdentical = this.checkManifestIdentical(existingRows, sanitizedUnits)
          if (isIdentical) {
            return existingRows.map(r => this.mapRawToUnitRecord(r))
          }
          throw new UnitFlowManifestConflictError(cleanPlanId, 'manifest already defined with divergent content')
        }
        throw new UnitFlowUnitConflictError(`Database constraint violation: ${error.message}`)
      }
      throw error
    }
  }

  listPlanUnits(sessionId: string, planId: string): UnitFlowUnitHeaderRecord[] {
    if (typeof sessionId !== 'string' || !sessionId.trim() || !UUID_REGEX.test(sessionId.trim())) {
      throw new SmcInvalidSessionIdError(sessionId ?? '')
    }
    const cleanSessionId = sessionId.trim().toLowerCase()

    if (typeof planId !== 'string' || !planId.trim() || !UUID_REGEX.test(planId.trim())) {
      throw new UnitFlowInvalidPlanError(`planId must be a valid UUID format, received: "${planId}"`)
    }
    const cleanPlanId = planId.trim().toLowerCase()

    const session = this.getSession(cleanSessionId)
    if (!session) {
      throw new SmcSessionNotFoundError(cleanSessionId)
    }

    const plan = this.getPlan(cleanPlanId)
    if (!plan) {
      throw new UnitFlowPlanNotFoundError(cleanPlanId)
    }
    if (plan.sessionId !== cleanSessionId) {
      throw new UnitFlowPlanConflictError(`Plan "${cleanPlanId}" belongs to session "${plan.sessionId}", not "${cleanSessionId}"`)
    }

    const rows = this.db.prepare(`
      SELECT unit_id, plan_id, position, title, depends_on_json, created_at
      FROM smc_plan_units
      WHERE plan_id = ?
      ORDER BY position ASC
    `).all(cleanPlanId) as Omit<RawUnitRow, 'objective' | 'acceptance_criteria'>[]

    return rows.map(r => this.mapRawToUnitHeader(r))
  }

  getPlanUnit(sessionId: string, planId: string, unitId: string): UnitFlowUnitRecord | null {
    if (
      typeof sessionId !== 'string' || !sessionId.trim() ||
      typeof planId !== 'string' || !planId.trim() ||
      typeof unitId !== 'string' || !unitId.trim()
    ) {
      return null
    }
    const cleanSessionId = sessionId.trim().toLowerCase()
    const cleanPlanId = planId.trim().toLowerCase()
    const cleanUnitId = unitId.trim().toLowerCase()

    if (!UUID_REGEX.test(cleanSessionId) || !UUID_REGEX.test(cleanPlanId) || !UUID_REGEX.test(cleanUnitId)) {
      return null
    }

    const plan = this.getPlan(cleanPlanId)
    if (!plan || plan.sessionId !== cleanSessionId) {
      return null
    }

    const row = this.db.prepare(`
      SELECT unit_id, plan_id, position, title, objective, acceptance_criteria, depends_on_json, created_at
      FROM smc_plan_units
      WHERE plan_id = ? AND unit_id = ?
    `).get(cleanPlanId, cleanUnitId) as RawUnitRow | undefined

    if (!row) {
      return null
    }

    return this.mapRawToUnitRecord(row)
  }

  private checkManifestIdentical(
    existing: RawUnitRow[],
    sanitized: Array<{
      unitId: string
      title: string
      objective: string
      acceptanceCriteria: string
      dependsOnUnitIds: string[]
    }>
  ): boolean {
    if (existing.length !== sanitized.length) {
      return false
    }
    for (let i = 0; i < existing.length; i++) {
      const e = existing[i]
      const s = sanitized[i]
      if (e.unit_id !== s.unitId) return false
      if (e.position !== i + 1) return false
      if (e.title !== s.title) return false
      if (e.objective !== s.objective) return false
      if (e.acceptance_criteria !== s.acceptanceCriteria) return false
      const eDeps: string[] = e.depends_on_json ? JSON.parse(e.depends_on_json) : []
      if (eDeps.length !== s.dependsOnUnitIds.length) return false
      for (let j = 0; j < eDeps.length; j++) {
        if (eDeps[j] !== s.dependsOnUnitIds[j]) return false
      }
    }
    return true
  }

  private mapRawToUnitHeader(row: Omit<RawUnitRow, 'objective' | 'acceptance_criteria'>): UnitFlowUnitHeaderRecord {
    return {
      unitId: row.unit_id,
      planId: row.plan_id,
      position: row.position,
      title: row.title,
      dependsOnUnitIds: row.depends_on_json ? JSON.parse(row.depends_on_json) : [],
      createdAt: row.created_at
    }
  }

  private mapRawToUnitRecord(row: RawUnitRow): UnitFlowUnitRecord {
    return {
      unitId: row.unit_id,
      planId: row.plan_id,
      position: row.position,
      title: row.title,
      objective: row.objective ?? '',
      acceptanceCriteria: row.acceptance_criteria ?? '',
      dependsOnUnitIds: row.depends_on_json ? JSON.parse(row.depends_on_json) : [],
      createdAt: row.created_at
    }
  }

  private mapRawToUnitStateRecord(row: RawUnitStateRow): UnitFlowUnitStateRecord {
    return {
      unitId: row.unit_id,
      planId: row.plan_id,
      status: row.status as UnitFlowUnitStatus,
      revision: Number(row.revision),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  getUnitState(sessionId: string, planId: string, unitId: string): UnitFlowUnitStateRecord | null {
    if (
      typeof sessionId !== 'string' || !sessionId.trim() ||
      typeof planId !== 'string' || !planId.trim() ||
      typeof unitId !== 'string' || !unitId.trim()
    ) {
      return null
    }
    const cleanSessionId = sessionId.trim().toLowerCase()
    const cleanPlanId = planId.trim().toLowerCase()
    const cleanUnitId = unitId.trim().toLowerCase()
    if (!UUID_REGEX.test(cleanSessionId) || !UUID_REGEX.test(cleanPlanId) || !UUID_REGEX.test(cleanUnitId)) {
      return null
    }

    const plan = this.getPlan(cleanPlanId)
    if (!plan || plan.sessionId !== cleanSessionId) {
      return null
    }

    const row = this.db.prepare(`
      SELECT unit_id, plan_id, status, revision, created_at, updated_at
      FROM smc_unit_states
      WHERE unit_id = ? AND plan_id = ?
    `).get(cleanUnitId, cleanPlanId) as RawUnitStateRow | undefined

    if (!row) return null
    return this.mapRawToUnitStateRecord(row)
  }

  getNextEligibleUnit(sessionId: string, planId: string): UnitFlowEligibilityResult {
    if (typeof sessionId !== 'string' || !sessionId.trim() || !UUID_REGEX.test(sessionId.trim())) {
      throw new SmcInvalidSessionIdError(sessionId ?? '')
    }
    const cleanSessionId = sessionId.trim().toLowerCase()

    if (typeof planId !== 'string' || !planId.trim() || !UUID_REGEX.test(planId.trim())) {
      throw new UnitFlowInvalidPlanError(`planId must be a valid UUID format, received: "${planId}"`)
    }
    const cleanPlanId = planId.trim().toLowerCase()

    // Valida sessão
    const sessionRow = this.db.prepare(`
      SELECT status FROM smc_sessions WHERE session_id = ? AND repository_id = ?
    `).get(cleanSessionId, this.repositoryId) as { status: string } | undefined

    if (!sessionRow) {
      throw new SmcSessionNotFoundError(cleanSessionId)
    }
    if (sessionRow.status === 'CLOSED') {
      throw new SmcSessionClosedError(cleanSessionId)
    }

    // Valida plano
    const planRow = this.db.prepare(`
      SELECT plan_id, session_id, status FROM smc_plans WHERE plan_id = ? AND repository_id = ?
    `).get(cleanPlanId, this.repositoryId) as { plan_id: string; session_id: string; status: string } | undefined

    if (!planRow) {
      throw new UnitFlowPlanNotFoundError(cleanPlanId)
    }
    if (planRow.session_id !== cleanSessionId) {
      throw new UnitFlowPlanConflictError(`Plan "${cleanPlanId}" belongs to another session "${planRow.session_id}"`)
    }
    if (planRow.status !== 'ACTIVE') {
      throw new UnitFlowPlanConflictError(`Plan "${cleanPlanId}" is not ACTIVE (status: ${planRow.status})`)
    }

    // Carrega unidades ordenadas + estados numa única query JOIN
    type UnitWithState = {
      unit_id: string
      position: number
      title: string
      depends_on_json: string | null
      status: string
    }

    const rows = this.db.prepare(`
      SELECT u.unit_id, u.position, u.title, u.depends_on_json, s.status
      FROM smc_plan_units u
      LEFT JOIN smc_unit_states s ON s.unit_id = u.unit_id AND s.plan_id = u.plan_id
      WHERE u.plan_id = ?
      ORDER BY u.position ASC
    `).all(cleanPlanId) as UnitWithState[]

    if (rows.length === 0) {
      return { kind: 'MANIFEST_UNDEFINED' }
    }

    // Verifica se estados estão presentes e consistentes (falha fechado)
    const completedUnitIds = new Set<string>()

    for (const row of rows) {
      if (!row.status) {
        throw new UnitFlowInvalidUnitError(`Unit "${row.unit_id}" has no persisted state in smc_unit_states`)
      }
      const status = row.status as UnitFlowUnitStatus
      const deps: string[] = row.depends_on_json ? JSON.parse(row.depends_on_json) : []

      if (status === 'COMPLETED') {
        completedUnitIds.add(row.unit_id)
        continue
      }

      // Primeira não COMPLETED: avaliar elegibilidade
      // Bloquear se em estado em andamento
      if (status === 'RESERVED' || status === 'EXECUTING' || status === 'VALIDATING' || status === 'RECONCILING') {
        return { kind: 'WAITING', blockingUnitId: row.unit_id }
      }

      // status === 'AVAILABLE': verificar se todas as anteriores por posição estão COMPLETED
      // (regra estritamente sequencial: todas as unidades anteriores devem estar concluídas)
      const prevRows = rows.filter(r => r.position < row.position)
      const allPrevCompleted = prevRows.every(r => r.status === 'COMPLETED')
      if (!allPrevCompleted) {
        // Encontrar o bloqueador (primeiro anterior não COMPLETED)
        const blocker = prevRows.find(r => r.status !== 'COMPLETED')
        if (blocker) {
          return { kind: 'WAITING', blockingUnitId: blocker.unit_id }
        }
      }

      // Verificar dependências declaradas
      const depsNotCompleted = deps.filter(d => !completedUnitIds.has(d))
      if (depsNotCompleted.length > 0) {
        return { kind: 'WAITING', blockingUnitId: depsNotCompleted[0] }
      }

      return {
        kind: 'ELIGIBLE',
        unitId: row.unit_id,
        position: row.position,
        title: row.title,
        status
      }
    }

    return { kind: 'ALL_UNITS_COMPLETED' }
  }

  private mapRawToWorkspaceBinding(row: RawWorkspaceBindingRow): BuildXWorkspaceBindingRecord {
    return {
      sessionId: row.session_id,
      repositoryId: row.repository_id,
      worktreeId: row.worktree_id,
      generation: row.generation,
      branch: row.branch,
      headAtBind: row.head_at_bind,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  saveWorkspaceBinding(sessionId: string, input: SaveWorkspaceBindingInput): BuildXWorkspaceBindingRecord {
    if (typeof sessionId !== 'string' || !sessionId.trim() || !UUID_REGEX.test(sessionId.trim())) {
      throw new SmcInvalidSessionIdError(sessionId ?? '')
    }
    const cleanSessionId = sessionId.trim().toLowerCase()

    return this.db.transaction(() => {
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

      // 2. Valida se já existe vínculo para esta sessão
      const existing = this.db.prepare(`
        SELECT session_id, repository_id, worktree_id, generation, branch, head_at_bind, created_at, updated_at
        FROM smc_session_worktrees
        WHERE session_id = ?
      `).get(cleanSessionId) as RawWorkspaceBindingRow | undefined

      if (existing) {
        const isIdentical =
          existing.worktree_id === input.worktreeId &&
          existing.generation === input.generation &&
          existing.branch === input.branch

        if (isIdentical) {
          // Replay idêntico
          return this.mapRawToWorkspaceBinding(existing)
        }
        throw new BuildXWorkspaceBindingConflictError(
          `Session "${cleanSessionId}" is already bound to worktree "${existing.worktree_id}" (${existing.branch}, generation ${existing.generation})`
        )
      }

      // 3. Insere novo vínculo
      const now = new Date().toISOString()
      this.db.prepare(`
        INSERT INTO smc_session_worktrees (
          session_id, repository_id, worktree_id, generation, branch, head_at_bind, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cleanSessionId,
        this.repositoryId,
        input.worktreeId,
        input.generation,
        input.branch,
        input.headAtBind,
        now,
        now
      )

      return {
        sessionId: cleanSessionId,
        repositoryId: this.repositoryId,
        worktreeId: input.worktreeId,
        generation: input.generation,
        branch: input.branch,
        headAtBind: input.headAtBind,
        createdAt: now,
        updatedAt: now
      }
    })()
  }

  getWorkspaceBinding(sessionId: string): BuildXWorkspaceBindingRecord | null {
    if (typeof sessionId !== 'string' || !sessionId.trim() || !UUID_REGEX.test(sessionId.trim())) {
      return null
    }
    const cleanSessionId = sessionId.trim().toLowerCase()

    const row = this.db.prepare(`
      SELECT session_id, repository_id, worktree_id, generation, branch, head_at_bind, created_at, updated_at
      FROM smc_session_worktrees
      WHERE session_id = ? AND repository_id = ?
    `).get(cleanSessionId, this.repositoryId) as RawWorkspaceBindingRow | undefined

    if (!row) {
      return null
    }

    return this.mapRawToWorkspaceBinding(row)
  }

  private mapRawToReservationRecord(row: RawReservationRow): UnitFlowReservationRecord {
    return {
      reservationId: row.reservation_id,
      repositoryId: row.repository_id,
      sessionId: row.session_id,
      planId: row.plan_id,
      unitId: row.unit_id,
      worktreeId: row.worktree_id,
      generation: row.generation,
      branch: row.branch,
      headObservedAtReservation: row.head_observed_at_reservation,
      unitStateRevision: row.unit_state_revision,
      status: row.status as UnitFlowReservationStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  reserveEligibleUnit(input: ReserveEligibleUnitInput): UnitFlowReservationResult {
    if (typeof input.sessionId !== 'string' || !input.sessionId.trim() || !UUID_REGEX.test(input.sessionId.trim())) {
      throw new SmcInvalidSessionIdError(input.sessionId ?? '')
    }
    const cleanSessionId = input.sessionId.trim().toLowerCase()

    if (typeof input.planId !== 'string' || !input.planId.trim() || !UUID_REGEX.test(input.planId.trim())) {
      throw new UnitFlowInvalidPlanError(`planId must be a valid UUID format, received: "${input.planId}"`)
    }
    const cleanPlanId = input.planId.trim().toLowerCase()

    if (typeof input.reservationId !== 'string' || !input.reservationId.trim() || !UUID_REGEX.test(input.reservationId.trim())) {
      throw new UnitFlowInvalidReservationIdError(input.reservationId ?? '')
    }
    const cleanReservationId = input.reservationId.trim().toLowerCase()

    if (!input.headObserved || typeof input.headObserved !== 'string' || !input.headObserved.trim()) {
      throw new BuildXWorkspaceBindingConflictError('headObserved must be non-empty')
    }

    return this.db.transaction((): UnitFlowReservationResult => {
      // 1. Replay check dentro da transação (para concorrência)
      const existing = this.db.prepare(`
        SELECT * FROM smc_unit_reservations WHERE reservation_id = ?
      `).get(cleanReservationId) as RawReservationRow | undefined

      if (existing) {
        if (
          existing.repository_id === this.repositoryId &&
          existing.session_id === cleanSessionId &&
          existing.plan_id === cleanPlanId
        ) {
          return { kind: 'RESERVED', reservation: this.mapRawToReservationRecord(existing) }
        }
        throw new UnitFlowReservationIdConflictError(
          cleanReservationId,
          `already exists with divergent scope (repo=${existing.repository_id}, session=${existing.session_id}, plan=${existing.plan_id})`
        )
      }

      // 2. Valida sessão
      const sessionRow = this.db.prepare(`
        SELECT status FROM smc_sessions WHERE session_id = ? AND repository_id = ?
      `).get(cleanSessionId, this.repositoryId) as { status: string } | undefined

      if (!sessionRow) {
        throw new SmcSessionNotFoundError(cleanSessionId)
      }
      if (sessionRow.status === 'CLOSED') {
        throw new SmcSessionClosedError(cleanSessionId)
      }

      // 3. Valida plano
      const planRow = this.db.prepare(`
        SELECT plan_id, session_id, status FROM smc_plans WHERE plan_id = ? AND repository_id = ?
      `).get(cleanPlanId, this.repositoryId) as { plan_id: string; session_id: string; status: string } | undefined

      if (!planRow) {
        throw new UnitFlowPlanNotFoundError(cleanPlanId)
      }
      if (planRow.session_id !== cleanSessionId) {
        throw new UnitFlowPlanConflictError(`Plan "${cleanPlanId}" belongs to another session "${planRow.session_id}"`)
      }
      if (planRow.status !== 'ACTIVE') {
        throw new UnitFlowPlanConflictError(`Plan "${cleanPlanId}" is not ACTIVE (status: ${planRow.status})`)
      }

      // 5. Valida workspace binding e confronta com o observado
      const bindingRow = this.db.prepare(`
        SELECT worktree_id, generation, branch, head_at_bind FROM smc_session_worktrees
        WHERE session_id = ? AND repository_id = ?
      `).get(cleanSessionId, this.repositoryId) as { worktree_id: string; generation: string; branch: string; head_at_bind: string } | undefined

      if (!bindingRow) {
        throw new BuildXWorkspaceBindingConflictError(`Session "${cleanSessionId}" is not bound to a worktree`)
      }
      if (
        bindingRow.worktree_id !== input.expectedBinding.worktreeId ||
        bindingRow.generation !== input.expectedBinding.generation ||
        bindingRow.branch !== input.expectedBinding.branch
      ) {
        throw new BuildXWorkspaceBindingConflictError(
          `Workspace binding drifted between observation and reservation transaction (expected wt=${input.expectedBinding.worktreeId}, gen=${input.expectedBinding.generation}, br=${input.expectedBinding.branch}; found wt=${bindingRow.worktree_id}, gen=${bindingRow.generation}, br=${bindingRow.branch})`
        )
      }

      // 6. Seleciona a próxima unidade elegível no snapshot da transação
      type UnitWithState = {
        unit_id: string
        position: number
        title: string
        depends_on_json: string | null
        status: string | null
        revision: number | null
      }

      const rows = this.db.prepare(`
        SELECT u.unit_id, u.position, u.title, u.depends_on_json, s.status, s.revision
        FROM smc_plan_units u
        LEFT JOIN smc_unit_states s ON s.unit_id = u.unit_id AND s.plan_id = u.plan_id
        WHERE u.plan_id = ?
        ORDER BY u.position ASC
      `).all(cleanPlanId) as UnitWithState[]

      if (rows.length === 0) {
        return { kind: 'MANIFEST_UNDEFINED' }
      }

      for (const row of rows) {
        if (!row.status || typeof row.revision !== 'number') {
          throw new UnitFlowInvalidUnitError(`Unit "${row.unit_id}" has no persisted state in smc_unit_states`)
        }
      }

      let eligibleUnit: { unit_id: string; revision: number } | null = null
      let waitingBlockerId: string | null = null
      const completedUnitIds = new Set<string>()

      for (const row of rows) {
        const status = row.status as UnitFlowUnitStatus
        const deps: string[] = row.depends_on_json ? JSON.parse(row.depends_on_json) : []

        if (status === 'COMPLETED') {
          completedUnitIds.add(row.unit_id)
          continue
        }

        if (status === 'RESERVED' || status === 'EXECUTING' || status === 'VALIDATING' || status === 'RECONCILING') {
          waitingBlockerId = row.unit_id
          break
        }

        const prevRows = rows.filter(r => r.position < row.position)
        const allPrevCompleted = prevRows.every(r => r.status === 'COMPLETED')
        if (!allPrevCompleted) {
          const blocker = prevRows.find(r => r.status !== 'COMPLETED')
          waitingBlockerId = blocker ? blocker.unit_id : row.unit_id
          break
        }

        const depsNotCompleted = deps.filter(d => !completedUnitIds.has(d))
        if (depsNotCompleted.length > 0) {
          waitingBlockerId = depsNotCompleted[0]
          break
        }

        if (status === 'AVAILABLE') {
          eligibleUnit = { unit_id: row.unit_id, revision: row.revision! }
          break
        }
      }

      if (waitingBlockerId) {
        return { kind: 'WAITING', blockingUnitId: waitingBlockerId }
      }

      if (!eligibleUnit) {
        return { kind: 'ALL_UNITS_COMPLETED' }
      }

      // 7. Atualização atômica: CAS de smc_unit_states + INSERT de smc_unit_reservations
      const now = new Date().toISOString()
      const newRevision = eligibleUnit.revision + 1

      const casResult = this.db.prepare(`
        UPDATE smc_unit_states
        SET status = 'RESERVED', revision = ?, updated_at = ?
        WHERE unit_id = ? AND plan_id = ? AND status = 'AVAILABLE' AND revision = ?
      `).run(newRevision, now, eligibleUnit.unit_id, cleanPlanId, eligibleUnit.revision)

      if (casResult.changes !== 1) {
        throw new UnitFlowReservationConflictError(
          `Concurrent modification detected on unit "${eligibleUnit.unit_id}" during reservation`
        )
      }

      try {
        this.db.prepare(`
          INSERT INTO smc_unit_reservations (
            reservation_id, repository_id, session_id, plan_id, unit_id,
            worktree_id, generation, branch, head_observed_at_reservation,
            unit_state_revision, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
        `).run(
          cleanReservationId,
          this.repositoryId,
          cleanSessionId,
          cleanPlanId,
          eligibleUnit.unit_id,
          input.expectedBinding.worktreeId,
          input.expectedBinding.generation,
          input.expectedBinding.branch,
          input.headObserved,
          newRevision,
          now,
          now
        )
      } catch (insertError: any) {
        const msg = String(insertError?.message || '')
        if (msg.includes('idx_smc_unit_reservations_active_session')) {
          throw new UnitFlowReservationConflictError(
            `Session "${cleanSessionId}" already has an active unit reservation`
          )
        }
        if (msg.includes('idx_smc_unit_reservations_active_unit')) {
          throw new UnitFlowReservationConflictError(
            `Unit "${eligibleUnit.unit_id}" already has an active reservation`
          )
        }
        if (msg.includes('idx_smc_unit_reservations_active_worktree')) {
          throw new UnitFlowReservationConflictError(
            `Worktree "${input.expectedBinding.worktreeId}" already has an active unit reservation in repository "${this.repositoryId}"`
          )
        }
        if (insertError?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || msg.includes('smc_unit_reservations.reservation_id') || msg.includes('PRIMARY KEY')) {
          throw new UnitFlowReservationIdConflictError(
            cleanReservationId,
            `already exists with conflicting record`
          )
        }
        throw new UnitFlowReservationConflictError(`Failed to persist reservation receipt: ${msg}`)
      }

      const receipt: UnitFlowReservationRecord = {
        reservationId: cleanReservationId,
        repositoryId: this.repositoryId,
        sessionId: cleanSessionId,
        planId: cleanPlanId,
        unitId: eligibleUnit.unit_id,
        worktreeId: input.expectedBinding.worktreeId,
        generation: input.expectedBinding.generation,
        branch: input.expectedBinding.branch,
        headObservedAtReservation: input.headObserved,
        unitStateRevision: newRevision,
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now
      }

      return { kind: 'RESERVED', reservation: receipt }
    })()
  }

  getReservation(reservationId: string): UnitFlowReservationRecord | null {
    if (typeof reservationId !== 'string' || !reservationId.trim() || !UUID_REGEX.test(reservationId.trim())) {
      throw new UnitFlowInvalidReservationIdError(reservationId ?? '')
    }
    const cleanId = reservationId.trim().toLowerCase()
    const row = this.db.prepare(`
      SELECT * FROM smc_unit_reservations
      WHERE reservation_id = ? AND repository_id = ?
    `).get(cleanId, this.repositoryId) as RawReservationRow | undefined
    if (!row) return null
    return this.mapRawToReservationRecord(row)
  }

  getActiveReservation(sessionId: string): UnitFlowReservationRecord | null {
    if (typeof sessionId !== 'string' || !sessionId.trim() || !UUID_REGEX.test(sessionId.trim())) {
      throw new SmcInvalidSessionIdError(sessionId ?? '')
    }
    const cleanSessionId = sessionId.trim().toLowerCase()
    const row = this.db.prepare(`
      SELECT * FROM smc_unit_reservations
      WHERE session_id = ? AND repository_id = ? AND status = 'ACTIVE'
    `).get(cleanSessionId, this.repositoryId) as RawReservationRow | undefined
    if (!row) return null
    return this.mapRawToReservationRecord(row)
  }

  private mapRawToExecutionAttemptRecord(row: RawExecutionAttemptRow): ExecutionAttemptRecord {
    return {
      attemptId: row.attempt_id,
      repositoryId: row.repository_id,
      sessionId: row.session_id,
      planId: row.plan_id,
      unitId: row.unit_id,
      reservationId: row.reservation_id,
      worktreeId: row.worktree_id,
      generation: row.generation,
      branch: row.branch,
      headObservedAtPreparation: row.head_observed_at_preparation,
      status: row.status as ExecutionAttemptStatus,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  prepareExecutionAttempt(input: PrepareExecutionAttemptInput): ExecutionAttemptRecord {
    if (typeof input.sessionId !== 'string' || !input.sessionId.trim() || !UUID_REGEX.test(input.sessionId.trim())) {
      throw new SmcInvalidSessionIdError(input.sessionId ?? '')
    }
    const cleanSessionId = input.sessionId.trim().toLowerCase()

    if (typeof input.reservationId !== 'string' || !input.reservationId.trim() || !UUID_REGEX.test(input.reservationId.trim())) {
      throw new UnitFlowInvalidReservationIdError(input.reservationId ?? '')
    }
    const cleanReservationId = input.reservationId.trim().toLowerCase()

    if (typeof input.attemptId !== 'string' || !input.attemptId.trim() || !UUID_REGEX.test(input.attemptId.trim())) {
      throw new ExecutionInvalidAttemptIdError(input.attemptId ?? '')
    }
    const cleanAttemptId = input.attemptId.trim().toLowerCase()

    if (!input.headObserved || typeof input.headObserved !== 'string' || !input.headObserved.trim()) {
      throw new BuildXWorkspaceBindingConflictError('headObserved must be non-empty')
    }

    return this.db.transaction((): ExecutionAttemptRecord => {
      // 1. Replay check dentro da transação
      const existing = this.db.prepare(`
        SELECT * FROM smc_execution_attempts WHERE attempt_id = ?
      `).get(cleanAttemptId) as RawExecutionAttemptRow | undefined

      if (existing) {
        if (
          existing.repository_id === this.repositoryId &&
          existing.session_id === cleanSessionId &&
          existing.reservation_id === cleanReservationId
        ) {
          return this.mapRawToExecutionAttemptRecord(existing)
        }
        throw new ExecutionAttemptIdConflictError(
          cleanAttemptId,
          `already exists with divergent scope (repo=${existing.repository_id}, session=${existing.session_id}, reservation=${existing.reservation_id})`
        )
      }

      // 2. Valida sessão (OPEN)
      const sessionRow = this.db.prepare(`
        SELECT status FROM smc_sessions WHERE session_id = ? AND repository_id = ?
      `).get(cleanSessionId, this.repositoryId) as { status: string } | undefined

      if (!sessionRow) {
        throw new SmcSessionNotFoundError(cleanSessionId)
      }
      if (sessionRow.status === 'CLOSED') {
        throw new SmcSessionClosedError(cleanSessionId)
      }

      // 3. Valida reserva (ACTIVE) pertencente à sessão e repositório
      const resRow = this.db.prepare(`
        SELECT * FROM smc_unit_reservations
        WHERE reservation_id = ? AND repository_id = ?
      `).get(cleanReservationId, this.repositoryId) as RawReservationRow | undefined

      if (!resRow) {
        throw new UnitFlowReservationNotFoundError(cleanReservationId)
      }
      if (resRow.session_id !== cleanSessionId) {
        throw new ExecutionAttemptConflictError(
          `Reservation "${cleanReservationId}" belongs to another session "${resRow.session_id}"`
        )
      }
      if (resRow.status !== 'ACTIVE') {
        throw new ExecutionAttemptConflictError(
          `Reservation "${cleanReservationId}" is not ACTIVE (status: ${resRow.status})`
        )
      }

      // 4. Valida plano (ACTIVE)
      const planRow = this.db.prepare(`
        SELECT plan_id, session_id, status FROM smc_plans WHERE plan_id = ? AND repository_id = ?
      `).get(resRow.plan_id, this.repositoryId) as { plan_id: string; session_id: string; status: string } | undefined

      if (!planRow) {
        throw new UnitFlowPlanNotFoundError(resRow.plan_id)
      }
      if (planRow.session_id !== cleanSessionId) {
        throw new UnitFlowPlanConflictError(`Plan "${resRow.plan_id}" belongs to another session "${planRow.session_id}"`)
      }
      if (planRow.status !== 'ACTIVE') {
        throw new UnitFlowPlanConflictError(`Plan "${resRow.plan_id}" is not ACTIVE (status: ${planRow.status})`)
      }

      // 5. Valida unidade (RESERVED) e revision == reservation.unit_state_revision
      const unitStateRow = this.db.prepare(`
        SELECT status, revision FROM smc_unit_states
        WHERE unit_id = ? AND plan_id = ?
      `).get(resRow.unit_id, resRow.plan_id) as { status: string; revision: number } | undefined

      if (!unitStateRow) {
        throw new ExecutionAttemptConflictError(`Unit "${resRow.unit_id}" has no persisted state in smc_unit_states`)
      }
      if (unitStateRow.status !== 'RESERVED') {
        throw new ExecutionAttemptConflictError(
          `Unit "${resRow.unit_id}" is not in RESERVED state (status: ${unitStateRow.status})`
        )
      }
      if (unitStateRow.revision !== resRow.unit_state_revision) {
        throw new ExecutionAttemptConflictError(
          `Unit "${resRow.unit_id}" state revision (${unitStateRow.revision}) diverges from reservation unitStateRevision (${resRow.unit_state_revision})`
        )
      }

      // 6. Valida workspace binding e confronta com o observado e com a reserva
      const bindingRow = this.db.prepare(`
        SELECT worktree_id, generation, branch, head_at_bind FROM smc_session_worktrees
        WHERE session_id = ? AND repository_id = ?
      `).get(cleanSessionId, this.repositoryId) as { worktree_id: string; generation: string; branch: string; head_at_bind: string } | undefined

      if (!bindingRow) {
        throw new BuildXWorkspaceBindingConflictError(`Session "${cleanSessionId}" is not bound to a worktree`)
      }
      if (
        bindingRow.worktree_id !== input.expectedBinding.worktreeId ||
        bindingRow.generation !== input.expectedBinding.generation ||
        bindingRow.branch !== input.expectedBinding.branch
      ) {
        throw new BuildXWorkspaceBindingConflictError(
          `Workspace binding drifted between observation and attempt preparation (expected wt=${input.expectedBinding.worktreeId}, gen=${input.expectedBinding.generation}, br=${input.expectedBinding.branch}; found wt=${bindingRow.worktree_id}, gen=${bindingRow.generation}, br=${bindingRow.branch})`
        )
      }
      if (
        bindingRow.worktree_id !== resRow.worktree_id ||
        bindingRow.generation !== resRow.generation ||
        bindingRow.branch !== resRow.branch
      ) {
        throw new BuildXWorkspaceBindingConflictError(
          `Workspace binding diverges from reservation (reservation wt=${resRow.worktree_id}, gen=${resRow.generation}, br=${resRow.branch}; found wt=${bindingRow.worktree_id}, gen=${bindingRow.generation}, br=${bindingRow.branch})`
        )
      }

      // 7. Valida se a sessão ou reserva já possui uma tentativa PREPARED
      const activeSessionAttempt = this.db.prepare(`
        SELECT attempt_id FROM smc_execution_attempts
        WHERE session_id = ? AND status = 'PREPARED'
      `).get(cleanSessionId) as { attempt_id: string } | undefined

      if (activeSessionAttempt) {
        throw new ExecutionAttemptConflictError(
          `Session "${cleanSessionId}" already has a prepared execution attempt "${activeSessionAttempt.attempt_id}"`
        )
      }

      const activeResAttempt = this.db.prepare(`
        SELECT attempt_id FROM smc_execution_attempts
        WHERE reservation_id = ? AND status = 'PREPARED'
      `).get(cleanReservationId) as { attempt_id: string } | undefined

      if (activeResAttempt) {
        throw new ExecutionAttemptConflictError(
          `Reservation "${cleanReservationId}" already has a prepared execution attempt "${activeResAttempt.attempt_id}"`
        )
      }

      // 8. Insere a tentativa PREPARED
      const now = new Date().toISOString()
      try {
        this.db.prepare(`
          INSERT INTO smc_execution_attempts (
            attempt_id, repository_id, session_id, plan_id, unit_id, reservation_id,
            worktree_id, generation, branch, head_observed_at_preparation,
            status, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARED', 1, ?, ?)
        `).run(
          cleanAttemptId,
          this.repositoryId,
          cleanSessionId,
          resRow.plan_id,
          resRow.unit_id,
          cleanReservationId,
          input.expectedBinding.worktreeId,
          input.expectedBinding.generation,
          input.expectedBinding.branch,
          input.headObserved,
          now,
          now
        )
      } catch (insertError: any) {
        const msg = String(insertError?.message || '')
        if (msg.includes('idx_smc_execution_attempts_prepared_session')) {
          throw new ExecutionAttemptConflictError(`Session "${cleanSessionId}" already has a prepared execution attempt`)
        }
        if (msg.includes('idx_smc_execution_attempts_prepared_reservation')) {
          throw new ExecutionAttemptConflictError(`Reservation "${cleanReservationId}" already has a prepared execution attempt`)
        }
        if (insertError?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || msg.includes('smc_execution_attempts.attempt_id') || msg.includes('PRIMARY KEY')) {
          throw new ExecutionAttemptIdConflictError(
            cleanAttemptId,
            `already exists with conflicting record`
          )
        }
        throw new ExecutionAttemptConflictError(`Failed to persist execution attempt: ${msg}`)
      }

      return {
        attemptId: cleanAttemptId,
        repositoryId: this.repositoryId,
        sessionId: cleanSessionId,
        planId: resRow.plan_id,
        unitId: resRow.unit_id,
        reservationId: cleanReservationId,
        worktreeId: input.expectedBinding.worktreeId,
        generation: input.expectedBinding.generation,
        branch: input.expectedBinding.branch,
        headObservedAtPreparation: input.headObserved,
        status: 'PREPARED',
        revision: 1,
        createdAt: now,
        updatedAt: now
      }
    })()
  }

  getExecutionAttempt(attemptId: string): ExecutionAttemptRecord | null {
    if (typeof attemptId !== 'string' || !attemptId.trim() || !UUID_REGEX.test(attemptId.trim())) {
      throw new ExecutionInvalidAttemptIdError(attemptId ?? '')
    }
    const cleanId = attemptId.trim().toLowerCase()
    const row = this.db.prepare(`
      SELECT * FROM smc_execution_attempts
      WHERE attempt_id = ? AND repository_id = ?
    `).get(cleanId, this.repositoryId) as RawExecutionAttemptRow | undefined
    if (!row) return null
    return this.mapRawToExecutionAttemptRecord(row)
  }

  getPreparedExecutionAttempt(sessionId: string): ExecutionAttemptRecord | null {
    if (typeof sessionId !== 'string' || !sessionId.trim() || !UUID_REGEX.test(sessionId.trim())) {
      throw new SmcInvalidSessionIdError(sessionId ?? '')
    }
    const cleanSessionId = sessionId.trim().toLowerCase()
    const row = this.db.prepare(`
      SELECT * FROM smc_execution_attempts
      WHERE session_id = ? AND repository_id = ? AND status = 'PREPARED'
    `).get(cleanSessionId, this.repositoryId) as RawExecutionAttemptRow | undefined
    if (!row) return null
    return this.mapRawToExecutionAttemptRecord(row)
  }

  getActiveExecutionAttempt(sessionId: string): ExecutionAttemptRecord | null {
    if (typeof sessionId !== 'string' || !sessionId.trim() || !UUID_REGEX.test(sessionId.trim())) {
      throw new SmcInvalidSessionIdError(sessionId ?? '')
    }
    const cleanSessionId = sessionId.trim().toLowerCase()
    const row = this.db.prepare(`
      SELECT * FROM smc_execution_attempts
      WHERE session_id = ? AND repository_id = ? AND status IN ('PREPARED', 'STARTING', 'RUNNING')
      ORDER BY created_at DESC LIMIT 1
    `).get(cleanSessionId, this.repositoryId) as RawExecutionAttemptRow | undefined
    if (!row) return null
    return this.mapRawToExecutionAttemptRecord(row)
  }

  getLatestExecutionAttempt(sessionId: string, unitId?: string): ExecutionAttemptRecord | null {
    if (typeof sessionId !== 'string' || !sessionId.trim() || !UUID_REGEX.test(sessionId.trim())) {
      throw new SmcInvalidSessionIdError(sessionId ?? '')
    }
    const cleanSessionId = sessionId.trim().toLowerCase()
    let row: RawExecutionAttemptRow | undefined
    if (unitId && typeof unitId === 'string' && UUID_REGEX.test(unitId.trim())) {
      const cleanUnitId = unitId.trim().toLowerCase()
      row = this.db.prepare(`
        SELECT * FROM smc_execution_attempts
        WHERE session_id = ? AND repository_id = ? AND unit_id = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(cleanSessionId, this.repositoryId, cleanUnitId) as RawExecutionAttemptRow | undefined
    } else {
      row = this.db.prepare(`
        SELECT * FROM smc_execution_attempts
        WHERE session_id = ? AND repository_id = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(cleanSessionId, this.repositoryId) as RawExecutionAttemptRow | undefined
    }
    if (!row) return null
    return this.mapRawToExecutionAttemptRecord(row)
  }

  transitionAttemptToStarting(attemptId: string, expectedRevision: number): ExecutionAttemptRecord {
    if (typeof attemptId !== 'string' || !attemptId.trim() || !UUID_REGEX.test(attemptId.trim())) {
      throw new ExecutionInvalidAttemptIdError(attemptId ?? '')
    }
    const cleanId = attemptId.trim().toLowerCase()
    const now = new Date().toISOString()

    const result = this.db.prepare(`
      UPDATE smc_execution_attempts
      SET status = 'STARTING', revision = revision + 1, updated_at = ?
      WHERE attempt_id = ? AND repository_id = ? AND status = 'PREPARED' AND revision = ?
    `).run(now, cleanId, this.repositoryId, expectedRevision)

    if (result.changes === 0) {
      const existing = this.db.prepare(`
        SELECT * FROM smc_execution_attempts WHERE attempt_id = ? AND repository_id = ?
      `).get(cleanId, this.repositoryId) as RawExecutionAttemptRow | undefined
      if (!existing) {
        throw new ExecutionAttemptConflictError(`Attempt "${cleanId}" not found`)
      }
      throw new ExecutionAttemptConflictError(
        `CAS conflict: attempt "${cleanId}" status="${existing.status}" revision=${existing.revision}, expected PREPARED@${expectedRevision}`
      )
    }

    const updated = this.db.prepare(`
      SELECT * FROM smc_execution_attempts WHERE attempt_id = ? AND repository_id = ?
    `).get(cleanId, this.repositoryId) as RawExecutionAttemptRow
    return this.mapRawToExecutionAttemptRecord(updated)
  }

  transitionAttemptToRunning(
    attemptId: string,
    expectedRevision: number,
    unitId: string,
    unitRevision: number
  ): ExecutionAttemptRecord {
    if (typeof attemptId !== 'string' || !attemptId.trim() || !UUID_REGEX.test(attemptId.trim())) {
      throw new ExecutionInvalidAttemptIdError(attemptId ?? '')
    }
    const cleanId = attemptId.trim().toLowerCase()
    const now = new Date().toISOString()

    return this.db.transaction((): ExecutionAttemptRecord => {
      const attemptResult = this.db.prepare(`
        UPDATE smc_execution_attempts
        SET status = 'RUNNING', revision = revision + 1, updated_at = ?
        WHERE attempt_id = ? AND repository_id = ? AND status = 'STARTING' AND revision = ?
      `).run(now, cleanId, this.repositoryId, expectedRevision)

      if (attemptResult.changes === 0) {
        const existing = this.db.prepare(`
          SELECT * FROM smc_execution_attempts WHERE attempt_id = ? AND repository_id = ?
        `).get(cleanId, this.repositoryId) as RawExecutionAttemptRow | undefined
        if (!existing) {
          throw new ExecutionAttemptConflictError(`Attempt "${cleanId}" not found`)
        }
        throw new ExecutionAttemptConflictError(
          `CAS conflict: attempt "${cleanId}" status="${existing.status}" revision=${existing.revision}, expected STARTING@${expectedRevision}`
        )
      }

      const unitResult = this.db.prepare(`
        UPDATE smc_unit_states
        SET status = 'EXECUTING', revision = revision + 1, updated_at = ?
        WHERE unit_id = ? AND revision = ? AND status = 'RESERVED'
      `).run(now, unitId, unitRevision)

      if (unitResult.changes === 0) {
        throw new ExecutionAttemptConflictError(
          `CAS conflict: unit "${unitId}" not in RESERVED@${unitRevision}`
        )
      }

      const updated = this.db.prepare(`
        SELECT * FROM smc_execution_attempts WHERE attempt_id = ? AND repository_id = ?
      `).get(cleanId, this.repositoryId) as RawExecutionAttemptRow
      return this.mapRawToExecutionAttemptRecord(updated)
    })()
  }

  transitionAttemptToSettled(input: SettleExecutionAttemptStoreInput): ExecutionAttemptRecord {
    if (typeof input.attemptId !== 'string' || !input.attemptId.trim() || !UUID_REGEX.test(input.attemptId.trim())) {
      throw new ExecutionInvalidAttemptIdError(input.attemptId ?? '')
    }
    const cleanId = input.attemptId.trim().toLowerCase()
    const now = new Date().toISOString()

    return this.db.transaction((): ExecutionAttemptRecord => {
      const existing = this.db.prepare(`
        SELECT * FROM smc_execution_attempts WHERE attempt_id = ? AND repository_id = ?
      `).get(cleanId, this.repositoryId) as RawExecutionAttemptRow | undefined

      if (!existing) {
        throw new ExecutionAttemptConflictError(`Attempt "${cleanId}" not found`)
      }

      if (existing.status === 'COMPLETED' || existing.status === 'FAILED' || existing.status === 'CANCELLED') {
        return this.mapRawToExecutionAttemptRecord(existing)
      }

      if (existing.status !== 'STARTING' && existing.status !== 'RUNNING') {
        throw new ExecutionAttemptConflictError(
          `Attempt "${cleanId}" status="${existing.status}", expected STARTING or RUNNING`
        )
      }

      let targetAttemptStatus: ExecutionAttemptStatus
      let targetUnitStatus: string
      let defaultKind: 'RESULT' | 'PENDING'
      if (input.terminalOutcome === 'SUCCEEDED') {
        targetAttemptStatus = 'COMPLETED'
        targetUnitStatus = 'VALIDATING'
        defaultKind = 'RESULT'
      } else if (input.terminalOutcome === 'CANCELLED') {
        targetAttemptStatus = 'CANCELLED'
        targetUnitStatus = 'RECONCILING'
        defaultKind = 'PENDING'
      } else {
        targetAttemptStatus = 'FAILED'
        targetUnitStatus = 'RECONCILING'
        defaultKind = 'PENDING'
      }

      const attemptResult = this.db.prepare(`
        UPDATE smc_execution_attempts
        SET status = ?, revision = revision + 1, updated_at = ?
        WHERE attempt_id = ? AND repository_id = ? AND status IN ('STARTING', 'RUNNING') AND revision = ?
      `).run(targetAttemptStatus, now, cleanId, this.repositoryId, input.expectedAttemptRevision)

      if (attemptResult.changes === 0) {
        const recheck = this.db.prepare(`
          SELECT * FROM smc_execution_attempts WHERE attempt_id = ? AND repository_id = ?
        `).get(cleanId, this.repositoryId) as RawExecutionAttemptRow | undefined
        if (recheck && (recheck.status === 'COMPLETED' || recheck.status === 'FAILED' || recheck.status === 'CANCELLED')) {
          return this.mapRawToExecutionAttemptRecord(recheck)
        }
        throw new ExecutionAttemptConflictError(
          `CAS conflict: attempt "${cleanId}" status="${recheck?.status}" revision=${recheck?.revision}, expected STARTING/RUNNING@${input.expectedAttemptRevision}`
        )
      }

      const unitResult = this.db.prepare(`
        UPDATE smc_unit_states
        SET status = ?, revision = revision + 1, updated_at = ?
        WHERE unit_id = ? AND revision = ? AND status IN ('RESERVED', 'EXECUTING')
      `).run(targetUnitStatus, now, input.unitId, input.expectedUnitRevision)

      if (unitResult.changes === 0) {
        const recheckUnit = this.db.prepare(`
          SELECT status, revision FROM smc_unit_states WHERE unit_id = ?
        `).get(input.unitId) as { status: string; revision: number } | undefined
        if (recheckUnit && (recheckUnit.status === 'VALIDATING' || recheckUnit.status === 'RECONCILING')) {
          // Concorrência já atualizou unidade
        } else {
          throw new ExecutionAttemptConflictError(
            `CAS conflict: unit "${input.unitId}" not in (RESERVED, EXECUTING)@${input.expectedUnitRevision}`
          )
        }
      }

      const entryId = deterministicEntryId('settle', cleanId)
      const existingEntry = this.db.prepare(`
        SELECT entry_id FROM smc_entries WHERE entry_id = ? AND session_id = ?
      `).get(entryId, existing.session_id)

      if (!existingEntry) {
        const title = input.entryData?.title ?? `Execution attempt settled: ${targetAttemptStatus}`
        const body = input.entryData?.body ?? JSON.stringify({
          attemptId: cleanId,
          unitId: input.unitId,
          terminalOutcome: input.terminalOutcome,
          attemptStatus: targetAttemptStatus,
          unitStatus: targetUnitStatus
        })
        const kind = input.entryData?.kind ?? defaultKind
        const referencesJson = JSON.stringify([{ kind: 'PROOF', target: cleanId }])

        this.db.prepare(`
          INSERT INTO smc_entries (
            entry_id, session_id, kind, title, body,
            emitter_role, emitter_id, references_json, supersedes_entry_id, created_at
          ) VALUES (?, ?, ?, ?, ?, 'SYSTEM', 'buildx-execution-service', ?, NULL, ?)
        `).run(
          entryId,
          existing.session_id,
          kind,
          title,
          body,
          referencesJson,
          now
        )
      }

      const updated = this.db.prepare(`
        SELECT * FROM smc_execution_attempts WHERE attempt_id = ? AND repository_id = ?
      `).get(cleanId, this.repositoryId) as RawExecutionAttemptRow
      return this.mapRawToExecutionAttemptRecord(updated)
    })()
  }

  transitionUnitToAccepted(input: AcceptUnitFlowUnitStoreInput): AcceptUnitFlowUnitStoreResult {
    if (typeof input.unitId !== 'string' || !input.unitId.trim() || !UUID_REGEX.test(input.unitId.trim())) {
      throw new UnitFlowInvalidUnitError(input.unitId ?? '')
    }
    if (typeof input.acceptanceOperationId !== 'string' || !input.acceptanceOperationId.trim() || !UUID_REGEX.test(input.acceptanceOperationId.trim())) {
      throw new UnitFlowAcceptanceConflictError(`Invalid acceptanceOperationId: "${input.acceptanceOperationId}"`)
    }
    const cleanSessionId = input.sessionId.trim().toLowerCase()
    const cleanPlanId = input.planId.trim().toLowerCase()
    const cleanUnitId = input.unitId.trim().toLowerCase()
    const cleanReservationId = input.reservationId.trim().toLowerCase()
    const cleanAttemptId = input.attemptId.trim().toLowerCase()
    const cleanAcceptanceOpId = input.acceptanceOperationId.trim().toLowerCase()
    const now = new Date().toISOString()

    return this.db.transaction((): AcceptUnitFlowUnitStoreResult => {
      // 1. Replay check
      const entryId = deterministicEntryId('accept', cleanAcceptanceOpId)
      const existingEntry = this.db.prepare(`
        SELECT entry_id, body FROM smc_entries WHERE entry_id = ? AND session_id = ?
      `).get(entryId, cleanSessionId) as { entry_id: string; body: string } | undefined

      if (existingEntry) {
        try {
          const parsed = JSON.parse(existingEntry.body)
          if (parsed.attemptId === cleanAttemptId && parsed.unitId === cleanUnitId) {
            const curUnit = this.db.prepare(`SELECT status, revision FROM smc_unit_states WHERE unit_id = ?`).get(cleanUnitId) as any
            const curRes = this.db.prepare(`SELECT status FROM smc_unit_reservations WHERE reservation_id = ?`).get(cleanReservationId) as any
            const curPlan = this.db.prepare(`SELECT status, revision FROM smc_plans WHERE plan_id = ?`).get(cleanPlanId) as any
            return {
              unitId: cleanUnitId,
              planId: cleanPlanId,
              unitStatus: curUnit?.status ?? 'COMPLETED',
              unitRevision: curUnit?.revision ?? 0,
              reservationStatus: curRes?.status ?? 'CONSUMED',
              planStatus: curPlan?.status ?? 'ACTIVE',
              planRevision: curPlan?.revision ?? 0,
              allUnitsCompleted: curPlan?.status === 'COMPLETED'
            }
          }
        } catch {}
        throw new UnitFlowAcceptanceConflictError(`acceptanceOperationId "${cleanAcceptanceOpId}" already exists with divergent payload`)
      }

      // 2. Validate unit state
      const currentUnit = this.db.prepare(`
        SELECT unit_id, plan_id, status, revision FROM smc_unit_states WHERE unit_id = ?
      `).get(cleanUnitId) as RawUnitStateRow | undefined

      if (!currentUnit) {
        throw new UnitFlowInvalidUnitError(`Unit "${cleanUnitId}" not found`)
      }
      if (currentUnit.status !== 'VALIDATING') {
        throw new UnitFlowAcceptanceConflictError(`Unit "${cleanUnitId}" is in status "${currentUnit.status}", expected VALIDATING`)
      }

      // 3. CAS on smc_unit_states (VALIDATING -> COMPLETED)
      const unitResult = this.db.prepare(`
        UPDATE smc_unit_states
        SET status = 'COMPLETED', revision = revision + 1, updated_at = ?
        WHERE unit_id = ? AND revision = ? AND status = 'VALIDATING'
      `).run(now, cleanUnitId, input.expectedUnitRevision)

      if (unitResult.changes === 0) {
        const recheck = this.db.prepare(`
          SELECT status, revision FROM smc_unit_states WHERE unit_id = ?
        `).get(cleanUnitId) as { status: string; revision: number } | undefined
        throw new UnitFlowAcceptanceConflictError(
          `CAS conflict on unit "${cleanUnitId}": status="${recheck?.status}" revision=${recheck?.revision}, expected VALIDATING@${input.expectedUnitRevision}`
        )
      }

      // 4. CAS on smc_unit_reservations (ACTIVE -> CONSUMED)
      const reservationResult = this.db.prepare(`
        UPDATE smc_unit_reservations
        SET status = 'CONSUMED', updated_at = ?
        WHERE reservation_id = ? AND repository_id = ? AND status = 'ACTIVE'
      `).run(now, cleanReservationId, this.repositoryId)

      if (reservationResult.changes === 0) {
        const recheckRes = this.db.prepare(`
          SELECT status FROM smc_unit_reservations WHERE reservation_id = ? AND repository_id = ?
        `).get(cleanReservationId, this.repositoryId) as { status: string } | undefined
        throw new UnitFlowAcceptanceConflictError(
          `CAS conflict on reservation "${cleanReservationId}": status="${recheckRes?.status}", expected ACTIVE`
        )
      }

      // 5. Append smc_entries (RESULT)
      const title = `Unit accepted: ${cleanUnitId}`
      const body = JSON.stringify({
        acceptanceOperationId: cleanAcceptanceOpId,
        attemptId: cleanAttemptId,
        unitId: cleanUnitId,
        planId: cleanPlanId,
        proofIds: input.proofIds,
        summary: input.acceptanceSummary,
        gitIdentity: input.gitIdentity
      })
      const referencesJson = JSON.stringify(input.proofIds.map(pid => ({ kind: 'PROOF', target: pid })))

      this.db.prepare(`
        INSERT INTO smc_entries (
          entry_id, session_id, kind, title, body,
          emitter_role, emitter_id, references_json, supersedes_entry_id, created_at
        ) VALUES (?, ?, 'RESULT', ?, ?, 'AGENT', ?, ?, NULL, ?)
      `).run(
        entryId,
        cleanSessionId,
        title,
        body,
        input.emitterId ?? 'buildx-agent',
        referencesJson,
        now
      )

      // 6. Check if all units of plan are now COMPLETED
      const pendingUnits = this.db.prepare(`
        SELECT count(*) as c FROM smc_unit_states WHERE plan_id = ? AND status != 'COMPLETED'
      `).get(cleanPlanId) as { c: number }

      let allUnitsCompleted = false
      if (pendingUnits.c === 0) {
        this.db.prepare(`
          UPDATE smc_plans
          SET status = 'COMPLETED', revision = revision + 1, updated_at = ?
          WHERE plan_id = ? AND repository_id = ? AND status = 'ACTIVE'
        `).run(now, cleanPlanId, this.repositoryId)
        allUnitsCompleted = true
      }

      const finalUnit = this.db.prepare(`SELECT status, revision FROM smc_unit_states WHERE unit_id = ?`).get(cleanUnitId) as any
      const finalRes = this.db.prepare(`SELECT status FROM smc_unit_reservations WHERE reservation_id = ?`).get(cleanReservationId) as any
      const finalPlan = this.db.prepare(`SELECT status, revision FROM smc_plans WHERE plan_id = ?`).get(cleanPlanId) as any

      return {
        unitId: cleanUnitId,
        planId: cleanPlanId,
        unitStatus: finalUnit.status,
        unitRevision: finalUnit.revision,
        reservationStatus: finalRes.status,
        planStatus: finalPlan.status,
        planRevision: finalPlan.revision,
        allUnitsCompleted
      }
    })()
  }

  transitionUnitToReconciled(input: ReconcileUnitFlowUnitStoreInput): ReconcileUnitFlowUnitStoreResult {
    if (typeof input.unitId !== 'string' || !input.unitId.trim() || !UUID_REGEX.test(input.unitId.trim())) {
      throw new UnitFlowInvalidUnitError(input.unitId ?? '')
    }
    if (typeof input.reconciliationOperationId !== 'string' || !input.reconciliationOperationId.trim() || !UUID_REGEX.test(input.reconciliationOperationId.trim())) {
      throw new UnitFlowReconciliationConflictError(`Invalid reconciliationOperationId: "${input.reconciliationOperationId}"`)
    }
    const cleanSessionId = input.sessionId.trim().toLowerCase()
    const cleanPlanId = input.planId.trim().toLowerCase()
    const cleanUnitId = input.unitId.trim().toLowerCase()
    const cleanReservationId = input.reservationId.trim().toLowerCase()
    const cleanAttemptId = input.attemptId.trim().toLowerCase()
    const cleanReconciliationOpId = input.reconciliationOperationId.trim().toLowerCase()
    const now = new Date().toISOString()

    return this.db.transaction((): ReconcileUnitFlowUnitStoreResult => {
      // 1. Replay check
      const entryId = deterministicEntryId('reconcile', cleanReconciliationOpId)
      const existingEntry = this.db.prepare(`
        SELECT entry_id, body FROM smc_entries WHERE entry_id = ? AND session_id = ?
      `).get(entryId, cleanSessionId) as { entry_id: string; body: string } | undefined

      if (existingEntry) {
        try {
          const parsed = JSON.parse(existingEntry.body)
          if (parsed.attemptId === cleanAttemptId && parsed.unitId === cleanUnitId && parsed.decision === input.decision) {
            const curUnit = this.db.prepare(`SELECT status, revision FROM smc_unit_states WHERE unit_id = ?`).get(cleanUnitId) as any
            const curRes = this.db.prepare(`SELECT status FROM smc_unit_reservations WHERE reservation_id = ?`).get(cleanReservationId) as any
            const curPlan = this.db.prepare(`SELECT status, revision FROM smc_plans WHERE plan_id = ?`).get(cleanPlanId) as any
            return {
              unitId: cleanUnitId,
              planId: cleanPlanId,
              unitStatus: curUnit?.status ?? 'AVAILABLE',
              unitRevision: curUnit?.revision ?? 0,
              reservationStatus: curRes?.status ?? 'CANCELLED',
              planStatus: curPlan?.status ?? 'ACTIVE',
              planRevision: curPlan?.revision ?? 0,
              decision: input.decision
            }
          }
        } catch {}
        throw new UnitFlowReconciliationConflictError(`reconciliationOperationId "${cleanReconciliationOpId}" already exists with divergent payload`)
      }

      // 2. Validate unit state
      const currentUnit = this.db.prepare(`
        SELECT unit_id, plan_id, status, revision FROM smc_unit_states WHERE unit_id = ?
      `).get(cleanUnitId) as RawUnitStateRow | undefined

      if (!currentUnit) {
        throw new UnitFlowInvalidUnitError(`Unit "${cleanUnitId}" not found`)
      }
      if (currentUnit.status !== 'RECONCILING') {
        throw new UnitFlowReconciliationConflictError(`Unit "${cleanUnitId}" is in status "${currentUnit.status}", expected RECONCILING`)
      }

      // 3. CAS on smc_unit_states (RECONCILING -> AVAILABLE)
      const unitResult = this.db.prepare(`
        UPDATE smc_unit_states
        SET status = 'AVAILABLE', revision = revision + 1, updated_at = ?
        WHERE unit_id = ? AND revision = ? AND status = 'RECONCILING'
      `).run(now, cleanUnitId, input.expectedUnitRevision)

      if (unitResult.changes === 0) {
        const recheck = this.db.prepare(`
          SELECT status, revision FROM smc_unit_states WHERE unit_id = ?
        `).get(cleanUnitId) as { status: string; revision: number } | undefined
        throw new UnitFlowReconciliationConflictError(
          `CAS conflict on unit "${cleanUnitId}": status="${recheck?.status}" revision=${recheck?.revision}, expected RECONCILING@${input.expectedUnitRevision}`
        )
      }

      // 4. CAS on smc_unit_reservations (ACTIVE -> CANCELLED)
      const reservationResult = this.db.prepare(`
        UPDATE smc_unit_reservations
        SET status = 'CANCELLED', updated_at = ?
        WHERE reservation_id = ? AND repository_id = ? AND status = 'ACTIVE'
      `).run(now, cleanReservationId, this.repositoryId)

      if (reservationResult.changes === 0) {
        const recheckRes = this.db.prepare(`
          SELECT status FROM smc_unit_reservations WHERE reservation_id = ? AND repository_id = ?
        `).get(cleanReservationId, this.repositoryId) as { status: string } | undefined
        throw new UnitFlowReconciliationConflictError(
          `CAS conflict on reservation "${cleanReservationId}": status="${recheckRes?.status}", expected ACTIVE`
        )
      }

      // 5. Append smc_entries (INTERVENTION)
      const title = `Unit reconciliation: ${input.decision} (${cleanUnitId})`
      const body = JSON.stringify({
        reconciliationOperationId: cleanReconciliationOpId,
        attemptId: cleanAttemptId,
        unitId: cleanUnitId,
        planId: cleanPlanId,
        reservationId: cleanReservationId,
        decision: input.decision,
        summary: input.summary,
        gitIdentity: input.gitIdentity,
        worktreeChangesSummary: input.worktreeChangesSummary
      })
      const referencesJson = JSON.stringify([
        { kind: 'ATTEMPT', target: cleanAttemptId },
        { kind: 'UNIT', target: cleanUnitId },
        { kind: 'RESERVATION', target: cleanReservationId }
      ])

      this.db.prepare(`
        INSERT INTO smc_entries (
          entry_id, session_id, kind, title, body,
          emitter_role, emitter_id, references_json, supersedes_entry_id, created_at
        ) VALUES (?, ?, 'INTERVENTION', ?, ?, 'AGENT', ?, ?, NULL, ?)
      `).run(
        entryId,
        cleanSessionId,
        title,
        body,
        input.emitterId ?? 'buildx-agent',
        referencesJson,
        now
      )

      const finalUnit = this.db.prepare(`SELECT status, revision FROM smc_unit_states WHERE unit_id = ?`).get(cleanUnitId) as any
      const finalRes = this.db.prepare(`SELECT status FROM smc_unit_reservations WHERE reservation_id = ?`).get(cleanReservationId) as any
      const finalPlan = this.db.prepare(`SELECT status, revision FROM smc_plans WHERE plan_id = ?`).get(cleanPlanId) as any

      return {
        unitId: cleanUnitId,
        planId: cleanPlanId,
        unitStatus: finalUnit.status,
        unitRevision: finalUnit.revision,
        reservationStatus: finalRes.status,
        planStatus: finalPlan.status,
        planRevision: finalPlan.revision,
        decision: input.decision
      }
    })()
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
