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
  { id: 'f2', relativePath: 'src/utils.ts', contentHash: 'h2', updatedAt: '2026-09-20' } as CodeMapFile,
  { id: 'f3', relativePath: 'package.json', contentHash: 'h3', updatedAt: '2026-09-20' } as CodeMapFile
]

vi.mock('../repository-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../repository-model')>()
  return {
    ...actual,
    createRepositoryModel: vi.fn((repoPath: string) => {
      let files = repoPath.includes('warm') ? [...sampleFiles] : []
      return {
        getRepoPath: () => repoPath,
        getRepositoryId: () => 'test-repo-id',
        pruneKnownBinaryFiles: () => {},
        getRepository: () => ({ id: 'test-repo-id', path: repoPath }),
        getFiles: () => files,
        getModifiedFiles: () => [],
        getFilesModifiedSince: () => [],
        getElementsByRepository: () => [],
        getRelationships: () => [],
        indexRepository: vi.fn(async () => {
          files = [...sampleFiles]
          return { filesIndexed: files.length, elementsExtracted: 0 }
        }),
        reconcileWithDisk: vi.fn(async () => {}),
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

describe('discover_repository readiness contract', () => {
  it('Harness 13: reprodução exata do bug — backgroundMaintenance pendente não bloqueia discover_repository', async () => {
    let maintenanceFinished = false
    const pendingMaintenance = new Promise<void>((resolve) => {
      setTimeout(() => {
        maintenanceFinished = true
        resolve()
      }, 5_000)
    })

    let snapshotWaited = false
    const mockPort: CodeMapNavigationPort = {
      awaitSnapshot: vi.fn(async () => {
        snapshotWaited = true
        await pendingMaintenance
      }),
      awaitReadiness: vi.fn(async (_repoPath, capability) => {
        if (capability === 'FILE_INVENTORY') {
          // Readiness imediata para leitura do inventário: NÃO aguarda pendingMaintenance
          return
        }
        await pendingMaintenance
      }),
      getFiles: vi.fn(() => sampleFiles),
      getElements: vi.fn(() => []),
      getRelationships: vi.fn(() => []),
      getSymbolReferencesByTargetElement: vi.fn(() => []),
      getSymbolReferencesBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsByTargetElement: vi.fn(() => []),
      getElementExactSources: vi.fn(async () => new Map())
    }

    const engine = new ContextEngine(mockPort)

    const startedAt = performance.now()
    const result = await engine.discoverRepository('/test/repo')
    const elapsed = performance.now() - startedAt

    // discover_repository retorna o inventário imediatamente
    expect(result.directories).toBeDefined()
    expect(result.directories[0].children).toContain('package.json')
    expect(result.directories[0].children).toContain('src/')
    expect(mockPort.awaitReadiness).toHaveBeenCalledWith('/test/repo', 'FILE_INVENTORY')
    expect(snapshotWaited).toBe(false)
    expect(maintenanceFinished).toBe(false)
    expect(elapsed).toBeLessThan(100)
  })

  it('Harness 14: Synchronizer ocupado — fila global não bloqueia discover_repository', async () => {
    let synchronizerIdleWaited = false
    const mockPort: CodeMapNavigationPort = {
      awaitSnapshot: vi.fn(async () => {
        synchronizerIdleWaited = true
        // waitForIdle simula sincronizador ocupado processando fila
        await new Promise((resolve) => setTimeout(resolve, 3_000))
      }),
      awaitReadiness: vi.fn(async () => {
        // Readiness de inventário não chama waitForIdle
      }),
      getFiles: vi.fn(() => sampleFiles),
      getElements: vi.fn(() => []),
      getRelationships: vi.fn(() => []),
      getSymbolReferencesByTargetElement: vi.fn(() => []),
      getSymbolReferencesBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsByTargetElement: vi.fn(() => []),
      getElementExactSources: vi.fn(async () => new Map())
    }

    const engine = new ContextEngine(mockPort)
    const result = await engine.discoverRepository('/busy/repo')

    expect(result.directories).toHaveLength(1)
    expect(mockPort.awaitReadiness).toHaveBeenCalledWith('/busy/repo', 'FILE_INVENTORY')
    expect(synchronizerIdleWaited).toBe(false)
  })

  it('Harness 15: Warm repository — responde imediatamente com inventário persistido no CodeMapService real', async () => {
    const watcher = new ReadOnlyWatcherService()
    const service = new CodeMapService(watcher, dummyCompression)
    const repoPath = '/workspace/warm-repo'

    try {
      await service.openRepository(repoPath)

      const engine = new ContextEngine(service as unknown as CodeMapNavigationPort)
      const started = performance.now()
      const result = await engine.discoverRepository(repoPath)
      const duration = performance.now() - started

      expect(result.directories[0].children.length).toBeGreaterThan(0)
      expect(result.directories[0].children).toContain('package.json')
      expect(result.directories[0].children).toContain('src/')
      expect(duration).toBeLessThan(100)
    } finally {
      service.closeAll()
      watcher.stop()
    }
  })

  it('Harness 16: Never indexed — preserva semântica conhecida sem disparar indexação implícita', async () => {
    const watcher = new ReadOnlyWatcherService()
    const service = new CodeMapService(watcher, dummyCompression)
    const indexSpy = vi.spyOn(service, 'indexRepository')
    const repoPath = '/workspace/never-indexed-repo'

    try {
      // Abre repositório nunca indexado
      await service.openRepository(repoPath)

      const engine = new ContextEngine(service as unknown as CodeMapNavigationPort)
      const result = await engine.discoverRepository(repoPath)

      expect(result.directories).toEqual([{ relativePath: '.', children: [] }])
      expect(indexSpy).not.toHaveBeenCalled()
    } finally {
      service.closeAll()
      watcher.stop()
    }
  })

  it('Harness 17: Maintenance failure — falha de background enrichment não impede leitura do inventário existente', async () => {
    const mockPort: CodeMapNavigationPort = {
      awaitSnapshot: vi.fn(async () => {
        throw new Error('Background maintenance crashed')
      }),
      awaitReadiness: vi.fn(async () => {
        // Falha posterior de maintenance não afeta FILE_INVENTORY
      }),
      getFiles: vi.fn(() => sampleFiles),
      getElements: vi.fn(() => []),
      getRelationships: vi.fn(() => []),
      getSymbolReferencesByTargetElement: vi.fn(() => []),
      getSymbolReferencesBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsByTargetElement: vi.fn(() => []),
      getElementExactSources: vi.fn(async () => new Map())
    }

    const engine = new ContextEngine(mockPort)
    const result = await engine.discoverRepository('/repo/with/failing/maintenance')

    expect(result.directories[0].children).toContain('src/')
    expect(mockPort.awaitReadiness).toHaveBeenCalled()
    expect(mockPort.awaitSnapshot).not.toHaveBeenCalled()
  })

  it('Harness 18: Outras tools mantêm awaitSnapshot e não usam readiness simplificada de inventário', async () => {
    const elementId = '0000000000000001'
    const targetId = createFullTargetId(elementId)
    const mockPort: CodeMapNavigationPort = {
      awaitSnapshot: vi.fn(async () => {}),
      awaitReadiness: vi.fn(async () => {}),
      getFiles: vi.fn(() => sampleFiles),
      getElements: vi.fn(() => [
        {
          id: elementId,
          fileId: 'f1',
          name: 'myFn',
          kind: 'function',
          startLine: 1,
          endLine: 5,
          retrievable: true,
          location: {
            start: { line: 1, column: 0, byte: 0 },
            end: { line: 5, column: 1, byte: 20 }
          }
        } as CodeMapElement
      ]),
      getRelationships: vi.fn(() => [
        { id: 'rel-1', sourceId: 'src/index.ts', targetId: 'src/utils.ts', type: 'imports' } as CodeMapRelationship
      ]),
      getSymbolReferencesByTargetElement: vi.fn(() => []),
      getSymbolReferencesBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsByTargetElement: vi.fn(() => []),
      getElementExactSources: vi.fn(async () => new Map([
        [elementId, { source: 'function myFn() {}', startLine: 1, endLine: 5, startByte: 0, endByte: 20, relativePath: 'src/index.ts' }]
      ]))
    }

    const engine = new ContextEngine(mockPort)

    // inspectFiles
    await engine.inspectFiles('/test/repo', ['src/index.ts'])
    expect(mockPort.awaitSnapshot).toHaveBeenCalledTimes(1)
    expect(mockPort.awaitReadiness).not.toHaveBeenCalled()

    // getRelationships
    await engine.getRelationships('/test/repo', ['src/index.ts'])
    expect(mockPort.awaitSnapshot).toHaveBeenCalledTimes(2)

    // readCode
    await engine.readCode('/test/repo', [targetId])
    expect(mockPort.awaitSnapshot).toHaveBeenCalledTimes(3)

    // getReferences
    await engine.getReferences('/test/repo', [targetId])
    expect(mockPort.awaitSnapshot).toHaveBeenCalledTimes(4)

    // getSymbolDependencies
    await engine.getSymbolDependencies('/test/repo', [targetId])
    expect(mockPort.awaitSnapshot).toHaveBeenCalledTimes(5)

    // getSymbolHierarchy
    await engine.getSymbolHierarchy('/test/repo', [targetId])
    expect(mockPort.awaitSnapshot).toHaveBeenCalledTimes(6)

    // Somente discoverRepository usa awaitReadiness
    await engine.discoverRepository('/test/repo')
    expect(mockPort.awaitReadiness).toHaveBeenCalledTimes(1)
    expect(mockPort.awaitSnapshot).toHaveBeenCalledTimes(6) // sem incremento em awaitSnapshot
  })

  it('Harness 12: Diagnostic Zoom by Design — emite traces de readiness com capability FILE_INVENTORY e drilldown localiza com precisão', async () => {
    const recordedEvents: CodeScopeTraceEvent[] = []
    const trace = {
      record: (ev: CodeScopeTraceEvent) => {
        recordedEvents.push(ev)
      }
    }
    const context: NavigationInvocationContext = {
      requestId: 'req-readiness-test',
      sessionId: 'sess-001',
      trace
    }

    const mockPort: CodeMapNavigationPort = {
      awaitSnapshot: vi.fn(async () => {}),
      awaitReadiness: vi.fn(async () => {}),
      getFiles: vi.fn(() => sampleFiles),
      getElements: vi.fn(() => []),
      getRelationships: vi.fn(() => []),
      getSymbolReferencesByTargetElement: vi.fn(() => []),
      getSymbolReferencesBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsByTargetElement: vi.fn(() => []),
      getElementExactSources: vi.fn(async () => new Map())
    }

    const engine = new ContextEngine(mockPort)
    await engine.discoverRepository('/test/repo', ['.'], context)

    // Verifica que os estágios específicos de readiness foram emitidos com capability FILE_INVENTORY
    const reqEvent = recordedEvents.find((e) => e.stage === 'codescope-readiness-requested')
    const satEvent = recordedEvents.find((e) => e.stage === 'codescope-readiness-satisfied')
    expect(reqEvent).toBeDefined()
    expect(reqEvent?.capability).toBe('FILE_INVENTORY')
    expect(reqEvent?.tool).toBe('discover_repository')
    expect(satEvent).toBeDefined()
    expect(satEvent?.capability).toBe('FILE_INVENTORY')
    expect(satEvent?.status).toBe('success')

    // Drilldown em caso de falha de readiness isola especificamente CodeMap Readiness / FILE_INVENTORY
    const failureEvents: CodeScopeTraceEvent[] = [
      {
        timestamp: new Date().toISOString(),
        requestId: 'req-fail',
        sessionId: 'sess-fail',
        method: 'tools/call',
        tool: 'discover_repository',
        stage: 'codescope-operation-routed',
        durationMs: 1,
        status: 'success'
      },
      {
        timestamp: new Date().toISOString(),
        requestId: 'req-fail',
        sessionId: 'sess-fail',
        method: 'tools/call',
        tool: 'discover_repository',
        stage: 'codescope-readiness-requested',
        capability: 'FILE_INVENTORY',
        durationMs: 0,
        status: 'started'
      },
      {
        timestamp: new Date().toISOString(),
        requestId: 'req-fail',
        sessionId: 'sess-fail',
        method: 'tools/call',
        tool: 'discover_repository',
        stage: 'codescope-readiness-failed',
        capability: 'FILE_INVENTORY',
        durationMs: 50,
        status: 'error',
        error: 'REPOSITORY_NOT_ACCESSIBLE'
      }
    ]

    const drilldown = codeScopeExecutionDrilldownProvider.evaluate(failureEvents, 'REPOSITORY_NOT_ACCESSIBLE')
    expect(drilldown).not.toBeNull()
    expect(drilldown?.state).toBe('LOCALIZED')
    expect(drilldown?.firstFailedCheckpoint).toBe('Snapshot Synchronization')
    expect(drilldown?.refinedInvestigationTarget).toEqual({
      systemArea: 'CodeMap Readiness',
      component: 'CodeMap Service / Readiness (FILE_INVENTORY)',
      boundary: 'Context Engine → CodeMap Readiness',
      responsibility: 'Awaiting repository readiness capability FILE_INVENTORY before query',
      investigationSeeds: [
        'src/main/core/code-map-service.ts',
        'src/main/core/context/context-engine.ts'
      ]
    })
    expect(drilldown?.diagnosticResolution).toBe('COMPONENT')
    expect(drilldown?.observabilityGap.state).toBe('NONE')
    expect(drilldown?.resolutionSufficient).toBe(true)
  })
})
