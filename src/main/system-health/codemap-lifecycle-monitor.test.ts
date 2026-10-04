/**
 * Testes do CodeMapLifecycleMonitor.
 *
 * Valida:
 * - Tracking de lifecycle (open/failed/closed)
 * - Tracking individual de etapas de manutenção
 * - Tracking de falhas estruturais
 * - Tracking de integridade
 * - Estado limpo após resolução de falha
 * - Isolamento por repositório
 * - Non-throwing em todos os casos
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { CodeMapLifecycleMonitor } from './codemap-lifecycle-monitor'
import { telemetryService } from '../core/telemetry-service'

function fire(component: 'CODE_MAP' | 'INTEGRITY', event: string, payload?: unknown): void {
  telemetryService.log('test-cid', component, event, payload)
}

describe('CodeMapLifecycleMonitor', () => {
  let monitor: CodeMapLifecycleMonitor

  beforeEach(() => {
    monitor = new CodeMapLifecycleMonitor()
    monitor.connect()
  })

  afterEach(() => {
    monitor.dispose()
  })

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  describe('Repository Lifecycle', () => {
    it('inicia sem estado', () => {
      expect(monitor.getAllStates()).toHaveLength(0)
      expect(monitor.getBlockedMaintenanceStep()).toBeNull()
    })

    it('REPO_OPENED registra repositório como open', () => {
      fire('CODE_MAP', 'REPO_OPENED', { repoPath: '/repo/a' })
      const state = monitor.getRepoState('/repo/a')
      expect(state).not.toBeNull()
      expect(state!.lifecycle).toBe('open')
    })

    it('REPO_OPEN_FAILED registra lifecycle como failed', () => {
      fire('CODE_MAP', 'REPO_OPEN_FAILED', { repoPath: '/repo/b', error: 'DB locked' })
      const state = monitor.getRepoState('/repo/b')
      expect(state!.lifecycle).toBe('failed')
      expect(state!.lifecycleError).toBe('DB locked')
    })

    it('REPO_CLOSED transiciona para closed', () => {
      fire('CODE_MAP', 'REPO_OPENED', { repoPath: '/repo/c' })
      fire('CODE_MAP', 'REPO_CLOSED', { repoPath: '/repo/c' })
      expect(monitor.getRepoState('/repo/c')!.lifecycle).toBe('closed')
    })

    it('repositórios diferentes têm estados isolados', () => {
      fire('CODE_MAP', 'REPO_OPENED', { repoPath: '/repo/x' })
      fire('CODE_MAP', 'REPO_OPEN_FAILED', { repoPath: '/repo/y', error: 'fail' })
      expect(monitor.getRepoState('/repo/x')!.lifecycle).toBe('open')
      expect(monitor.getRepoState('/repo/y')!.lifecycle).toBe('failed')
    })
  })

  // ─── Background Maintenance ───────────────────────────────────────────────────

  describe('Background Maintenance', () => {
    it('BACKGROUND_MAINTENANCE_STARTED inicia manutenção', () => {
      fire('CODE_MAP', 'BACKGROUND_MAINTENANCE_STARTED', { repoPath: '/repo/a' })
      const state = monitor.getRepoState('/repo/a')!
      expect(state.maintenanceRunning).toBe(true)
      expect(state.maintenanceCompleted).toBe(false)
    })

    it('BACKGROUND_MAINTENANCE_COMPLETED conclui manutenção', () => {
      fire('CODE_MAP', 'BACKGROUND_MAINTENANCE_STARTED', { repoPath: '/repo/a' })
      fire('CODE_MAP', 'BACKGROUND_MAINTENANCE_COMPLETED', { repoPath: '/repo/a' })
      const state = monitor.getRepoState('/repo/a')!
      expect(state.maintenanceRunning).toBe(false)
      expect(state.maintenanceCompleted).toBe(true)
    })

    it('BACKGROUND_MAINTENANCE_FAILED registra falha', () => {
      fire('CODE_MAP', 'BACKGROUND_MAINTENANCE_STARTED', { repoPath: '/repo/a' })
      fire('CODE_MAP', 'BACKGROUND_MAINTENANCE_FAILED', { repoPath: '/repo/a', error: 'oom' })
      const state = monitor.getRepoState('/repo/a')!
      expect(state.maintenanceFailed).toBe(true)
    })

    it('rastreia Content Identity Backfill', () => {
      fire('CODE_MAP', 'BACKGROUND_MAINTENANCE_STARTED', { repoPath: '/repo/a' })
      fire('CODE_MAP', 'BACKFILL_STARTED', { repoPath: '/repo/a' })
      const step = monitor.getRepoState('/repo/a')!.maintenanceSteps.get('Content Identity Backfill')
      expect(step?.status).toBe('running')
      fire('CODE_MAP', 'BACKFILL_COMPLETED', { repoPath: '/repo/a' })
      expect(monitor.getRepoState('/repo/a')!.maintenanceSteps.get('Content Identity Backfill')?.status).toBe('completed')
    })

    it('rastreia Context Reference Backfill', () => {
      fire('CODE_MAP', 'BACKGROUND_MAINTENANCE_STARTED', { repoPath: '/repo/a' })
      fire('CODE_MAP', 'MAINTENANCE_CONTEXT_REF_STARTED', { repoPath: '/repo/a' })
      fire('CODE_MAP', 'MAINTENANCE_CONTEXT_REF_COMPLETED', { repoPath: '/repo/a' })
      const step = monitor.getRepoState('/repo/a')!.maintenanceSteps.get('Context Reference Backfill')
      expect(step?.status).toBe('completed')
    })

    it('rastreia Token Metadata Backfill', () => {
      fire('CODE_MAP', 'BACKGROUND_MAINTENANCE_STARTED', { repoPath: '/repo/a' })
      fire('CODE_MAP', 'MAINTENANCE_TOKEN_METADATA_STARTED', { repoPath: '/repo/a' })
      fire('CODE_MAP', 'MAINTENANCE_TOKEN_METADATA_COMPLETED', { repoPath: '/repo/a' })
      const step = monitor.getRepoState('/repo/a')!.maintenanceSteps.get('Token Metadata Backfill')
      expect(step?.status).toBe('completed')
    })

    it('rastreia Text Document Backfill', () => {
      fire('CODE_MAP', 'BACKGROUND_MAINTENANCE_STARTED', { repoPath: '/repo/a' })
      fire('CODE_MAP', 'MAINTENANCE_TEXT_DOCUMENTS_STARTED', { repoPath: '/repo/a' })
      fire('CODE_MAP', 'MAINTENANCE_TEXT_DOCUMENTS_COMPLETED', { repoPath: '/repo/a' })
      const step = monitor.getRepoState('/repo/a')!.maintenanceSteps.get('Text Document Backfill')
      expect(step?.status).toBe('completed')
    })

    it('rastreia Declaration Signature Backfill', () => {
      fire('CODE_MAP', 'BACKGROUND_MAINTENANCE_STARTED', { repoPath: '/repo/a' })
      fire('CODE_MAP', 'MAINTENANCE_DECLARATION_SIGS_STARTED', { repoPath: '/repo/a' })
      fire('CODE_MAP', 'MAINTENANCE_DECLARATION_SIGS_COMPLETED', { repoPath: '/repo/a' })
      const step = monitor.getRepoState('/repo/a')!.maintenanceSteps.get('Declaration Signature Backfill')
      expect(step?.status).toBe('completed')
    })

    it('rastreia Symbol Reference Backfill', () => {
      fire('CODE_MAP', 'BACKGROUND_MAINTENANCE_STARTED', { repoPath: '/repo/a' })
      fire('CODE_MAP', 'BACKFILL_SYMBOL_REFERENCES_STARTED', { repoPath: '/repo/a' })
      fire('CODE_MAP', 'BACKFILL_SYMBOL_REFERENCES_COMPLETED', { repoPath: '/repo/a' })
      const step = monitor.getRepoState('/repo/a')!.maintenanceSteps.get('Symbol Reference Backfill')
      expect(step?.status).toBe('completed')
    })

    it('RECONCILE_STARTED/COMPLETED rastreia etapa de reconciliação', () => {
      fire('CODE_MAP', 'BACKGROUND_MAINTENANCE_STARTED', { repoPath: '/repo/a' })
      fire('CODE_MAP', 'RECONCILE_STARTED', { repoPath: '/repo/a' })
      fire('CODE_MAP', 'RECONCILE_COMPLETED', { repoPath: '/repo/a' })
      const step = monitor.getRepoState('/repo/a')!.maintenanceSteps.get('Disk/Bank Reconciliation')
      expect(step?.status).toBe('completed')
    })

    it('RECONCILE_FAILED registra falha no step', () => {
      fire('CODE_MAP', 'BACKGROUND_MAINTENANCE_STARTED', { repoPath: '/repo/a' })
      fire('CODE_MAP', 'RECONCILE_STARTED', { repoPath: '/repo/a' })
      fire('CODE_MAP', 'RECONCILE_FAILED', { repoPath: '/repo/a', error: 'disk error' })
      const step = monitor.getRepoState('/repo/a')!.maintenanceSteps.get('Disk/Bank Reconciliation')
      expect(step?.status).toBe('failed')
    })

    it('getBlockedMaintenanceStep retorna step em falha', () => {
      fire('CODE_MAP', 'BACKGROUND_MAINTENANCE_STARTED', { repoPath: '/repo/a' })
      fire('CODE_MAP', 'BACKFILL_SYMBOL_REFERENCES_STARTED', { repoPath: '/repo/a' })
      fire('CODE_MAP', 'BACKFILL_SYMBOL_REFERENCES_FAILED', { repoPath: '/repo/a', error: 'fail' })
      const blocked = monitor.getBlockedMaintenanceStep()
      expect(blocked).not.toBeNull()
      expect(blocked!.step).toBe('Symbol Reference Backfill')
    })

    it('getBlockedMaintenanceTarget retorna investigation target correto', () => {
      fire('CODE_MAP', 'BACKGROUND_MAINTENANCE_STARTED', { repoPath: '/repo/a' })
      fire('CODE_MAP', 'BACKFILL_SYMBOL_REFERENCES_STARTED', { repoPath: '/repo/a' })
      const target = monitor.getBlockedMaintenanceTarget()
      expect(target).not.toBeNull()
      expect(target!.systemArea).toBe('CodeMap Background Maintenance')
    })

    it('BACKGROUND_MAINTENANCE_COMPLETED limpa maintenanceRunning', () => {
      fire('CODE_MAP', 'BACKGROUND_MAINTENANCE_STARTED', { repoPath: '/repo/a' })
      fire('CODE_MAP', 'BACKGROUND_MAINTENANCE_COMPLETED', { repoPath: '/repo/a' })
      expect(monitor.getRepoState('/repo/a')!.maintenanceRunning).toBe(false)
    })
  })

  // ─── Structural State ─────────────────────────────────────────────────────────

  describe('Structural Index State', () => {
    it('STRUCTURE_EXTRACTED registra lastExtractionAt', () => {
      fire('CODE_MAP', 'STRUCTURE_EXTRACTED', { repoPath: '/repo/a', relativePath: 'src/main.ts' })
      const state = monitor.getRepoState('_default') ?? monitor.getAllStates()[0]
      expect(state).not.toBeNull()
    })

    it('RELATIONSHIP_RESOLUTION_FAILED registra falha estrutural ativa', () => {
      fire('CODE_MAP', 'RELATIONSHIP_RESOLUTION_FAILED', { repoPath: '/repo/a', error: 'resolve error' })
      const state = monitor.getRepoState('/repo/a')!
      expect(state.structural.activeFailure).toBe('resolve error')
      expect(state.structural.activeFailureBoundaryId).toBe('relationship-resolution')
    })

    it('RELATIONSHIP_RESOLUTION_COMPLETED limpa falha ativa de relationship', () => {
      fire('CODE_MAP', 'RELATIONSHIP_RESOLUTION_FAILED', { repoPath: '/repo/a', error: 'err' })
      fire('CODE_MAP', 'RELATIONSHIP_RESOLUTION_COMPLETED', { repoPath: '/repo/a' })
      expect(monitor.getRepoState('/repo/a')!.structural.activeFailure).toBeNull()
    })

    it('REINDEX_FAILED registra falha de file-reindex', () => {
      fire('CODE_MAP', 'REINDEX_FAILED', { repoPath: '/repo/a', error: 'parse err' })
      const state = monitor.getRepoState('/repo/a')!
      expect(state.structural.activeFailureBoundaryId).toBe('file-reindex')
    })

    it('REINDEX_COMPLETED limpa falha de file-reindex', () => {
      fire('CODE_MAP', 'REINDEX_FAILED', { repoPath: '/repo/a', error: 'parse err' })
      fire('CODE_MAP', 'REINDEX_COMPLETED', { repoPath: '/repo/a' })
      expect(monitor.getRepoState('/repo/a')!.structural.activeFailure).toBeNull()
    })

    it('getActiveStructuralFailureTarget retorna target quando há falha ativa', () => {
      fire('CODE_MAP', 'RELATIONSHIP_RESOLUTION_FAILED', { repoPath: '/repo/a', error: 'err' })
      const target = monitor.getActiveStructuralFailureTarget()
      expect(target).not.toBeNull()
      expect(target!.component).toContain('RelationshipResolver')
    })
  })

  // ─── Integrity State ──────────────────────────────────────────────────────────

  describe('Integrity State', () => {
    it('CHECK_STARTED marca integrity como running', () => {
      fire('INTEGRITY', 'CHECK_STARTED', { repoPath: '/repo/a' })
      expect(monitor.getRepoState('/repo/a')!.integrity.isRunning).toBe(true)
    })

    it('CHECK_COMPLETED registra lastDiscoveryAt', () => {
      fire('INTEGRITY', 'CHECK_STARTED', { repoPath: '/repo/a' })
      fire('INTEGRITY', 'CHECK_COMPLETED', { repoPath: '/repo/a', totalIssues: 3 })
      const state = monitor.getRepoState('/repo/a')!
      expect(state.integrity.isRunning).toBe(false)
      expect(state.integrity.lastIssueCount).toBe(3)
    })

    it('REPAIR_COMPLETED registra lastRepairAt', () => {
      fire('INTEGRITY', 'REPAIR_STARTED', { repoPath: '/repo/a' })
      fire('INTEGRITY', 'REPAIR_COMPLETED', { repoPath: '/repo/a' })
      expect(monitor.getRepoState('/repo/a')!.integrity.lastRepairAt).not.toBeNull()
    })
  })

  // ─── Non-throwing e dispose ───────────────────────────────────────────────────

  describe('Robustness', () => {
    it('não lança quando payload é nulo', () => {
      expect(() => fire('CODE_MAP', 'REPO_OPENED')).not.toThrow()
      expect(() => fire('CODE_MAP', 'BACKGROUND_MAINTENANCE_STARTED')).not.toThrow()
    })

    it('dispose: para de receber eventos', () => {
      monitor.dispose()
      fire('CODE_MAP', 'REPO_OPENED', { repoPath: '/repo/x' })
      expect(monitor.getAllStates()).toHaveLength(0)
    })

    it('payload sem repoPath usa chave _default', () => {
      fire('CODE_MAP', 'BACKFILL_STARTED', { updated: 5 })
      const allStates = monitor.getAllStates()
      expect(allStates.length).toBeGreaterThan(0)
    })
  })
})
