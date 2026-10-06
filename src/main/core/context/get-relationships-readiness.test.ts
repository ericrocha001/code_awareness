import { RepositoryChangeReadiness } from '../repository-change-readiness'
/**
 * Testes de contrato de readiness para get_relationships e get_symbol_hierarchy.
 *
 * Prova que:
 * 1. backgroundMaintenance (backfills pesados) não bloqueia get_relationships
 * 2. synchronizer idle drains antes de retornar (barreira causal correta)
 * 3. filesystem noise não impede readiness quando os eventos são rejeitados pelo intake gate
 * 4. falha de snapshot não contamina get_relationships
 * 5. get_symbol_hierarchy usa o mesmo contrato RELATIONSHIPS
 */

import { describe, expect, it, vi } from 'vitest'
import { ContextEngine } from './context-engine'
import type { CodeMapNavigationPort } from './context-navigation-port'
import type { CodeMapElement, CodeMapFile, CodeMapRelationship } from '../../../shared/types'
import { CodeMapService } from '../code-map-service'
import { WatcherService } from '../watcher-service'
import type { CompressionPort } from '../compression-port'
import { createFullTargetId } from './code-target'

// ─── Fixtures ───────────────────────────────────────────────────────────────

const sampleFiles: CodeMapFile[] = [
  { id: 'f1', relativePath: 'src/index.ts', contentHash: 'h1' } as CodeMapFile,
  { id: 'f2', relativePath: 'src/utils.ts', contentHash: 'h2' } as CodeMapFile,
]

const sampleElements: CodeMapElement[] = [
  {
    id: '0000000000000001',
    fileId: 'f1',
    name: 'App',
    kind: 'class',
    parentElementId: null,
    startLine: 1,
    endLine: 10,
    retrievable: true,
    location: { start: { line: 1, column: 0, byte: 0 }, end: { line: 10, column: 1, byte: 100 } }
  } as CodeMapElement
]

const sampleRelationships: CodeMapRelationship[] = [
  {
    id: 'r1',
    repositoryId: 'test-repo',
    sourceId: '0000000000000001',
    targetId: 'f2',
    sourceKind: 'element',
    targetKind: 'file',
    type: 'imports'
  } as CodeMapRelationship
]

vi.mock('../repository-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../repository-model')>()
  return {
    ...actual,
    createRepositoryModel: vi.fn((repoPath: string) => {
      const isWarm = repoPath.includes('warm')
      return {
        readiness: new RepositoryChangeReadiness(),
        getRepoPath: () => repoPath,
        getRepositoryId: () => 'test-repo-id',
        pruneKnownBinaryFiles: () => {},
        getRepository: () => ({ id: 'test-repo-id', path: repoPath }),
        getFiles: () => (isWarm ? [...sampleFiles] : []),
        getModifiedFiles: () => [],
        getElementsByRepository: () => (isWarm ? [...sampleElements] : []),
        getRelationships: () => (isWarm ? [...sampleRelationships] : []),
        getHierarchyRelationshipsBySourceElement: () => [],
        getHierarchyRelationshipsByTargetElement: () => [],
        getSymbolReferencesByTargetElement: () => [],
        getSymbolReferencesBySourceElement: () => [],
        indexRepository: vi.fn(async () => ({ filesIndexed: 0, elementsExtracted: 0 })),
        reconcileWithDisk: vi.fn(async () => ({})),
        backfillContentHashes: vi.fn(async () => 0),
        backfillContextReferences: vi.fn(async () => 0),
        backfillTokenMetadata: vi.fn(async () => 0),
        backfillTextDocuments: vi.fn(async () => 0),
        backfillDeclarationSignatures: vi.fn(async () => 0),
        backfillSymbolReferences: vi.fn(async () => 0),
        close: vi.fn(() => {})
      }
    })
  }
})

const dummyCompression: CompressionPort = {
  async generateCompressionMarkdown() { throw new Error('unused') }
}

class ReadOnlyWatcherService extends WatcherService {
  override subscribe(): () => void { return () => {} }
}

function makeBlockingPort(longPendingMs = 10_000): {
  port: CodeMapNavigationPort
  snapshotWaited: () => boolean
  maintenanceFinished: () => boolean
} {
  let snapshotWaited = false
  let maintenanceFinished = false

  const pendingMaintenance = new Promise<void>((resolve) => {
    setTimeout(() => { maintenanceFinished = true; resolve() }, longPendingMs)
  })

  const port: CodeMapNavigationPort = {
    awaitSnapshot: vi.fn(async () => {
      snapshotWaited = true
      await pendingMaintenance
    }),
    awaitReadiness: vi.fn(async (_repoPath: string, capability: string) => {
      if (capability === 'RELATIONSHIPS') return   // resolve imediatamente
      await pendingMaintenance                      // outros bloqueiam
    }),
    getFiles: vi.fn(() => sampleFiles),
    getElements: vi.fn(() => sampleElements),
    getRelationships: vi.fn(() => sampleRelationships),
    getHierarchyRelationshipsBySourceElement: vi.fn(() => []),
    getHierarchyRelationshipsByTargetElement: vi.fn(() => []),
    getSymbolReferencesByTargetElement: vi.fn(() => []),
    getSymbolReferencesBySourceElement: vi.fn(() => []),
    getElementExactSources: vi.fn(async () => new Map())
  } as unknown as CodeMapNavigationPort

  return {
    port,
    snapshotWaited: () => snapshotWaited,
    maintenanceFinished: () => maintenanceFinished,
  }
}

// ─── Testes ──────────────────────────────────────────────────────────────────

describe('get_relationships readiness contract', () => {
  it('1. backgroundMaintenance pendente não bloqueia get_relationships', async () => {
    const { port, snapshotWaited, maintenanceFinished } = makeBlockingPort(10_000)

    const engine = new ContextEngine(port)
    const startedAt = performance.now()
    const result = await engine.getRelationships('/test/repo', ['src/index.ts'])
    const elapsed = performance.now() - startedAt

    expect(result.files).toHaveLength(1)
    expect(result.files[0].relativePath).toBe('src/index.ts')
    expect(port.awaitReadiness).toHaveBeenCalledWith('/test/repo', 'RELATIONSHIPS')
    expect(snapshotWaited()).toBe(false)
    expect(maintenanceFinished()).toBe(false)
    expect(elapsed).toBeLessThan(200)
  })

  it('2. synchronizer idle é aguardado antes de retornar (barreira causal)', async () => {
    let synchronizerIdleResolved = false
    const port: CodeMapNavigationPort = {
      awaitSnapshot: vi.fn(),
      awaitReadiness: vi.fn(async (_repoPath: string, capability: string) => {
        if (capability === 'RELATIONSHIPS') {
          // Simula waitForIdle de ~50ms
          await new Promise<void>(resolve => setTimeout(() => {
            synchronizerIdleResolved = true
            resolve()
          }, 50))
        }
      }),
      getFiles: vi.fn(() => sampleFiles),
      getElements: vi.fn(() => sampleElements),
      getRelationships: vi.fn(() => sampleRelationships),
      getHierarchyRelationshipsBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsByTargetElement: vi.fn(() => []),
      getSymbolReferencesByTargetElement: vi.fn(() => []),
      getSymbolReferencesBySourceElement: vi.fn(() => []),
      getElementExactSources: vi.fn(async () => new Map())
    } as unknown as CodeMapNavigationPort

    const engine = new ContextEngine(port)
    const result = await engine.getRelationships('/test/repo', ['src/index.ts'])

    expect(result.files[0].out).toBeDefined()
    expect(synchronizerIdleResolved).toBe(true)
    expect(port.awaitReadiness).toHaveBeenCalledWith('/test/repo', 'RELATIONSHIPS')
    expect(port.awaitSnapshot).not.toHaveBeenCalled()
  })

  it('3. awaitReadiness é chamado com RELATIONSHIPS, nunca com snapshot global', async () => {
    const port: CodeMapNavigationPort = {
      awaitSnapshot: vi.fn(async () => { throw new Error('awaitSnapshot não deve ser chamado') }),
      awaitReadiness: vi.fn(async () => {}),
      getFiles: vi.fn(() => sampleFiles),
      getElements: vi.fn(() => sampleElements),
      getRelationships: vi.fn(() => sampleRelationships),
      getHierarchyRelationshipsBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsByTargetElement: vi.fn(() => []),
      getSymbolReferencesByTargetElement: vi.fn(() => []),
      getSymbolReferencesBySourceElement: vi.fn(() => []),
      getElementExactSources: vi.fn(async () => new Map())
    } as unknown as CodeMapNavigationPort

    const engine = new ContextEngine(port)
    await expect(engine.getRelationships('/test/repo', ['src/index.ts'])).resolves.toBeDefined()

    expect(port.awaitReadiness).toHaveBeenCalledWith('/test/repo', 'RELATIONSHIPS')
    expect(port.awaitSnapshot).not.toHaveBeenCalled()
  })

  it('4. resultado retorna edges in/out corretos', async () => {
    const port: CodeMapNavigationPort = {
      awaitReadiness: vi.fn(async () => {}),
      awaitSnapshot: vi.fn(),
      getFiles: vi.fn(() => sampleFiles),
      getElements: vi.fn(() => sampleElements),
      getRelationships: vi.fn(() => sampleRelationships),
      getHierarchyRelationshipsBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsByTargetElement: vi.fn(() => []),
      getSymbolReferencesByTargetElement: vi.fn(() => []),
      getSymbolReferencesBySourceElement: vi.fn(() => []),
      getElementExactSources: vi.fn(async () => new Map())
    } as unknown as CodeMapNavigationPort

    const engine = new ContextEngine(port)
    const result = await engine.getRelationships('/test/repo', ['src/index.ts'], { direction: 'out' })

    expect(result.files[0].out).toBeDefined()
    expect(result.files[0].out).toContainEqual(expect.objectContaining({ relativePath: 'src/utils.ts' }))
    expect(result.files[0].in).toBeUndefined()
  })

  it('5. warm repository CodeMapService real — get_relationships responde sem aguardar maintenance', async () => {
    const watcher = new ReadOnlyWatcherService()
    const service = new CodeMapService(watcher, dummyCompression)
    const repoPath = '/workspace/warm-relationships-repo'

    try {
      await service.openRepository(repoPath)
      const engine = new ContextEngine(service as unknown as CodeMapNavigationPort)

      const started = performance.now()
      const result = await engine.getRelationships(repoPath, ['src/index.ts'])
      const duration = performance.now() - started

      expect(result.files).toHaveLength(1)
      // Com warm repo os relacionamentos já estão persistidos — resposta rápida
      expect(duration).toBeLessThan(500)
    } finally {
      service.closeAll()
      watcher.stop()
    }
  })
})

describe('get_symbol_hierarchy readiness contract', () => {
  // O target ID precisa ser o formato real do engine: createFullTargetId(elementId)
  const validTarget = createFullTargetId(sampleElements[0].id)

  it('1. backgroundMaintenance pendente não bloqueia get_symbol_hierarchy', async () => {
    const { port, snapshotWaited, maintenanceFinished } = makeBlockingPort(10_000)

    const engine = new ContextEngine(port)
    const startedAt = performance.now()
    await engine.getSymbolHierarchy('/test/repo', [validTarget])
    const elapsed = performance.now() - startedAt

    expect(port.awaitReadiness).toHaveBeenCalledWith('/test/repo', 'RELATIONSHIPS')
    expect(snapshotWaited()).toBe(false)
    expect(maintenanceFinished()).toBe(false)
    expect(elapsed).toBeLessThan(200)
  })

  it('2. get_symbol_hierarchy usa awaitReadiness RELATIONSHIPS, não awaitSnapshot', async () => {
    const port: CodeMapNavigationPort = {
      awaitSnapshot: vi.fn(async () => { throw new Error('awaitSnapshot não deve ser chamado') }),
      awaitReadiness: vi.fn(async () => {}),
      getFiles: vi.fn(() => sampleFiles),
      getElements: vi.fn(() => sampleElements),
      getRelationships: vi.fn(() => sampleRelationships),
      getHierarchyRelationshipsBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsByTargetElement: vi.fn(() => []),
      getSymbolReferencesByTargetElement: vi.fn(() => []),
      getSymbolReferencesBySourceElement: vi.fn(() => []),
      getElementExactSources: vi.fn(async () => new Map())
    } as unknown as CodeMapNavigationPort

    const engine = new ContextEngine(port)
    await expect(
      engine.getSymbolHierarchy('/test/repo', [validTarget])
    ).resolves.toBeDefined()

    expect(port.awaitReadiness).toHaveBeenCalledWith('/test/repo', 'RELATIONSHIPS')
    expect(port.awaitSnapshot).not.toHaveBeenCalled()
  })
})

describe('RELATIONSHIPS vs snapshot — isolation', () => {
  it('get_references usa SYMBOL_REFERENCES sem snapshot global', async () => {
    let snapshotCalled = false
    let readinessCalled = false

    const port: CodeMapNavigationPort = {
      awaitSnapshot: vi.fn(async () => { snapshotCalled = true }),
      awaitReadiness: vi.fn(async () => { readinessCalled = true }),
      getFiles: vi.fn(() => sampleFiles),
      getElements: vi.fn(() => sampleElements),
      getRelationships: vi.fn(() => []),
      getHierarchyRelationshipsBySourceElement: vi.fn(() => []),
      getHierarchyRelationshipsByTargetElement: vi.fn(() => []),
      getSymbolReferencesByTargetElement: vi.fn(() => []),
      getSymbolReferencesBySourceElement: vi.fn(() => []),
      getElementExactSources: vi.fn(async () => new Map())
    } as unknown as CodeMapNavigationPort

    const engine = new ContextEngine(port)
    // Usa o formato real de target ID: createFullTargetId com elemento retrievable
    const elemId = createFullTargetId(sampleElements[0].id)
    await engine.getReferences('/test/repo', [elemId])

    expect(snapshotCalled).toBe(false)
    expect(readinessCalled).toBe(true)
    expect(port.awaitReadiness).toHaveBeenCalledWith('/test/repo', 'SYMBOL_REFERENCES')
  })

  it('RELATIONSHIPS readiness não espera backgroundMaintenance — CodeMapService real', async () => {
    const watcher = new ReadOnlyWatcherService()
    const service = new CodeMapService(watcher, dummyCompression)
    const repoPath = '/workspace/relationships-readiness-real'

    try {
      await service.openRepository(repoPath)

      const startedAt = performance.now()
      await service.awaitReadiness(repoPath, 'RELATIONSHIPS')
      const elapsed = performance.now() - startedAt

      // waitForIdle é rápido quando não há eventos pendentes
      expect(elapsed).toBeLessThan(500)
    } finally {
      service.closeAll()
      watcher.stop()
    }
  })
})
