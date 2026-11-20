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
  text?: string
}

export interface NativeEventFilter {
  eventId?: string
  types?: string[]
  tool?: string
  turnId?: string
  status?: string
  errorKind?: string
  isError?: boolean
  after?: string
  before?: string
}

export interface NativeCrossSessionFilter {
  repositoryId: string
  worktreeId?: string
  generation?: string
  nativeKeys?: string[]
  provider?: 'codex' | 'antigravity'
  providers?: Array<'codex' | 'antigravity'>
  sourceSessionId?: string
  types?: string[]
  tool?: string
  status?: string
  errorKind?: string
  isError?: boolean
  turnId?: string
  after?: string
  before?: string
  query?: string
  mode?: 'ALL_TERMS' | 'PHRASE'
  limit: number
  offset: number
}

export interface NativeCrossSessionHit {
  nativeKey: string
  revision: number
  provider: 'codex' | 'antigravity'
  repositoryId: string
  worktreeId: string
  generation: string
  sourceSessionId: string
  normalizer: string
  fileIdentity: string
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
  lineStart: number
  lineEnd: number
  partIndex: number
  text?: string
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
  readonly ftsAvailable: boolean
  readonly isReadOnly: boolean
  constructor(private readonly db: Database.Database, private readonly readOnly = false) {
    this.isReadOnly = readOnly
    if (readOnly) {
      const table = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_reference_sources'"
      ).get()
      this.available = !!table
      const ftsTable = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_reference_fts'"
      ).get()
      const ftsMap = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_reference_fts_map'"
      ).get()
      this.ftsAvailable = this.available && !!ftsTable && !!ftsMap
      return
    }
    try { db.pragma('secure_delete = ON') } catch {}
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
      CREATE INDEX IF NOT EXISTS native_ref_events_status ON native_reference_events(nativeKey, revision, status, seq);
      CREATE INDEX IF NOT EXISTS native_ref_events_errorkind ON native_reference_events(nativeKey, revision, errorKind, seq);
      CREATE INDEX IF NOT EXISTS native_ref_events_timems ON native_reference_events(nativeKey, revision, timestampMs, seq);
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
      CREATE TABLE IF NOT EXISTS native_reference_fts_map (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        nativeKey TEXT NOT NULL,
        revision INTEGER NOT NULL,
        eventId TEXT NOT NULL,
        UNIQUE (nativeKey, revision, eventId)
      );
      CREATE INDEX IF NOT EXISTS native_ref_fts_map_lookup ON native_reference_fts_map(nativeKey, revision);
      CREATE VIRTUAL TABLE IF NOT EXISTS native_reference_fts USING fts5(
        body,
        content='',
        contentless_delete=1,
        tokenize='unicode61 remove_diacritics 2'
      );
    `)
    try { db.prepare("INSERT INTO native_reference_fts(native_reference_fts, rank) VALUES ('secure-delete', 1)").run() } catch {}
    this.available = true
    this.ftsAvailable = true
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
      const oldFts = this.db.prepare(`SELECT rowid FROM native_reference_fts_map WHERE nativeKey=? AND revision NOT IN (
        SELECT revision FROM native_reference_sources WHERE nativeKey=?
      )`).all(input.nativeKey, input.nativeKey) as Array<{ rowid: number }>
      if (oldFts.length) {
        const delFts = this.db.prepare('DELETE FROM native_reference_fts WHERE rowid=?')
        for (const r of oldFts) delFts.run(r.rowid)
        this.db.prepare(`DELETE FROM native_reference_fts_map WHERE nativeKey=? AND revision NOT IN (
          SELECT revision FROM native_reference_sources WHERE nativeKey=?
        )`).run(input.nativeKey, input.nativeKey)
      }
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
    allowLexicalIndex?: boolean
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
      if (input.allowLexicalIndex && this.available) {
        const insertMap = this.db.prepare('INSERT OR IGNORE INTO native_reference_fts_map (nativeKey, revision, eventId) VALUES (?,?,?)')
        const insertFts = this.db.prepare('INSERT INTO native_reference_fts (rowid, body) VALUES (?,?)')
        for (const ev of input.events) {
          if (ev.text) {
            const res = insertMap.run(input.nativeKey, input.revision, ev.eventId)
            if (res.changes > 0) {
              insertFts.run(res.lastInsertRowid, ev.text)
            }
          }
        }
      }
      const cpUpdate = this.db.prepare(`
        UPDATE native_reference_checkpoints
        SET nextOffset=?, tailDigest=?, sourceBytes=?, fileIdentity=?, stateJson=?, updatedAt=?
        WHERE nativeKey=? AND revision=?
      `).run(
        input.nextOffset, input.tailDigest, input.sourceBytes, input.fileIdentity, input.stateJson,
        new Date().toISOString(), input.nativeKey, input.revision
      )
      if (cpUpdate.changes === 0) throw new Error('SOURCE_STALE')
    }).immediate()
  }

  private bumpIndexEpoch(): void {
    this.db.prepare(`
      INSERT INTO native_reference_revisions (nativeKey, lastRevision) VALUES ('$index_epoch', 1)
      ON CONFLICT(nativeKey) DO UPDATE SET lastRevision = lastRevision + 1
    `).run()
  }

  indexRevision(repositoryId: string): string {
    if (!this.available) return 'UNAVAILABLE'
    const hasRev = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_reference_revisions'").get()
    const epoch = hasRev
      ? (this.db.prepare("SELECT lastRevision FROM native_reference_revisions WHERE nativeKey='$index_epoch'").get() as { lastRevision: number } | undefined)?.lastRevision ?? 0
      : 0
    const agg = this.db.prepare(
      "SELECT COUNT(*) AS c, COALESCE(SUM(revision),0) AS s, COALESCE(MAX(updatedAt),'') AS m FROM native_reference_sources WHERE repositoryId=?"
    ).get(repositoryId) as { c: number; s: number; m: string }
    const ftsCount = this.ftsAvailable
      ? (this.db.prepare('SELECT COUNT(*) AS c FROM native_reference_fts_map').get() as { c: number }).c
      : 0
    return digest(JSON.stringify([epoch, agg.c, agg.s, agg.m, ftsCount]))
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
      const staleFts = this.db.prepare('SELECT rowid FROM native_reference_fts_map WHERE nativeKey=? AND revision<>?').all(persisted.nativeKey, persisted.revision) as Array<{ rowid: number }>
      if (staleFts.length) {
        const delFts = this.db.prepare('DELETE FROM native_reference_fts WHERE rowid=?')
        for (const r of staleFts) delFts.run(r.rowid)
        this.db.prepare('DELETE FROM native_reference_fts_map WHERE nativeKey=? AND revision<>?').run(persisted.nativeKey, persisted.revision)
      }
      this.bumpIndexEpoch()
      return persisted
    }).immediate()
  }

  invalidate(nativeKey: string): void {
    if (this.readOnly || !this.available) return
    this.db.transaction(() => {
      const had = this.db.prepare('SELECT 1 FROM native_reference_sources WHERE nativeKey=? LIMIT 1').get(nativeKey)
        || this.db.prepare('SELECT 1 FROM native_reference_checkpoints WHERE nativeKey=? LIMIT 1').get(nativeKey)
        || this.db.prepare('SELECT 1 FROM native_reference_events WHERE nativeKey=? LIMIT 1').get(nativeKey)
        || this.db.prepare('SELECT 1 FROM native_reference_fts_map WHERE nativeKey=? LIMIT 1').get(nativeKey)
      this.db.prepare('DELETE FROM native_reference_sources WHERE nativeKey=?').run(nativeKey)
      this.db.prepare('DELETE FROM native_reference_checkpoints WHERE nativeKey=?').run(nativeKey)
      this.db.prepare('DELETE FROM native_reference_events WHERE nativeKey=?').run(nativeKey)
      this.db.prepare('DELETE FROM native_reference_turns WHERE nativeKey=?').run(nativeKey)
      const ftsRows = this.db.prepare('SELECT rowid FROM native_reference_fts_map WHERE nativeKey=?').all(nativeKey) as Array<{ rowid: number }>
      if (ftsRows.length) {
        const delFts = this.db.prepare('DELETE FROM native_reference_fts WHERE rowid=?')
        for (const r of ftsRows) delFts.run(r.rowid)
        this.db.prepare('DELETE FROM native_reference_fts_map WHERE nativeKey=?').run(nativeKey)
      }
      if (had) this.bumpIndexEpoch()
    }).immediate()
  }

  purgeProvider(repositoryId: string, provider: 'codex' | 'antigravity'): number {
    if (this.readOnly || !this.available) return 0
    return this.db.transaction(() => {
      const keys = this.db.prepare(`
        SELECT nativeKey FROM native_reference_sources WHERE repositoryId=? AND provider=?
        UNION
        SELECT DISTINCT e.nativeKey FROM native_reference_events e
        JOIN native_reference_sources s ON s.nativeKey=e.nativeKey
        WHERE s.repositoryId=? AND s.provider=?
      `).all(repositoryId, provider, repositoryId, provider) as Array<{ nativeKey: string }>
      for (const { nativeKey } of keys) {
        this.db.prepare('DELETE FROM native_reference_sources WHERE nativeKey=?').run(nativeKey)
        this.db.prepare('DELETE FROM native_reference_checkpoints WHERE nativeKey=?').run(nativeKey)
        this.db.prepare('DELETE FROM native_reference_events WHERE nativeKey=?').run(nativeKey)
        this.db.prepare('DELETE FROM native_reference_turns WHERE nativeKey=?').run(nativeKey)
        if (this.ftsAvailable) {
          const ftsRows = this.db.prepare('SELECT rowid FROM native_reference_fts_map WHERE nativeKey=?').all(nativeKey) as Array<{ rowid: number }>
          if (ftsRows.length) {
            const delFts = this.db.prepare('DELETE FROM native_reference_fts WHERE rowid=?')
            for (const r of ftsRows) delFts.run(r.rowid)
            this.db.prepare('DELETE FROM native_reference_fts_map WHERE nativeKey=?').run(nativeKey)
          }
        }
      }
      if (keys.length) this.bumpIndexEpoch()
      return keys.length
    }).immediate()
  }

  purgeProviderFts(repositoryId: string, provider: 'codex' | 'antigravity'): number {
    if (this.readOnly || !this.available || !this.ftsAvailable) return 0
    return this.db.transaction(() => {
      const ftsRows = this.db.prepare(`
        SELECT m.rowid FROM native_reference_fts_map m
        JOIN native_reference_sources s ON s.nativeKey = m.nativeKey
        WHERE s.repositoryId=? AND s.provider=?
      `).all(repositoryId, provider) as Array<{ rowid: number }>
      if (ftsRows.length) {
        const delFts = this.db.prepare('DELETE FROM native_reference_fts WHERE rowid=?')
        const delMap = this.db.prepare('DELETE FROM native_reference_fts_map WHERE rowid=?')
        for (const r of ftsRows) {
          delFts.run(r.rowid)
          delMap.run(r.rowid)
        }
        this.bumpIndexEpoch()
      }
      return ftsRows.length
    }).immediate()
  }

  hasFtsEntriesForProvider(repositoryId: string, provider: 'codex' | 'antigravity'): boolean {
    if (!this.available || !this.ftsAvailable) return false
    return !!this.db.prepare(`
      SELECT 1 FROM native_reference_fts_map m
      JOIN native_reference_sources s ON s.nativeKey = m.nativeKey
      WHERE s.repositoryId=? AND s.provider=? LIMIT 1
    `).get(repositoryId, provider)
  }

  hasPendingCheckpoints(repositoryId: string, worktreeId?: string, generation?: string): boolean {
    if (!this.available) return false
    const cp = this.db.prepare('SELECT nativeKey FROM native_reference_checkpoints LIMIT 10').all() as Array<{ nativeKey: string }>
    if (!cp.length) return false
    if (!worktreeId && !generation) return true
    return cp.some(c => {
      const src = this.getSummary(c.nativeKey)
      return !src || (src.repositoryId === repositoryId && src.worktreeId === worktreeId && src.generation === generation)
    })
  }

  listReadySources(
    repositoryId: string,
    filter: { worktreeId?: string; generation?: string; providers?: Array<'codex' | 'antigravity'>; sourceSessionId?: string } = {},
    offset = 0,
    limit = 500
  ): Array<{ nativeKey: string; provider: 'codex' | 'antigravity'; worktreeId: string; generation: string; sourceSessionId: string; locatorHash: string; normalizer: string; revision: number; fileIdentity: string; sourceBytes: number }> {
    if (!this.available) return []
    const clauses = ['repositoryId=?']
    const params: unknown[] = [repositoryId]
    if (filter.worktreeId && filter.generation) {
      clauses.push('worktreeId=? AND generation=?')
      params.push(filter.worktreeId, filter.generation)
    }
    if (filter.providers?.length) {
      clauses.push(`provider IN (${filter.providers.map(() => '?').join(',')})`)
      params.push(...filter.providers)
    }
    if (filter.sourceSessionId) {
      clauses.push('sourceSessionId=?')
      params.push(filter.sourceSessionId)
    }
    return this.db.prepare(`
      SELECT nativeKey, provider, worktreeId, generation, sourceSessionId, locatorHash, normalizer, revision, fileIdentity, sourceBytes
      FROM native_reference_sources
      WHERE ${clauses.join(' AND ')}
      ORDER BY nativeKey ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<{ nativeKey: string; provider: 'codex' | 'antigravity'; worktreeId: string; generation: string; sourceSessionId: string; locatorHash: string; normalizer: string; revision: number; fileIdentity: string; sourceBytes: number }>
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
    if (filters.eventId) {
      clauses.push('eventId=?')
      params.push(filters.eventId)
    }
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
    if (filters.status) {
      clauses.push('status=?')
      params.push(filters.status)
    }
    if (filters.errorKind) {
      clauses.push('errorKind=?')
      params.push(filters.errorKind)
    }
    if (filters.isError === true) {
      clauses.push("(type='ERROR' OR status IN ('FAILURE', 'REFUSAL'))")
    } else if (filters.isError === false) {
      clauses.push("(type<>'ERROR' AND status='SUCCESS')")
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

  private formatFtsQuery(query: string, mode: 'ALL_TERMS' | 'PHRASE'): string | undefined {
    const trimmed = query.trim()
    if (!trimmed) return undefined
    if (mode === 'PHRASE') return `"${trimmed.replace(/"/g, '""')}"`
    const tokens = trimmed.split(/\s+/).filter(Boolean).map(t => `"${t.replace(/"/g, '""')}"`)
    return tokens.length ? tokens.join(' AND ') : undefined
  }

  pageTools(nativeKey: string, revision: number, offset: number, limit: number): { tools: Array<{ tool: string; count: number }>; more: boolean } {
    if (!this.available) return { tools: [], more: false }
    const rows = this.db.prepare(`
      SELECT tool, COUNT(*) AS count
      FROM native_reference_events
      WHERE nativeKey=? AND revision=? AND tool IS NOT NULL
      GROUP BY tool
      ORDER BY count DESC, tool ASC
      LIMIT ? OFFSET ?
    `).all(nativeKey, revision, limit + 1, offset) as Array<{ tool: string; count: number }>
    return { tools: rows.slice(0, limit), more: rows.length > limit }
  }

  pageErrors(nativeKey: string, revision: number, offset: number, limit: number): { errors: NativeIndexedEventRow[]; more: boolean } {
    if (!this.available) return { errors: [], more: false }
    const rows = this.pageEvents(nativeKey, revision, { isError: true }, offset, limit + 1)
    return { errors: rows.slice(0, limit), more: rows.length > limit }
  }

  searchCrossSessionEvents(filter: NativeCrossSessionFilter): { hits: NativeCrossSessionHit[]; more: boolean } {
    if (!this.available) return { hits: [], more: false }
    if (filter.nativeKeys !== undefined && filter.nativeKeys.length === 0) return { hits: [], more: false }
    if (filter.providers !== undefined && filter.providers.length === 0) return { hits: [], more: false }
    let ftsJoin = ''
    const clauses = ['s.repositoryId=?']
    const params: unknown[] = [filter.repositoryId]
    if (filter.query !== undefined) {
      if (!this.ftsAvailable) return { hits: [], more: false }
      const formatted = this.formatFtsQuery(filter.query, filter.mode ?? 'ALL_TERMS')
      if (!formatted) return { hits: [], more: false }
      ftsJoin = 'JOIN native_reference_fts_map m ON m.nativeKey = e.nativeKey AND m.revision = e.revision AND m.eventId = e.eventId'
      clauses.push('m.rowid IN (SELECT rowid FROM native_reference_fts WHERE native_reference_fts MATCH ?)')
      params.push(formatted)
    }
    if (filter.worktreeId && filter.generation) {
      clauses.push('s.worktreeId=? AND s.generation=?')
      params.push(filter.worktreeId, filter.generation)
    }
    if (filter.nativeKeys?.length) {
      clauses.push(`s.nativeKey IN (${filter.nativeKeys.map(() => '?').join(',')})`)
      params.push(...filter.nativeKeys)
    }
    if (filter.provider) {
      clauses.push('s.provider=?')
      params.push(filter.provider)
    }
    if (filter.providers?.length) {
      clauses.push(`s.provider IN (${filter.providers.map(() => '?').join(',')})`)
      params.push(...filter.providers)
    }
    if (filter.sourceSessionId) {
      clauses.push('s.sourceSessionId=?')
      params.push(filter.sourceSessionId)
    }
    if (filter.types?.length) {
      clauses.push(`e.type IN (${filter.types.map(() => '?').join(',')})`)
      params.push(...filter.types)
    }
    if (filter.tool) {
      clauses.push('e.tool=?')
      params.push(filter.tool)
    }
    if (filter.status) {
      clauses.push('e.status=?')
      params.push(filter.status)
    }
    if (filter.errorKind) {
      clauses.push('e.errorKind=?')
      params.push(filter.errorKind)
    }
    if (filter.isError === true) {
      clauses.push("(e.type='ERROR' OR e.status IN ('FAILURE', 'REFUSAL'))")
    } else if (filter.isError === false) {
      clauses.push("(e.type<>'ERROR' AND e.status='SUCCESS')")
    }
    if (filter.turnId) {
      clauses.push('e.turnId=?')
      params.push(filter.turnId)
    }
    if (filter.after) {
      const ms = Date.parse(filter.after)
      if (!Number.isFinite(ms)) throw new Error('INVALID_ARGUMENT')
      clauses.push('e.timestampMs IS NOT NULL AND e.timestampMs>=?')
      params.push(ms)
    }
    if (filter.before) {
      const ms = Date.parse(filter.before)
      if (!Number.isFinite(ms)) throw new Error('INVALID_ARGUMENT')
      clauses.push('e.timestampMs IS NOT NULL AND e.timestampMs<=?')
      params.push(ms)
    }
    const where = clauses.join(' AND ')
    const sql = `
      SELECT s.nativeKey, s.revision, s.provider, s.repositoryId, s.worktreeId, s.generation, s.sourceSessionId, s.normalizer, s.fileIdentity,
             e.seq, e.ordinal, e.eventId, e.type, e.timestamp, e.timestampMs, e.tool, e.turnId, e.status, e.pairing, e.errorKind,
             e.bytes, e.lineStart, e.lineEnd, e.partIndex
      FROM native_reference_sources s
      JOIN native_reference_events e ON e.nativeKey = s.nativeKey AND e.revision = s.revision
      ${ftsJoin}
      WHERE ${where}
      ORDER BY CASE WHEN e.timestampMs IS NULL THEN 1 ELSE 0 END ASC, e.timestampMs ASC, s.sourceSessionId ASC, e.eventId ASC
      LIMIT ? OFFSET ?
    `
    let rows: Array<Record<string, unknown>>
    try {
      rows = this.db.prepare(sql).all(...params, filter.limit + 1, filter.offset) as Array<Record<string, unknown>>
    } catch (error) {
      if (filter.query !== undefined && error instanceof Error && /fts5/i.test(error.message)) {
        return { hits: [], more: false }
      }
      throw error
    }
    const more = rows.length > filter.limit
    const hits: NativeCrossSessionHit[] = rows.slice(0, filter.limit).map(r => ({
      nativeKey: String(r.nativeKey),
      revision: Number(r.revision),
      provider: r.provider as 'codex' | 'antigravity',
      repositoryId: String(r.repositoryId),
      worktreeId: String(r.worktreeId),
      generation: String(r.generation),
      sourceSessionId: String(r.sourceSessionId),
      normalizer: String(r.normalizer),
      fileIdentity: String(r.fileIdentity),
      seq: Number(r.seq),
      ordinal: Number(r.ordinal),
      eventId: String(r.eventId),
      type: r.type as NativeSourceEventType,
      ...(r.timestamp ? { timestamp: String(r.timestamp) } : {}),
      ...(r.timestampMs !== null && r.timestampMs !== undefined ? { timestampMs: Number(r.timestampMs) } : {}),
      ...(r.tool ? { tool: String(r.tool) } : {}),
      ...(r.turnId ? { turnId: String(r.turnId) } : {}),
      ...(r.status ? { status: String(r.status) } : {}),
      ...(r.pairing ? { pairing: String(r.pairing) } : {}),
      ...(r.errorKind ? { errorKind: String(r.errorKind) } : {}),
      bytes: Number(r.bytes),
      lineStart: Number(r.lineStart),
      lineEnd: Number(r.lineEnd),
      partIndex: Number(r.partIndex)
    }))
    return { hits, more }
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
