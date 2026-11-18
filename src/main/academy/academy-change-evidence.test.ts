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
    expect(() => compareAcademyPackages(pkg(), pkg(), { textLimit: 0 })).toThrow()
  })

  it('supports creation from null base, exact path filtering, and surrogate/CRLF-safe literal pagination', () => {
    const created = {
      skillMd: '---\nname: created\ndescription: Created skill\n---\n# Title\r\n🧪𠀋 tail\r\n',
      artifacts: { 'references/empty.md': '', 'references/guide.md': 'line1\r\n🧪𠀋end' }
    }
    const creationDiff = compareAcademyPackages(null, created)
    expect(creationDiff.frontmatter.resolved).toBe(true)
    expect(creationDiff.frontmatter.changedProperties.items).toEqual(['description', 'name'])
    expect(creationDiff.changes.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'SKILL.md', kind: 'ADDED', side: 'AFTER', line: 1 }),
      expect.objectContaining({ path: 'references/empty.md', kind: 'ADDED', side: 'AFTER', line: 1, lineCount: 0 }),
      expect.objectContaining({ path: 'references/guide.md', kind: 'ADDED', side: 'AFTER', line: 1 })
    ]))

    const next = {
      skillMd: '---\nname: created\ndescription: Updated description\n---\n# Title\r\nchanged\r\n',
      artifacts: { 'references/empty.md': '', 'references/guide.md': 'line1\r\n🧪𠀋end' }
    }
    const onlyUnchangedRef = compareAcademyPackages(created, next, { path: 'references/guide.md' })
    expect(onlyUnchangedRef.changes.total).toBe(0)
    expect(onlyUnchangedRef.frontmatter).toMatchObject({ resolved: false, changedProperties: { items: [], total: 0 } })

    const onlySkillMd = compareAcademyPackages(created, { ...next, artifacts: { ...next.artifacts, 'references/guide.md': 'also changed' } }, { path: 'SKILL.md' })
    expect(onlySkillMd.changes.items.every(c => c.path === 'SKILL.md')).toBe(true)
    expect(onlySkillMd.frontmatter.changedProperties.items).toEqual(['description'])

    expect(() => compareAcademyPackages(created, next, { path: 'references/absent.md' })).toThrow(expect.objectContaining({ code: 'PATH_NOT_FOUND' }))
    for (const badPath of ['', '../x', '/abs.md', 'a\\b.md', 'a//b.md', 'dir/']) {
      expect(() => compareAcademyPackages(created, next, { path: badPath })).toThrowError('INVALID_ARGUMENT')
    }

    // Reconstruct astral Unicode + CRLF literal text across textLimit=1 and textLimit=3 without splitting surrogate pairs
    const longBefore = { skillMd: '---\nname: uni\ndescription: Unicode\n---\na\r\n', artifacts: {} }
    const longAfter = { skillMd: '---\nname: uni\ndescription: Unicode\n---\n🧪𠀋\r\nend', artifacts: {} }
    let reconstructed = ''
    let textOffset: number | null = 0
    while (textOffset !== null) {
      const pageDiff = compareAcademyPackages(longBefore, longAfter, { offset: 1, limit: 1, textOffset, textLimit: 1 })
      const chunk = pageDiff.changes.items[0].content
      expect(chunk.text.length).toBeGreaterThan(0)
      reconstructed += chunk.text
      textOffset = chunk.nextOffset
    }
    expect(reconstructed).toBe('🧪𠀋\r\nend')
    expect(() => compareAcademyPackages(longBefore, longAfter, { offset: 1, limit: 1, textOffset: 1 })).toThrowError('INVALID_ARGUMENT')
  })
})
