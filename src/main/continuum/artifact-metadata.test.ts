import { describe, expect, it } from 'vitest'
import { canonicalJson, parseArtifactMarkdown, validateMetadata } from './artifact-metadata'
import { canonicalizePublication } from './artifact-publication'

describe('Universal publication canonicalization', () => {
  const intro = 'Preserva o conteúdo literal e os metadados sem inferir autoria.'
  it('derives only an unambiguous title and introductory sentence, preserving literal body bytes', () => {
    const body = '\uFEFF\r\n# Ação 日本語\r\n\r\n' + intro + '\r\n\r\n## Prova\r\n```md\r\n# Not a title\r\n```\r\n${literal} $(command)\t\r\n'
    const result = canonicalizePublication(body, { kind: 'FUTURE_KIND' })
    expect(result.metadata).toEqual({ name: 'Ação 日本語', description: intro, kind: 'FUTURE_KIND' })
    expect(parseArtifactMarkdown(result.rawMarkdown).body).toBe(body.slice(1))
    expect(result.rawMarkdown.startsWith('\uFEFF---\n')).toBe(true)
    expect(canonicalizePublication(result.rawMarkdown).rawMarkdown).toBe(result.rawMarkdown)
  })
  it('requires semantic choices instead of generic names, guessed kinds or insufficient descriptions', () => {
    for (const [body, fields, field] of [
      ['# Title\n\n' + intro, {}, 'kind'],
      ['# First\n\n' + intro + '\n\n# Second', { kind: 'DOCUMENT' }, 'name'],
      ['## Section\n\n' + intro, { kind: 'DOCUMENT' }, 'name'],
      ['```md\n# Example\n```', { kind: 'DOCUMENT' }, 'name'],
      ['# Title\n\nTODO', { kind: 'DOCUMENT' }, 'description'],
      ['# Title\n\n- a list', { kind: 'DOCUMENT' }, 'description'],
      ['# Title\n\n' + 'x'.repeat(513) + '.', { kind: 'DOCUMENT' }, 'description'],
      ['# Title\n\n## Detail\n\n' + intro, { kind: 'DOCUMENT' }, 'description']
    ] as const) {
      expect(() => canonicalizePublication(body, fields)).toThrow(`MISSING_SEMANTIC_FIELD: ${field}`)
    }
    const explicit = canonicalizePublication('Literal body without headings.', { kind: 'CUSTOM', name: 'Explicit', description: intro })
    expect(explicit.metadata.name).toBe('Explicit')
  })
  it('keeps legacy dates and extensions literal, rejects malformed YAML and conflicting or technical selections', () => {
    const raw = '\uFEFF---\r\nname: Legacy\r\ndescription: Authored description\r\nkind: CUSTOM\r\ndate: 2020-01-01\r\nfuture: {a: true}\r\n---\r\nBody\r\n'
    expect(canonicalizePublication(raw).rawMarkdown).toBe(raw)
    expect(() => canonicalizePublication(raw, { kind: 'OTHER' })).toThrow(/conflicts/)
    for (const malformed of ['---', '---\nname: [\n---\nBody', '---\nkind: CUSTOM\n---\nBody']) expect(() => canonicalizePublication(malformed, { kind: 'CUSTOM' })).toThrow(/INVALID_ARGUMENT/)
    expect(() => canonicalizePublication('# Title\n\n' + intro, { kind: 'CUSTOM', sessionId: 'forged' } as never)).toThrow(/INVALID_ARGUMENT/)
  })
  it('preserves all previous semantic metadata in body-only updates unless explicitly changed', () => {
    const prior = { name: 'Prior', description: intro, kind: 'WORK_ITEM', status: 'PENDING', date: '2020-01-01', tags: ['canonical'], future: { value: true }, relations: [{ artifactId: 'plan', kind: 'implements' }] }
    const result = canonicalizePublication('# Different title\n\nNew body.', {}, prior)
    expect(result.metadata).toEqual(prior)
    expect(parseArtifactMarkdown(result.rawMarkdown).body).toBe('# Different title\n\nNew body.')
    expect(canonicalizePublication('Changed body.', { name: 'Selected' }, prior).metadata).toEqual({ ...prior, name: 'Selected' })
  })
})
describe('Artifact YAML parser', () => {
  const valid = '---\r\nname: Context\r\ndescription: Decide whether to open this context\r\nkind: FUTURE_KIND\r\nstatus: BLOCKED\r\nfuture: {value: 2, enabled: true}\r\n---\r\n# Body\r\n\tLiteral ${value} `code` ç 🚀\r\n'
  it('preserves exact body and open structured metadata, including CRLF and BOM', () => {
    const parsed = parseArtifactMarkdown(valid); expect(parsed.body).toBe('# Body\r\n\tLiteral ${value} `code` ç 🚀\r\n')
    expect(parsed.metadata.future).toEqual({ value: 2, enabled: true }); expect(parsed.metadata.kind).toBe('FUTURE_KIND')
    expect(parseArtifactMarkdown('\uFEFF' + valid)).toEqual(parsed)
    expect(canonicalJson({ b: 1, a: [true, null] })).toBe(canonicalJson({ a: [true, null], b: 1 }))
  })
  it('requires core metadata for new artifacts, allowing missing description only in migration', () => {
    for (const key of ['name', 'description', 'kind']) expect(() => parseArtifactMarkdown(valid.replace(new RegExp(key + ': [^\\r]+\\r\\n'), ''))).toThrow(key)
    expect(() => validateMetadata({ name: 'old', kind: 'IMPLEMENTATION_HANDOFF' })).toThrow(/description/)
    expect(validateMetadata({ name: 'old', kind: 'IMPLEMENTATION_HANDOFF' }, true)).toEqual({ name: 'old', kind: 'IMPLEMENTATION_HANDOFF' })
  })
  it.each(['# no frontmatter', '---\n[]\n---\nbody', '---\nname: A\nname: B\n---\nbody',
    '---\nname: [A]\ndescription: D\nkind: K\n---\nbody', '---\nname: A\ndescription: D\nkind: K\nstatus: 2\n---\nbody',
    '---\nname: A\ndescription: D\nkind: K\nrelations: {}\n---\nbody', '---\nname: A\ndescription: D\nkind: K\nrelations: [{artifactId: B}]\n---\nbody',
    '---\nname: A\ndescription: D\nkind: K\ncycle: &c {self: *c}\n---\nbody', '---\nname: A\ndescription: D\nkind: K\n__proto__: bad\n---\nbody',
    '---\nname: A\ndescription: D\nkind: K\n---\n', '---\nname: A\ndescription: D\nkind: K\n---\nbody\x00'])('rejects invalid structure: %s', raw => { expect(() => parseArtifactMarkdown(raw)).toThrow(/INVALID_ARGUMENT/) })
  it('rejects cyclic/deep metadata, nonfinite values and duplicated edges', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    expect(() => validateMetadata({ name: 'A', kind: 'K', description: 'D', cyclic })).toThrow(/cycles/)
    expect(() => validateMetadata({ name: 'A', kind: 'K', description: 'D', value: Infinity })).toThrow()
    let deep: unknown = {}; for (let i = 0; i < 22; i++) deep = { nested: deep }
    expect(() => validateMetadata({ name: 'A', kind: 'K', description: 'D', deep })).toThrow(/nesting/)
    expect(() => validateMetadata({ name: 'A', kind: 'K', description: 'D', relations: [{ artifactId: 'B', kind: 'future-kind' }, { artifactId: 'B', kind: 'future-kind' }] })).toThrow(/duplicate/)
  })
})
