import { afterEach, expect, it, vi } from 'vitest'
import * as tokenizer from '../core/tokenizer'
import sharp from 'sharp'
import Database from 'better-sqlite3'
import { fixture, markdown, withFixtureDatabase } from './continuum-test-fixtures'
import { ContinuumService } from './continuum-service'
import { ArtifactStore } from './artifact-store'
import { editArtifactTags } from './artifact-tags'
import { parseArtifactMarkdown } from './artifact-metadata'
import { executeListArtifacts, executePublishArtifact, executeUpdateArtifact } from './continuum-mcp'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.reverse().forEach(close => close()); cleanup.length = 0 })
function setup() { const f = fixture(); cleanup.push(f.close); return f }
const tag = (slug: string) => ({ slug, name: slug })
const createTag = (f: ReturnType<typeof setup>, slug: string) => f.service.mutateTags({ repositoryId: 'catalog-A', intent: 'create', tag: tag(slug) })
const assign = (f: ReturnType<typeof setup>, slug: string, artifactId: string, expectedRevision: number, assigned = true) => f.service.mutateTags({ repositoryId: 'catalog-A', intent: 'assign', slug, selected: [{ artifactId, expectedRevision }], assigned, confirmed: true })

it('resolves all filtered identities without reading bodies and rejects overflow without a partial selection', async () => {
  const f = setup()
  for (let index = 0; index < 101; index++) f.service.publishHuman(markdown(`Selection ${index}`))
  const get = vi.spyOn(f.service, 'get'), measure = vi.spyOn(f.store, 'measureTokenCountBatch')
  expect(() => f.service.resolveSelection({ query: 'Selection' })).toThrow(/SELECTION_LIMIT/)
  const all = f.service.resolveSelection({ query: 'Selection 1' })
  expect(all).toHaveLength(12)
  expect(get).not.toHaveBeenCalled(); expect(measure).not.toHaveBeenCalled()
  expect(all.every(item => item.revision === 1 && !('rawMarkdown' in item))).toBe(true)
  const totals = await f.service.selectionTokens(all.map(item => ({ artifactId: item.artifactId, expectedRevision: item.revision! })))
  expect(totals).toHaveLength(12)
  await expect(f.service.selectionTokens([{ artifactId: all[0].artifactId, expectedRevision: 2 }])).rejects.toThrow(/REVISION_CONFLICT/)
})

it('rolls back a 100-source quick-create when the last revision conflicts without an orphan tag', () => {
  const f = setup()
  const receipts = Array.from({ length: 100 }, (_, index) => f.service.publishHuman(markdown(`Atomic ${index}`, 'tags: []\n')))
  const selected = receipts.map(item => ({ artifactId: item.artifactId, expectedRevision: item.revision }))
  selected[99].expectedRevision++
  expect(() => f.service.mutateTags({ repositoryId: 'catalog-A', intent: 'quick-create', name: 'Atomic', selected })).toThrow(/REVISION_CONFLICT/)
  expect(f.service.tags()).toEqual([])
  expect(receipts.every(item => f.service.get(item.artifactId)!.revision === 1)).toBe(true)
  selected[99].expectedRevision--
  f.service.mutateTags({ repositoryId: 'catalog-A', intent: 'quick-create', name: 'Atomic', selected })
  expect(f.service.tags()[0].count).toBe(100)
})

it('sums every tag member in bounded deduplicated batches, reuses cache and refreshes affected revisions', async () => {
  const f = setup()
  for (const slug of ['empty', 'first', 'second']) createTag(f, slug)
  for (let index = 0; index < 65; index++) f.service.publishHuman(markdown(`Member ${index}`, 'tags: [first, second]\n'), true)
  const measure = vi.spyOn(tokenizer, 'countCanonicalTokens')
  const totals = await f.service.tagTokenTotals(['empty', 'first', 'second'])
  expect(totals[0]).toMatchObject({ count: 0, rawMarkdownTokenCount: 0, tokenizerEncoding: 'cl100k_base' })
  expect(totals[1].count).toBe(65)
  expect(totals[1].rawMarkdownTokenCount).toBe(totals[2].rawMarkdownTokenCount)
  expect(measure).toHaveBeenCalledTimes(65)
  measure.mockClear()
  expect(await f.service.tagTokenTotals(['first', 'second'])).toEqual(totals.slice(1))
  expect(measure).not.toHaveBeenCalled()
  const source = f.service.list({ tag: 'first', limit: 1 }).artifacts[0]
  assign(f, 'second', source.artifactId, source.revision!, false)
  const updated = await f.service.tagTokenTotals(['first', 'second'])
  expect(updated[1].count).toBe(64)
  expect(measure).toHaveBeenCalledTimes(1)
  const records = f.service.list({ tag: 'first', limit: 100, includeRawMarkdownTokenCount: true })
  expect(updated[0].rawMarkdownTokenCount).toBe(records.artifacts.reduce((sum, item) => sum + item.rawMarkdownTokenCount!, 0))
  measure.mockRestore()
})

it('rejects partial tag totals on membership drift or repository deactivation', async () => {
  const f = setup(); createTag(f, 'first')
  const source = f.service.publishHuman(markdown('Member', 'tags: [first]\n'), true)
  const pending = f.service.tagTokenTotals(['first'])
  assign(f, 'first', source.artifactId, source.revision, false)
  await expect(pending).rejects.toThrow(/TAG_CONTEXT_CHANGED|REVISION_CONFLICT/)
  let active = true
  assign(f, 'first', source.artifactId, source.revision + 1)
  const service = new ContinuumService(f.store, undefined, () => active)
  const abandoned = service.tagTokenTotals(['first']); active = false
  await expect(abandoned).rejects.toThrow(/REPOSITORY_CONTEXT_CHANGED/)
})

it('does not reuse token projections under a different tokenizer identity', async () => {
  const f = setup(); createTag(f, 'first')
  f.service.publishHuman(markdown('Member', 'tags: [first]\n'), true)
  await f.service.tagTokenTotals(['first'])
  const original = tokenizer.getCanonicalTokenizer()
  const identity = vi.spyOn(tokenizer, 'getCanonicalTokenizer').mockReturnValue({ ...original, id: 'next-tokenizer', encoding: original.encoding, count: original.count.bind(original) })
  const measure = vi.spyOn(tokenizer, 'countCanonicalTokens')
  try {
    const totals = await f.service.tagTokenTotals(['first'])
    expect(totals[0].tokenizerId).toBe('next-tokenizer')
    expect(measure).toHaveBeenCalledTimes(1)
  } finally { identity.mockRestore(); measure.mockRestore() }
})

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
  withFixtureDatabase(f.path, db => expect(db.prepare('SELECT count(*) AS n FROM continuum_tag_migrations WHERE version = 1').get()).toEqual({ n: 1 }))
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
  f.service.mutateTags({ repositoryId: 'catalog-A', intent: 'edit', tag: { ...tag('architecture'), name: 'Architecture renamed' } })
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
it('allows immutable import replay after human tagging without authorizing imported tag changes', () => {
  const f = setup(); createTag(f, 'architecture')
  const rawMarkdown = markdown('Imported'), input = { artifactId: 'imported', rawMarkdown, metadata: parseArtifactMarkdown(rawMarkdown).metadata, createdAt: '2026-10-21T00:00:00Z' }
  f.service.importArtifact('inbox:fixture', input)
  assign(f, 'architecture', input.artifactId, 1)
  expect(f.service.importArtifact('inbox:fixture', input).revision).toBe(2)
  expect(f.service.get(input.artifactId)!.metadata.tags).toEqual(['architecture'])
  const changed = editArtifactTags(rawMarkdown, ['architecture'])
  expect(() => f.service.importArtifact('inbox:fixture', { ...input, rawMarkdown: changed, metadata: parseArtifactMarkdown(changed).metadata })).toThrow('IDENTITY_CONFLICT')
})
it('creates by name and assigns atomically, reuses exact identities and rolls back catalog on CAS failure', () => {
  const f = setup(), one = f.service.publish(markdown('One'))
  const request = { repositoryId: 'catalog-A', intent: 'quick-create' as const, name: 'Arquitetura Técnica', selected: [{ artifactId: one.artifactId, expectedRevision: 99 }] }
  expect(() => f.service.mutateTags(request)).toThrow('REVISION_CONFLICT')
  expect(f.service.tags()).toEqual([])
  const original = f.service.get(one.artifactId)!
  f.service.mutateTags({ ...request, selected: [{ artifactId: one.artifactId, expectedRevision: 1 }] })
  expect(f.service.tags()).toEqual([{ slug: 'arquitetura-tecnica', name: 'Arquitetura Técnica', description: '', count: 1 }])
  expect(parseArtifactMarkdown(f.service.get(one.artifactId)!.rawMarkdown).body).toBe(parseArtifactMarkdown(original.rawMarkdown).body)
  f.service.mutateTags({ repositoryId: 'catalog-A', intent: 'quick-create', name: 'arquitetura técnica' })
  expect(f.service.tags()).toHaveLength(1)
  expect(() => f.service.mutateTags({ repositoryId: 'catalog-A', intent: 'quick-create', name: 'Arquitetura Tecnica' })).toThrow('TAG_IDENTITY_CONFLICT')
  expect(() => f.service.mutateTags({ ...request, repositoryId: 'other' })).toThrow('REPOSITORY_CONTEXT_CHANGED')
  expect(f.service.get(one.artifactId)!.revision).toBe(2)
})
it('adds optional descriptions to a v2 catalog without changing identities, members, history or media and persists edits across restart', async () => {
  const f = setup(); createTag(f, 'architecture'); createTag(f, 'onboarding')
  f.service.mutateTags({ repositoryId: 'catalog-A', intent: 'edit', tag: { slug: 'architecture', name: 'Architecture display' } })
  const one = f.service.publish(markdown('Migrated source'))
  assign(f, 'architecture', one.artifactId, 1); assign(f, 'onboarding', one.artifactId, 2)
  const data = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#7852ee' } }).webp({ lossless: true }).toBuffer()
  const visual = await f.service.publishVisual(markdown('Migrated visual').replace('kind: DECISION', 'kind: VISUAL_REFERENCE'), data)
  assign(f, 'architecture', visual.artifactId, 1)
  const before = f.service.get(one.artifactId)!, original = f.service.getVisual(visual.artifactId)
  const history = withFixtureDatabase(f.path, db => db.prepare('SELECT * FROM artifact_revisions ORDER BY artifact_id, revision').all())
  f.store.close()
  withFixtureDatabase(f.path, db => {
    db.exec('ALTER TABLE continuum_tags DROP COLUMN description')
    db.prepare('DELETE FROM continuum_tag_migrations WHERE version = 3').run()
  }, false)
  const reopened = new ArtifactStore(f.path, 'catalog-A'); cleanup.push(() => reopened.close())
  expect(reopened.tags()).toEqual([{ slug: 'architecture', name: 'Architecture display', description: '', count: 2 }, { slug: 'onboarding', name: 'onboarding', description: '', count: 1 }])
  expect(reopened.get(one.artifactId)).toEqual(before)
  expect(reopened.getVisual(visual.artifactId).data).toEqual(data)
  expect(reopened.getVisual(visual.artifactId).media).toEqual(original.media)
  withFixtureDatabase(f.path, db => {
    expect((db.pragma('table_info(continuum_tags)') as { name: string }[]).map(column => column.name)).toEqual(['slug', 'name', 'description'])
    expect(db.prepare('SELECT * FROM artifact_revisions ORDER BY artifact_id, revision').all()).toEqual(history)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.prepare('SELECT version FROM continuum_tag_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }])
  })
  const service = new ContinuumService(reopened)
  const description = 'Inclua decisões aprovadas; exclua propostas e relatos operacionais.'
  service.mutateTags({ repositoryId: 'catalog-A', intent: 'edit', tag: { slug: 'architecture', name: 'Architecture display', description } })
  service.mutateTags({ repositoryId: 'catalog-A', intent: 'edit', tag: { slug: 'architecture', name: 'Architecture display' } })
  expect(service.tags()[0].description).toBe(description)
  expect(reopened.get(one.artifactId)).toEqual(before)
  expect(reopened.getVisual(visual.artifactId)).toEqual(original)
  expect(() => service.mutateTags({ repositoryId: 'catalog-A', intent: 'edit', tag: { slug: 'architecture', name: 'Rejected', description: 'x'.repeat(281) } })).toThrow('INVALID_TAG_DESCRIPTION')
  reopened.close()
  const restarted = new ArtifactStore(f.path, 'catalog-A'); cleanup.push(() => restarted.close())
  expect(restarted.tags()[0]).toEqual({ slug: 'architecture', name: 'Architecture display', description, count: 2 })
  expect(restarted.get(one.artifactId)).toEqual(before)
})
