import type Database from 'better-sqlite3'
import { digest } from './privacy'
import type { NativeSourceEventType } from './native-source-events'

export const NATIVE_CODEX_NORMALIZER = 'native-codex-v3'
export const NATIVE_ANTIGRAVITY_NORMALIZER = 'native-antigravity-v3'

export interface NativeTurnSummary {
  id: string
  firstObserved: string
  lastObserved: string
  eventCount: number
}

export interface NativeAttemptSummary {
  total: number
  success: number
  failure: number
  refusal: number
  dangling: number
  unknown: number
  attemptCoverage: string
}

export interface NativeIndexedDiagnosticRef {
  eventId: string
  ordinal: number
  timestamp?: string
  tool?: string
  turnId?: string
  status?: string
  errorKind?: string
  pairing?: string
}

export interface NativeTimeCoverage {
  timestampedEvents: number
  missingTimestamps: number
}

export interface NativeSourceRecordSummary {
  nativeKey: string
  provider: 'codex' | 'antigravity'
  repositoryId: string
  worktreeId: string
  generation: string
  sourceSessionId: string
  locatorHash: string
  normalizer: string
  revision: number
  fileIdentity: string
  prefixDigest: string
  tailOffset: number
  tailDigest: string
  sourceBytes: number
  indexedBytes: number
  eventCount: number
  omittedRecords: number
  sourceCoverage: string
  attemptCoverage: string
  timeCoverage: NativeTimeCoverage
  sourceTools: Array<{ tool: string; count: number }>
  sourceTypeCounts: Array<{ type: NativeSourceEventType; count: number }>
  attemptSummary: NativeAttemptSummary
  errors: NativeIndexedDiagnosticRef[]
  omittedErrors: number
  danglingCalls: NativeIndexedDiagnosticRef[]
  omittedDanglingCalls: number
  turnCount: number
  lastOrdinal: number
  currentTurnId?: string
  openCallsJson: string
  updatedAt: string
}

export interface NativeIndexingCheckpoint {
  nativeKey: string
  revision: number
  locatorHash: string
  normalizer: string
  fileIdentity: string
  prefixDigest: string
  nextOffset: number
  tailDigest: string
  sourceBytes: number
  stateJson: string
  updatedAt: string
}

export interface NativeIndexedEventRow {
  seq: number
  ordinal: number
  eventId: string
  type: NativeSourceEventType
  timestamp?: string
  timestampMs?: number
  tool?: string
  turnId?: string
  status?: string
  pairing?: string
  errorKind?: string
  bytes: number
  payloadDigest: string
  sanitized: boolean
  lineStart: number
  lineEnd: number
  partIndex: number
}

export interface NativeEventFilter {
  types?: string[]
  tool?: string
  turnId?: string
  after?: string
  before?: string
}

export function nativeReferenceKey(
  provider: 'codex' | 'antigravity',
  repositoryId: string,
  worktreeId: string,
  generation: string,
  sourceSessionId: string
): string {
  return digest(JSON.stringify([provider, repositoryId, worktreeId, generation, sourceSessionId]))
}

export function toNativeEventMeta(row: NativeIndexedEventRow) {
  return {
    eventId: row.eventId,
    ordinal: row.ordinal,
    type: row.type,
    ...(row.timestamp ? { timestamp: row.timestamp } : {}),
    ...(row.tool ? { tool: row.tool } : {}),
    ...(row.turnId ? { turnId: row.turnId } : {}),
    ...(row.status ? { status: row.status } : {}),
    ...(row.pairing ? { pairing: row.pairing } : {}),
    ...(row.errorKind ? { errorKind: row.errorKind } : {}),
    bytes: row.bytes,
    payloadDigest: row.payloadDigest,
    sanitized: row.sanitized
  }
}

export class NativeSessionReferences {
  readonly available: boolean
  readonly isReadOnly: boolean
  constructor(private readonly db: Database.Database, private readonly readOnly = false) {
    this.isReadOnly = readOnly
    if (readOnly) {
      const table = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_reference_sources'"
      ).get()
      this.available = !!table
      return
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS native_reference_sources (
        nativeKey TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        repositoryId TEXT NOT NULL,
        worktreeId TEXT NOT NULL,
        generation TEXT NOT NULL,
        sourceSessionId TEXT NOT NULL,
        locatorHash TEXT NOT NULL,
        normalizer TEXT NOT NULL,
        revision INTEGER NOT NULL,
        fileIdentity TEXT NOT NULL,
        prefixDigest TEXT NOT NULL,
        tailOffset INTEGER NOT NULL,
        tailDigest TEXT NOT NULL,
        sourceBytes INTEGER NOT NULL,
        indexedBytes INTEGER NOT NULL,
        eventCount INTEGER NOT NULL,
        omittedRecords INTEGER NOT NULL,
        sourceCoverage TEXT NOT NULL,
        attemptCoverage TEXT NOT NULL,
        timeCoverage TEXT NOT NULL,
        sourceTools TEXT NOT NULL,
        sourceTypeCounts TEXT NOT NULL,
        attemptSummary TEXT NOT NULL,
        errors TEXT NOT NULL,
        omittedErrors INTEGER NOT NULL,
        danglingCalls TEXT NOT NULL,
        omittedDanglingCalls INTEGER NOT NULL,
        turnCount INTEGER NOT NULL,
        lastOrdinal INTEGER NOT NULL DEFAULT 0,
        currentTurnId TEXT,
        openCallsJson TEXT NOT NULL DEFAULT '{}',
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS native_reference_checkpoints (
        nativeKey TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        locatorHash TEXT NOT NULL,
        normalizer TEXT NOT NULL,
        fileIdentity TEXT NOT NULL,
        prefixDigest TEXT NOT NULL,
        nextOffset INTEGER NOT NULL,
        tailDigest TEXT NOT NULL,
        sourceBytes INTEGER NOT NULL,
        stateJson TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS native_reference_events (
        nativeKey TEXT NOT NULL,
        revision INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        eventId TEXT NOT NULL,
        type TEXT NOT NULL,
        timestamp TEXT,
        timestampMs INTEGER,
        tool TEXT,
        turnId TEXT,
        status TEXT,
        pairing TEXT,
        errorKind TEXT,
        bytes INTEGER NOT NULL,
        payloadDigest TEXT NOT NULL,
        sanitized INTEGER NOT NULL,
        lineStart INTEGER NOT NULL,
        lineEnd INTEGER NOT NULL,
        partIndex INTEGER NOT NULL,
        PRIMARY KEY (nativeKey, revision, seq),
        UNIQUE (nativeKey, revision, eventId)
      );
      CREATE INDEX IF NOT EXISTS native_ref_events_type ON native_reference_events(nativeKey, revision, type, seq);
      CREATE INDEX IF NOT EXISTS native_ref_events_tool ON native_reference_events(nativeKey, revision, tool, seq);
      CREATE INDEX IF NOT EXISTS native_ref_events_turn ON native_reference_events(nativeKey, revision, turnId, seq);
      CREATE TABLE IF NOT EXISTS native_reference_turns (
        nativeKey TEXT NOT NULL,
        revision INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        turnId TEXT NOT NULL,
        firstTime TEXT,
        lastTime TEXT,
        eventCount INTEGER NOT NULL,
        typesJson TEXT NOT NULL,
        PRIMARY KEY (nativeKey, revision, turnId)
      );
      CREATE INDEX IF NOT EXISTS native_ref_turns_order ON native_reference_turns(nativeKey, revision, ordinal);
      CREATE TABLE IF NOT EXISTS native_reference_revisions (
        nativeKey TEXT PRIMARY KEY,
        lastRevision INTEGER NOT NULL
      );
    `)
    this.available = true
  }

  private assertWritable(): void {
    if (this.readOnly) throw new Error('STORE_READ_ONLY')
  }

  getSummary(nativeKey: string): NativeSourceRecordSummary | undefined {
    if (!this.available) return undefined
    const row = this.db.prepare('SELECT * FROM native_reference_sources WHERE nativeKey=?').get(nativeKey) as
      Record<string, unknown> | undefined
    if (!row) return undefined
    return {
      nativeKey: String(row.nativeKey),
      provider: row.provider as 'codex' | 'antigravity',
      repositoryId: String(row.repositoryId),
      worktreeId: String(row.worktreeId),
      generation: String(row.generation),
      sourceSessionId: String(row.sourceSessionId),
      locatorHash: String(row.locatorHash),
      normalizer: String(row.normalizer),
      revision: Number(row.revision),
      fileIdentity: String(row.fileIdentity),
      prefixDigest: String(row.prefixDigest),
      tailOffset: Number(row.tailOffset),
      tailDigest: String(row.tailDigest),
      sourceBytes: Number(row.sourceBytes),
      indexedBytes: Number(row.indexedBytes),
      eventCount: Number(row.eventCount),
      omittedRecords: Number(row.omittedRecords),
      sourceCoverage: String(row.sourceCoverage),
      attemptCoverage: String(row.attemptCoverage),
      timeCoverage: JSON.parse(String(row.timeCoverage)) as NativeTimeCoverage,
      sourceTools: JSON.parse(String(row.sourceTools)) as Array<{ tool: string; count: number }>,
      sourceTypeCounts: JSON.parse(String(row.sourceTypeCounts)) as Array<{ type: NativeSourceEventType; count: number }>,
      attemptSummary: JSON.parse(String(row.attemptSummary)) as NativeAttemptSummary,
      errors: JSON.parse(String(row.errors)) as NativeIndexedDiagnosticRef[],
      omittedErrors: Number(row.omittedErrors),
      danglingCalls: JSON.parse(String(row.danglingCalls)) as NativeIndexedDiagnosticRef[],
      omittedDanglingCalls: Number(row.omittedDanglingCalls),
      turnCount: Number(row.turnCount),
      lastOrdinal: Number(row.lastOrdinal ?? 0),
      ...(row.currentTurnId ? { currentTurnId: String(row.currentTurnId) } : {}),
      openCallsJson: String(row.openCallsJson ?? '{}'),
      updatedAt: String(row.updatedAt)
    }
  }

  getCheckpoint(nativeKey: string): NativeIndexingCheckpoint | undefined {
    if (!this.available) return undefined
    return this.db.prepare('SELECT * FROM native_reference_checkpoints WHERE nativeKey=?').get(nativeKey) as
      NativeIndexingCheckpoint | undefined
  }

  nextRevision(nativeKey: string): number {
    if (!this.available) return 1
    const hasRevTable = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_reference_revisions'").get()
    const rev = hasRevTable
      ? this.db.prepare('SELECT lastRevision FROM native_reference_revisions WHERE nativeKey=?').get(nativeKey) as { lastRevision: number } | undefined
      : undefined
    const src = this.db.prepare('SELECT revision FROM native_reference_sources WHERE nativeKey=?').get(nativeKey) as { revision: number } | undefined
    const cp = this.db.prepare('SELECT revision FROM native_reference_checkpoints WHERE nativeKey=?').get(nativeKey) as { revision: number } | undefined
    const ev = this.db.prepare('SELECT MAX(revision) AS r FROM native_reference_events WHERE nativeKey=?').get(nativeKey) as { r: number | null } | undefined
    return Math.max(rev?.lastRevision ?? 0, src?.revision ?? 0, cp?.revision ?? 0, ev?.r ?? 0) + 1
  }

  startFreshCheckpoint(input: {
    nativeKey: string
    locatorHash: string
    normalizer: string
    fileIdentity: string
    prefixDigest: string
    sourceBytes: number
    stateJson: string
  }): NativeIndexingCheckpoint {
    this.assertWritable()
    return this.db.transaction(() => {
      const revision = this.nextRevision(input.nativeKey)
      const now = new Date().toISOString()
      const cp: NativeIndexingCheckpoint = {
        nativeKey: input.nativeKey,
        revision,
        locatorHash: input.locatorHash,
        normalizer: input.normalizer,
        fileIdentity: input.fileIdentity,
        prefixDigest: input.prefixDigest,
        nextOffset: 0,
        tailDigest: '',
        sourceBytes: input.sourceBytes,
        stateJson: input.stateJson,
        updatedAt: now
      }
      this.db.prepare('INSERT OR REPLACE INTO native_reference_revisions (nativeKey, lastRevision) VALUES (?,?)').run(input.nativeKey, revision)
      this.db.prepare('DELETE FROM native_reference_checkpoints WHERE nativeKey=?').run(input.nativeKey)
      this.db.prepare(`DELETE FROM native_reference_events WHERE nativeKey=? AND revision NOT IN (
        SELECT revision FROM native_reference_sources WHERE nativeKey=?
      )`).run(input.nativeKey, input.nativeKey)
      this.db.prepare(`DELETE FROM native_reference_turns WHERE nativeKey=? AND revision NOT IN (
        SELECT revision FROM native_reference_sources WHERE nativeKey=?
      )`).run(input.nativeKey, input.nativeKey)
      this.db.prepare(`
        INSERT OR REPLACE INTO native_reference_checkpoints
        (nativeKey, revision, locatorHash, normalizer, fileIdentity, prefixDigest, nextOffset, tailDigest, sourceBytes, stateJson, updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        cp.nativeKey, cp.revision, cp.locatorHash, cp.normalizer, cp.fileIdentity, cp.prefixDigest,
        cp.nextOffset, cp.tailDigest, cp.sourceBytes, cp.stateJson, cp.updatedAt
      )
      return cp
    }).immediate()
  }

  saveChunk(input: {
    nativeKey: string
    revision: number
    events: NativeIndexedEventRow[]
    pairUpdates: Array<{ eventId: string; status: string; pairing: string }>
    turns: Array<{ ordinal: number; turnId: string; firstTime?: string; lastTime?: string; eventCount: number; typesJson: string }>
    nextOffset: number
    tailDigest: string
    sourceBytes: number
    fileIdentity: string
    stateJson: string
  }): void {
    this.assertWritable()
    this.db.transaction(() => {
      const insertEvent = this.db.prepare(`
        INSERT INTO native_reference_events
        (nativeKey, revision, seq, ordinal, eventId, type, timestamp, timestampMs, tool, turnId, status, pairing, errorKind, bytes, payloadDigest, sanitized, lineStart, lineEnd, partIndex)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `)
      for (const ev of input.events) {
        insertEvent.run(
          input.nativeKey, input.revision, ev.seq, ev.ordinal, ev.eventId, ev.type,
          ev.timestamp ?? null, ev.timestampMs ?? null, ev.tool ?? null, ev.turnId ?? null,
          ev.status ?? null, ev.pairing ?? null, ev.errorKind ?? null,
          ev.bytes, ev.payloadDigest, ev.sanitized ? 1 : 0, ev.lineStart, ev.lineEnd, ev.partIndex
        )
      }
      if (input.pairUpdates.length) {
        const updatePair = this.db.prepare(
          'UPDATE native_reference_events SET status=?, pairing=? WHERE nativeKey=? AND revision=? AND eventId=?'
        )
        for (const pair of input.pairUpdates) {
          updatePair.run(pair.status, pair.pairing, input.nativeKey, input.revision, pair.eventId)
        }
      }
      if (input.turns.length) {
        const upsertTurn = this.db.prepare(`
          INSERT INTO native_reference_turns (nativeKey, revision, ordinal, turnId, firstTime, lastTime, eventCount, typesJson)
          VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(nativeKey, revision, turnId) DO UPDATE SET
            firstTime = CASE
              WHEN native_reference_turns.firstTime IS NULL OR native_reference_turns.firstTime = '' THEN excluded.firstTime
              WHEN excluded.firstTime IS NULL OR excluded.firstTime = '' THEN native_reference_turns.firstTime
              WHEN excluded.firstTime < native_reference_turns.firstTime THEN excluded.firstTime
              ELSE native_reference_turns.firstTime
            END,
            lastTime = CASE
              WHEN native_reference_turns.lastTime IS NULL OR native_reference_turns.lastTime = '' THEN excluded.lastTime
              WHEN excluded.lastTime IS NULL OR excluded.lastTime = '' THEN native_reference_turns.lastTime
              WHEN excluded.lastTime > native_reference_turns.lastTime THEN excluded.lastTime
              ELSE native_reference_turns.lastTime
            END,
            eventCount = native_reference_turns.eventCount + excluded.eventCount
        `)
        for (const t of input.turns) {
          upsertTurn.run(input.nativeKey, input.revision, t.ordinal, t.turnId, t.firstTime ?? null, t.lastTime ?? null, t.eventCount, t.typesJson)
        }
      }
      this.db.prepare(`
        UPDATE native_reference_checkpoints
        SET nextOffset=?, tailDigest=?, sourceBytes=?, fileIdentity=?, stateJson=?, updatedAt=?
        WHERE nativeKey=? AND revision=?
      `).run(
        input.nextOffset, input.tailDigest, input.sourceBytes, input.fileIdentity, input.stateJson,
        new Date().toISOString(), input.nativeKey, input.revision
      )
    }).immediate()
  }

  promote(summary: NativeSourceRecordSummary): NativeSourceRecordSummary {
    this.assertWritable()
    return this.db.transaction(() => {
      const turnCount = (this.db.prepare(
        'SELECT COUNT(*) AS count FROM native_reference_turns WHERE nativeKey=? AND revision=?'
      ).get(summary.nativeKey, summary.revision) as { count: number }).count
      const persisted = { ...summary, turnCount }
      this.db.prepare(`
        INSERT OR REPLACE INTO native_reference_sources (
          nativeKey, provider, repositoryId, worktreeId, generation, sourceSessionId, locatorHash, normalizer, revision,
          fileIdentity, prefixDigest, tailOffset, tailDigest, sourceBytes, indexedBytes, eventCount, omittedRecords,
          sourceCoverage, attemptCoverage, timeCoverage, sourceTools, sourceTypeCounts, attemptSummary,
          errors, omittedErrors, danglingCalls, omittedDanglingCalls, turnCount, lastOrdinal, currentTurnId, openCallsJson, updatedAt
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        persisted.nativeKey, persisted.provider, persisted.repositoryId, persisted.worktreeId, persisted.generation, persisted.sourceSessionId,
        persisted.locatorHash, persisted.normalizer, persisted.revision, persisted.fileIdentity, persisted.prefixDigest,
        persisted.tailOffset, persisted.tailDigest, persisted.sourceBytes, persisted.indexedBytes, persisted.eventCount, persisted.omittedRecords,
        persisted.sourceCoverage, persisted.attemptCoverage, JSON.stringify(persisted.timeCoverage),
        JSON.stringify(persisted.sourceTools), JSON.stringify(persisted.sourceTypeCounts), JSON.stringify(persisted.attemptSummary),
        JSON.stringify(persisted.errors), persisted.omittedErrors, JSON.stringify(persisted.danglingCalls), persisted.omittedDanglingCalls,
        persisted.turnCount, persisted.lastOrdinal, persisted.currentTurnId ?? null, persisted.openCallsJson, persisted.updatedAt
      )
      this.db.prepare('DELETE FROM native_reference_checkpoints WHERE nativeKey=? AND revision<=?').run(persisted.nativeKey, persisted.revision)
      this.db.prepare('DELETE FROM native_reference_events WHERE nativeKey=? AND revision<>?').run(persisted.nativeKey, persisted.revision)
      this.db.prepare('DELETE FROM native_reference_turns WHERE nativeKey=? AND revision<>?').run(persisted.nativeKey, persisted.revision)
      return persisted
    }).immediate()
  }

  invalidate(nativeKey: string): void {
    if (this.readOnly || !this.available) return
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM native_reference_sources WHERE nativeKey=?').run(nativeKey)
      this.db.prepare('DELETE FROM native_reference_checkpoints WHERE nativeKey=?').run(nativeKey)
      this.db.prepare('DELETE FROM native_reference_events WHERE nativeKey=?').run(nativeKey)
      this.db.prepare('DELETE FROM native_reference_turns WHERE nativeKey=?').run(nativeKey)
    }).immediate()
  }

  pageTurns(nativeKey: string, revision: number, offset: number, limit: number): NativeTurnSummary[] {
    if (!this.available) return []
    const rows = this.db.prepare(`
      SELECT turnId, firstTime, lastTime, eventCount, typesJson
      FROM native_reference_turns
      WHERE nativeKey=? AND revision=?
      ORDER BY ordinal ASC
      LIMIT ? OFFSET ?
    `).all(nativeKey, revision, limit, offset) as Array<{
      turnId: string; firstTime: string | null; lastTime: string | null; eventCount: number; typesJson: string
    }>
    return rows.map(row => ({
      id: row.turnId,
      firstObserved: row.firstTime ?? '',
      lastObserved: row.lastTime ?? '',
      eventCount: row.eventCount
    }))
  }

  private buildEventWhere(nativeKey: string, revision: number, filters: NativeEventFilter): { sql: string; params: unknown[] } {
    const clauses = ['nativeKey=?', 'revision=?']
    const params: unknown[] = [nativeKey, revision]
    if (filters.types?.length) {
      clauses.push(`type IN (${filters.types.map(() => '?').join(',')})`)
      params.push(...filters.types)
    }
    if (filters.tool) {
      clauses.push('tool=?')
      params.push(filters.tool)
    }
    if (filters.turnId) {
      clauses.push('turnId=?')
      params.push(filters.turnId)
    }
    if (filters.after) {
      const ms = Date.parse(filters.after)
      if (!Number.isFinite(ms)) throw new Error('INVALID_ARGUMENT')
      clauses.push('timestampMs IS NOT NULL AND timestampMs>=?')
      params.push(ms)
    }
    if (filters.before) {
      const ms = Date.parse(filters.before)
      if (!Number.isFinite(ms)) throw new Error('INVALID_ARGUMENT')
      clauses.push('timestampMs IS NOT NULL AND timestampMs<=?')
      params.push(ms)
    }
    return { sql: clauses.join(' AND '), params }
  }

  countEvents(nativeKey: string, revision: number, filters: NativeEventFilter): number {
    if (!this.available) return 0
    const { sql, params } = this.buildEventWhere(nativeKey, revision, filters)
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM native_reference_events WHERE ${sql}`).get(...params) as { count: number }
    return row.count
  }

  pageEvents(nativeKey: string, revision: number, filters: NativeEventFilter, offset: number, limit: number): NativeIndexedEventRow[] {
    if (!this.available) return []
    const { sql, params } = this.buildEventWhere(nativeKey, revision, filters)
    const rows = this.db.prepare(`
      SELECT seq, ordinal, eventId, type, timestamp, timestampMs, tool, turnId, status, pairing, errorKind,
             bytes, payloadDigest, sanitized, lineStart, lineEnd, partIndex
      FROM native_reference_events
      WHERE ${sql}
      ORDER BY seq ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<Omit<NativeIndexedEventRow, 'sanitized'> & { sanitized: number }>
    return rows.map(row => ({
      seq: row.seq,
      ordinal: row.ordinal,
      eventId: row.eventId,
      type: row.type,
      ...(row.timestamp ? { timestamp: row.timestamp } : {}),
      ...(row.timestampMs !== null && row.timestampMs !== undefined ? { timestampMs: row.timestampMs } : {}),
      ...(row.tool ? { tool: row.tool } : {}),
      ...(row.turnId ? { turnId: row.turnId } : {}),
      ...(row.status ? { status: row.status } : {}),
      ...(row.pairing ? { pairing: row.pairing } : {}),
      ...(row.errorKind ? { errorKind: row.errorKind } : {}),
      bytes: row.bytes,
      payloadDigest: row.payloadDigest,
      sanitized: row.sanitized === 1,
      lineStart: row.lineStart,
      lineEnd: row.lineEnd,
      partIndex: row.partIndex
    }))
  }

  getEventById(nativeKey: string, revision: number, eventId: string): NativeIndexedEventRow | undefined {
    if (!this.available) return undefined
    const row = this.db.prepare(`
      SELECT seq, ordinal, eventId, type, timestamp, timestampMs, tool, turnId, status, pairing, errorKind,
             bytes, payloadDigest, sanitized, lineStart, lineEnd, partIndex
      FROM native_reference_events
      WHERE nativeKey=? AND revision=? AND eventId=?
    `).get(nativeKey, revision, eventId) as (Omit<NativeIndexedEventRow, 'sanitized'> & { sanitized: number }) | undefined
    if (!row) return undefined
    return {
      seq: row.seq,
      ordinal: row.ordinal,
      eventId: row.eventId,
      type: row.type,
      ...(row.timestamp ? { timestamp: row.timestamp } : {}),
      ...(row.timestampMs !== null && row.timestampMs !== undefined ? { timestampMs: row.timestampMs } : {}),
      ...(row.tool ? { tool: row.tool } : {}),
      ...(row.turnId ? { turnId: row.turnId } : {}),
      ...(row.status ? { status: row.status } : {}),
      ...(row.pairing ? { pairing: row.pairing } : {}),
      ...(row.errorKind ? { errorKind: row.errorKind } : {}),
      bytes: row.bytes,
      payloadDigest: row.payloadDigest,
      sanitized: row.sanitized === 1,
      lineStart: row.lineStart,
      lineEnd: row.lineEnd,
      partIndex: row.partIndex
    }
  }
}
