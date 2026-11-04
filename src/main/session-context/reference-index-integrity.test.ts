import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from './store'
import { digest } from './privacy'
import type { ReferencedEvent } from './entire-transcript'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.reverse()) close(); cleanup.length = 0 })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'reference-integrity-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const store = new SessionStore(join(root, 'fixture.sqlite'), 'fixture')
  cleanup.push(() => store.close())
  const sessionId = store.ingest({ providerSessionId: 'source', providerVersion: '0.12.2', agent: 'codex', state: 'UNKNOWN', coverage: 'PARTIAL', importState: 'METADATA_ONLY', sourceDigest: digest('metadata'), sourceBytes: 0 }, []).sessionId
  const begin = () => store.references.begin(sessionId, { kind: 'ENTIRE_CLI', agent: 'codex', providerSessionId: 'source' }, 'codex-v1')
  const event: ReferencedEvent = { type: 'INPUT', sourcePosition: 1, files: [], fields: [{ path: 'payload/message', startByte: 1, endByte: 5, bytes: 4, digest: digest('body'), encoding: 'JSON_STRING' }] }
  return { store, sessionId, begin, event }
}
it('validates reference envelopes and rejects direct body ingestion', () => {
  const f = fixture(), run = f.begin()
  expect(() => f.store.references.append(run, [{ ...f.event, sourcePosition: -1 }])).toThrow('INVALID_EVENT')
  expect(() => f.store.references.append(run, [{ ...f.event, fields: [{ ...f.event.fields[0], endByte: -1 }] }])).toThrow('SOURCE_LOCATOR_INVALID')
  f.store.references.append(run, [{ ...f.event, text: 'NEVER_PERSIST' } as ReferencedEvent])
  expect([...f.store.references.staged(run)][0].event).not.toContain('NEVER_PERSIST')
  expect(() => f.store.ingest({ providerSessionId: 'source', providerVersion: '0.12.2', agent: 'codex', state: 'UNKNOWN', coverage: 'PARTIAL', sourceDigest: digest('metadata'), sourceBytes: 0 }, [{ type: 'INPUT', text: 'body', sourcePosition: 1 }])).toThrow('SOURCE_REFERENCE_REQUIRED')
})
it('preserves event identities on replay and rejects partial index replacement', () => {
  const f = fixture(), first = f.begin()
  f.store.references.append(first, [f.event])
  f.store.references.commit(first, digest('source'), 5, () => {}, 'COMPLETE')
  const before = f.store.events(f.sessionId, {}, 0, 10), revision = f.store.session(f.sessionId).revision
  const replay = f.begin(); f.store.references.append(replay, [f.event])
  expect(f.store.references.commit(replay, digest('source'), 5, () => {}, 'COMPLETE').replay).toBe(true)
  const partial = f.begin(); f.store.references.append(partial, [f.event])
  expect(() => f.store.references.commit(partial, digest('partial'), 5, () => {}, 'PARTIAL')).toThrow('SOURCE_PARTIAL_CONFLICT')
  expect(f.store.events(f.sessionId, {}, 0, 10)).toEqual(before)
  expect(f.store.session(f.sessionId).revision).toBe(revision)
})
it('rolls back cancelled publication and rejects a stale concurrent writer', () => {
  const f = fixture(), stale = f.begin(), current = f.begin()
  f.store.references.append(current, [f.event])
  f.store.references.commit(current, digest('first'), 5, () => {}, 'COMPLETE')
  expect(() => f.store.references.commit(stale, digest('stale'), 5, () => {}, 'COMPLETE')).toThrow('REVISION_CONFLICT')
  const before = f.store.session(f.sessionId), events = f.store.events(f.sessionId, {}, 0, 10)
  const cancelled = f.begin(); f.store.references.append(cancelled, [f.event, { ...f.event, sourcePosition: 2 }])
  let calls = 0
  expect(() => f.store.references.commit(cancelled, digest('second'), 10, () => { if (++calls === 3) throw new Error('CANCELLED') }, 'COMPLETE')).toThrow('CANCELLED')
  expect(f.store.session(f.sessionId)).toEqual(before)
  expect(f.store.events(f.sessionId, {}, 0, 10)).toEqual(events)
})
