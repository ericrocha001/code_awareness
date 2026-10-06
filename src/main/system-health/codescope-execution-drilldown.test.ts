import { describe, expect, it } from 'vitest'
import type { ChannelTraceEvent } from '../../shared/types/channel-types'
import { SystemHealthCore } from './system-health-core'
import { executeGetSystemHealth, type SystemHealthDiagnosticPayload } from './system-health-mcp'
import { codeScopeExecutionDrilldownProvider } from './codescope-execution-drilldown'

function makeEvent(overrides: Partial<ChannelTraceEvent> & Pick<ChannelTraceEvent, 'stage' | 'status'>): ChannelTraceEvent {
  const baseTs = new Date().toISOString()
  return {
    timestamp: baseTs,
    requestId: 'req-codescope-accuracy-1',
    sessionId: 'sess-codescope-accuracy-1',
    method: 'tools/call',
    tool: 'discover_repository',
    durationMs: 0,
    ...overrides
  }
}

describe('Diagnostic Accuracy Harness — CodeScope Execution Drilldown', () => {
  it('Caso 1 — Operação não roteada: Operation Routing FAILED com INVALID_ARGUMENT', () => {
    const core = new SystemHealthCore()
    core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'desktop-request-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'mcp-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'mcp-request-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'codescope-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'codescope-operation-routed', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'codescope-operation-routed', status: 'error', error: 'INVALID_ARGUMENT' }))

    const result = executeGetSystemHealth(core, {})
    const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

    expect(payload.status).toBe('DEGRADED')
    expect(payload.firstFailedBoundary).toBe('CodeScope Execution')
    expect(payload.diagnosis.state).toBe('LOCALIZED')
    expect(payload.diagnosis.faultScope?.precision).toBe('EXACT')
    expect(payload.diagnosis.disposition).toBe('INSPECT_CODE')

    const drilldown = payload.diagnosis.drilldown
    expect(drilldown).toBeDefined()
    expect(drilldown?.canonicalStage).toBe('CodeScope Execution')
    expect(drilldown?.state).toBe('LOCALIZED')
    expect(drilldown?.precision).toBe('EXACT')
    expect(drilldown?.firstFailedCheckpoint).toBe('Operation Routing')
    expect(drilldown?.lastSuccessfulCheckpoint).toBeNull()
    expect(drilldown?.firstBlockedCheckpoint).toBe('Snapshot Synchronization')
    expect(drilldown?.reasonCode).toBe('INVALID_ARGUMENT')

    const routingCp = drilldown?.checkpoints.find((c) => c.name === 'Operation Routing')
    expect(routingCp?.status).toBe('FAILED')
    expect(routingCp?.reasonCode).toBe('INVALID_ARGUMENT')

    const downstream = drilldown?.checkpoints.slice(1) ?? []
    expect(downstream).toHaveLength(4)
    for (const cp of downstream) {
      expect(cp.status).toBe('BLOCKED')
      expect(cp.durationMs).toBeUndefined()
      expect(cp.reasonCode).toBeUndefined()
    }

    expect(payload.diagnosis.investigationTarget).toEqual({
      systemArea: 'CodeScope Tool Dispatch',
      component: 'Context Navigation MCP Adapter',
      boundary: 'MCP Request → Tool Operation Routing',
      responsibility: 'Validating tool arguments and routing to the designated context operation',
      investigationSeeds: [
        'src/main/mcp/channel-mcp-adapter.ts'
      ]
    })
  })

  it('Caso 2 — Sincronização de snapshot não completou (Timeout real de discover_repository): Snapshot Synchronization FAILED — REQUEST_TIMEOUT', () => {
    const core = new SystemHealthCore()
    core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'desktop-request-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'mcp-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'mcp-request-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'codescope-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'codescope-operation-routed', status: 'success' }))
    core.sink.record(makeEvent({ stage: 'codescope-snapshot-started', status: 'started' }))
    // Timeout strikes while waiting for snapshot
    core.sink.record(makeEvent({ stage: 'codescope-snapshot-started', status: 'error', error: 'REQUEST_TIMEOUT', durationMs: 30_000 }))

    const result = executeGetSystemHealth(core, {})
    const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

    expect(payload.status).toBe('DEGRADED')
    expect(payload.firstFailedBoundary).toBe('CodeScope Execution')
    expect(payload.diagnosis.state).toBe('LOCALIZED')
    expect(payload.diagnosis.faultScope?.precision).toBe('EXACT')
    expect(payload.diagnosis.disposition).toBe('INSPECT_CODE')

    const drilldown = payload.diagnosis.drilldown
    expect(drilldown).toBeDefined()
    expect(drilldown?.canonicalStage).toBe('CodeScope Execution')
    expect(drilldown?.lastSuccessfulCheckpoint).toBe('Operation Routing')
    expect(drilldown?.firstFailedCheckpoint).toBe('Snapshot Synchronization')
    expect(drilldown?.firstBlockedCheckpoint).toBe('Index Query')
    expect(drilldown?.reasonCode).toBe('REQUEST_TIMEOUT')

    const snapshotCp = drilldown?.checkpoints.find((c) => c.name === 'Snapshot Synchronization')
    expect(snapshotCp?.status).toBe('FAILED')
    expect(snapshotCp?.reasonCode).toBe('REQUEST_TIMEOUT')

    const queryCp = drilldown?.checkpoints.find((c) => c.name === 'Index Query')
    expect(queryCp?.status).toBe('BLOCKED')

    expect(payload.diagnosis.investigationTarget).toEqual({
      systemArea: 'CodeMap Snapshot & Maintenance',
      component: 'CodeMap Service / Background Synchronizer',
      boundary: 'Context Engine → CodeMap Snapshot',
      responsibility: 'Awaiting background maintenance, backfill, and synchronizer queue to achieve snapshot consistency',
      investigationSeeds: [
        'src/main/core/code-map-service.ts'
      ]
    })
  })

  it('Caso 3 — Consulta de índice não completou: Index Query FAILED', () => {
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
    core.sink.record(makeEvent({ stage: 'codescope-index-query-started', status: 'error', error: 'INDEX_QUERY_FAILED' }))

    const result = executeGetSystemHealth(core, {})
    const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

    const drilldown = payload.diagnosis.drilldown
    expect(drilldown).toBeDefined()
    expect(drilldown?.lastSuccessfulCheckpoint).toBe('Snapshot Synchronization')
    expect(drilldown?.firstFailedCheckpoint).toBe('Index Query')
    expect(drilldown?.firstBlockedCheckpoint).toBe('Result Assembly')
    expect(drilldown?.reasonCode).toBe('INDEX_QUERY_FAILED')
    expect(drilldown?.precision).toBe('EXACT')

    expect(payload.diagnosis.investigationTarget).toEqual({
      systemArea: 'CodeMap Index Query',
      component: 'CodeMap Model / Storage',
      boundary: 'Context Engine → CodeMap Model',
      responsibility: 'Querying indexed files, elements, relationships, and references from the repository model',
      investigationSeeds: [
        'src/main/core/code-map-service.ts',
        'src/main/core/codemap/code-map-model.ts'
      ]
    })
  })

  it('Caso 4 — Construção de resultado falhou: Result Assembly FAILED', () => {
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
    core.sink.record(makeEvent({ stage: 'codescope-result-assembly-started', status: 'error', error: 'RESULT_ASSEMBLY_FAILED' }))

    const result = executeGetSystemHealth(core, {})
    const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

    const drilldown = payload.diagnosis.drilldown
    expect(drilldown).toBeDefined()
    expect(drilldown?.lastSuccessfulCheckpoint).toBe('Index Query')
    expect(drilldown?.firstFailedCheckpoint).toBe('Result Assembly')
    expect(drilldown?.firstBlockedCheckpoint).toBe('Operation Completed')
    expect(drilldown?.reasonCode).toBe('RESULT_ASSEMBLY_FAILED')

    expect(payload.diagnosis.investigationTarget).toEqual({
      systemArea: 'Context Result Processing',
      component: 'Context Engine / Navigation Serializer',
      boundary: 'Indexed Data → Structured Output Serialization',
      responsibility: 'Transforming model data into tool-specific response structures and serializing output format',
      investigationSeeds: [
        'src/main/core/context/context-engine.ts',
        'src/main/core/context/context-navigation-serializer.ts'
      ]
    })
  })

  it('Caso 5 — Operação não retornou: Operation Completed FAILED', () => {
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
    core.sink.record(makeEvent({ stage: 'codescope-handler-completed', status: 'error', error: 'OPERATION_RETURN_FAILED' }))

    const result = executeGetSystemHealth(core, {})
    const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

    const drilldown = payload.diagnosis.drilldown
    expect(drilldown).toBeDefined()
    expect(drilldown?.lastSuccessfulCheckpoint).toBe('Result Assembly')
    expect(drilldown?.firstFailedCheckpoint).toBe('Operation Completed')
    expect(drilldown?.firstBlockedCheckpoint).toBeNull()
    expect(drilldown?.reasonCode).toBe('OPERATION_RETURN_FAILED')
    expect(drilldown?.precision).toBe('EXACT')

    expect(payload.diagnosis.investigationTarget).toEqual({
      systemArea: 'CodeScope Output Delivery',
      component: 'Context Navigation MCP Adapter / MCP Server',
      boundary: 'Context Operation Return → MCP Server',
      responsibility: 'Packaging tool result into MCP content envelope and returning to caller',
      investigationSeeds: [
        'src/main/mcp/channel-mcp-adapter.ts',
        'src/main/mcp/mcp-http-server.ts'
      ]
    })
  })

  it('Caso 6 — Caminho saudável: todos os 5 checkpoints OPERATIONAL', () => {
    const events = [
      makeEvent({ stage: 'codescope-operation-routed', status: 'success' }),
      makeEvent({ stage: 'codescope-snapshot-started', status: 'started' }),
      makeEvent({ stage: 'codescope-snapshot-completed', status: 'success' }),
      makeEvent({ stage: 'codescope-index-query-started', status: 'started' }),
      makeEvent({ stage: 'codescope-index-query-completed', status: 'success' }),
      makeEvent({ stage: 'codescope-result-assembly-started', status: 'started' }),
      makeEvent({ stage: 'codescope-result-assembly-completed', status: 'success' }),
      makeEvent({ stage: 'codescope-handler-completed', status: 'success' })
    ]

    const drilldown = codeScopeExecutionDrilldownProvider.evaluate(events)
    expect(drilldown).not.toBeNull()
    expect(drilldown?.state).toBe('NO_ACTIVE_FAILURE')
    expect(drilldown?.firstFailedCheckpoint).toBeNull()
    expect(drilldown?.lastSuccessfulCheckpoint).toBe('Operation Completed')
    expect(drilldown?.checkpoints).toHaveLength(5)
    for (const cp of drilldown!.checkpoints) {
      expect(cp.status).toBe('OPERATIONAL')
    }
  })

  it('Caso 7 — Evidência insuficiente: checkpoint crítico ausente sem contrato produz precision BOUNDED e missingEvidence', () => {
    const events = [
      makeEvent({ stage: 'codescope-handler-started', status: 'started' }),
      makeEvent({ stage: 'codescope-execution', status: 'error', error: 'REQUEST_TIMEOUT' })
    ]

    const drilldown = codeScopeExecutionDrilldownProvider.evaluate(events, 'REQUEST_TIMEOUT')
    expect(drilldown).not.toBeNull()
    expect(drilldown?.precision).toBe('BOUNDED')
    expect(drilldown?.state).toBe('BOUNDED')
    expect(drilldown?.firstFailedCheckpoint).toBe('Operation Routing')
    expect(drilldown?.missingEvidence).toContain('codescope-operation-routed')
  })

  // ─── Deepest Proven Progress Permanent Harness (Sections 12, 13, 14) ─────────

  it('Harness Section 12 — Outer timeout + downstream started: MCP Request OPERATIONAL, CodeScope Execution FAILED, fault scope uses deepest evidence', () => {
    const core = new SystemHealthCore()
    // Sequence: MCP Handler Started -> CodeScope Operation Routed -> CodeScope Snapshot Started -> outer timeout (bridge-forward-started)
    core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'desktop-request-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'mcp-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'mcp-request-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'codescope-handler-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'codescope-operation-routed', status: 'success' }))
    core.sink.record(makeEvent({ stage: 'codescope-snapshot-started', status: 'started' }))
    // Outer transport timeout
    core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'error', error: 'REQUEST_TIMEOUT', durationMs: 25_066 }))

    const result = executeGetSystemHealth(core, {})
    const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

    expect(payload.status).toBe('DEGRADED')
    // MCP Request is NOT the failure region (it is OPERATIONAL)
    const mcpStage = payload.stages.find((s) => s.name === 'MCP Request')
    expect(mcpStage?.status).toBe('OPERATIONAL')

    // CodeScope Execution is NOT BLOCKED (it is FAILED)
    const csStage = payload.stages.find((s) => s.name === 'CodeScope Execution')
    expect(csStage?.status).toBe('FAILED')
    expect(csStage?.reasonCode).toBe('REQUEST_TIMEOUT')

    expect(payload.firstFailedBoundary).toBe('CodeScope Execution')
    expect(payload.lastSuccessfulStage).toBe('MCP Request')

    // CodeScope drilldown is evaluated with deepest evidence
    expect(payload.diagnosis.drilldown?.canonicalStage).toBe('CodeScope Execution')
    expect(payload.diagnosis.drilldown?.firstFailedCheckpoint).toBe('Snapshot Synchronization')
    expect(payload.diagnosis.drilldown?.lastSuccessfulCheckpoint).toBe('Operation Routing')
    expect(payload.diagnosis.drilldown?.reasonCode).toBe('REQUEST_TIMEOUT')
    expect(payload.diagnosis.investigationTarget?.systemArea).toBe('CodeMap Snapshot & Maintenance')
  })

  it('Harness Section 13 — Nenhum downstream: MCP Handler Started sem evidência CodeScope localiza na fronteira handler → routing', () => {
    const core = new SystemHealthCore()
    // Sequence: MCP Handler Started -> outer timeout sem eventos CodeScope
    core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'desktop-request-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'mcp-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'mcp-request-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'codescope-handler-started', status: 'started' }))
    // Outer transport timeout
    core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'error', error: 'REQUEST_TIMEOUT', durationMs: 25_066 }))

    const result = executeGetSystemHealth(core, {})
    const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

    expect(payload.status).toBe('DEGRADED')
    expect(payload.firstFailedBoundary).toBe('CodeScope Execution')
    expect(payload.lastSuccessfulStage).toBe('MCP Request')

    // Fault scope between handler and routing CodeScope — does NOT invent snapshot activity
    expect(payload.diagnosis.drilldown?.canonicalStage).toBe('CodeScope Execution')
    expect(payload.diagnosis.drilldown?.firstFailedCheckpoint).toBe('Operation Routing')
    expect(payload.diagnosis.drilldown?.state).toBe('BOUNDED')
    expect(payload.diagnosis.drilldown?.missingEvidence).toContain('codescope-operation-routed')
    expect(payload.diagnosis.investigationTarget?.systemArea).toBe('CodeScope Tool Dispatch')
  })

  it('Harness Section 14 — Downstream completed: CodeScope Operation Completed não é marcado como falho e investigação avança para MCP Response', () => {
    const core = new SystemHealthCore()
    // Sequence: CodeScope finishes successfully -> outer timeout before response delivered
    core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'desktop-request-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'mcp-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'mcp-request-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'codescope-handler-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'codescope-operation-routed', status: 'success' }))
    core.sink.record(makeEvent({ stage: 'codescope-snapshot-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'codescope-snapshot-completed', status: 'success' }))
    core.sink.record(makeEvent({ stage: 'codescope-index-query-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'codescope-index-query-completed', status: 'success' }))
    core.sink.record(makeEvent({ stage: 'codescope-result-assembly-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'codescope-result-assembly-completed', status: 'success' }))
    core.sink.record(makeEvent({ stage: 'codescope-response-produced', status: 'success' }))
    // Outer transport timeout before response returned
    core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'error', error: 'REQUEST_TIMEOUT', durationMs: 25_066 }))

    const result = executeGetSystemHealth(core, {})
    const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

    expect(payload.status).toBe('DEGRADED')

    // CodeScope Execution is NOT marked as failed — it is OPERATIONAL
    const csStage = payload.stages.find((s) => s.name === 'CodeScope Execution')
    expect(csStage?.status).toBe('OPERATIONAL')

    // Investigation advances to MCP Response
    expect(payload.firstFailedBoundary).toBe('MCP Response')
    expect(payload.lastSuccessfulStage).toBe('CodeScope Execution')

    const respStage = payload.stages.find((s) => s.name === 'MCP Response')
    expect(respStage?.status).toBe('FAILED')
    expect(respStage?.reasonCode).toBe('REQUEST_TIMEOUT')
  })
})
