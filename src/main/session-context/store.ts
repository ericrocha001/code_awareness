import Database from 'better-sqlite3'
import { sourceTimestamp } from './source-time'
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { digest, safeFile, sanitize, utf8Prefix } from './privacy'
import { EVENT_TYPES, LIMITS, COVERAGE_REASON_CODES, type EventInput, type EventRow, type SessionInput, type SessionRow, type SourceObservation, type CoverageReasons } from './types'

export function sessionStorePath(base: string, repositoryId: string): string {
  if (!repositoryId || repositoryId.length > 200) throw new Error('REPOSITORY_REQUIRED')
  return join(base, 'repositories', Buffer.from(repositoryId).toString('base64url'), 'session-context.sqlite')
}

export class SessionStore {
  private readonly db: Database.Database
  private readonly key: string
  constructor(readonly path: string, readonly repositoryId: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new Database(path)
    try {
      if (process.platform !== 'win32') chmodSync(path, 0o600)
      this.db.pragma('auto_vacuum = INCREMENTAL')
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('foreign_keys = ON')
      this.db.pragma('busy_timeout = 3000')
      if (Number(this.db.pragma('user_version', { simple: true })) > 3) throw new Error('SCHEMA_UNSUPPORTED')
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS identity(repositoryId TEXT PRIMARY KEY, cursorKey TEXT NOT NULL, revision INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS sessions(
            id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'entire', providerSessionId TEXT NOT NULL,
            providerVersion TEXT NOT NULL, agent TEXT NOT NULL, startedAt TEXT, endedAt TEXT,
            lastObserved TEXT NOT NULL, state TEXT NOT NULL, coverage TEXT NOT NULL,
            revision INTEGER NOT NULL, eventCount INTEGER NOT NULL, payloadBytes INTEGER NOT NULL,
            sourceDigest TEXT NOT NULL, sourceBytes INTEGER NOT NULL,
            worktreeId TEXT, generation TEXT, executionId TEXT, commitSha TEXT,
            UNIQUE(provider, providerSessionId));
          CREATE TABLE IF NOT EXISTS events(
            id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL, type TEXT NOT NULL, timestamp TEXT, tool TEXT, success INTEGER,
            summary TEXT NOT NULL, files TEXT NOT NULL, sourcePosition INTEGER NOT NULL,
            digest TEXT NOT NULL, bytes INTEGER NOT NULL, omission TEXT, sanitized INTEGER NOT NULL,
            UNIQUE(sessionId, ordinal));
          CREATE TABLE IF NOT EXISTS event_payloads(
            eventId TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE, text TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS session_chronology ON sessions(lastObserved, id);
          CREATE INDEX IF NOT EXISTS session_execution ON sessions(executionId, lastObserved, id);
          CREATE INDEX IF NOT EXISTS session_state ON sessions(state, endedAt, id);
          CREATE INDEX IF NOT EXISTS event_type ON events(sessionId, type, ordinal);
          CREATE INDEX IF NOT EXISTS event_tool ON events(sessionId, tool, ordinal);
          CREATE INDEX IF NOT EXISTS event_time ON events(sessionId, timestamp, ordinal);
        `)
        const identities = this.db.prepare('SELECT repositoryId FROM identity').all() as { repositoryId: string }[]
        if (identities.length && (identities.length !== 1 || identities[0].repositoryId !== repositoryId)) throw new Error('REPOSITORY_MISMATCH')
        this.db.prepare('INSERT OR IGNORE INTO identity VALUES (?, ?, 1)').run(repositoryId, randomBytes(32).toString('hex'))
        const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
        if (!columns.some(column => column.name === 'sourceObservation')) this.db.exec("ALTER TABLE sessions ADD COLUMN sourceObservation TEXT NOT NULL DEFAULT '{}'")
        if (!columns.some(column => column.name === 'importState')) this.db.exec("ALTER TABLE sessions ADD COLUMN importState TEXT NOT NULL DEFAULT 'UNKNOWN'")
        if (!columns.some(column => column.name === 'coverageReasons')) this.db.exec("ALTER TABLE sessions ADD COLUMN coverageReasons TEXT NOT NULL DEFAULT '{}'")
        this.db.prepare("UPDATE sessions SET coverageReasons = ? WHERE importState = 'UNKNOWN' AND coverageReasons = '{}' AND coverage <> 'COMPLETE'").run(JSON.stringify({ LEGACY_COVERAGE_UNEXPLAINED: 1 }))
        this.db.pragma('user_version = 3')
      }).immediate()
      this.key = (this.db.prepare('SELECT cursorKey FROM identity').get() as { cursorKey: string }).cursorKey
    } catch (error) { this.db.close(); throw error }
  }
  assertRepository(id: string): void { if (id !== this.repositoryId) throw new Error('REPOSITORY_MISMATCH') }
  close(): void { this.db.close() }
  catalogRevision(): number { return (this.db.prepare('SELECT revision FROM identity').get() as { revision: number }).revision }
  session(id: string): SessionRow {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
    if (!row) throw new Error('SESSION_UNAVAILABLE')
    return row
  }
  byProvider(id: string): SessionRow | undefined { return this.db.prepare('SELECT * FROM sessions WHERE providerSessionId = ?').get(id) as SessionRow | undefined }
  revision(id: string, expected?: number): SessionRow {
    const session = this.session(id)
    if (expected !== undefined && expected !== session.revision) throw new Error('REVISION_CONFLICT')
    return session
  }
  cursor(scope: unknown, offset: number): string {
    const body = Buffer.from(JSON.stringify({ scope: digest(JSON.stringify(scope)), offset })).toString('base64url')
    return body + '.' + createHmac('sha256', this.key).update(body).digest('base64url')
  }
  offset(cursor: string | undefined, scope: unknown): number {
    if (!cursor) return 0
    if (cursor.length > 512) throw new Error('CURSOR_STALE')
    const [body, signature, extra] = cursor.split('.')
    const expected = createHmac('sha256', this.key).update(body ?? '').digest('base64url')
    if (extra || !signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('CURSOR_STALE')
    try {
      const data = JSON.parse(Buffer.from(body, 'base64url').toString())
      if (data.scope !== digest(JSON.stringify(scope)) || !Number.isSafeInteger(data.offset) || data.offset < 0) throw new Error()
      return data.offset
    } catch { throw new Error('CURSOR_STALE') }
  }
  sourceObservation(row: SessionRow): SourceObservation {
    return row.sourceObservation === '{}' ? { identity: 'UNKNOWN', streamTime: { timestampedRecords: 0, missingTimestamps: 0, invalidTimestamps: 0, windowRelation: 'UNAVAILABLE' } } : JSON.parse(row.sourceObservation)
  }
  ingest(input: SessionInput, events: EventInput[], assertCurrent: () => void = () => {}): { sessionId: string; revision: number; eventCount: number; coverage: string; replay: boolean; sourceObservation: SourceObservation; importState: SessionRow['importState']; coverageReasons: CoverageReasons } {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.providerSessionId) || input.agent !== 'codex' || events.length > LIMITS.events) throw new Error('INVALID_IMPORT')
    if (!['ACTIVE', 'ENDED', 'UNKNOWN', 'PARTIAL'].includes(input.state) || (input.state === 'ENDED' && (!input.endedAt || !Number.isFinite(Date.parse(input.endedAt))))) throw new Error('INVALID_IMPORT')
    const importState = input.importState ?? 'UNKNOWN'
    if (importState === 'METADATA_ONLY' && events.length) throw new Error('INVALID_IMPORT')
    if (!['UNKNOWN', 'METADATA_ONLY', 'TRANSCRIPT_IMPORTED'].includes(importState)) throw new Error('INVALID_IMPORT')
    const suppliedReasons = input.coverageReasons ?? {}
    if (Object.entries(suppliedReasons).some(([code, count]) => !COVERAGE_REASON_CODES.includes(code as keyof CoverageReasons) || !Number.isSafeInteger(count) || count! <= 0 || count! > LIMITS.import)) throw new Error('INVALID_IMPORT')
    const diagnosticsFor = (id?: string): string => {
      const reasons: CoverageReasons = { ...suppliedReasons }
      delete reasons.PAYLOAD_LIMIT; delete reasons.PAYLOAD_UNAVAILABLE; delete reasons.PAYLOAD_REDACTED
      if (importState === 'METADATA_ONLY') reasons.TRANSCRIPT_NOT_IMPORTED = 1
      if (id) {
        const omissions = this.db.prepare('SELECT omission, COUNT(*) AS count FROM events WHERE sessionId = ? AND omission IS NOT NULL GROUP BY omission').all(id) as { omission: string; count: number }[]
        for (const row of omissions) {
          if (row.omission === 'LIMIT_REACHED') reasons.PAYLOAD_LIMIT = row.count
          else if (row.omission === 'UNAVAILABLE') reasons.PAYLOAD_UNAVAILABLE = row.count
          else if (row.omission === 'REDACTED') reasons.PAYLOAD_REDACTED = row.count
        }
      }
      if (input.coverage !== 'COMPLETE' && !Object.keys(reasons).length) reasons.SOURCE_COVERAGE_INCOMPLETE = 1
      return JSON.stringify(Object.fromEntries(COVERAGE_REASON_CODES.filter(code => reasons[code]).map(code => [code, reasons[code]])))
    }
    const observation = input.sourceObservation
    if (observation && (!['VERIFIED', 'UNKNOWN'].includes(observation.identity) || !['WITHIN_PROVIDER_WINDOW', 'OUTSIDE_PROVIDER_WINDOW', 'UNAVAILABLE'].includes(observation.streamTime.windowRelation) ||
      [observation.streamTime.timestampedRecords, observation.streamTime.missingTimestamps, observation.streamTime.invalidTimestamps].some(n => !Number.isSafeInteger(n) || n < 0 || n > LIMITS.import) ||
      [observation.streamTime.first, observation.streamTime.last].some(value => value !== undefined && (typeof value !== 'string' || !sourceTimestamp(value))))) throw new Error('INVALID_IMPORT')
    const sourceObservation = observation ? JSON.stringify({ identity: observation.identity, streamTime: { first: observation.streamTime.first, last: observation.streamTime.last,
      timestampedRecords: observation.streamTime.timestampedRecords, missingTimestamps: observation.streamTime.missingTimestamps, invalidTimestamps: observation.streamTime.invalidTimestamps, windowRelation: observation.streamTime.windowRelation } }) : '{}'
    return this.db.transaction(() => {
      assertCurrent()
      const old = this.byProvider(input.providerSessionId)
      if (old && importState === 'METADATA_ONLY') {
        this.db.prepare('UPDATE sessions SET lastObserved = ? WHERE id = ?').run(new Date().toISOString(), old.id)
        this.db.prepare('UPDATE identity SET revision = revision + 1').run()
        assertCurrent()
        return { sessionId: old.id, revision: old.revision, eventCount: old.eventCount, coverage: old.coverage, replay: true,
          sourceObservation: this.sourceObservation(old), importState: old.importState, coverageReasons: JSON.parse(old.coverageReasons) }
      }
      const coverageReasons = diagnosticsFor(old?.id)
      if (old?.sourceDigest === input.sourceDigest && old.importState === importState && old.coverageReasons === coverageReasons && old.sourceObservation === sourceObservation && old.startedAt === (input.startedAt ?? null) && old.coverage === (coverageReasons === '{}' ? 'COMPLETE' : 'PARTIAL') && old.state === input.state && old.endedAt === (input.endedAt ?? null)) {
        this.db.prepare('UPDATE sessions SET lastObserved = ? WHERE id = ?').run(new Date().toISOString(), old.id)
        this.db.prepare('UPDATE identity SET revision = revision + 1').run()
        assertCurrent()
        return { sessionId: old.id, revision: old.revision, eventCount: old.eventCount, coverage: old.coverage, replay: true, sourceObservation: this.sourceObservation(old), importState: old.importState, coverageReasons: JSON.parse(old.coverageReasons) }
      }
      if (!old && this.count() >= LIMITS.sessions) {
        const victim = this.db.prepare("SELECT id FROM sessions WHERE state = 'ENDED' AND endedAt IS NOT NULL ORDER BY julianday(endedAt), id LIMIT 1").get() as { id: string } | undefined
        if (!victim) throw new Error('CAPACITY_REACHED')
        this.db.prepare('DELETE FROM sessions WHERE id = ?').run(victim.id)
      }
      const id = old?.id ?? randomUUID(), revision = (old?.revision ?? 0) + 1
      const normalized = events.map((event, index) => {
        if (!EVENT_TYPES.includes(event.type) || !Number.isSafeInteger(event.sourcePosition) || event.sourcePosition < 0 || (event.omission !== undefined && !['LIMIT_REACHED', 'REDACTED', 'UNAVAILABLE'].includes(event.omission))) throw new Error('INVALID_EVENT')
        const text = sanitize(event.text ?? '')
        return { event, text, hash: digest(JSON.stringify({ ...event, text })), ordinal: index + 1 }
      })
      let prefix = 0
      if (old) {
        const hashes = this.db.prepare('SELECT digest FROM events WHERE sessionId = ? ORDER BY ordinal').all(id) as { digest: string }[]
        while (prefix < Math.min(hashes.length, normalized.length) && hashes[prefix].digest === normalized[prefix].hash) prefix++
        if (input.coverage !== 'COMPLETE' && prefix < hashes.length) throw new Error('SOURCE_PARTIAL_CONFLICT')
        this.db.prepare('DELETE FROM events WHERE sessionId = ? AND ordinal > ?').run(id, prefix)
      }
      const kept = this.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM events WHERE sessionId = ?').get(id) as { bytes: number }
      let sessionBytes = kept.bytes
      let repositoryBytes = (this.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM events').get() as { bytes: number }).bytes
      this.db.prepare(`INSERT INTO sessions(id, providerSessionId, providerVersion, agent, startedAt, endedAt, lastObserved, state, coverage, revision, eventCount, payloadBytes, sourceDigest, sourceBytes, sourceObservation, importState, coverageReasons)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET providerVersion=excluded.providerVersion, startedAt=excluded.startedAt, endedAt=excluded.endedAt, sourceObservation=excluded.sourceObservation, importState=excluded.importState, coverageReasons=excluded.coverageReasons,
        lastObserved=excluded.lastObserved, state=excluded.state, revision=excluded.revision, sourceDigest=excluded.sourceDigest, sourceBytes=excluded.sourceBytes`).run(
          id, input.providerSessionId, utf8Prefix(sanitize(input.providerVersion), 80), input.agent, input.startedAt ?? null, input.endedAt ?? null,
          new Date().toISOString(), input.state, input.coverage, revision, input.sourceDigest, input.sourceBytes, sourceObservation, importState, coverageReasons)
      const insertEvent = this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      const insertPayload = this.db.prepare('INSERT INTO event_payloads VALUES (?, ?)')
      for (const { event, text, hash, ordinal } of normalized.slice(prefix)) {
        const allowed = Math.min(LIMITS.event, LIMITS.session - sessionBytes, LIMITS.repository - repositoryBytes)
        const payload = utf8Prefix(text, Math.max(0, allowed)), bytes = Buffer.byteLength(payload)
        const omission = event.omission ?? (event.text === undefined ? 'UNAVAILABLE' : payload !== text ? 'LIMIT_REACHED' : null)
        const eventId = randomUUID()
        const files = [...new Set((event.files ?? []).map(safeFile).filter((file): file is string => !!file))].slice(0, 10)
        insertEvent.run(eventId, id, ordinal, event.type, event.timestamp ?? null, event.tool ? utf8Prefix(sanitize(event.tool), 80) : null,
          event.success === undefined ? null : Number(event.success), utf8Prefix(payload.replace(/\s+/g, ' '), 160), JSON.stringify(files), event.sourcePosition,
          hash, bytes, omission, Number(text !== (event.text ?? '')))
        if (bytes) insertPayload.run(eventId, payload)
        sessionBytes += bytes; repositoryBytes += bytes
      }
      const totals = this.db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM events WHERE sessionId = ?').get(id) as { count: number; bytes: number }
      const finalReasons = diagnosticsFor(id)
      const coverage = finalReasons === '{}' ? 'COMPLETE' : 'PARTIAL'
      this.db.prepare('UPDATE sessions SET eventCount=?, payloadBytes=?, coverage=?, coverageReasons=? WHERE id=?').run(totals.count, totals.bytes, coverage, finalReasons, id)
      this.db.prepare('UPDATE identity SET revision = revision + 1').run()
      assertCurrent()
      return { sessionId: id, revision, eventCount: totals.count, coverage, replay: false, sourceObservation: this.sourceObservation(this.session(id)), importState, coverageReasons: JSON.parse(finalReasons) }
    }).immediate()
  }
  count(): number { return (this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n }
  sessions(filter: { state?: string; agent?: string; after?: string; before?: string; executionId?: string }, offset: number, limit: number): SessionRow[] {
    if (filter.executionId) return []
    const where: string[] = [], params: (string | number)[] = []
    for (const [key, column, op] of [['state', 'state', '='], ['agent', 'agent', '='], ['after', 'lastObserved', '>='], ['before', 'lastObserved', '<=']] as const) {
      if (filter[key]) { where.push(key === 'after' || key === 'before' ? `julianday(${column}) ${op} julianday(?)` : `${column} ${op} ?`); params.push(filter[key]!) }
    }
    return this.db.prepare(`SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY lastObserved DESC, id LIMIT ? OFFSET ?`).all(...params, limit, offset) as SessionRow[]
  }
  events(sessionId: string, filter: { types?: string[]; tool?: string; from?: number; to?: number; after?: string; before?: string }, offset: number, limit: number): EventRow[] {
    const where = ['sessionId = ?'], params: (string | number)[] = [sessionId]
    if (filter.types?.length) { where.push(`type IN (${filter.types.map(() => '?').join(',')})`); params.push(...filter.types) }
    for (const [key, column, op] of [['tool', 'tool', '='], ['from', 'ordinal', '>='], ['to', 'ordinal', '<='], ['after', 'timestamp', '>='], ['before', 'timestamp', '<=']] as const) {
      const value = filter[key]
      if (value !== undefined) { where.push(key === 'after' || key === 'before' ? `julianday(${column}) ${op} julianday(?)` : `${column} ${op} ?`); params.push(value) }
    }
    return this.db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY ordinal LIMIT ? OFFSET ?`).all(...params, limit, offset) as EventRow[]
  }
  event(sessionId: string, id: string): EventRow & { text: string | null } {
    const row = this.db.prepare('SELECT e.*, p.text FROM events e LEFT JOIN event_payloads p ON p.eventId=e.id WHERE e.sessionId=? AND e.id=?').get(sessionId, id) as (EventRow & { text: string | null }) | undefined
    if (!row) throw new Error('EVENT_UNAVAILABLE')
    return row
  }
  map(id: string, offset: number, limit: number) {
    const types = this.db.prepare('SELECT type, COUNT(*) AS count FROM events WHERE sessionId=? GROUP BY type').all(id)
    const tools = this.db.prepare('SELECT tool, COUNT(*) AS count FROM events WHERE sessionId=? AND tool IS NOT NULL GROUP BY tool ORDER BY count DESC, tool LIMIT 10').all(id)
    const files = this.db.prepare('SELECT value AS file, COUNT(*) AS count FROM events, json_each(events.files) WHERE sessionId=? GROUP BY value ORDER BY count DESC, value LIMIT 10').all(id)
    const segments = this.db.prepare(`SELECT CAST((ordinal-1)/100 AS INTEGER) AS segment, MIN(ordinal) AS first, MAX(ordinal) AS last,
      COUNT(*) AS count, MIN(timestamp) AS firstObserved, MAX(timestamp) AS lastObserved FROM events WHERE sessionId=? GROUP BY segment ORDER BY segment LIMIT ? OFFSET ?`).all(id, limit, offset) as { segment: number; first: number; last: number; count: number; firstObserved: string | null; lastObserved: string | null }[]
    return { types, tools, files, segments: segments.map(segment => ({ ...segment, id: `S${segment.segment + 1}`, label: `Eventos ${segment.first}–${segment.last}`, types: this.db.prepare('SELECT type, COUNT(*) AS count FROM events WHERE sessionId=? AND ordinal BETWEEN ? AND ? GROUP BY type').all(id, segment.first, segment.last) })) }
  }
  diagnostics() {
    const size = (path: string) => { try { return statSync(path).size } catch { return 0 } }
    return { sessions: this.count(), payloadBytes: (this.db.prepare('SELECT COALESCE(SUM(payloadBytes), 0) AS n FROM sessions').get() as { n: number }).n,
      databaseBytes: size(this.path), walBytes: size(this.path + '-wal'), limits: LIMITS }
  }
  maintain(): void { this.db.pragma('wal_checkpoint(PASSIVE)'); this.db.pragma('incremental_vacuum(64)') }
}
