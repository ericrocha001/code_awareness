import { describe, expect, it } from 'vitest'
import { getCanonicalTokenizer } from '../tokenizer'
import { analyzeAdaptivePaths, generateAdaptivePathReport } from './adaptive-path-encoding'
import { parseRM2, projectRM2, serializeRM2, verifyRM2Projection, type RM2Snapshot } from './rm2-encoder'
import { generateDelimiterReport, runTokenAwareDelimiterSearch } from './token-aware-delimiter'

function createSnapshot(paths: string[], dense = false): RM2Snapshot {
  const files = [...paths].sort().map((relativePath, index) => ({
    id: `f${index}`, repositoryId: 'benchmark', contextReference: `x${index.toString(36)}`,
    relativePath, tokenCount: index + 1, language: 'typescript', extension: '.ts', lines: 1,
    sizeBytes: 1, mtime: 1, contentHash: String(index), status: 'indexed' as const
  }))
  const relationships: RM2Snapshot['relationships'] = []
  if (files.length > 1) {
    const edgeCount = dense ? Math.min(files.length * 3, 300) : files.length - 1
    for (let index = 0; index < edgeCount; index++) {
      const source = files[index % files.length]
      const target = files[(index * 7 + 1) % files.length]
      if (source.id === target.id) continue
      relationships.push({
        id: `r${index}`, repositoryId: 'benchmark', sourceId: source.id, targetId: target.id,
        sourceKind: 'file', targetKind: 'file', type: 'imports'
      })
    }
  }
  return { projectName: 'benchmark', files, elements: [], relationships }
}

describe('RM2 L1/L2 encoding benchmark', () => {
  it('runs token-aware delimiter search', () => {
    const report = runTokenAwareDelimiterSearch()
    console.log('DELIMITER_REPORT')
    console.log(generateDelimiterReport(report))
    expect(report.winners.fieldSeparation).toBeTruthy()
    expect(report.winners.nesting).toBeTruthy()
    expect(report.winners.relationships).toBeTruthy()
  })

  it('analyzes adaptive path encoding', () => {
    const paths = Array.from({ length: 50 }, (_, i) => `src/features/feature-${i}/service.ts`)
    paths.push(...Array.from({ length: 10 }, (_, i) => `src/utils/helper-${i}.ts`))
    const report = analyzeAdaptivePaths(paths)
    console.log('ADAPTIVE_PATH_REPORT')
    console.log(generateAdaptivePathReport(report))
    expect(report.branches.length).toBeGreaterThan(0)
  })

  it.each([
    ['small', ['src/a.ts', 'src/b.ts', 'src/c.ts'], false],
    ['medium', Array.from({ length: 80 }, (_, i) => `src/features/feature-${i}/service.ts`), false],
    ['dense', Array.from({ length: 80 }, (_, i) => `src/domain/unit-${i}/index.ts`), true],
    ['deep', Array.from({ length: 40 }, (_, i) => `packages/product/src/modules/area-${i}/internal/service.ts`), false]
  ] as const)('benchmarks %s corpus across L1/L2', (_name, paths, dense) => {
    const snapshot = createSnapshot([...paths], dense)
    for (const layer of [1, 2] as const) {
      const startedAt = performance.now()
      const projection = projectRM2(snapshot, layer)
      const content = serializeRM2(projection)
      const parsed = parseRM2(content)
      const report = {
        layer,
        tokens: getCanonicalTokenizer().count(content),
        characters: content.length,
        generationMs: Number((performance.now() - startedAt).toFixed(2)),
        files: parsed.files.length,
        edges: parsed.files.reduce((sum, file) => sum + file.outgoingContextReferences.length, 0)
      }
      console.log(`RM2_${_name}_L${layer} ${JSON.stringify(report)}`)
      expect(report.tokens).toBeGreaterThan(0)
      expect(report.files).toBe(snapshot.files.length)
      expect(verifyRM2Projection(projection).valid).toBe(true)
      if (layer === 2) expect(report.edges).toBeGreaterThan(0)
    }
  })
})
