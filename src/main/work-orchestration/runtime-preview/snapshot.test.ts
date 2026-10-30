import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PreviewSessionStore } from './session-store'
import { RuntimePreviewRunner } from './runner'
import { previewContextManifest } from './context-contract'
import { SnapshotAdapter, SnapshotLaunch, snapshotSelector } from './snapshot'
import { digest, hash } from '../preview-build/files'
import { previewFingerprint } from '../preview-profile'

describe('Snapshot launch admission', () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'snapshot-contract-'))
    await mkdir(join(root, 'dist'))
    const bytes = Buffer.from('controlled runtime identity')
    await writeFile(join(root, 'dist/electron.exe'), bytes)
    const runtimeBasis = { electron: '32.0.0', abi: '128', platform: 'win32', arch: 'x64', files: [{ path: 'electron.exe', bytes: bytes.length, sha256: hash(bytes) }] }
    const runtimeId = digest(runtimeBasis)
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ runtimeId, ...runtimeBasis }))
    const profile = { command: { inputs: [] }, profileId: 'profile', bootstrap: { dataPolicy: 'ARTIFACT_FIRST' }, revision: 1 }
    const selection = { repositoryId: 'repo', worktreeId: 'tree', generation: 'g1', profileId: 'profile', fingerprint: previewFingerprint(profile) }
    const capture = { captureId: 'a'.repeat(64), runtimeId, files: [], selection, profile, source: { head: 'captured-head' } }
    const build = { buildId: 'b'.repeat(64), captureId: capture.captureId, runtimeId, compatibility: runtimeBasis }
    const builds = { bundles: { root, read: vi.fn(async () => build) }, captures: { get: vi.fn(async () => capture), source: () => join(root, 'source') }, toolchains: { runtimeRoot: () => root } }
    const identity = { repositoryId: 'repo', record: { generation: 'g1', path: root } }
    const target = { guard: vi.fn(), git: { getCoordinationIdentity: vi.fn(async () => identity), getCoordinationSnapshot: vi.fn(() => { throw Error('SOURCE_SCAN_FORBIDDEN') }) } }
    const repositories = { open: vi.fn(async () => target) }
    const profiles = { profiles: vi.fn(async () => [profile]), approved: vi.fn(async () => true) }
    const launch = new SnapshotLaunch(builds as any, repositories as any, profiles as any)
    return { root, build, capture, selection, target, profiles, launch, builds, requested: { captureId: capture.captureId, buildId: build.buildId } }
  }
  it('runs the verified capture without compiling or scanning changed checkout source', async () => {
    const f = await fixture()
    try {
      const prepared = await f.launch.prepare(f.selection, f.requested)
      expect(prepared.snapshot.buildId).toBe(f.build.buildId)
      expect(prepared.preflight.snapshot).toEqual(f.capture.source)
      await prepared.guard()
      expect(f.target.git.getCoordinationSnapshot).not.toHaveBeenCalled()
      f.profiles.approved.mockResolvedValue(false)
      await expect(prepared.guard()).rejects.toThrow('PROFILE_APPROVAL_REQUIRED')
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
  it('refuses substituted captures, runtime corruption and stale ownership', async () => {
    const f = await fixture()
    try {
      f.build.captureId = 'c'.repeat(64)
      await expect(f.launch.prepare(f.selection, f.requested)).rejects.toThrow('BUILD_SCOPE_REJECTED')
      f.build.captureId = f.capture.captureId
      await writeFile(join(f.root, 'dist/electron.exe'), 'changed')
      await expect(f.launch.prepare(f.selection, f.requested)).rejects.toThrow()
      f.target.git.getCoordinationIdentity.mockResolvedValue({ repositoryId: 'repo', record: { generation: 'g2', path: f.root } })
      await expect(f.launch.prepare(f.selection, f.requested)).rejects.toThrow('WORKTREE_STALE')
      expect(snapshotSelector.safeParse({ ...f.requested, executable: 'injected' }).success).toBe(false)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
})

it('normalizes capture metadata through the context contract before comparing identity', () => {
  const captured = { head: 'h', branch: 'b', operation: null, indexRevision: 'i', worktreeRevision: 'w', dirty: true }
  const context = { head: 'h', branch: 'b', indexRevision: 'i', worktreeRevision: 'w', dirty: true, operation: null }
  expect(digest(captured)).not.toBe(digest(context))
  expect(digest(previewContextManifest.shape.source.parse(captured))).toBe(digest(context))
})
it('replays exactly the same Snapshot operation and rejects a different build', async () => {
  const operationId = randomUUID(), record = { operationId, sessionId: randomUUID(), state: 'FAILED', selection: { repositoryId: 'r', worktreeId: 'w', generation: 'g', profileId: 'p', fingerprint: 'a'.repeat(64) }, build: { buildId: 'b'.repeat(64), captureId: 'c'.repeat(64), runtimeId: 'd'.repeat(64) } }
  const store = { list: () => [record], read: () => record }
  const authority = { prepare: vi.fn() }
  const runner = new RuntimePreviewRunner(store as any, authority, {} as any)
  const request = { selection: record.selection, operationId, snapshot: { captureId: record.build.captureId, buildId: record.build.buildId } }
  expect(await runner.start(request)).toBe(record)
  expect(authority.prepare).not.toHaveBeenCalled()
  await expect(runner.start({ ...request, snapshot: { ...request.snapshot, buildId: 'e'.repeat(64) } })).rejects.toThrow('OPERATION_ID_CONFLICT')
})

it('does not report READY when the owned Channel rejects current liveness', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-stale-'))
  const sessionId = randomUUID(), buildId = 'b'.repeat(64), captureId = 'c'.repeat(64), runtimeId = 'd'.repeat(64), sha = 'e'.repeat(64)
  const snapshot = { buildId, captureId, runtimeId, manifest: { compatibility: { electron: '32.0.0', abi: '128' }, files: ['app/out/main/main.js', 'app/out/preload/preload.js', 'app/out/renderer/index.html'].map(path => ({ path, sha256: sha })) } }
  const context = { sessionId, selection: { repositoryId: 'r', worktreeId: 'w', generation: 'g' } }
  const adapter = new SnapshotAdapter(snapshot as any, context as any, directory)
  vi.spyOn(adapter, 'invokeChannel').mockResolvedValue({ result: { success: false, code: 'SESSION_STALE' } } as any)
  try {
    await writeFile(join(directory, 'snapshot-evidence.json'), JSON.stringify({ sessionId, buildId, captureId, runtimeId, pid: 42, rendererPid: 43, runtime: '32.0.0', abi: '128', mainDigest: sha, preloadDigest: sha, rendererDigest: sha, sandboxObserved: true, functionalAt: new Date().toISOString(), rendererFailure: null, contextBound: true }))
    const owner = { processes: async () => ({ processes: [{ pid: 42 }, { pid: 43 }] }) }
    await expect(adapter.observe(owner as any)).rejects.toThrow('SESSION_STALE')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('keeps cleanup retryable until the in-use bundle reference is released', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-release-')), at = new Date().toISOString()
  const store = new PreviewSessionStore(directory), sessionId = randomUUID()
  const record = { schemaVersion: 1, persistence: 'PERSISTED', sessionId, operationId: randomUUID(), selection: { repositoryId: 'r', worktreeId: 'w', generation: 'g', profileId: 'p', fingerprint: 'a'.repeat(64) }, profileRevision: 1, gitFingerprint: 'source', revision: 0, at, startedAt: at, endedAt: null, sourceSnapshot: null, state: 'RUNNING', reconciliation: 'NOT_REQUIRED', failure: null, resources: 'RESERVED', process: null, recoveryObservation: null, resourceInventory: [], coverage: [], readiness: 'READY', liveness: 'VERIFIED', attestation: { artifact: 'VERIFIED', loadedCode: 'VERIFIED' }, shutdown: { graceMs: 0, forceMs: 1000, graceful: false }, build: { captureId: 'c'.repeat(64), buildId: 'b'.repeat(64), runtimeId: 'd'.repeat(64) } }
  const release = vi.fn().mockRejectedValueOnce(Error('BUILD_STORE_BUSY')).mockResolvedValue(undefined)
  const owner = { inspect: async () => ({ rootSignaled: false }), stop: async () => ({ pid: 42, created: 'created', rootSignaled: true, knownHandlesClosed: true, activeProcesses: 0, jobClosed: true, eventClosed: true, assignedAtCreation: true, ownerOutsideJob: true, phase: 'DRAINED' }), shutdown: async () => {} }
  const runner = new RuntimePreviewRunner(store, {} as any, {} as any, undefined, { builds: { bundles: { release } } } as any)
  try {
    store.reserve(record as any)
    ;(runner as any).owners.set(sessionId, owner)
    expect(await runner.stop(sessionId)).toMatchObject({ state: 'CLEANUP_INCOMPLETE', resources: 'UNVERIFIABLE' })
    expect(store.active()).toBe(sessionId)
    expect(await runner.stop(sessionId)).toMatchObject({ state: 'STOPPED', resources: 'RELEASED' })
    expect(store.active()).toBeUndefined()
    expect(release).toHaveBeenCalledTimes(2)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
