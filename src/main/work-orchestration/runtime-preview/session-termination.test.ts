import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { nativeObservation, rootExitSchema } from './native-owner'
import { PreviewSessionStore, type PreviewSessionRecord, terminationSchema } from './session-store'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true }) })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'preview-termination-')); directories.push(directory)
  const at = new Date().toISOString()
  const record: PreviewSessionRecord = { schemaVersion: 1, persistence: 'PERSISTED', sessionId: randomUUID(), operationId: randomUUID(),
    selection: { repositoryId: 'repo', worktreeId: 'tree', generation: 'generation', profileId: 'profile', fingerprint: 'hash' },
    profileRevision: 1, gitFingerprint: 'source', revision: 0, at, startedAt: at, endedAt: at, sourceSnapshot: null,
    state: 'FAILED', reconciliation: 'NOT_REQUIRED', failure: 'UNEXPECTED_PROCESS_EXIT', resources: 'RELEASED', process: null,
    recoveryObservation: null, resourceInventory: [], coverage: [], readiness: 'NOT_READY', liveness: 'NOT_OBSERVED',
    attestation: { artifact: 'NOT_OBSERVED', loadedCode: 'NOT_OBSERVED' }, shutdown: { graceMs: 0, forceMs: 1000, graceful: false } }
  return { store: new PreviewSessionStore(directory), record }
}
const unknown = { status: 'UNKNOWN', code: null, reasonCode: 'EXIT_STATUS_NOT_RECORDED', observedAt: null } as const

describe('termination receipts — storage and contract fixtures', () => {
  it('reads old terminal sessions without adding a retrospective cause or stop intent', () => {
    const { store, record } = fixture(); store.reserve(record)
    expect(new PreviewSessionStore(store.root).read(record.sessionId)).toEqual(record)
    expect(store.read(record.sessionId).termination).toBeUndefined()
  })
  it('preserves an explicit unknown reason through a fresh store instance', () => {
    const { store, record } = fixture()
    record.termination = { kind: 'UNEXPECTED_EXIT', reasonCode: record.failure!, observedAt: record.at, rootExit: unknown,
      supervisor: { status: 'UNKNOWN', pid: null, created: null, phase: null }, process: null }
    store.reserve(record)
    expect(new PreviewSessionStore(store.root).read(record.sessionId).termination?.rootExit).toEqual(unknown)
  })
  it.each(['state', 'termination', 'stopIntent'] as const)('detects terminal history mutation: %s', field => {
    const { store, record } = fixture()
    record.stopIntent = { requestedAt: record.at }
    record.termination = { kind: 'STARTUP_FAILURE', reasonCode: 'LAUNCH_FAILED', observedAt: record.at, rootExit: unknown,
      supervisor: { status: 'EXITED', pid: null, created: null, phase: null }, process: null }
    store.reserve(record)
    const next = structuredClone({ ...record, revision: 1 })
    if (field === 'state') next.state = 'STOPPED'
    if (field === 'termination') delete next.termination
    if (field === 'stopIntent') delete next.stopIntent
    store.append(next)
    expect(() => store.read(record.sessionId)).toThrow(/SESSION_TERMINAL_CHANGED|SESSION_TERMINATION_CHANGED|SESSION_STOP_INTENT_CHANGED/)
  })
  it('accepts legacy native observations while rejecting invented or unbounded exit data', () => {
    expect(nativeObservation.safeParse({ pid: 1, created: '1', rootSignaled: true, knownHandlesClosed: true, activeProcesses: 0,
      jobClosed: true, eventClosed: true, assignedAtCreation: true, ownerOutsideJob: true, phase: 'DRAINED' }).success).toBe(true)
    expect(rootExitSchema.safeParse({ ...unknown, code: 1 }).success).toBe(false)
    expect(rootExitSchema.safeParse({ ...unknown, status: 'KNOWN' }).success).toBe(false)
    expect(rootExitSchema.safeParse({ ...unknown, reasonCode: 'a'.repeat(81) }).success).toBe(false)
    expect(rootExitSchema.safeParse({ ...unknown, token: 'forbidden' }).success).toBe(false)
    expect(terminationSchema.safeParse({ kind: 'CRASH', reasonCode: 'GUESSED' }).success).toBe(false)
  })
})
