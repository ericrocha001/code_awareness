import { describe, expect, it } from 'vitest'
import { hashAcademyPackage, normalizeAcademyPackage, parseSkillMetadata } from './academy-package'

const skillMd = `---\nname: test-skill\ndescription: A test skill\n---\n\n# Test\n`

describe('Academy package contract', () => {
  it('requires literal name and description metadata', () => {
    expect(parseSkillMetadata(skillMd)).toEqual({ name: 'test-skill', description: 'A test skill' })
    expect(() => parseSkillMetadata('# missing')).toThrowError(/frontmatter/)
    expect(() => parseSkillMetadata('---\nname: Bad Name\ndescription: x\n---')).toThrowError(/lowercase/)
  })

  it('rejects traversal, duplicate and non-text artifacts', () => {
    expect(() => normalizeAcademyPackage({ skillMd, artifacts: { '../escape.md': 'x' } })).toThrowError(/Invalid artifact path/)
    expect(() => normalizeAcademyPackage({ skillMd, artifacts: { 'A.md': 'x', 'a.md': 'y' } })).toThrowError(/Duplicate/)
    expect(() => normalizeAcademyPackage({ skillMd, artifacts: { 'binary.bin': 'a\0b' } })).toThrowError(/UTF-8 text/)
  })

  it('hashes the complete package deterministically', () => {
    const first = hashAcademyPackage({ skillMd, artifacts: { 'b.md': 'β', 'a.md': 'á' } })
    const second = hashAcademyPackage({ skillMd, artifacts: { 'a.md': 'á', 'b.md': 'β' } })
    expect(first).toBe(second)
    expect(hashAcademyPackage({ skillMd, artifacts: { 'a.md': 'changed', 'b.md': 'β' } })).not.toBe(first)
  })
})
