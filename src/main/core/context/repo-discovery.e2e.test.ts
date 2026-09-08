import { describe, expect, it, vi } from 'vitest'
import type { CompressionPort } from '../compression-port'
import { CodeMapService } from '../code-map-service'
import { createCodeMapSystemFixture, eventually } from '../codemap-system-fixture'
import { RepositoryModel } from '../repository-model'
import type { TokenizerPort } from '../tokenizer'
import { getCanonicalTokenizer } from '../tokenizer'
import { WatcherService } from '../watcher-service'
import { ContextEngine } from './context-engine'
import { parseRM2 } from './rm2-encoder'

const unusedCompression: CompressionPort = {
  async generateCompressionMarkdown() {
    throw new Error('unused')
  }
}

describe('Repo Discovery system acceptance', () => {
  it('produces cumulative, complete, deterministic and fresh layers from the real index', async () => {
    const telemetry = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const fixture = createCodeMapSystemFixture()
    for (let index = 0; index < 30; index++) {
      fixture.write(`scale/file-${String(index).padStart(3, '0')}.ts`, [
        `export function value${index}(input: string): string {`,
        `  const prefix = "${'x'.repeat(2400)}"`,
        '  const normalized = input.trim().toLowerCase()',
        '  return `${prefix}:${normalized}`',
        '}',
        ''
      ].join('\n'))
    }
    const watcher = new WatcherService()
    const codeMap = new CodeMapService(watcher, unusedCompression)
    const engine = new ContextEngine(codeMap)
    try {
      await codeMap.openRepository(fixture.repoPath)
      await codeMap.indexRepository(fixture.repoPath)
      const layers = []
      for (const layer of [1, 2] as const) layers.push(await engine.discover(fixture.repoPath, layer))
      const parsed = layers.map((result) => parseRM2(result.content))
      for (const result of layers) {
        expect(result.fileCount).toBe(41)
        expect(parseRM2(result.content).files).toHaveLength(41)
        expect(result.tokenCount).toBe(getCanonicalTokenizer().count(result.content))
        expect(result.mapTokenCount).toBe(result.tokenCount)
        expect(result.tokenizerEncoding).toBe('cl100k_base')
        expect(result.generationMs).toBe(result.timings.totalMs)
      }
      expect(parsed.every((result) => result.files.length === parsed[0].files.length)).toBe(true)
      const l2ById = new Map(parsed[1].files.map((file) => [file.contextReference, file.path]))
      const legacy = parsed[1].files.find((file) => file.path === 'src/renderer/legacy.cjs')!
      expect(legacy.imports.map((id) => l2ById.get(id))).toContain('src/renderer/helper.js')
      const encodedEdges = parsed[1].files.flatMap((file) => file.imports.map((target) => `${file.path}>${target}`))
      expect(encodedEdges.length).toBeGreaterThan(0)
      expect(new Set(encodedEdges).size).toBe(encodedEdges.length)
      expect(layers[0].content).not.toMatch(/FILE|language=|extension=|lines=|bytes=|\[INVENTORY\]/)
      expect(layers[1].content).not.toMatch(/importedBy|REL imports|\[CONNECTIONS\]/)
      expect(layers[1].content).not.toMatch(/\t=\[|~semantic|kind,name|\^parent/)
      const repeated = await engine.discover(fixture.repoPath, 2)
      expect(repeated.content).toBe(layers[1].content)
      expect(repeated.generationMs).toBeLessThan(5_000)

      const discoveryBackend = new (await import('../dash/dash-discovery-service')).DashDiscoveryService(engine)
      const backendResult = await discoveryBackend.execute({
        protocol: 'repo-discovery/v1', operation: 'discovery', layer: 2
      }, fixture.repoPath)
      expect(parseRM2(backendResult.content).layer).toBe(2)

      fixture.write('src/shared/Fresh.ts', 'export interface Fresh { ready: true }\n')
      await eventually(async () => {
        const fresh = await engine.discover(fixture.repoPath, 1)
        return parseRM2(fresh.content).files.some((file) => file.path === 'src/shared/Fresh.ts') ? fresh : null
      }, { description: 'Repo Discovery to converge after a filesystem change' })
    } finally {
      codeMap.closeAll()
      watcher.stop()
      await fixture.cleanup()
      telemetry.mockRestore()
    }
  }, 120_000)

  it('never tokenizes or indexes known binary assets', async () => {
    const telemetry = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const fixture = createCodeMapSystemFixture()
    fixture.writeBinary('assets/font.woff', Buffer.from('wOFFfake-font-payload'))
    fixture.writeBinary('assets/font.ttf', Buffer.from([0, 1, 0, 0, 0, 8, 0, 128]))
    fixture.writeBinary('assets/image.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const count = vi.fn((content: string) => content.length)
    const model = new RepositoryModel(fixture.repoPath, [], { id: 'spy@1', encoding: 'spy', count })
    try {
      await model.indexRepository()
      const paths = model.getFiles().map((file) => file.relativePath)
      expect(paths).not.toContain('assets/font.woff')
      expect(paths).not.toContain('assets/font.ttf')
      expect(paths).not.toContain('assets/image.png')
      expect(count).toHaveBeenCalledTimes(model.getFiles().length)
    } finally {
      model.close()
      await fixture.cleanup()
      telemetry.mockRestore()
    }
  }, 120_000)

  it('does not retokenize unchanged content and retokenizes changed content once', async () => {
    const telemetry = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const fixture = createCodeMapSystemFixture()
    const count = vi.fn((content: string) => content.length)
    const tokenizer: TokenizerPort = { id: 'spy@1', encoding: 'spy', count }
    const model = new RepositoryModel(fixture.repoPath, [], tokenizer)
    try {
      await model.indexRepository()
      const initialCalls = count.mock.calls.length
      await model.indexRepository()
      expect(count).toHaveBeenCalledTimes(initialCalls)
      fixture.write('src/shared/types.ts', 'export interface User { id: string; name: string }\n')
      await model.updateFileContent('src/shared/types.ts')
      expect(count).toHaveBeenCalledTimes(initialCalls + 1)
      const file = model.getFileByRelativePath('src/shared/types.ts')
      expect(file?.tokenizedContentHash).toBe(file?.contentHash)
      expect(file?.tokenizerId).toBe('spy@1')
    } finally {
      model.close()
      await fixture.cleanup()
      telemetry.mockRestore()
    }
  }, 120_000)
})
