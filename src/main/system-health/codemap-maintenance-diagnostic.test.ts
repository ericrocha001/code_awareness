/**
 * Testes de diagnóstico de manutenção do CodeMap.
 *
 * Cobre:
 * 1. Step success: STARTED → COMPLETED, mesmo correlation ID, estado = completed
 * 2. Step failure: STARTED → FAILED, exceção propagada, estado = failed
 * 3. Session failure: step A completes, step B fails, step C não aparece como completed
 * 4. Investigation target: step falhado retorna Investigation Target do catálogo
 * 5. Correlation chain: todos os eventos de uma sessão usam o mesmo cid
 * 6. Recovery: step falhado re-executa com sucesso → active fault limpo
 * 7. Multi-repo isolation: duas sessões não contaminam estados
 * 8. running vs failed: distinção explícita no monitor
 * 9. Catálogo: todas as fronteiras de maintenance têm errorEvents com FAILED
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { CodeMapLifecycleMonitor } from './codemap-lifecycle-monitor'
import { telemetryService } from '../core/telemetry-service'
import {
  CODEMAP_DIAGNOSTIC_CATALOG,
  boundariesByArea
} from './codemap-diagnostic-catalog'

function emit(event: string, payload?: unknown): void {
  telemetryService.log('session-cid', 'CODE_MAP', event, payload)
}

function emitWithCid(cid: string, event: string, payload?: unknown): void {
  telemetryService.log(cid, 'CODE_MAP', event, payload)
}

function emitError(event: string, payload?: unknown): void {
  telemetryService.logError('session-cid', 'CODE_MAP', event, payload)
}

const REPO_A = '/repo/alpha'
const REPO_B = '/repo/beta'

// ─── 1. Step success ─────────────────────────────────────────────────────────

describe('Step success — STARTED → COMPLETED', () => {
  let monitor: CodeMapLifecycleMonitor

  beforeEach(() => { monitor = new CodeMapLifecycleMonitor().connect() })
  afterEach(() => { monitor.dispose() })

  it('Context Reference Backfill: status = completed após COMPLETED', () => {
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_CONTEXT_REF_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_CONTEXT_REF_COMPLETED', { repoPath: REPO_A })

    const step = monitor.getRepoState(REPO_A)!.maintenanceSteps.get('Context Reference Backfill')
    expect(step?.status).toBe('completed')
    expect(step?.startedAt).not.toBeNull()
    expect(step?.completedAt).not.toBeNull()
  })

  it('Token Metadata Backfill: status = completed', () => {
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_TOKEN_METADATA_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_TOKEN_METADATA_COMPLETED', { repoPath: REPO_A })
    const step = monitor.getRepoState(REPO_A)!.maintenanceSteps.get('Token Metadata Backfill')
    expect(step?.status).toBe('completed')
  })

  it('Text Document Backfill: status = completed', () => {
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_TEXT_DOCUMENTS_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_TEXT_DOCUMENTS_COMPLETED', { repoPath: REPO_A })
    const step = monitor.getRepoState(REPO_A)!.maintenanceSteps.get('Text Document Backfill')
    expect(step?.status).toBe('completed')
  })

  it('Declaration Signature Backfill: status = completed', () => {
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_DECLARATION_SIGS_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_DECLARATION_SIGS_COMPLETED', { repoPath: REPO_A })
    const step = monitor.getRepoState(REPO_A)!.maintenanceSteps.get('Declaration Signature Backfill')
    expect(step?.status).toBe('completed')
  })

  it('Content Identity Backfill: status = completed', () => {
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    emit('BACKFILL_STARTED', { repoPath: REPO_A })
    emit('BACKFILL_COMPLETED', { repoPath: REPO_A })
    const step = monitor.getRepoState(REPO_A)!.maintenanceSteps.get('Content Identity Backfill')
    expect(step?.status).toBe('completed')
  })
})

// ─── 2. Step failure — STARTED → FAILED, estado = failed ─────────────────────

describe('Step failure — STARTED → FAILED', () => {
  let monitor: CodeMapLifecycleMonitor

  beforeEach(() => { monitor = new CodeMapLifecycleMonitor().connect() })
  afterEach(() => { monitor.dispose() })

  it('Context Reference Backfill: status = failed após FAILED', () => {
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_CONTEXT_REF_STARTED', { repoPath: REPO_A })
    telemetryService.logError('session-cid', 'CODE_MAP', 'MAINTENANCE_CONTEXT_REF_FAILED', {
      repoPath: REPO_A, error: 'DB locked'
    })
    const step = monitor.getRepoState(REPO_A)!.maintenanceSteps.get('Context Reference Backfill')
    expect(step?.status).toBe('failed')
    expect(step?.error).toBe('DB locked')
  })

  it('Token Metadata Backfill: status = failed', () => {
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_TOKEN_METADATA_STARTED', { repoPath: REPO_A })
    telemetryService.logError('session-cid', 'CODE_MAP', 'MAINTENANCE_TOKEN_METADATA_FAILED', {
      repoPath: REPO_A, error: 'OOM'
    })
    const step = monitor.getRepoState(REPO_A)!.maintenanceSteps.get('Token Metadata Backfill')
    expect(step?.status).toBe('failed')
  })

  it('Text Document Backfill: status = failed', () => {
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_TEXT_DOCUMENTS_STARTED', { repoPath: REPO_A })
    telemetryService.logError('session-cid', 'CODE_MAP', 'MAINTENANCE_TEXT_DOCUMENTS_FAILED', {
      repoPath: REPO_A, error: 'parse error'
    })
    const step = monitor.getRepoState(REPO_A)!.maintenanceSteps.get('Text Document Backfill')
    expect(step?.status).toBe('failed')
  })

  it('Declaration Signature Backfill: status = failed', () => {
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_DECLARATION_SIGS_STARTED', { repoPath: REPO_A })
    telemetryService.logError('session-cid', 'CODE_MAP', 'MAINTENANCE_DECLARATION_SIGS_FAILED', {
      repoPath: REPO_A, error: 'extractor fail'
    })
    const step = monitor.getRepoState(REPO_A)!.maintenanceSteps.get('Declaration Signature Backfill')
    expect(step?.status).toBe('failed')
  })

  it('Content Identity Backfill: status = failed', () => {
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    emit('BACKFILL_STARTED', { repoPath: REPO_A })
    telemetryService.logError('session-cid', 'CODE_MAP', 'BACKFILL_FAILED', {
      repoPath: REPO_A, error: 'read error'
    })
    const step = monitor.getRepoState(REPO_A)!.maintenanceSteps.get('Content Identity Backfill')
    expect(step?.status).toBe('failed')
  })
})

// ─── 3. Session failure — A completes, B fails, outer failure ─────────────────

describe('Session failure — step sequence', () => {
  let monitor: CodeMapLifecycleMonitor

  beforeEach(() => { monitor = new CodeMapLifecycleMonitor().connect() })
  afterEach(() => { monitor.dispose() })

  it('step A completes, step B fails: A=completed, B=failed', () => {
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    // Step A: Context Ref → completes
    emit('MAINTENANCE_CONTEXT_REF_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_CONTEXT_REF_COMPLETED', { repoPath: REPO_A })
    // Step B: Token Metadata → fails
    emit('MAINTENANCE_TOKEN_METADATA_STARTED', { repoPath: REPO_A })
    telemetryService.logError('session-cid', 'CODE_MAP', 'MAINTENANCE_TOKEN_METADATA_FAILED', {
      repoPath: REPO_A, error: 'OOM'
    })
    // Outer failure fired
    telemetryService.logError('session-cid', 'CODE_MAP', 'BACKGROUND_MAINTENANCE_FAILED', {
      repoPath: REPO_A, error: 'OOM'
    })

    const state = monitor.getRepoState(REPO_A)!
    expect(state.maintenanceSteps.get('Context Reference Backfill')?.status).toBe('completed')
    expect(state.maintenanceSteps.get('Token Metadata Backfill')?.status).toBe('failed')
    expect(state.maintenanceFailed).toBe(true)
    expect(state.maintenanceRunning).toBe(false)
  })

  it('step C (Declaration Sigs) não aparece quando sessão falhou em step B', () => {
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_CONTEXT_REF_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_CONTEXT_REF_COMPLETED', { repoPath: REPO_A })
    emit('MAINTENANCE_TOKEN_METADATA_STARTED', { repoPath: REPO_A })
    telemetryService.logError('session-cid', 'CODE_MAP', 'MAINTENANCE_TOKEN_METADATA_FAILED', {
      repoPath: REPO_A, error: 'OOM'
    })
    telemetryService.logError('session-cid', 'CODE_MAP', 'BACKGROUND_MAINTENANCE_FAILED', {
      repoPath: REPO_A, error: 'OOM'
    })

    const state = monitor.getRepoState(REPO_A)!
    // Declaration Sigs nunca foi iniciado — não deve aparecer como completed
    expect(state.maintenanceSteps.has('Declaration Signature Backfill')).toBe(false)
  })
})

// ─── 4. Investigation Target — step falhado retorna target do catálogo ─────────

describe('Investigation Target on failure', () => {
  let monitor: CodeMapLifecycleMonitor

  beforeEach(() => { monitor = new CodeMapLifecycleMonitor().connect() })
  afterEach(() => { monitor.dispose() })

  it('Token Metadata FAILED → getBlockedMaintenanceTarget retorna target correto', () => {
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_TOKEN_METADATA_STARTED', { repoPath: REPO_A })
    telemetryService.logError('session-cid', 'CODE_MAP', 'MAINTENANCE_TOKEN_METADATA_FAILED', {
      repoPath: REPO_A, error: 'OOM'
    })
    telemetryService.logError('session-cid', 'CODE_MAP', 'BACKGROUND_MAINTENANCE_FAILED', {
      repoPath: REPO_A
    })

    const target = monitor.getBlockedMaintenanceTarget()
    expect(target).not.toBeNull()
    expect(target!.systemArea).toBe('CodeMap Background Maintenance')
    expect(target!.component).toContain('backfillTokenMetadata')
    expect(target!.investigationSeeds).toContain('src/main/core/repository-model.ts')
  })

  it('Context Reference FAILED → getBlockedMaintenanceStep retorna boundary id correto', () => {
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_CONTEXT_REF_STARTED', { repoPath: REPO_A })
    telemetryService.logError('session-cid', 'CODE_MAP', 'MAINTENANCE_CONTEXT_REF_FAILED', {
      repoPath: REPO_A, error: 'DB error'
    })
    telemetryService.logError('session-cid', 'CODE_MAP', 'BACKGROUND_MAINTENANCE_FAILED', {
      repoPath: REPO_A
    })

    const blocked = monitor.getBlockedMaintenanceStep()
    expect(blocked).not.toBeNull()
    expect(blocked!.boundaryId).toBe('maintenance-context-ref')
  })

  it('failed preferred over running when both exist', () => {
    // Simula: context-ref completed, token-meta failed, text-docs running
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_CONTEXT_REF_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_CONTEXT_REF_COMPLETED', { repoPath: REPO_A })
    emit('MAINTENANCE_TOKEN_METADATA_STARTED', { repoPath: REPO_A })
    telemetryService.logError('session-cid', 'CODE_MAP', 'MAINTENANCE_TOKEN_METADATA_FAILED', {
      repoPath: REPO_A
    })
    // Text docs still appears as started (running) due to hypothetical ordering
    emit('MAINTENANCE_TEXT_DOCUMENTS_STARTED', { repoPath: REPO_A })
    telemetryService.logError('session-cid', 'CODE_MAP', 'BACKGROUND_MAINTENANCE_FAILED', { repoPath: REPO_A })

    // Should return the FAILED step (token metadata), not the running one
    const blocked = monitor.getBlockedMaintenanceStep()
    expect(blocked!.step).toBe('Token Metadata Backfill')
    expect(blocked!.boundaryId).toBe('maintenance-token-metadata')
  })
})

// ─── 5. Correlation chain — mesma sessão usa o mesmo cid ──────────────────────

describe('Correlation chain — single cid per session', () => {
  it('todos os eventos de uma sessão usam o mesmo correlation ID', () => {
    const capturedCids: string[] = []
    const unsub = telemetryService.subscribe(e => {
      if (e.component === 'CODE_MAP' && e.event.startsWith('MAINTENANCE')) {
        capturedCids.push(e.correlationId)
      }
    })

    const sessionCid = 'maintenance-session-test-cid'
    emitWithCid(sessionCid, 'MAINTENANCE_CONTEXT_REF_STARTED', { repoPath: REPO_A })
    emitWithCid(sessionCid, 'MAINTENANCE_CONTEXT_REF_COMPLETED', { repoPath: REPO_A })
    emitWithCid(sessionCid, 'MAINTENANCE_TOKEN_METADATA_STARTED', { repoPath: REPO_A })
    emitWithCid(sessionCid, 'MAINTENANCE_TOKEN_METADATA_COMPLETED', { repoPath: REPO_A })

    unsub()

    // Todos os 4 eventos têm o mesmo sessionCid
    expect(capturedCids).toHaveLength(4)
    expect(capturedCids.every(cid => cid === sessionCid)).toBe(true)
  })

  it('dois repositórios usam cids de sessão distintos', () => {
    const cidsByRepo: Record<string, Set<string>> = { [REPO_A]: new Set(), [REPO_B]: new Set() }

    const unsub = telemetryService.subscribe(e => {
      if (e.component !== 'CODE_MAP') return
      const p = e.payload as Record<string, unknown> | undefined
      const rp = p?.['repoPath'] as string | undefined
      if (rp === REPO_A) cidsByRepo[REPO_A].add(e.correlationId)
      if (rp === REPO_B) cidsByRepo[REPO_B].add(e.correlationId)
    })

    emitWithCid('cid-A', 'MAINTENANCE_CONTEXT_REF_STARTED', { repoPath: REPO_A })
    emitWithCid('cid-B', 'MAINTENANCE_CONTEXT_REF_STARTED', { repoPath: REPO_B })

    unsub()

    expect(cidsByRepo[REPO_A].has('cid-A')).toBe(true)
    expect(cidsByRepo[REPO_B].has('cid-B')).toBe(true)
    // Os dois cids são distintos
    expect(cidsByRepo[REPO_A].has('cid-B')).toBe(false)
  })
})

// ─── 6. Recovery — falha → nova sessão bem-sucedida limpa active fault ────────

describe('Recovery', () => {
  let monitor: CodeMapLifecycleMonitor

  beforeEach(() => { monitor = new CodeMapLifecycleMonitor().connect() })
  afterEach(() => { monitor.dispose() })

  it('nova sessão bem-sucedida após falha limpa o estado', () => {
    // Primeira sessão falha
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_TOKEN_METADATA_STARTED', { repoPath: REPO_A })
    telemetryService.logError('session-cid', 'CODE_MAP', 'MAINTENANCE_TOKEN_METADATA_FAILED', {
      repoPath: REPO_A, error: 'fail'
    })
    telemetryService.logError('session-cid', 'CODE_MAP', 'BACKGROUND_MAINTENANCE_FAILED', { repoPath: REPO_A })

    expect(monitor.getBlockedMaintenanceStep()).not.toBeNull()

    // Segunda sessão inicia e limpa o estado
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    // Nova sessão: step que antes falhava agora completa
    emit('MAINTENANCE_TOKEN_METADATA_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_TOKEN_METADATA_COMPLETED', { repoPath: REPO_A })
    emit('BACKGROUND_MAINTENANCE_COMPLETED', { repoPath: REPO_A })

    // Active fault deve ser limpo
    expect(monitor.getBlockedMaintenanceStep()).toBeNull()
    expect(monitor.getRepoState(REPO_A)!.maintenanceFailed).toBe(false)
    expect(monitor.getRepoState(REPO_A)!.maintenanceCompleted).toBe(true)
  })

  it('BACKGROUND_MAINTENANCE_STARTED limpa steps da sessão anterior', () => {
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_CONTEXT_REF_STARTED', { repoPath: REPO_A })
    telemetryService.logError('session-cid', 'CODE_MAP', 'MAINTENANCE_CONTEXT_REF_FAILED', { repoPath: REPO_A })
    telemetryService.logError('session-cid', 'CODE_MAP', 'BACKGROUND_MAINTENANCE_FAILED', { repoPath: REPO_A })

    // Nova sessão — steps são limpos
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    expect(monitor.getRepoState(REPO_A)!.maintenanceSteps.size).toBe(0)
    expect(monitor.getRepoState(REPO_A)!.maintenanceFailed).toBe(false)
  })
})

// ─── 7. Multi-repo isolation ───────────────────────────────────────────────────

describe('Multi-repository isolation', () => {
  let monitor: CodeMapLifecycleMonitor

  beforeEach(() => { monitor = new CodeMapLifecycleMonitor().connect() })
  afterEach(() => { monitor.dispose() })

  it('falha em REPO_A não afeta estado de REPO_B', () => {
    // REPO_A: maintenance started + step fails
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_TOKEN_METADATA_STARTED', { repoPath: REPO_A })
    telemetryService.logError('session-cid', 'CODE_MAP', 'MAINTENANCE_TOKEN_METADATA_FAILED', {
      repoPath: REPO_A, error: 'fail'
    })
    telemetryService.logError('session-cid', 'CODE_MAP', 'BACKGROUND_MAINTENANCE_FAILED', { repoPath: REPO_A })

    // REPO_B: maintenance starts normally
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_B })
    emit('MAINTENANCE_CONTEXT_REF_STARTED', { repoPath: REPO_B })
    emit('MAINTENANCE_CONTEXT_REF_COMPLETED', { repoPath: REPO_B })

    expect(monitor.getRepoState(REPO_A)!.maintenanceFailed).toBe(true)
    expect(monitor.getRepoState(REPO_B)!.maintenanceFailed).toBe(false)
    expect(monitor.getRepoState(REPO_B)!.maintenanceSteps.get('Context Reference Backfill')?.status).toBe('completed')
  })

  it('getBlockedMaintenanceStep retorna o step do repositório com falha', () => {
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_B })
    emit('MAINTENANCE_CONTEXT_REF_STARTED', { repoPath: REPO_B })
    emit('MAINTENANCE_CONTEXT_REF_COMPLETED', { repoPath: REPO_B })
    emit('BACKGROUND_MAINTENANCE_COMPLETED', { repoPath: REPO_B })

    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_DECLARATION_SIGS_STARTED', { repoPath: REPO_A })
    telemetryService.logError('session-cid', 'CODE_MAP', 'MAINTENANCE_DECLARATION_SIGS_FAILED', {
      repoPath: REPO_A
    })
    telemetryService.logError('session-cid', 'CODE_MAP', 'BACKGROUND_MAINTENANCE_FAILED', { repoPath: REPO_A })

    const blocked = monitor.getBlockedMaintenanceStep()
    expect(blocked!.step).toBe('Declaration Signature Backfill')
  })
})

// ─── 8. running vs failed — distinção explícita ───────────────────────────────

describe('running vs failed — explicit distinction', () => {
  let monitor: CodeMapLifecycleMonitor

  beforeEach(() => { monitor = new CodeMapLifecycleMonitor().connect() })
  afterEach(() => { monitor.dispose() })

  it('step com STARTED mas sem COMPLETED/FAILED = running', () => {
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_CONTEXT_REF_STARTED', { repoPath: REPO_A })

    const step = monitor.getRepoState(REPO_A)!.maintenanceSteps.get('Context Reference Backfill')
    expect(step?.status).toBe('running')
  })

  it('step com FAILED = failed (não confunde com running)', () => {
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_CONTEXT_REF_STARTED', { repoPath: REPO_A })
    telemetryService.logError('session-cid', 'CODE_MAP', 'MAINTENANCE_CONTEXT_REF_FAILED', { repoPath: REPO_A })

    const step = monitor.getRepoState(REPO_A)!.maintenanceSteps.get('Context Reference Backfill')
    expect(step?.status).toBe('failed')
    expect(step?.status).not.toBe('running')
  })

  it('ausência de evento terminal = running (não infere falha)', () => {
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_TEXT_DOCUMENTS_STARTED', { repoPath: REPO_A })
    // Sem COMPLETED e sem FAILED

    const step = monitor.getRepoState(REPO_A)!.maintenanceSteps.get('Text Document Backfill')
    expect(step?.status).toBe('running')
  })

  it('getBlockedMaintenanceStep com step running retorna o step', () => {
    emit('BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO_A })
    emit('MAINTENANCE_DECLARATION_SIGS_STARTED', { repoPath: REPO_A })
    // Step ainda running

    const blocked = monitor.getBlockedMaintenanceStep()
    expect(blocked).not.toBeNull()
    expect(blocked!.step).toBe('Declaration Signature Backfill')
  })
})

// ─── 9. Catálogo: todas as fronteiras de maintenance têm errorEvents ──────────

describe('Catalog completeness — maintenance boundaries have errorEvents', () => {
  it('todas as fronteiras de Background Maintenance têm pelo menos um errorEvent', () => {
    const maintenanceBoundaries = boundariesByArea('Background Maintenance')
    expect(maintenanceBoundaries.length).toBeGreaterThan(0)

    const missingErrorEvents = maintenanceBoundaries.filter(b => b.errorEvents.length === 0)
    expect(missingErrorEvents.map(b => b.id)).toEqual([])
  })

  it('cada maintenance boundary tem seu FAILED event correspondente', () => {
    const expected: Record<string, string> = {
      'maintenance-content-identity': 'BACKFILL_FAILED',
      'maintenance-context-ref':      'MAINTENANCE_CONTEXT_REF_FAILED',
      'maintenance-token-metadata':   'MAINTENANCE_TOKEN_METADATA_FAILED',
      'maintenance-text-documents':   'MAINTENANCE_TEXT_DOCUMENTS_FAILED',
      'maintenance-declaration-sigs': 'MAINTENANCE_DECLARATION_SIGS_FAILED',
      'maintenance-symbol-refs':      'BACKFILL_SYMBOL_REFERENCES_FAILED',
    }

    for (const [boundaryId, failedEvent] of Object.entries(expected)) {
      const boundary = CODEMAP_DIAGNOSTIC_CATALOG.find(b => b.id === boundaryId)
      expect(boundary, `boundary ${boundaryId} not found`).toBeDefined()
      expect(boundary!.errorEvents, `${boundaryId} missing ${failedEvent}`).toContain(failedEvent)
    }
  })
})
