import { describe, expect, it } from 'vitest'
import type { CodeMapElement } from '../../../shared/types'
import { projectFileOutline } from '../context/file-outline'
import { MarkdownStructureExtractor } from './markdown-extractor'

function rangeOf(content: string, element: CodeMapElement): string {
  return Buffer.from(content, 'utf-8')
    .subarray(element.location.start.byte, element.location.end.byte)
    .toString('utf-8')
}

describe('MarkdownStructureExtractor', () => {
  const extractor = new MarkdownStructureExtractor()
  const input = (content: string, relativePath = 'AGENTS.md') => ({
    repositoryId: 'markdown-repository',
    relativePath,
    extension: relativePath.endsWith('.markdown') ? '.markdown' : '.md',
    content
  })

  it('supports Markdown extensions without accepting MDX', () => {
    expect(extractor.supports('.md')).toBe(true)
    expect(extractor.supports('.MD')).toBe(true)
    expect(extractor.supports('.markdown')).toBe(true)
    expect(extractor.supports('.mdx')).toBe(false)
  })

  it('builds heading hierarchy and makes parent ranges include child sections', () => {
    const content = [
      'Preamble.',
      '',
      '# A',
      'A prose.',
      '## B',
      'B prose.',
      '### C',
      'C prose.',
      '## D',
      'D prose.',
      '# E',
      'E prose.',
      ''
    ].join('\n')
    const result = extractor.extract(input(content))
    const outline = projectFileOutline(result.elements, {})
    const document = outline[0]
    const a = result.elements.find((element) => element.name === 'A')!
    const b = result.elements.find((element) => element.name === 'B')!
    const c = result.elements.find((element) => element.name === 'C')!
    const d = result.elements.find((element) => element.name === 'D')!
    const e = result.elements.find((element) => element.name === 'E')!

    expect(document.name).toBe('AGENTS.md')
    expect(document.children?.map((section) => section.name)).toEqual(['A', 'E'])
    expect(document.children?.[0].children?.map((section) => section.name)).toEqual(['B', 'D'])
    expect(document.children?.[0].children?.[0].children?.map((section) => section.name)).toEqual(['C'])
    expect(rangeOf(content, a)).toBe('# A\nA prose.\n## B\nB prose.\n### C\nC prose.\n## D\nD prose.\n')
    expect(rangeOf(content, b)).toBe('## B\nB prose.\n### C\nC prose.\n')
    expect(rangeOf(content, c)).toBe('### C\nC prose.\n')
    expect(rangeOf(content, d)).toBe('## D\nD prose.\n')
    expect(rangeOf(content, e)).toBe('# E\nE prose.\n')
  })

  it('associates skipped levels with the nearest real ancestor and distinguishes duplicate headings', () => {
    const content = '# A\n### C\n## Notes\nfirst\n## Notes\nsecond\n'
    const result = extractor.extract(input(content))
    const a = result.elements.find((element) => element.name === 'A')!
    const children = result.elements.filter((element) => element.parentElementId === a.id)
    const notes = result.elements.filter((element) => element.name === 'Notes')

    expect(children.map((element) => element.name)).toEqual(['C', 'Notes', 'Notes'])
    expect(notes).toHaveLength(2)
    expect(notes[0].id).not.toBe(notes[1].id)
    expect(rangeOf(content, notes[0])).toBe('## Notes\nfirst\n')
    expect(rangeOf(content, notes[1])).toBe('## Notes\nsecond\n')
  })

  it('ignores frontmatter and heading-like text inside backtick and tilde fences', () => {
    const content = [
      '\uFEFF---',
      'title: Sample',
      '# frontmatter comment',
      '---',
      'Intro text.',
      '# Architecture ##',
      '```md',
      '# Not a heading',
      '```',
      '~~~markdown',
      '## Also not a heading',
      '~~~~',
      '## Testing ###',
      'Done.'
    ].join('\r\n')
    const result = extractor.extract(input(content))
    const sections = result.elements.filter((element) => element.kind === 'section')

    expect(sections.map((section) => section.name)).toEqual(['Architecture', 'Testing'])
    expect(rangeOf(content, sections[0])).toContain('```md\r\n# Not a heading\r\n```')
    expect(rangeOf(content, sections[0])).toContain('~~~markdown\r\n## Also not a heading\r\n~~~~')
    expect(rangeOf(content, sections[0])).not.toContain('Intro text.')
    expect(rangeOf(content, sections[1])).toBe('## Testing ###\r\nDone.')
  })

  it('recognizes a BOM-prefixed first heading while preserving its literal bytes', () => {
    const content = '\uFEFF# Visão geral\r\nTexto 日本語 😀\r\n'
    const result = extractor.extract(input(content, 'README.md'))
    const section = result.elements.find((element) => element.kind === 'section')!

    expect(section.name).toBe('Visão geral')
    expect(rangeOf(content, section)).toBe(content)
    expect(section.location.start).toEqual({ line: 1, column: 0, byte: 0 })
    expect(section.location.end.byte).toBe(Buffer.byteLength(content))
  })

  it('keeps documents without named ATX headings addressable only as documents', () => {
    for (const content of ['Plain text.\nNo headings.\n', '#\nText\n##   \n', 'Setext\n======\n']) {
      const result = extractor.extract(input(content, 'notes.markdown'))
      expect(result.elements).toHaveLength(1)
      expect(result.elements[0]).toMatchObject({ kind: 'document', name: 'notes.markdown' })
      expect(rangeOf(content, result.elements[0])).toBe(content)
      expect(result.relationships).toEqual([])
    }
  })

  it('preserves identities across reordering and adds no signatures or non-heading relationships', () => {
    const before = extractor.extract(input('# A\n[link](./other.md)\n# B\n'))
    const after = extractor.extract(input('# B\n# A\n[changed](https://example.com)\n'))
    const beforeIds = new Map(before.elements.map((element) => [element.name, element.id]))
    const afterIds = new Map(after.elements.map((element) => [element.name, element.id]))

    expect(afterIds.get('AGENTS.md')).toBe(beforeIds.get('AGENTS.md'))
    expect(afterIds.get('A')).toBe(beforeIds.get('A'))
    expect(afterIds.get('B')).toBe(beforeIds.get('B'))
    expect(before.relationships.every((relationship) => relationship.type === 'contains')).toBe(true)
    expect(projectFileOutline(before.elements, { signatures: true })).toEqual(
      projectFileOutline(before.elements, { signatures: false })
    )
  })
})
