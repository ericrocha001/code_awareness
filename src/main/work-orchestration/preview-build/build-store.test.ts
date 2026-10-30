import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PreviewBuildStore } from './build-store'
import type { BuildCapture, PreviewCaptureStore } from './capture'
import type { BuildToolchain, PreviewBuildToolchains } from './toolchain'
import { snapshot, tree } from './files'
import * as files from './files'
import { randomUUID } from 'node:crypto'
import { RuntimePreviewRunner } from '../runtime-preview/runner'
import { PreviewSessionStore } from '../runtime-preview/session-store'
import { bytesFingerprint, previewFingerprint } from '../preview-profile'
import type { compileElectronBundle } from './electron-build'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true }) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'pvo-build-store-test-')); roots.push(root)
  const capture = { captureId: 'a'.repeat(64), toolchainId: 'b'.repeat(64), runtimeId: 'c'.repeat(64), source: { head: 'head', branch: 'feature', indexRevision: 'index', worktreeRevision: 'source', dirty: true } } as BuildCapture
  const captured = { get: vi.fn(async () => capture), source: vi.fn(() => join(root, 'frozen')) }
  const runtime = { runtimeId: capture.runtimeId, electron: '32.0.0', abi: '128', platform: 'win32', arch: 'x64' }
  const tools = { get: vi.fn(async () => ({ runtime }) as BuildToolchain) }
  const approve = vi.fn(async () => true)
  const compile = vi.fn< typeof compileElectronBundle >(async (_capture, _source, _toolchain, _tools, work) => {
    const bundle = join(work, 'bundle')
    for (const path of ['app/package.json', 'app/out/main/main.js', 'app/out/preload/preload.js', 'app/out/renderer/index.html', 'app/out/renderer/assets/main.js', 'app/node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'resources/runtime-preview/preview-owner.exe', 'resources/local-mcp/launcher.cjs']) {
      await mkdir(dirname(join(bundle, path)), { recursive: true }); await writeFile(join(bundle, path), 'controlled fixture bytes')
    }
    return { files: await snapshot(bundle, await tree(bundle)), compatibility: { electron: runtime.electron, abi: runtime.abi, platform: runtime.platform, arch: runtime.arch, node: '20.16.0', buildNode: '24.18.0', nativeModules: ['better-sqlite3'] } }
  })
  const store = new PreviewBuildStore(join(root, 'store'), captured as unknown as PreviewCaptureStore, tools as unknown as PreviewBuildToolchains, approve, compile)
  return { root, store, capture, captured, tools, approve, compile }
}
it('reuses the verified bundle without source or toolchain traversal and preserves content identities', async () => {
  const f = await setup(), first = await f.store.prepare(f.capture.captureId)
  expect(first.reused).toBe(false)
  f.captured.source.mockImplementation(() => { throw Error('WORKTREE_MUST_NOT_BE_READ_ON_HIT') })
  const next = await f.store.prepare(f.capture.captureId)
  expect(next.buildId).toBe(first.buildId); expect(next.reused).toBe(true)
  expect(f.compile).toHaveBeenCalledTimes(1); expect(f.approve).toHaveBeenCalledTimes(1); expect(f.tools.get).toHaveBeenCalledTimes(1)
  const bytes = await readFile(join(first.directory, 'app/out/main/main.js'))
  expect(bytes.toString()).toBe('controlled fixture bytes')
  await writeFile(join(first.directory, 'app/out/main/main.js'), 'corruption')
  await expect(f.store.prepare(f.capture.captureId)).rejects.toThrow('BUILD_INTEGRITY_FAILED')
  expect(f.compile).toHaveBeenCalledTimes(1)
})

it('selects metadata without hashing and admits exactly once under the prune lock with a session lease', async () => {
  const f = await setup(), built = await f.store.prepare(f.capture.captureId), original = files.verify, verify = vi.spyOn(files, 'verify')
  const selected = await f.store.readManifest(built.buildId), sessionId = randomUUID()
  expect(verify).not.toHaveBeenCalled()
  let enter!: () => void, finish!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), barrier = new Promise<void>(resolve => { finish = resolve })
  verify.mockImplementationOnce(async (...args) => { enter(); await barrier; return original(...args) })
  const acquired = f.store.acquire(selected, sessionId)
  await entered
  try { await expect(f.store.prune(0)).rejects.toThrow('BUILD_STORE_BUSY') } finally { finish() }
  expect(await acquired).toEqual(selected)
  expect(verify).toHaveBeenCalledTimes(1)
  expect(JSON.parse(await readFile(join(f.store.root, 'references', built.buildId, sessionId + '.json'), 'utf8'))).toEqual({ buildId: built.buildId, referenceId: sessionId })
  await expect(f.store.acquire(selected, sessionId)).rejects.toThrow('BUILD_REFERENCE_EXISTS')
  expect(await f.store.prune(0)).toEqual({ removed: [], retained: 1 })
  await f.store.release(built.buildId, sessionId)
  expect(await f.store.prune(0)).toEqual({ removed: [built.buildId], retained: 0 })
})

it.each(['bytes', 'manifest', 'malformed', 'removed', 'selection'])('refuses %s changed between metadata selection and acquisition without retaining it', async fault => {
  const f = await setup(), built = await f.store.prepare(f.capture.captureId), selected = await f.store.readManifest(built.buildId), sessionId = randomUUID()
  if (fault === 'bytes') await writeFile(join(built.directory, 'app/out/main/main.js'), 'tampered after PREPARE')
  if (fault === 'manifest') await writeFile(join(f.store.root, 'bundle-' + built.buildId, 'manifest.json'), JSON.stringify({ ...selected, runtimeId: 'f'.repeat(64) }))
  if (fault === 'malformed') await writeFile(join(f.store.root, 'bundle-' + built.buildId, 'manifest.json'), '{invalid json')
  if (fault === 'removed') await f.store.prune(0)
  if (fault === 'selection') selected.captureId = 'f'.repeat(64)
  await expect(f.store.acquire(selected, sessionId)).rejects.toThrow(fault === 'removed' ? 'BUILD_SELECTION_UNAVAILABLE' : fault === 'selection' ? 'BUILD_SELECTION_CHANGED' : 'BUILD_INTEGRITY_FAILED')
  expect(await readdir(join(f.store.root, 'references', built.buildId)).catch(() => [])).toEqual([])
  expect(await readdir(f.store.root)).not.toContain('store.lock')
})

it.each(['stop', 'crash', 'tamper', 'guard'])('integrates one Host verification with START and %s cleanup', async fault => {
  const f = await setup(), built = await f.store.prepare(f.capture.captureId), manifest = await f.store.readManifest(built.buildId)
  const store = new PreviewSessionStore(join(f.root, 'sessions'))
  const worktree = join(f.root, 'checkout'); await mkdir(worktree)
  const profile = { profileId: 'profile', repositoryId: 'repo', revision: 1, runtime: 'ELECTRON_DEV', env: {}, resources: [],
    command: { executable: process.execPath, executableHash: bytesFingerprint(await readFile(process.execPath)), cwd: '.', args: [], inputs: [] },
    security: { mode: 'profile_only', requirements: [] }, shutdown: { spawn: 'JOB_LIST_AT_CREATE', graceMs: 0, forceMs: 1000 } }
  const selection = { repositoryId: 'repo', worktreeId: 'tree', generation: 'generation', profileId: profile.profileId, fingerprint: previewFingerprint(profile) }
  const snapshot = { buildId: built.buildId, captureId: built.captureId, runtimeId: built.runtimeId, manifest, executable: process.execPath, executableHash: profile.command.executableHash, bundle: built.directory }
  const guard = vi.fn(async () => {})
  const prepare = vi.fn(async () => {
    if (fault === 'tamper') await writeFile(join(built.directory, 'app/out/main/main.js'), 'changed after selection')
    return { profile, worktree, gitFingerprint: 'source', preflight: { selection, status: 'SUPPORTED', profileRevision: 1 }, guard, snapshot }
  })
  const live = { pid: 42, created: '123', rootSignaled: false, knownHandlesClosed: false, activeProcesses: 1, jobClosed: false, eventClosed: false, assignedAtCreation: true, ownerOutsideJob: true, phase: 'RUNNING' }
  const drained = { ...live, rootSignaled: true, knownHandlesClosed: true, activeProcesses: 0, jobClosed: true, eventClosed: true, phase: 'DRAINED' }
  const owner = { start: vi.fn(async () => live), inspect: vi.fn(async () => fault === 'crash' ? drained : live), stop: vi.fn(async () => drained), shutdown: vi.fn(async () => {}) }
  const runner = new RuntimePreviewRunner(store, {} as any, {} as any, undefined, { prepare, builds: { bundles: f.store } } as any)
  vi.spyOn(runner as any, 'owner').mockImplementation(async () => { if (fault === 'guard') guard.mockRejectedValue(Error('WORKTREE_STALE')); return owner })
  const verify = vi.spyOn(files, 'verify'), acquire = vi.spyOn(f.store, 'acquire'), operationId = randomUUID()
  const request = { selection, operationId, snapshot: { captureId: built.captureId, buildId: built.buildId } }
  const result = await runner.start(request)
  expect(verify).toHaveBeenCalledTimes(1)
  expect(acquire).toHaveBeenCalledWith(manifest, result.sessionId)
  if (fault === 'tamper' || fault === 'guard') {
    expect(result).toMatchObject({ state: 'FAILED', resources: 'RELEASED', readiness: 'NOT_OBSERVED', failure: fault === 'tamper' ? 'BUILD_INTEGRITY_FAILED' : 'WORKTREE_STALE' })
    expect(owner.start).not.toHaveBeenCalled()
  } else {
    expect(result.state).toBe('RUNNING')
    expect(owner.start).toHaveBeenCalledOnce()
    expect((await runner.start(request)).sessionId).toBe(result.sessionId)
    expect(acquire).toHaveBeenCalledOnce()
    const terminal = fault === 'crash' ? await runner.inspect(result.sessionId) : await runner.stop(result.sessionId)
    expect(terminal).toMatchObject({ state: fault === 'crash' ? 'FAILED' : 'STOPPED', resources: 'RELEASED' })
  }
  expect(await readdir(join(f.store.root, 'references', built.buildId)).catch(() => [])).toEqual([])
  expect(store.active()).toBeUndefined()
})
it('cannot execute before approval and rejects incomplete or ABI-incompatible artifacts', async () => {
  const f = await setup(); f.approve.mockResolvedValueOnce(false)
  await expect(f.store.prepare(f.capture.captureId)).rejects.toThrow('BUILD_APPROVAL_REQUIRED')
  expect(f.compile).not.toHaveBeenCalled()
  const original = f.compile.getMockImplementation()!
  f.compile.mockImplementationOnce(async (...args) => { const result = await original(...args); result.compatibility.abi = '999'; return result })
  await expect(f.store.prepare(f.capture.captureId)).rejects.toThrow('BUILD_RUNTIME_INCOMPATIBLE')
  f.compile.mockImplementationOnce(async (...args) => { const result = await original(...args); result.files = result.files.filter(file => !file.path.endsWith('.node')); return result })
  await expect(f.store.prepare(f.capture.captureId)).rejects.toThrow('BUILD_BUNDLE_INCOMPLETE')
  expect((await readdir(f.store.root)).filter(name => /^(bundle|partial|publish)-/.test(name))).toEqual([])
})
it('serializes publication across store instances, hides partial output, and never prunes referenced bundles', async () => {
  const f = await setup(), original = f.compile.getMockImplementation()!
  let enter!: () => void, finish!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), barrier = new Promise<void>(resolve => { finish = resolve })
  f.compile.mockImplementationOnce(async (...args) => { enter(); await barrier; return original(...args) })
  const first = f.store.prepare(f.capture.captureId); await entered
  const other = new PreviewBuildStore(f.store.root, f.captured as unknown as PreviewCaptureStore, f.tools as unknown as PreviewBuildToolchains, f.approve, f.compile)
  await expect(other.prepare(f.capture.captureId)).rejects.toThrow('BUILD_STORE_BUSY')
  expect((await readdir(f.store.root)).some(name => name.startsWith('bundle-'))).toBe(false)
  finish(); const result = await first
  const lease = await f.store.retain(result.buildId)
  expect(await other.prune(0)).toEqual({ removed: [], retained: 1 })
  await other.release(result.buildId, lease)
  expect(await f.store.prune(0)).toEqual({ removed: [result.buildId], retained: 0 })
  await expect(other.read(result.buildId)).rejects.toMatchObject({ code: 'ENOENT' })
})
