import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { SessionStore, sessionStorePath } from './store'
import { digest } from './privacy'
import type { SessionInput } from './types'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.reverse()) close(); cleanup.length = 0 })
export function input(id: string, overrides: Partial<SessionInput> = {}): SessionInput {
  return { providerSessionId: id, providerVersion: 'fixture', agent: 'codex', state: 'UNKNOWN', coverage: 'PARTIAL', importState: 'METADATA_ONLY', sourceDigest: digest(id), sourceBytes: 0, ...overrides }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'session-store-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const open = (repository = 'A') => { const store = new SessionStore(sessionStorePath(root, repository), repository); cleanup.push(() => store.close()); return store }
  return { open }
}
it('preserves repository isolation and separate identities for matching agent IDs', () => {
  const f = fixture(), a = f.open(), b = f.open('B')
  const codex = a.ingest(input('shared'), []).sessionId
  const other = a.ingest(input('shared', { agent: 'antigravity' }), []).sessionId
  expect(codex).not.toBe(other)
  expect(a.registry.sessionIdentity(codex)).toEqual({ kind: 'SESSION', id: 'entire:shared' })
  expect(a.registry.sessionIdentity(other)).toEqual({ kind: 'SESSION', id: 'entire-agent:antigravity:shared' })
  const collidingLegacy = a.ingest(input('antigravity:shared'), []).sessionId
  expect(a.registry.sessionIdentity(collidingLegacy)).not.toEqual(a.registry.sessionIdentity(other))
  expect(b.count()).toBe(0)
  expect(() => b.session(codex)).toThrow('SESSION_UNAVAILABLE')
  expect(() => new SessionStore(a.path, 'B')).toThrow('REPOSITORY_MISMATCH')
})
it('keeps immutable associations and signed cursors across reopen and rejects tampering', () => {
  const a = fixture().open(), result = a.ingest(input('session'), [])
  const link = { repositoryId: 'A', sessionId: result.sessionId, provider: 'entire' as const, providerSessionId: 'session', worktreeId: 'a'.repeat(64), generation: 'b'.repeat(64), evidence: 'WORKTREE_VERIFIED' as const, origin: 'ENTIRE_PROVIDER' as const, artifactId: 'plan' }
  const recorded = a.recordAssociation(link, a.catalogRevision())
  expect(a.recordAssociation(link, a.catalogRevision()).replay).toBe(true)
  const cursor = a.cursor({ selector: 'session' }, 25), reopened = new SessionStore(a.path, 'A')
  try {
    expect(reopened.offset(cursor, { selector: 'session' })).toBe(25)
    expect(() => reopened.offset(cursor, { selector: 'other' })).toThrow('CURSOR_STALE')
    expect(reopened.sessions({ artifactId: 'plan' }, 0, 5)[0].id).toBe(result.sessionId)
    const sql = new Database(a.path)
    try { sql.prepare('UPDATE session_associations SET integrity=? WHERE id=?').run('tampered', recorded.associationId) } finally { sql.close() }
    expect(() => reopened.associations(result.sessionId)).toThrow('ASSOCIATION_INTEGRITY_ERROR')
  } finally { reopened.close() }
})
it('rejects invalid metadata and direct transcript writes, and rolls back cancellation', () => {
  const a = fixture().open()
  expect(() => a.ingest(input('invalid', { state: 'ENDED' }), [])).toThrow('INVALID_IMPORT')
  expect(() => a.ingest(input('source'), [{ type: 'INPUT', text: 'private', sourcePosition: 1 }])).toThrow('SOURCE_REFERENCE_REQUIRED')
  let checks = 0
  expect(() => a.ingest(input('cancelled'), [], () => { if (++checks === 2) throw new Error('WORKTREE_STALE') })).toThrow('WORKTREE_STALE')
  expect(a.count()).toBe(0)
})
it('creates only reference metadata without textual payload schema', () => {
  const a = fixture().open()
  a.ingest(input('metadata'), [])
  const db = new Database(a.path, { readonly: true })
  try {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='event_payloads'").get()).toBeUndefined()
    expect((db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map(row => row.name)).not.toContain('summary')
    expect(db.pragma('foreign_key_check')).toEqual([])
  } finally { db.close() }
})
