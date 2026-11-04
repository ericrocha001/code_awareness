import Database from 'better-sqlite3'
import { sourceTimestamp } from './source-time'
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { digest, sanitize, utf8Prefix } from './privacy'
import { COVERAGE_REASON_CODES, type EventInput, type EventRow, type SessionInput, type SessionRow, type SourceObservation, type CoverageReasons } from './types'
import type { SessionAssociation, SessionFilter, DeclaredSessionAssociation } from './associations'
import type { CaptureHealthObservation } from './capture-health-types'
import { CheckpointRegistry, REGISTRY_SCHEMA } from './checkpoint-registry'
import { entireAgent } from './entire-schema'
import { migrateSessionNamespace } from './session-namespace-migration'
import { SessionReferences } from './session-references'

export function sessionStorePath(base: string, repositoryId: string): string {
  if (!repositoryId || repositoryId.length > 200) throw new Error('REPOSITORY_REQUIRED')
  return join(base, 'repositories', Buffer.from(repositoryId).toString('base64url'), 'session-context.sqlite')
}
function associationQuery(filter: SessionFilter): { where: string[]; params: (string | number)[] } {
  const where: string[] = [], params: (string | number)[] = []
  for (const key of ['executionId', 'commitSha', 'pullRequest'] as const) {
    if (filter[key] !== undefined) { where.push(`json_extract(a.payload, '$.${key}')=?`); params.push(filter[key]!) }
  }
  if (filter.artifactId) { where.push("(json_extract(a.payload, '$.artifactId')=? OR json_extract(a.payload, '$.sourceArtifactId')=?)"); params.push(filter.artifactId, filter.artifactId) }
  return { where, params }
}

export class SessionStore {
  readonly registry: CheckpointRegistry
  readonly references: SessionReferences
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
      if (Number(this.db.pragma('user_version', { simple: true })) > 8) throw new Error('SCHEMA_UNSUPPORTED')
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
            UNIQUE(provider, agent, providerSessionId));
          CREATE TABLE IF NOT EXISTS events(
            id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL, type TEXT NOT NULL, timestamp TEXT, tool TEXT, success INTEGER,
            files TEXT NOT NULL, sourcePosition INTEGER NOT NULL,
            digest TEXT NOT NULL, bytes INTEGER NOT NULL, omission TEXT, sanitized INTEGER NOT NULL,
            UNIQUE(sessionId, ordinal));
          CREATE INDEX IF NOT EXISTS session_chronology ON sessions(lastObserved, id);
          CREATE INDEX IF NOT EXISTS session_execution ON sessions(executionId, lastObserved, id);
          CREATE INDEX IF NOT EXISTS session_state ON sessions(state, endedAt, id);
          CREATE INDEX IF NOT EXISTS event_type ON events(sessionId, type, ordinal);
          CREATE INDEX IF NOT EXISTS event_tool ON events(sessionId, tool, ordinal);
          CREATE INDEX IF NOT EXISTS event_time ON events(sessionId, timestamp, ordinal);
          CREATE TABLE IF NOT EXISTS session_associations(
            id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, providerSessionId TEXT NOT NULL, provider TEXT NOT NULL,
            observedAt TEXT NOT NULL, payload TEXT NOT NULL, integrity TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS association_session ON session_associations(sessionId);
          CREATE INDEX IF NOT EXISTS association_execution ON session_associations(json_extract(payload, '$.executionId'));
          CREATE INDEX IF NOT EXISTS association_artifact ON session_associations(json_extract(payload, '$.artifactId'));
          CREATE INDEX IF NOT EXISTS association_commit ON session_associations(json_extract(payload, '$.commitSha'));
          CREATE INDEX IF NOT EXISTS association_pr ON session_associations(json_extract(payload, '$.pullRequest'));
          CREATE TABLE IF NOT EXISTS capture_health(
            id TEXT PRIMARY KEY, worktreeId TEXT NOT NULL, generation TEXT NOT NULL, cycleId TEXT NOT NULL,
            observedAt TEXT NOT NULL, payload TEXT NOT NULL, integrity TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS capture_health_target ON capture_health(worktreeId, generation, cycleId, observedAt);
          CREATE TABLE IF NOT EXISTS capture_health_latest(target TEXT PRIMARY KEY, observationId TEXT NOT NULL REFERENCES capture_health(id));
        `)
        const identities = this.db.prepare('SELECT repositoryId FROM identity').all() as { repositoryId: string }[]
        if (identities.length && (identities.length !== 1 || identities[0].repositoryId !== repositoryId)) throw new Error('REPOSITORY_MISMATCH')
        this.db.prepare('INSERT OR IGNORE INTO identity VALUES (?, ?, 1)').run(repositoryId, randomBytes(32).toString('hex'))
        const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
        if (!columns.some(column => column.name === 'sourceObservation')) this.db.exec("ALTER TABLE sessions ADD COLUMN sourceObservation TEXT NOT NULL DEFAULT '{}'")
        if (!columns.some(column => column.name === 'importState')) this.db.exec("ALTER TABLE sessions ADD COLUMN importState TEXT NOT NULL DEFAULT 'UNKNOWN'")
        if (!columns.some(column => column.name === 'coverageReasons')) this.db.exec("ALTER TABLE sessions ADD COLUMN coverageReasons TEXT NOT NULL DEFAULT '{}'")
        this.db.prepare("UPDATE sessions SET coverageReasons = ? WHERE importState = 'UNKNOWN' AND coverageReasons = '{}' AND coverage <> 'COMPLETE'").run(JSON.stringify({ LEGACY_COVERAGE_UNEXPLAINED: 1 }))
        this.db.exec(REGISTRY_SCHEMA)
        for (const [table, required] of [['registry_edges', ['id', 'source', 'sourceRevision', 'fromId', 'toId', 'payload', 'integrity', 'observedAt', 'state']], ['checkpoint_registry', ['checkpointId', 'refRevision', 'state', 'digest', 'sessionIds', 'integrity', 'observedAt']]] as const) {
          const names = (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name)
          if (required.some(name => !names.includes(name))) throw new Error('SCHEMA_INVALID')
        }
        this.db.pragma('user_version = 8')
      }).immediate()
      this.key = (this.db.prepare('SELECT cursorKey FROM identity').get() as { cursorKey: string }).cursorKey
      this.registry = new CheckpointRegistry(this.db, repositoryId)
      this.references = new SessionReferences(this.db, this.key)
    } catch (error) { this.db.close(); throw error }
  }
  assertRepository(id: string): void { if (id !== this.repositoryId) throw new Error('REPOSITORY_MISMATCH') }
  migrateAgentNamespace(assertCurrent: () => void): void { assertCurrent(); migrateSessionNamespace(this.db, assertCurrent); assertCurrent() }
  close(): void { this.db.close() }
  catalogRevision(): number { return (this.db.prepare('SELECT revision FROM identity').get() as { revision: number }).revision }
  session(id: string): SessionRow {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
    if (!row) {
      if (this.db.prepare('SELECT 1 FROM session_associations WHERE sessionId=? LIMIT 1').get(id) || this.registry.evictedSession(id)) throw new Error('SESSION_EVICTED')
      throw new Error('SESSION_UNAVAILABLE')
    }
    return row
  }
  byProvider(id: string, provider = 'entire', agent = 'codex'): SessionRow | undefined { return this.db.prepare('SELECT * FROM sessions WHERE providerSessionId = ? AND provider = ? AND agent = ?').get(id, provider, agent) as SessionRow | undefined }
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
    if (events.length) throw new Error('SOURCE_REFERENCE_REQUIRED')
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.providerSessionId) || entireAgent(input.agent) !== input.agent) throw new Error('INVALID_IMPORT')
    if (!['ACTIVE', 'ENDED', 'UNKNOWN', 'PARTIAL'].includes(input.state) || (input.state === 'ENDED' && (!input.endedAt || !Number.isFinite(Date.parse(input.endedAt))))) throw new Error('INVALID_IMPORT')
    const importState = input.importState ?? 'UNKNOWN'
    if (!['UNKNOWN', 'METADATA_ONLY'].includes(importState)) throw new Error('INVALID_IMPORT')
    const suppliedReasons = input.coverageReasons ?? {}
    if (Object.entries(suppliedReasons).some(([code, count]) => !COVERAGE_REASON_CODES.includes(code as keyof CoverageReasons) || !Number.isSafeInteger(count) || count! <= 0)) throw new Error('INVALID_IMPORT')
    const diagnosticsFor = (id?: string): string => {
      const reasons: CoverageReasons = { ...suppliedReasons }
      delete reasons.PAYLOAD_LIMIT; delete reasons.PAYLOAD_UNAVAILABLE; delete reasons.PAYLOAD_REDACTED
      reasons.TRANSCRIPT_NOT_IMPORTED = 1
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
      [observation.streamTime.timestampedRecords, observation.streamTime.missingTimestamps, observation.streamTime.invalidTimestamps].some(n => !Number.isSafeInteger(n) || n < 0) ||
      [observation.streamTime.first, observation.streamTime.last].some(value => value !== undefined && (typeof value !== 'string' || !sourceTimestamp(value))))) throw new Error('INVALID_IMPORT')
    const sourceObservation = observation ? JSON.stringify({ identity: observation.identity, streamTime: { first: observation.streamTime.first, last: observation.streamTime.last,
      timestampedRecords: observation.streamTime.timestampedRecords, missingTimestamps: observation.streamTime.missingTimestamps, invalidTimestamps: observation.streamTime.invalidTimestamps, windowRelation: observation.streamTime.windowRelation } }) : '{}'
    return this.db.transaction(() => {
      assertCurrent()
      const provider = input.provider ?? 'entire'
      if (!['entire', 'codex'].includes(provider)) throw new Error('INVALID_IMPORT')
      const old = this.byProvider(input.providerSessionId, provider, input.agent)
      if (old && importState !== 'METADATA_ONLY' && this.references.legacyPayloads(old.id)) throw new Error('LEGACY_MIGRATION_REQUIRED')
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
      const id = old?.id ?? randomUUID(), revision = (old?.revision ?? 0) + 1
      if (old?.eventCount) throw new Error('SOURCE_REFERENCE_REQUIRED')
      this.db.prepare(`INSERT INTO sessions(id, provider, providerSessionId, providerVersion, agent, startedAt, endedAt, lastObserved, state, coverage, revision, eventCount, payloadBytes, sourceDigest, sourceBytes, sourceObservation, importState, coverageReasons)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET providerVersion=excluded.providerVersion, startedAt=excluded.startedAt, endedAt=excluded.endedAt, sourceObservation=excluded.sourceObservation, importState=excluded.importState, coverageReasons=excluded.coverageReasons,
        lastObserved=excluded.lastObserved, state=excluded.state, revision=excluded.revision, sourceDigest=excluded.sourceDigest, sourceBytes=excluded.sourceBytes`).run(
          id, provider, input.providerSessionId, utf8Prefix(sanitize(input.providerVersion), 80), input.agent, input.startedAt ?? null, input.endedAt ?? null,
          new Date().toISOString(), input.state, input.coverage, revision, input.sourceDigest, input.sourceBytes, sourceObservation, importState, coverageReasons)
      const totals = this.db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM events WHERE sessionId = ?').get(id) as { count: number; bytes: number }
      const finalReasons = diagnosticsFor(id)
      const coverage = finalReasons === '{}' ? 'COMPLETE' : 'PARTIAL'
      this.db.prepare('UPDATE sessions SET eventCount=?, payloadBytes=?, coverage=?, coverageReasons=? WHERE id=?').run(totals.count, totals.bytes, coverage, finalReasons, id)
      this.registry.importedSession(provider, input.providerSessionId, id, input.agent === 'codex' ? undefined : input.agent)
      this.db.prepare('UPDATE identity SET revision = revision + 1').run()
      assertCurrent()
      return { sessionId: id, revision, eventCount: totals.count, coverage, replay: false, sourceObservation: this.sourceObservation(this.session(id)), importState, coverageReasons: JSON.parse(finalReasons) }
    }).immediate()
  }
  count(): number { return (this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n }
  captureHealth(target: { worktreeId: string; generation: string }, cycleId: string): CaptureHealthObservation | undefined {
    const key = digest(JSON.stringify([this.repositoryId, target.worktreeId, target.generation, cycleId]))
    const row = this.db.prepare('SELECT payload, integrity FROM capture_health h JOIN capture_health_latest l ON h.id=l.observationId WHERE l.target=?').get(key) as { payload: string; integrity: string } | undefined
    if (!row) return undefined
    if (digest(row.payload) !== row.integrity) throw new Error('CAPTURE_HEALTH_INTEGRITY_ERROR')
    const value = JSON.parse(row.payload) as CaptureHealthObservation
    this.assertRepository(value.repositoryId)
    return value
  }
  recordCaptureHealth(value: CaptureHealthObservation, assertCurrent: () => void): CaptureHealthObservation {
    this.assertRepository(value.repositoryId)
    const { observedAt: _at, ...identity } = value
    const id = digest(JSON.stringify(identity)), payload = JSON.stringify(value)
    return this.db.transaction(() => {
      assertCurrent()
      const old = this.db.prepare('SELECT payload, integrity FROM capture_health WHERE id=?').get(id) as { payload: string; integrity: string } | undefined
      if (old) {
        if (digest(old.payload) !== old.integrity) throw new Error('CAPTURE_HEALTH_INTEGRITY_ERROR')
        this.db.prepare('INSERT OR REPLACE INTO capture_health_latest VALUES (?, ?)').run(digest(JSON.stringify([this.repositoryId, value.worktreeId, value.generation, value.cycleId])), id)
        assertCurrent()
        return JSON.parse(old.payload) as CaptureHealthObservation
      }
      this.db.prepare('INSERT INTO capture_health VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, value.worktreeId, value.generation, value.cycleId, value.observedAt, payload, digest(payload))
      this.db.prepare('INSERT OR REPLACE INTO capture_health_latest VALUES (?, ?)').run(digest(JSON.stringify([this.repositoryId, value.worktreeId, value.generation, value.cycleId])), id)
      assertCurrent()
      return value
    }).immediate()
  }
  sessions(filter: SessionFilter, offset: number, limit: number, accountHash?: string | null): SessionRow[] {
    if (filter.executionId || filter.artifactId || filter.commitSha || filter.pullRequest) return this.historicalSessions(filter, offset, limit, accountHash)
    const where: string[] = [], params: (string | number)[] = []
    if (accountHash === undefined) where.push("(provider<>'codex' OR (importState='METADATA_ONLY' AND eventCount=0 AND payloadBytes=0 AND EXISTS (SELECT 1 FROM session_associations access WHERE access.sessionId=sessions.id AND json_extract(access.payload,'$.origin')='CODEX_APP_SERVER' AND json_extract(access.payload,'$.archived')=1)))")
    if (accountHash !== undefined) { where.push("(provider<>'codex' OR EXISTS (SELECT 1 FROM session_associations access WHERE access.sessionId=sessions.id AND json_extract(access.payload,'$.providerAccountHash')=?))"); params.push(accountHash ?? '') }
    for (const [key, column, op] of [['state', 'state', '='], ['agent', 'agent', '='], ['after', 'lastObserved', '>='], ['before', 'lastObserved', '<=']] as const) {
      if (filter[key]) { where.push(key === 'after' || key === 'before' ? `julianday(${column}) ${op} julianday(?)` : `${column} ${op} ?`); params.push(filter[key]!) }
    }
    return this.db.prepare(`SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY lastObserved DESC, id LIMIT ? OFFSET ?`).all(...params, limit, offset) as SessionRow[]
  }
  recordAssociation(input: SessionAssociation, expectedCatalogRevision: number, assertCurrent: () => void = () => {}): { associationId: string; revision: number; replay: boolean } {
    this.assertRepository(input.repositoryId)
    const row = this.session(input.sessionId)
    if (row.providerSessionId !== input.providerSessionId || (row.provider ?? 'entire') !== input.provider || !/^[a-f0-9]{64}$/.test(input.worktreeId) || !/^[a-f0-9]{64}$/.test(input.generation)) throw new Error('ASSOCIATION_IDENTITY_CONFLICT')
    const normalized = { ...input, ...(input.proofIds ? { proofIds: [...new Set(input.proofIds)].sort() } : {}) }
    const payload = JSON.stringify(Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))))
    const integrity = digest(payload), associationId = digest(JSON.stringify([this.repositoryId, input.sessionId, integrity]))
    return this.db.transaction(() => {
      assertCurrent()
      const existing = this.db.prepare('SELECT payload, integrity FROM session_associations WHERE id=?').get(associationId) as { payload: string; integrity: string } | undefined
      if (existing) {
        if (existing.payload !== payload || existing.integrity !== integrity) throw new Error('ASSOCIATION_INTEGRITY_ERROR')
        return { associationId, revision: this.catalogRevision(), replay: true }
      }
      if (this.catalogRevision() !== expectedCatalogRevision) throw new Error('REVISION_CONFLICT')
      this.db.prepare('INSERT INTO session_associations VALUES (?, ?, ?, ?, ?, ?, ?)').run(associationId, row.id, row.providerSessionId, row.provider ?? 'entire', new Date().toISOString(), payload, integrity)
      this.db.prepare('UPDATE identity SET revision=revision+1').run()
      assertCurrent()
      return { associationId, revision: this.catalogRevision(), replay: false }
    }).immediate()
  }
  associations(sessionId: string, limit = 5, filter: SessionFilter = {}): SessionAssociation[] {
    const { where, params } = associationQuery(filter)
    const rows = this.db.prepare(`SELECT payload, integrity FROM session_associations a WHERE sessionId=? ${where.length ? 'AND ' + where.join(' AND ') : ''} ORDER BY observedAt DESC, id LIMIT ?`).all(sessionId, ...params, limit) as { payload: string; integrity: string }[]
    return rows.map(row => {
      if (digest(row.payload) !== row.integrity) throw new Error('ASSOCIATION_INTEGRITY_ERROR')
      const value = JSON.parse(row.payload) as SessionAssociation
      this.assertRepository(value.repositoryId)
      return value
    })
  }
  observeWorktree(sessionId: string, target: { worktreeId: string; generation: string }, assertCurrent: () => void = () => {}) {
    const row = this.session(sessionId)
    return this.recordAssociation({ repositoryId: this.repositoryId, sessionId, providerSessionId: row.providerSessionId, provider: row.provider ?? 'entire', ...target,
      evidence: 'WORKTREE_VERIFIED', origin: row.provider === 'codex' ? 'CODEX_APP_SERVER' : 'ENTIRE_PROVIDER' }, this.catalogRevision(), assertCurrent)
  }
  declareAssociation(sessionId: string, target: { worktreeId: string; generation: string }, input: DeclaredSessionAssociation, assertCurrent: () => void) {
    const row = this.db.prepare("SELECT payload, integrity FROM session_associations WHERE sessionId=? AND json_extract(payload, '$.evidence')='WORKTREE_VERIFIED' AND json_extract(payload, '$.worktreeId')=? AND json_extract(payload, '$.generation')=? LIMIT 1").get(sessionId, target.worktreeId, target.generation) as { payload: string; integrity: string } | undefined
    if (!row) throw new Error('ASSOCIATION_WORKTREE_MISMATCH')
    if (digest(row.payload) !== row.integrity) throw new Error('ASSOCIATION_INTEGRITY_ERROR')
    const anchor = JSON.parse(row.payload) as SessionAssociation
    this.assertRepository(anchor.repositoryId)
    const { expectedCatalogRevision, ...declared } = input
    return this.recordAssociation({ ...anchor, ...declared, evidence: 'HANDOFF_DECLARED', origin: 'CONTINUUM_HANDOFF' }, expectedCatalogRevision, assertCurrent)
  }
  private historicalSessions(filter: SessionFilter, offset: number, limit: number, accountHash?: string | null): SessionRow[] {
    const { where, params } = associationQuery(filter)
    if (accountHash === undefined) where.push("(a.provider<>'codex' OR (s.importState='METADATA_ONLY' AND s.eventCount=0 AND s.payloadBytes=0 AND EXISTS (SELECT 1 FROM session_associations access WHERE access.sessionId=a.sessionId AND json_extract(access.payload,'$.origin')='CODEX_APP_SERVER' AND json_extract(access.payload,'$.archived')=1)))")
    if (accountHash !== undefined) { where.push("(a.provider<>'codex' OR EXISTS (SELECT 1 FROM session_associations access WHERE access.sessionId=a.sessionId AND json_extract(access.payload,'$.providerAccountHash')=?))"); params.push(accountHash ?? '') }
    for (const key of ['state', 'agent'] as const) { if (filter[key]) { where.push(`s.${key}=?`); params.push(filter[key]!) } }
    for (const [key, op] of [['after', '>='], ['before', '<=']] as const) { if (filter[key]) { where.push(`julianday(COALESCE(s.lastObserved, a.observedAt)) ${op} julianday(?)`); params.push(filter[key]!) } }
    const rows = this.db.prepare(`SELECT a.sessionId, a.providerSessionId, a.provider, a.payload, a.integrity, MAX(a.observedAt) AS observedAt FROM session_associations a LEFT JOIN sessions s ON s.id=a.sessionId
      WHERE ${where.join(' AND ')} GROUP BY a.sessionId ORDER BY MAX(COALESCE(s.lastObserved, a.observedAt)) DESC, a.sessionId LIMIT ? OFFSET ?`).all(...params, limit, offset) as { sessionId: string; providerSessionId: string; provider: 'entire' | 'codex'; observedAt: string; payload: string; integrity: string }[]
    return rows.map(row => {
      if (digest(row.payload) !== row.integrity || JSON.parse(row.payload).repositoryId !== this.repositoryId) throw new Error('ASSOCIATION_INTEGRITY_ERROR')
      this.associations(row.sessionId)
      const live = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(row.sessionId) as SessionRow | undefined
      return live ?? { id: row.sessionId, providerSessionId: row.providerSessionId, provider: row.provider, providerVersion: 'historical', agent: 'codex', startedAt: null, endedAt: null,
        lastObserved: row.observedAt, state: 'UNKNOWN', coverage: 'UNAVAILABLE', revision: 0, eventCount: 0, payloadBytes: 0, sourceDigest: '', sourceBytes: 0,
        sourceObservation: '{}', importState: 'UNKNOWN', coverageReasons: '{}', historicalState: 'SESSION_EVICTED' }
    })
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
    const legacy = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='event_payloads'").get()
    const row = this.db.prepare(`SELECT e.*, ${legacy ? 'p.text' : 'NULL AS text'} FROM events e ${legacy ? 'LEFT JOIN event_payloads p ON p.eventId=e.id' : ''} WHERE e.sessionId=? AND e.id=?`).get(sessionId, id) as (EventRow & { text: string | null }) | undefined
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
      databaseBytes: size(this.path), walBytes: size(this.path + '-wal'), storage: 'REFERENCES_ONLY', capacityQuota: null }
  }
  maintain(): void { this.db.pragma('wal_checkpoint(PASSIVE)'); this.db.pragma('incremental_vacuum(64)') }
}
