import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from './store'
import { legacyStoreFixture } from './fixtures/legacy-store-fixture'
import { migrateSessionNamespace } from './session-namespace-migration'

it('proves the namespace table rebuild preserves payloads, foreign keys and rollback in an isolated in-memory database', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys=ON')
    db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,provider TEXT,agent TEXT,providerSessionId TEXT,UNIQUE(provider,providerSessionId)); CREATE TABLE events(id TEXT PRIMARY KEY,sessionId TEXT REFERENCES sessions(id) ON DELETE CASCADE); CREATE TABLE event_payloads(eventId TEXT REFERENCES events(id) ON DELETE CASCADE,text TEXT); INSERT INTO sessions VALUES('s','entire','codex','same'); INSERT INTO events VALUES('e','s'); INSERT INTO event_payloads VALUES('e','legacy literal preserved');")
    const snapshot = () => JSON.stringify(['sessions', 'events', 'event_payloads'].map(table => db.prepare('SELECT * FROM ' + table).all()))
    const original = snapshot()
    const migrate = (fail: boolean) => { let checks = 0; migrateSessionNamespace(db, () => { if (fail && ++checks === 2) throw new Error('INJECTED_FAILURE') }) }
    expect(() => migrate(true)).toThrow('INJECTED_FAILURE')
    expect(snapshot()).toBe(original)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    migrate(false)
    expect(snapshot()).toBe(original)
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('other', 'entire', 'antigravity', 'same')
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 2 })
    expect(db.prepare('SELECT text FROM event_payloads').get()).toEqual({ text: 'legacy literal preserved' })
    expect(db.pragma('foreign_key_check')).toEqual([])
  } finally { db.close() }
})

it('proves rollback and readback against a file-backed actual SessionStore fixture with associations and registry', () => {
  const root = mkdtempSync(join(tmpdir(), 'namespace-real-store-')), path = join(root, 'fixture.sqlite')
  let store: SessionStore | undefined
  try {
    const legacy = legacyStoreFixture(path, 'fixture', root)
    const result = legacy.ingest({ providerSessionId: 'source', providerVersion: '0.12.2', agent: 'codex', state: 'UNKNOWN', coverage: 'COMPLETE', sourceDigest: 'fixture', sourceBytes: 12 }, [{ type: 'INPUT', text: 'fixture literal', sourcePosition: 1 }])
    legacy.observeWorktree(result.sessionId, { worktreeId: 'a'.repeat(64), generation: 'b'.repeat(64) }); legacy.close()
    store = new SessionStore(path, 'fixture')
    const before = JSON.stringify({ session: store.session(result.sessionId), events: store.events(result.sessionId, {}, 0, 10), associations: store.associations(result.sessionId) })
    store.close(); store = undefined
    const db = new Database(path)
    const originalSchema = (db.prepare("SELECT sql FROM sqlite_master WHERE name='sessions'").get() as { sql: string }).sql
    const indexes = (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='sessions' AND sql IS NOT NULL").all() as { sql: string }[]).map(row => row.sql)
    try {
      const rebuild = (fail: boolean) => {
        db.pragma('foreign_keys=OFF')
        try {
          db.transaction(() => {
            db.exec(originalSchema.replace(/^CREATE TABLE sessions\s*\(/i, 'CREATE TABLE sessions_v7(').replace('UNIQUE(provider, providerSessionId)', 'UNIQUE(provider, agent, providerSessionId)'))
            db.exec('INSERT INTO sessions_v7 SELECT * FROM sessions; DROP TABLE sessions; ALTER TABLE sessions_v7 RENAME TO sessions;')
            for (const sql of indexes) db.exec(sql)
            expect(db.pragma('foreign_key_check')).toEqual([])
            if (fail) throw new Error('INJECTED_FILE_FAILURE')
          }).immediate()
        } finally { db.pragma('foreign_keys=ON') }
      }
      expect(() => rebuild(true)).toThrow('INJECTED_FILE_FAILURE')
      expect((db.prepare("SELECT sql FROM sqlite_master WHERE name='sessions'").get() as { sql: string }).sql).toBe(originalSchema)
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
      rebuild(false)
      expect(db.prepare('SELECT text FROM event_payloads').get()).toEqual({ text: 'fixture literal' })
      expect(db.pragma('foreign_key_check')).toEqual([])
    } finally { db.close() }
    store = new SessionStore(path, 'fixture')
    expect(JSON.stringify({ session: store.session(result.sessionId), events: store.events(result.sessionId, {}, 0, 10), associations: store.associations(result.sessionId) })).toBe(before)
    expect(store.registry.sessionIdentity(result.sessionId)).toEqual({ kind: 'SESSION', id: 'entire:source' })
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }) }
})
