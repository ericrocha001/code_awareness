import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { EntireSource } from './entire-source'
import type { ReferencedEvent, TranscriptField } from './entire-transcript'
import { digest, sanitize, utf8Prefix } from './privacy'
import { eventReference } from './event-reference'
import type { Coverage } from './types'

export interface ReferenceSource { locator: EntireSource; sourceDigest: string; sourceBytes: number; normalizer: string; revision: number }
export class SessionReferences {
  constructor(readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_sources(sessionId TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,locator TEXT NOT NULL,sourceDigest TEXT NOT NULL,sourceBytes INTEGER NOT NULL,normalizer TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS event_locators(eventId TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,sessionId TEXT NOT NULL,fields TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reference_runs(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL,locator TEXT NOT NULL,normalizer TEXT NOT NULL,expectedRevision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reference_staging(runId TEXT NOT NULL,ordinal INTEGER NOT NULL,event TEXT NOT NULL,PRIMARY KEY(runId,ordinal));
      CREATE TABLE IF NOT EXISTS reference_tools(runId TEXT NOT NULL,callId TEXT NOT NULL,tool TEXT NOT NULL,PRIMARY KEY(runId,callId));
      CREATE TABLE IF NOT EXISTS literal_spans(eventId TEXT NOT NULL,revision INTEGER NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,replacement TEXT NOT NULL,rule INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS literal_span_order ON literal_spans(eventId,revision,start,end);
      CREATE TABLE IF NOT EXISTS literal_anchors(eventId TEXT NOT NULL,revision INTEGER NOT NULL,fieldIndex INTEGER NOT NULL,decodedByte INTEGER NOT NULL,rawByte INTEGER NOT NULL,PRIMARY KEY(eventId,revision,fieldIndex,decodedByte));
      CREATE TABLE IF NOT EXISTS literal_projection(eventId TEXT PRIMARY KEY,revision INTEGER NOT NULL,payloadDigest TEXT NOT NULL,outputBytes INTEGER NOT NULL);
    `)
  }
  begin(sessionId: string, locator: EntireSource, normalizer: string): string {
    const id = randomUUID()
    const session = this.db.prepare('SELECT revision FROM sessions WHERE id=?').get(sessionId) as { revision: number } | undefined
    if (!session) throw new Error('SESSION_UNAVAILABLE')
    this.db.prepare('INSERT INTO reference_runs VALUES(?,?,?,?,?)').run(id, sessionId, JSON.stringify(locator), normalizer, session.revision)
    return id
  }
  append(runId: string, events: ReferencedEvent[]): void {
    const insert = this.db.prepare('INSERT INTO reference_staging VALUES(?,?,?)')
    let ordinal = (this.db.prepare('SELECT COALESCE(MAX(ordinal),0) AS n FROM reference_staging WHERE runId=?').get(runId) as { n: number }).n
    this.db.transaction(() => {
      for (const event of events) {
        const normalized = eventReference(event)
        insert.run(runId, ++ordinal, JSON.stringify(normalized))
      }
    }).immediate()
  }
  tool(runId: string, id: string, tool?: string): string | undefined {
    if (typeof id !== 'string' || !id || id.length > 200) return tool
    if (tool && tool.length <= 80) this.db.prepare('INSERT OR REPLACE INTO reference_tools VALUES(?,?,?)').run(runId, id, utf8Prefix(sanitize(tool), 80))
    return (this.db.prepare('SELECT tool FROM reference_tools WHERE runId=? AND callId=?').get(runId, id) as { tool: string } | undefined)?.tool
  }
  *staged(runId: string): IterableIterator<{ ordinal: number; event: string }> {
    let after = 0
    for (;;) {
      const batch = this.db.prepare('SELECT ordinal,event FROM reference_staging WHERE runId=? AND ordinal>? ORDER BY ordinal LIMIT 256').all(runId, after) as { ordinal: number; event: string }[]
      if (!batch.length) return
      for (const row of batch) { after = row.ordinal; yield row }
    }
  }
  source(sessionId: string): ReferenceSource | undefined {
    const row = this.db.prepare('SELECT * FROM session_sources WHERE sessionId=?').get(sessionId) as { locator: string; sourceDigest: string; sourceBytes: number; normalizer: string; revision: number } | undefined
    return row ? { ...row, locator: JSON.parse(row.locator) } : undefined
  }
  fields(eventId: string): TranscriptField[] | undefined {
    const row = this.db.prepare('SELECT fields FROM event_locators WHERE eventId=?').get(eventId) as { fields: string } | undefined
    return row ? JSON.parse(row.fields) : undefined
  }
  legacyPayloads(sessionId: string): number {
    const payloads = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='event_payloads' AND type='table'").get()
    const summary = (this.db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).some(column => column.name === 'summary')
    if (!payloads && !summary) return 0
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM events e ${payloads ? 'LEFT JOIN event_payloads p ON p.eventId=e.id' : ''} WHERE e.sessionId=? AND (${payloads ? 'p.eventId IS NOT NULL' : '0'} ${summary ? "OR e.summary<>''" : ''})`).get(sessionId) as { n: number }).n
  }
  discardLegacyText(assertCurrent: () => void): { discardedSessions: number; complete: true } {
    return this.db.transaction(() => {
      assertCurrent()
      const payloads = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='event_payloads'").get()
      const summary = (this.db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).some(column => column.name === 'summary')
      let discardedSessions = 0
      if (payloads || summary) {
        discardedSessions = this.db.prepare(`UPDATE sessions SET revision=revision+1,payloadBytes=0,coverage='PARTIAL',coverageReasons=json_set(coverageReasons,'$.TRANSCRIPT_NOT_IMPORTED',1),importState=CASE WHEN EXISTS(SELECT 1 FROM session_sources source WHERE source.sessionId=sessions.id) THEN 'TRANSCRIPT_REFERENCED' ELSE 'METADATA_ONLY' END
          WHERE id IN (SELECT e.sessionId FROM events e ${payloads ? 'LEFT JOIN event_payloads p ON p.eventId=e.id' : ''} WHERE ${payloads ? 'p.eventId IS NOT NULL' : '0'} ${summary ? "OR e.summary<>''" : ''})`).run().changes
        this.db.exec('DROP TABLE IF EXISTS event_payloads')
        if (summary) this.db.exec('ALTER TABLE events DROP COLUMN summary')
        if (discardedSessions) this.db.prepare('UPDATE identity SET revision=revision+1').run()
      }
      this.db.exec('DROP TABLE IF EXISTS legacy_reference_verifications')
      assertCurrent()
      return { discardedSessions, complete: true as const }
    }).immediate()
  }
  commit(runId: string, sourceDigest: string, sourceBytes: number, assertCurrent: () => void, coverage: Coverage): { sessionId: string; revision: number; eventCount: number; replay: boolean } {
    if (coverage !== 'COMPLETE') throw new Error('SOURCE_PARTIAL_CONFLICT')
    if (!/^[a-f0-9]{64}$/.test(sourceDigest) || !Number.isSafeInteger(sourceBytes) || sourceBytes < 0) throw new Error('SOURCE_IDENTITY_CONFLICT')
    const run = this.db.prepare('SELECT * FROM reference_runs WHERE id=?').get(runId) as { sessionId: string; locator: string; normalizer: string; expectedRevision: number } | undefined
    if (!run) throw new Error('SOURCE_INDEX_UNAVAILABLE')
    if (this.legacyPayloads(run.sessionId)) throw new Error('LEGACY_TEXT_DISCARD_REQUIRED')
    return this.db.transaction(() => {
      assertCurrent()
      if ((this.db.prepare('SELECT revision FROM sessions WHERE id=?').get(run.sessionId) as { revision: number }).revision !== run.expectedRevision) throw new Error('REVISION_CONFLICT')
      const prior = this.source(run.sessionId)
      if (prior?.sourceDigest === sourceDigest && prior.normalizer === run.normalizer && JSON.stringify(prior.locator) === run.locator) {
        const row = this.db.prepare('SELECT revision,eventCount FROM sessions WHERE id=?').get(run.sessionId) as { revision: number; eventCount: number }
        this.discard(runId)
        return { sessionId: run.sessionId, ...row, replay: true }
      }
      const summary = (this.db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).some(column => column.name === 'summary')
      const insert = this.db.prepare(`INSERT INTO events(id,sessionId,ordinal,type,timestamp,tool,success,${summary ? 'summary,' : ''}files,sourcePosition,digest,bytes,omission,sanitized) VALUES(?,?,?,?,?,?,?,${summary ? "''," : ''}?,?,?,?,NULL,0)
        ON CONFLICT(sessionId,ordinal) DO UPDATE SET type=excluded.type,timestamp=excluded.timestamp,tool=excluded.tool,success=excluded.success,${summary ? "summary=''," : ''}files=excluded.files,sourcePosition=excluded.sourcePosition,digest=excluded.digest,bytes=excluded.bytes,omission=NULL,sanitized=0`)
      let count = 0
      for (const row of this.staged(runId)) {
        assertCurrent()
        const event = JSON.parse(row.event) as ReferencedEvent
        const bytes = event.fields.reduce((total, field) => total + field.bytes, Math.max(0, event.fields.length - 1))
        insert.run(randomUUID(), run.sessionId, row.ordinal, event.type, event.timestamp ?? null, event.tool ?? null, event.success === undefined ? null : Number(event.success), JSON.stringify(event.files), event.sourcePosition, digest(row.event), bytes)
        const id = (this.db.prepare('SELECT id FROM events WHERE sessionId=? AND ordinal=?').get(run.sessionId, row.ordinal) as { id: string }).id
        this.db.prepare('INSERT OR REPLACE INTO event_locators VALUES(?,?,?)').run(id, run.sessionId, JSON.stringify(event.fields))
        count++
      }
      this.db.prepare('DELETE FROM events WHERE sessionId=? AND ordinal>?').run(run.sessionId, count)
      this.db.prepare("UPDATE sessions SET revision=revision+1,eventCount=?,payloadBytes=0,sourceDigest=?,sourceBytes=?,coverage='COMPLETE',coverageReasons='{}',importState='TRANSCRIPT_REFERENCED',lastObserved=? WHERE id=?").run(count, sourceDigest, sourceBytes, new Date().toISOString(), run.sessionId)
      const revision = (this.db.prepare('SELECT revision FROM sessions WHERE id=?').get(run.sessionId) as { revision: number }).revision
      this.db.prepare('INSERT OR REPLACE INTO session_sources VALUES(?,?,?,?,?,?)').run(run.sessionId, run.locator, sourceDigest, sourceBytes, run.normalizer, revision)
      this.db.prepare('UPDATE identity SET revision=revision+1').run()
      this.discard(runId); assertCurrent()
      return { sessionId: run.sessionId, revision, eventCount: count, replay: false }
    }).immediate()
  }
  discard(runId: string): void {
    this.db.prepare('DELETE FROM reference_staging WHERE runId=?').run(runId)
    this.db.prepare('DELETE FROM reference_tools WHERE runId=?').run(runId)
    this.db.prepare('DELETE FROM reference_runs WHERE id=?').run(runId)
  }
}
