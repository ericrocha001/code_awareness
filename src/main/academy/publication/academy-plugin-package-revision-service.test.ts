import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AcademyStore } from '../academy-store'
import { buildCanonicalOpenAiSnapshot, buildOpenAiManifest, calculateOpenAiDelta, hashOpenAiSnapshot } from './openai-plugin-model'
import { AcademyPluginPackageRevisionService } from './academy-plugin-package-revision-service'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'academy-package-revision-'))
  roots.push(root)
  const store = new AcademyStore(join(root, 'academy.db'))
  const logoPath = join(root, 'logo.png')
  writeFileSync(logoPath, Buffer.from('logo-v1'))
  store.create({
    package: { skillMd: '---\nname: alpha\ndescription: Alpha\n---\n# Alpha\n', artifacts: {} },
    scope: 'GLOBAL', origin: 'IMPORT'
  })
  const profile = store.createOpenAiPluginProfile({
    name: 'academy-skills', displayName: 'Academy Skills', description: 'Academy skills',
    author: { name: 'Academy' },
    openAiInterface: { displayName: 'Academy Skills', shortDescription: 'Procedural skills maintained by the Academy' },
    logoPath, publishedVersion: '0.1.4', deletionSemantics: 'UNKNOWN', deletionSemanticsEvidence: null
  })
  const snapshot = buildCanonicalOpenAiSnapshot(store)
  store.insertOpenAiRelease({
    id: 'baseline', pluginVersion: '0.1.3', createdAt: '2026-09-23T00:00:00.000Z', referenceReleaseId: null,
    snapshot, snapshotHash: hashOpenAiSnapshot(snapshot), delta: calculateOpenAiDelta([], snapshot),
    manifest: buildOpenAiManifest(profile, '0.1.3'), artifactPath: null, artifactHash: null,
    status: 'UPLOADED_UNVERIFIED', blockedReason: null, baseline: true, uploadConfirmation: null, verificationEvidence: 'baseline'
  })
  store.insertOpenAiRelease({
    id: 'published', pluginVersion: '0.1.4', createdAt: '2026-09-24T00:00:00.000Z', referenceReleaseId: 'baseline',
    snapshot, snapshotHash: hashOpenAiSnapshot(snapshot), delta: calculateOpenAiDelta(snapshot, snapshot),
    manifest: buildOpenAiManifest(profile, '0.1.4'), artifactPath: null, artifactHash: null,
    status: 'VERIFIED', blockedReason: null, baseline: false, uploadConfirmation: null, verificationEvidence: 'published'
  })
  return { store, logoPath }
}

describe('AcademyPluginPackageRevisionService', () => {
  it('bootstraps 0.1.4 without an infrastructure bump and reuses identical content', () => {
    const { store } = setup()
    const service = new AcademyPluginPackageRevisionService(store)
    const baseline = service.bootstrapBaseline()

    expect(baseline.version).toBe('0.1.4')
    expect(service.resolveCurrent()).toEqual(baseline)
    expect(store.getCurrentPluginPackageRevision()).toEqual(baseline)
    store.close()
  })

  it('uses PATCH for metadata or asset changes and MINOR for adding a skill', () => {
    const { store, logoPath } = setup()
    const service = new AcademyPluginPackageRevisionService(store)
    service.bootstrapBaseline()

    const profile = store.getOpenAiPluginProfile()!
    store.setOpenAiInterface({ ...profile.openAiInterface, shortDescription: 'Academy procedural skills' })
    const metadataRevision = service.resolveCurrent()
    expect(metadataRevision.version).toBe('0.1.5')
    expect(service.resolveCurrent().id).toBe(metadataRevision.id)

    writeFileSync(logoPath, Buffer.from('logo-v2'))
    expect(service.resolveCurrent().version).toBe('0.1.6')

    store.create({
      package: { skillMd: '---\nname: beta\ndescription: Beta\n---\n# Beta\n', artifacts: {} },
      scope: 'GLOBAL', origin: 'UI'
    })
    expect(service.resolveCurrent().version).toBe('0.2.0')
    store.close()
  })

  it('repairs only the current incomplete bootstrap revision anchored to the published version', () => {
    const { store } = setup()
    const service = new AcademyPluginPackageRevisionService(store)
    const correct = service.bootstrapBaseline()
    const snapshot = store.getPluginPackageRevisionSnapshot(correct.id)
    store.replaceCurrentPluginPackageRevision('0.1.4', {
      ...correct,
      id: 'incomplete-migration',
      contentFingerprint: 'wrong-content',
      profileFingerprint: 'wrong-profile'
    }, snapshot)

    const repaired = service.bootstrapBaseline()
    expect(repaired.version).toBe('0.1.4')
    expect(repaired.contentFingerprint).toBe(correct.contentFingerprint)
    store.close()
  })

  it('recovers when initialization stopped after persisting the older historical baseline', () => {
    const { store } = setup()
    const service = new AcademyPluginPackageRevisionService(store)
    const published = service.bootstrapBaseline()
    const snapshot = store.getPluginPackageRevisionSnapshot(published.id)
    store.replaceCurrentPluginPackageRevision('0.1.4', {
      ...published,
      id: 'interrupted-bootstrap',
      version: '0.1.3'
    }, snapshot)

    expect(service.bootstrapBaseline()).toMatchObject({
      version: '0.1.4',
      contentFingerprint: published.contentFingerprint
    })
    store.close()
  })
})
