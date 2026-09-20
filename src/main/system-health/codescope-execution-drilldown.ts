import type { CodeScopeTraceEvent } from '../mcp/code-scope-health'
import type {
  CheckpointResult,
  InvestigationTarget,
  StageDrilldownProvider,
  StageDrilldownResult,
  StageStatus
} from '../../shared/types/system-health-types'
import { computeLinearAdaptiveLocalization } from './adaptive-fault-locator'

export const CODESCOPE_EXECUTION_CHECKPOINTS = [
  'Operation Routing',
  'Snapshot Synchronization',
  'Index Query',
  'Result Assembly',
  'Operation Completed'
] as const

export type CodeScopeExecutionCheckpoint = (typeof CODESCOPE_EXECUTION_CHECKPOINTS)[number]

const CODESCOPE_AVAILABLE_INSTRUMENTATION = new Set([
  'codescope-operation-routed',
  'codescope-snapshot-started',
  'codescope-snapshot-completed',
  'codescope-readiness-requested',
  'codescope-readiness-satisfied',
  'codescope-readiness-failed',
  'codescope-index-query-started',
  'codescope-index-query-completed',
  'codescope-result-assembly-started',
  'codescope-result-assembly-completed',
  'codescope-handler-completed',
  'codescope-response-produced'
])

const READINESS_TARGET: InvestigationTarget = {
  systemArea: 'CodeMap Readiness',
  component: 'CodeMap Service / Readiness (FILE_INVENTORY)',
  boundary: 'Context Engine → CodeMap Readiness',
  responsibility: 'Awaiting repository readiness capability FILE_INVENTORY before query',
  investigationSeeds: [
    'src/main/core/code-map-service.ts',
    'src/main/core/context/context-engine.ts'
  ]
}

const REFINED_TARGETS: Record<CodeScopeExecutionCheckpoint, InvestigationTarget> = {
  'Operation Routing': {
    systemArea: 'CodeScope Tool Dispatch',
    component: 'Context Navigation MCP Adapter',
    boundary: 'MCP Request → Tool Operation Routing',
    responsibility: 'Validating tool arguments and routing to the designated context operation',
    investigationSeeds: [
      'src/main/mcp/context-navigation-mcp-adapter.ts'
    ]
  },
  'Snapshot Synchronization': {
    systemArea: 'CodeMap Snapshot & Maintenance',
    component: 'CodeMap Service / Background Synchronizer',
    boundary: 'Context Engine → CodeMap Snapshot',
    responsibility: 'Awaiting background maintenance, backfill, and synchronizer queue to achieve snapshot consistency',
    investigationSeeds: [
      'src/main/core/code-map-service.ts'
    ]
  },
  'Index Query': {
    systemArea: 'CodeMap Index Query',
    component: 'CodeMap Model / Storage',
    boundary: 'Context Engine → CodeMap Model',
    responsibility: 'Querying indexed files, elements, relationships, and references from the repository model',
    investigationSeeds: [
      'src/main/core/code-map-service.ts',
      'src/main/core/codemap/code-map-model.ts'
    ]
  },
  'Result Assembly': {
    systemArea: 'Context Result Processing',
    component: 'Context Engine / Navigation Serializer',
    boundary: 'Indexed Data → Structured Output Serialization',
    responsibility: 'Transforming model data into tool-specific response structures and serializing output format',
    investigationSeeds: [
      'src/main/core/context/context-engine.ts',
      'src/main/core/context/context-navigation-serializer.ts'
    ]
  },
  'Operation Completed': {
    systemArea: 'CodeScope Output Delivery',
    component: 'Context Navigation MCP Adapter / MCP Server',
    boundary: 'Context Operation Return → MCP Server',
    responsibility: 'Packaging tool result into MCP content envelope and returning to caller',
    investigationSeeds: [
      'src/main/mcp/context-navigation-mcp-adapter.ts',
      'src/main/mcp/mcp-http-server.ts'
    ]
  }
}

export class CodeScopeExecutionDrilldownProvider implements StageDrilldownProvider {
  readonly canonicalStage = 'CodeScope Execution' as const

  evaluate(events: CodeScopeTraceEvent[], failureReason?: string | null): StageDrilldownResult | null {
    if (events.length === 0) return null

    const hasEvent = (stage: string, status?: string) =>
      events.some((e) => e.stage === stage && (status === undefined || e.status === status))

    const findErrorEvent = (stage: string) =>
      events.find((e) => e.stage === stage && e.status === 'error')

    // 1. Operation Routing
    const routingCompleted = hasEvent('codescope-operation-routed', 'success')
    const routingStarted = hasEvent('codescope-operation-routed', 'started') || routingCompleted
    const routingError = findErrorEvent('codescope-operation-routed') || findErrorEvent('codescope-request-started')

    if (routingError && routingError.status === 'error') {
      return this.buildResult({
        failedCheckpoint: 'Operation Routing',
        reasonCode: routingError.error ?? failureReason ?? 'ROUTING_FAILED',
        precision: 'EXACT',
        state: 'LOCALIZED',
        durationMs: routingError.durationMs
      })
    }

    if (!routingCompleted) {
      return this.buildResult({
        failedCheckpoint: 'Operation Routing',
        reasonCode: failureReason ?? 'REQUEST_TIMEOUT',
        precision: 'BOUNDED',
        state: 'BOUNDED',
        missingEvidence: ['codescope-operation-routed'],
        durationMs: routingStarted ? 0 : 30_000
      })
    }

    const hasReadiness = events.some(
      (e) =>
        e.stage === 'codescope-readiness-requested' ||
        e.stage === 'codescope-readiness-satisfied' ||
        e.stage === 'codescope-readiness-failed' ||
        e.capability === 'FILE_INVENTORY'
    )

    const snapshotStarted =
      hasEvent('codescope-snapshot-started') ||
      hasEvent('codescope-readiness-requested')
    const snapshotCompleted =
      hasEvent('codescope-snapshot-completed', 'success') ||
      hasEvent('codescope-readiness-satisfied', 'success')
    const snapshotError =
      findErrorEvent('codescope-snapshot-started') ||
      findErrorEvent('codescope-snapshot-completed') ||
      findErrorEvent('codescope-readiness-requested') ||
      findErrorEvent('codescope-readiness-failed')

    if (!snapshotStarted) {
      return this.buildResult({
        failedCheckpoint: 'Snapshot Synchronization',
        reasonCode: failureReason ?? 'REQUEST_TIMEOUT',
        precision: 'BOUNDED',
        state: 'BOUNDED',
        missingEvidence: [hasReadiness ? 'codescope-readiness-requested' : 'codescope-snapshot-started'],
        durationMs: 30_000,
        customTarget: hasReadiness ? READINESS_TARGET : undefined
      })
    }

    // 2. Snapshot Synchronization / Readiness
    if (snapshotError) {
      return this.buildResult({
        failedCheckpoint: 'Snapshot Synchronization',
        reasonCode: snapshotError.error ?? failureReason ?? (hasReadiness ? 'READINESS_FAILED' : 'SNAPSHOT_FAILED'),
        precision: 'EXACT',
        state: 'LOCALIZED',
        durationMs: snapshotError.durationMs,
        customTarget: hasReadiness ? READINESS_TARGET : undefined
      })
    }

    if (!snapshotCompleted) {
      return this.buildResult({
        failedCheckpoint: 'Snapshot Synchronization',
        reasonCode: failureReason ?? 'REQUEST_TIMEOUT',
        precision: 'EXACT',
        state: 'LOCALIZED',
        durationMs: 30_000,
        customTarget: hasReadiness ? READINESS_TARGET : undefined
      })
    }

    // 3. Index Query
    const indexQueryStarted = hasEvent('codescope-index-query-started')
    const indexQueryCompleted = hasEvent('codescope-index-query-completed', 'success')
    const indexQueryError = findErrorEvent('codescope-index-query-started') || findErrorEvent('codescope-index-query-completed')

    if (!indexQueryStarted && failureReason) {
      return this.buildResult({
        failedCheckpoint: 'Index Query',
        reasonCode: failureReason,
        precision: 'BOUNDED',
        state: 'BOUNDED',
        missingEvidence: ['codescope-index-query-started'],
        durationMs: 30_000
      })
    }

    if (indexQueryError) {
      return this.buildResult({
        failedCheckpoint: 'Index Query',
        reasonCode: indexQueryError.error ?? failureReason ?? 'INDEX_QUERY_FAILED',
        precision: 'EXACT',
        state: 'LOCALIZED',
        durationMs: indexQueryError.durationMs
      })
    }

    if (!indexQueryCompleted) {
      return this.buildResult({
        failedCheckpoint: 'Index Query',
        reasonCode: failureReason ?? 'REQUEST_TIMEOUT',
        precision: 'EXACT',
        state: 'LOCALIZED',
        durationMs: 30_000
      })
    }

    // 4. Result Assembly
    const resultAssemblyStarted = hasEvent('codescope-result-assembly-started')
    const resultAssemblyCompleted = hasEvent('codescope-result-assembly-completed', 'success')
    const resultAssemblyError = findErrorEvent('codescope-result-assembly-started') || findErrorEvent('codescope-result-assembly-completed')

    if (!resultAssemblyStarted && failureReason) {
      return this.buildResult({
        failedCheckpoint: 'Result Assembly',
        reasonCode: failureReason,
        precision: 'BOUNDED',
        state: 'BOUNDED',
        missingEvidence: ['codescope-result-assembly-started'],
        durationMs: 30_000
      })
    }

    if (resultAssemblyError) {
      return this.buildResult({
        failedCheckpoint: 'Result Assembly',
        reasonCode: resultAssemblyError.error ?? failureReason ?? 'RESULT_ASSEMBLY_FAILED',
        precision: 'EXACT',
        state: 'LOCALIZED',
        durationMs: resultAssemblyError.durationMs
      })
    }

    if (!resultAssemblyCompleted) {
      return this.buildResult({
        failedCheckpoint: 'Result Assembly',
        reasonCode: failureReason ?? 'REQUEST_TIMEOUT',
        precision: 'EXACT',
        state: 'LOCALIZED',
        durationMs: 30_000
      })
    }

    // 5. Operation Completed
    const operationCompleted =
      hasEvent('codescope-response-produced', 'success') ||
      hasEvent('codescope-handler-completed', 'success')
    const operationError =
      findErrorEvent('codescope-response-produced') ||
      findErrorEvent('codescope-handler-completed')

    if (operationError) {
      return this.buildResult({
        failedCheckpoint: 'Operation Completed',
        reasonCode: operationError.error ?? failureReason ?? 'OPERATION_RETURN_FAILED',
        precision: 'EXACT',
        state: 'LOCALIZED',
        durationMs: operationError.durationMs ?? 30_000
      })
    }

    if (!operationCompleted) {
      return this.buildResult({
        failedCheckpoint: 'Operation Completed',
        reasonCode: failureReason ?? 'REQUEST_TIMEOUT',
        precision: 'EXACT',
        state: 'LOCALIZED',
        durationMs: 30_000
      })
    }

    return this.buildHappyPathResult(events)
  }

  private buildResult(params: {
    failedCheckpoint: CodeScopeExecutionCheckpoint
    reasonCode: string
    precision: 'EXACT' | 'BOUNDED'
    state: 'LOCALIZED' | 'BOUNDED' | 'INSUFFICIENT_EVIDENCE'
    missingEvidence?: string[]
    durationMs?: number | null
    customTarget?: InvestigationTarget
  }): StageDrilldownResult {
    const failedIdx = CODESCOPE_EXECUTION_CHECKPOINTS.indexOf(params.failedCheckpoint)
    const lastSuccessfulCheckpoint = failedIdx > 0 ? CODESCOPE_EXECUTION_CHECKPOINTS[failedIdx - 1] : null
    const firstBlockedCheckpoint =
      failedIdx + 1 < CODESCOPE_EXECUTION_CHECKPOINTS.length
        ? CODESCOPE_EXECUTION_CHECKPOINTS[failedIdx + 1]
        : null

    const checkpoints: CheckpointResult[] = CODESCOPE_EXECUTION_CHECKPOINTS.map((name, idx) => {
      let status: StageStatus
      let durationMs: number | null = null
      let reasonCode: string | null = null

      if (idx < failedIdx) {
        status = 'OPERATIONAL'
      } else if (idx === failedIdx) {
        status = params.precision === 'BOUNDED' ? 'UNKNOWN' : 'FAILED'
        if (status === 'FAILED') {
          durationMs = params.durationMs ?? null
          reasonCode = params.reasonCode
        }
      } else {
        status = 'BLOCKED'
      }

      return {
        name,
        status,
        ...(durationMs !== null ? { durationMs } : {}),
        ...(reasonCode ? { reasonCode } : {})
      }
    })

    const statusMap = new Map<string, { status: StageStatus; durationMs?: number | null; reasonCode?: string | null }>()
    for (const cp of checkpoints) {
      statusMap.set(cp.name, { status: cp.status, durationMs: cp.durationMs, reasonCode: cp.reasonCode })
    }

    const target = params.customTarget ?? REFINED_TARGETS[params.failedCheckpoint] ?? null

    const adaptive = computeLinearAdaptiveLocalization({
      canonicalStage: this.canonicalStage,
      checkpointNames: CODESCOPE_EXECUTION_CHECKPOINTS,
      statuses: statusMap,
      missingEvidence: params.missingEvidence,
      availableInstrumentation: CODESCOPE_AVAILABLE_INSTRUMENTATION,
      hasRefinedTarget: Boolean(target)
    })

    return {
      canonicalStage: this.canonicalStage,
      state: params.state,
      precision: params.precision,
      lastSuccessfulCheckpoint,
      firstFailedCheckpoint: params.failedCheckpoint,
      firstBlockedCheckpoint,
      reasonCode: params.reasonCode,
      checkpoints,
      ...(params.missingEvidence?.length ? { missingEvidence: params.missingEvidence } : {}),
      refinedInvestigationTarget: target,
      deepestProvenProgress: adaptive.deepestProvenProgress,
      diagnosticFrontier: adaptive.diagnosticFrontier,
      diagnosticResolution: adaptive.diagnosticResolution,
      observabilityGap: adaptive.observabilityGap,
      nextBestEvidence: adaptive.nextBestEvidence,
      resolutionSufficient: adaptive.observabilityGap.state === 'NONE'
    }
  }

  private buildHappyPathResult(events: CodeScopeTraceEvent[]): StageDrilldownResult {
    const checkpoints: CheckpointResult[] = CODESCOPE_EXECUTION_CHECKPOINTS.map((name) => ({
      name,
      status: 'OPERATIONAL'
    }))

    return {
      canonicalStage: this.canonicalStage,
      state: 'NO_ACTIVE_FAILURE',
      precision: 'EXACT',
      lastSuccessfulCheckpoint: CODESCOPE_EXECUTION_CHECKPOINTS[CODESCOPE_EXECUTION_CHECKPOINTS.length - 1],
      firstFailedCheckpoint: null,
      firstBlockedCheckpoint: null,
      reasonCode: null,
      checkpoints,
      refinedInvestigationTarget: null
    }
  }
}

export const codeScopeExecutionDrilldownProvider = new CodeScopeExecutionDrilldownProvider()
