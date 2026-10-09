import { vi } from 'vitest'
import type { CodeMapElement, CodeMapFile } from '../../../shared/types'
import type { DashRequest } from '../../../shared/types/dash-types'
import type { DashMapPort } from './dash-map-port'

export const files = ['src/sync.ts', 'src/neighbor.ts'].map(
  (relativePath, i) =>
    ({
      id: `f${i}`,
      relativePath,
      language: 'typescript',
      extension: '.ts',
      status: 'indexed',
      lines: 10,
      sizeBytes: 100
    }) as CodeMapFile
)
export const elements = ['SyncService', 'syncNow', 'Distractor', 'Nested'].map(
  (name, i): CodeMapElement => ({
    id: i.toString(16).padStart(16, '0'),
    repositoryId: 'repo',
    fileId: i === 2 ? 'f1' : 'f0',
    name,
    kind: i === 0 ? 'class' : 'method',
    parentElementId: i === 1 ? '0000000000000000' : i === 3 ? '0000000000000001' : null,
    location: {
      start: { line: i + 1, column: 0, byte: i * 10 },
      end: { line: i + 2, column: 0, byte: (i + 1) * 10 }
    },
    sizeLines: 1,
    sizeBytes: 10,
    retrievable: true,
    granularity: 'structural',
    declarationSignature: name + '()',
    visibility: 'public',
    modifiers: [],
    returnType: null,
    baseClass: null,
    hasDocumentation: false,
    parameterCount: 0
  })
)
export function fixtureMap(): DashMapPort {
  return {
    awaitReadiness: vi.fn(async () => {}),
    getFiles: () => [...files].reverse(),
    getElements: () => [...elements].reverse(),
    getRelationships: () => [],
    getSymbolReferencesBySourceElement: () => [],
    getSymbolReferencesByTargetElement: () => [],
    getElementExactSources: vi.fn(
      async (_repo: string, ids: string[]) =>
        new Map(
          ids.map((id) => [
            id,
            {
              content: `literal ${id} <>&\r\n🚀`,
              relativePath: 'src/sync.ts',
              startByte: 0,
              endByte: 10
            }
          ])
        )
    ),
    getFileContent: vi.fn(async () => null)
  }
}
export const request = (): DashRequest => ({
  protocol: 'code-dash/v2',
  steps: [
    {
      id: 'x',
      find: 'element',
      where: { name: { exact: 'SyncService' } },
      expect: { min: 1, max: 1 }
    }
  ],
  emit: [{ from: 'x', include: ['name'] }]
})
