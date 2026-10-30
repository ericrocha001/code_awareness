import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PreviewBuildStore } from './build-store'
import type { BuildCapture, PreviewCaptureStore } from './capture'
import type { BuildToolchain, PreviewBuildToolchains } from './toolchain'
import { snapshot, tree } from './files'
import type { compileElectronBundle } from './electron-build'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true }) })
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
    return { files: await snapshot(bundle, await tree(bundle)), compatibility: { ...runtime, node: '20.16.0', buildNode: '24.18.0', nativeModules: ['better-sqlite3'] } }
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
