import { afterEach, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { fixture, markdown } from './continuum-test-fixtures'
import { ContextBundle } from './context-bundle'
import { countCanonicalTokens } from '../core/tokenizer'
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.reverse().forEach(close => close()); cleanups.length = 0 })
function setup() {
  const f = fixture(); cleanups.push(f.close)
  f.service.mutateTags({ repositoryId: 'catalog-A', intent: 'create', tag: { slug: 'architecture', name: 'Architecture' } })
  return f
}
const request = { repositoryId: 'catalog-A', slug: 'architecture' }
function unzip(data: Buffer): Map<string, Buffer> {
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = data.readUInt16LE(end + 10), files = new Map<string, Buffer>()
  let position = data.readUInt32LE(end + 16)
  for (let i = 0; i < count; i++) {
    expect(data.readUInt32LE(position)).toBe(0x02014b50)
    const method = data.readUInt16LE(position + 10), size = data.readUInt32LE(position + 20), nameLength = data.readUInt16LE(position + 28), extra = data.readUInt16LE(position + 30), comment = data.readUInt16LE(position + 32), local = data.readUInt32LE(position + 42)
    const name = data.toString('utf8', position + 46, position + 46 + nameLength)
    const offset = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28)
    const bytes = data.subarray(offset, offset + size)
    files.set(name, method === 0 ? bytes : inflateRawSync(bytes))
    position += 46 + nameLength + extra + comment
  }
  return files
}
it('creates an extractable ZIP with the same context, manifest and original WebP, loading no pixels for preview', async () => {
  const f = setup()
  const data = await sharp({ create: { width: 20, height: 10, channels: 4, background: '#ff000080' } }).webp({ lossless: true }).toBuffer()
  const visual = await f.service.publishVisual(markdown('Visual').replace('kind: DECISION', 'kind: VISUAL_REFERENCE'), data)
  f.service.mutateTags({ repositoryId: 'catalog-A', intent: 'assign', slug: 'architecture', selected: [{ artifactId: visual.artifactId, expectedRevision: 1 }], assigned: true, confirmed: true })
  const media = vi.spyOn(f.service, 'getVisual'), bundle = ContextBundle.prepare(f.service, request)
  expect(media).not.toHaveBeenCalled()
  const files = unzip(await bundle.zip())
  expect(files.get('context.md')!.toString('utf8')).toBe(bundle.preview.markdown)
  expect(files.get(`media/${visual.artifactId}.webp`)).toEqual(data)
  const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'))
  expect(manifest.snapshotId).toBe(bundle.preview.snapshotId)
  expect(manifest.artifacts[0]).toMatchObject({ artifactId: visual.artifactId, revision: 2, kind: 'VISUAL_REFERENCE', media: { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') } })
  expect([...files.keys()]).toHaveLength(3)
  expect(f.service.getVisual(visual.artifactId).data).toEqual(data)
})
it('rejects oversized media and context changes during asynchronous ZIP generation without a partial result', async () => {
  const f = setup()
  const data = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#000000' } }).webp({ lossless: true }).toBuffer()
  const visual = await f.service.publishVisual(markdown('Visual').replace('kind: DECISION', 'kind: VISUAL_REFERENCE'), data)
  f.service.mutateTags({ repositoryId: 'catalog-A', intent: 'assign', slug: 'architecture', selected: [{ artifactId: visual.artifactId, expectedRevision: 1 }], assigned: true, confirmed: true })
  const bundle = ContextBundle.prepare(f.service, request), original = f.service.getVisual(visual.artifactId)
  const spy = vi.spyOn(f.service, 'getVisual').mockReturnValueOnce({ ...original, data: Buffer.alloc(64 * 1024 * 1024) })
  await expect(bundle.zip()).rejects.toThrow('BUNDLE_LIMIT')
  spy.mockRestore()
  const pending = bundle.zip(), source = f.service.get(visual.artifactId)!
  f.service.update(source.artifactId, source.revision, source.rawMarkdown + '\nConcurrent update')
  await expect(pending).rejects.toThrow('BUNDLE_SNAPSHOT_STALE')
})
it('resolves the whole tag beyond the visible timeline and preserves literal sources and declared token accounting', () => {
  const f = setup()
  const raw = '\uFEFF---\r\nname: Literal\r\ndescription: d\r\nkind: DOCUMENT\r\ntags: [architecture]\r\n---\r\n# ç 日本語 🚀\r\n```ts\r\n${literal}\r\n```\r\n'
  const ids = Array.from({ length: 3 }, () => f.service.publishHuman(raw, true).artifactId)
  for (let i = 0; i < 35; i++) f.service.publish(markdown('Unrelated ' + i))
  expect(f.service.list({ limit: 30 }).artifacts.every(item => !ids.includes(item.artifactId))).toBe(true)
  const bundle = ContextBundle.prepare(f.service, request)
  expect(bundle.preview.members.map(item => item.artifactId)).toEqual([...ids].sort())
  expect(bundle.preview.markdown.split(raw)).toHaveLength(4)
  expect(bundle.preview.markdownBytes).toBe(Buffer.byteLength(bundle.preview.markdown))
  expect(bundle.preview.tokenCount).toBe(countCanonicalTokens(bundle.preview.markdown).tokenCount)
  expect(bundle.preview.tokenizerEncoding).toBe('cl100k_base')
  expect(bundle.preview).not.toHaveProperty('objective')
  expect(bundle.preview.markdown).not.toContain('\nObjective:')
  expect(() => ContextBundle.prepare(f.service, Object.assign({}, request, { objective: 'Removed' }))).toThrow('INVALID_BUNDLE_REQUEST')
  expect(f.service.get(ids[0])!.rawMarkdown).toBe(raw)
  const reordered = ContextBundle.prepare(f.service, { ...request, order: [...ids].reverse() })
  expect(reordered.preview.members.map(item => item.artifactId)).toEqual([...ids].reverse())
})
it('regenerates current revisions and membership, and refuses exporting a stale snapshot', () => {
  const f = setup(), one = f.service.publishHuman(markdown('One', 'tags: [architecture]\n'), true)
  const two = f.service.publishHuman(markdown('Two', 'tags: [architecture]\n'), true)
  const first = ContextBundle.prepare(f.service, request)
  const source = f.service.get(one.artifactId)!
  f.service.update(one.artifactId, 1, source.rawMarkdown + '\nUpdated')
  expect(() => first.assertFresh()).toThrow('BUNDLE_SNAPSHOT_STALE')
  const second = ContextBundle.prepare(f.service, request)
  expect(second.preview.members.find(item => item.artifactId === one.artifactId)!.revision).toBe(2)
  f.service.mutateTags({ repositoryId: 'catalog-A', intent: 'assign', slug: 'architecture', selected: [{ artifactId: two.artifactId, expectedRevision: 1 }], assigned: false, confirmed: true })
  expect(() => second.assertFresh()).toThrow('BUNDLE_SNAPSHOT_STALE')
  expect(ContextBundle.prepare(f.service, { ...request, order: [two.artifactId] }).preview.members.map(item => item.artifactId)).toEqual([one.artifactId])
})
it('includes all 35 members, fails explicitly at 51 and enforces the composed Markdown cap without truncation', () => {
  const f = setup()
  for (let i = 0; i < 35; i++) f.service.publishHuman(markdown('Tagged ' + i, 'tags: [architecture]\n'), true)
  expect(ContextBundle.prepare(f.service, request).preview.members).toHaveLength(35)
  for (let i = 35; i < 51; i++) f.service.publishHuman(markdown('Tagged ' + i, 'tags: [architecture]\n'), true)
  expect(() => ContextBundle.prepare(f.service, request)).toThrow('BUNDLE_LIMIT')
  const large = setup()
  large.service.publishHuman(markdown('Large', 'tags: [architecture]\n', 'x'.repeat(8 * 1024 * 1024)), true)
  expect(() => ContextBundle.prepare(large.service, request)).toThrow('BUNDLE_LIMIT')
})
it('represents empty tags honestly and denies unknown tags, unsafe slugs and repository context changes', () => {
  const f = setup()
  expect(ContextBundle.prepare(f.service, request).preview.members).toEqual([])
  expect(() => ContextBundle.prepare(f.service, { ...request, slug: '../escape' })).toThrow('INVALID_TAG_SLUG')
  expect(() => ContextBundle.prepare(f.service, { ...request, slug: 'unknown' })).toThrow('TAG_NOT_FOUND')
  const bundle = ContextBundle.prepare(f.service, request)
  f.service.mutateTags({ repositoryId: 'catalog-A', intent: 'delete', slug: 'architecture' })
  expect(() => bundle.assertFresh()).toThrow('BUNDLE_SNAPSHOT_STALE')
})
