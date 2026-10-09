import { afterEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { ArtifactStore } from './artifact-store'
import { ContinuumService } from './continuum-service'
import { fixture, markdown, withFixtureDatabase } from './continuum-test-fixtures'
import { inspectWebP, validateVisualMedia, VISUAL_MAX_BYTES } from './visual-media'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.reverse().forEach(close => close()); cleanup.length = 0 })
function setup() { const f = fixture(); cleanup.push(f.close); return f }
const visual = (extra = '') => markdown('Visual', extra).replace('kind: DECISION', 'kind: VISUAL_REFERENCE')
async function image(lossless = true) {
  const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 120, 140, 160, 255])
  return { pixels, data: await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } }).webp({ lossless }).toBuffer() }
}
describe('Visual Continuum persistence and validation', () => {
  it('roundtrips bytes/pixels/alpha across restart, deduplicates and preserves textual revisions', async () => {
    const f = setup(), { data, pixels } = await image()
    const receipt = await f.service.publishVisual(visual(), data)
    const second = await f.service.publishVisual(visual(), data)
    expect(second.artifactId).not.toBe(receipt.artifactId)
    const actual = f.service.getVisual(receipt.artifactId)
    expect(actual.data).toEqual(data)
    expect(await sharp(actual.data).ensureAlpha().raw().toBuffer()).toEqual(pixels)
    f.service.update(receipt.artifactId, 1, visual('status: VALIDATED\n'))
    expect(f.service.getVisual(receipt.artifactId).media).toEqual(receipt.media)
    expect(() => f.service.update(receipt.artifactId, 1, visual())).toThrow(/REVISION_CONFLICT/)
    expect(() => f.service.update(receipt.artifactId, 2, markdown())).toThrow(/IMMUTABLE_VISUAL_KIND/)
    withFixtureDatabase(f.path, db => {
      expect(db.prepare('SELECT count(*) AS n FROM visual_blobs').get()).toEqual({ n: 1 })
      expect(db.prepare('SELECT count(*) AS n FROM artifact_media').get()).toEqual({ n: 2 })
      expect(JSON.stringify(db.prepare('SELECT snapshot_json FROM artifact_revisions').all())).not.toContain(data.toString('base64'))
    })
    f.store.close()
    const reopened = new ArtifactStore(f.path, 'catalog-A'); cleanup.push(() => reopened.close())
    expect(reopened.getVisual(receipt.artifactId).data).toEqual(data)
    const other = setup()
    expect(() => other.service.getVisual(receipt.artifactId)).toThrow(/ARTIFACT_NOT_FOUND/)
  })
  it('rolls back invalid relations without artifacts, blobs or links, and rejects legacy forgery', async () => {
    const f = setup(), { data } = await image()
    await expect(f.service.publishVisual(visual('relations:\n  - artifactId: missing\n    kind: related-to\n'), data)).rejects.toThrow(/INVALID_RELATION/)
    expect(f.store.list().artifacts).toEqual([])
    withFixtureDatabase(f.path, db => {
      for (const table of ['visual_blobs', 'artifact_media', 'artifact_revisions']) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
    })
    expect(() => f.service.publish(visual())).toThrow(/RESERVED_VISUAL_METADATA/)
    expect(() => f.service.publish(markdown('Forged', 'media: {sha256: false}\n'))).toThrow(/RESERVED_VISUAL_METADATA/)
    const legacy = f.service.publish(markdown())
    expect(f.service.get(legacy.artifactId)?.rawMarkdown).toBe(markdown())
  })
  it('keeps discovery/text pixel-free, checks corruption, and fails closed after context change', async () => {
    const f = setup(), { data } = await image()
    const parent = f.service.publish(markdown())
    const receipt = await f.service.publishVisual(visual(`relations:\n  - artifactId: ${parent.artifactId}\n    kind: derived-from\n`), data)
    const page = f.service.list({ kind: 'VISUAL_REFERENCE', relatedToArtifactId: parent.artifactId })
    expect(page.artifacts.map(item => item.artifactId)).toEqual([receipt.artifactId])
    expect(JSON.stringify(page)).not.toMatch(/media|base64|data/)
    expect(JSON.stringify(f.service.get(receipt.artifactId))).not.toContain(data.toString('base64'))
    let active = true
    const guarded = new ContinuumService(f.store, undefined, () => active)
    const pending = guarded.publishVisual(visual(), data); active = false
    await expect(pending).rejects.toThrow(/REPOSITORY_CONTEXT_CHANGED/)
    withFixtureDatabase(f.path, db => { db.prepare('UPDATE visual_blobs SET data = ?').run(Buffer.from('corrupt')) }, false)
    expect(() => f.service.getVisual(receipt.artifactId)).toThrow(/VISUAL_INTEGRITY_ERROR/)
  })
  it('rejects lossy/disguised/truncated/oversized input and unsafe chunks before decode', async () => {
    const { data } = await image()
    await expect(validateVisualMedia((await image(false)).data)).rejects.toThrow(/INVALID_VISUAL_MEDIA/)
    for (const invalid of [Buffer.from('JPEG'), Buffer.from([137, 80, 78, 71]), data.subarray(0, data.length - 1), Buffer.alloc(VISUAL_MAX_BYTES + 1)]) expect(() => inspectWebP(invalid)).toThrow()
    for (const tag of ['ANIM', 'EXIF', 'XMP ', 'JUNK']) {
      const extra = Buffer.alloc(8); extra.write(tag)
      const invalid = Buffer.concat([data, extra]); invalid.writeUInt32LE(invalid.length - 8, 4)
      expect(() => inspectWebP(invalid)).toThrow(/INVALID_VISUAL_MEDIA/)
    }
    const tooWide = Buffer.from(data)
    const offset = tooWide.indexOf('VP8L') + 9
    tooWide.writeUInt32LE((tooWide.readUInt32LE(offset) & 0xffffc000) | 4096, offset)
    expect(() => inspectWebP(tooWide)).toThrow(/VISUAL_DIMENSION_LIMIT/)
    const tooManyPixels = Buffer.from(data)
    tooManyPixels.writeUInt32LE(4095 | (4095 << 14), offset)
    expect(() => inspectWebP(tooManyPixels)).toThrow(/VISUAL_DIMENSION_LIMIT/)
    const invalidPixels = Buffer.from(data.subarray(0, 26))
    invalidPixels.writeUInt32LE(invalidPixels.length - 8, 4)
    invalidPixels.writeUInt32LE(invalidPixels.length - 20, 16)
    await expect(validateVisualMedia(invalidPixels)).rejects.toThrow(/INVALID_VISUAL_MEDIA/)
  })
  it('preserves valid ICC bytes and rejects incompatible or malformed profiles', async () => {
    const { data } = await image()
    const profiled = await sharp(data).withIccProfile('srgb').webp({ lossless: true }).toBuffer()
    const media = await validateVisualMedia(profiled)
    const f = setup(), receipt = await f.service.publishVisual(visual(), profiled)
    expect(f.service.getVisual(receipt.artifactId).data).toEqual(profiled)
    expect(media.width).toBe(2)
    const malformed = Buffer.from(profiled)
    const profile = malformed.indexOf('ICCP') + 8
    malformed.write('CMYK', profile + 16)
    await expect(validateVisualMedia(malformed)).rejects.toThrow(/INVALID_VISUAL_MEDIA/)
    const broken = Buffer.from(profiled)
    broken.writeUInt32BE(0xffffffff, profile + 128)
    await expect(validateVisualMedia(broken)).rejects.toThrow(/INVALID_VISUAL_MEDIA/)
  })
})
