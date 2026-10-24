import { describe, expect, it } from 'vitest'
import { compareAcademyPackages } from './academy-change-evidence'

const pkg = (body = 'Você pode revisar.', description = 'Use antes de editar') => ({ skillMd: `---\nname: sample\ndescription: ${description}\n---\n${body}`, artifacts: {} })

describe('Academy change evidence', () => {
  it('compares artifact names that also exist on Object.prototype', () => {
    expect(compareAcademyPackages(pkg(), { ...pkg(), artifacts: { toString: 'text' } }).changes.items[0]).toMatchObject({ path: 'toString', kind: 'ADDED' })
  })
  it('reports description/trigger and free prose including modal changes without semantic verdict', () => {
    const result = compareAcademyPackages(pkg(), pkg('Você deve revisar.', 'Use ao planejar'))
    expect(result.frontmatter.changedProperties.items).toEqual(['description'])
    expect(result.changes.items.map(c => c.content.text).join('')).toContain('Você deve revisar.')
    expect(result.changes.items.every(c => c.literalEffect === 'UNKNOWN')).toBe(true)
    expect(result.semanticEffect).toBe('NOT_ASSESSED')
  })
  it('reports changed, removed and added complements, even empty files', () => {
    const result = compareAcademyPackages({ ...pkg(), artifacts: { 'a.md': 'old', 'gone.md': 'gone' } }, { ...pkg(), artifacts: { 'a.md': 'new', 'empty.md': '' } })
    expect(result.changes.items).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'gone.md', kind: 'REMOVED' }), expect.objectContaining({ path: 'empty.md', kind: 'ADDED' }), expect.objectContaining({ path: 'a.md', kind: 'MODIFIED' })]))
  })
  it('keeps formatting changes visible and unchanged packages empty', () => {
    expect(compareAcademyPackages(pkg(), pkg()).changes.total).toBe(0)
    expect(compareAcademyPackages(pkg(), pkg('Você  pode revisar.')).changes.items.every(c => c.literalEffect === 'WHITESPACE_ONLY')).toBe(true)
  })
  it('offers bounded, recoverable literal spans with precise line positions', () => {
    const before = pkg('line\nold\nend'), after = pkg('line\nnew value\nend')
    const first = compareAcademyPackages(before, after, { limit: 1, textLimit: 2 })
    expect(first.changes).toMatchObject({ total: 2, nextOffset: 1 })
    expect(first.changes.items[0]).toMatchObject({ side: 'BEFORE', line: 6, content: { text: 'ol', nextOffset: 2 } })
    expect(compareAcademyPackages(before, after, { offset: 1, textOffset: 2 }).changes.items[0].content.text).toBe('w value\n')
  })
  it('rejects malformed packages and invalid bounds', () => {
    expect(() => compareAcademyPackages(pkg(), { skillMd: 'broken', artifacts: {} })).toThrow()
    expect(() => compareAcademyPackages(pkg(), { ...pkg(), artifacts: { '../x': 'unsafe' } })).toThrow()
    expect(() => compareAcademyPackages(pkg(), pkg('changed'), { limit: 0 })).toThrow()
  })
})
