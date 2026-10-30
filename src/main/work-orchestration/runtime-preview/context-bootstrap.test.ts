import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PreviewCaptureStore } from '../preview-build/capture'
import { digest, hash, snapshot, tree } from '../preview-build/files'
import * as buildFiles from '../preview-build/files'
import { previewProfileSchema, previewFingerprint } from '../preview-profile'
import { previewContextManifest } from './context-contract'
import { previewCatalogPath } from './context-data'
import { normalizeRepositoryPath } from '../../repository-catalog/repository-catalog-service'
import { validatePreviewContext } from './context-bootstrap'
import { initializeElectronPreview } from './electron-mode'

const catalog = vi.hoisted(() => ({ rows: [] as Record<string, string>[], valid: true, closed: false }))
vi.mock('better-sqlite3', () => ({ default: class {
  prepare(sql: string) { return { all: () => catalog.rows, get: () => ({ n: sql.includes('github_links') ? 0 : 1 }) } }
  pragma() { return catalog.valid ? 'ok' : 'corrupt' }
  close() { catalog.closed = true }
} }))
vi.mock('electron', () => ({ BrowserWindow: {}, ipcMain: { on: vi.fn() } }))

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pvo-bootstrap-')); roots.push(root)
  const worktree = realpathSync(process.cwd()), directory = join(root, 'runtime'), userData = join(directory, 'userData'), store = join(root, 'captures')
  await mkdir(userData, { recursive: true })
  const sha = 'a'.repeat(64)
  const profile = previewProfileSchema.parse({ schemaVersion: 1, profileId: 'snapshot', revision: 1, repositoryId: 'repo', runtime: 'ELECTRON_DEV', runtimeVersion: '32.0.0',
    command: { executable: process.execPath, executableHash: sha, args: [], cwd: '.', inputs: [{ path: 'package.json', fingerprint: sha }] }, env: {}, resources: [{ name: 'data', strategy: 'SESSION_DIRECTORY' }],
    dependencies: { packageManager: 'npm', packageManagerVersion: '10.9.4', manifest: 'package.json', lockfile: 'package-lock.json', manifestHash: sha, lockfileHash: sha, abi: '128', materialization: 'installed.json' },
    cooperation: { manifest: 'preview.json', fingerprint: sha }, security: { mode: 'profile_only', requirements: [] },
    network: { destinations: [], openNetworkConsent: false, credentials: 'TARGET_OWN_TEST_PROFILE' },
    probes: { readiness: { kind: 'COOPERATIVE_IPC', address: 'preview', timeoutMs: 1000 }, liveness: 'COOPERATIVE_IPC', attestation: 'COOPERATIVE_LOADED_ARTIFACT' },
    shutdown: { spawn: 'JOB_LIST_AT_CREATE', breakaway: false, killOnJobClose: true, graceMs: 0, forceMs: 1000 },
    bootstrap: { kind: 'CODE_AWARENESS', dataPolicy: 'ARTIFACT_FIRST', maxBytes: 1048576, maxArtifacts: 1 },
    adapter: { version: 1, kind: 'ELECTRON', port: 5678, configFile: 'preview.cjs', nativeModules: [], artifacts: [{ component: 'ELECTRON_MAIN', path: 'out/main/main.js' }] } })
  const selection = { repositoryId: 'repo', worktreeId: 'tree', generation: 'generation', profileId: profile.profileId, fingerprint: previewFingerprint(profile) }
  const source = { head: 'captured-head', branch: 'feature', operation: null, indexRevision: 'index', worktreeRevision: 'files', dirty: true }
  const bytes = Buffer.from('captured source'), files = [{ path: 'main.ts', bytes: bytes.length, sha256: hash(bytes) }]
  const basis = { version: 1, selection, profile, source, toolchainId: sha, runtimeId: sha, files }, captureId = digest(basis), sourceDirectory = join(store, captureId, 'source')
  await mkdir(sourceDirectory, { recursive: true }); await writeFile(join(sourceDirectory, 'main.ts'), bytes)
  await writeFile(join(store, captureId, 'capture.json'), JSON.stringify({ ...basis, captureId }))
  const catalogFile = previewCatalogPath(userData); await mkdir(join(catalogFile, '..'), { recursive: true }); await writeFile(catalogFile, 'controlled catalog')
  catalog.rows = [{ id: 'repo', checkout_path: worktree, normalized_checkout_path: normalizeRepositoryPath(worktree), status: 'ACTIVE', availability: 'AVAILABLE', git_state: 'GIT' }]
  catalog.valid = true; catalog.closed = false
  const selected = { captureId, buildId: 'b'.repeat(64), runtimeId: sha, sourceDirectory }
  const context = previewContextManifest.parse({ version: 1, mode: 'PREVIEW', sessionId: randomUUID(), selection, profileRevision: 1, worktree, source, policy: profile.bootstrap,
    data: { policy: 'ARTIFACT_FIRST', repositoryId: 'repo', origin: 'HOST_CANONICAL_REFERENCE', at: new Date().toISOString(), schema: null, digest: null, bytes: 0, artifacts: 0, media: 0 }, catalogDigest: hash(Buffer.from('controlled catalog')), snapshot: selected })
  const get = vi.spyOn(PreviewCaptureStore.prototype, 'get'), input = { sessionId: context.sessionId, profile: selection.fingerprint, approvedProfile: profile, directory, worktree, snapshot: selected as any }
  return { root, directory, worktree, context, input, sourceDirectory, catalogFile, get }
}

it('validates captured bytes once after the private catalog, without consulting mutable Git', async () => {
  const original = PreviewCaptureStore.prototype.get, f = await fixture()
  const verify = vi.spyOn(buildFiles, 'verify')
  f.get.mockImplementation(async function (this: PreviewCaptureStore, id) { expect(catalog.closed).toBe(true); return original.call(this, id) })
  expect(await validatePreviewContext(f.context, f.input)).toEqual(f.context)
  expect(f.get).toHaveBeenCalledExactlyOnceWith(f.context.snapshot!.captureId)
  expect(verify).toHaveBeenCalledExactlyOnceWith(f.sourceDirectory, expect.any(Array))
})

it.each(['bytes', 'catalog-bytes', 'catalog-identity', 'catalog-invalid', 'missing', 'selection', 'source', 'build', 'no-snapshot'])('refuses inconsistent %s before accepting bootstrap context', async fault => {
  const f = await fixture()
  if (fault === 'bytes') await writeFile(join(f.sourceDirectory, 'main.ts'), 'tampered')
  if (fault === 'catalog-bytes') await writeFile(f.catalogFile, 'tampered')
  if (fault === 'catalog-identity') catalog.rows[0].id = 'wrong'
  if (fault === 'catalog-invalid') catalog.valid = false
  if (fault === 'missing') await rm(join(f.sourceDirectory, '../capture.json'))
  if (fault === 'selection') f.context.selection.generation = 'wrong'
  if (fault === 'source') f.context.source.head = 'wrong'
  if (fault === 'build') f.context.snapshot!.buildId = 'f'.repeat(64)
  if (fault === 'no-snapshot') delete f.input.snapshot
  await expect(validatePreviewContext(f.context, f.input)).rejects.toThrow(/^PREVIEW_/)
  expect(f.get.mock.calls.length).toBeLessThanOrEqual(1)
  if (fault.startsWith('catalog-')) expect(f.get).not.toHaveBeenCalled()
})

it('independently rejects a bundle changed after Host admission before bootstrap can return to the main import', async () => {
  const f = await fixture(), bundle = join(f.root, 'bundle'), appRoot = join(bundle, 'app')
  await mkdir(appRoot, { recursive: true }); await writeFile(join(appRoot, 'main.js'), 'verified bundle')
  const files = await snapshot(bundle, await tree(bundle))
  await writeFile(join(appRoot, 'main.js'), 'tampered after Host admission')
  const configFile = join(f.directory, 'configuration.json')
  await writeFile(configFile, JSON.stringify({ sessionId: f.context.sessionId, kind: 'ELECTRON', mode: 'SNAPSHOT', directory: f.directory, worktree: f.worktree,
    profile: f.input.profile, context: f.context, approvedProfile: f.input.approvedProfile, channelToken: 'test-only', snapshot: { ...f.input.snapshot, bundle, manifest: { files } } }))
  vi.stubEnv('PREVIEW_SESSION_CONFIG', configFile); vi.stubEnv('PREVIEW_SESSION_DIRECTORY', f.directory); vi.stubEnv('PREVIEW_SESSION_ID', f.context.sessionId)
  const paths = new Map<string, string>()
  const app = { setPath: (key: string, path: string) => paths.set(key, path), getPath: (key: string) => paths.get(key), setName() {}, commandLine: { appendSwitch() {} }, enableSandbox() {}, on() {}, getAppPath: () => appRoot }
  await expect(initializeElectronPreview(app as any)).rejects.toThrow('BUILD_INTEGRITY_FAILED')
  expect(f.get).toHaveBeenCalledOnce()
})
