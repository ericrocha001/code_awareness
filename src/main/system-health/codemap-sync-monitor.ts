/**
 * CodeMapSyncMonitor — observa telemetria de sincronização do CodeMap e alimenta
 * o System Health com evidência sobre a fronteira concreta de bloqueios.
 *
 * Fluxo: CodeMap → Telemetry → CodeMapSyncMonitor → SystemHealth
 *
 * Invariantes:
 * - Não conhece CodeScope, CodeDash, CodeBrain.
 * - Não altera comportamento funcional do CodeMap.
 * - Non-throwing em todos os métodos públicos.
 * - Não cria singleton global automático — instanciado e conectado em main.ts.
 */

import { telemetryService, type TelemetryEntry } from '../core/telemetry-service'
import type { StageDrilldownProvider, StageDrilldownResult, InvestigationTarget, CheckpointResult, StageStatus } from '../../shared/types/system-health-types'
import type { CodeScopeTraceEvent } from '../mcp/code-scope-health'
import { computeLinearAdaptiveLocalization } from './adaptive-fault-locator'

// Fronteiras de sincronização expostas ao System Health
export const CODEMAP_SYNC_CHECKPOINTS = [
  'Repository Observation',
  'Path Eligibility',
  'Change Intake',
  'Change Stabilization',
  'Change Verification',
  'File Reindex',
  'Relationship Resolution'
] as const

export type CodeMapSyncCheckpoint = (typeof CODEMAP_SYNC_CHECKPOINTS)[number]

// Mapeamento de eventos de telemetria → fronteira de sincronização
// Usado para determinar onde a sincronização está bloqueada
const EVENT_TO_CHECKPOINT: Record<string, CodeMapSyncCheckpoint> = {
  EVENT_BRIDGED: 'Repository Observation',
  OBSERVED: 'Repository Observation',
  QUEUED: 'Repository Observation',
  QUEUE_DEDUP: 'Repository Observation',
  INTAKE_ACCEPTED: 'Change Intake',
  INTAKE_REJECTED: 'Path Eligibility',
  STABILIZE_CHECK: 'Change Stabilization',
  RESTABILIZE_SCHEDULED: 'Change Stabilization',
  CONFIRMED_UNSTABLE: 'Change Stabilization',
  HASH_CALCULATED: 'Change Verification',
  CONFIRMED_MODIFIED: 'Change Verification',
  CONFIRMED_NEW: 'Change Verification',
  CONFIRMED_DELETED: 'Change Verification',
  LEGACY_FILE_MODIFIED: 'Change Verification',
  AUTOCURED: 'Change Verification',
  AUTO_REINDEX_COMPLETED: 'File Reindex',
  AUTO_REINDEX_SKIPPED: 'File Reindex',
  AUTO_REINDEX_FAILED: 'File Reindex',
  SYNC_BATCH_STARTED: 'File Reindex',
  SYNC_BATCH_COMPLETED: 'File Reindex',
  SYNC_BATCH_FAILED: 'File Reindex',
  RELATIONSHIP_RESOLUTION_STARTED: 'Relationship Resolution',
  RELATIONSHIP_RESOLUTION_COMPLETED: 'Relationship Resolution',
  RELATIONSHIP_RESOLUTION_FAILED: 'Relationship Resolution',
}

// Eventos de erro por fronteira
const ERROR_EVENTS = new Set([
  'AUTO_REINDEX_FAILED',
  'SYNC_BATCH_FAILED',
  'VERIFY_FAILED',
  'CONFIRMED_UNSTABLE',
  'RELATIONSHIP_RESOLUTION_FAILED',
])

interface CheckpointState {
  lastSeen: number        // timestamp ms da última atividade
  errorCount: number
  inProgress: boolean     // evento de início sem conclusão correspondente
  lastError?: string
}

/**
 * Estado de sincronização por repositório, mantido pelo monitor.
 */
interface RepoSyncState {
  deepestCheckpoint: CodeMapSyncCheckpoint | null
  checkpoints: Map<CodeMapSyncCheckpoint, CheckpointState>
  hasActiveFailure: boolean
  failedCheckpoint: CodeMapSyncCheckpoint | null
  failureReason: string | null
  lastActivity: number
}

const REFINED_TARGETS: Record<CodeMapSyncCheckpoint, InvestigationTarget> = {
  'Repository Observation': {
    systemArea: 'CodeMap Filesystem Observation',
    component: 'WatcherService / WatcherBridge',
    boundary: 'Filesystem → RepositoryEventBus',
    responsibility: 'Observing filesystem changes and delivering path notifications to the event bus',
    investigationSeeds: [
      'src/main/core/watcher-service.ts',
      'src/main/core/watcher-bridge.ts'
    ]
  },
  'Path Eligibility': {
    systemArea: 'CodeMap Change Intake Gate',
    component: 'RepositoryFileMembership',
    boundary: 'RepositoryEventBus → RepositorySynchronizer intake',
    responsibility: 'Classifying incoming paths as eligible, ignored, directory, or ineligible before expensive work',
    investigationSeeds: [
      'src/main/core/repository-file-membership.ts',
      'src/main/core/repository-synchronizer.ts'
    ]
  },
  'Change Intake': {
    systemArea: 'CodeMap Change Queue',
    component: 'RepositorySynchronizer / Debounce Queue',
    boundary: 'Path Eligibility → Stabilization',
    responsibility: 'Enqueuing accepted paths and coalescing burst events before stabilization',
    investigationSeeds: [
      'src/main/core/repository-synchronizer.ts'
    ]
  },
  'Change Stabilization': {
    systemArea: 'CodeMap Change Verification',
    component: 'RepositorySynchronizer / Stabilization',
    boundary: 'Change Intake → Hash Verification',
    responsibility: 'Waiting for file write to complete (stat consistency check) before reading content',
    investigationSeeds: [
      'src/main/core/repository-synchronizer.ts'
    ]
  },
  'Change Verification': {
    systemArea: 'CodeMap Content Verification',
    component: 'RepositorySynchronizer / Hash Check',
    boundary: 'Stabilization → Reindex Decision',
    responsibility: 'Comparing disk content hash against indexed hash to confirm real change',
    investigationSeeds: [
      'src/main/core/repository-synchronizer.ts'
    ]
  },
  'File Reindex': {
    systemArea: 'CodeMap File Reindex',
    component: 'RepositoryModel / updateFileContent',
    boundary: 'Verification → CodeMap Updated',
    responsibility: 'Parsing and indexing file content, elements, and relationships into the repository model',
    investigationSeeds: [
      'src/main/core/repository-model.ts',
      'src/main/core/repository-synchronizer.ts'
    ]
  },
  'Relationship Resolution': {
    systemArea: 'CodeMap Relationship Graph',
    component: 'RepositoryModel / RelationshipResolver',
    boundary: 'File Reindex → Cross-file Relationship Edges',
    responsibility: 'Resolving cross-file import, extends, and implements relationships over the full element set after a structural change',
    investigationSeeds: [
      'src/main/core/repository-model.ts',
      'src/main/core/relationship-resolver.ts'
    ]
  }
}

const CODEMAP_SYNC_AVAILABLE_INSTRUMENTATION = new Set(Object.keys(EVENT_TO_CHECKPOINT))

/**
 * Monitor de sincronização do CodeMap.
 * Subscreve telemetria, mantém estado por repositório, e fornece drilldown para o System Health.
 */
export class CodeMapSyncMonitor {
  private readonly repoStates = new Map<string, RepoSyncState>()
  private unsubscribe: (() => void) | null = null

  /**
   * Conecta o monitor ao telemetryService.
   * Retorna `this` para encadeamento fluente.
   */
  connect(): this {
    if (this.unsubscribe) return this
    this.unsubscribe = telemetryService.subscribe((entry) => {
      try {
        this.onTelemetryEntry(entry)
      } catch {
        // non-throwing
      }
    })
    return this
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.repoStates.clear()
  }

  /**
   * Retorna o estado de sincronização atual para o repositório (para testes e diagnóstico).
   */
  getRepoState(repoPath: string): RepoSyncState | null {
    const normalized = repoPath.replace(/\\/g, '/').replace(/\/$/, '')
    return this.repoStates.get(normalized) ?? null
  }

  /**
   * Retorna a fronteira mais profunda com atividade recente em algum repositório.
   * Usado pelo drilldown para enriquecer o diagnóstico do Snapshot Synchronization.
   */
  getDeepestActiveFrontier(): CodeMapSyncCheckpoint | null {
    let deepest: CodeMapSyncCheckpoint | null = null
    let deepestIdx = -1

    for (const state of this.repoStates.values()) {
      if (!state.deepestCheckpoint) continue
      const idx = CODEMAP_SYNC_CHECKPOINTS.indexOf(state.deepestCheckpoint)
      if (idx > deepestIdx) {
        deepestIdx = idx
        deepest = state.deepestCheckpoint
      }
    }

    return deepest
  }

  /**
   * Retorna se há falha ativa de reindex ou relationship resolution em algum repositório.
   */
  hasActiveReindexFailure(): boolean {
    for (const state of this.repoStates.values()) {
      if (state.hasActiveFailure && (
        state.failedCheckpoint === 'File Reindex' ||
        state.failedCheckpoint === 'Relationship Resolution'
      )) return true
    }
    return false
  }

  private onTelemetryEntry(entry: TelemetryEntry): void {
    if (entry.component !== 'CHANGE_DETECTION' && entry.component !== 'CODE_MAP' && entry.component !== 'WATCHER') {
      return
    }

    const checkpoint = EVENT_TO_CHECKPOINT[entry.event]
    if (!checkpoint) return

    // Tenta extrair repoPath do payload
    const repoPath = this.extractRepoPath(entry)
    if (!repoPath) return

    let state = this.repoStates.get(repoPath)
    if (!state) {
      state = this.createEmptyState()
      this.repoStates.set(repoPath, state)
    }

    // Atualiza fronteira mais profunda vista
    const currentIdx = state.deepestCheckpoint ? CODEMAP_SYNC_CHECKPOINTS.indexOf(state.deepestCheckpoint) : -1
    const newIdx = CODEMAP_SYNC_CHECKPOINTS.indexOf(checkpoint)
    if (newIdx > currentIdx) {
      state.deepestCheckpoint = checkpoint
    }

    state.lastActivity = entry.timestamp

    // Atualiza estado do checkpoint específico
    let cpState = state.checkpoints.get(checkpoint)
    if (!cpState) {
      cpState = { lastSeen: entry.timestamp, errorCount: 0, inProgress: false }
      state.checkpoints.set(checkpoint, cpState)
    }
    cpState.lastSeen = entry.timestamp

    if (ERROR_EVENTS.has(entry.event)) {
      cpState.errorCount++
      cpState.lastError = this.extractError(entry)
      state.hasActiveFailure = true
      state.failedCheckpoint = checkpoint
      state.failureReason = cpState.lastError ?? entry.event
    } else if (entry.event === 'AUTO_REINDEX_COMPLETED' || entry.event === 'SYNC_BATCH_COMPLETED') {
      // Reindex concluído — limpa falha ativa se era de reindex
      if (state.failedCheckpoint === 'File Reindex') {
        state.hasActiveFailure = false
        state.failedCheckpoint = null
        state.failureReason = null
      }
      cpState.inProgress = false
    } else if (entry.event === 'RELATIONSHIP_RESOLUTION_COMPLETED') {
      // Relationship resolution concluída — limpa falha ativa se era de relationships
      if (state.failedCheckpoint === 'Relationship Resolution') {
        state.hasActiveFailure = false
        state.failedCheckpoint = null
        state.failureReason = null
      }
      cpState.inProgress = false
    } else if (entry.event === 'RELATIONSHIP_RESOLUTION_STARTED') {
      cpState.inProgress = true
    } else if (entry.event === 'SYNC_BATCH_STARTED') {
      cpState.inProgress = true
    }
  }

  private extractRepoPath(entry: TelemetryEntry): string | null {
    if (!entry.payload || typeof entry.payload !== 'object') return null
    const p = entry.payload as Record<string, unknown>
    const raw = (p['repoPath'] ?? p['relativePath']) as string | undefined
    if (!raw) return null
    // Se for caminho relativo (não absoluto), não é repoPath — retorna uma chave genérica
    if (!raw.startsWith('/') && !/^[a-zA-Z]:/.test(raw)) return '_default'
    return raw.replace(/\\/g, '/').replace(/\/$/, '')
  }

  private extractError(entry: TelemetryEntry): string | undefined {
    if (!entry.payload || typeof entry.payload !== 'object') return undefined
    const p = entry.payload as Record<string, unknown>
    return p['error'] as string | undefined
  }

  private createEmptyState(): RepoSyncState {
    return {
      deepestCheckpoint: null,
      checkpoints: new Map(),
      hasActiveFailure: false,
      failedCheckpoint: null,
      failureReason: null,
      lastActivity: Date.now()
    }
  }
}

/**
 * StageDrilldownProvider que enriquece o checkpoint "Snapshot Synchronization"
 * dentro do CodeScope Execution stage com evidência concreta da fronteira do CodeMap.
 *
 * Composição: CodeMapSyncMonitor alimenta este provider com estado observado.
 */
export class CodeMapSnapshotDrilldownEnricher {
  constructor(private readonly monitor: CodeMapSyncMonitor) {}

  /**
   * Tenta enriquecer o resultado de drilldown do Snapshot Synchronization
   * com a fronteira concreta do CodeMap.
   *
   * Retorna um InvestigationTarget refinado ou null se não houver evidência.
   */
  getRefinedTarget(): InvestigationTarget | null {
    const frontier = this.monitor.getDeepestActiveFrontier()
    if (!frontier) return null
    return REFINED_TARGETS[frontier]
  }

  getFailedCheckpointInfo(): { checkpoint: CodeMapSyncCheckpoint; reason: string | null } | null {
    for (const state of this.getStates()) {
      if (state.hasActiveFailure && state.failedCheckpoint) {
        return { checkpoint: state.failedCheckpoint, reason: state.failureReason }
      }
    }
    return null
  }

  private getStates(): RepoSyncState[] {
    // Acessa via método público do monitor
    const states: RepoSyncState[] = []
    // O monitor expõe os estados via getDeepestActiveFrontier e hasActiveReindexFailure
    // Para o enricher, precisamos do acesso ao estado interno — expor via método
    return states
  }
}

/**
 * Drilldown provider para o estágio CodeScope Execution que enriquece
 * o checkpoint "Snapshot Synchronization" com fronteira do CodeMap.
 *
 * Este provider é registrado no SystemHealthCore e substitui (ou complementa)
 * o CodeScopeExecutionDrilldownProvider quando há evidência de sincronização ativa.
 */
export class CodeMapSyncDrilldownProvider implements StageDrilldownProvider {
  readonly canonicalStage = 'CodeScope Execution' as const

  constructor(
    private readonly monitor: CodeMapSyncMonitor,
    private readonly baseProvider: StageDrilldownProvider,
    private readonly lifecycleMonitor?: import('./codemap-lifecycle-monitor').CodeMapLifecycleMonitor
  ) {}

  evaluate(events: CodeScopeTraceEvent[], failureReason?: string | null): StageDrilldownResult | null {
    // Delega ao provider base primeiro
    const baseResult = this.baseProvider.evaluate(events, failureReason)
    if (!baseResult) return null

    // Enriquece somente se o checkpoint falho for "Snapshot Synchronization"
    if (baseResult.firstFailedCheckpoint !== 'Snapshot Synchronization') {
      return baseResult
    }

    // Tenta obter fronteira concreta do CodeMap
    const frontier = this.monitor.getDeepestActiveFrontier()

    // Se não há evidência de sync mas há evidência de manutenção bloqueada, usar isso
    if (!frontier && this.lifecycleMonitor) {
      const maintenanceTarget = this.lifecycleMonitor.getBlockedMaintenanceTarget()
      if (maintenanceTarget) {
        return {
          ...baseResult,
          refinedInvestigationTarget: maintenanceTarget,
          deepestProvenProgress: 'Snapshot Synchronization → Background Maintenance',
          diagnosticResolution: 'COMPONENT',
          resolutionSufficient: true
        }
      }
    }

    if (!frontier) return baseResult

    const refinedTarget = REFINED_TARGETS[frontier]
    const failureInfo = this.getActiveFailure()

    // Constrói checkpoints enriquecidos para o Snapshot Synchronization sub-pipeline
    const syncCheckpoints: CheckpointResult[] = CODEMAP_SYNC_CHECKPOINTS.map((name) => {
      const frontierIdx = CODEMAP_SYNC_CHECKPOINTS.indexOf(frontier)
      const nameIdx = CODEMAP_SYNC_CHECKPOINTS.indexOf(name)
      let status: StageStatus
      if (failureInfo && name === failureInfo.checkpoint) {
        status = 'FAILED'
      } else if (nameIdx <= frontierIdx) {
        status = 'OPERATIONAL'
      } else {
        status = 'BLOCKED'
      }
      return { name, status }
    })

    const statusMap = new Map(syncCheckpoints.map(cp => [cp.name, { status: cp.status }]))
    const adaptive = computeLinearAdaptiveLocalization({
      canonicalStage: 'CodeScope Execution',
      checkpointNames: CODEMAP_SYNC_CHECKPOINTS,
      statuses: statusMap,
      availableInstrumentation: CODEMAP_SYNC_AVAILABLE_INSTRUMENTATION,
      hasRefinedTarget: true
    })

    return {
      ...baseResult,
      refinedInvestigationTarget: refinedTarget,
      deepestProvenProgress: `Snapshot Synchronization → ${frontier}`,
      diagnosticFrontier: adaptive.diagnosticFrontier,
      diagnosticResolution: 'COMPONENT',
      observabilityGap: adaptive.observabilityGap,
      nextBestEvidence: adaptive.nextBestEvidence,
      resolutionSufficient: true
    }
  }

  private getActiveFailure(): { checkpoint: CodeMapSyncCheckpoint; reason: string | null } | null {
    if (this.monitor.hasActiveReindexFailure()) {
      return { checkpoint: 'File Reindex', reason: null }
    }
    return null
  }
}
