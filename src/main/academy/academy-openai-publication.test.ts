import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { calculateOpenAiDelta, hashOpenAiSnapshot, nextOpenAiPluginVersion } from './publication/openai-plugin-model'
import { validateOpenAiPluginPackage } from './publication/openai-plugin-validator'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const skillMd = (name: string, body = 'v1') => `---\nname: ${name}\ndescription: Use ${name}.\n---\n\n# ${name}\n\n${body}\n`

function png(width = 512, height = 512): Buffer {
  const value = Buffer.alloc(24)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(value)
  value.writeUInt32BE(width, 16); value.writeUInt32BE(height, 20)
  return value
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'academy-openai-')); roots.push(root)
  const service = new AcademyService(join(root, 'academy', 'academy.db'), join(root, 'Downloads'))
  const global = await service.create({ package: { skillMd: skillMd('global-skill'), artifacts: { 'references/guide.md': 'guide' } }, scope: 'GLOBAL', origin: 'UI' })
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
  return { ...f, git, sync, transport, human, commit, bump, manifest }
}

describe('Academy Git-pinned plugin publication', () => {
  it('refuses unsafe authored metadata before ingestion and validates assets before reserving a release version', async () => {
    const f = await gitFixture()
    try {
      const first = await f.service.prepareOpenAiRelease({ mode: 'LATEST' })
      f.manifest.extensions['com.openai'].interface.logo = './assets/missing.png'
      f.bump('0.4.0'); await f.commit('missing authored asset')
      await expect(f.service.prepareOpenAiRelease({ mode: 'LATEST' })).rejects.toMatchObject({ code: 'OPENAI_PACKAGE_INVALID' })
      expect(f.service.store.listPluginPackageRevisions().some(item => item.version === '0.4.0')).toBe(false)
      expect(f.service.store.listOpenAiReleases().filter(item => !item.baseline)).toHaveLength(1)
      delete f.manifest.extensions['com.openai'].interface.logo
      f.manifest.description = 'sk-proj-' + 'x'.repeat(30)
      f.bump('0.4.1'); await f.commit('unsafe metadata')
      const accepted = f.service.store.getGitAuthority()!.processedCommitSha
      await expect(f.service.prepareOpenAiRelease({ mode: 'LATEST' })).rejects.toMatchObject({ code: 'GIT_SOURCE_LATEST_UNVERIFIED' })
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
      expect(f.service.getOpenAiPublicationState().currentPackageRevision?.version).toBe('0.2.0')
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
      await expect(f.service.prepareOpenAiRelease({ mode: 'LATEST' })).rejects.toThrow('database interrupted')
      expect(f.service.listOpenAiReleases().filter(release => !release.baseline)).toHaveLength(0)
      persist.mockRestore()
      const first = await f.service.prepareOpenAiRelease({ mode: 'LATEST' })
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
      const merged = await f.service.prepareOpenAiRelease({ mode: 'LATEST' })
      expect(merged.pluginVersion).toBe('0.2.2')
      expect(merged.snapshot.map(item => item.name).sort()).toEqual(['contribution', 'global-skill'])
      expect(merged.source?.sourceCommitSha).toBe(await f.git.resolveCommit(f.human, 'HEAD'))
      expect(f.service.get(f.global.id).currentVersion).toBe(2)
    } finally { await f.service.close() }
  }, 120000)

  it('refuses reused versions and dirty source, retains immutable receipts, and rebuilds verified commits offline', async () => {
    const f = await gitFixture()
    try {
      const first = await f.service.prepareOpenAiRelease({ mode: 'LATEST' })
      const receipts = f.service.store.listGitBuildReceipts(first.id)
      writeFile(f.human, 'skills/global-skill/SKILL.md', skillMd('global-skill', 'published changed content'))
      await f.commit('skill changed without version bump')
      await expect(f.service.prepareOpenAiRelease({ mode: 'LATEST' })).rejects.toMatchObject({ code: 'VERSION_REUSE_FOR_DIFFERENT_CONTENT' })
      expect(f.service.get(f.global.id).currentVersion).toBe(2)
      expect(f.service.getOpenAiPublicationState().sourceError).toBe('VERSION_REUSE_FOR_DIFFERENT_CONTENT')
      f.bump('0.2.1'); await f.commit('approved version bump')
      const newer = await f.service.prepareOpenAiRelease({ mode: 'LATEST' })
      expect(newer.pluginVersion).toBe('0.2.1')
      expect(newer.artifactHash).not.toBe(first.artifactHash)
      writeFile(f.human, 'README.md', 'An unrelated approved documentation change')
      await gitExec(f.human, ['add', '--', 'README.md'])
      const documentationHead = await f.commit('documentation only')
      const unchangedPackage = await f.service.prepareOpenAiRelease({ mode: 'LATEST' })
      expect(unchangedPackage.id).toBe(newer.id)
      expect(unchangedPackage.artifactHash).toBe(newer.artifactHash)
      expect(unchangedPackage.source!.sourceCommitSha).toBe(documentationHead)
      const sourceRoot = f.sync.getStatus().publication!.checkoutPath
      writeFile(sourceRoot, 'plugin.json', '{}')
      await expect(f.service.prepareOpenAiRelease({ mode: 'LATEST' })).rejects.toBeDefined()
      vi.spyOn(f.transport, 'fetch').mockRejectedValue(new Error('offline'))
      await expect(f.service.prepareOpenAiRelease({ mode: 'LATEST' })).rejects.toMatchObject({ code: 'GIT_SOURCE_LATEST_UNVERIFIED' })
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
      expect(() => f.service.openAiPublication.prepareGitRelease(cached)).toThrow('GIT_SOURCE_SNAPSHOT_NOT_VERIFIED')
    } finally { await f.service.close() }
  }, 120000)

  it('keeps destructive delta authorization separate from source confirmation and ZIP/upload states', async () => {
    const f = await gitFixture()
    try {
      await f.service.prepareOpenAiRelease({ mode: 'LATEST' })
      await gitExec(f.human, ['rm', '-r', 'skills/global-skill'])
      f.bump('0.3.0'); await f.commit('approved removal')
      const blocked = await f.service.prepareOpenAiRelease({ mode: 'LATEST' })
      expect(blocked).toMatchObject({ status: 'BLOCKED', artifactHash: null, source: { pluginVersion: '0.3.0', zipSha256: null } })
      expect(f.service.history(f.global.id)).toHaveLength(1)
      expect(f.service.store.listGitBuildReceipts(blocked.id)).toHaveLength(1)
      f.service.openAiPublication.recordDeletionSemantics('PROVEN_REPLACE', 'Explicitly demonstrated replace behavior')
      const ready = await f.service.prepareOpenAiRelease({ mode: 'LATEST' })
      expect(ready.id).toBe(blocked.id)
      expect(ready.status).toBe('READY_TO_UPLOAD')
      expect(ready.snapshot).toEqual([])
      expect(f.service.store.listGitBuildReceipts(blocked.id)[0].zipSha256).toBeNull()
      expect(f.service.confirmOpenAiUpload(ready.id, ready.artifactHash!).status).toBe('UPLOADED_UNVERIFIED')
      expect(f.service.openAiPublication.verifyRelease(ready.id, 'Manual verification').status).toBe('VERIFIED')
    } finally { await f.service.close() }
  }, 90000)
})

describe('Academy OpenAI plugin publication', () => {
  it('bootstraps the existing identity and creates a complete validated deterministic ZIP from canonical GLOBAL ACTIVE Skills', async () => {
    const { root, service } = await fixture()
    const release = service.prepareOpenAiRelease()
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
    const canonical = service.get(skill.id)
    try {
      const release = service.prepareOpenAiRelease()
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
    const prepared = service.prepareOpenAiRelease()
    await service.update({ skillId: global.id, expectedVersion: global.currentVersion, package: { skillMd: skillMd('global-skill', 'v2'), artifacts: { 'references/guide.md': 'guide' } }, origin: 'UI' })
    expect(service.getOpenAiRelease(prepared.id).status).toBe('STALE')
    expect(() => service.confirmOpenAiUpload(prepared.id, prepared.artifactHash!)).toThrow('OPENAI_RELEASE_NOT_CONFIRMABLE')
    const current = service.prepareOpenAiRelease()
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
    const blockedRemoval = service.prepareOpenAiRelease()
    expect(blockedRemoval).toMatchObject({ status: 'BLOCKED', blockedReason: 'DESTRUCTIVE_DELTA_UNKNOWN', artifactPath: null })
    expect(blockedRemoval.delta.removed.map((item) => item.name)).toEqual(['global-skill'])
    expect(blockedRemoval.snapshot).toEqual([])
    expect(readFileSync(join(root, 'installed/academy-skills/skills/global-skill/SKILL.md'), 'utf8')).toBe(global.current.package.skillMd)
    expect(service.getOpenAiPublicationState().latestUploaded?.status).not.toBe('VERIFIED')
    service.openAiPublication.recordDeletionSemantics('PROVEN_REPLACE', 'Disposable plugin removal probe passed.')
    const allowed = service.prepareOpenAiRelease()
    expect(allowed.status).toBe('READY_TO_UPLOAD')
    expect(allowed.pluginVersion).toBe('0.2.0')
    expect(readZipEntries(readFileSync(allowed.artifactPath!)).some(entry => entry.path.includes('/skills/global-skill/'))).toBe(false)
    await service.update({ skillId: global.id, expectedVersion: 1, package: { ...global.current.package, skillMd: skillMd(global.name, 'private latest') }, origin: 'UI' })
    expect(service.prepareOpenAiRelease().snapshot).toEqual([])
    await service.setEnabled(global.id, true, 2)
    expect(service.prepareOpenAiRelease().snapshot).toMatchObject([{ skillId: global.id, academyVersion: 2 }])
    service.close()

    const renamedFixture = await fixture()
    await renamedFixture.service.update({ skillId: renamedFixture.global.id, expectedVersion: 1, package: { skillMd: skillMd('renamed-skill'), artifacts: { 'references/guide.md': 'guide' } }, origin: 'UI' })
    const blockedRename = renamedFixture.service.prepareOpenAiRelease()
    expect(blockedRename.status).toBe('BLOCKED')
    expect(blockedRename.delta.renamed).toHaveLength(1)
    renamedFixture.service.close()
  })

  it('allows non-destructive additions while deletion semantics remain unknown', async () => {
    const { service } = await fixture()
    await service.create({ package: { skillMd: skillMd('added-skill'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
    const release = service.prepareOpenAiRelease()
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
      const release = service.prepareOpenAiRelease()
      const entries = readZipEntries(readFileSync(release.artifactPath!))
      entries.push({ path: 'academy-skills/' + path, data: Buffer.from('safe') })
      expect(() => validateOpenAiPluginPackage(entries, service.getOpenAiPublicationState().profile!, release.snapshot)).toThrow(/FORBIDDEN_COMPONENT|UNEXPECTED_FILE|INVALID_PATH/)
    } finally { service.close() }
  })

  it('persists profile, snapshots, hashes, destructive evidence, and confirmations across reopen', async () => {
    const { root, service } = await fixture()
    const release = service.prepareOpenAiRelease()
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
})
