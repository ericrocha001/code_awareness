/**
 * Testes de contrato de addressability do catálogo diagnóstico do CodeMap.
 *
 * Garante que:
 * 1. Toda fronteira declarada tem investigation target completo
 * 2. Toda fronteira tem pelo menos um evento de evidência declarado
 * 3. IDs são únicos
 * 4. Funções de lookup funcionam corretamente
 * 5. Nenhuma fronteira com errorEvents declarados fica sem mecanismo de diagnóstico
 *
 * Este teste DEVE falhar se uma nova fronteira for adicionada sem target ou evidência.
 */

import { describe, it, expect } from 'vitest'
import {
  CODEMAP_DIAGNOSTIC_CATALOG,
  BOUNDARY_BY_ID,
  boundariesByArea,
  boundariesByFlow,
  type DiagnosticBoundary,
  type CodeMapDiagnosticArea,
  type CodeMapDiagnosticFlow
} from './codemap-diagnostic-catalog'

// ─── Contrato de Addressability ───────────────────────────────────────────────

describe('CodeMap Diagnostic Catalog — Addressability Contract', () => {
  it('catálogo não está vazio', () => {
    expect(CODEMAP_DIAGNOSTIC_CATALOG.length).toBeGreaterThan(20)
  })

  it('todos os IDs são únicos', () => {
    const ids = CODEMAP_DIAGNOSTIC_CATALOG.map(b => b.id)
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
  })

  it('BOUNDARY_BY_ID contém todas as fronteiras', () => {
    for (const boundary of CODEMAP_DIAGNOSTIC_CATALOG) {
      expect(BOUNDARY_BY_ID.has(boundary.id)).toBe(true)
      expect(BOUNDARY_BY_ID.get(boundary.id)).toBe(boundary)
    }
  })

  it('toda fronteira tem InvestigationTarget completo', () => {
    const missingFields: string[] = []
    for (const boundary of CODEMAP_DIAGNOSTIC_CATALOG) {
      const { target } = boundary
      if (!target.systemArea) missingFields.push(`${boundary.id}: missing target.systemArea`)
      if (!target.component) missingFields.push(`${boundary.id}: missing target.component`)
      if (!target.boundary) missingFields.push(`${boundary.id}: missing target.boundary`)
      if (!target.responsibility) missingFields.push(`${boundary.id}: missing target.responsibility`)
      if (!target.investigationSeeds || target.investigationSeeds.length === 0) {
        missingFields.push(`${boundary.id}: missing target.investigationSeeds`)
      }
    }
    expect(missingFields).toEqual([])
  })

  it('investigation seeds apontam para arquivos existentes ou pastas válidas', () => {
    // Verificação de formato — não de existência em disco (evita dependência de FS nos testes Node)
    for (const boundary of CODEMAP_DIAGNOSTIC_CATALOG) {
      for (const seed of boundary.target.investigationSeeds) {
        expect(seed).toMatch(/^src\//)
        expect(seed.length).toBeGreaterThan(4)
      }
    }
  })

  it('toda fronteira tem pelo menos um evidenceEvent', () => {
    const missing = CODEMAP_DIAGNOSTIC_CATALOG.filter(b => b.evidenceEvents.length === 0)
    const missingIds = missing.map(b => b.id)
    expect(missingIds).toEqual([])
  })

  it('toda fronteira pertence a uma área válida', () => {
    const validAreas: CodeMapDiagnosticArea[] = [
      'Repository Lifecycle',
      'Repository Knowledge Acquisition',
      'Incremental Synchronization',
      'Repository Convergence',
      'Symbol Knowledge',
      'Background Maintenance',
      'Integrity',
      'Readiness'
    ]
    for (const boundary of CODEMAP_DIAGNOSTIC_CATALOG) {
      expect(validAreas).toContain(boundary.area)
    }
  })

  it('toda fronteira participa de pelo menos um fluxo', () => {
    for (const boundary of CODEMAP_DIAGNOSTIC_CATALOG) {
      expect(boundary.flows.length).toBeGreaterThan(0)
    }
  })

  it('nomes de fronteiras são únicos', () => {
    const names = CODEMAP_DIAGNOSTIC_CATALOG.map(b => b.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })
})

// ─── Presença obrigatória de fronteiras por área ──────────────────────────────

describe('CodeMap Diagnostic Catalog — Required Boundaries', () => {
  const byId = BOUNDARY_BY_ID

  it('Repository Lifecycle tem as fronteiras canônicas', () => {
    expect(byId.has('repo-activation')).toBe(true)
    expect(byId.has('repo-store')).toBe(true)
    expect(byId.has('repo-runtime-composition')).toBe(true)
    expect(byId.has('repo-deactivation')).toBe(true)
  })

  it('Repository Knowledge Acquisition tem todas as fronteiras essenciais', () => {
    expect(byId.has('source-read')).toBe(true)
    expect(byId.has('structure-extraction')).toBe(true)
    expect(byId.has('structural-persistence')).toBe(true)
    expect(byId.has('relationship-resolution')).toBe(true)
    expect(byId.has('relationship-persistence')).toBe(true)
    expect(byId.has('membership-classification')).toBe(true)
  })

  it('Incremental Synchronization preserva os 7 checkpoints existentes', () => {
    // Os 7 checkpoints que o CodeMapSyncMonitor já rastreia
    expect(byId.has('repo-observation')).toBe(true)
    expect(byId.has('path-eligibility')).toBe(true)
    expect(byId.has('change-intake')).toBe(true)
    expect(byId.has('change-stabilization')).toBe(true)
    expect(byId.has('change-verification')).toBe(true)
    expect(byId.has('file-reindex')).toBe(true)
    expect(byId.has('relationship-resolution')).toBe(true) // compartilhada com Knowledge Acquisition
  })

  it('Background Maintenance tem todos os 6 estágios de backfill', () => {
    expect(byId.has('maintenance-content-identity')).toBe(true)
    expect(byId.has('maintenance-context-ref')).toBe(true)
    expect(byId.has('maintenance-token-metadata')).toBe(true)
    expect(byId.has('maintenance-text-documents')).toBe(true)
    expect(byId.has('maintenance-declaration-sigs')).toBe(true)
    expect(byId.has('maintenance-symbol-refs')).toBe(true)
  })

  it('Symbol Knowledge tem resolução e persistência separadas', () => {
    expect(byId.has('symbol-ref-resolution')).toBe(true)
    expect(byId.has('symbol-ref-persistence')).toBe(true)
  })

  it('Integrity tem as três fases distintas', () => {
    expect(byId.has('integrity-discovery')).toBe(true)
    expect(byId.has('integrity-repair')).toBe(true)
    expect(byId.has('integrity-verification')).toBe(true)
  })

  it('Readiness tem as 4 capabilities', () => {
    expect(byId.has('readiness-file-inventory')).toBe(true)
    expect(byId.has('readiness-structure')).toBe(true)
    expect(byId.has('readiness-relationships')).toBe(true)
    expect(byId.has('readiness-snapshot')).toBe(true)
  })

  it('Repository Convergence tem as fronteiras de reconciliação', () => {
    expect(byId.has('disk-bank-reconciliation')).toBe(true)
    expect(byId.has('convergence-repair')).toBe(true)
  })
})

// ─── Lookup functions ─────────────────────────────────────────────────────────

describe('CodeMap Diagnostic Catalog — Lookup Functions', () => {
  it('boundariesByArea retorna somente fronteiras da área', () => {
    const lifecycle = boundariesByArea('Repository Lifecycle')
    expect(lifecycle.length).toBeGreaterThan(0)
    expect(lifecycle.every(b => b.area === 'Repository Lifecycle')).toBe(true)
  })

  it('boundariesByFlow retorna somente fronteiras do fluxo', () => {
    const startup = boundariesByFlow('startup')
    expect(startup.length).toBeGreaterThan(0)
    expect(startup.every(b => b.flows.includes('startup'))).toBe(true)
  })

  it('fluxo snapshot-maintenance inclui todas as etapas de backfill', () => {
    const maintenance = boundariesByFlow('snapshot-maintenance')
    const ids = maintenance.map(b => b.id)
    expect(ids).toContain('maintenance-content-identity')
    expect(ids).toContain('maintenance-context-ref')
    expect(ids).toContain('maintenance-token-metadata')
    expect(ids).toContain('maintenance-text-documents')
    expect(ids).toContain('maintenance-declaration-sigs')
    expect(ids).toContain('maintenance-symbol-refs')
  })

  it('fluxo initial-indexing inclui source-read, extraction, persistence, relationships', () => {
    const indexing = boundariesByFlow('initial-indexing')
    const ids = indexing.map(b => b.id)
    expect(ids).toContain('source-read')
    expect(ids).toContain('structure-extraction')
    expect(ids).toContain('structural-persistence')
    expect(ids).toContain('relationship-resolution')
  })

  it('fronteiras com errorEvents têm boundary id diagnosticamente endereçável', () => {
    const withErrors = CODEMAP_DIAGNOSTIC_CATALOG.filter(b => b.errorEvents.length > 0)
    // Toda fronteira com errorEvents deve ter investigation seeds não-vazia
    for (const boundary of withErrors) {
      expect(boundary.target.investigationSeeds.length).toBeGreaterThan(0)
    }
  })
})

// ─── Invariante diagnóstica: resposta à pergunta ──────────────────────────────

describe('Diagnostic Map — Questão de Investigação', () => {
  it('dado qualquer boundary id, conseguimos responder "qual responsabilidade pode estar falhando"', () => {
    for (const boundary of CODEMAP_DIAGNOSTIC_CATALOG) {
      const target = BOUNDARY_BY_ID.get(boundary.id)!.target
      expect(target.responsibility.length).toBeGreaterThan(20)
    }
  })

  it('dado qualquer boundary id, conseguimos responder "onde investigar"', () => {
    for (const boundary of CODEMAP_DIAGNOSTIC_CATALOG) {
      const seeds = BOUNDARY_BY_ID.get(boundary.id)!.target.investigationSeeds
      expect(seeds.length).toBeGreaterThan(0)
    }
  })

  it('todas as 8 áreas arquiteturais estão representadas', () => {
    const areas = new Set(CODEMAP_DIAGNOSTIC_CATALOG.map(b => b.area))
    expect(areas.size).toBe(8)
  })
})
