import { describe, expect, it } from 'vitest'
import { getCanonicalTokenizer } from '../../core/tokenizer'
import { hashAcademyPackage } from '../academy-package'
import { countLines, parseMarkdownFile } from './skill-markdown'
import { measurePackage } from './skill-measures'

describe('skill-markdown & skill-measures (U1 pure)', () => {
  it('handles Unicode, CRLF, final newline vs unterminated final line, and BOM offsets', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('hello')).toBe(1)
    expect(countLines('hello\n')).toBe(1)
    expect(countLines('a\r\nb\r\n')).toBe(2)
    expect(countLines('a\r\nb')).toBe(2)

    const md =
      '\uFEFF---\r\nname: unicode-skill\r\ndescription: Café 𠀋 triggers\r\n---\r\n# Título Café\r\n\r\nParágrafo 𠀋 com [link](references/guide.md).\r\n'
    const parsed = parseMarkdownFile(md, { isSkillMd: true })
    expect(parsed.coverage).toBe('COMPLETE')
    expect(parsed.frontmatterRange).toEqual({
      startLine: 1,
      endLine: 4,
      startOffset: 1,
      endOffset: md.indexOf('# Título')
    })
    expect(parsed.headings).toHaveLength(1)
    expect(parsed.headings[0].title).toBe('Título Café')
    expect(md.slice(parsed.headings[0].range.startOffset, parsed.headings[0].range.endOffset)).toBe('# Título Café\r\n')
    expect(parsed.links.map(l => l.rawTarget)).toEqual(['references/guide.md'])
  })

  it('ignores links inside fenced/indented code and inline code, and marks HTML or unclosed fence PARTIAL', () => {
    const md = [
      '# Heading',
      '',
      'Inline `[ignored](a.md)` and real [kept](b.md).',
      '',
      '```md',
      '[fenced](c.md)',
      '```',
      '',
      '    [indented](d.md)',
      '',
      '<div>raw html</div>'
    ].join('\n')

    const parsed = parseMarkdownFile(md, { isSkillMd: false })
    expect(parsed.coverage).toBe('PARTIAL')
    expect(parsed.partialReasons).toContain('HTML_BLOCK')
    expect(parsed.links.map(l => l.rawTarget)).toEqual(['b.md'])

    const unclosed = '# H\n\n```ts\nconst x = 1\n'
    const parsedUnclosed = parseMarkdownFile(unclosed, { isSkillMd: false })
    expect(parsedUnclosed.coverage).toBe('PARTIAL')
    expect(parsedUnclosed.partialReasons).toContain('UNCLOSED_FENCE')
  })

  it('computes exact canonical tokenizer counts, file sums, and own vs subtree section measures', () => {
    const tokenizer = getCanonicalTokenizer()
    const skillMd = [
      '---',
      'name: measure-skill',
      'description: Measure tokens accurately across sections',
      '---',
      '# Root',
      'Intro paragraph.',
      '## Child A',
      'Child A body text.',
      '# Second Root',
      'Second body.'
    ].join('\n')
    const refMd = '# Ref\n\nReference content.\n'
    const pkg = { skillMd, artifacts: { 'references/ref.md': refMd } }
    const hash = hashAcademyPackage(pkg)

    const { measures } = measurePackage(
      pkg,
      hash,
      { name: 'measure-skill', description: 'Measure tokens accurately across sections' },
      tokenizer
    )

    expect(measures.nameTokens).toBe(tokenizer.count('measure-skill'))
    expect(measures.descriptionTokens).toBe(tokenizer.count('Measure tokens accurately across sections'))
    expect(measures.metadataTokens).toBe(measures.nameTokens + measures.descriptionTokens)
    expect(measures.skillMdTokens).toBe(tokenizer.count(skillMd))
    expect(measures.resourcesTokens).toBe(tokenizer.count(refMd))
    expect(measures.packageTokens).toBe(measures.skillMdTokens + measures.resourcesTokens)
    expect(measures.packageBytes).toBe(
      Buffer.byteLength(skillMd, 'utf8') + Buffer.byteLength(refMd, 'utf8')
    )

    const rootSections = measures.sections.filter(s => s.path === 'SKILL.md')
    expect(rootSections).toHaveLength(3)
    expect(rootSections[0].subtreeTokens).toBeGreaterThan(rootSections[0].ownTokens)
    expect(rootSections[0].ownTokens).toBe(tokenizer.count('# Root\nIntro paragraph.\n'))
    expect(rootSections[0].subtreeTokens).toBe(
      tokenizer.count('# Root\nIntro paragraph.\n## Child A\nChild A body text.\n')
    )
  })

  it('extracts inline code spans with exact UTF-16 offsets across Unicode/CRLF and ignores fenced/indented/frontmatter/HTML', () => {
    const md = [
      '---',
      'name: inline-span',
      'description: `ignored-in-frontmatter.md`',
      '---',
      '🧪 𠀋 before `references/a.md` and `` ./references/`b`.md ``.',
      '',
      '```md',
      '`ignored-in-fenced.md`',
      '```',
      '',
      '    `ignored-in-indented.md`',
      '',
      '<div>`ignored-in-html.md`</div>',
      ''
    ].join('\r\n')

    const parsed = parseMarkdownFile(md, { isSkillMd: true })
    expect(parsed.inlineCodeSpans.map(s => s.text)).toEqual(['references/a.md', './references/`b`.md'])
    for (const span of parsed.inlineCodeSpans) {
      expect(md.slice(span.range.startOffset, span.range.endOffset)).toBe(span.text)
    }
  })
})
