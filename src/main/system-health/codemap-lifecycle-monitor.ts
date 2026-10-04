/**
 * CodeMapLifecycleMonitor — observa telemetria de lifecycle, manutenção e integridade
 * do CodeMap e mantém estado diagnóstico por repositório.
 *
 * Complementa o CodeMapSyncMonitor (fluxo incremental) cobrindo:
 * - Repository Lifecycle (open/close)
 * - Background Maintenance (cada etapa de backfill)
 * - Structural Indexing (extraction, persistence)
 * - Symbol Knowledge (backfill)
 * - Integrity (discovery, repair)
 *
 * Invariantes:
 * - Non-throwing em todos os métodos públicos.
 * - Não conhece CodeScope, CodeDash, CodeBrain.
 * - Estado é repository-scoped — repositórios diferentes não se contaminam.
 * - Falha resolvida é limpa — não permanece como active fault histórico.
 */

import { telemetryService, type TelemetryEntry } from '../core/telemetry-service'
import { BOUNDARY_BY_ID, type DiagnosticBoundary } from './codemap-diagnostic-catalog'

// ─── Tipos de estado ──────────────────────────────────────────────────────────

export type LifecyclePhase =
  | 'closed'        // repositório não está aberto
  | 'opening'       // openRepository em progresso
  | 'open'          // repositório aberto e pronto
  | 'failed'        // abertura falhou

export type MaintenanceStepName =
  | 'Content Identity Backfill'
  | 'Context Reference Backfill'
  | 'Token Metadata Backfill'
  | 'Disk/Bank Reconciliation'
  | 'Text Document Backfill'
  | 'Declaration Signature Backfill'
  | 'Symbol Reference Backfill'

export type MaintenanceStepStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface MaintenanceStepState {
  name: MaintenanceStepName
  status: MaintenanceStepStatus
  startedAt: number | null
  completedAt: number | null
  error?: string
}

export interface StructuralIndexState {
  lastExtractionAt: number | null
  lastPersistenceAt: number | null
  lastRelationshipResolutionAt: number | null
  lastSymbolBackfillAt: number | null
  activeFailure: string | null
  activeFailureBoundaryId: string | null
}

export interface IntegrityState {
  lastDiscoveryAt: number | null
  lastRepairAt: number | null
  isRunning: boolean
  lastIssueCount: number | null
}

export interface RepoLifecycleDiagnosticState {
  repoPath: string
  lifecycle: LifecyclePhase
  lifecycleError?: string
  maintenanceRunning: boolean
  maintenanceCompleted: boolean
  maintenanceFailed: boolean
  maintenanceSteps: Map<MaintenanceStepName, MaintenanceStepState>
  structural: StructuralIndexState
  integrity: IntegrityState
  lastActivity: number
}

// ─── Mapeamento de eventos → estado ──────────────────────────────────────────

const MAINTENANCE_STEP_EVENTS: Record<string, { step: MaintenanceStepName; phase: 'started' | 'completed' | 'failed' }> = {
  // Content Identity Backfill
  BACKFILL_STARTED:                         { step: 'Content Identity Backfill',    phase: 'started' },
  BACKFILL_COMPLETED:                       { step: 'Content Identity Backfill',    phase: 'completed' },
  BACKFILL_FAILED:                          { step: 'Content Identity Backfill',    phase: 'failed' },
  // Context Reference Backfill
  MAINTENANCE_CONTEXT_REF_STARTED:          { step: 'Context Reference Backfill',   phase: 'started' },
  MAINTENANCE_CONTEXT_REF_COMPLETED:        { step: 'Context Reference Backfill',   phase: 'completed' },
  MAINTENANCE_CONTEXT_REF_FAILED:           { step: 'Context Reference Backfill',   phase: 'failed' },
  // Token Metadata Backfill
  MAINTENANCE_TOKEN_METADATA_STARTED:       { step: 'Token Metadata Backfill',      phase: 'started' },
  MAINTENANCE_TOKEN_METADATA_COMPLETED:     { step: 'Token Metadata Backfill',      phase: 'completed' },
  MAINTENANCE_TOKEN_METADATA_FAILED:        { step: 'Token Metadata Backfill',      phase: 'failed' },
  // Reconcile (embedded in maintenance)
  RECONCILE_STARTED:                        { step: 'Disk/Bank Reconciliation',     phase: 'started' },
  RECONCILE_COMPLETED:                      { step: 'Disk/Bank Reconciliation',     phase: 'completed' },
  RECONCILE_FAILED:                         { step: 'Disk/Bank Reconciliation',     phase: 'failed' },
  // Text Document Backfill
  MAINTENANCE_TEXT_DOCUMENTS_STARTED:       { step: 'Text Document Backfill',       phase: 'started' },
  MAINTENANCE_TEXT_DOCUMENTS_COMPLETED:     { step: 'Text Document Backfill',       phase: 'completed' },
  MAINTENANCE_TEXT_DOCUMENTS_FAILED:        { step: 'Text Document Backfill',       phase: 'failed' },
  // Declaration Signature Backfill
  MAINTENANCE_DECLARATION_SIGS_STARTED:     { step: 'Declaration Signature Backfill', phase: 'started' },
  MAINTENANCE_DECLARATION_SIGS_COMPLETED:   { step: 'Declaration Signature Backfill', phase: 'completed' },
  MAINTENANCE_DECLARATION_SIGS_FAILED:      { step: 'Declaration Signature Backfill', phase: 'failed' },
  // Symbol Reference Backfill
  BACKFILL_SYMBOL_REFERENCES_STARTED:       { step: 'Symbol Reference Backfill',    phase: 'started' },
  BACKFILL_SYMBOL_REFERENCES_COMPLETED:     { step: 'Symbol Reference Backfill',    phase: 'completed' },
  BACKFILL_SYMBOL_REFERENCES_FAILED:        { step: 'Symbol Reference Backfill',    phase: 'failed' },
}

// ─── Monitor ──────────────────────────────────────────────────────────────────

export class CodeMapLifecycleMonitor {
  private readonly repoStates = new Map<string, RepoLifecycleDiagnosticState>()
  private unsubscribe: (() => void) | null = null

  connect(): this {
    if (this.unsubscribe) return this
    this.unsubscribe = telemetryService.subscribe((entry) => {
      try { this.onEntry(entry) } catch { /* non-throwing */ }
    })
    return this
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.repoStates.clear()
  }

  /** Retorna o estado diagnóstico para um repositório específico. */
  getRepoState(repoPath: string): RepoLifecycleDiagnosticState | null {
    const normalized = repoPath.replace(/\\/g, '/').replace(/\/$/, '')
    return this.repoStates.get(normalized) ?? null
  }

  /** Retorna todos os estados ativos. */
  getAllStates(): RepoLifecycleDiagnosticState[] {
    return Array.from(this.repoStates.values())
  }

  /**
   * Retorna a fronteira de manutenção que está atualmente bloqueada/falhando,
   * se houver, para qualquer repositório.
   *
   * Preferência: 'failed' > 'running' — falha explícita tem prioridade sobre
   * step ainda em progresso (que pode ter sido interrompido sem evento final).
   */
  getBlockedMaintenanceStep(): { step: MaintenanceStepName; boundaryId: string } | null {
    for (const state of this.repoStates.values()) {
      if (!state.maintenanceRunning && !state.maintenanceFailed) continue
      // Primeiro: procura step explicitamente falhado
      for (const [, step] of state.maintenanceSteps) {
        if (step.status === 'failed') {
          return {
            step: step.name,
            boundaryId: this.maintenanceStepToBoundaryId(step.name)
          }
        }
      }
      // Segundo: procura step ainda em progresso (sem terminal)
      for (const [, step] of state.maintenanceSteps) {
        if (step.status === 'running') {
          return {
            step: step.name,
            boundaryId: this.maintenanceStepToBoundaryId(step.name)
          }
        }
      }
    }
    return null
  }

  /**
   * Retorna o InvestigationTarget da fronteira de manutenção bloqueada, se houver.
   */
  getBlockedMaintenanceTarget(): import('../../shared/types/system-health-types').InvestigationTarget | null {
    const blocked = this.getBlockedMaintenanceStep()
    if (!blocked) return null
    return BOUNDARY_BY_ID.get(blocked.boundaryId)?.target ?? null
  }

  /**
   * Retorna o InvestigationTarget da falha estrutural ativa, se houver.
   */
  getActiveStructuralFailureTarget(): import('../../shared/types/system-health-types').InvestigationTarget | null {
    for (const state of this.repoStates.values()) {
      if (state.structural.activeFailureBoundaryId) {
        return BOUNDARY_BY_ID.get(state.structural.activeFailureBoundaryId)?.target ?? null
      }
    }
    return null
  }

  private onEntry(entry: TelemetryEntry): void {
    if (entry.component !== 'CODE_MAP' && entry.component !== 'INTEGRITY') return

    const repoPath = this.extractRepoPath(entry)
    if (!repoPath) return

    let state = this.repoStates.get(repoPath)
    if (!state) {
      state = this.createEmptyState(repoPath)
      this.repoStates.set(repoPath, state)
    }

    state.lastActivity = entry.timestamp

    this.handleLifecycleEvent(state, entry)
    this.handleMaintenanceEvent(state, entry)
    this.handleStructuralEvent(state, entry)
    this.handleIntegrityEvent(state, entry)
  }

  private handleLifecycleEvent(state: RepoLifecycleDiagnosticState, entry: TelemetryEntry): void {
    switch (entry.event) {
      case 'REPO_OPENED':
        state.lifecycle = 'open'
        state.lifecycleError = undefined
        break
      case 'REPO_OPEN_FAILED':
        state.lifecycle = 'failed'
        state.lifecycleError = this.extractError(entry)
        break
      case 'REPO_CLOSED':
        state.lifecycle = 'closed'
        state.maintenanceRunning = false
        state.maintenanceCompleted = false
        break
    }
  }

  private handleMaintenanceEvent(state: RepoLifecycleDiagnosticState, entry: TelemetryEntry): void {
    switch (entry.event) {
      case 'BACKGROUND_MAINTENANCE_STARTED':
        state.maintenanceRunning = true
        state.maintenanceCompleted = false
        state.maintenanceFailed = false
        state.maintenanceSteps.clear()
        break
      case 'BACKGROUND_MAINTENANCE_COMPLETED':
        state.maintenanceRunning = false
        state.maintenanceCompleted = true
        state.maintenanceFailed = false
        break
      case 'BACKGROUND_MAINTENANCE_FAILED':
        state.maintenanceRunning = false
        state.maintenanceFailed = true
        break
    }

    // Etapas individuais
    const stepEvent = MAINTENANCE_STEP_EVENTS[entry.event]
    if (stepEvent) {
      let step = state.maintenanceSteps.get(stepEvent.step)
      if (!step) {
        step = {
          name: stepEvent.step,
          status: 'pending',
          startedAt: null,
          completedAt: null
        }
        state.maintenanceSteps.set(stepEvent.step, step)
      }
      if (stepEvent.phase === 'started') {
        step.status = 'running'
        step.startedAt = entry.timestamp
      } else if (stepEvent.phase === 'completed') {
        step.status = 'completed'
        step.completedAt = entry.timestamp
        // Limpa falha ativa do mesmo step se havia
        if (state.structural.activeFailureBoundaryId === this.maintenanceStepToBoundaryId(stepEvent.step)) {
          state.structural.activeFailure = null
          state.structural.activeFailureBoundaryId = null
        }
      } else if (stepEvent.phase === 'failed') {
        step.status = 'failed'
        step.error = this.extractError(entry)
      }
    }
  }

  private handleStructuralEvent(state: RepoLifecycleDiagnosticState, entry: TelemetryEntry): void {
    switch (entry.event) {
      case 'STRUCTURE_EXTRACTED':
        state.structural.lastExtractionAt = entry.timestamp
        break
      case 'STRUCTURAL_PERSISTENCE_COMPLETED':
        state.structural.lastPersistenceAt = entry.timestamp
        break
      case 'RELATIONSHIP_RESOLUTION_COMPLETED':
        state.structural.lastRelationshipResolutionAt = entry.timestamp
        if (state.structural.activeFailureBoundaryId === 'relationship-resolution') {
          state.structural.activeFailure = null
          state.structural.activeFailureBoundaryId = null
        }
        break
      case 'RELATIONSHIP_RESOLUTION_FAILED':
        state.structural.activeFailure = this.extractError(entry)
        state.structural.activeFailureBoundaryId = 'relationship-resolution'
        break
      case 'REINDEX_FAILED':
        state.structural.activeFailure = this.extractError(entry)
        state.structural.activeFailureBoundaryId = 'file-reindex'
        break
      case 'REINDEX_COMPLETED':
        if (state.structural.activeFailureBoundaryId === 'file-reindex') {
          state.structural.activeFailure = null
          state.structural.activeFailureBoundaryId = null
        }
        break
      case 'BACKFILL_SYMBOL_REFERENCES_COMPLETED':
        state.structural.lastSymbolBackfillAt = entry.timestamp
        if (state.structural.activeFailureBoundaryId === 'symbol-ref-resolution') {
          state.structural.activeFailure = null
          state.structural.activeFailureBoundaryId = null
        }
        break
      case 'BACKFILL_SYMBOL_REFERENCES_FAILED':
        state.structural.activeFailure = this.extractError(entry)
        state.structural.activeFailureBoundaryId = 'symbol-ref-resolution'
        break
    }
  }

  private handleIntegrityEvent(state: RepoLifecycleDiagnosticState, entry: TelemetryEntry): void {
    if (entry.component !== 'INTEGRITY') return
    switch (entry.event) {
      case 'CHECK_STARTED':
        state.integrity.isRunning = true
        break
      case 'CHECK_COMPLETED':
      case 'REVALIDATION_COMPLETED': {
        state.integrity.isRunning = false
        state.integrity.lastDiscoveryAt = entry.timestamp
        const p = entry.payload as Record<string, unknown> | undefined
        if (p && typeof p['totalIssues'] === 'number') {
          state.integrity.lastIssueCount = p['totalIssues']
        }
        break
      }
      case 'REPAIR_STARTED':
        break
      case 'REPAIR_COMPLETED':
        state.integrity.lastRepairAt = entry.timestamp
        break
    }
  }

  private extractRepoPath(entry: TelemetryEntry): string | null {
    if (!entry.payload || typeof entry.payload !== 'object') return null
    const p = entry.payload as Record<string, unknown>
    const raw = p['repoPath'] as string | undefined
    if (!raw) return '_default'
    return raw.replace(/\\/g, '/').replace(/\/$/, '')
  }

  private extractError(entry: TelemetryEntry): string | undefined {
    if (!entry.payload || typeof entry.payload !== 'object') return undefined
    return (entry.payload as Record<string, unknown>)['error'] as string | undefined
  }

  private maintenanceStepToBoundaryId(step: MaintenanceStepName): string {
    const map: Record<MaintenanceStepName, string> = {
      'Content Identity Backfill':    'maintenance-content-identity',
      'Context Reference Backfill':   'maintenance-context-ref',
      'Token Metadata Backfill':      'maintenance-token-metadata',
      'Disk/Bank Reconciliation':     'disk-bank-reconciliation',
      'Text Document Backfill':       'maintenance-text-documents',
      'Declaration Signature Backfill': 'maintenance-declaration-sigs',
      'Symbol Reference Backfill':    'maintenance-symbol-refs',
    }
    return map[step]
  }

  private createEmptyState(repoPath: string): RepoLifecycleDiagnosticState {
    return {
      repoPath,
      lifecycle: 'closed',
      maintenanceRunning: false,
      maintenanceCompleted: false,
      maintenanceFailed: false,
      maintenanceSteps: new Map(),
      structural: {
        lastExtractionAt: null,
        lastPersistenceAt: null,
        lastRelationshipResolutionAt: null,
        lastSymbolBackfillAt: null,
        activeFailure: null,
        activeFailureBoundaryId: null,
      },
      integrity: {
        lastDiscoveryAt: null,
        lastRepairAt: null,
        isRunning: false,
        lastIssueCount: null,
      },
      lastActivity: Date.now()
    }
  }
}
