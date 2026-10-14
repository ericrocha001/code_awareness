import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcademyStore } from '../academy-store'
import { AcademyGitMaterializer } from './academy-git-materializer'
import { AcademyGitSyncService } from './academy-git-sync-service'
import { AcademyPluginRepositoryProjection } from './academy-plugin-repository-projection'
import type { GitRemoteTransport } from './academy-git-sync-service'
import { GitService } from '../../core/git-service'
import { gitExec, writeFile } from '../../core/git-test-helpers'
import type { RepositoryRecord } from '../../../shared/types/repository-catalog-types'

const roots: string[] = []
const stores: AcademyStore[] = []
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const pkg = (text = 'canonical') => ({ skillMd: `---\nname: alpha\ndescription: Test skill\n---\n${text}\n`, artifacts: {} })

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'academy-github-v2-')); roots.push(root)
  const remote = join(root, 'remote.git')
  await gitExec(root, ['init', '--bare', remote])
  const human = join(root, 'human')
  await gitExec(root, ['clone', remote, human])
  await gitExec(human, ['switch', '-c', 'main'])
  await gitExec(human, ['config', 'user.name', 'Test'])
  await gitExec(human, ['config', 'user.email', 'test@example.com'])
  const databasePath = join(root, 'data', 'academy.db')
  let store = new AcademyStore(databasePath); stores.push(store)
  const skill = store.create({ package: pkg(), scope: 'GLOBAL', origin: 'UI' })
  writeFile(human, 'skills/alpha/SKILL.md', pkg().skillMd)
  writeFile(human, 'README.md', 'human documentation')
  await gitExec(human, ['add', '.']); await gitExec(human, ['commit', '-m', 'baseline'])
  await gitExec(human, ['push', '-u', 'origin', 'main'])
  const external = join(root, 'external')
  await gitExec(root, ['clone', '--branch', 'main', remote, external])
  await gitExec(external, ['config', 'user.name', 'External'])
  await gitExec(external, ['config', 'user.email', 'external@example.com'])
  const git = new GitService()
  const transport: GitRemoteTransport = {
    fetch: (path, origin) => git.fetchRemote(path, origin),
    readRemoteHead: (path, origin, ref) => git.readRemoteHead(path, origin, ref),
    push: (path, branch, origin = 'origin', head) => git.push(path, origin, branch, head)
  }
  const record = { id: 'destination', name: 'Academy', status: 'ACTIVE',
    localCheckout: { path: human, availability: 'AVAILABLE', gitState: 'GIT' },
    github: { repositoryId: 'github-id', name: 'Academy', fullName: 'test/academy', ownerId: 'owner-id', ownerLogin: 'test', visibility: 'PRIVATE', cloneUrl: remote, htmlUrl: 'https://github.com/test/academy', accessState: 'AVAILABLE', lastSeenAt: new Date().toISOString() },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as RepositoryRecord
  const port = { resolveRepository: () => record, findByGitHubId: () => record, listEligibleRepositories: () => [record] }
  const service = () => new AcademyGitSyncService(store, new AcademyGitMaterializer(), git, transport, port)
  const sync = service()
  const bound = await sync.bindRepository(record.id)
  expect(bound.syncState, bound.lastError ?? '').toBe('SYNCED')
  const update = (text: string) => store.update({ skillId: skill.id, expectedVersion: store.get(skill.id).currentVersion, package: pkg(text), scope: 'GLOBAL', origin: 'UI' })
  const externalCommit = async (path: string, content: string) => {
    writeFile(external, path, content); await gitExec(external, ['add', '.']); await gitExec(external, ['commit', '-m', path]); await gitExec(external, ['push', 'origin', 'main'])
    return git.resolveCommit(external, 'HEAD')
  }
  const restart = () => {
    stores.splice(stores.indexOf(store), 1); store.close()
    store = new AcademyStore(databasePath); stores.push(store)
    return service()
  }
  return { root, human, external, remote, get store() { return store }, skill, git, transport, record, port, sync, service, restart, update, externalCommit }
}

describe('isolated Academy GitHub reconciliation', () => {
  it.each(['checkout', 'projection'])('rejects an unsafe Skill junction in the %s without commit, push or canonical mutation', async (area) => {
    const f = await fixture()
    f.update('security regression')
    const state = f.sync.getStatus().publication!
    const targetRoot = area === 'checkout' ? state.checkoutPath : join(state.checkoutPath, '..', 'projection')
    const peerRoot = area === 'checkout' ? join(state.checkoutPath, '..', 'projection') : state.checkoutPath
    const peerSkill = readFileSync(join(peerRoot, 'skills', 'alpha', 'SKILL.md'), 'utf8')
    const target = join(targetRoot, 'skills', 'alpha')
    const external = join(f.root, 'external-sentinel')
    mkdirSync(external)
    writeFileSync(join(external, 'sentinel.txt'), 'preserve external sentinel')
    writeFileSync(join(external, 'SKILL.md'), 'external skill')
    rmSync(target, { recursive: true })
    symlinkSync(external, target, process.platform === 'win32' ? 'junction' : 'dir')
    const head = await f.git.resolveCommit(state.checkoutPath, 'HEAD')
    const canonical = f.store.get(f.skill.id)
    const push = vi.spyOn(f.transport, 'push')
    const commit = vi.spyOn(f.git, 'commitInspectedIndex')
    const result = await f.sync.syncNow()
    expect(result.syncState).toBe('ERROR')
    expect(result.lastError).toContain('Unsafe Academy mutation path')
    expect(commit).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
    expect(await f.git.resolveCommit(state.checkoutPath, 'HEAD')).toBe(head)
    expect(f.store.get(f.skill.id)).toEqual(canonical)
    expect(readFileSync(join(external, 'sentinel.txt'), 'utf8')).toBe('preserve external sentinel')
    expect(readFileSync(join(external, 'SKILL.md'), 'utf8')).toBe('external skill')
    expect(readFileSync(join(peerRoot, 'skills', 'alpha', 'SKILL.md'), 'utf8')).toBe(peerSkill)
  }, 60000)
  it('recovers interruption during materialization without a duplicate commit', async () => {
    const f = await fixture()
    f.update('interrupted')
    const materialize = AcademyGitMaterializer.prototype.materialize
    const spy = vi.spyOn(AcademyGitMaterializer.prototype, 'materialize').mockImplementation(async function (this: AcademyGitMaterializer, path, entries) {
      const result = await materialize.call(this, path, entries)
      if (path.endsWith('checkout')) throw new Error('interrupted after materialization')
      return result
    })
    expect((await f.sync.syncNow()).syncState).toBe('ERROR')
    spy.mockRestore()
    const resumed = await f.restart().syncNow()
    expect(resumed.syncState, resumed.lastError ?? '').toBe('SYNCED')
    expect((await gitExec(resumed.repository!.checkoutPath, ['log', '--format=%s'])).split('\n').filter(line => line.startsWith('Academy sync:'))).toHaveLength(1)
  }, 60000)

  it('publishes plugin, logo and marketplace together while leaving ZIP publication separate', async () => {
    const f = await fixture()
    const logo = join(f.root, 'logo.png')
    const png = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(512, 16); png.writeUInt32BE(512, 20); writeFileSync(logo, png)
    f.store.createOpenAiPluginProfile({ name: 'academy-skills', displayName: 'Academy Skills', description: 'Procedural skills', author: { name: 'Academy' }, openAiInterface: { displayName: 'Academy Skills', shortDescription: 'Skills', longDescription: 'Curated procedural skills', developerName: 'Academy', category: 'Productivity', capabilities: ['Interactive'], defaultPrompt: ['Help me code'] }, logoPath: logo, publishedVersion: '0.1.3', deletionSemantics: 'UNKNOWN', deletionSemanticsEvidence: null })
    f.store.saveMarketplaceTakeoverState({ takeoverStatus: 'TAKEOVER_UNSUPPORTED', observedPluginId: null, evidence: 'Distinct source' })
    const service = new AcademyGitSyncService(f.store, new AcademyGitMaterializer(), f.git, f.transport, f.port, undefined, new AcademyPluginRepositoryProjection())
    const result = await service.syncNow()
    expect(result.syncState, result.lastError ?? '').toBe('SYNCED')
    const root = result.repository!.checkoutPath
    for (const path of ['plugin.json', 'assets/logo.png', '.agents/plugins/marketplace.json']) expect(await f.git.readCommitFile(root, result.publication!.remoteHead!, path, 10000)).not.toBeNull()
    expect(await f.git.readManagedTree(root, result.publication!.remoteHead!, ['skills', 'plugin.json', 'assets/logo.png', '.agents/plugins/marketplace.json'])).toBe(result.publication!.desiredTree)
    const validation = vi.spyOn(AcademyPluginRepositoryProjection.prototype, 'validate').mockRejectedValue(new Error('invalid plugin'))
    f.update('invalid projection')
    const failed = await service.syncNow()
    expect(failed.syncState).toBe('ERROR')
    expect(failed.lastError).toContain('invalid plugin')
    validation.mockRestore()
  }, 60000)

  it('publishes canonical changes without touching human HEAD, index, consumers or unstaged files', async () => {
    const f = await fixture()
    const head = await f.git.resolveCommit(f.human, 'HEAD')
    writeFile(f.human, 'third-party.txt', 'staged'); await gitExec(f.human, ['add', 'third-party.txt'])
    writeFile(f.human, 'skills/alpha/SKILL.md', 'human draft')
    writeFile(f.human, '.skills/consumer/SKILL.md', 'consumer')
    const index = await f.git.getIndexRevision(f.human)
    f.update('version 2')
    const result = await f.sync.syncNow()
    expect(result.syncState, result.lastError ?? '').toBe('SYNCED')
    expect(result.publication?.verifiedAt).toBeTruthy()
    expect(await f.git.resolveCommit(f.human, 'HEAD')).toBe(head)
    expect(await f.git.getIndexRevision(f.human)).toBe(index)
    expect(readFileSync(join(f.human, 'skills/alpha/SKILL.md'), 'utf8')).toBe('human draft')
    expect(existsSync(join(f.human, '.skills/consumer/SKILL.md'))).toBe(true)
    expect(await f.git.readCommitFile(result.repository!.checkoutPath, result.publication!.remoteHead!, 'third-party.txt', 100)).toBeNull()
  }, 60000)

  it('recovers the temporary-skill/history incident and remains idempotent after restart', async () => {
    const f = await fixture()
    const baseline = await f.git.resolveCommit(f.external, 'HEAD')
    const added = await f.externalCommit('skills/temporary/SKILL.md', 'temporary')
    rmSync(join(f.external, 'skills/temporary'), { recursive: true })
    await gitExec(f.external, ['add', '.']); await gitExec(f.external, ['commit', '-m', 'remove temporary']); await gitExec(f.external, ['push'])
    f.update('new canonical')
    const docs = await f.externalCommit('README.md', 'external documentation')
    const result = await f.sync.syncNow()
    expect(result.syncState, result.lastError ?? '').toBe('SYNCED')
    const root = result.repository!.checkoutPath
    for (const commit of [baseline, added, docs]) expect(await f.git.isAncestor(root, commit, result.publication!.remoteHead!)).toBe(true)
    expect((await f.git.readCommitFile(root, result.publication!.remoteHead!, 'README.md', 100))?.toString()).toBe('external documentation')
    expect(await f.git.readManagedTree(root, result.publication!.remoteHead!, ['skills'])).toBe(result.publication!.desiredTree)
    const restarted = f.restart()
    await restarted.recoverOnStartup()
    expect(restarted.getStatus().publication?.localHead).toBe(result.publication!.localHead)
  }, 60000)

  it('adopts external history with identical managed content without a publication commit', async () => {
    const f = await fixture()
    const docs = await f.externalCommit('README.md', 'changed documentation')
    const result = await f.sync.syncNow()
    expect(result.syncState, result.lastError ?? '').toBe('SYNCED')
    expect(result.publication?.localHead).toBe(docs)
    expect(result.publication?.remoteHead).toBe(docs)
  }, 60000)

  it('protects incompatible remote content without changing SQLite or pushing', async () => {
    const f = await fixture()
    const changed = await f.externalCommit('skills/alpha/SKILL.md', pkg('external incompatible').skillMd)
    f.update('canonical different')
    const push = vi.spyOn(f.transport, 'push')
    const result = await f.sync.syncNow()
    expect(result.syncState).toBe('REMOTE_DIVERGED')
    expect(result.publication?.phase).toBe('CONFLICT')
    expect(push).not.toHaveBeenCalled()
    expect(result.publication?.remoteHead).toBe(changed)
    expect(f.store.get(f.skill.id).current.package).toEqual(pkg('canonical different'))
    const resolved = await f.sync.resolveManagedConflict(changed, result.publication!.desiredTree!)
    expect(resolved.syncState, resolved.lastError ?? '').toBe('SYNCED')
    expect(await f.git.isAncestor(resolved.repository!.checkoutPath, changed, resolved.publication!.remoteHead!)).toBe(true)
  }, 60000)

  it('rejects stale conflict authorization and refuses adoption without a proven baseline', async () => {
    const f = await fixture()
    const changed = await f.externalCommit('skills/alpha/SKILL.md', pkg('external').skillMd)
    const state = f.sync.getStatus().publication!
    f.store.saveGitPublication({ ...state, baselineTree: null })
    const conflict = await f.sync.syncNow()
    expect(conflict.publication?.phase).toBe('CONFLICT')
    await f.externalCommit('skills/alpha/SKILL.md', pkg('newer external').skillMd)
    const result = await f.sync.resolveManagedConflict(changed, conflict.publication!.desiredTree!)
    expect(result.publication?.phase).toBe('CONFLICT')
    expect(f.store.get(f.skill.id).current.package).toEqual(pkg())
  }, 60000)

  it('recovers a persisted commit after failed push and incorporates compatible divergent histories', async () => {
    const f = await fixture()
    f.update('pending')
    const push = f.transport.push
    f.transport.push = async () => { throw new Error('offline') }
    const pending = await f.sync.syncNow()
    expect(pending.syncState).toBe('PUSH_PENDING')
    expect(pending.publication?.pendingCommit).toBeTruthy()
    const docs = await f.externalCommit('README.md', 'concurrent docs')
    f.transport.push = push
    const resumed = await f.restart().syncNow()
    expect(resumed.syncState, resumed.lastError ?? '').toBe('SYNCED')
    for (const commit of [docs, pending.publication!.pendingCommit!]) expect(await f.git.isAncestor(resumed.repository!.checkoutPath, commit, resumed.publication!.remoteHead!)).toBe(true)
    expect((await gitExec(resumed.repository!.checkoutPath, ['log', '--format=%s'])).split('\n').filter(line => line.startsWith('Academy sync:'))).toHaveLength(1)
  }, 60000)

  it('recognizes a successful push with lost confirmation and preserves concurrent writer commits', async () => {
    const f = await fixture()
    f.update('race')
    const push = f.transport.push
    let calls = 0
    f.transport.push = async (...args) => {
      calls++
      if (calls === 1) await f.externalCommit('README.md', 'writer raced')
      await push(...args)
      throw new Error('confirmation lost')
    }
    const result = await f.sync.syncNow()
    expect(result.syncState, result.lastError ?? '').toBe('SYNCED')
    expect(calls).toBe(2)
    expect((await f.git.readCommitFile(result.repository!.checkoutPath, result.publication!.remoteHead!, 'README.md', 100))?.toString()).toBe('writer raced')
  }, 60000)

  it('reports unavailable remote without a fresh success and resumes independently of human checkout availability', async () => {
    const f = await fixture()
    const verified = f.sync.getStatus().lastSyncAt
    const fetch = f.transport.fetch!
    f.transport.fetch = async () => { throw new Error('network unavailable') }
    const unavailable = await f.sync.syncNow()
    expect(unavailable.syncState).not.toBe('SYNCED')
    expect(unavailable.publication?.phase).toBe('REMOTE_UNAVAILABLE')
    expect(unavailable.lastSyncAt).toBe(verified)
    f.transport.fetch = fetch
    f.record.localCheckout = null
    f.update('independent')
    expect((await f.service().syncNow()).syncState).toBe('SYNCED')
  }, 60000)

  it('migrates legacy LOCAL_DRIFT from proven convergence and preserves incompatible unpublished commits', async () => {
    const f = await fixture()
    const old = f.store.getGitProfile()!
    const head = await f.git.resolveCommit(f.human, 'HEAD')
    const state = f.sync.getStatus().publication!
    f.store.saveGitPublication({ ...state, migrationComplete: false, baselineTree: null })
    f.store.saveGitProfile({ ...old, syncState: 'LOCAL_DRIFT', lastPushedCommitSha: head })
    expect((await f.service().syncNow()).syncState).toBe('SYNCED')
    writeFile(f.human, 'skills/alpha/SKILL.md', pkg('unpublished legacy').skillMd)
    await gitExec(f.human, ['add', '.']); await gitExec(f.human, ['commit', '-m', 'unpublished work'])
    const legacy = await f.git.resolveCommit(f.human, 'HEAD')
    f.store.saveGitPublication({ ...f.sync.getStatus().publication!, migrationComplete: false })
    const blocked = await f.service().syncNow()
    expect(blocked.publication?.phase).toBe('CONFLICT')
    expect(await f.git.resolveCommit(blocked.repository!.checkoutPath, 'refs/academy/legacy-pending')).toBe(legacy)
    expect(await f.git.resolveCommit(f.human, 'HEAD')).toBe(legacy)
  }, 60000)
})
