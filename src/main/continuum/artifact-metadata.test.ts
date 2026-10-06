import { describe, expect, it } from 'vitest'
import { canonicalJson, parseArtifactMarkdown, validateMetadata } from './artifact-metadata'
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
