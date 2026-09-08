import { describe, expect, it } from 'vitest'
import type { CodeMapElement } from '../../../shared/types'
import {
  countRM2Tokens,
  parseRM2,
  projectRM2,
  serializeRM2,
  verifyRM2RoundTrip,
  type RM2Snapshot
} from './rm2-encoder'

function createSnapshot(paths: string[], dense = false): RM2Snapshot {
  const files = [...paths].sort().map((path, index) => ({
    id: `f${index}`,
    repositoryId: 'test',
    relativePath: path,
    language: 'typescript',
    extension: path.slice(path.lastIndexOf('.')),
    lines: 1,
    sizeBytes: 1,
    mtime: 1,
    contentHash: String(index),
    contextReference: `r${index.toString(36)}`,
    tokenCount: index + 1,
    status: 'indexed' as const
  }))
  const relationships: RM2Snapshot['relationships'] = []
  if (files.length > 1) {
    const edgeCount = dense ? Math.min(files.length * 3, 300) : files.length - 1
    for (let index = 0; index < edgeCount; index++) {
      const source = files[index % files.length]
      const target = files[(index * 7 + 1) % files.length]
      if (source.id === target.id) continue
      relationships.push({
        id: `edge${index}`,
        repositoryId: 'test',
        sourceId: source.id,
        targetId: target.id,
        sourceKind: 'file',
        targetKind: 'file',
        type: 'imports'
      })
    }
  }
  return { projectName: 'fixture', files, elements: [], relationships }
}

describe('RM2 Encoder', () => {
  it('serializes L1 as inventory without internal payload', () => {
    const content = serializeRM2(projectRM2(createSnapshot(['src/a.ts', 'src/b.ts']), 1))
    const parsed = parseRM2(content)
    expect(parsed.layer).toBe(1)
    expect(parsed.files.map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(parsed.files.every((file) => file.outgoingContextReferences.length === 0)).toBe(true)
    expect(content).toMatch(/^RM2L1\nPROJECT\{name="fixture"\}\nLEGEND\{/)
    expect(content).not.toMatch(/kind|semantic|\^parent|~text/)
  })

  it('serializes L2 with unique outbound edges and sparse references', () => {
    const parsed = parseRM2(serializeRM2(projectRM2(createSnapshot(['src/a.ts', 'src/b.ts', 'src/c.ts']), 2)))
    expect(parsed.layer).toBe(2)
    expect(parsed.files.map((file) => file.contextReference)).toEqual([null, 'r1', 'r2'])
    expect(parsed.files.flatMap((file) => file.outgoingContextReferences)).toEqual(['r1', 'r2'])
  })

  it('resolves element endpoints to owning files without serializing elements', () => {
    const snapshot = createSnapshot(['src/a.ts', 'src/b.ts'])
    const element = (id: string, fileId: string): CodeMapElement => ({
      id, repositoryId: 'test', fileId, kind: 'function', name: id, parentElementId: null,
      location: { start: { line: 1, column: 0, byte: 0 }, end: { line: 1, column: 1, byte: 1 } },
      sizeLines: 1, sizeBytes: 1, visibility: null, modifiers: [], returnType: null, baseClass: null,
      hasDocumentation: false, parameterCount: 0, granularity: 'structural', retrievable: true
    })
    snapshot.elements = [element('ea', 'f0'), element('eb', 'f1')]
    snapshot.relationships = [{
      id: 'element-edge', repositoryId: 'test', sourceId: 'ea', targetId: 'eb',
      sourceKind: 'element', targetKind: 'element', type: 'imports'
    }]
    const content = serializeRM2(projectRM2(snapshot, 2))
    expect(parseRM2(content).files.flatMap((file) => file.outgoingContextReferences)).toEqual(['r1'])
    expect(content).not.toContain('ea')
    expect(content).not.toContain('eb')
  })

  it.each([1, 2] as const)('passes deterministic round-trip for L%i', (layer) => {
    const snapshot = createSnapshot(Array.from({ length: 20 }, (_, i) => `src/feature-${i}/index.ts`), true)
    const first = serializeRM2(projectRM2(snapshot, layer))
    const second = serializeRM2(projectRM2(snapshot, layer))
    expect(second).toBe(first)
    const result = verifyRM2RoundTrip(snapshot, layer)
    expect(result.valid).toBe(true)
    expect(result.originalFiles).toBe(result.parsedFiles)
    expect(result.originalEdges).toBe(result.parsedEdges)
  })

  it('counts canonical map tokens', () => {
    expect(countRM2Tokens(projectRM2(createSnapshot(['src/a.ts']), 1))).toBeGreaterThan(0)
  })

  it('round-trips deep and unusual paths', () => {
    const paths = [
      'packages/core/src/internal/services/auth/service.ts',
      'packages/core/src/internal/services/auth/types.ts',
      'src/a\tb.ts',
      '"quoted"/file.ts'
    ]
    const parsed = parseRM2(serializeRM2(projectRM2(createSnapshot(paths), 1)))
    expect(parsed.files.map((file) => file.path).sort()).toEqual([...paths].sort())
  })

  it('rejects removed RM2 layers', () => {
    expect(() => parseRM2('RM2L3\nPROJECT{name="x"}\nLEGEND{}\nMAP|H')).toThrow('Unsupported RM2 grammar')
    expect(() => parseRM2('RM2L4\nPROJECT{name="x"}\nLEGEND{}\nMAP|H')).toThrow('Unsupported RM2 grammar')
  })
})
