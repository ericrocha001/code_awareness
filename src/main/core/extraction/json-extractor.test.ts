import { describe, expect, it } from 'vitest'
import type { CodeMapElement } from '../../../shared/types'
import { projectFileOutline } from '../context/file-outline'
import { JsonStructureExtractor } from './json-extractor'

function rangeOf(content: string, element: CodeMapElement): string {
  return Buffer.from(content, 'utf-8')
    .subarray(element.location.start.byte, element.location.end.byte)
    .toString('utf-8')
}

describe('JsonStructureExtractor', () => {
  const extractor = new JsonStructureExtractor()
  const input = (content: string, relativePath = 'package.json') => ({
    repositoryId: 'json-repository',
    relativePath,
    extension: '.json',
    content
  })

  it('supports only the JSON extension', () => {
    expect(extractor.supports('.json')).toBe(true)
    expect(extractor.supports('.JSON')).toBe(true)
    expect(extractor.supports('.jsonc')).toBe(false)
    expect(extractor.supports('.json5')).toBe(false)
  })

  it('projects every top-level property once without expanding nested objects or arrays', () => {
    const content = [
      '{',
      '  "name": "code-awareness",',
      '  "scripts": { "test": "vitest", "nested": { "ignored": true } },',
      '  "dependencies": { "react": "latest" },',
      '  "devDependencies": {},',
      '  "files": ["src", { "alsoIgnored": true }],',
      '  "private": true',
      '}'
    ].join('\n')
    const result = extractor.extract(input(content))
    const document = result.elements[0]
    const sections = result.elements.slice(1)

    expect(document).toMatchObject({ kind: 'document', name: 'package.json', parentElementId: null })
    expect(rangeOf(content, document)).toBe(content)
    expect(sections.map((section) => section.name)).toEqual([
      'name', 'scripts', 'dependencies', 'devDependencies', 'files', 'private'
    ])
    expect(sections.every((section) => section.kind === 'section' && section.parentElementId === document.id)).toBe(true)
    expect(result.elements.some((element) => ['test', 'nested', 'ignored', 'react', 'alsoIgnored'].includes(element.name))).toBe(false)
    expect(result.relationships).toHaveLength(sections.length)
    expect(result.relationships.every((relationship) => relationship.type === 'contains')).toBe(true)
  })

  it('returns exact literal ranges for scalars, objects, arrays, CRLF, Unicode, escapes and BOM', () => {
    const content = '\uFEFF{\r\n  "na\\u006de": "ação 😀",\r\n  "scripts": {\r\n    "test": "vitest --run"\r\n  },\r\n  "include": [\r\n    "src/**/*.ts"\r\n  ],\r\n  "empty": []\r\n}\r\n'
    const result = extractor.extract(input(content))
    const byName = new Map(result.elements.map((element) => [element.name, element]))

    expect(rangeOf(content, byName.get('name')!)).toBe('"na\\u006de": "ação 😀"')
    expect(rangeOf(content, byName.get('scripts')!)).toBe('"scripts": {\r\n    "test": "vitest --run"\r\n  }')
    expect(rangeOf(content, byName.get('include')!)).toBe('"include": [\r\n    "src/**/*.ts"\r\n  ]')
    expect(rangeOf(content, byName.get('empty')!)).toBe('"empty": []')
    for (const element of result.elements) {
      expect(element.sizeBytes).toBe(element.location.end.byte - element.location.start.byte)
    }
  })

  it('keeps empty objects and root arrays addressable only as documents', () => {
    for (const content of ['{}', '[]', '[{"nested": true}]']) {
      const result = extractor.extract(input(content, 'empty.json'))
      expect(result.elements).toHaveLength(1)
      expect(result.elements[0].kind).toBe('document')
      expect(rangeOf(content, result.elements[0])).toBe(content)
      expect(result.relationships).toEqual([])
    }
  })

  it('projects tsconfig-like arrays and objects at the top level only', () => {
    const content = '{"compilerOptions":{"strict":true,"target":"ES2022"},"include":["src/**/*.ts"],"exclude":["dist"]}'
    const result = extractor.extract(input(content, 'tsconfig.json'))
    const sections = result.elements.filter((element) => element.kind === 'section')

    expect(sections.map((section) => section.name)).toEqual(['compilerOptions', 'include', 'exclude'])
    expect(result.elements.some((element) => ['strict', 'target'].includes(element.name))).toBe(false)
    expect(rangeOf(content, sections[0])).toBe('"compilerOptions":{"strict":true,"target":"ES2022"}')
    expect(rangeOf(content, sections[1])).toBe('"include":["src/**/*.ts"]')
    expect(rangeOf(content, sections[2])).toBe('"exclude":["dist"]')
  })

  it('falls back atomically to the whole document for invalid JSON', () => {
    for (const content of ['{"valid": true,}', '{"valid": true} trailing', '{"partial": {"nested": true}']) {
      const result = extractor.extract(input(content, 'invalid.json'))
      expect(result.elements).toHaveLength(1)
      expect(result.elements[0]).toMatchObject({ kind: 'document', name: 'invalid.json' })
      expect(rangeOf(content, result.elements[0])).toBe(content)
      expect(result.relationships).toEqual([])
    }
  })

  it('preserves deterministic identities and ignores signatures for documents and sections', () => {
    const before = extractor.extract(input('{"name":"one","scripts":{"test":"a"}}'))
    const after = extractor.extract(input('{"extra":0,"name":"two","scripts":{"test":"b"}}'))
    const beforeIds = new Map(before.elements.map((element) => [element.name, element.id]))
    const afterIds = new Map(after.elements.map((element) => [element.name, element.id]))

    expect(afterIds.get('package.json')).toBe(beforeIds.get('package.json'))
    expect(afterIds.get('name')).toBe(beforeIds.get('name'))
    expect(afterIds.get('scripts')).toBe(beforeIds.get('scripts'))
    expect(projectFileOutline(before.elements, { signatures: true })).toEqual(
      projectFileOutline(before.elements, { signatures: false })
    )
  })
})
