import type Database from 'better-sqlite3'
import { createHmac, randomUUID } from 'node:crypto'
import type { EntireSource } from './entire-source'
import type { ReferencedEvent, TranscriptField } from './entire-transcript'
import { digest, sanitize, utf8Prefix } from './privacy'
import { eventReference } from './event-reference'
import type { Coverage, EventRow } from './types'

export interface ReferenceSource { locator: EntireSource; sourceDigest: string; sourceBytes: number; normalizer: string; revision: number }
interface LegacyEvent extends EventRow { text: string | null }
interface LiteralRead { content: string; complete: boolean; payloadDigest: string; range: { startByte: number; endByte: number } }
export class SessionReferences {
  private readonly verifiedRuns = new Map<string, { revision: number; sourceDigest: string }>()
  constructor(readonly db: Database.Database, private readonly key: string) {
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
      CREATE TABLE IF NOT EXISTS legacy_reference_verifications(sessionId TEXT NOT NULL,sourceDigest TEXT NOT NULL,eventId TEXT NOT NULL,legacyDigest TEXT NOT NULL,revision INTEGER NOT NULL,evidence TEXT NOT NULL,integrity TEXT NOT NULL,PRIMARY KEY(sessionId,sourceDigest,eventId));
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
  async verifyLegacy(runId: string, sourceDigest: string, read: (legacy: LegacyEvent, candidate: ReferencedEvent, offset: number) => Promise<LiteralRead>, assertCurrent: () => void, shouldPause: () => boolean): Promise<{ complete: boolean; verified: number }> {
    const run = this.db.prepare('SELECT sessionId FROM reference_runs WHERE id=?').get(runId) as { sessionId: string } | undefined
    if (!run) throw new Error('SOURCE_INDEX_UNAVAILABLE')
    const session = this.db.prepare('SELECT revision,sourceDigest FROM sessions WHERE id=?').get(run.sessionId) as { revision: number; sourceDigest: string }
    let after = 0, verified = 0
    for (;;) {
      const batch = this.db.prepare('SELECT e.*,p.text FROM events e LEFT JOIN event_payloads p ON p.eventId=e.id WHERE e.sessionId=? AND e.ordinal>? ORDER BY e.ordinal LIMIT 32').all(run.sessionId, after) as LegacyEvent[]
      if (!batch.length) break
      for (const legacy of batch) {
        assertCurrent()
        if (shouldPause()) return { complete: false, verified }
        after = legacy.ordinal
        const candidateRow = this.db.prepare('SELECT event FROM reference_staging WHERE runId=? AND ordinal=?').get(runId, legacy.ordinal) as { event: string } | undefined
        if (!candidateRow) throw new Error('LEGACY_SOURCE_RECOVERY_REQUIRED')
        const candidate = JSON.parse(candidateRow.event) as ReferencedEvent
        if (candidate.sourcePosition !== legacy.sourcePosition || candidate.type !== legacy.type || (legacy.tool && candidate.tool !== legacy.tool) || (JSON.parse(legacy.files) as string[]).some(file => !candidate.files.includes(file))) throw new Error('LEGACY_SOURCE_IDENTITY_CONFLICT')
        if (legacy.text === null && !legacy.summary) continue
        const legacyDigest = digest(JSON.stringify([legacy.text, legacy.summary, legacy.type, legacy.tool, legacy.sourcePosition]))
        const prior = this.db.prepare('SELECT * FROM legacy_reference_verifications WHERE sessionId=? AND sourceDigest=? AND eventId=?').get(run.sessionId, sourceDigest, legacy.id) as { legacyDigest: string; revision: number; evidence: string; integrity: string } | undefined
        if (prior?.legacyDigest === legacyDigest && prior.revision === session.revision && this.validLegacyProof(prior, run.sessionId, sourceDigest, legacy, session)) { verified++; continue }
        const expected = legacy.text === null ? undefined : Buffer.from(legacy.text)
        if (legacy.text !== null && legacy.summary !== utf8Prefix(legacy.text.replace(/\s+/g, ' '), 160)) throw new Error('LEGACY_HISTORY_INTEGRITY_ERROR')
        let offset = 0, payloadDigest = '', summary = '', whitespace = false
        for (;;) {
          const page = await read(legacy, candidate, offset)
          if (page.range.startByte !== offset || (page.range.endByte <= offset && !page.complete)) throw new Error('SOURCE_READER_NO_PROGRESS')
          const bytes = Buffer.from(page.content)
          if (expected) {
            const size = Math.min(bytes.length, Math.max(0, expected.length - offset))
            if (!bytes.subarray(0, size).equals(expected.subarray(offset, offset + size))) throw new Error('LEGACY_LITERAL_MISMATCH')
          } else {
            for (const character of page.content) {
              if (Buffer.byteLength(summary) >= 160) break
              if (/\s/.test(character)) { if (!whitespace) summary += ' '; whitespace = true }
              else { summary += character; whitespace = false }
            }
          }
          if (payloadDigest && payloadDigest !== page.payloadDigest) throw new Error('SOURCE_REVISION_CHANGED')
          payloadDigest = page.payloadDigest; offset = page.range.endByte
          if (expected ? offset >= expected.length : page.complete || Buffer.byteLength(summary) >= 160) break
          if (page.complete) throw new Error('LEGACY_SOURCE_RECOVERY_REQUIRED')
        }
        if (!expected && utf8Prefix(summary, 160) !== legacy.summary) throw new Error('LEGACY_LITERAL_MISMATCH')
        const evidence = JSON.stringify({ sessionId: run.sessionId, eventId: legacy.id, sourceDigest, legacySessionDigest: session.sourceDigest, legacyDigest, payloadDigest, verifiedBytes: expected?.length ?? null, revision: session.revision })
        this.db.prepare('INSERT OR REPLACE INTO legacy_reference_verifications VALUES(?,?,?,?,?,?,?)').run(run.sessionId, sourceDigest, legacy.id, legacyDigest, session.revision, evidence, createHmac('sha256', this.key).update(evidence).digest('hex'))
        verified++
      }
    }
    assertCurrent()
    this.verifiedRuns.set(runId, session)
    return { complete: true, verified }
  }
  private validLegacyProof(proof: { evidence: string; integrity: string }, sessionId: string, sourceDigest: string, legacy: LegacyEvent, session: { revision: number; sourceDigest: string }): boolean {
    if (createHmac('sha256', this.key).update(proof.evidence).digest('hex') !== proof.integrity) return false
    try {
      const evidence = JSON.parse(proof.evidence)
      return evidence.sessionId === sessionId && evidence.eventId === legacy.id && evidence.sourceDigest === sourceDigest && evidence.revision === session.revision && evidence.legacySessionDigest === session.sourceDigest &&
        evidence.legacyDigest === digest(JSON.stringify([legacy.text, legacy.summary, legacy.type, legacy.tool, legacy.sourcePosition])) && /^[a-f0-9]{64}$/.test(evidence.payloadDigest)
    } catch { return false }
  }
  finalizeLegacySchema(assertCurrent: () => void): { complete: boolean; blockedSessions: number } {
    return this.db.transaction(() => {
      assertCurrent()
      const sessions = this.db.prepare('SELECT id FROM sessions').iterate() as IterableIterator<{ id: string }>
      let blockedSessions = 0
      for (const session of sessions) if (this.legacyPayloads(session.id)) blockedSessions++
      if (blockedSessions) return { complete: false, blockedSessions }
      this.db.exec('DROP TABLE IF EXISTS event_payloads')
      if ((this.db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).some(column => column.name === 'summary')) this.db.exec('ALTER TABLE events DROP COLUMN summary')
      assertCurrent()
      return { complete: true, blockedSessions: 0 }
    }).immediate()
  }
  commit(runId: string, sourceDigest: string, sourceBytes: number, assertCurrent: () => void, coverage: Coverage): { sessionId: string; revision: number; eventCount: number; replay: boolean } {
    if (coverage !== 'COMPLETE') throw new Error('SOURCE_PARTIAL_CONFLICT')
    if (!/^[a-f0-9]{64}$/.test(sourceDigest) || !Number.isSafeInteger(sourceBytes) || sourceBytes < 0) throw new Error('SOURCE_IDENTITY_CONFLICT')
    const run = this.db.prepare('SELECT * FROM reference_runs WHERE id=?').get(runId) as { sessionId: string; locator: string; normalizer: string; expectedRevision: number } | undefined
    if (!run) throw new Error('SOURCE_INDEX_UNAVAILABLE')
    const legacy = this.legacyPayloads(run.sessionId)
    const verification = this.verifiedRuns.get(runId)
    if (legacy && !verification) throw new Error('LEGACY_MIGRATION_REQUIRED')
    return this.db.transaction(() => {
      assertCurrent()
      if ((this.db.prepare('SELECT revision FROM sessions WHERE id=?').get(run.sessionId) as { revision: number }).revision !== run.expectedRevision) throw new Error('REVISION_CONFLICT')
      if (legacy) {
        const current = this.db.prepare('SELECT revision,sourceDigest FROM sessions WHERE id=?').get(run.sessionId) as { revision: number; sourceDigest: string }
        if (current.revision !== verification!.revision || current.sourceDigest !== verification!.sourceDigest) throw new Error('REVISION_CONFLICT')
        const rows = this.db.prepare('SELECT e.*,p.text FROM events e LEFT JOIN event_payloads p ON p.eventId=e.id WHERE e.sessionId=? ORDER BY e.ordinal').iterate(run.sessionId) as IterableIterator<LegacyEvent>
        for (const event of rows) {
          if (event.text === null && !event.summary) continue
          const proof = this.db.prepare('SELECT evidence,integrity FROM legacy_reference_verifications WHERE sessionId=? AND sourceDigest=? AND eventId=?').get(run.sessionId, sourceDigest, event.id) as { evidence: string; integrity: string } | undefined
          if (!proof || !this.validLegacyProof(proof, run.sessionId, sourceDigest, event, current)) throw new Error('LEGACY_HISTORY_INTEGRITY_ERROR')
        }
        this.db.prepare('DELETE FROM event_payloads WHERE eventId IN (SELECT id FROM events WHERE sessionId=?)').run(run.sessionId)
      }
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
    this.verifiedRuns.delete(runId)
    this.db.prepare('DELETE FROM reference_staging WHERE runId=?').run(runId)
    this.db.prepare('DELETE FROM reference_tools WHERE runId=?').run(runId)
    this.db.prepare('DELETE FROM reference_runs WHERE id=?').run(runId)
  }
}
