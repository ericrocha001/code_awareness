import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PreviewCaptureStore, type CaptureBasis } from './capture'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true }) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'pvo-capture-test-')); roots.push(root)
  const checkout = join(root, 'checkout'); await mkdir(checkout)
  for (const file of ['package.json', 'package-lock.json', 'electron.vite.config.ts', 'scripts/native-bundle-guard.cjs', 'src/main/bootstrap.ts', 'src/main/preload.ts', 'src/renderer/index.html']) {
    await mkdir(dirname(join(checkout, file)), { recursive: true }); await writeFile(join(checkout, file), file)
  }
  await writeFile(join(checkout, '.env'), 'PRIVATE_VALUE')
  await mkdir(join(checkout, 'node_modules')); await writeFile(join(checkout, 'node_modules/dependency'), 'excluded')
  const basis = { selection: { repositoryId: 'repo', worktreeId: 'tree', generation: 'generation', profileId: 'profile', fingerprint: 'a'.repeat(64) },
    source: { head: 'head', branch: 'feature', indexRevision: 'index', worktreeRevision: 'working', dirty: false }, profile: { revision: 1 } } as CaptureBasis
  const store = new PreviewCaptureStore(join(root, 'captures')), toolchain = { toolchainId: 'toolchain', runtimeId: 'runtime' }
  return { root, checkout, basis, store, toolchain }
}
it('freezes relevant dirty bytes, HEAD/index/profile/toolchain identity and never captures private data or node_modules', async () => {
  const f = await setup(), observe = async () => structuredClone(f.basis)
  const first = await f.store.capture(f.checkout, observe, f.toolchain, true)
  expect(first.files.some(file => /PRIVATE|node_modules|\.env/.test(file.path))).toBe(false)
  await writeFile(join(f.checkout, 'src/main/bootstrap.ts'), 'dirty source')
  expect((await f.store.get(first.captureId)).captureId).toBe(first.captureId)
  expect(await readFile(join(f.store.source(first.captureId), 'src/main/bootstrap.ts'), 'utf8')).toBe('src/main/bootstrap.ts')
  const second = await f.store.capture(f.checkout, observe, f.toolchain, true)
  expect(second.captureId).not.toBe(first.captureId)
  expect(await readFile(join(f.checkout, 'src/main/bootstrap.ts'), 'utf8')).toBe('dirty source')
  f.basis.source.indexRevision = 'new-index'
  expect((await f.store.capture(f.checkout, observe, f.toolchain, true)).captureId).not.toBe(second.captureId)
})
it('refuses dirty, detached and changing captures, and detects post-publication corruption', async () => {
  const f = await setup()
  f.basis.source.dirty = true
  await expect(f.store.capture(f.checkout, async () => f.basis, f.toolchain, false)).rejects.toThrow('CAPTURE_DIRTY_REJECTED')
  f.basis.source.branch = null
  await expect(f.store.capture(f.checkout, async () => f.basis, f.toolchain, true)).rejects.toThrow('CAPTURE_HEAD_REJECTED')
  f.basis.source.branch = 'feature'
  let calls = 0
  await expect(f.store.capture(f.checkout, async () => { if (++calls === 2) await writeFile(join(f.checkout, 'src/main/bootstrap.ts'), 'changed during capture'); return f.basis }, f.toolchain, true)).rejects.toThrow('CAPTURE_SOURCE_CHANGED')
  expect(await readdir(f.store.root)).toEqual([])
  const capture = await f.store.capture(f.checkout, async () => f.basis, f.toolchain, true)
  await writeFile(join(f.store.source(capture.captureId), 'src/main/bootstrap.ts'), 'tampered')
  await expect(f.store.get(capture.captureId)).rejects.toThrow('BUILD_INTEGRITY_FAILED')
})
