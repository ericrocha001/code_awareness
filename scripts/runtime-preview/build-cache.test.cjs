const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { randomUUID } = require('node:crypto')
const root = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'preview-build-cache-'))
const bundle = path.join(root, 'cache.cjs')
require('esbuild').buildSync({ entryPoints: ['src/main/work-orchestration/runtime-preview/build-cache.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs' })
const { PreviewBuildCache } = require(bundle)
after(() => fs.rm(root, { recursive: true, force: true }))
async function fixture() {
  const base = path.join(root, randomUUID()), worktree = path.join(base, 'worktree'), directory = path.join(base, 'runtime'), cacheRoot = path.join(base, 'cache')
  const files = ['package.json', 'package-lock.json', 'electron.vite.config.ts', 'scripts/runtime-preview/launch.cjs', 'src/App.tsx',
    'node_modules/vite/package.json', 'node_modules/electron-vite/package.json', 'node_modules/esbuild/package.json',
    'node_modules/@vitejs/plugin-react/package.json', 'node_modules/@vitejs/plugin-react/dist/index.js', 'node_modules/esbuild/lib/main.js',
    'node_modules/vite/dist/node/index.js', 'node_modules/electron-vite/dist/index.mjs', 'node_modules/example/index.js']
  for (const file of files) { const target = path.join(worktree, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, file.endsWith('.json') ? '{}' : 'export const value = "A"\n') }
  await fs.mkdir(directory, { recursive: true })
  const selection = { repositoryId: 'repo', worktreeId: 'tree', generation: 'generation', profileId: 'code-awareness-tree', fingerprint: 'a'.repeat(64) }
  const profile = { profileId: selection.profileId, command: { inputs: [{ path: 'scripts/runtime-preview/launch.cjs' }, { path: 'electron.vite.config.ts' }] },
    dependencies: { manifest: 'package.json', lockfile: 'package-lock.json', abi: '128' }, runtimeVersion: '32', env: { PATH: 'approved' },
    adapter: { kind: 'ELECTRON', configFile: 'electron.vite.config.ts', nativeModules: ['esbuild'], artifacts: [{ component: 'ELECTRON_RENDERER', path: 'src/App.tsx' }] } }
  const forbidden = [randomUUID(), 'secret-token-' + randomUUID(), directory, 'http://127.0.0.1:54321']
  const prepare = async (dir = directory, changes = {}) => { await fs.mkdir(dir, { recursive: true }); return PreviewBuildCache.prepare(cacheRoot, worktree, dir, profile, selection, 'verified-installation', forbidden, changes.signal) }
  const materialize = async (dir = directory, injected = '') => {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'dependency-cache-policy.json'), JSON.stringify({ schemaVersion: 1, nativeOptimizer: true }))
    const deps = path.join(dir, 'vite-cache', 'deps'), source = path.join(worktree, 'node_modules/example/index.js')
    await fs.mkdir(deps, { recursive: true })
    const code = await fs.readFile(source, 'utf8'), relative = path.relative(deps, source).replaceAll('\\', '/')
    await fs.writeFile(path.join(deps, 'package.json'), '{"type":"module"}')
    await fs.writeFile(path.join(deps, 'example.js'), code + injected + '\n//# sourceMappingURL=example.js.map')
    await fs.writeFile(path.join(deps, 'example.js.map'), JSON.stringify({ version: 3, sources: [relative], sourcesContent: [code], mappings: '' }))
    await fs.writeFile(path.join(deps, '_metadata.json'), JSON.stringify({ hash: 'fixed', configHash: 'fixed', lockfileHash: 'fixed', browserHash: 'native-browser-hash',
      optimized: { example: { src: relative, file: 'example.js', fileHash: 'native-file-hash' } }, chunks: {} }))
  }
  return { base, worktree, directory, cacheRoot, selection, profile, forbidden, prepare, materialize }
}
test('retains only native dependency outputs and restores them in a fresh private session', async () => {
  const f = await fixture(), cold = await f.prepare()
  assert.equal(cold.receipt.status, 'MISS')
  await fs.mkdir(path.join(f.directory, 'userData'), { recursive: true })
  await fs.writeFile(path.join(f.directory, 'userData', 'continuum.db'), 'PRIVATE_ARTIFACT_CANARY')
  await f.materialize(); await cold.finish(true)
  assert.ok(cold.receipt.retainedBytes > 0, JSON.stringify(cold.receipt))
  const next = path.join(f.base, 'runtime-next'), warm = await f.prepare(next)
  assert.ok(warm.receipt.restoredBytes > 0, JSON.stringify(warm.receipt))
  await fs.writeFile(path.join(next, 'dependency-cache-policy.json'), JSON.stringify({ schemaVersion: 1, nativeOptimizer: true }))
  await warm.guard(); await warm.finish(true)
  assert.equal(warm.receipt.status, 'HIT')
  assert.equal(warm.receipt.mainPreload, 'RECOMPILED')
  const scan = async dir => { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await scan(file); else { const text = await fs.readFile(file, 'utf8'); assert.ok(!text.includes('PRIVATE_ARTIFACT_CANARY')); for (const secret of f.forbidden) assert.ok(!text.includes(secret)) } } }
  await scan(f.cacheRoot)
  await assert.rejects(fs.access(path.join(next, 'userData')))
})
test('revalidates dependency bytes without relying on HEAD, mtime or package version', async () => {
  const f = await fixture(), cold = await f.prepare(); await f.materialize(); await cold.finish(true)
  await fs.writeFile(path.join(f.worktree, 'node_modules/example/index.js'), 'export const value = "B"\n')
  const warm = await f.prepare(path.join(f.base, 'next'))
  assert.equal(warm.receipt.status, 'REJECTED'); assert.equal(warm.receipt.reasonCode, 'BUILD_CACHE_INPUT_CHANGED')
  assert.equal(warm.receipt.restoredBytes, 0)
  const initialKey = cold.receipt.key
  await fs.writeFile(path.join(f.worktree, 'electron.vite.config.ts'), 'changed config')
  assert.notEqual((await f.prepare(path.join(f.base, 'config-change'))).receipt.key, initialKey)
})
test('corrupt outputs rebuild safely and private or transformed outputs are never retained', async () => {
  const f = await fixture(), cache = await f.prepare(); await f.materialize(); await cache.finish(true)
  const partition = (await fs.readdir(f.cacheRoot))[0], entry = path.join(f.cacheRoot, partition, cache.receipt.key)
  await fs.writeFile(path.join(entry, 'data', 'example.js'), 'corrupt')
  const fallback = await f.prepare(path.join(f.base, 'next'))
  assert.equal(fallback.receipt.status, 'REJECTED'); assert.equal(fallback.receipt.restoredBytes, 0)
  await f.materialize(path.join(f.base, 'next'), f.forbidden[1]); await fallback.finish(true)
  assert.equal(fallback.receipt.reasonCode, 'BUILD_CACHE_PRIVATE_OUTPUT')
  await assert.rejects(fs.access(entry))
})
test('partitions Worktrees and generations and invalidates source and lockfile changes', async () => {
  const f = await fixture(), original = await f.prepare(); await f.materialize(); await original.finish(true)
  const other = await PreviewBuildCache.prepare(f.cacheRoot, f.worktree, path.join(f.base, 'other'), f.profile, { ...f.selection, generation: 'new' }, 'verified-installation', f.forbidden)
  assert.equal(other.receipt.restoredBytes, 0); assert.notEqual(other.receipt.key, original.receipt.key)
  const second = await fixture()
  const isolated = await PreviewBuildCache.prepare(f.cacheRoot, second.worktree, second.directory, second.profile, second.selection, 'verified-installation', second.forbidden)
  assert.notEqual(isolated.receipt.key, original.receipt.key); assert.equal(isolated.receipt.restoredBytes, 0)
  for (const file of ['src/App.tsx', 'package-lock.json', 'node_modules/vite/package.json', 'node_modules/@vitejs/plugin-react/dist/index.js']) {
    await fs.writeFile(path.join(f.worktree, file), randomUUID())
    assert.notEqual((await f.prepare(path.join(f.base, randomUUID()))).receipt.key, original.receipt.key)
  }
})

test('requires fresh native optimizer evidence and refuses custom optimizer outputs', async () => {
  const f = await fixture(), cache = await f.prepare(); await f.materialize()
  await fs.writeFile(path.join(f.directory, 'dependency-cache-policy.json'), JSON.stringify({ schemaVersion: 1, nativeOptimizer: false }))
  await cache.finish(true)
  assert.equal(cache.receipt.reasonCode, 'BUILD_CACHE_CUSTOM_OPTIMIZER'); assert.equal(cache.receipt.retainedBytes, 0)
})

test('proves virtual original sources against distributed package maps and their JavaScript bytes', async () => {
  const f = await fixture(), cache = await f.prepare(); await f.materialize()
  const original = 'export const original: string = "public package source"', file = path.join(f.worktree, 'node_modules/example/index.js.map')
  await fs.writeFile(file, JSON.stringify({ version: 3, sources: ['src/original.ts'], sourcesContent: [original] }))
  const virtual = path.join(f.worktree, 'node_modules/example/src/original.ts'), deps = path.join(f.directory, 'vite-cache/deps')
  await fs.writeFile(path.join(deps, 'example.js.map'), JSON.stringify({ version: 3, sources: [path.relative(deps, virtual)], sourcesContent: [original] }))
  await cache.finish(true); assert.ok(cache.receipt.retainedBytes > 0, JSON.stringify(cache.receipt))
  const warm = await f.prepare(path.join(f.base, 'next')); assert.ok(warm.receipt.restoredBytes > 0)
  await fs.writeFile(path.join(f.worktree, 'node_modules/example/index.js'), 'changed while preserving package map')
  await assert.rejects(warm.guard(), /BUILD_CACHE_INPUT_CHANGED/)
})

test('isolates two physical Git Worktrees of the same repository', async () => {
  const f = await fixture(), git = require('node:util').promisify(require('node:child_process').execFile)
  const run = (...args) => git('git', ['-C', f.worktree, ...args], { windowsHide: true })
  await run('init'); await fs.writeFile(path.join(f.worktree, 'tracked.txt'), 'fixture')
  await run('add', 'tracked.txt'); await run('-c', 'user.name=Preview Fixture', '-c', 'user.email=preview@example.invalid', 'commit', '-m', 'fixture')
  const peer = path.join(f.base, 'peer'); await run('worktree', 'add', '--detach', peer, 'HEAD')
  for (const entry of await fs.readdir(f.worktree)) if (entry !== '.git') await fs.cp(path.join(f.worktree, entry), path.join(peer, entry), { recursive: true })
  assert.equal((await run('rev-parse', '--path-format=absolute', '--git-common-dir')).stdout.trim(),
    (await git('git', ['-C', peer, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { windowsHide: true })).stdout.trim())
  const cold = await f.prepare(); await f.materialize(); await cold.finish(true)
  const selection = { ...f.selection, worktreeId: 'peer', profileId: 'code-awareness-peer' }
  const cache = await PreviewBuildCache.prepare(f.cacheRoot, peer, path.join(f.base, 'peer-runtime'), { ...f.profile, profileId: selection.profileId }, selection, 'verified-installation', f.forbidden)
  assert.equal(cache.receipt.restoredBytes, 0); assert.notEqual(cache.receipt.key, cold.receipt.key)
})

test('bounds retained entries and removes corrupt siblings without discarding a valid publication', async () => {
  const f = await fixture()
  const corrupt = path.join(f.cacheRoot, '0'.repeat(64), '1'.repeat(64))
  await fs.mkdir(corrupt, { recursive: true }); await fs.writeFile(path.join(corrupt, 'entry.json'), 'invalid')
  for (let index = 0; index < 10; index++) {
    const directory = path.join(f.base, 'retention-' + index); await fs.mkdir(directory)
    const cache = await PreviewBuildCache.prepare(f.cacheRoot, f.worktree, directory, f.profile, { ...f.selection, generation: 'generation-' + index }, 'verified-installation', f.forbidden)
    await f.materialize(directory); await cache.finish(true)
    assert.ok(cache.receipt.retainedBytes > 0, JSON.stringify(cache.receipt))
  }
  await assert.rejects(fs.access(corrupt))
  const partitions = await fs.readdir(f.cacheRoot); assert.ok(partitions.length <= 8)
  let entries = 0
  for (const partition of partitions) entries += (await fs.readdir(path.join(f.cacheRoot, partition))).length
  assert.equal(entries, 8)
})
test('rejects drift at consumption, aborts without publication and refuses linked cache roots', async () => {
  const f = await fixture(), original = await f.prepare(); await f.materialize(); await original.finish(true)
  const warm = await f.prepare(path.join(f.base, 'next'))
  await fs.writeFile(path.join(f.worktree, 'node_modules/example/index.js'), 'changed')
  await assert.rejects(warm.guard(), /BUILD_CACHE_INPUT_CHANGED/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(f.prepare(path.join(f.base, 'cancelled'), { signal: controller.signal }))
  const external = path.join(f.base, 'external'), linked = path.join(f.base, 'linked'); await fs.mkdir(external)
  await fs.writeFile(path.join(external, 'sentinel'), 'preserved'); await fs.symlink(external, linked, 'junction')
  const rejected = await PreviewBuildCache.prepare(linked, f.worktree, path.join(f.base, 'link-session'), f.profile, f.selection, 'basis', f.forbidden)
  assert.equal(rejected.receipt.status, 'REJECTED'); assert.equal(await fs.readFile(path.join(external, 'sentinel'), 'utf8'), 'preserved')
})
