import { describe, expect, it } from 'vitest'
import type { ChannelTraceEvent } from '../../shared/types/channel-types'
import { SystemHealthCore } from './system-health-core'
import { executeGetSystemHealth, type SystemHealthDiagnosticPayload } from './system-health-mcp'
import type {
  CanonicalStage,
  StageDrilldownProvider,
  StageDrilldownResult
} from '../../shared/types/system-health-types'
import { computeLinearAdaptiveLocalization } from './adaptive-fault-locator'

function makeEvent(overrides: Partial<ChannelTraceEvent> & Pick<ChannelTraceEvent, 'stage' | 'status'>): ChannelTraceEvent {
  return {
    timestamp: new Date().toISOString(),
    requestId: 'req-adaptive-harness',
    sessionId: 'sess-adaptive-harness',
    method: 'tools/call',
    tool: 'discover_repository',
    durationMs: 0,
    ...overrides
  }
}

describe('System Health — Adaptive Fault Localization Harness', () => {
  describe('Capacidade 1 & 2 — Hierarchical Execution Topology & Deepest Proven Progress', () => {
    it('outer transport timeout does not mask downstream proven progress', () => {
      const core = new SystemHealthCore()
      // Outer layers start
      core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'desktop-request-received', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'mcp-request-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'mcp-request-received', status: 'started' }))
      // Downstream progresses into CodeScope
      core.sink.record(makeEvent({ stage: 'codescope-operation-routed', status: 'success' }))
      core.sink.record(makeEvent({ stage: 'codescope-snapshot-started', status: 'started' }))
      // Outer layer observes timeout
      core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'error', error: 'REQUEST_TIMEOUT', durationMs: 30_000 }))

      const result = executeGetSystemHealth(core, {})
      const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

      expect(payload.firstFailedBoundary).toBe('CodeScope Execution')
      expect(payload.diagnosis.deepestProvenProgress).toBe('Operation Routing')
      expect(payload.diagnosis.diagnosticFrontier).toEqual({
        lastProven: 'Operation Routing',
        at: 'Snapshot Synchronization',
        nextBlocked: 'Index Query',
        precision: 'EXACT'
      })
    })

    it('progress state distinguishes started (entered/open) from completed', () => {
      const core = new SystemHealthCore()
      core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'desktop-request-received', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'mcp-request-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'mcp-request-received', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'codescope-operation-routed', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'codescope-operation-routed', status: 'error', error: 'INVALID_ARGUMENT' }))

      const result = executeGetSystemHealth(core, {})
      const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

      // Started does not equal completed: deepest proven progress did not advance past CodeScope Execution
      expect(payload.diagnosis.deepestProvenProgress).toBe('CodeScope Execution')
      expect(payload.diagnosis.diagnosticFrontier?.lastProven).toBeNull()
      expect(payload.diagnosis.diagnosticFrontier?.at).toBe('Operation Routing')
    })
  })

  describe('Capacidade 3 & 4 — Diagnostic Frontier & Diagnostic Resolution', () => {
    it('Case: Exact frontier and COMPONENT resolution when refined target exists', () => {
      const core = new SystemHealthCore()
      core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'desktop-request-received', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'mcp-request-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'mcp-request-received', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'codescope-operation-routed', status: 'success' }))
      core.sink.record(makeEvent({ stage: 'codescope-snapshot-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'codescope-snapshot-started', status: 'error', error: 'REQUEST_TIMEOUT', durationMs: 30_000 }))

      const result = executeGetSystemHealth(core, {})
      const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

      expect(payload.diagnosis.diagnosticResolution).toBe('COMPONENT')
      expect(payload.diagnosis.diagnosticFrontier?.precision).toBe('EXACT')
      expect(payload.diagnosis.investigationTarget?.component).toBe('CodeMap Service / Background Synchronizer')
      expect(payload.diagnosis.disposition).toBe('INSPECT_CODE')
    })

    it('Case: Bounded frontier and CHECKPOINT resolution when exact failure boundary is not yet observed', () => {
      const core = new SystemHealthCore()
      core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'desktop-request-received', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'started' }))
      // Transport timed out before mcp-request-received
      core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'error', error: 'REQUEST_TIMEOUT', durationMs: 30_000 }))

      const result = executeGetSystemHealth(core, {})
      const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

      expect(payload.firstFailedBoundary).toBe('MCP Request')
      expect(payload.diagnosis.diagnosticResolution).toBe('CHECKPOINT')
      expect(payload.diagnosis.diagnosticFrontier?.precision).toBe('BOUNDED')
      expect(payload.diagnosis.diagnosticFrontier?.at).toBe('MCP Request Received')
    })
  })

  describe('Capacidade 5 & 6 — Observability Gap & Next Best Evidence', () => {
    it('Case: Observability gap is NONE when resolution is COMPONENT and disposition is INSPECT_CODE', () => {
      const core = new SystemHealthCore()
      core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'desktop-request-received', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'mcp-request-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'mcp-request-received', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'codescope-operation-routed', status: 'success' }))
      core.sink.record(makeEvent({ stage: 'codescope-snapshot-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'codescope-snapshot-started', status: 'error', error: 'REQUEST_TIMEOUT', durationMs: 30_000 }))

      const result = executeGetSystemHealth(core, {})
      const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

      expect(payload.diagnosis.observabilityGap).toEqual({
        state: 'NONE',
        currentBoundary: 'Operation Routing → Snapshot Synchronization',
        instrumentationAvailable: false
      })
      expect(payload.diagnosis.nextBestEvidence).toBeUndefined()
    })

    it('Case: Next Best Evidence selects single most informative observation when gap exists', () => {
      const core = new SystemHealthCore()
      core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'desktop-request-received', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'started' }))
      // Dispatched succeeded, but mcp-request-received is missing
      core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'error', error: 'REQUEST_TIMEOUT', durationMs: 30_000 }))

      const result = executeGetSystemHealth(core, {})
      const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

      expect(payload.diagnosis.observabilityGap).toMatchObject({
        state: 'EVIDENCE_AVAILABLE',
        currentBoundary: 'MCP Request Dispatched → MCP Request Received',
        missingEvidence: ['mcp-request-received']
      })
      expect(payload.diagnosis.nextBestEvidence).toEqual({
        evidenceKey: 'mcp-request-received',
        boundary: 'MCP Request Dispatched → MCP Request Received',
        diagnosticValue: 'Distinguishes progress past MCP Request Dispatched from blockage at MCP Request Received',
        instrumentationState: 'AVAILABLE'
      })
    })

    it('Synthetic branching provider selects specialized discriminator for branching hypotheses', () => {
      const branchingProvider: StageDrilldownProvider = {
        canonicalStage: 'Relay Outbound' as CanonicalStage,
        evaluate: (_events, failureReason) => {
          const statusMap = new Map([
            ['Relay Session Opened', { status: 'OPERATIONAL' as const }],
            ['Relay Framing Completed', { status: 'UNKNOWN' as const }],
            ['Outbound Socket Flushed', { status: 'BLOCKED' as const }]
          ])

          const adaptive = computeLinearAdaptiveLocalization({
            canonicalStage: 'Relay Outbound',
            checkpointNames: ['Relay Session Opened', 'Relay Framing Completed', 'Outbound Socket Flushed'],
            statuses: statusMap,
            missingEvidence: ['relay-framing-completed', 'outbound-socket-flushed'],
            availableInstrumentation: new Set(['relay-framing-completed']),
            customNextBestEvidence: {
              evidenceKey: 'relay-framing-completed',
              boundary: 'Relay Session Opened → Relay Framing Completed',
              diagnosticValue: 'Distinguishes framing serialization failure from network socket backpressure',
              instrumentationState: 'AVAILABLE'
            }
          })

          return {
            canonicalStage: 'Relay Outbound',
            state: 'BOUNDED',
            precision: 'BOUNDED',
            lastSuccessfulCheckpoint: 'Relay Session Opened',
            firstFailedCheckpoint: 'Relay Framing Completed',
            firstBlockedCheckpoint: 'Outbound Socket Flushed',
            reasonCode: failureReason ?? 'TIMEOUT',
            checkpoints: [
              { name: 'Relay Session Opened', status: 'OPERATIONAL' },
              { name: 'Relay Framing Completed', status: 'UNKNOWN' },
              { name: 'Outbound Socket Flushed', status: 'BLOCKED' }
            ],
            deepestProvenProgress: adaptive.deepestProvenProgress,
            diagnosticFrontier: adaptive.diagnosticFrontier,
            diagnosticResolution: adaptive.diagnosticResolution,
            observabilityGap: adaptive.observabilityGap,
            nextBestEvidence: adaptive.nextBestEvidence
          }
        }
      }

      const core = new SystemHealthCore([branchingProvider])
      core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'access-assertion-received', status: 'success' }))
      core.sink.record(makeEvent({ stage: 'relay-request-received', status: 'error', error: 'SOCKET_TIMEOUT' }))

      const state = core.getState()
      expect(state.lastFailure?.drilldown?.nextBestEvidence?.diagnosticValue).toContain(
        'Distinguishes framing serialization failure from network socket backpressure'
      )
    })
  })

  describe('Capacidade 7 — Caso de Aceitação Real (discover_repository trace)', () => {
    it('produces deepest proven progress, frontier, resolution COMPONENT, and target CodeMapService.awaitSnapshot', () => {
      const core = new SystemHealthCore()
      // Reproduce exact sequence of trace 279a395d-4ac8-4768-8517-0eb7b45cf62d
      core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'access-assertion-received', status: 'success' }))
      core.sink.record(makeEvent({ stage: 'desktop-request-received', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'mcp-request-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'mcp-request-received', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'codescope-request-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'codescope-operation-routed', status: 'success' }))
      core.sink.record(makeEvent({ stage: 'codescope-snapshot-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'codescope-snapshot-started', status: 'error', error: 'REQUEST_TIMEOUT', durationMs: 30_000 }))

      const result = executeGetSystemHealth(core, {})
      const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

      expect(payload.status).toBe('DEGRADED')
      expect(payload.firstFailedBoundary).toBe('CodeScope Execution')
      expect(payload.reasonCode).toBe('REQUEST_TIMEOUT')

      expect(payload.diagnosis.deepestProvenProgress).toBe('Operation Routing')
      expect(payload.diagnosis.diagnosticFrontier).toEqual({
        lastProven: 'Operation Routing',
        at: 'Snapshot Synchronization',
        nextBlocked: 'Index Query',
        precision: 'EXACT'
      })
      expect(payload.diagnosis.diagnosticResolution).toBe('COMPONENT')
      expect(payload.diagnosis.observabilityGap).toEqual({
        state: 'NONE',
        currentBoundary: 'Operation Routing → Snapshot Synchronization',
        instrumentationAvailable: false
      })
      expect(payload.diagnosis.nextBestEvidence).toBeUndefined()
      expect(payload.diagnosis.investigationTarget).toEqual({
        systemArea: 'CodeMap Snapshot & Maintenance',
        component: 'CodeMap Service / Background Synchronizer',
        boundary: 'Context Engine → CodeMap Snapshot',
        responsibility: 'Awaiting background maintenance, backfill, and synchronizer queue to achieve snapshot consistency',
        investigationSeeds: [
          'src/main/core/code-map-service.ts'
        ]
      })
      expect(payload.diagnosis.disposition).toBe('INSPECT_CODE')

      // Also confirm lastFailureDiagnosis preserves the exact fields
      expect(payload.lastFailureDiagnosis?.deepestProvenProgress).toBe('Operation Routing')
      expect(payload.lastFailureDiagnosis?.diagnosticFrontier).toEqual({
        lastProven: 'Operation Routing',
        at: 'Snapshot Synchronization',
        nextBlocked: 'Index Query',
        precision: 'EXACT'
      })
      expect(payload.lastFailureDiagnosis?.diagnosticResolution).toBe('COMPONENT')
      expect(payload.lastFailureDiagnosis?.observabilityGap).toEqual({
        state: 'NONE',
        currentBoundary: 'Operation Routing → Snapshot Synchronization',
        instrumentationAvailable: false
      })
    })

    it('healthy payload does not pollute with empty diagnostic structures', () => {
      const core = new SystemHealthCore()
      core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'desktop-request-received', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'mcp-request-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'mcp-request-received', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'codescope-operation-routed', status: 'success' }))
      core.sink.record(makeEvent({ stage: 'codescope-snapshot-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'codescope-snapshot-completed', status: 'success' }))
      core.sink.record(makeEvent({ stage: 'codescope-index-query-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'codescope-index-query-completed', status: 'success' }))
      core.sink.record(makeEvent({ stage: 'codescope-result-assembly-started', status: 'started' }))
      core.sink.record(makeEvent({ stage: 'codescope-result-assembly-completed', status: 'success' }))
      core.sink.record(makeEvent({ stage: 'codescope-handler-completed', status: 'success' }))
      core.sink.record(makeEvent({ stage: 'mcp-response-sent', status: 'success' }))
      core.sink.record(makeEvent({ stage: 'bridge-response-received', status: 'success' }))
      core.sink.record(makeEvent({ stage: 'desktop-relay-response-sent', status: 'success' }))
      core.sink.record(makeEvent({ stage: 'relay-response-forwarded', status: 'success' }))
      core.sink.record(makeEvent({ stage: 'gateway-response-produced', status: 'success' }))
      core.sink.record(makeEvent({ stage: 'http-response-returned', status: 'success' }))

      const result = executeGetSystemHealth(core, {})
      const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

      expect(payload.status).toBe('OPERATIONAL')
      expect(payload.diagnosis.state).toBe('NO_ACTIVE_FAILURE')
      expect(payload.diagnosis.deepestProvenProgress).toBeUndefined()
      expect(payload.diagnosis.diagnosticFrontier).toBeUndefined()
      expect(payload.diagnosis.diagnosticResolution).toBeUndefined()
      expect(payload.diagnosis.observabilityGap).toBeUndefined()
      expect(payload.diagnosis.nextBestEvidence).toBeUndefined()
      expect(payload.lastFailureDiagnosis).toBeNull()
    })
  })
})
