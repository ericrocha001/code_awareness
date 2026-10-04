/**
 * Testes do CodeMapSyncMonitor e CodeMapSyncDrilldownProvider.
 *
 * Valida:
 * - Tracking de fronteiras de sincronização via telemetria
 * - Enriquecimento do drilldown do System Health
 * - Invariantes de non-throwing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { CodeMapSyncMonitor, CodeMapSyncDrilldownProvider, CODEMAP_SYNC_CHECKPOINTS } from './codemap-sync-monitor'
import { telemetryService } from '../core/telemetry-service'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fireEvent(component: 'CHANGE_DETECTION' | 'CODE_MAP' | 'WATCHER', event: string, payload?: unknown): void {
  telemetryService.log('test-cid', component, event, payload)
}

// Base drilldown provider stub
const stubProvider = {
  canonicalStage: 'CodeScope Execution' as const,
  evaluate: (_events: unknown[], _reason?: string | null) => ({
    canonicalStage: 'CodeScope Execution' as const,
    state: 'LOCALIZED' as const,
    precision: 'EXACT' as const,
    lastSuccessfulCheckpoint: 'Operation Routing',
    firstFailedCheckpoint: 'Snapshot Synchronization',
    firstBlockedCheckpoint: 'Index Query',
    reasonCode: 'REQUEST_TIMEOUT',
    checkpoints: []
  })
}

// ─── CodeMapSyncMonitor ───────────────────────────────────────────────────────

describe('CodeMapSyncMonitor', () => {
  let monitor: CodeMapSyncMonitor

  beforeEach(() => {
    monitor = new CodeMapSyncMonitor()
    monitor.connect()
  })

  afterEach(() => {
    monitor.dispose()
  })

  it('inicia sem estado de repositório', () => {
    expect(monitor.getDeepestActiveFrontier()).toBeNull()
    expect(monitor.hasActiveReindexFailure()).toBe(false)
  })

  it('rastreia Repository Observation ao receber OBSERVED', () => {
    fireEvent('CHANGE_DETECTION', 'OBSERVED', { relativePath: 'src/main.ts' })
    expect(monitor.getDeepestActiveFrontier()).toBe('Repository Observation')
  })

  it('rastreia Change Intake ao receber INTAKE_ACCEPTED', () => {
    fireEvent('CHANGE_DETECTION', 'INTAKE_ACCEPTED', { relativePath: 'src/main.ts' })
    expect(monitor.getDeepestActiveFrontier()).toBe('Change Intake')
  })

  it('rastreia Change Stabilization', () => {
    fireEvent('CHANGE_DETECTION', 'STABILIZE_CHECK', { relativePath: 'src/main.ts' })
    expect(monitor.getDeepestActiveFrontier()).toBe('Change Stabilization')
  })

  it('rastreia Change Verification', () => {
    fireEvent('CHANGE_DETECTION', 'CONFIRMED_MODIFIED', { relativePath: 'src/main.ts' })
    expect(monitor.getDeepestActiveFrontier()).toBe('Change Verification')
  })

  it('rastreia File Reindex', () => {
    fireEvent('CHANGE_DETECTION', 'AUTO_REINDEX_COMPLETED', { relativePath: 'src/main.ts' })
    expect(monitor.getDeepestActiveFrontier()).toBe('File Reindex')
  })

  it('rastreia Relationship Resolution ao receber RELATIONSHIP_RESOLUTION_COMPLETED', () => {
    fireEvent('CODE_MAP', 'RELATIONSHIP_RESOLUTION_COMPLETED', { relativePath: 'src/main.ts' })
    expect(monitor.getDeepestActiveFrontier()).toBe('Relationship Resolution')
  })

  it('Relationship Resolution é a fronteira mais profunda após File Reindex', () => {
    fireEvent('CHANGE_DETECTION', 'AUTO_REINDEX_COMPLETED', { relativePath: 'src/a.ts' })
    fireEvent('CODE_MAP', 'RELATIONSHIP_RESOLUTION_COMPLETED', { relativePath: 'src/a.ts' })
    expect(monitor.getDeepestActiveFrontier()).toBe('Relationship Resolution')
  })

  it('mantém fronteira mais profunda já vista', () => {
    fireEvent('CHANGE_DETECTION', 'OBSERVED', { relativePath: 'src/a.ts' })
    fireEvent('CHANGE_DETECTION', 'AUTO_REINDEX_COMPLETED', { relativePath: 'src/a.ts' })
    fireEvent('CHANGE_DETECTION', 'OBSERVED', { relativePath: 'src/b.ts' })
    // A fronteira mais profunda (File Reindex) permanece mesmo quando um novo OBSERVED chega
    expect(monitor.getDeepestActiveFrontier()).toBe('File Reindex')
  })

  it('detecta falha ativa de reindex ao receber AUTO_REINDEX_FAILED', () => {
    fireEvent('CHANGE_DETECTION', 'AUTO_REINDEX_FAILED', {
      relativePath: 'src/main.ts',
      error: 'parse error'
    })
    expect(monitor.hasActiveReindexFailure()).toBe(true)
  })

  it('limpa falha de reindex ao receber AUTO_REINDEX_COMPLETED', () => {
    fireEvent('CHANGE_DETECTION', 'AUTO_REINDEX_FAILED', {
      relativePath: 'src/main.ts',
      error: 'parse error'
    })
    fireEvent('CHANGE_DETECTION', 'AUTO_REINDEX_COMPLETED', { relativePath: 'src/main.ts' })
    expect(monitor.hasActiveReindexFailure()).toBe(false)
  })

  it('ignora componentes irrelevantes (PERSISTENCE, INTEGRITY)', () => {
    telemetryService.log('cid', 'PERSISTENCE', 'SOME_EVENT', { repoPath: '/repo' })
    telemetryService.log('cid', 'INTEGRITY', 'SOME_EVENT', { repoPath: '/repo' })
    expect(monitor.getDeepestActiveFrontier()).toBeNull()
  })

  it('não lança quando payload é nulo ou ausente', () => {
    expect(() => fireEvent('CHANGE_DETECTION', 'OBSERVED')).not.toThrow()
    expect(() => fireEvent('CHANGE_DETECTION', 'AUTO_REINDEX_FAILED')).not.toThrow()
    expect(() => fireEvent('CODE_MAP', 'RELATIONSHIP_RESOLUTION_FAILED')).not.toThrow()
  })

  it('detecta falha ativa de relationship resolution ao receber RELATIONSHIP_RESOLUTION_FAILED', () => {
    fireEvent('CODE_MAP', 'RELATIONSHIP_RESOLUTION_FAILED', {
      relativePath: 'src/main.ts',
      error: 'resolver error'
    })
    expect(monitor.hasActiveReindexFailure()).toBe(true)
  })

  it('limpa falha de relationship resolution ao receber RELATIONSHIP_RESOLUTION_COMPLETED', () => {
    fireEvent('CODE_MAP', 'RELATIONSHIP_RESOLUTION_FAILED', {
      relativePath: 'src/main.ts',
      error: 'resolver error'
    })
    fireEvent('CODE_MAP', 'RELATIONSHIP_RESOLUTION_COMPLETED', { relativePath: 'src/main.ts' })
    expect(monitor.hasActiveReindexFailure()).toBe(false)
  })

  it('dispose: para de receber eventos', () => {
    monitor.dispose()
    fireEvent('CHANGE_DETECTION', 'OBSERVED', { relativePath: 'src/main.ts' })
    expect(monitor.getDeepestActiveFrontier()).toBeNull()
  })
})

// ─── CodeMapSyncDrilldownProvider ────────────────────────────────────────────

describe('CodeMapSyncDrilldownProvider', () => {
  let monitor: CodeMapSyncMonitor
  let provider: CodeMapSyncDrilldownProvider

  beforeEach(() => {
    monitor = new CodeMapSyncMonitor()
    monitor.connect()
    provider = new CodeMapSyncDrilldownProvider(monitor, stubProvider)
  })

  afterEach(() => {
    monitor.dispose()
  })

  it('delega ao provider base quando firstFailedCheckpoint não é Snapshot Synchronization', () => {
    const base = {
      canonicalStage: 'CodeScope Execution' as const,
      evaluate: () => ({
        canonicalStage: 'CodeScope Execution' as const,
        state: 'LOCALIZED' as const,
        precision: 'EXACT' as const,
        lastSuccessfulCheckpoint: null,
        firstFailedCheckpoint: 'Operation Routing',
        firstBlockedCheckpoint: 'Snapshot Synchronization',
        reasonCode: 'ROUTING_FAILED',
        checkpoints: []
      })
    }
    const p = new CodeMapSyncDrilldownProvider(monitor, base)
    const result = p.evaluate([])
    expect(result?.firstFailedCheckpoint).toBe('Operation Routing')
    // Não deve enriquecer — mantém o resultado base
    expect(result?.diagnosticResolution).toBeUndefined()
  })

  it('enriquece Snapshot Synchronization com fronteira do CodeMap quando há evidência', () => {
    // Simula atividade no Change Stabilization
    fireEvent('CHANGE_DETECTION', 'STABILIZE_CHECK', { relativePath: 'src/main.ts' })

    const result = provider.evaluate([])
    expect(result).not.toBeNull()
    expect(result?.firstFailedCheckpoint).toBe('Snapshot Synchronization')
    expect(result?.deepestProvenProgress).toContain('Change Stabilization')
    expect(result?.diagnosticResolution).toBe('COMPONENT')
    expect(result?.resolutionSufficient).toBe(true)
    expect(result?.refinedInvestigationTarget?.component).toContain('RepositorySynchronizer')
  })

  it('não enriquece quando não há evidência de atividade no CodeMap', () => {
    // Monitor sem atividade — frontier = null
    const result = provider.evaluate([])
    expect(result).not.toBeNull()
    // Sem fronteira conhecida, retorna o resultado base sem enriquecimento
    expect(result?.firstFailedCheckpoint).toBe('Snapshot Synchronization')
    expect(result?.diagnosticResolution).toBeUndefined()
  })

  it('retorna null quando base provider retorna null', () => {
    const nullBase = {
      canonicalStage: 'CodeScope Execution' as const,
      evaluate: () => null
    }
    const p = new CodeMapSyncDrilldownProvider(monitor, nullBase)
    expect(p.evaluate([])).toBeNull()
  })

  it('refined target para File Reindex contém seeds corretos', () => {
    fireEvent('CHANGE_DETECTION', 'AUTO_REINDEX_COMPLETED', { relativePath: 'src/main.ts' })
    const result = provider.evaluate([])
    expect(result?.refinedInvestigationTarget?.investigationSeeds).toContain('src/main/core/repository-synchronizer.ts')
  })

  it('refined target para Relationship Resolution contém seeds corretos', () => {
    fireEvent('CODE_MAP', 'RELATIONSHIP_RESOLUTION_COMPLETED', { relativePath: 'src/main.ts' })
    const result = provider.evaluate([])
    expect(result?.refinedInvestigationTarget?.investigationSeeds).toContain('src/main/core/relationship-resolver.ts')
    expect(result?.deepestProvenProgress).toContain('Relationship Resolution')
  })
})
