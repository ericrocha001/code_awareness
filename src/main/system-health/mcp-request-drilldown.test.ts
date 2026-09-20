import { describe, expect, it } from 'vitest'
import type { CodeScopeTraceEvent } from '../mcp/code-scope-health'
import { SystemHealthCore } from './system-health-core'
import { executeGetSystemHealth, type SystemHealthDiagnosticPayload } from './system-health-mcp'
import { mcpRequestDrilldownProvider } from './mcp-request-drilldown'

function makeEvent(overrides: Partial<CodeScopeTraceEvent> & Pick<CodeScopeTraceEvent, 'stage' | 'status'>): CodeScopeTraceEvent {
  const baseTs = new Date().toISOString()
  return {
    timestamp: baseTs,
    requestId: 'req-mcp-accuracy-1',
    sessionId: 'sess-mcp-accuracy-1',
    method: 'tools/call',
    tool: 'discover_repository',
    durationMs: 0,
    ...overrides
  }
}

describe('Diagnostic Accuracy Harness — MCP Request Drilldown', () => {
  it('Caso 1 — Conexão indisponível: Local MCP Connection Available FAILED', () => {
    const core = new SystemHealthCore()
    core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'desktop-request-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'error', error: 'LOCAL_MCP_UNAVAILABLE' }))

    const result = executeGetSystemHealth(core, {})
    const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

    expect(payload.status).toBe('DEGRADED')
    expect(payload.firstFailedBoundary).toBe('MCP Request')
    expect(payload.diagnosis.state).toBe('LOCALIZED')
    expect(payload.diagnosis.faultScope?.precision).toBe('EXACT')
    expect(payload.diagnosis.disposition).toBe('INSPECT_CODE')

    const drilldown = payload.diagnosis.drilldown
    expect(drilldown).toBeDefined()
    expect(drilldown?.canonicalStage).toBe('MCP Request')
    expect(drilldown?.state).toBe('LOCALIZED')
    expect(drilldown?.precision).toBe('EXACT')
    expect(drilldown?.firstFailedCheckpoint).toBe('Local MCP Connection Available')
    expect(drilldown?.lastSuccessfulCheckpoint).toBeNull()
    expect(drilldown?.firstBlockedCheckpoint).toBe('MCP Request Dispatched')
    expect(drilldown?.reasonCode).toBe('LOCAL_MCP_UNAVAILABLE')

    const connCp = drilldown?.checkpoints.find((c) => c.name === 'Local MCP Connection Available')
    expect(connCp?.status).toBe('FAILED')
    expect(connCp?.reasonCode).toBe('LOCAL_MCP_UNAVAILABLE')

    expect(payload.diagnosis.investigationTarget).toEqual({
      systemArea: 'Local MCP Availability',
      component: 'Relay Transport / MCP Lifecycle',
      boundary: 'Desktop Process → Local MCP Server Binding',
      responsibility: 'Local MCP process lifecycle, HTTP server availability, and loopback port binding',
      investigationSeeds: [
        'src/main/mcp/connection/relay-transport.ts',
        'src/main/mcp/mcp-lifecycle.ts'
      ]
    })
  })

  it('Caso 2 — Dispatch realizado, server não recebeu: fault scope na fronteira de entrega local com precision BOUNDED', () => {
    const core = new SystemHealthCore()
    core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'desktop-request-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'relay-response-forwarded', status: 'error', error: 'REQUEST_TIMEOUT', durationMs: 30_000 }))

    const result = executeGetSystemHealth(core, {})
    const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

    const drilldown = mcpRequestDrilldownProvider.evaluate([
      makeEvent({ stage: 'bridge-forward-started', status: 'started' }),
      makeEvent({ stage: 'bridge-forward-started', status: 'error', error: 'REQUEST_TIMEOUT' })
    ], 'REQUEST_TIMEOUT')

    expect(drilldown).not.toBeNull()
    expect(drilldown?.precision).toBe('BOUNDED')
    expect(drilldown?.state).toBe('BOUNDED')
    expect(drilldown?.lastSuccessfulCheckpoint).toBe('MCP Request Dispatched')
    expect(drilldown?.firstFailedCheckpoint).toBe('MCP Request Received')
    expect(drilldown?.firstBlockedCheckpoint).toBe('MCP Handler Started')
    expect(drilldown?.missingEvidence).toContain('mcp-request-received')

    const cp1 = drilldown?.checkpoints.find((c) => c.name === 'Local MCP Connection Available')
    expect(cp1?.status).toBe('OPERATIONAL')
    const cp2 = drilldown?.checkpoints.find((c) => c.name === 'MCP Request Dispatched')
    expect(cp2?.status).toBe('OPERATIONAL')
    const cp3 = drilldown?.checkpoints.find((c) => c.name === 'MCP Request Received')
    expect(cp3?.status).toBe('UNKNOWN')

    expect(drilldown?.refinedInvestigationTarget).toEqual({
      systemArea: 'Local MCP Ingress Transport',
      component: 'Local MCP HTTP Ingress',
      boundary: 'Desktop Dispatch → MCP HTTP Server Ingress',
      responsibility: 'Delivery and reception of the local HTTP request across loopback',
      investigationSeeds: [
        'src/main/mcp/mcp-http-server.ts',
        'src/main/mcp/connection/relay-transport.ts'
      ]
    })
  })

  it('Caso 3 — Server recebeu, handler não iniciou: fault scope entre receive e handler dispatch', () => {
    const core = new SystemHealthCore()
    core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'desktop-request-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'mcp-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'mcp-request-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'mcp-dispatch-started', status: 'error', error: 'METHOD_NOT_FOUND' }))

    const result = executeGetSystemHealth(core, {})
    const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

    expect(payload.diagnosis.drilldown?.lastSuccessfulCheckpoint).toBe('MCP Request Received')
    expect(payload.diagnosis.drilldown?.firstFailedCheckpoint).toBe('MCP Handler Started')
    expect(payload.diagnosis.drilldown?.firstBlockedCheckpoint).toBeNull()
    expect(payload.diagnosis.drilldown?.reasonCode).toBe('METHOD_NOT_FOUND')
    expect(payload.diagnosis.drilldown?.precision).toBe('EXACT')

    expect(payload.diagnosis.investigationTarget).toEqual({
      systemArea: 'MCP Server Dispatcher',
      component: 'MCP Protocol Router / Dispatcher',
      boundary: 'MCP HTTP Ingress → Tool Handler Dispatch',
      responsibility: 'JSON-RPC parsing, schema validation, and tool method routing',
      investigationSeeds: [
        'src/main/mcp/mcp-http-server.ts',
        'src/main/mcp/context-navigation-mcp-adapter.ts'
      ]
    })
  })

  it('Caso 4 — Handler iniciou e expirou: Deepest Proven Progress refina para CodeScope Execution e MCP Request é OPERATIONAL', () => {
    const core = new SystemHealthCore()
    core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'desktop-request-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'mcp-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'mcp-request-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'codescope-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'codescope-handler-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'error', error: 'REQUEST_TIMEOUT', durationMs: 30_000 }))

    const result = executeGetSystemHealth(core, {})
    const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

    expect(payload.status).toBe('DEGRADED')
    // MCP Request reached handler and is OPERATIONAL
    const mcpStage = payload.stages.find((s) => s.name === 'MCP Request')
    expect(mcpStage?.status).toBe('OPERATIONAL')

    // CodeScope Execution is the failed boundary, refined by Deepest Proven Progress
    expect(payload.firstFailedBoundary).toBe('CodeScope Execution')
    expect(payload.lastSuccessfulStage).toBe('MCP Request')
    expect(payload.diagnosis.drilldown?.canonicalStage).toBe('CodeScope Execution')
    expect(payload.diagnosis.drilldown?.firstFailedCheckpoint).toBe('Operation Routing')

    // Direct provider evaluation on MCP Request returns happy path because handler was reached
    const mcpDrilldown = mcpRequestDrilldownProvider.evaluate([
      makeEvent({ stage: 'bridge-forward-started', status: 'started' }),
      makeEvent({ stage: 'mcp-request-started', status: 'started' }),
      makeEvent({ stage: 'mcp-request-received', status: 'started' }),
      makeEvent({ stage: 'codescope-handler-started', status: 'started' })
    ])
    expect(mcpDrilldown?.state).toBe('NO_ACTIVE_FAILURE')
    expect(mcpDrilldown?.firstFailedCheckpoint).toBeNull()
    expect(mcpDrilldown?.checkpoints).toHaveLength(4)
  })

  it('Caso 5 — Handler completou e response não voltou: Deepest Proven Progress refina para MCP Response', () => {
    const core = new SystemHealthCore()
    core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'desktop-request-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'mcp-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'mcp-request-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'codescope-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'codescope-handler-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'codescope-response-produced', status: 'success' }))
    core.sink.record(makeEvent({ stage: 'codescope-handler-completed', status: 'success' }))
    core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'error', error: 'PAYLOAD_TOO_LARGE' }))

    const result = executeGetSystemHealth(core, {})
    const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

    expect(payload.status).toBe('DEGRADED')
    expect(payload.firstFailedBoundary).toBe('MCP Response')
    expect(payload.lastSuccessfulStage).toBe('CodeScope Execution')

    const csStage = payload.stages.find((s) => s.name === 'CodeScope Execution')
    expect(csStage?.status).toBe('OPERATIONAL')

    const respStage = payload.stages.find((s) => s.name === 'MCP Response')
    expect(respStage?.status).toBe('FAILED')
    expect(respStage?.reasonCode).toBe('PAYLOAD_TOO_LARGE')
  })

  it('Caso 6 — Caminho saudável: todos os checkpoints OPERATIONAL e MCP Request não é região de falha', () => {
    const events = [
      makeEvent({ stage: 'bridge-forward-started', status: 'started' }),
      makeEvent({ stage: 'mcp-request-started', status: 'started' }),
      makeEvent({ stage: 'mcp-request-received', status: 'started' }),
      makeEvent({ stage: 'codescope-handler-started', status: 'started' })
    ]

    const drilldown = mcpRequestDrilldownProvider.evaluate(events)
    expect(drilldown).not.toBeNull()
    expect(drilldown?.state).toBe('NO_ACTIVE_FAILURE')
    expect(drilldown?.firstFailedCheckpoint).toBeNull()
    expect(drilldown?.lastSuccessfulCheckpoint).toBe('MCP Handler Started')
    expect(drilldown?.checkpoints).toHaveLength(4)
    for (const cp of drilldown!.checkpoints) {
      expect(cp.status).toBe('OPERATIONAL')
    }
  })
})
