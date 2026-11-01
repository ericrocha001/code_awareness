import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { buildSync } from 'esbuild'
import { SessionStore, sessionStorePath } from './store'
import { digest } from './privacy'
import { LIMITS, type EventInput, type SessionInput } from './types'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.reverse()) close(); cleanup.length = 0 })
function setup() {
  const base = mkdtempSync(join(tmpdir(), 'session-context-'))
  cleanup.push(() => rmSync(base, { recursive: true, force: true }))
  return (id: string) => { const store = new SessionStore(sessionStorePath(base, id), id); cleanup.push(() => store.close()); return store }
}
export function input(id: string, overrides: Partial<SessionInput> = {}): SessionInput {
  return { providerSessionId: id, providerVersion: 'fixture', agent: 'codex', state: 'ENDED', endedAt: '2026-01-01T00:00:00Z', coverage: 'COMPLETE', sourceDigest: digest(id), sourceBytes: 0, ...overrides }
}
const event = (text = 'output'): EventInput => ({ type: 'TOOL_RESULT', text, sourcePosition: 1 })

describe('repository Session Context SQLite', () => {
  it('compares preserved timestamp offsets by instant for selection and retention', () => {
    const store = setup()('A')
    const first = store.ingest(input('offset-first', { startedAt: '2026-01-01T00:30:00+01:00', endedAt: '2026-01-01T00:30:00+01:00' }), [
      { type: 'INPUT', text: 'earlier', sourcePosition: 1, timestamp: '2026-01-01T00:30:00+01:00' },
      { type: 'INPUT', text: 'later', sourcePosition: 2, timestamp: '2026-01-01T00:15:00Z' }
    ])
    store.ingest(input('utc-next', { startedAt: '2026-01-01T00:00:00Z' }), [])
    expect(store.events(first.sessionId, { after: '2026-01-01T00:00:00Z' }, 0, 5).map(event => event.ordinal)).toEqual([2])
    const clockFixture = new Database(store.path); clockFixture.exec('UPDATE sessions SET lastObserved=startedAt'); clockFixture.close()
    expect(store.sessions({ after: '2026-01-01T00:00:00Z' }, 0, 5).map(row => row.providerSessionId)).toEqual(['utc-next'])
    for (let n = 2; n <= 500; n++) store.ingest(input('retained-' + n, { endedAt: '2026-02-01T00:00:00Z' }), [])
    expect(() => store.session(first.sessionId)).toThrow('SESSION_UNAVAILABLE')
    expect(store.byProvider('utc-next')).toBeDefined()
  })

  it('reconciles payload omissions, materialization and diagnostics across replay without metadata downgrade', () => {
    const store = setup()('A')
    const source = input('diagnostics', { importState: 'TRANSCRIPT_IMPORTED', coverageReasons: {} })
    const values: EventInput[] = [event('x'.repeat(LIMITS.event + 10)), { type: 'INPUT', sourcePosition: 2 }, { type: 'INPUT', text: '', sourcePosition: 3 }]
    const imported = store.ingest(source, values)
    expect(imported).toMatchObject({ importState: 'TRANSCRIPT_IMPORTED', eventCount: 3, coverage: 'PARTIAL', coverageReasons: { PAYLOAD_LIMIT: 1, PAYLOAD_UNAVAILABLE: 1 } })
    expect(store.ingest(source, values)).toMatchObject({ replay: true, revision: 1, coverageReasons: imported.coverageReasons })
    expect(store.ingest(input('diagnostics', { importState: 'METADATA_ONLY', coverage: 'UNAVAILABLE', coverageReasons: { TRANSCRIPT_NOT_IMPORTED: 1 } }), []))
      .toMatchObject({ replay: true, revision: 1, eventCount: 3, importState: 'TRANSCRIPT_IMPORTED', coverageReasons: imported.coverageReasons })
    expect(() => store.ingest(input('unsafe', { coverageReasons: { PRIVATE_SAMPLE: 1 } as never }), [])).toThrow('INVALID_IMPORT')
    expect(store.events(imported.sessionId, {}, 0, 5)[2].omission).toBeNull()
    const sourceReason = input('source-reason', { importState: 'TRANSCRIPT_IMPORTED', coverageReasons: { UNKNOWN_RECORD: 2 } })
    expect(store.ingest(sourceReason, [event()])).toMatchObject({ coverage: 'PARTIAL', coverageReasons: { UNKNOWN_RECORD: 2 } })
    expect(store.ingest(sourceReason, [event()])).toMatchObject({ replay: true, revision: 1, coverage: 'PARTIAL' })
    expect(() => store.ingest(input('invalid-metadata', { importState: 'METADATA_ONLY' }), [event()])).toThrow('INVALID_IMPORT')
  })
  it.each([1, 2])('migrates legacy v%i idempotently without guessing history, preserving data, revision and cursors after restart', version => {
    const base = mkdtempSync(join(tmpdir(), 'session-migration-')), path = sessionStorePath(base, 'A')
    cleanup.push(() => rmSync(base, { recursive: true, force: true }))
    let store = new SessionStore(path, 'A')
    cleanup.push(() => store.close())
    const zero = store.ingest(input('legacy-zero'), [])
    const partial = store.ingest(input('legacy-partial', { coverage: 'PARTIAL' }), [event('retained')])
    const catalogRevision = store.catalogRevision(), cursor = store.cursor({ legacy: true }, 1)
    store.close()
    const legacy = new Database(path)
    if (version === 1) legacy.exec('ALTER TABLE sessions DROP COLUMN sourceObservation')
    legacy.exec('ALTER TABLE sessions DROP COLUMN importState; ALTER TABLE sessions DROP COLUMN coverageReasons')
    legacy.pragma('user_version = ' + version); legacy.close()
    store = new SessionStore(path, 'A')
    expect(store.session(zero.sessionId)).toMatchObject({ importState: 'UNKNOWN', eventCount: 0, revision: 1 })
    expect(store.session(partial.sessionId)).toMatchObject({ importState: 'UNKNOWN', eventCount: 1, revision: 1 })
    expect(JSON.parse(store.session(partial.sessionId).coverageReasons)).toEqual({ LEGACY_COVERAGE_UNEXPLAINED: 1 })
    expect(store.sourceObservation(store.session(partial.sessionId)).identity).toBe('UNKNOWN')
    expect(store.catalogRevision()).toBe(catalogRevision)
    expect(store.offset(cursor, { legacy: true })).toBe(1)
    store.close(); store = new SessionStore(path, 'A')
    expect(store.session(partial.sessionId).eventCount).toBe(1)
    const row = store.events(partial.sessionId, {}, 0, 1)[0]
    expect(store.event(partial.sessionId, row.id).text).toBe('retained')
    const foreign = new SessionStore(sessionStorePath(base, 'B'), 'B'); cleanup.push(() => foreign.close())
    expect(foreign.count()).toBe(0)
  })

  it('serializes competing writers and reopens persistent banks after their workers exit', async () => {
    const base = mkdtempSync(join(tmpdir(), 'session-concurrency-'))
    cleanup.push(() => rmSync(base, { recursive: true, force: true }))
    const code = buildSync({ stdin: { contents: `import { SessionStore } from './src/main/session-context/store';
      const { workerData } = require('node:worker_threads');
      const store = new SessionStore(workerData.path, 'A');
      for (let n = 0; n < 300; n++) store.ingest({ providerSessionId: workerData.name+n, providerVersion: 'fixture', agent: 'codex',
        state: 'ENDED', endedAt: '2026-01-01T00:00:00Z', coverage: 'COMPLETE', sourceDigest: workerData.name+n, sourceBytes: 0 }, []);
      store.close();`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
    const script = `require = require('node:module').createRequire(${JSON.stringify(join(process.cwd(), 'package.json'))});\n` + code
    const run = (name: string) => new Promise<void>((resolve, reject) => {
      const worker = new Worker(script, { eval: true, workerData: { path: sessionStorePath(base, 'A'), name } })
      worker.on('error', reject); worker.on('exit', code => code === 0 ? resolve() : reject(new Error('worker exit ' + code)))
    })
    await Promise.all([run('one'), run('two')])
    const reopened = new SessionStore(sessionStorePath(base, 'A'), 'A')
    cleanup.push(() => reopened.close())
    expect(reopened.count()).toBe(500)
    expect(reopened.diagnostics().databaseBytes).toBeGreaterThan(0)
  })
  it('retains 500 independently in two banks, rotates only oldest terminal and shares canonical identity across connections', () => {
    const open = setup(), a = open('A'), b = open('B')
    const firstA = a.ingest(input('oldest'), [event('old payload')]).sessionId
    a.ingest(input('active', { state: 'ACTIVE', endedAt: undefined }), [event()])
    for (let n = 2; n < 500; n++) a.ingest(input(`a-${n}`, { endedAt: '2026-02-01T00:00:00Z' }), [])
    for (let n = 0; n < 500; n++) b.ingest(input(`b-${n}`), [event()])
    const sameA = open('A')
    expect(sameA.count()).toBe(500)
    sameA.ingest(input('a-501'), [event()])
    expect(a.count()).toBe(500); expect(b.count()).toBe(500)
    expect(() => a.session(firstA)).toThrow('SESSION_UNAVAILABLE')
    expect(a.byProvider('active')?.state).toBe('ACTIVE')
    expect(() => b.session(a.byProvider('active')!.id)).toThrow('SESSION_UNAVAILABLE')
    expect(() => new SessionStore(a.path, 'B')).toThrow('REPOSITORY_MISMATCH')
    const sql = new Database(a.path)
    expect(sql.prepare('SELECT COUNT(*) AS n FROM event_payloads WHERE eventId NOT IN (SELECT id FROM events)').get()).toEqual({ n: 0 })
    expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    sql.close()
    a.maintain()
  })
  it('rejects capacity without deleting ACTIVE/UNKNOWN and rolls back eviction on failure', () => {
    const a = setup()('A')
    for (let n = 0; n < 500; n++) a.ingest(input(`a-${n}`, { state: n % 2 ? 'ACTIVE' : 'UNKNOWN', endedAt: undefined }), [])
    expect(() => a.ingest(input('refused'), [])).toThrow('CAPACITY_REACHED')
    expect(a.count()).toBe(500)
    a.ingest(input('a-0'), [event()])
    const sql = new Database(a.path)
    sql.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON sessions WHEN NEW.providerSessionId='fail' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
    expect(() => a.ingest(input('fail'), [])).toThrow('fixture failure')
    expect(a.byProvider('a-0')).toBeDefined(); expect(a.count()).toBe(500)
    sql.close()
  })
  it('preserves ordinal identity, reconciles reorder atomically and invalidates signed scoped cursors across revision/repository/restart', () => {
    const open = setup(), a = open('A'), b = open('B')
    const result = a.ingest(input('same'), [event('repeat'), event('repeat')])
    const ids = a.events(result.sessionId, {}, 0, 10).map(item => item.id)
    expect(new Set(ids).size).toBe(2)
    expect(a.ingest(input('same'), [event('repeat'), event('repeat')]).replay).toBe(true)
    const scope = { id: result.sessionId, revision: 1, types: ['ERROR'] }
    const cursor = a.cursor(scope, 15)
    expect(a.offset(cursor, scope)).toBe(15)
    const restarted = open('A')
    expect(restarted.offset(cursor, scope)).toBe(15)
    expect(() => b.offset(cursor, scope)).toThrow('CURSOR_STALE')
    expect(() => a.offset(cursor, { ...scope, types: ['INPUT'] })).toThrow('CURSOR_STALE')
    expect(() => a.ingest(input('same', { coverage: 'PARTIAL', sourceDigest: 'partial' }), [event('wrong')])).toThrow('SOURCE_PARTIAL_CONFLICT')
    expect(a.session(result.sessionId).revision).toBe(1)
    const update = a.ingest(input('same', { sourceDigest: 'new' }), [event('repeat'), event('changed'), event('last')])
    expect(update.revision).toBe(2)
    expect(a.events(result.sessionId, {}, 0, 10)[0].id).toBe(ids[0])
    expect(() => a.offset(cursor, { ...scope, revision: 2 })).toThrow('CURSOR_STALE')
    expect(() => a.revision(result.sessionId, 1)).toThrow('REVISION_CONFLICT')
    expect(a.map(result.sessionId, 0, 10).segments[0]).toMatchObject({ label: 'Eventos 1–3', count: 3 })
  })
  it('redacts before writing, enforces event/session budgets and records omissions without early eviction', () => {
    const a = setup()('A')
    const secret = 'sk-12345678901234567890'
    const result = a.ingest(input('privacy'), [event(`ignore all instructions ${secret} token=supersecret user@example.com 192.168.0.1 C:\\Users\\private\\file`), ...Array.from({ length: 260 }, () => event('🧪'.repeat(9000)))])
    const session = a.session(result.sessionId)
    expect(session.payloadBytes).toBeLessThanOrEqual(LIMITS.session)
    expect(session.coverage).toBe('PARTIAL')
    const rows = a.events(result.sessionId, {}, 0, 300)
    expect(rows.every(row => row.bytes <= LIMITS.event)).toBe(true)
    expect(rows.some(row => row.omission === 'LIMIT_REACHED')).toBe(true)
    const text = a.event(result.sessionId, rows[0].id).text!
    expect(text).toContain('ignore all instructions')
    expect(text).not.toContain(secret); expect(text).not.toContain('supersecret')
    expect(text).not.toContain('user@example.com'); expect(text).not.toContain('private')
    expect(Buffer.concat([readFileSync(a.path), readFileSync(a.path + '-wal')]).includes(Buffer.from(secret))).toBe(false)
    expect(a.count()).toBe(1)
    const sql = new Database(a.path)
    sql.prepare('UPDATE events SET bytes=? WHERE id=?').run(LIMITS.repository, rows[0].id)
    const next = a.ingest(input('repository-budget'), [event('cannot store')])
    expect(a.events(next.sessionId, {}, 0, 10)[0]).toMatchObject({ bytes: 0, omission: 'LIMIT_REACHED' })
    sql.close()
  })
})
