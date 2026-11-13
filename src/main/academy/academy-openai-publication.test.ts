import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cpSync } from 'node:fs'
import { AcademyGitSyncService } from './git/academy-git-sync-service'
import { AcademyGitMaterializer } from './git/academy-git-materializer'
import { GitService } from '../core/git-service'
import { gitExec, writeFile } from '../core/git-test-helpers'
import type { RepositoryRecord } from '../../shared/types/repository-catalog-types'
import { AcademyService } from './academy-service'
import { AcademyStore } from './academy-store'
import { readZipEntries, createDeterministicZip } from './publication/deterministic-zip'
import { calculateOpenAiDelta, hashOpenAiSnapshot, nextOpenAiPluginVersion, sha256 } from './publication/openai-plugin-model'
import { validateOpenAiPluginPackage } from './publication/openai-plugin-validator'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch {} })

const skillMd = (name: string, body = 'v1') => `---\nname: ${name}\ndescription: Use ${name}.\n---\n\n# ${name}\n\n${body}\n`

function png(width = 512, height = 512): Buffer {
  const value = Buffer.alloc(24)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(value)
  value.writeUInt32BE(width, 16); value.writeUInt32BE(height, 20)
  return value
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'academy-openai-')); roots.push(root)
  const workerPath = join(root, 'academy-plugin-worker.cjs')
  buildSync({ entryPoints: ['src/main/academy/publication/academy-plugin-worker.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: workerPath })
  const service = new AcademyService(join(root, 'academy', 'academy.db'), join(root, 'Downloads'), 2000, workerPath)
  const global = await service.create({ package: { skillMd: skillMd('global-skill'), artifacts: { 'references/guide.md': 'guide' } }, scope: 'GLOBAL', origin: 'UI' })
  service.store.approvePublicSkill(global.id, global.currentVersion)
  const project = await service.create({ package: { skillMd: skillMd('project-skill'), artifacts: {} }, scope: 'PROJECT', origin: 'UI' })
  const archived = await service.create({ package: { skillMd: skillMd('archived-skill'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
  await service.archive(archived.id, archived.currentVersion)
  const plugin = join(root, 'installed', 'academy-skills')
  mkdirSync(join(plugin, 'assets'), { recursive: true })
  mkdirSync(join(plugin, 'skills', 'global-skill', 'references'), { recursive: true })
  writeFileSync(join(plugin, 'assets', 'logo.png'), png())
  writeFileSync(join(plugin, 'skills', 'global-skill', 'SKILL.md'), global.current.package.skillMd)
  writeFileSync(join(plugin, 'skills', 'global-skill', 'references', 'guide.md'), 'guide')
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'academy-skills', version: '0.1.3',
    description: 'Academy Skills', author: { name: 'Academy' }, extensions: { 'com.openai': { interface: {
      displayName: 'Academy Skills', shortDescription: 'Academy', longDescription: 'Academy Skills', developerName: 'Academy',
      category: 'Productivity', capabilities: ['Interactive'], defaultPrompt: ['One', 'Two'], composerIcon: './assets/logo.png', logo: './assets/logo.png'
    } } }
  }))
  await service.bootstrapOpenAiPlugin(plugin)
  return { root, service, global, project, archived }
}

async function gitFixture() {
  const f = await fixture()
  const remote = join(f.root, 'remote.git'), human = join(f.root, 'human')
  await gitExec(f.root, ['init', '--bare', remote])
  await gitExec(f.root, ['clone', remote, human])
  await gitExec(human, ['switch', '-c', 'main'])
  await gitExec(human, ['config', 'user.name', 'Release Proof'])
  await gitExec(human, ['config', 'user.email', 'proof@example.com'])
  cpSync(join(f.root, 'installed', 'academy-skills'), human, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(human, 'plugin.json'), 'utf8'))
  manifest.version = '0.2.0'
  writeFile(human, 'plugin.json', JSON.stringify(manifest))
  const commit = async (message: string, push = true) => {
    await gitExec(human, ['add', '--', 'plugin.json', 'assets'])
    if (existsSync(join(human, 'skills'))) await gitExec(human, ['add', '--', 'skills'])
    await gitExec(human, ['commit', '-m', message])
    if (push) await gitExec(human, ['push', '-u', 'origin', 'main'])
    return new GitService().resolveCommit(human, 'HEAD')
  }
  await commit('published baseline')
  const git = new GitService()
  const transport = {
    fetch: (path: string, origin: string) => git.fetchRemote(path, origin),
    readRemoteHead: (path: string, origin: string, ref: string) => git.readRemoteHead(path, origin, ref),
    push: (path: string, branch: string, origin = 'origin', head?: string) => git.push(path, origin, branch, head)
  }
  const record = { id: 'release-destination', name: 'Academy', status: 'ACTIVE', localCheckout: { path: human, availability: 'AVAILABLE', gitState: 'GIT' },
    github: { repositoryId: 'release-github', fullName: 'proof/academy', cloneUrl: remote, visibility: 'PRIVATE' } } as RepositoryRecord
  const sync = new AcademyGitSyncService(f.service.store, new AcademyGitMaterializer(), git, transport,
    { resolveRepository: () => record, findByGitHubId: () => record, listEligibleRepositories: () => [record] })
  f.service.initializeGitSync(sync)
  expect((await sync.bindRepository(record.id)).syncState).toBe('SYNCED')
  const bump = (version: string) => { manifest.version = version; writeFile(human, 'plugin.json', JSON.stringify(manifest)) }
  return { ...f, git, sync, transport, human, commit, bump, manifest, record }
}

describe('Academy Git-pinned plugin publication', () => {
  it('builds sealed local releases offline with one candidate and an unsigned in-toto statement', async () => {
    const f = await gitFixture()
    try {
      await f.sync.saveDraft({ skillId: f.global.id, expectedVersion: 1, package: { ...f.global.current.package, skillMd: skillMd('global-skill', 'reviewed legacy draft') }, origin: 'UI' })
      expect((await f.sync.completeLocalCutover(true)).lastError).toBe('ACADEMY_CUTOVER_PENDING')
      expect(f.service.store.usesLocalAuthority()).toBe(false)
      expect(f.service.get(f.global.id).currentVersion).toBe(1)
      expect((await f.sync.publish()).lastError).toBeNull()
      expect((await f.sync.completeLocalCutover(true)).lastError).toBeNull()
      const fetch = vi.spyOn(f.transport, 'fetch').mockRejectedValue(new Error('offline'))
      await f.service.update({ skillId: f.global.id, expectedVersion: 2, package: { skillMd: skillMd('global-skill', 'local v2'), artifacts: { 'references/guide.md': 'sealed guide' } }, origin: 'UI' })
      await f.service.create({ package: { skillMd: skillMd('private-new'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
      const [first, second] = await Promise.all([f.service.prepareOpenAiRelease({ mode: 'LATEST' }), f.service.prepareOpenAiRelease({ mode: 'LATEST' })])
      expect(fetch).not.toHaveBeenCalled()
      expect(first.id).toBe(second.id)
      expect(first.artifactHash).toBe(second.artifactHash)
      expect(first.status).toBe('READY_TO_UPLOAD')
      expect(first.snapshot.map(skill => skill.name)).toEqual(['global-skill'])
      const entries = readZipEntries(readFileSync(first.artifactPath!))
      expect(entries.find(entry => entry.path.endsWith('/references/guide.md'))?.data.toString()).toBe('sealed guide')
      const statement = JSON.parse(readFileSync(join(first.artifactPath!, '..', 'statement.intoto.json'), 'utf8'))
      expect(statement._type).toBe('https://in-toto.io/Statement/v1')
      expect(statement.subject[0].digest.sha256).toBe(first.artifactHash)
      expect(statement.predicate.git.confirmation).toBe('UNVERIFIED')
      expect(statement.predicate.signed).toBe(false)
      expect(sha256(createDeterministicZip(entries))).toBe(first.artifactHash)
      const executor = (f.service.openAiPublication as any).executor
      const run = executor.run.bind(executor)
      let started!: () => void, resume!: () => void
      const startedPromise = new Promise<void>(resolve => { started = resolve })
      const barrier = new Promise<void>(resolve => { resume = resolve })
      vi.spyOn(executor, 'run').mockImplementation(async (task: any) => { started(); await barrier; return run(task) })
      await f.service.update({ skillId: f.global.id, expectedVersion: 3, package: { skillMd: skillMd('global-skill', 'sealed v3'), artifacts: {} }, origin: 'UI' })
      const building = f.service.prepareOpenAiRelease({ mode: 'LATEST' })
      await startedPromise
      await f.service.update({ skillId: f.global.id, expectedVersion: 4, package: { skillMd: skillMd('global-skill', 'newer v4'), artifacts: {} }, origin: 'UI' })
      resume()
      const stale = await building
      expect(stale.status).toBe('STALE')
      const sealed = readZipEntries(readFileSync(stale.artifactPath!))
      expect(sealed.find(entry => entry.path.endsWith('/global-skill/SKILL.md'))?.data.toString()).toContain('sealed v3')
      expect(stale.artifactHash).not.toBe(first.artifactHash)
      expect(f.service.get(f.global.id).current.package.skillMd).toContain('newer v4')
    } finally { await f.service.close() }
  }, 120000)
  it('hydrates persisted identity, flags and upload state across restart while remote verification fails independently', async () => {
    const f = await gitFixture()
    let reopened: AcademyService | undefined
    try {
      Object.assign(f.transport, { authorizationIdentity: () => 'authorized-fixture-policy' })
      await f.sync.configureAutomation({ autoPublish: true, autoUpdate: true, confirmed: true, expectedRepositoryId: 'release-github', expectedBranch: 'main' })
      const before = f.sync.getStatus()
      const database = f.service.store.databasePath
      await f.service.close()
      reopened = new AcademyService(database, join(f.root, 'Downloads'), 2000, join(f.root, 'academy-plugin-worker.cjs'))
      const store = reopened.store
      const sync = new AcademyGitSyncService(store, new AcademyGitMaterializer(), f.git, f.transport,
        { resolveRepository: () => f.record, findByGitHubId: () => f.record, listEligibleRepositories: () => [f.record] })
      reopened.initializeGitSync(sync)
      expect(sync.getStatus()).toMatchObject({ lastKnown: before.lastKnown, remoteCheck: { state: 'IDLE' } })
      const persisted = store.getGitPublication(before.publication!.destinationKey)
      const save = vi.spyOn(store, 'saveGitPublication')
      const scan = vi.spyOn(store, 'getGitSnapshot').mockImplementation(() => { throw new Error('snapshot scan forbidden in bootstrap') })
      const header = vi.spyOn(store, 'getGitSnapshotHeader').mockImplementation(() => { throw new Error('fingerprint source forbidden in bootstrap') })
      const publication = vi.spyOn(reopened.openAiPublication, 'state').mockImplementation(() => { throw new Error('expensive projection forbidden in bootstrap') })
      let fail!: (error: Error) => void
      const fetch = vi.spyOn(f.transport, 'fetch').mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
      const pending = sync.recoverOnStartup()
      await vi.waitFor(() => expect(sync.getStatus().remoteCheck?.state).toBe('CHECKING'))
      const bootstrap = reopened.getAcademyBootstrapState('restart-proof')
      expect(bootstrap.snapshot.skills.some(skill => skill.name === 'global-skill')).toBe(true)
      expect(bootstrap).toMatchObject({ hydration: 'READY', provenance: 'ACADEMY_SQLITE',
        git: { lastKnown: before.lastKnown, remoteCheck: { state: 'CHECKING' }, publication: { autoPublish: true, autoUpdate: true } },
        publication: { publishedVersion: '0.1.3', release: { version: '0.1.3', status: 'UPLOADED_UNVERIFIED', sourceCommitSha: null } } })
      expect(save).not.toHaveBeenCalled(); expect(scan).not.toHaveBeenCalled(); expect(header).not.toHaveBeenCalled(); expect(publication).not.toHaveBeenCalled()
      expect(store.getGitPublication(before.publication!.destinationKey)).toEqual(persisted)
      await vi.waitFor(() => expect(fail).toBeTypeOf('function'))
      fail(new Error('simulated offline'))
      await pending
      expect(sync.getStatus()).toMatchObject({ syncState: 'OFFLINE', lastKnown: before.lastKnown, remoteCheck: { state: 'FAILED', error: 'simulated offline' } })
      expect(save).not.toHaveBeenCalled()
      expect(store.getGitPublication(before.publication!.destinationKey)).toEqual(persisted)
      scan.mockRestore(); header.mockRestore(); publication.mockRestore()
      expect((await sync.verifyRemote()).remoteCheck?.state).toBe('OK')
      expect(sync.getStatus().lastKnown?.autoUpdate).toBe(true)
      fetch.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
      const late = sync.verifyRemote()
      await vi.waitFor(() => expect(sync.getStatus().remoteCheck?.state).toBe('CHECKING'))
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
      store.saveGitProfile({ ...store.getGitProfile()!, repositoryCatalogId: 'other', githubRepositoryId: 'other-repo', branch: 'release' })
      expect(sync.getStatus()).toMatchObject({ repository: null, lastCommitSha: null, lastSyncAt: null, lastKnown: { repositoryId: 'other-repo', branch: 'release', remoteHead: null }, remoteCheck: { state: 'IDLE' } })
      fail(new Error('old identity completed late'))
      await late
      expect(sync.getStatus()).toMatchObject({ lastKnown: { repositoryId: 'other-repo' }, remoteCheck: { state: 'IDLE', error: null } })
      console.log('ACADEMY_BOOTSTRAP_STORE', JSON.stringify({ initializationId: bootstrap.initializationId, storeMs: bootstrap.storeDurationMs, source: bootstrap.provenance }))
    } finally { if (reopened) await reopened.close(); else await f.service.close() }
  }, 90000)

  it('coalesces fresh observations and physical builds, verifies cached bytes, and independently reproduces the archive off-thread', async () => {
    const f = await gitFixture()
    try {
      const fetch = vi.spyOn(f.transport, 'fetch')
      const executor = (f.service.openAiPublication as any).executor
      const run = vi.spyOn(executor, 'run')
      const [first, concurrent] = await Promise.all([f.service.prepareOpenAiRelease({ mode: 'LATEST' }), f.service.prepareOpenAiRelease({ mode: 'LATEST' })])
      expect(fetch).not.toHaveBeenCalled()
      expect(first.id).toBe(concurrent.id)
      expect(run.mock.calls.filter(([task]: any[]) => task.kind === 'inventory')).toHaveLength(1)
      expect(run.mock.calls.filter(([task]: any[]) => task.kind === 'build')).toHaveLength(1)
      const mtime = statSync(first.artifactPath!).mtimeMs
      const source = await f.sync.getSourceSnapshot({ mode: 'LATEST' })
      const header = f.service.store.getGitSnapshotHeader(source.snapshot.repositoryId, source.snapshot.sourceCommitSha)!
      const projection = f.service.store.getGitBuildProjection(header.repositoryId, header.sourceCommitSha)!
      const task = { kind: 'build', snapshotJson: f.service.store.getGitSnapshotPayload(header.repositoryId, header.sourceCommitSha)!, projection,
        profile: f.service.store.getOpenAiPluginProfile()!, storageRoot: join(f.root, 'independent') }
      let heartbeats = 0
      const timer = setInterval(() => heartbeats++, 1)
      let independent
      try { independent = await executor.run({ ...task, artifactPath: join(task.storageRoot, 'one.zip') }) }
      finally { clearInterval(timer) }
      const another = await executor.run({ ...task, artifactPath: join(task.storageRoot, 'two.zip') })
      expect(heartbeats).toBeGreaterThan(0)
      expect(independent.artifactHash).toBe(first.artifactHash)
      expect(another.artifactHash).toBe(first.artifactHash)
      const bytes = readFileSync(independent.artifactPath)
      const central = bytes.readUInt32LE(bytes.length - 6)
      expect(bytes.readUInt16LE(10)).toBe(0)
      expect(bytes.readUInt16LE(12)).toBe(0x21)
      expect(bytes.readUInt16LE(28)).toBe(0)
      expect(bytes.readUInt32LE(central + 38)).toBe(0)
      expect(bytes.readUInt16LE(central + 30)).toBe(0)
      expect(bytes.readUInt16LE(central + 32)).toBe(0)
      const repeated = await f.service.prepareOpenAiRelease({ mode: 'LATEST' })
      expect(repeated.source!.buildKey).toBe(first.source!.buildKey)
      expect(statSync(first.artifactPath!).mtimeMs).toBe(mtime)
      const reopened = new AcademyService(f.service.store.databasePath, join(f.root, 'Downloads'), 2000, join(f.root, 'academy-plugin-worker.cjs'))
      try {
        const restartedRun = vi.spyOn((reopened.openAiPublication as any).executor, 'run')
        expect((await reopened.openAiPublication.prepareGitRelease(source)).artifactHash).toBe(first.artifactHash)
        expect(restartedRun.mock.calls.map(([task]: any[]) => task.kind)).toEqual(['verify'])
        expect(fetch).not.toHaveBeenCalled()
      } finally { await reopened.close() }
      const count = run.mock.calls.filter(([task]: any[]) => task.kind === 'inventory').length
      const body = vi.spyOn(f.service.store, 'getGitSnapshotPayload')
      f.service.getOpenAiPublicationState(); f.service.getPackageDistributionState(); f.service.listOpenAiReleases()
      expect(body).not.toHaveBeenCalled()
      expect(run.mock.calls.filter(([task]: any[]) => task.kind === 'inventory')).toHaveLength(count)
      body.mockRestore()
      await f.sync.getSourceSnapshot({ mode: 'LATEST', force: true })
      expect(fetch).toHaveBeenCalledTimes(1)
      Object.assign(f.transport, { authorizationIdentity: () => 'different-credential-policy' })
      await f.sync.getSourceSnapshot({ mode: 'LATEST' })
      expect(fetch).toHaveBeenCalledTimes(2)
      const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(Date.parse(f.sync.getStatus().lastSyncAt!) + 30001)
      await Promise.all([f.sync.getSourceSnapshot({ mode: 'LATEST' }), f.sync.getSourceSnapshot({ mode: 'LATEST' })])
      clock.mockRestore()
      expect(fetch).toHaveBeenCalledTimes(3)
      fetch.mockRejectedValue(new Error('offline'))
      await expect(f.sync.getSourceSnapshot({ mode: 'LATEST', force: true })).rejects.toMatchObject({ code: 'GIT_SOURCE_LATEST_UNVERIFIED' })
      await expect(f.sync.getSourceSnapshot({ mode: 'LATEST' })).rejects.toMatchObject({ code: 'GIT_SOURCE_LATEST_UNVERIFIED' })
      expect(fetch).toHaveBeenCalledTimes(5)
      const cached = await f.service.prepareOpenAiRelease({ mode: 'REBUILD', sourceCommitSha: source.snapshot.sourceCommitSha })
      expect(cached.artifactHash).toBe(first.artifactHash)
      writeFileSync(first.artifactPath!, 'corrupted')
      const ledger = f.service.store.listGitBuildReceipts(first.id)
      await expect(f.service.prepareOpenAiRelease({ mode: 'REBUILD', sourceCommitSha: source.snapshot.sourceCommitSha })).rejects.toMatchObject({ code: 'OPENAI_RELEASE_ARTIFACT_DRIFT' })
      expect(readFileSync(first.artifactPath!, 'utf8')).toBe('corrupted')
      expect(f.service.store.listGitBuildReceipts(first.id)).toEqual(ledger)
    } finally { await f.service.close() }
  }, 120000)

  it('blocks legacy 0.27.16 before inventory and assists an authorized Git-only 0.27.17 revision without rewriting history', async () => {
    const f = await gitFixture()
    try {
      f.bump('0.27.16'); await f.commit('current publication manifest')
      const source = await f.sync.getSourceSnapshot({ mode: 'LATEST', force: true })
      const baseline = f.service.listOpenAiReleases().find(item => item.baseline)!
      const oldZip = createDeterministicZip([{ path: 'academy-skills/legacy.txt', data: Buffer.from('historical upload') }])
      const oldPath = join(f.root, 'legacy-0.27.16.zip'); writeFileSync(oldPath, oldZip)
      const legacy = f.service.store.insertOpenAiRelease({ ...baseline, id: 'legacy-02716', pluginVersion: '0.27.16', baseline: false,
        manifest: { ...f.manifest }, artifactPath: oldPath, artifactHash: sha256(oldZip), createdAt: new Date().toISOString() })
      const before = f.service.store.listOpenAiReleases()
      const inventory = vi.spyOn((f.service.openAiPublication as any).executor, 'run')
      const fullSnapshot = vi.spyOn(f.service.store, 'getGitSnapshot')
      const started = performance.now()
      await expect(f.service.openAiPublication.prepareGitRelease(source)).rejects.toThrow(/manifesto declara 0.27.16/)
      console.log('ACADEMY_VERSION_PREFLIGHT', JSON.stringify({ elapsedMs: performance.now() - started, inventoryCalls: inventory.mock.calls.length, snapshotBodyReads: fullSnapshot.mock.calls.length }))
      expect(inventory).not.toHaveBeenCalled(); expect(fullSnapshot).not.toHaveBeenCalled()
      expect(f.service.store.listPluginPackageRevisions()).toEqual([])
      expect(f.service.store.listOpenAiReleases()).toEqual(before)
      inventory.mockRestore(); fullSnapshot.mockRestore()
      const preview = await f.service.previewManifestVersion('PATCH')
      expect(preview).toMatchObject({ previousVersion: '0.27.16', newVersion: '0.27.17' })
      const remoteBefore = await f.git.resolveCommit(f.human, 'HEAD')
      const push = vi.spyOn(f.transport, 'push')
      expect((await f.sync.saveManifestDraft({ preview, confirmed: true })).syncState).toBe('LOCAL_CHANGES')
      expect(push).not.toHaveBeenCalled()
      const workspace = f.sync.getStatus().publication!.workspacePath!
      expect((await gitExec(workspace, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).trim()).toBe('plugin.json')
      expect(await f.git.resolveCommit(f.human, 'HEAD')).toBe(remoteBefore)
      push.mockRejectedValueOnce(new Error('GH006 protected branch requires pull request'))
      expect((await f.sync.publish()).syncState).toBe('PR_PENDING')
      await expect(f.service.prepareOpenAiRelease({ mode: 'LATEST', force: true })).rejects.toMatchObject({ code: 'VERSION_REUSE_FOR_DIFFERENT_CONTENT' })
      expect(f.service.store.findOpenAiReleaseVersion('0.27.17')).toBeNull()
      expect((await f.sync.publish()).syncState).toBe('SYNCED')
      const release = await f.service.prepareOpenAiRelease({ mode: 'LATEST', force: true })
      expect(release).toMatchObject({ pluginVersion: '0.27.17', status: 'READY_TO_UPLOAD', source: { sourceCommitSha: f.service.store.getGitAuthority()!.processedCommitSha } })
      expect(f.service.store.getOpenAiRelease(legacy.id)).toEqual(legacy)
      expect(readFileSync(oldPath)).toEqual(oldZip)
      expect(f.service.get(f.global.id).currentVersion).toBe(1)
    } finally { await f.service.close() }
  }, 150000)

  it('refuses a stale manifest review when the remote advances and never publishes from Prepare ZIP', async () => {
    const f = await gitFixture()
    try {
      const preview = await f.service.previewManifestVersion('PATCH')
      f.bump('0.2.3'); await f.commit('external manifest change')
      const push = vi.spyOn(f.transport, 'push')
      const result = await f.sync.saveManifestDraft({ preview, confirmed: true })
      expect(result.lastError).toBe('MANIFEST_SOURCE_CHANGED')
      expect(push).not.toHaveBeenCalled()
      expect(f.service.store.findOpenAiReleaseVersion(preview.newVersion)).toBeNull()
    } finally { await f.service.close() }
  }, 60000)

  it('refuses unsafe authored metadata before ingestion and validates assets before reserving a release version', async () => {
    const f = await gitFixture()
    try {
      const first = await f.service.prepareOpenAiRelease({ mode: 'LATEST', force: true })
      f.manifest.extensions['com.openai'].interface.logo = './assets/missing.png'
      f.bump('0.4.0'); await f.commit('missing authored asset')
      await expect(f.service.prepareOpenAiRelease({ mode: 'LATEST', force: true })).rejects.toMatchObject({ code: 'OPENAI_PACKAGE_INVALID' })
      expect(f.service.store.listPluginPackageRevisions().some(item => item.version === '0.4.0')).toBe(false)
      expect(f.service.store.listOpenAiReleases().filter(item => !item.baseline)).toHaveLength(1)
      delete f.manifest.extensions['com.openai'].interface.logo
      f.manifest.description = 'sk-proj-' + 'x'.repeat(30)
      f.bump('0.4.1'); await f.commit('unsafe metadata')
      const accepted = f.service.store.getGitAuthority()!.processedCommitSha
      await expect(f.service.prepareOpenAiRelease({ mode: 'LATEST', force: true })).rejects.toMatchObject({ code: 'GIT_SOURCE_LATEST_UNVERIFIED' })
      expect(f.sync.getStatus().lastError).toBe('KNOWN_SECRET_DETECTED')
      expect(f.service.store.getGitAuthority()!.processedCommitSha).toBe(accepted)
      expect((await f.service.prepareOpenAiRelease({ mode: 'REBUILD', sourceCommitSha: first.source!.sourceCommitSha })).artifactHash).toBe(first.artifactHash)
    } finally { await f.service.close() }
  }, 90000)

  it('builds exclusively from one integrated commit, preserves disabled Skills, and reproduces bytes across retries', async () => {
    const f = await gitFixture()
    try {
      const baseline = f.service.listOpenAiReleases().find(release => release.baseline)!
      expect(baseline.source).toBeUndefined()
      expect(f.service.getOpenAiPublicationState()).toMatchObject({ currentPackageRevision: null, versionPreflight: { manifestVersion: '0.2.0', outcome: 'NEW_RELEASE_ALLOWED' } })
      expect(f.service.store.listPluginPackageRevisions()).toEqual([])
      const script = 'throw new Error("never execute a synchronized resource")\n'
      writeFile(f.human, 'skills/global-skill/scripts/release.cjs', script)
      f.bump('0.2.0')
      const head = await f.commit('approved resources and version')
      await f.sync.syncNow()
      await f.service.setEnabled(f.global.id, false, 1)
      const draft = await f.sync.saveDraft({ skillId: f.global.id, expectedVersion: 2,
        package: { skillMd: skillMd('global-skill', 'PRIVATE DRAFT'), artifacts: {} }, origin: 'UI' })
      await gitExec(f.human, ['switch', '-c', 'unmerged'])
      writeFile(f.human, 'skills/contribution/SKILL.md', skillMd('contribution'))
      f.bump('0.2.2'); await f.commit('candidate only', false)
      const originalProfile = f.service.store.getOpenAiPluginProfile()!
      writeFileSync(originalProfile.logoPath!, Buffer.from('unversioned logo must not be read'))
      const persist = vi.spyOn(f.service.store, 'persistGitBuild').mockImplementationOnce(() => { throw new Error('database interrupted') })
      await expect(f.service.prepareOpenAiRelease({ mode: 'LATEST', force: true })).rejects.toThrow('database interrupted')
      expect(f.service.listOpenAiReleases().filter(release => !release.baseline)).toHaveLength(0)
      persist.mockRestore()
      const first = await f.service.prepareOpenAiRelease({ mode: 'LATEST', force: true })
      const second = await f.service.prepareOpenAiRelease({ mode: 'REBUILD', sourceCommitSha: head })
      expect(second.id).toBe(first.id)
      expect(second.artifactHash).toBe(first.artifactHash)
      expect(second.source).toMatchObject({ sourceRepositoryId: 'release-github', branch: 'main', sourceCommitSha: head, pluginVersion: '0.2.0', remoteConfirmation: 'CACHED', zipSha256: first.artifactHash, buildSchema: 1 })
      const entries = readZipEntries(readFileSync(first.artifactPath!))
      expect(entries.find(entry => entry.path.endsWith('/scripts/release.cjs'))?.data.toString()).toBe(script)
      expect(entries.find(entry => entry.path.endsWith('/SKILL.md'))?.data.toString()).toBe(f.global.current.package.skillMd)
      expect(entries.find(entry => entry.path.endsWith('/assets/logo.png'))?.data.equals(png())).toBe(true)
      expect(JSON.parse(entries.find(entry => entry.path.endsWith('/plugin.json'))!.data.toString()).version).toBe('0.2.0')
      expect(first.snapshot.map(item => item.name)).toEqual(['global-skill'])
      expect(f.service.get(f.global.id).status).toBe('DISABLED')
      expect((await f.sync.getDraft('global-skill')).workspaceCommitSha).toBe(draft.workspaceCommitSha)
      expect(f.service.store.getOpenAiRelease(baseline.id)).toEqual(baseline)
      expect(f.service.store.listGitBuildReceipts(first.id).length).toBeGreaterThanOrEqual(2)
      expect(f.service.confirmOpenAiUpload(first.id, first.artifactHash!).status).toBe('UPLOADED_UNVERIFIED')
      expect(f.service.openAiPublication.verifyRelease(first.id, 'Explicit manual verification evidence').status).toBe('VERIFIED')
      await gitExec(f.human, ['switch', 'main'])
      await gitExec(f.human, ['merge', '--no-ff', 'unmerged', '-m', 'approved contribution'])
      await gitExec(f.human, ['push', 'origin', 'main'])
      const merged = await f.service.prepareOpenAiRelease({ mode: 'LATEST', force: true })
      expect(merged.pluginVersion).toBe('0.2.2')
      expect(merged.snapshot.map(item => item.name).sort()).toEqual(['contribution', 'global-skill'])
      expect(merged.source?.sourceCommitSha).toBe(await f.git.resolveCommit(f.human, 'HEAD'))
      expect(f.service.get(f.global.id).currentVersion).toBe(2)
    } finally { await f.service.close() }
  }, 120000)

  it('refuses reused versions and dirty source, retains immutable receipts, and rebuilds verified commits offline', async () => {
    const f = await gitFixture()
    try {
      const first = await f.service.prepareOpenAiRelease({ mode: 'LATEST', force: true })
      const receipts = f.service.store.listGitBuildReceipts(first.id)
      writeFile(f.human, 'skills/global-skill/SKILL.md', skillMd('global-skill', 'published changed content'))
      await f.commit('skill changed without version bump')
      await expect(f.service.prepareOpenAiRelease({ mode: 'LATEST', force: true })).rejects.toMatchObject({ code: 'VERSION_REUSE_FOR_DIFFERENT_CONTENT' })
      expect(f.service.get(f.global.id).currentVersion).toBe(2)
      expect(f.service.getOpenAiPublicationState().sourceError).toBe('VERSION_REUSE_FOR_DIFFERENT_CONTENT')
      f.bump('0.2.1'); await f.commit('approved version bump')
      const newer = await f.service.prepareOpenAiRelease({ mode: 'LATEST', force: true })
      expect(newer.pluginVersion).toBe('0.2.1')
      expect(newer.artifactHash).not.toBe(first.artifactHash)
      writeFile(f.human, 'README.md', 'An unrelated approved documentation change')
      await gitExec(f.human, ['add', '--', 'README.md'])
      const documentationHead = await f.commit('documentation only')
      const unchangedPackage = await f.service.prepareOpenAiRelease({ mode: 'LATEST', force: true })
      expect(unchangedPackage.id).toBe(newer.id)
      expect(unchangedPackage.artifactHash).toBe(newer.artifactHash)
      expect(unchangedPackage.source!.sourceCommitSha).toBe(documentationHead)
      const sourceRoot = f.sync.getStatus().publication!.checkoutPath
      writeFile(sourceRoot, 'plugin.json', '{}')
      await expect(f.service.prepareOpenAiRelease({ mode: 'LATEST', force: true })).rejects.toBeDefined()
      vi.spyOn(f.transport, 'fetch').mockRejectedValue(new Error('offline'))
      await expect(f.service.prepareOpenAiRelease({ mode: 'LATEST', force: true })).rejects.toMatchObject({ code: 'GIT_SOURCE_LATEST_UNVERIFIED' })
      const offline = await f.service.prepareOpenAiRelease({ mode: 'REBUILD', sourceCommitSha: first.source!.sourceCommitSha })
      expect(offline.artifactHash).toBe(first.artifactHash)
      expect(offline.source?.remoteConfirmation).toBe('CACHED')
      expect(offline.status).toBe('STALE')
      expect(f.service.store.listGitBuildReceipts(first.id).slice(0, receipts.length)).toEqual(receipts)
      const reopened = new AcademyStore(f.service.store.databasePath)
      try {
        expect(reopened.listGitBuildReceipts(first.id)).toEqual(f.service.store.listGitBuildReceipts(first.id))
        expect(reopened.getOpenAiRelease(newer.id).source?.sourceCommitSha).toBe(documentationHead)
      } finally { reopened.close() }
      const cached = await f.sync.getSourceSnapshot({ mode: 'REBUILD', sourceCommitSha: first.source!.sourceCommitSha })
      cached.snapshot.authoredFiles['skills/../escape'] = Buffer.from('bad').toString('base64')
      await expect(f.service.openAiPublication.prepareGitRelease(cached)).rejects.toThrow('GIT_SOURCE_SNAPSHOT_NOT_VERIFIED')
    } finally { await f.service.close() }
  }, 120000)

  it('keeps destructive delta authorization separate from source confirmation and ZIP/upload states', async () => {
    const f = await gitFixture()
    try {
      await f.service.prepareOpenAiRelease({ mode: 'LATEST', force: true })
      await gitExec(f.human, ['rm', '-r', 'skills/global-skill'])
      f.bump('0.3.0'); await f.commit('approved removal')
      const before = f.service.store.listOpenAiReleases()
      await expect(f.service.prepareOpenAiRelease({ mode: 'LATEST', force: true })).rejects.toMatchObject({ code: 'OPENAI_DESTRUCTIVE_DELTA_BLOCKED' })
      expect(f.service.store.listOpenAiReleases()).toEqual(before)
      expect(f.service.history(f.global.id)).toHaveLength(1)
      f.service.openAiPublication.recordDeletionSemantics('PROVEN_REPLACE', 'Explicitly demonstrated replace behavior')
      const ready = await f.service.prepareOpenAiRelease({ mode: 'LATEST', force: true })
      expect(ready.status).toBe('READY_TO_UPLOAD')
      expect(ready.snapshot).toEqual([])
      expect(f.service.store.listGitBuildReceipts(ready.id)[0].zipSha256).toBe(ready.artifactHash)
      expect(f.service.confirmOpenAiUpload(ready.id, ready.artifactHash!).status).toBe('UPLOADED_UNVERIFIED')
      expect(f.service.openAiPublication.verifyRelease(ready.id, 'Manual verification').status).toBe('VERIFIED')
    } finally { await f.service.close() }
  }, 90000)
})

describe('Academy OpenAI plugin publication', () => {
  it('bootstraps the existing identity and creates a complete validated deterministic ZIP from canonical GLOBAL ACTIVE Skills', async () => {
    const { root, service } = await fixture()
    const release = await service.prepareOpenAiRelease()
    expect(release).toMatchObject({ pluginVersion: '0.1.4', status: 'READY_TO_UPLOAD', baseline: false })
    expect(release.snapshot.map((entry) => entry.name)).toEqual(['global-skill'])
    expect(release.artifactPath).toContain(join('academy', 'openai-plugin', 'releases'))
    const archive = readFileSync(release.artifactPath!)
    const downloadArchive = readFileSync(join(root, 'Downloads', 'academy-skills-0.1.4.zip'))
    expect(release.artifactHash).toHaveLength(64)
    expect(downloadArchive.equals(archive)).toBe(true)
    const entries = readZipEntries(archive)
    expect(entries.map((entry) => entry.path)).toEqual([
      'academy-skills/assets/logo.png',
      'academy-skills/plugin.json',
      'academy-skills/skills/global-skill/references/guide.md',
      'academy-skills/skills/global-skill/SKILL.md'
    ])
    expect(entries.some((entry) => /mcp\.json|\.app\.json|\.codex-plugin/.test(entry.path))).toBe(false)
    const manifest = JSON.parse(entries.find((entry) => entry.path.endsWith('plugin.json'))!.data.toString())
    expect(manifest).toMatchObject({ name: 'academy-skills', version: '0.1.4' })
    expect(manifest.extensions['com.openai'].interface.defaultPrompt).toEqual(['One', 'Two'])
    const rebuilt = createDeterministicZip(entries)
    expect(rebuilt.equals(archive)).toBe(true)
    service.close()
  })

  it('preserves Skill scripts byte for byte in a prepared ZIP without executing them', async () => {
    const { service } = await fixture()
    const artifacts = {
      'references/guide.md': 'guide',
      'scripts/open-pr-safe.cjs': 'throw new Error("must never execute")\n',
      'scripts/nested/check.py': 'raise Exception("must never execute")\n',
      'assets/mcp.json': '{"example":true}\n'
    }
    const skill = await service.create({ package: { skillMd: skillMd('worktree-execution'), artifacts }, scope: 'GLOBAL', origin: 'UI' })
    service.store.approvePublicSkill(skill.id, skill.currentVersion)
    const canonical = service.get(skill.id)
    try {
      const release = await service.prepareOpenAiRelease()
      expect(release.status).toBe('READY_TO_UPLOAD')
      const entries = readZipEntries(readFileSync(release.artifactPath!))
      for (const [path, content] of Object.entries(artifacts)) {
        expect(entries.find(entry => entry.path === 'academy-skills/skills/worktree-execution/' + path)?.data.equals(Buffer.from(content))).toBe(true)
      }
      expect(service.get(skill.id)).toEqual(canonical)
    } finally { service.close() }
  })

  it.each(['cjs', 'js', 'mjs', 'sh', 'py', 'ps1', 'custom', ''])('blocks known secrets in textual Skill resources with extension %s', async (extension) => {
    const { service, global } = await fixture()
    const path = 'scripts/check' + (extension ? '.' + extension : '')
    try {
      await service.update({ skillId: global.id, expectedVersion: global.currentVersion, package: { skillMd: global.current.package.skillMd, artifacts: { [path]: 'sk-proj-abcdefghijklmnopqrstuvwxyz' } }, origin: 'UI' })
      expect(() => service.prepareOpenAiRelease()).toThrow('KNOWN_SECRET:')
    } finally { service.close() }
  })

  it('calculates stable-id delta and automatic PATCH/MINOR versions', () => {
    const before = [{ skillId: '1', name: 'alpha', academyVersion: 1, packageHash: 'a' }]
    const content = [{ skillId: '1', name: 'alpha', academyVersion: 2, packageHash: 'b' }]
    const renamed = [{ skillId: '1', name: 'beta', academyVersion: 2, packageHash: 'b' }]
    expect(nextOpenAiPluginVersion('1.2.3', calculateOpenAiDelta(before, content), false)).toBe('1.2.4')
    expect(nextOpenAiPluginVersion('1.2.4', calculateOpenAiDelta(before, [...before, { skillId: '2', name: 'beta', academyVersion: 1, packageHash: 'b' }]), false)).toBe('1.3.0')
    const delta = calculateOpenAiDelta(before, renamed)
    expect(delta.renamed).toHaveLength(1)
    expect(delta.added).toHaveLength(0)
    expect(delta.removed).toHaveLength(0)
    expect(delta.destructive).toBe(true)
  })

  it('marks prepared releases stale, rejects stale confirmation, and records exact manual upload without claiming verification', async () => {
    const { service, global } = await fixture()
    const prepared = await service.prepareOpenAiRelease()
    await service.update({ skillId: global.id, expectedVersion: global.currentVersion, package: { skillMd: skillMd('global-skill', 'v2'), artifacts: { 'references/guide.md': 'guide' } }, origin: 'UI' })
    expect(service.getOpenAiRelease(prepared.id).status).toBe('STALE')
    expect(() => service.confirmOpenAiUpload(prepared.id, prepared.artifactHash!)).toThrow('OPENAI_RELEASE_NOT_CONFIRMABLE')
    const current = await service.prepareOpenAiRelease()
    expect(current.pluginVersion).toBe('0.1.5')
    expect(() => service.confirmOpenAiUpload(current.id, '0'.repeat(64))).toThrow('OPENAI_RELEASE_HASH_MISMATCH')
    const confirmed = service.confirmOpenAiUpload(current.id, current.artifactHash!)
    expect(confirmed.status).toBe('UPLOADED_UNVERIFIED')
    expect(confirmed.uploadConfirmation).toMatchObject({ method: 'MANUAL_UPLOAD', artifactHash: current.artifactHash })
    expect(service.openAiPublication.verifyRelease(confirmed.id, 'external runtime catalog matched').status).toBe('VERIFIED')
    service.close()
  })

  it('blocks removal and rename until replacement semantics are proven', async () => {
    const { service, global, root } = await fixture()
    await service.setEnabled(global.id, false, global.stateRevision)
    const blockedRemoval = await service.prepareOpenAiRelease()
    expect(blockedRemoval).toMatchObject({ status: 'BLOCKED', blockedReason: 'DESTRUCTIVE_DELTA_UNKNOWN', artifactPath: null })
    expect(blockedRemoval.delta.removed.map((item) => item.name)).toEqual(['global-skill'])
    expect(blockedRemoval.snapshot).toEqual([])
    expect(readFileSync(join(root, 'installed/academy-skills/skills/global-skill/SKILL.md'), 'utf8')).toBe(global.current.package.skillMd)
    expect(service.getOpenAiPublicationState().latestUploaded?.status).not.toBe('VERIFIED')
    service.openAiPublication.recordDeletionSemantics('PROVEN_REPLACE', 'Disposable plugin removal probe passed.')
    const allowed = await service.prepareOpenAiRelease()
    expect(allowed.status).toBe('READY_TO_UPLOAD')
    expect(allowed.pluginVersion).toBe('0.2.0')
    expect(readZipEntries(readFileSync(allowed.artifactPath!)).some(entry => entry.path.includes('/skills/global-skill/'))).toBe(false)
    await service.update({ skillId: global.id, expectedVersion: 1, package: { ...global.current.package, skillMd: skillMd(global.name, 'private latest') }, origin: 'UI' })
    expect((await service.prepareOpenAiRelease()).snapshot).toEqual([])
    await service.setEnabled(global.id, true, 2)
    expect((await service.prepareOpenAiRelease()).snapshot).toMatchObject([{ skillId: global.id, academyVersion: 2 }])
    service.close()

    const renamedFixture = await fixture()
    await renamedFixture.service.update({ skillId: renamedFixture.global.id, expectedVersion: 1, package: { skillMd: skillMd('renamed-skill'), artifacts: { 'references/guide.md': 'guide' } }, origin: 'UI' })
    const blockedRename = await renamedFixture.service.prepareOpenAiRelease()
    expect(blockedRename.status).toBe('BLOCKED')
    expect(blockedRename.delta.renamed).toHaveLength(1)
    renamedFixture.service.close()
  })

  it('allows non-destructive additions while deletion semantics remain unknown', async () => {
    const { service } = await fixture()
    const added = await service.create({ package: { skillMd: skillMd('added-skill'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
    service.store.approvePublicSkill(added.id, added.currentVersion)
    const release = await service.prepareOpenAiRelease()
    expect(release).toMatchObject({ pluginVersion: '0.2.0', status: 'READY_TO_UPLOAD' })
    expect(release.delta.added.map((item) => item.name)).toEqual(['added-skill'])
    service.close()
  })

  it('rejects foreign components, secrets, invalid skill metadata, and invalid logo dimensions', async () => {
    const { service } = await fixture()
    const state = service.getOpenAiPublicationState()
    const profile = state.profile!
    const snapshot = [{ skillId: 'id', name: 'safe-skill', academyVersion: 1, packageHash: 'hash' }]
    const manifest = Buffer.from(JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'academy-skills', version: '1.0.0', description: 'x',
      author: { name: 'Academy' }, extensions: { 'com.openai': { interface: { displayName: 'Academy Skills', logo: './assets/logo.png' } } }
    }))
    expect(() => validateOpenAiPluginPackage([
      { path: 'academy-skills/plugin.json', data: manifest }, { path: 'academy-skills/assets/logo.png', data: png(64, 32) },
      { path: 'academy-skills/skills/safe-skill/SKILL.md', data: Buffer.from('---\nname: wrong\ndescription: x\n---\n') },
      { path: 'academy-skills/mcp.json', data: Buffer.from('{"token":"sk-proj-abcdefghijklmnopqrstuvwxyz"}') }
    ], profile, snapshot)).toThrow(/KNOWN_SECRET:.*FORBIDDEN_COMPONENT:.*LOGO_INVALID_DIMENSIONS/)
    service.close()
  })

  it.each(['mcp.json', '.app.json', '.codex-plugin/plugin.json', 'scripts/run.cjs', 'node_modules/a/index.js', 'skills/global-skill/node_modules/a/index.js', 'skills/global-skill/.codex-plugin/plugin.json', 'skills/unknown/scripts/run.cjs', 'skills/global-skill/../escape.txt', 'skills/global-skill/skill.md'])('rejects unauthorized or invalid path %s', async (path) => {
    const { service } = await fixture()
    try {
      const release = await service.prepareOpenAiRelease()
      const entries = readZipEntries(readFileSync(release.artifactPath!))
      entries.push({ path: 'academy-skills/' + path, data: Buffer.from('safe') })
      expect(() => validateOpenAiPluginPackage(entries, service.getOpenAiPublicationState().profile!, release.snapshot)).toThrow(/FORBIDDEN_COMPONENT|UNEXPECTED_FILE|INVALID_PATH/)
    } finally { service.close() }
  })

  it('persists profile, snapshots, hashes, destructive evidence, and confirmations across reopen', async () => {
    const { root, service } = await fixture()
    const release = await service.prepareOpenAiRelease()
    service.confirmOpenAiUpload(release.id, release.artifactHash!)
    service.openAiPublication.recordDeletionSemantics('INCONCLUSIVE', 'Probe could not distinguish overlay from replacement.')
    const databasePath = service.store.databasePath
    service.close()
    const reopened = new AcademyService(databasePath)
    expect(reopened.getOpenAiPublicationState().profile).toMatchObject({ name: 'academy-skills', publishedVersion: '0.1.4', deletionSemantics: 'INCONCLUSIVE' })
    expect(reopened.getOpenAiRelease(release.id)).toMatchObject({ artifactHash: release.artifactHash, status: 'UPLOADED_UNVERIFIED' })
    expect(hashOpenAiSnapshot(reopened.getOpenAiRelease(release.id).snapshot)).toBe(release.snapshotHash)
    reopened.close()
    expect(root).toBeTruthy()
  })

  it('projects explicit plugin coverage counts, distinguishes exclusion reasons, and tracks ZIP availability offline', async () => {
    const { root, service } = await fixture()
    try {
      const dest = service.store.upsertDestination(join(root, 'proj'), 'proj')
      const privateSkill = service.store.create({
        package: { skillMd: '---\nname: priv-skill\ndescription: Private\n---\n# Priv\n', artifacts: {} },
        scope: 'GLOBAL', origin: 'UI'
      })
      const disabledSkill = service.store.create({
        package: { skillMd: '---\nname: disabled-skill\ndescription: Disabled\n---\n# Disabled\n', artifacts: {} },
        scope: 'GLOBAL', origin: 'UI'
      })
      service.store.approvePublicSkill(disabledSkill.id, 1)
      service.store.setEnabled(disabledSkill.id, false, 1)
      service.store.create({
        package: { skillMd: '---\nname: local-proj\ndescription: Project\n---\n# Project\n', artifacts: {} },
        scope: 'PROJECT', projectIds: [dest.id], origin: 'UI'
      })

      const beforeZip = service.getOpenAiPublicationState()
      expect(beforeZip.artifactAvailable).toBe(false)
      expect(beforeZip.coverage).toMatchObject({
        catalog: 6, eligible: 1, includedInLastZip: 1, awaitingZip: 0, notApplicable: 2
      })
      expect(beforeZip.coverage?.excluded.map((item) => [item.name, item.reason])).toEqual([
        ['archived-skill', 'DISABLED'],
        ['disabled-skill', 'DISABLED'],
        ['priv-skill', 'PRIVATE']
      ])

      const release = await service.prepareOpenAiRelease()
      expect(release.status).toBe('READY_TO_UPLOAD')
      expect(release.snapshot.map((entry) => entry.name)).toEqual(['global-skill'])

      const afterZip = service.getOpenAiPublicationState()
      expect(afterZip.artifactAvailable).toBe(true)
      expect(afterZip.drifted).toBe(false)
      expect(afterZip.coverage).toMatchObject({
        catalog: 6, eligible: 1, includedInLastZip: 1, awaitingZip: 0, notApplicable: 2
      })

      rmSync(release.artifactPath!)
      expect(service.getOpenAiPublicationState().artifactAvailable).toBe(false)

      service.approvePublicSkills([{ skillId: privateSkill.id, expectedVersion: 1 }], true)
      const pendingNew = service.getOpenAiPublicationState()
      expect(pendingNew.drifted).toBe(true)
      expect(pendingNew.coverage).toMatchObject({
        catalog: 6, eligible: 2, includedInLastZip: 1, awaitingZip: 1, notApplicable: 2
      })
    } finally { await service.close() }
  })

  it('honors shared importConfirmationPreference on downloadOpenAiRelease and supports revokeUploadConfirmation without mutating canonical skills', async () => {
    const f = await fixture()
    try {
      const { service, global } = f
      expect(service.getImportConfirmationPreference().mode).toBe('MANUAL')
      expect(service.getOpenAiPublicationState().importConfirmationPreference?.mode).toBe('MANUAL')

      // Shared preference updates both OpenAI and Gemini states
      service.setImportConfirmationPreference('AUTOMATIC')
      expect(service.getOpenAiPublicationState().importConfirmationPreference?.mode).toBe('AUTOMATIC')
      expect(service.getGeminiExportState().importConfirmationPreference?.mode).toBe('AUTOMATIC')

      // Advance global skill so prepareOpenAiRelease builds 0.1.4 READY_TO_UPLOAD
      const v2 = service.store.update({
        skillId: global.id,
        expectedVersion: global.currentVersion,
        package: { skillMd: skillMd('global-skill', 'v2 body'), artifacts: { 'references/guide.md': 'updated guide' } },
        origin: 'UI'
      })

      // Even under AUTOMATIC mode, prepareOpenAiRelease must NEVER auto-confirm upload
      const prepared = await service.prepareOpenAiRelease()
      expect(prepared.status).toBe('READY_TO_UPLOAD')
      expect(prepared.uploadConfirmation).toBeNull()
      expect(service.getOpenAiPublicationState().profile?.publishedVersion).toBe('0.1.3')

      // Under MANUAL mode, downloadOpenAiRelease verifies/copies ZIP without auto-confirming
      service.setImportConfirmationPreference('MANUAL')
      const afterManualDownload = service.downloadOpenAiRelease(prepared.id)
      expect(afterManualDownload.status).toBe('READY_TO_UPLOAD')
      expect(afterManualDownload.uploadConfirmation).toBeNull()
      const downloadedZipPath = join(f.root, 'Downloads', `academy-skills-${prepared.pluginVersion}.zip`)
      expect(existsSync(downloadedZipPath)).toBe(true)
      expect(sha256(readFileSync(downloadedZipPath))).toBe(prepared.artifactHash)

      // Under AUTOMATIC mode, successful verified download records ASSUMED_ON_DOWNLOAD
      service.setImportConfirmationPreference('AUTOMATIC')
      const afterAutoDownload = service.downloadOpenAiRelease(prepared.id)
      expect(afterAutoDownload.status).toBe('UPLOADED_UNVERIFIED')
      expect(afterAutoDownload.uploadConfirmation).toMatchObject({
        releaseId: prepared.id,
        pluginVersion: prepared.pluginVersion,
        artifactHash: prepared.artifactHash,
        method: 'ASSUMED_ON_DOWNLOAD',
        origin: 'ASSUMED_ON_DOWNLOAD'
      })
      expect(service.getOpenAiPublicationState().profile?.publishedVersion).toBe(prepared.pluginVersion)

      const releasesAfterConfirm = service.listOpenAiReleases()
      const baselineDuringPublish = releasesAfterConfirm.find((r) => r.baseline)
      expect(baselineDuringPublish?.status).toBe('SUPERSEDED')

      // Revoke confirmation restores READY_TO_UPLOAD + baseline status without creating new canonical skill versions
      const versionBeforeRevoke = service.get(global.id).currentVersion
      const hashBeforeRevoke = service.get(global.id).current.packageHash
      const revoked = service.revokeOpenAiUpload(prepared.id)
      expect(revoked.status).toBe('READY_TO_UPLOAD')
      expect(revoked.uploadConfirmation).toBeNull()
      expect(service.getOpenAiPublicationState().profile?.publishedVersion).toBe('0.1.3')
      expect(service.listOpenAiReleases().find((r) => r.baseline)?.status).toBe('UPLOADED_UNVERIFIED')
      expect(service.get(global.id).currentVersion).toBe(versionBeforeRevoke)
      expect(service.get(global.id).current.packageHash).toBe(hashBeforeRevoke)

      // Re-download under AUTOMATIC, drift canonical catalog, then revoke -> becomes STALE instead of READY_TO_UPLOAD
      const reConfirmed = service.downloadOpenAiRelease(prepared.id)
      expect(reConfirmed.status).toBe('UPLOADED_UNVERIFIED')
      const v3 = service.store.update({
        skillId: global.id,
        expectedVersion: v2.currentVersion,
        package: { skillMd: skillMd('global-skill', 'v3 drifted'), artifacts: { 'references/guide.md': 'v3 guide' } },
        origin: 'UI'
      })
      expect(v3.currentVersion).toBe(3)
      const revokedDrifted = service.revokeOpenAiUpload(prepared.id)
      expect(revokedDrifted.status).toBe('STALE')
      expect(revokedDrifted.uploadConfirmation).toBeNull()
      expect(service.getOpenAiPublicationState().profile?.publishedVersion).toBe('0.1.3')
    } finally { await f.service.close() }
  })
})
