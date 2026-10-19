import { afterEach, expect, it, vi } from 'vitest'
import * as syntax from './artifact-structure'
import { ArtifactStore } from './artifact-store'
import { fixture, markdown, withFixtureDatabase } from './continuum-test-fixtures'
const cleanup: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(close => close()) })
function setup() { const f = fixture(); cleanup.push(f.close); return f }

it('extracts literal UTF-16 ranges, hierarchy, duplicates, GFM and synthetic sections', () => {
  const body = 'Preamble 🚀\r\n\r\n# Same *title*\r\ntext\r\n## Child\r\n```md\r\n# fake\r\n```\r\n\r\n<div>\r\n# fake html\r\n</div>\r\n\r\n# Same *title*\r\n\r\nSetext\r\n------\r\n\r\n| A | B |\r\n| - | - |\r\n| a | b |\r\n'
  const raw = markdown('Rich', '', body)
  const sections = syntax.extractOutline(raw)
  expect(sections.map(s => [s.title, s.level, s.parent])).toEqual([
    ['Preamble', 0, null], ['Same title', 1, null], ['Child', 2, 1], ['Same title', 1, null], ['Setext', 2, 3]
  ])
  expect(raw.slice(sections[1].start, sections[1].ownEnd)).toBe('# Same *title*\r\ntext\r\n')
  expect(Buffer.from(sections.filter(s => s.parent === null).map(s => raw.slice(s.start, s.end)).join(''))).toEqual(Buffer.from(body))
  expect(syntax.extractBlocks(raw, sections[4]).map(b => b.type)).toEqual(['table'])
  expect(syntax.extractOutline('plain 🚀\r\ntext')).toMatchObject([{ start: 0, end: 14, level: 0 }])
})

it('builds lazily, reuses across restart/metadata revisions, repairs corruption and invalidates changed text', () => {
  const f = setup()
  const a = f.store.create({ artifactId: 'a', metadata: { name: 'A', description: 'A', kind: 'DOCUMENT' }, rawMarkdown: '# A\nbody' })
  const spy = vi.spyOn(syntax, 'extractOutline')
  expect(withFixtureDatabase(f.path, db => db.prepare('SELECT count(*) AS n FROM artifact_structure').get())).toEqual({ n: 0 })
  const before = f.store.get('a'), outline = f.store.outline(a)
  expect(f.store.get('a')).toEqual(before)
  f.store.close()
  const reopened = new ArtifactStore(f.path, 'catalog-A'); cleanup.push(() => reopened.close())
  expect(reopened.outline(a)).toEqual(outline)
  const metadata = reopened.update({ artifactId: 'a', expectedRevision: 1, metadata: { ...a.metadata, status: 'VALIDATED' }, rawMarkdown: a.rawMarkdown })
  reopened.outline(metadata)
  expect(spy).toHaveBeenCalledTimes(1)
  withFixtureDatabase(f.path, db => db.prepare("UPDATE artifact_structure SET outline_json = 'broken'").run(), false)
  reopened.outline(metadata)
  expect(spy).toHaveBeenCalledTimes(2)
  const changed = reopened.update({ artifactId: 'a', expectedRevision: 2, metadata: a.metadata, rawMarkdown: '# Changed' })
  expect(reopened.outline(changed)[0].title).toBe('Changed')
  expect(spy).toHaveBeenCalledTimes(3)
  withFixtureDatabase(f.path, db => db.prepare('UPDATE artifact_structure SET version = 0').run(), false)
  reopened.outline(changed)
  expect(spy).toHaveBeenCalledTimes(4)
  expect(() => reopened.outline(a)).toThrow(/REVISION_CONFLICT/)
})

it('memoizes syntax failures per hash/version without breaking publication or full reads', () => {
  const f = setup(), a = f.service.publish(markdown())
  const spy = vi.spyOn(syntax, 'extractOutline').mockImplementation(() => { throw new Error('parse') })
  for (let i = 0; i < 2; i++) expect(() => f.store.outline(f.store.get(a.artifactId)!)).toThrow(/STRUCTURE_UNAVAILABLE/)
  expect(spy).toHaveBeenCalledTimes(1)
  expect(f.service.get(a.artifactId)!.rawMarkdown).toBe(markdown())
  expect(f.service.update(a.artifactId, 1, markdown('Changed')).revision).toBe(2)
  spy.mockRestore()
  expect(f.store.outline(f.store.get(a.artifactId)!)[0].title).toBe('Exact body')
})

it('preserves BOM, CRLF frontmatter and legacy text without rewriting it', () => {
  const { store } = setup()
  for (const [id, raw] of [['bom', '\uFEFF' + markdown('BOM', '', 'plain 🚀\r\ntext').replace(/\n/g, '\r\n')], ['legacy', '---\nnot valid YAML [\n---\nlegacy\n\n# Last\ntext'], ['empty', '# Only']]) {
    const a = store.create({ artifactId: id, metadata: { name: id, description: id, kind: 'DOCUMENT' }, rawMarkdown: raw })
    const outline = store.outline(a)
    expect(outline[0].start).toBe(id === 'bom' ? raw.indexOf('plain') : 0)
    expect(outline.filter(s => s.parent === null).map(s => raw.slice(s.start, s.end)).join('')).toBe(raw.slice(outline[0].start))
    expect(store.get(id)).toEqual(a)
  }
})
