import { describe, expect, it, vi } from 'vitest'
import { basename } from 'node:path'
import { createRepositoryModel } from '../repository-model'
import { getCanonicalTokenizer } from '../tokenizer'
import { ContextEngine } from './context-engine'
import { parseRM2, verifyRM2RoundTrip } from './rm2-encoder'

describe('Code Awareness real Repo Map benchmark', () => {
  it('records hot L1/L2 inventory, edges, tokens and generation time', async () => {
    const telemetry = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const repoPath = process.cwd().replace(/\\/g, '/')
    const model = createRepositoryModel(repoPath)
    model.pruneKnownBinaryFiles()
    await model.backfillContextReferences()
    const snapshot = {
      projectName: basename(repoPath),
      files: model.getFiles(),
      elements: model.getElementsByRepository(),
      relationships: model.getRelationships()
    }
    const engine = new ContextEngine({
      awaitSnapshot: async () => undefined,
      getFiles: () => snapshot.files,
      getElements: () => snapshot.elements,
      getRelationships: () => snapshot.relationships
    })
    try {
      const report = []
      let inventoryPaths: string[] | null = null
      for (const layer of [1, 2] as const) {
        const result = await engine.discover(repoPath, layer)
        const repeated = await engine.discover(repoPath, layer)
        const parsed = parseRM2(result.content)
        const paths = parsed.files.map((file) => file.path)
        const edges = parsed.files.reduce((sum, file) => sum + file.outgoingContextReferences.length, 0)
        if (inventoryPaths) expect(paths).toEqual(inventoryPaths)
        inventoryPaths = paths
        expect(result.mapTokenCount).toBe(getCanonicalTokenizer().count(result.content))
        expect(parsed.projectName).toBe(basename(repoPath))
        expect(repeated.content).toBe(result.content)
        expect(verifyRM2RoundTrip(snapshot, layer).valid).toBe(true)
        expect(result.timings.totalMs).toBeLessThan(5_000)
        if (layer === 1) expect(edges).toBe(0)
        if (layer === 2) expect(edges).toBeGreaterThan(0)
        report.push({
          layer,
          files: result.fileCount,
          edges,
          tokens: result.mapTokenCount,
          generationMs: result.generationMs,
          deterministic: result.content === repeated.content
        })
      }
      expect(report[0].files).toBeGreaterThan(300)
      expect(report.every((entry) => entry.deterministic)).toBe(true)
      console.log(`REAL_REPO_MAP_BENCHMARK ${JSON.stringify(report)}`)
    } finally {
      model.close()
      telemetry.mockRestore()
    }
  }, 180_000)
})
