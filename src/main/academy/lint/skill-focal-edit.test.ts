import { describe, expect, it } from 'vitest'
import { getCanonicalTokenizer } from '../../core/tokenizer'
import { hashAcademyPackage } from '../academy-package'
import { analyzePackageFacts } from './skill-lint-engine'
import { applyFocalEdits } from './skill-focal-edit'

const tok = getCanonicalTokenizer()

describe('skill-focal-edit (U3 pure)', () => {
  it('applies atomic replace + add + move, preserves CRLF bytes outside target, and rejects invalid batches', () => {
    const basePkg = {
      skillMd: '---\r\nname: focal-edit\r\ndescription: Focal edit test\r\n---\r\n# Intro\r\nKeep line 1.\r\nSee [old](references/old.md).\r\nKeep line 2.\r\n',
      artifacts: {
        'references/old.md': '# Old\r\nContent\r\n'
      }
    }
    const baseHash = hashAcademyPackage(basePkg)
    const baseFacts = analyzePackageFacts(basePkg, tok, baseHash)

    const result = applyFocalEdits(basePkg, baseHash, baseFacts, [
      { op: 'replace', path: 'SKILL.md', oldText: '[old](references/old.md)', newText: '[new](references/new.md)' },
      { op: 'move', path: 'references/old.md', toPath: 'references/moved.md' },
      { op: 'add', path: 'references/new.md', content: '# New\r\nSharded content\r\n' }
    ])

    expect(result.candidateValid).toBe(true)
    expect(result.candidate.skillMd).toBe(
      '---\r\nname: focal-edit\r\ndescription: Focal edit test\r\n---\r\n# Intro\r\nKeep line 1.\r\nSee [new](references/new.md).\r\nKeep line 2.\r\n'
    )
    expect(result.candidate.artifacts['references/old.md']).toBeUndefined()
    expect(result.candidate.artifacts['references/moved.md']).toBe('# Old\r\nContent\r\n')
    expect(result.candidate.artifacts['references/new.md']).toBe('# New\r\nSharded content\r\n')

    // Selector replace and stale selector rejection
    const headingEntry = baseFacts.outlines['SKILL.md'].entries.find(e => e.kind === 'HEADING')!
    const bySelector = applyFocalEdits(basePkg, baseHash, baseFacts, [
      { op: 'replace', path: 'SKILL.md', selector: headingEntry.selector, newText: '# Renamed Intro\r\n' }
    ])
    expect(bySelector.candidate.skillMd).toContain('# Renamed Intro\r\nKeep line 1.')

    const expectCode = (fn: () => unknown, code: string) => {
      try {
        fn()
        throw new Error(`Expected ${code}`)
      } catch (err: any) {
        expect(err.code).toBe(code)
      }
    }

    expectCode(
      () =>
        applyFocalEdits(basePkg, baseHash, baseFacts, [
          { op: 'replace', path: 'SKILL.md', selector: `deadbeef0000:SKILL.md#h0`, newText: 'x' }
        ]),
      'SELECTOR_STALE'
    )

    // Ambiguous oldText, missing oldText, overlapping ranges, conflict with remove, traversal path
    expectCode(
      () =>
        applyFocalEdits(basePkg, baseHash, baseFacts, [
          { op: 'replace', path: 'SKILL.md', oldText: 'Keep line', newText: 'X' }
        ]),
      'OLD_TEXT_AMBIGUOUS'
    )

    expectCode(
      () =>
        applyFocalEdits(basePkg, baseHash, baseFacts, [
          { op: 'replace', path: 'SKILL.md', oldText: 'Absent text', newText: 'X' }
        ]),
      'OLD_TEXT_NOT_FOUND'
    )

    expectCode(
      () =>
        applyFocalEdits(basePkg, baseHash, baseFacts, [
          { op: 'replace', path: 'SKILL.md', oldText: 'Keep line 1.', newText: 'A' },
          { op: 'replace', path: 'SKILL.md', oldText: 'line 1.', newText: 'B' }
        ]),
      'EDIT_RANGES_OVERLAP'
    )

    expectCode(
      () =>
        applyFocalEdits(basePkg, baseHash, baseFacts, [
          { op: 'remove', path: 'references/old.md' },
          { op: 'replace', path: 'references/old.md', oldText: 'Content', newText: 'New' }
        ]),
      'EDIT_CONFLICT'
    )

    expectCode(
      () =>
        applyFocalEdits(basePkg, baseHash, baseFacts, [
          { op: 'add', path: '../escape.md', content: 'bad' }
        ]),
      'INVALID_ARTIFACT_PATH'
    )

    // Candidate that breaks frontmatter returns candidateValid: false for PREVIEW handling
    const brokenFrontmatter = applyFocalEdits(basePkg, baseHash, baseFacts, [
      { op: 'replace', path: 'SKILL.md', oldText: '---\r\nname: focal-edit', newText: 'broken' }
    ])
    expect(brokenFrontmatter.candidateValid).toBe(false)
    expect(brokenFrontmatter.validationError?.code).toBe('INVALID_METADATA')
  })
})
