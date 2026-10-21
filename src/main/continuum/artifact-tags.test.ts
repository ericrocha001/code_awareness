import { afterEach, expect, it } from 'vitest'
import sharp from 'sharp'
import Database from 'better-sqlite3'
import { fixture, markdown, withFixtureDatabase } from './continuum-test-fixtures'
import { ArtifactStore } from './artifact-store'
import { editArtifactTags } from './artifact-tags'
import { parseArtifactMarkdown } from './artifact-metadata'
import { executeListArtifacts, executePublishArtifact, executeUpdateArtifact } from './continuum-mcp'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.reverse().forEach(close => close()); cleanup.length = 0 })
function setup() { const f = fixture(); cleanup.push(f.close); return f }
const tag = (slug: string) => ({ slug, name: slug, color: '#7852ee', description: 'Human purpose' })
const createTag = (f: ReturnType<typeof setup>, slug: string) => f.service.mutateTags({ repositoryId: 'catalog-A', intent: 'create', tag: tag(slug) })
const assign = (f: ReturnType<typeof setup>, slug: string, artifactId: string, expectedRevision: number, assigned = true) => f.service.mutateTags({ repositoryId: 'catalog-A', intent: 'assign', slug, selected: [{ artifactId, expectedRevision }], assigned, confirmed: true })

it('edits only the tags node, preserving unknown YAML, comments, Unicode, BOM and literal body', () => {
  const body = '\r\n# ç 🚀\r\n```yaml\r\ntags: untouched\r\n```\r\n'
  for (const field of ['tags: [old] # keep', '"tags":\r\n  - old', 'tags: []']) {
    const raw = '\uFEFF---\r\nname: "Quoted" # stable\r\ndescription: d\r\nkind: DOCUMENT\r\nunknown: {nested: true}\r\n' + field + '\r\n---\r\n' + body
    const next = editArtifactTags(raw, ['architecture', 'onboarding'])
    expect(parseArtifactMarkdown(next).body).toBe(body)
    expect(next.startsWith('\uFEFF---\r\nname: "Quoted" # stable')).toBe(true)
    expect(next).toContain('unknown: {nested: true}')
    expect(parseArtifactMarkdown(next).metadata.tags).toEqual(['architecture', 'onboarding'])
    if (field.includes('# keep')) expect(next).toContain('# keep')
  }
  const flow = '---\n{"name":"JSON", "description":"d", "kind":"DOCUMENT"}\n---\n# exact'
  expect(parseArtifactMarkdown(editArtifactTags(flow, ['architecture'])).metadata.tags).toEqual(['architecture'])
})

it('queries membership independently of exact array equality, composes filters and paginates through restart', () => {
  const f = setup(); createTag(f, 'architecture'); createTag(f, 'onboarding')
  for (let i = 0; i < 35; i++) f.service.publishHuman(markdown('Tagged item ' + i, 'tags: [architecture, onboarding]\nstatus: PENDING\n'), true)
  let cursor: string | undefined; const ids: string[] = []
  do { const page = f.service.list({ tag: 'architecture', query: 'Tagged', status: 'PENDING', metadata: { kind: 'DECISION' }, limit: 7, cursor }); ids.push(...page.artifacts.map(a => a.artifactId)); cursor = page.nextCursor } while (cursor)
  expect(new Set(ids).size).toBe(35)
  expect(f.service.list({ tag: 'onboarding', limit: 100 }).artifacts).toHaveLength(35)
  expect(f.service.list({ metadata: { tags: ['architecture'] } }).artifacts).toHaveLength(0)
  expect(JSON.parse(executeListArtifacts(f.service, { tag: 'architecture' }).content[0].text).count).toBe(20)
  const current = f.service.get(ids[0])!
  f.service.update(current.artifactId, current.revision, current.rawMarkdown + '\nRevision body')
  expect(f.service.list({ tag: 'architecture', limit: 100 }).artifacts).toHaveLength(35)
  f.store.close()
  const reopened = new ArtifactStore(f.path, 'catalog-A'); cleanup.push(() => reopened.close())
  expect(reopened.tags().find(t => t.slug === 'architecture')!.count).toBe(35)
  expect(reopened.list({ tag: 'onboarding', limit: 100 }).artifacts).toHaveLength(35)
  withFixtureDatabase(f.path, db => expect(db.prepare('SELECT count(*) AS n FROM continuum_tag_migrations').get()).toEqual({ n: 1 }))
})

it('enforces human authorship through MCP and service/CLI paths while allowing text revisions preserving tags', () => {
  const f = setup(); createTag(f, 'architecture')
  const raw = markdown('Human', 'tags: [architecture]\n')
  expect(() => f.service.publish(raw)).toThrow('HUMAN_TAG_AUTHORSHIP_REQUIRED')
  expect(executePublishArtifact(f.service, { rawMarkdown: raw }).isError).toBe(true)
  expect(() => f.service.publishHuman(raw)).toThrow('TAGS_CONFIRMATION_REQUIRED')
  const receipt = f.service.publishHuman(raw, true)
  expect(executeUpdateArtifact(f.service, { artifactId: receipt.artifactId, expectedRevision: 1, rawMarkdown: markdown('Removed') }).isError).toBe(true)
  expect(() => f.service.update(receipt.artifactId, 1, raw.replace('[architecture]', '[other]'))).toThrow('HUMAN_TAG_AUTHORSHIP_REQUIRED')
  expect(f.service.update(receipt.artifactId, 1, raw + '\nAgent text').revision).toBe(2)
  expect(() => f.service.importArtifact('agent-inbox', { artifactId: 'injected', metadata: parseArtifactMarkdown(raw).metadata, rawMarkdown: raw })).toThrow('HUMAN_TAG_AUTHORSHIP_REQUIRED')
  expect(() => f.service.publishHuman(raw.replace('[architecture]', '[unknown]'), true)).toThrow('TAG_NOT_FOUND')
})

it('uses all-or-nothing CAS for explicit selections and refuses deletion in use or invalid slugs', () => {
  const f = setup(); createTag(f, 'architecture')
  const one = f.service.publish(markdown('One')), two = f.service.publish(markdown('Two'))
  expect(() => f.service.mutateTags({ repositoryId: 'catalog-A', intent: 'assign', slug: 'architecture', selected: [{ artifactId: one.artifactId, expectedRevision: 1 }, { artifactId: two.artifactId, expectedRevision: 99 }], assigned: true, confirmed: true })).toThrow('REVISION_CONFLICT')
  expect(f.service.get(one.artifactId)!.revision).toBe(1)
  assign(f, 'architecture', one.artifactId, 1)
  expect(() => f.service.mutateTags({ repositoryId: 'catalog-A', intent: 'delete', slug: 'architecture' })).toThrow('TAG_IN_USE')
  f.service.mutateTags({ repositoryId: 'catalog-A', intent: 'edit', tag: { ...tag('architecture'), name: 'Architecture renamed', color: '#112233' } })
  expect(f.service.get(one.artifactId)!.metadata.tags).toEqual(['architecture'])
  assign(f, 'architecture', one.artifactId, 2, false)
  f.service.mutateTags({ repositoryId: 'catalog-A', intent: 'delete', slug: 'architecture' })
  expect(f.service.tags()).toEqual([])
  for (const slug of ['../escape', 'Upper Case', '__proto__', 'a--b', 'constructor']) expect(() => createTag(f, slug)).toThrow('INVALID_TAG_SLUG')
})

it('keeps visual binary identity and revision contracts while updating contextual tags', async () => {
  const f = setup(); createTag(f, 'architecture')
  const data = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ff000080' } }).webp({ lossless: true }).toBuffer()
  const receipt = await f.service.publishVisual(markdown('Visual').replace('kind: DECISION', 'kind: VISUAL_REFERENCE'), data)
  assign(f, 'architecture', receipt.artifactId, 1)
  const visual = f.service.getVisual(receipt.artifactId)
  expect(visual.data).toEqual(data); expect(visual.media.sha256).toBe(receipt.media.sha256)
  expect(visual.artifact.metadata.tags).toEqual(['architecture'])
  const other = setup(); expect(other.service.list({ tag: 'architecture' }).artifacts).toEqual([])
  expect(other.service.tags()).toEqual([])
})

it('backfills existing YAML membership once and preserves the catalog across reopen', () => {
  const f = setup()
  const raw = markdown('Historical', 'tags: [historical]\n')
  f.store.create({ artifactId: 'historical', rawMarkdown: raw, metadata: parseArtifactMarkdown(raw).metadata })
  const db = new Database(f.path)
  db.prepare('DELETE FROM artifact_tags').run(); db.prepare('DELETE FROM continuum_tag_migrations').run(); db.close()
  f.store.close()
  const reopened = new ArtifactStore(f.path, 'catalog-A'); cleanup.push(() => reopened.close())
  expect(reopened.list({ tag: 'historical' }).artifacts.map(a => a.artifactId)).toEqual(['historical'])
  expect(reopened.tags()[0].count).toBe(1)
})
