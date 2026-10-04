import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AcademyService } from './academy-service'
import { readZipEntries, createDeterministicZip } from './publication/deterministic-zip'
import { calculateOpenAiDelta, hashOpenAiSnapshot, nextOpenAiPluginVersion } from './publication/openai-plugin-model'
import { validateOpenAiPluginPackage } from './publication/openai-plugin-validator'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

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
    const { service, global } = await fixture()
    await service.archive(global.id, global.currentVersion)
    const blockedRemoval = service.prepareOpenAiRelease()
    expect(blockedRemoval).toMatchObject({ status: 'BLOCKED', blockedReason: 'DESTRUCTIVE_DELTA_UNKNOWN', artifactPath: null })
    expect(blockedRemoval.delta.removed.map((item) => item.name)).toEqual(['global-skill'])
    service.openAiPublication.recordDeletionSemantics('PROVEN_REPLACE', 'Disposable plugin removal probe passed.')
    const allowed = service.prepareOpenAiRelease()
    expect(allowed.status).toBe('READY_TO_UPLOAD')
    expect(allowed.pluginVersion).toBe('0.2.0')
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
