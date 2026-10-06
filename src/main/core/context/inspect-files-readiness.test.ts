import { RepositoryChangeReadiness } from '../repository-change-readiness'
import { describe, expect, it, vi } from 'vitest'
import { ContextEngine } from './context-engine'
import type { CodeMapNavigationPort, NavigationInvocationContext } from './context-navigation-port'
import type { CodeMapElement, CodeMapFile, CodeMapRelationship } from '../../../shared/types'
import { CodeMapService } from '../code-map-service'
import { WatcherService } from '../watcher-service'
import type { CompressionPort } from '../compression-port'
import { codeScopeExecutionDrilldownProvider } from '../../system-health/codescope-execution-drilldown'
import type { CodeScopeTraceEvent } from '../../mcp/code-scope-health'
import { createFullTargetId } from './code-target'

const sampleFiles: CodeMapFile[] = [
  { id: 'f1', relativePath: 'src/index.ts', contentHash: 'h1', updatedAt: '2026-09-20' } as CodeMapFile,
  { id: 'f2', relativePath: 'src/utils.ts', contentHash: 'h2', updatedAt: '2026-09-20' } as CodeMapFile
]

const sampleElements: CodeMapElement[] = [
  {
    id: '0000000000000001',
    fileId: 'f1',
    name: 'MainService',
    kind: 'class',
    parentElementId: null,
    startLine: 1,
    endLine: 20,
    retrievable: true,
    location: { start: { line: 1, column: 0, byte: 0 }, end: { line: 20, column: 1, byte: 200 } }
  } as CodeMapElement,
  {
    id: '0000000000000002',
    fileId: 'f1',
    name: 'run',
    kind: 'method',
    parentElementId: '0000000000000001',
    startLine: 5,
    endLine: 10,
    retrievable: true,
    location: { start: { line: 5, column: 2, byte: 50 }, end: { line: 10, column: 3, byte: 100 } }
  } as CodeMapElement
]

vi.mock('../repository-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../repository-model')>()
  return {
    ...actual,
    createRepositoryModel: vi.fn((repoPath: string) => {
      const isWarm = repoPath.includes('warm')
      const files = isWarm ? [...sampleFiles] : []
      const elements = isWarm ? [...sampleElements] : []
      return {
        readiness: new RepositoryChangeReadiness(),
        getRepoPath: () => repoPath,
        getRepositoryId: () => 'test-repo-id',
        pruneKnownBinaryFiles: () => {},
        getRepository: () => ({ id: 'test-repo-id', path: repoPath }),
        getFiles: () => files,
        getModifiedFiles: () => [],
        getFilesModifiedSince: () => [],
        getElementsByRepository: () => elements,
        getRelationships: () => [],
        indexRepository: vi.fn(async () => ({ filesIndexed: files.length, elementsExtracted: elements.length })),
        reconcileWithDisk: vi.fn(async () => ({})),
        backfillContentHashes: vi.fn(async () => {}),
        backfillContextReferences: vi.fn(async () => {}),
        backfillTokenMetadata: vi.fn(async () => {}),
        backfillTextDocuments: vi.fn(async () => {}),
        backfillDeclarationSignatures: vi.fn(async () => {}),
        backfillSymbolReferences: vi.fn(async () => {}),
        close: vi.fn(() => {})
      }
    })
  }
})

const dummyCompression: CompressionPort = {
  async generateCompressionMarkdown() {
    throw new Error('unused')
  }
}

class ReadOnlyWatcherService extends WatcherService {
  override subscribe(): () => void {
    return () => {}
  }
}

describe('inspect_files readiness contract — Unidade 1', () => {
  it('1. maintenance permanentemente pendente não bloqueia inspect_files', async () => {
    let maintenanceFinished = false
    const pendingMaintenance = new Promise<void>((resolve) => {
      setTimeout(() => {
        maintenanceFinished = true
        resolve()
      }, 10_000)
    })

    let snapshotWaited = false
    const mockPort: CodeMapNavigationPort = {
      awaitSnapshot: vi.fn(async () => {
        snapshotWaited = true
        await pendingMaintenance
      }),
      awaitReadiness: vi.fn(async (_repoPath, capability) => {
        if (capability === 'STRUCTURE') {
          return
        }
        await pendingMaintenance
      }),
      getFiles: vi.fn(() => sampleFiles),
      getElements: vi.fn(() => sampleElements),
      getRelationships: vi.fn(() => []),
      getSymbolReferencesByTargetElement: vi.fn(() => []),
      getSymbolReferencesBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsByTargetElement: vi.fn(() => []),
      getElementExactSources: vi.fn(async () => new Map())
    }

    const engine = new ContextEngine(mockPort)
    const startedAt = performance.now()
    const result = await engine.inspectFiles('/test/repo', ['src/index.ts'])
    const elapsed = performance.now() - startedAt

    expect(result.files).toHaveLength(1)
    expect(result.files[0].relativePath).toBe('src/index.ts')
    expect(result.files[0].elements).toHaveLength(1)
    expect(result.files[0].elements[0].name).toBe('MainService')
    expect(mockPort.awaitReadiness).toHaveBeenCalledWith('/test/repo', 'STRUCTURE')
    expect(snapshotWaited).toBe(false)
    expect(maintenanceFinished).toBe(false)
    expect(elapsed).toBeLessThan(100)
  })

  it('2. synchronizer ocupado não bloqueia inspect_files', async () => {
    let synchronizerIdleWaited = false
    const mockPort: CodeMapNavigationPort = {
      awaitSnapshot: vi.fn(async () => {
        synchronizerIdleWaited = true
        await new Promise((resolve) => setTimeout(resolve, 5_000))
      }),
      awaitReadiness: vi.fn(async () => {}),
      getFiles: vi.fn(() => sampleFiles),
      getElements: vi.fn(() => sampleElements),
      getRelationships: vi.fn(() => []),
      getSymbolReferencesByTargetElement: vi.fn(() => []),
      getSymbolReferencesBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsByTargetElement: vi.fn(() => []),
      getElementExactSources: vi.fn(async () => new Map())
    }

    const engine = new ContextEngine(mockPort)
    const result = await engine.inspectFiles('/busy/repo', ['src/index.ts'])

    expect(result.files[0].elements[0].name).toBe('MainService')
    expect(mockPort.awaitReadiness).toHaveBeenCalledWith('/busy/repo', 'STRUCTURE')
    expect(synchronizerIdleWaited).toBe(false)
  })

  it('3. repositório warm responde com estrutura persistida no CodeMapService real', async () => {
    const watcher = new ReadOnlyWatcherService()
    const service = new CodeMapService(watcher, dummyCompression)
    const repoPath = '/workspace/warm-structure-repo'

    try {
      await service.openRepository(repoPath)
      const engine = new ContextEngine(service as unknown as CodeMapNavigationPort)

      const started = performance.now()
      const result = await engine.inspectFiles(repoPath, ['src/index.ts'])
      const duration = performance.now() - started

      expect(result.files).toHaveLength(1)
      expect(result.files[0].relativePath).toBe('src/index.ts')
      expect(result.files[0].elements[0].name).toBe('MainService')
      expect(duration).toBeLessThan(100)
    } finally {
      service.closeAll()
      watcher.stop()
    }
  })

  it('4. repositório nunca indexado preserva a semântica existente', async () => {
    const watcher = new ReadOnlyWatcherService()
    const service = new CodeMapService(watcher, dummyCompression)
    const repoPath = '/workspace/never-indexed-inspect-repo'

    try {
      await service.openRepository(repoPath)
      const engine = new ContextEngine(service as unknown as CodeMapNavigationPort)

      await expect(engine.inspectFiles(repoPath, ['src/missing.ts'])).rejects.toThrow('Unknown CodeMap file: src/missing.ts')
    } finally {
      service.closeAll()
      watcher.stop()
    }
  })

  it('5. falha de maintenance não destrói STRUCTURE já disponível', async () => {
    const mockPort: CodeMapNavigationPort = {
      awaitSnapshot: vi.fn(async () => {
        throw new Error('Background maintenance crashed')
      }),
      awaitReadiness: vi.fn(async () => {}),
      getFiles: vi.fn(() => sampleFiles),
      getElements: vi.fn(() => sampleElements),
      getRelationships: vi.fn(() => []),
      getSymbolReferencesByTargetElement: vi.fn(() => []),
      getSymbolReferencesBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsByTargetElement: vi.fn(() => []),
      getElementExactSources: vi.fn(async () => new Map())
    }

    const engine = new ContextEngine(mockPort)
    const result = await engine.inspectFiles('/repo/with/failing/maintenance', ['src/index.ts'])

    expect(result.files[0].elements[0].name).toBe('MainService')
    expect(mockPort.awaitReadiness).toHaveBeenCalledWith('/repo/with/failing/maintenance', 'STRUCTURE')
    expect(mockPort.awaitSnapshot).not.toHaveBeenCalled()
  })

  it('6. discover_repository usa FILE_INVENTORY, inspect_files usa STRUCTURE e demais tools usam a fase causal correspondente', async () => {
    const elementId = '0000000000000001'
    const targetId = createFullTargetId(elementId)
    const mockPort: CodeMapNavigationPort = {
      awaitSnapshot: vi.fn(async () => {}),
      awaitReadiness: vi.fn(async () => {}),
      getFiles: vi.fn(() => sampleFiles),
      getElements: vi.fn(() => sampleElements),
      getRelationships: vi.fn(() => [
        { id: 'rel-1', sourceId: 'src/index.ts', targetId: 'src/utils.ts', type: 'imports' } as CodeMapRelationship
      ]),
      getSymbolReferencesByTargetElement: vi.fn(() => []),
      getSymbolReferencesBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsByTargetElement: vi.fn(() => []),
      getElementExactSources: vi.fn(async () => new Map([
        [elementId, { source: 'class MainService {}', startLine: 1, endLine: 5, startByte: 0, endByte: 200, relativePath: 'src/index.ts' }]
      ]))
    }

    const engine = new ContextEngine(mockPort)

    // discover_repository usa FILE_INVENTORY
    await engine.discoverRepository('/test/repo')
    expect(mockPort.awaitReadiness).toHaveBeenLastCalledWith('/test/repo', 'FILE_INVENTORY')
    expect(mockPort.awaitSnapshot).not.toHaveBeenCalled()

    // inspect_files usa STRUCTURE
    await engine.inspectFiles('/test/repo', ['src/index.ts'])
    expect(mockPort.awaitReadiness).toHaveBeenLastCalledWith('/test/repo', 'STRUCTURE')
    expect(mockPort.awaitSnapshot).not.toHaveBeenCalled()

    // get_relationships usa RELATIONSHIPS (não snapshot)
    await engine.getRelationships('/test/repo', ['src/index.ts'])
    expect(mockPort.awaitReadiness).toHaveBeenLastCalledWith('/test/repo', 'RELATIONSHIPS')
    expect(mockPort.awaitSnapshot).not.toHaveBeenCalled()

    // get_symbol_hierarchy usa RELATIONSHIPS (não snapshot)
    await engine.getSymbolHierarchy('/test/repo', [targetId])
    expect(mockPort.awaitReadiness).toHaveBeenLastCalledWith('/test/repo', 'RELATIONSHIPS')
    expect(mockPort.awaitSnapshot).not.toHaveBeenCalled()

    // Consumidores usam a fase causal correspondente
    await engine.readCode('/test/repo', [targetId])
    expect(mockPort.awaitReadiness).toHaveBeenLastCalledWith('/test/repo', 'STRUCTURE')
    expect(mockPort.awaitSnapshot).not.toHaveBeenCalled()

    await engine.getReferences('/test/repo', [targetId])
    expect(mockPort.awaitReadiness).toHaveBeenLastCalledWith('/test/repo', 'SYMBOL_REFERENCES')
    expect(mockPort.awaitSnapshot).not.toHaveBeenCalled()

    await engine.getSymbolDependencies('/test/repo', [targetId])
    expect(mockPort.awaitSnapshot).not.toHaveBeenCalled()
  })

  it('7. abertura concorrente é aguardada corretamente sem dependência temporal oculta', async () => {
    const watcher = new ReadOnlyWatcherService()
    const service = new CodeMapService(watcher, dummyCompression)
    const repoPath = '/workspace/concurrent-warm-repo'

    try {
      // Duas chamadas simultâneas de readiness para o mesmo repositório ainda fechado
      const [r1, r2] = await Promise.all([
        service.awaitReadiness(repoPath, 'STRUCTURE'),
        service.awaitReadiness(repoPath, 'FILE_INVENTORY')
      ])

      expect(r1).toBeUndefined()
      expect(r2).toBeUndefined()

      // Acesso síncrono imediatamente após o await conjunto obtém a instância sem erro
      const files = service.getFiles(repoPath)
      const elements = service.getElements(repoPath)
      expect(files).toBeDefined()
      expect(elements).toBeDefined()
    } finally {
      service.closeAll()
      watcher.stop()
    }
  })

  it('8. a duração de inspect_files não cresce com a duração de enrichments que ele não utiliza', async () => {
    const runWithDelay = async (enrichmentDelayMs: number) => {
      const mockPort: CodeMapNavigationPort = {
        awaitSnapshot: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, enrichmentDelayMs))
        }),
        awaitReadiness: vi.fn(async () => {}),
        getFiles: vi.fn(() => sampleFiles),
        getElements: vi.fn(() => sampleElements),
        getRelationships: vi.fn(() => []),
        getSymbolReferencesByTargetElement: vi.fn(() => []),
        getSymbolReferencesBySourceElement: vi.fn(() => []),
        getHierarchyRelationshipsBySourceElement: vi.fn(() => []),
        getHierarchyRelationshipsByTargetElement: vi.fn(() => []),
        getElementExactSources: vi.fn(async () => new Map())
      }
      const engine = new ContextEngine(mockPort)
      const start = performance.now()
      await engine.inspectFiles('/test/repo', ['src/index.ts'])
      return performance.now() - start
    }

    const durationFast = await runWithDelay(10)
    const durationSlow = await runWithDelay(1_000)

    // Ambas as execuções devem ser praticamente instantâneas (<50ms)
    // demonstrando que a duração de inspect_files não cresce com a duração do enrichment
    expect(durationFast).toBeLessThan(50)
    expect(durationSlow).toBeLessThan(50)
  })

  it('9. Unidade 2: emite traces com capability STRUCTURE e drilldown isola corretamente', async () => {
    const recordedEvents: CodeScopeTraceEvent[] = []
    const trace = {
      record: (ev: CodeScopeTraceEvent) => {
        recordedEvents.push(ev)
      }
    }
    const context: NavigationInvocationContext = {
      requestId: 'req-inspect-trace',
      sessionId: 'sess-002',
      trace
    }

    const mockPort: CodeMapNavigationPort = {
      awaitSnapshot: vi.fn(async () => {}),
      awaitReadiness: vi.fn(async () => {}),
      getFiles: vi.fn(() => sampleFiles),
      getElements: vi.fn(() => sampleElements),
      getRelationships: vi.fn(() => []),
      getSymbolReferencesByTargetElement: vi.fn(() => []),
      getSymbolReferencesBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsByTargetElement: vi.fn(() => []),
      getElementExactSources: vi.fn(async () => new Map())
    }

    const engine = new ContextEngine(mockPort)
    await engine.inspectFiles('/test/repo', ['src/index.ts'], {}, context)

    const reqEvent = recordedEvents.find((e) => e.stage === 'codescope-readiness-requested')
    const satEvent = recordedEvents.find((e) => e.stage === 'codescope-readiness-satisfied')
    expect(reqEvent).toBeDefined()
    expect(reqEvent?.capability).toBe('STRUCTURE')
    expect(reqEvent?.tool).toBe('inspect_files')
    expect(satEvent).toBeDefined()
    expect(satEvent?.capability).toBe('STRUCTURE')
    expect(satEvent?.status).toBe('success')

    // Drilldown com falha em STRUCTURE
    const failureEvents: CodeScopeTraceEvent[] = [
      {
        timestamp: new Date().toISOString(),
        requestId: 'req-fail',
        sessionId: 'sess-fail',
        method: 'tools/call',
        tool: 'inspect_files',
        stage: 'codescope-operation-routed',
        durationMs: 1,
        status: 'success'
      },
      {
        timestamp: new Date().toISOString(),
        requestId: 'req-fail',
        sessionId: 'sess-fail',
        method: 'tools/call',
        tool: 'inspect_files',
        stage: 'codescope-readiness-requested',
        capability: 'STRUCTURE',
        durationMs: 0,
        status: 'started'
      },
      {
        timestamp: new Date().toISOString(),
        requestId: 'req-fail',
        sessionId: 'sess-fail',
        method: 'tools/call',
        tool: 'inspect_files',
        stage: 'codescope-readiness-failed',
        capability: 'STRUCTURE',
        durationMs: 25,
        status: 'error',
        error: 'DATABASE_LOCKED'
      }
    ]

    const drilldown = codeScopeExecutionDrilldownProvider.evaluate(failureEvents, 'DATABASE_LOCKED')
    expect(drilldown).not.toBeNull()
    expect(drilldown?.state).toBe('LOCALIZED')
    expect(drilldown?.firstFailedCheckpoint).toBe('Snapshot Synchronization')
    expect(drilldown?.refinedInvestigationTarget).toEqual({
      systemArea: 'CodeMap Readiness',
      component: 'CodeMap Service / Readiness (STRUCTURE)',
      boundary: 'Context Engine → CodeMap Readiness',
      responsibility: 'Awaiting repository readiness capability STRUCTURE before query',
      investigationSeeds: [
        'src/main/core/code-map-service.ts',
        'src/main/core/context/context-engine.ts'
      ]
    })
  })
})
