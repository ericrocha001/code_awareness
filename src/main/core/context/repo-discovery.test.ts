import { describe, expect, it, vi } from 'vitest'
import type { CodeMapElement, CodeMapFile, CodeMapRelationship } from '../../../shared/types'
import { parseRM2 } from './rm2-encoder'
import type { CodeMapDiscoveryPort } from './repo-discovery'
import { RepoDiscovery } from './repo-discovery'

function file(id: string, relativePath: string, tokenCount: number): CodeMapFile {
  return {
    id, repositoryId: 'repo', relativePath, language: 'typescript', extension: '.ts', lines: 2,
    sizeBytes: 20, mtime: 1, contentHash: 'hash', contextReference: id, tokenCount, tokenizerId: 'test',
    tokenizerEncoding: 'test', tokenizedContentHash: 'hash', status: 'indexed'
  }
}

function element(id: string, fileId: string, kind: CodeMapElement['kind'], name: string): CodeMapElement {
  return {
    id, repositoryId: 'repo', fileId, kind, name, parentElementId: null,
    location: { start: { line: 1, column: 0, byte: 0 }, end: { line: 1, column: 10, byte: 10 } },
    sizeLines: 1, sizeBytes: 10, visibility: null, modifiers: [], returnType: null, baseClass: null,
    hasDocumentation: false, parameterCount: 0, granularity: 'structural', retrievable: true
  }
}

function fakeIndex(): CodeMapDiscoveryPort & {
  refreshIndex: ReturnType<typeof vi.fn>
  reconcileWithDisk: ReturnType<typeof vi.fn>
  backfillTokenMetadata: ReturnType<typeof vi.fn>
} {
  const files = [file('a', 'src/deep/a.ts', 5), file('b', 'src/deep/b.ts', 7)]
  const elements = [element('ea', 'a', 'class', 'Alpha'), element('eb', 'b', 'function', 'beta')]
  const relationships: CodeMapRelationship[] = [0, 1].map((index) => ({
    id: `r${index}`, repositoryId: 'repo', sourceId: 'a', targetId: 'b', type: 'imports',
    sourceKind: 'file', targetKind: 'file'
  }))
  return {
    refreshIndex: vi.fn(),
    reconcileWithDisk: vi.fn(),
    backfillTokenMetadata: vi.fn(),
    awaitSnapshot: vi.fn(async () => undefined),
    getFiles: vi.fn(() => files),
    getElements: vi.fn(() => elements),
    getRelationships: vi.fn(() => relationships),
  }
}

describe('RepoDiscovery AI-native projections', () => {
  it.each([1, 2] as const)('keeps hot layer %i index-only, deterministic and dense', async (layer) => {
    const codeMap = fakeIndex()
    const tokenizer = { id: 'test', encoding: 'test', count: vi.fn((text: string) => text.length) }
    const discovery = new RepoDiscovery(codeMap, tokenizer)
    const first = await discovery.generate('repo', layer)
    const second = await discovery.generate('repo', layer)
    const parsed = parseRM2(first.content)
    expect(first.content).toBe(second.content)
    expect(parsed.files.map((entry) => entry.path)).toEqual(['src/deep/a.ts', 'src/deep/b.ts'])
    expect(first.tokenCount).toBe(first.content.length)
    expect(first.mapTokenCount).toBe(first.tokenCount)
    expect(codeMap.awaitSnapshot).toHaveBeenCalledTimes(2)
    expect(codeMap.refreshIndex).not.toHaveBeenCalled()
    expect(codeMap.reconcileWithDisk).not.toHaveBeenCalled()
    expect(codeMap.backfillTokenMetadata).not.toHaveBeenCalled()
    expect(first.content).not.toMatch(/FILE|language=|extension=|lines=|bytes=|\[INVENTORY\]|importedBy|REL imports/)
  })

  it('encodes each logical edge once without structural or semantic payload', async () => {
    const codeMap = fakeIndex()
    const discovery = new RepoDiscovery(codeMap, { id: 'test', encoding: 'test', count: (text) => text.length })
    const layers = await Promise.all([1, 2].map((layer) => discovery.generate('repo', layer as 1 | 2)))
    const parsed = layers.map((result) => parseRM2(result.content))
    expect(parsed.every((layer) => layer.files.length === 2)).toBe(true)
    expect(parsed[1].files.flatMap((entry) => entry.imports)).toHaveLength(1)
    expect(layers[1].content).not.toMatch(/\t=\[|~semantic|kind,name|\^parent/)
    expect(layers[1].timings).toEqual(expect.objectContaining({
      readinessMs: expect.any(Number), projectionMs: expect.any(Number),
      serializationMs: expect.any(Number), outputTokenizationMs: expect.any(Number), totalMs: expect.any(Number)
    }))
  })
})
