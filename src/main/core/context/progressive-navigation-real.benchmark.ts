import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRepositoryModel } from '../repository-model'
import { ContextEngine } from './context-engine'
import { createFullTargetId, parseCodeTargetId } from './code-target'
import { serializeDiscovery, serializeInspectFiles, serializeReadCode, serializeRelationships, serializeSymbolDependencies } from './context-navigation-serializer'
import { computeNavigationOverhead, computeReadCodeEnvelopeOverhead, measureScenario } from './context-efficiency-harness'

function reductionPercent(old: number, current: number): string {
  return old > 0 ? `${(((old - current) / old) * 100).toFixed(1)}%` : 'n/a'
}

describe('CodeScope real repository acceptance', () => {
  it('finds the navigation implementation progressively and measures equivalent old/new payloads', async () => {
    const telemetry = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const repoPath = process.cwd().replace(/\\/g, '/')
    const model = createRepositoryModel(repoPath)
    try {
      await model.indexRepository()
      const files = model.getFiles()
      const elements = model.getElementsByRepository()
      const port = {
        awaitSnapshot: async () => {}, getFiles: () => files, getElements: vi.fn(() => elements),
        getRelationships: vi.fn(() => model.getRelationships()),
        getSymbolReferencesByTargetElement: vi.fn((_repo: string, targetElementId: string) => model.getSymbolReferencesByTargetElement(targetElementId)),
        getSymbolReferencesBySourceElement: vi.fn((_repo: string, sourceElementId: string) => model.getSymbolReferencesBySourceElement(sourceElementId)),
        getElementExactSources: vi.fn((_repo: string, ids: string[]) => model.getElementExactSources(ids))
      }
      const engine = new ContextEngine(port)

      const serializedRoot = serializeDiscovery(await engine.discoverRepository(repoPath))
      expect(serializedRoot).toContain('\nsrc/')

      const explored = await engine.discoverRepository(repoPath, ['src', 'src/main', 'src/main/core', 'src/main/core/context', 'src/main/mcp', 'src/shared/types'])
      expect(explored.directories.find((directory) => directory.relativePath === 'src/main/core/context')?.children).toContain('context-engine.ts')
      expect(port.getElements).not.toHaveBeenCalled()
      expect(port.getRelationships).not.toHaveBeenCalled()

      const paths = ['src/main/core/context/context-engine.ts', 'src/main/core/context/code-target.ts', 'src/main/core/code-map-service.ts', 'src/main/mcp/channel-mcp-adapter.ts', 'src/shared/types/context-navigation-types.ts']
      const relationships = await engine.getRelationships(repoPath, [paths[0]])
      expect(relationships.files[0].out?.map((edge) => edge.relativePath)).toEqual(expect.arrayContaining([paths[1], paths[4]]))

      const inspected = await engine.inspectFiles(repoPath, paths)
      const serializedOutline = serializeInspectFiles(inspected)
      expect(inspected.files.map((file) => file.relativePath)).toEqual(paths)
      const engineClass = inspected.files[0].elements.find((element) => element.name === 'ContextEngine')!
      expect(engineClass.children?.map((element) => element.name)).toEqual(expect.arrayContaining(['discoverRepository', 'getRelationships', 'inspectFiles', 'getSymbolDependencies', 'readCode']))
      expect(port.getElementExactSources).not.toHaveBeenCalled()

      const dependencySources = elements.filter((element) =>
        element.retrievable && model.getSymbolReferencesBySourceElement(element.id).some((reference) =>
          elements.some((candidate) => candidate.id === reference.targetElementId && candidate.retrievable)
        )
      ).slice(0, 3)
      expect(dependencySources.length).toBeGreaterThan(0)
      const dependencySourceTargets = dependencySources.map((element) => createFullTargetId(element.id))
      const dependencyResult = await engine.getSymbolDependencies(repoPath, dependencySourceTargets)
      const serializedDependencies = serializeSymbolDependencies(dependencyResult)
      const dependencyMeasurement = measureScenario('symbol_dependencies_real', serializedDependencies)
      const dependencyCount = dependencyResult.sources.reduce((count, source) => count + source.dependencies.length, 0)
      expect(dependencyCount).toBeGreaterThan(0)
      expect(port.getElementExactSources).not.toHaveBeenCalled()

      const dependencySourceReads = await engine.readCode(repoPath, dependencySourceTargets)
      const dependencySourceMeasurement = measureScenario('symbol_dependencies_source_alternative', dependencySourceReads.map(serializeReadCode).join('\n\n'))

      const target = engineClass.children!.find((element) => element.name === 'discoverRepository')!.target!
      const [read] = await engine.readCode(repoPath, [target])
      const original = elements.find((element) => element.id === parseCodeTargetId(target)!.elementId)!
      const source = await readFile(join(repoPath, paths[0]))
      expect(Buffer.from(read.source)).toEqual(source.subarray(original.location.start.byte, original.location.end.byte))
      expect(await engine.readCode(repoPath, ['target:' + original.id + ':full'])).toEqual([read])

      const legacyOutline = { files: paths.map((relativePath) => {
        const file = files.find((entry) => entry.relativePath === relativePath)!
        return { fileId: file.id, relativePath, language: file.language, elements: elements.filter((entry) => entry.fileId === file.id).map((entry) => ({
          elementId: entry.id, kind: entry.kind, name: entry.name, parentElementId: entry.parentElementId,
          granularity: entry.granularity, location: entry.location, visibility: entry.visibility, modifiers: entry.modifiers,
          returnType: entry.returnType, baseClass: entry.baseClass, parameterCount: entry.parameterCount,
          ...(entry.retrievable ? { target: { id: 'target:' + entry.id + ':full', elementId: entry.id, kind: 'full', location: entry.location } } : {})
        })) }
      }) }


      const mRoot = measureScenario('discover_root', serializedRoot)
      const mExpanded = measureScenario('discover_expanded', serializeDiscovery(explored))
      const mRelationships = measureScenario('get_relationships', serializeRelationships(relationships))
      const mInspect = measureScenario('inspect_files', serializedOutline)
      const navOverhead = computeNavigationOverhead(mRoot, mExpanded, mRelationships, mInspect)

      const serializedRead = serializeReadCode(read)
      const readEnvelope = computeReadCodeEnvelopeOverhead(serializedRead, read.source)

      const oldInspectTokens = measureScenario('old_inspect', JSON.stringify(legacyOutline)).tokens

      expect(mInspect.tokens).toBeLessThan(oldInspectTokens / 5)

      for (const output of [serializedRoot, serializeDiscovery(explored), serializeRelationships(relationships), serializedOutline]) {
        expect(output).not.toMatch(/\"(?:elementId|location|granularity|tokenCount|language)\"|\\n|\\\"|target:/)
      }

      const col = (s: string | number, w: number): string => String(s).padStart(w)
      console.log([
        'CodeScope Real Context Benchmark',
        `Files: ${files.length}`,
        '',
        `${''.padEnd(30)} ${col('old', 8)} ${col('new', 8)} ${col('reduction', 10)}`,
        `Discovery (root): ${mRoot.tokens} tokens`,
        `${'Inspect (' + paths.length + ' files)'.padEnd(30)} ${col(oldInspectTokens, 8)} ${col(mInspect.tokens, 8)} ${col(reductionPercent(oldInspectTokens, mInspect.tokens), 10)}`,
        '',
        `Navigation Overhead: ${navOverhead.totalTokens} tokens (${navOverhead.totalCharacters} chars)`,
        `  discover_root:     ${navOverhead.discoverRootTokens} tokens`,
        `  discover_expanded: ${navOverhead.discoverSrcTokens} tokens`,
        `  get_relationships: ${navOverhead.relationshipsBothTokens} tokens`,
        `  inspect_files:     ${navOverhead.inspectServiceTokens} tokens`,
        '',
        `Read Code Envelope: ${readEnvelope.envelopeTokens} token overhead (serialized=${readEnvelope.serializedTokens}, source=${readEnvelope.sourceTokens})`,
        `Source: ${Buffer.byteLength(read.source)} bytes`,
        '',
        `Symbol Dependencies (${dependencySources.length} real elements): ${dependencyCount} dependencies, ${dependencyMeasurement.tokens} tokens (${dependencyMeasurement.characters} chars)`,
        `Read Code alternative: ${dependencySourceMeasurement.tokens} tokens (${dependencySourceMeasurement.characters} chars)`
      ].join('\n'))
    } finally {
      model.close()
      telemetry.mockRestore()
    }
  }, 180_000)
})
