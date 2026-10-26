import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import sharp from 'sharp'
import { ArtifactStore } from '../../continuum/artifact-store'
import { ContinuumService } from '../../continuum/continuum-service'
import { markdown, legacyEnvelope, legacyDatabase } from '../../continuum/continuum-test-fixtures'
import { ArtifactInbox } from '../../continuum/artifact-inbox'
import { RepositoryCatalogStore } from '../../repository-catalog/repository-catalog-store'
import { RepositoryContinuumSession } from '../../continuum/project-continuum-session'
import { RepositoryPreviewContextProvisioner, previewCorpusPath, previewCatalogPath } from './context-data'
import { bytesFingerprint, type PreviewProfile } from '../preview-profile'
import { PreviewStartClock } from './start-timing'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.reverse().forEach(fn => fn()); cleanup.length = 0 })
function setup(policy: 'EMPTY' | 'REPOSITORY_SNAPSHOT' = 'REPOSITORY_SNAPSHOT') {
  const root = mkdtempSync(join(tmpdir(), 'preview-context-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, 'runtime'), worktree = join(root, 'checkout'), host = join(root, 'host')
  mkdirSync(directory); mkdirSync(worktree)
  const file = previewCorpusPath(host, 'logical-repository')
  const store = new ArtifactStore(file, 'logical-repository'); cleanup.push(() => store.close())
  const service = new ContinuumService(store)
  const provisioner = new RepositoryPreviewContextProvisioner({ resolveAvailable: () => ({ id: 'logical-repository', name: 'Selected', status: 'ACTIVE', localCheckout: { path: worktree, availability: 'AVAILABLE', gitState: 'GIT' }, github: null, createdAt: '', updatedAt: '' }) }, join(host, 'continuum'))
  const profile = { revision: 1, repositoryId: 'logical-repository', adapter: { kind: 'ELECTRON' }, bootstrap: { kind: 'CODE_AWARENESS', dataPolicy: policy, maxBytes: 8 * 1048576, maxArtifacts: 20 } } as PreviewProfile
  const input = { profile, selection: { repositoryId: 'logical-repository', worktreeId: 'tree', generation: 'generation', profileId: 'profile', fingerprint: 'a'.repeat(64) },
    sessionId: randomUUID(), directory, worktree, source: { head: 'head', branch: 'branch', indexRevision: 'index', worktreeRevision: 'files', dirty: false } }
  return { root, directory, worktree, host, store, service, provisioner, input, file }
}
describe('private preview corpus provisioning with real SQLite', () => {
  it.each(['before', 'backup'])('cancels %s preparation without exposing a completed corpus or retaining SQLite handles', async when => {
    const f = setup(), controller = new AbortController(), timing = new PreviewStartClock()
    f.service.publish(markdown('Canonical remains intact'))
    const before = f.service.get(f.service.list().artifacts[0].artifactId)
    const measure = timing.measure.bind(timing)
    timing.measure = async (stage, work) => {
      if (stage === 'context_backup') controller.abort(new Error('PREPARATION_CANCELLED'))
      return measure(stage, work)
    }
    if (when === 'before') controller.abort(new Error('PREPARATION_CANCELLED'))
    await expect(f.provisioner.prepare({ ...f.input, timing, signal: controller.signal })).rejects.toThrow('PREPARATION_CANCELLED')
    expect(f.service.get(before!.artifactId)).toEqual(before)
    rmSync(f.directory, { recursive: true }); expect(existsSync(f.directory)).toBe(false)
  })
  it('backs up committed WAL, revisions and actual media; retains logical identity and isolates writes', async () => {
    const f = setup()
    f.service.mutateTags({ repositoryId: 'logical-repository', intent: 'create', tag: { slug: 'canonical', name: 'Canonical' } })
    const receipt = f.service.publishHuman(markdown('Selected', 'tags: [canonical]\n'), true)
    const image = await sharp({ create: { width: 2, height: 2, channels: 4, background: 'red' } }).webp({ lossless: true }).toBuffer()
    const visual = await f.service.publishVisual(markdown('Image').replace('kind: DECISION', 'kind: VISUAL_REFERENCE'), image)
    f.service.update(receipt.artifactId, 1, markdown('Selected revision 2', 'tags: [canonical]\n'))
    expect(existsSync(f.file + '-wal')).toBe(true)
    const before = [f.file, f.file + '-wal'].map(file => bytesFingerprint(readFileSync(file)))
    const manifest = await f.provisioner.prepare(f.input)
    expect(manifest.data).toMatchObject({ policy: 'REPOSITORY_SNAPSHOT', artifacts: 2, media: 1, repositoryId: 'logical-repository' })
    const catalog = new RepositoryCatalogStore(previewCatalogPath(join(f.directory, 'userData')))
    try { expect(catalog.list()).toMatchObject([{ id: 'logical-repository', localCheckout: { path: f.worktree } }]); expect(catalog.isLegacyMigrationComplete()).toBe(true) } finally { catalog.close() }
    const copy = new ArtifactStore(previewCorpusPath(join(f.directory, 'userData'), 'logical-repository'), 'logical-repository')
    try {
      const service = new ContinuumService(copy)
      expect(service.get(receipt.artifactId)?.revision).toBe(2)
      expect(service.getVisual(visual.artifactId).data).toEqual(image)
      expect(service.tags()).toMatchObject([{ slug: 'canonical', count: 1 }])
      expect(service.list({ tag: 'canonical' }).artifacts.map(artifact => artifact.artifactId)).toEqual([receipt.artifactId])
      expect(() => service.update(receipt.artifactId, 2, markdown('Private only', 'tags: [preview]\n'))).toThrow('HUMAN_TAG_AUTHORSHIP_REQUIRED')
      service.update(receipt.artifactId, 2, markdown('Private only', 'tags: [canonical]\n'))
      expect(f.service.get(receipt.artifactId)?.metadata.name).toBe('Selected revision 2')
    } finally { copy.close() }
    expect([f.file, f.file + '-wal'].map(file => bytesFingerprint(readFileSync(file)))).toEqual(before)
  })
  it('EMPTY does not read canonical data and never ingests checkout inbox or legacy data', async () => {
    const f = setup('EMPTY'); f.service.publish(markdown('Canonical must remain absent'))
    const manifest = await f.provisioner.prepare(f.input)
    new ArtifactInbox(f.worktree).write(legacyEnvelope(f.worktree))
    legacyDatabase(join(f.directory, 'userData', 'continuum'), f.worktree)
    const catalog = new RepositoryCatalogStore(previewCatalogPath(join(f.directory, 'userData')))
    const session = new RepositoryContinuumSession(join(f.directory, 'userData', 'continuum'), { findByPath: () => catalog.get('logical-repository') }, { ingestCheckout: false })
    try {
      expect(session.activate(f.worktree)).toMatchObject({ discovered: 0, ingested: 0 })
      expect(manifest.data).toMatchObject({ policy: 'EMPTY', artifacts: 0, media: 0 })
      expect(session.getActiveService()!.list().artifacts).toEqual([])
      expect(session.activate(f.worktree).discovered).toBe(0)
    } finally { session.dispose(); catalog.close() }
  })
  it.each(['schema', 'scope', 'hash', 'limits', 'media'])('fails closed for %s without mutating source', async fault => {
    const f = setup(); f.service.publish(markdown('Original'))
    if (fault === 'media') {
      const image = await sharp({ create: { width: 2, height: 2, channels: 4, background: 'red' } }).webp({ lossless: true }).toBuffer()
      await f.service.publishVisual(markdown('Image').replace('kind: DECISION', 'kind: VISUAL_REFERENCE'), image)
    }
    const db = new Database(f.file)
    try {
      if (fault === 'schema') db.exec('CREATE TABLE unexpected_credentials(token TEXT)')
      if (fault === 'scope') db.exec("UPDATE repository_scope SET repository_id='another-repository'")
      if (fault === 'hash') db.exec("UPDATE artifacts SET content_hash='incorrect'")
      if (fault === 'limits') f.input.profile.bootstrap!.maxArtifacts = 0
      if (fault === 'media') db.exec("UPDATE visual_blobs SET data=X'00'")
    } finally { db.close() }
    const before = bytesFingerprint(readFileSync(f.file + '-wal'))
    await expect(f.provisioner.prepare(f.input)).rejects.toThrow(/PREVIEW_DATA_(SCHEMA_INCOMPATIBLE|SCOPE_MISMATCH|CONTENT_CORRUPT|LIMIT_EXCEEDED|INTEGRITY_FAILED)/)
    expect(bytesFingerprint(readFileSync(f.file + '-wal'))).toBe(before)
  })
  it('does not copy other repositories, secrets or host identity and refuses an existing destination', async () => {
    const f = setup(); f.service.publish(markdown('Selected'))
    const otherFile = previewCorpusPath(f.host, 'other-repository'), other = new ArtifactStore(otherFile, 'other-repository')
    try { new ContinuumService(other).publish(markdown('Other repository')) } finally { other.close() }
    await f.provisioner.prepare(f.input)
    const userData = join(f.directory, 'userData')
    expect(existsSync(previewCorpusPath(userData, 'other-repository'))).toBe(false)
    for (const name of ['installation', 'github', 'settings.json', 'academy', 'channel']) expect(existsSync(join(userData, name))).toBe(false)
    await expect(f.provisioner.prepare(f.input)).rejects.toThrow('PREVIEW_DATA_DESTINATION_EXISTS')
    const db = new Database(previewCorpusPath(userData, 'logical-repository'), { readonly: true })
    try { expect(db.prepare('SELECT * FROM artifact_structure_key').all()).toEqual([]); expect(db.prepare('SELECT * FROM repository_locators').all()).toEqual([]) } finally { db.close() }
  })
})
