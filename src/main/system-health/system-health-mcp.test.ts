import { describe, expect, it } from 'vitest'
import { SystemHealthCore } from './system-health-core'
import { executeGetSystemHealth, SYSTEM_HEALTH_MCP_TOOL, type SystemHealthDiagnosticPayload } from './system-health-mcp'
import { ContextNavigationMcpAdapter } from '../mcp/context-navigation-mcp-adapter'
import type { CodeScopeTraceEvent } from '../mcp/code-scope-health'
import { CANONICAL_PIPELINE } from './canonical-pipeline'

function happyPathEvents(requestId = 'req-00000000-0000-4000-8000-000000000001'): CodeScopeTraceEvent[] {
  const ts = new Date().toISOString()
  const base = { requestId, sessionId: 'sess-0001', method: 'tools/call', tool: 'discover_repository', timestamp: ts }
  return [
    { ...base, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
    { ...base, stage: 'access-assertion-validated', durationMs: 31, status: 'success' },
    { ...base, stage: 'identity-resolved', durationMs: 40, status: 'success' },
    { ...base, stage: 'installation-routed', durationMs: 50, status: 'success' },
    { ...base, stage: 'relay-request-sent', durationMs: 156, status: 'started' },
    { ...base, stage: 'desktop-request-received', durationMs: 160, status: 'started' },
    { ...base, stage: 'mcp-request-started', durationMs: 170, status: 'started' },
    { ...base, stage: 'codescope-request-started', durationMs: 180, status: 'started' },
    { ...base, stage: 'codescope-response-produced', durationMs: 200, status: 'success' },
    { ...base, stage: 'mcp-response-produced', durationMs: 210, status: 'success' },
    { ...base, stage: 'mcp-response-sent', durationMs: 215, status: 'success' },
    { ...base, stage: 'desktop-relay-response-sent', durationMs: 220, status: 'success' },
    { ...base, stage: 'relay-response-forwarded', durationMs: 225, status: 'success' },
    { ...base, stage: 'gateway-relay-response-received', durationMs: 1719, status: 'success' },
    { ...base, stage: 'gateway-response-produced', durationMs: 2460, status: 'success' },
    { ...base, stage: 'http-response-returned', durationMs: 2460, status: 'success' },
    { ...base, stage: 'gateway-response-delivered', durationMs: 2470, status: 'success' },
  ]
}

function mockNavigation() {
  return {
    discoverRepository: async () => ({ directories: [] }),
    getRelationships: async () => ({ files: [] }),
    inspectFiles: async () => ({ files: [] }),
    readCode: async () => [],
    getReferences: async () => ({ references: [] }),
    getSymbolDependencies: async () => ({ dependencies: [] }),
    getSymbolHierarchy: async () => ({ hierarchies: [] }),
  } as any
}

describe('System Health MCP — get_system_health tool', () => {
  it('appears in the MCP catalog alongside the seven CodeScope tools and runtime identity (9 tools total)', () => {
    const adapter = new ContextNavigationMcpAdapter(mockNavigation(), new SystemHealthCore())
    const tools = adapter.listTools()
    expect(tools).toHaveLength(9)
    expect(tools.map((t) => t.name)).toContain('get_system_health')
    expect(tools.map((t) => t.name)).toContain('get_runtime_identity')
    expect(tools.map((t) => t.name)).toEqual([
      'discover_repository',
      'get_relationships',
      'inspect_files',
      'get_references',
      'get_symbol_dependencies',
      'get_symbol_hierarchy',
      'read_code',
      'get_system_health',
      'get_runtime_identity',
    ])
    const healthTool = tools.find((t) => t.name === 'get_system_health')!
    expect(healthTool.description).toContain('Inspect the operational health')
    expect(healthTool.inputSchema.properties).toHaveProperty('feature')
    expect(healthTool.securitySchemes).toEqual([{ type: 'oauth2', scopes: [] }])
  })

  it('healthy projection: returns OPERATIONAL, functional proof, and 12 operational stages', async () => {
    const core = new SystemHealthCore()
    for (const event of happyPathEvents()) core.sink.record(event)

    const adapter = new ContextNavigationMcpAdapter(mockNavigation(), core)
    const result = await adapter.callTool('get_system_health', {})

    expect(result.isError).toBeUndefined()
    expect(result.content).toHaveLength(1)
    const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

    expect(payload.feature).toBe('codescope')
    expect(payload.status).toBe('OPERATIONAL')
    expect(payload.stale).toBe(false)
    expect(payload.lastFunctionalProof).not.toBeNull()
    expect(payload.lastFunctionalProof?.operation).toBe('discover_repository')
    expect(payload.lastFunctionalProof?.traceId).toBe('req-00000000-0000-4000-8000-000000000001')
    expect(payload.lastFailure).toBeNull()
    expect(payload.firstFailedBoundary).toBeNull()
    expect(payload.lastSuccessfulStage).toBe('Client Response')
    expect(payload.reasonCode).toBeNull()
    expect(payload.stages).toHaveLength(12)
    for (const stage of payload.stages) {
      expect(stage.status).toBe('OPERATIONAL')
    }
  })

  it('failure projection: returns firstFailedBoundary, reasonCode, lastSuccessfulStage, and downstream BLOCKED', async () => {
    const core = new SystemHealthCore()
    const ts = new Date().toISOString()
    const base = { requestId: 'req-fail-1', sessionId: 'sess-fail', method: 'tools/call', tool: 'discover_repository', timestamp: ts }
    const failureEvents: CodeScopeTraceEvent[] = [
      { ...base, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...base, stage: 'access-assertion-validated', durationMs: 31, status: 'success' },
      { ...base, stage: 'identity-resolved', durationMs: 40, status: 'success' },
      { ...base, stage: 'installation-routed', durationMs: 50, status: 'success' },
      { ...base, stage: 'relay-request-sent', durationMs: 60, status: 'started' },
      { ...base, stage: 'desktop-request-received', durationMs: 65, status: 'started' },
      { ...base, stage: 'mcp-request-started', durationMs: 70, status: 'started' },
      { ...base, stage: 'codescope-request-started', durationMs: 75, status: 'started' },
      { ...base, stage: 'codescope-response-produced', durationMs: 120, status: 'success' },
      { ...base, stage: 'mcp-response-produced', durationMs: 130, status: 'success' },
      { ...base, stage: 'mcp-response-sent', durationMs: 135, status: 'success' },
      { ...base, stage: 'desktop-relay-response-sent', durationMs: 140, status: 'error', error: 'REQUEST_TIMEOUT' },
    ]
    for (const event of failureEvents) core.sink.record(event)

    const adapter = new ContextNavigationMcpAdapter(mockNavigation(), core)
    const result = await adapter.callTool('get_system_health', { feature: 'codescope' })

    expect(result.isError).toBeUndefined()
    const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

    expect(payload.status).toBe('DEGRADED')
    expect(payload.firstFailedBoundary).toBe('Relay Inbound')
    expect(payload.lastSuccessfulStage).toBe('MCP Response')
    expect(payload.reasonCode).toBe('REQUEST_TIMEOUT')

    const failedStage = payload.stages.find((s) => s.name === 'Relay Inbound')
    expect(failedStage?.status).toBe('FAILED')
    expect(failedStage?.reasonCode).toBe('REQUEST_TIMEOUT')

    const mcpResponse = payload.stages.find((s) => s.name === 'MCP Response')
    expect(mcpResponse?.status).toBe('OPERATIONAL')

    const gatewayResponse = payload.stages.find((s) => s.name === 'Gateway Response')
    expect(gatewayResponse?.status).toBe('BLOCKED')

    const clientResponse = payload.stages.find((s) => s.name === 'Client Response')
    expect(clientResponse?.status).toBe('BLOCKED')
  })

  it('freshness: reconnect marks evidence stale and prevents reporting old evidence as current OPERATIONAL proof', async () => {
    const core = new SystemHealthCore()
    for (const event of happyPathEvents()) core.sink.record(event)

    // Initially operational
    let result = executeGetSystemHealth(core, {})
    let payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload
    expect(payload.status).toBe('OPERATIONAL')
    expect(payload.stale).toBe(false)

    // Reconnect invalidates evidence
    core.invalidate()

    result = executeGetSystemHealth(core, {})
    payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload
    expect(payload.status).toBe('UNKNOWN')
    expect(payload.stale).toBe(true)
    expect(payload.lastFunctionalProof).not.toBeNull()
  })

  it('sanitization: response never contains tokens, JWT, assertions, secrets, or source code', async () => {
    const core = new SystemHealthCore()
    for (const event of happyPathEvents()) core.sink.record(event)

    const result = executeGetSystemHealth(core, {})
    const text = result.content[0].text

    for (const forbidden of ['bearer', 'eyj', 'secret', 'credential', 'cookie', 'password', 'token', 'authorization']) {
      expect(text.toLowerCase()).not.toContain(forbidden)
    }
  })

  it('unsupported feature produces SYSTEM_HEALTH_FEATURE_NOT_SUPPORTED error', async () => {
    const core = new SystemHealthCore()
    const result = executeGetSystemHealth(core, { feature: 'codemap' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('SYSTEM_HEALTH_FEATURE_NOT_SUPPORTED')
    expect(result.content[0].text).toContain('codemap')
  })

  it('calling get_system_health does not pollute or overwrite CodeScope functional evidence', async () => {
    const core = new SystemHealthCore()
    for (const event of happyPathEvents('req-real-proof')) core.sink.record(event)

    const stateBefore = core.getState()
    expect(stateBefore.lastFunctionalProof?.operation).toBe('discover_repository')
    expect(stateBefore.lastFunctionalProof?.traceId).toBe('req-real-proof')

    // Simulate get_system_health being called via MCP
    const adapter = new ContextNavigationMcpAdapter(mockNavigation(), core)
    await adapter.callTool('get_system_health', {})

    // Simulate trace sink receiving a get_system_health event
    core.sink.record({
      timestamp: new Date().toISOString(),
      requestId: 'req-diag-call',
      sessionId: 'sess-1',
      method: 'tools/call',
      tool: 'get_system_health',
      stage: 'mcp-response-sent',
      durationMs: 5,
      status: 'success',
    })

    const stateAfter = core.getState()
    expect(stateAfter.lastFunctionalProof?.operation).toBe('discover_repository')
    expect(stateAfter.lastFunctionalProof?.traceId).toBe('req-real-proof')
  })

  it('regression: MCP control traffic (initialize, tools/list) does NOT generate functional proofs', () => {
    const core = new SystemHealthCore()
    const ts = new Date().toISOString()

    // 1. initialize traffic
    core.sink.record({
      timestamp: ts,
      requestId: 'req-init',
      sessionId: 'sess-1',
      method: 'initialize',
      tool: 'initialize',
      stage: 'gateway-response-delivered',
      durationMs: 50,
      status: 'success'
    })
    expect(core.getState().status).toBe('UNKNOWN')
    expect(core.getState().lastFunctionalProof).toBeNull()

    // 2. tools/list traffic
    core.sink.record({
      timestamp: ts,
      requestId: 'req-list',
      sessionId: 'sess-1',
      method: 'tools/list',
      tool: 'tools/list',
      stage: 'gateway-response-delivered',
      durationMs: 60,
      status: 'success'
    })
    expect(core.getState().status).toBe('UNKNOWN')
    expect(core.getState().lastFunctionalProof).toBeNull()
  })

  it('regression: notifications/initialized does NOT generate CodeScope functional failure', () => {
    const core = new SystemHealthCore()
    const ts = new Date().toISOString()

    core.sink.record({
      timestamp: ts,
      requestId: 'req-notif',
      sessionId: 'sess-1',
      method: 'notifications/initialized',
      tool: 'notifications/initialized',
      stage: 'gateway-relay-response-received',
      durationMs: 10,
      status: 'error',
      error: 'TOOL_ERROR'
    })
    expect(core.getState().status).toBe('UNKNOWN')
    expect(core.getState().lastFailure).toBeNull()
  })

  it('regression: discover_repository timeout produces lastFailure and subsequent MCP traffic does NOT overwrite it', () => {
    const core = new SystemHealthCore()
    const ts = new Date().toISOString()
    const reqId = 'req-disc-timeout'
    const base = { requestId: reqId, sessionId: 'sess-real', method: 'tools/call', tool: 'discover_repository', timestamp: ts }

    // discover_repository starts, executes in MCP, but times out before delivery
    const timeoutEvents: CodeScopeTraceEvent[] = [
      { ...base, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...base, stage: 'desktop-request-received', durationMs: 10, status: 'started' },
      { ...base, stage: 'mcp-request-started', durationMs: 20, status: 'started' },
      { ...base, stage: 'codescope-response-produced', durationMs: 150, status: 'success' },
      { ...base, stage: 'mcp-response-sent', durationMs: 160, status: 'success' },
      { ...base, stage: 'relay-response-forwarded', durationMs: 25_000, status: 'error', error: 'REQUEST_TIMEOUT' },
    ]
    for (const e of timeoutEvents) core.sink.record(e)

    const state = core.getState()
    expect(state.status).toBe('DEGRADED')
    expect(state.lastFailure).not.toBeNull()
    expect(state.lastFailure?.operation).toBe('discover_repository')
    expect(state.lastFailure?.firstFailedBoundary).toBe('Relay Inbound')
    expect(state.lastFailure?.reasonCode).toBe('REQUEST_TIMEOUT')

    // Subsequent MCP control traffic arrives (e.g. ChatGPT reconnects and calls initialize and tools/list)
    core.sink.record({
      timestamp: new Date().toISOString(),
      requestId: 'req-reconnect-init',
      sessionId: 'sess-reconnect',
      method: 'initialize',
      tool: 'initialize',
      stage: 'gateway-response-delivered',
      durationMs: 20,
      status: 'success'
    })
    core.sink.record({
      timestamp: new Date().toISOString(),
      requestId: 'req-reconnect-list',
      sessionId: 'sess-reconnect',
      method: 'tools/list',
      tool: 'tools/list',
      stage: 'gateway-response-delivered',
      durationMs: 30,
      status: 'success'
    })

    // The state MUST STILL BE DEGRADED with discover_repository failure!
    const stateAfterControlTraffic = core.getState()
    expect(stateAfterControlTraffic.status).toBe('DEGRADED')
    expect(stateAfterControlTraffic.lastFailure?.operation).toBe('discover_repository')
    expect(stateAfterControlTraffic.lastFailure?.firstFailedBoundary).toBe('Relay Inbound')
    expect(stateAfterControlTraffic.lastFailure?.reasonCode).toBe('REQUEST_TIMEOUT')

    // get_system_health payload top-level fields MUST represent discover_repository failure, NOT control traffic
    const toolResult = executeGetSystemHealth(core, {})
    const payload = JSON.parse(toolResult.content[0].text) as SystemHealthDiagnosticPayload
    expect(payload.status).toBe('DEGRADED')
    expect(payload.operation).toBe('discover_repository')
    expect(payload.firstFailedBoundary).toBe('Relay Inbound')
    expect(payload.reasonCode).toBe('REQUEST_TIMEOUT')
    expect(payload.lastFailure?.operation).toBe('discover_repository')
  })

  it('AI Contract Acceptance: LOCAL_MCP_UNAVAILABLE localizes to MCP Request with EXACT precision and INSPECT_CODE disposition', async () => {
    const core = new SystemHealthCore()
    const ts = new Date().toISOString()
    const base = { requestId: 'req-real-acceptance', sessionId: 'sess-real', method: 'tools/call', tool: 'discover_repository', timestamp: ts }

    const events: CodeScopeTraceEvent[] = [
      { ...base, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...base, stage: 'access-assertion-validated', durationMs: 31, status: 'success' },
      { ...base, stage: 'identity-resolved', durationMs: 40, status: 'success' },
      { ...base, stage: 'installation-routed', durationMs: 50, status: 'success' },
      { ...base, stage: 'relay-request-sent', durationMs: 60, status: 'started' },
      { ...base, stage: 'desktop-request-received', durationMs: 65, status: 'started' },
      { ...base, stage: 'bridge-forward-started', durationMs: 70, status: 'error', error: 'LOCAL_MCP_UNAVAILABLE' }
    ]
    for (const e of events) core.sink.record(e)

    const adapter = new ContextNavigationMcpAdapter(mockNavigation(), core)
    const result = await adapter.callTool('get_system_health', { feature: 'codescope' })

    expect(result.isError).toBeUndefined()
    const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

    expect(payload.status).toBe('DEGRADED')
    expect(payload.operation).toBe('discover_repository')
    expect(payload.lastSuccessfulStage).toBe('Desktop Request')
    expect(payload.firstFailedBoundary).toBe('MCP Request')
    expect(payload.reasonCode).toBe('LOCAL_MCP_UNAVAILABLE')

    expect(payload.diagnosis).toBeDefined()
    expect(payload.diagnosis.state).toBe('LOCALIZED')
    expect(payload.diagnosis.disposition).toBe('INSPECT_CODE')

    expect(payload.diagnosis.faultScope).toEqual({
      precision: 'EXACT',
      lastSuccessfulStage: 'Desktop Request',
      firstFailedStage: 'MCP Request',
      firstFailedBoundary: 'MCP Request',
      firstBlockedStage: 'CodeScope Execution'
    })

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

    expect(payload.diagnosis.drilldown).toBeDefined()
    expect(payload.diagnosis.drilldown?.canonicalStage).toBe('MCP Request')
    expect(payload.diagnosis.drilldown?.firstFailedCheckpoint).toBe('Local MCP Connection Available')
    expect(payload.diagnosis.drilldown?.firstBlockedCheckpoint).toBe('MCP Request Dispatched')
    expect(payload.diagnosis.drilldown?.precision).toBe('EXACT')

    const rawPayload = JSON.parse(result.content[0].text) as Record<string, unknown>
    expect(rawPayload.suggestedFix).toBeUndefined()
    expect(rawPayload.rootCause).toBeUndefined()

    const mcpStage = payload.stages.find((s) => s.name === 'MCP Request')
    expect(mcpStage?.status).toBe('FAILED')
    expect(mcpStage?.reasonCode).toBe('LOCAL_MCP_UNAVAILABLE')

    const codeScopeStage = payload.stages.find((s) => s.name === 'CodeScope Execution')
    expect(codeScopeStage?.status).toBe('BLOCKED')
    expect(codeScopeStage?.durationMs).toBeUndefined()
    expect(codeScopeStage?.reasonCode).toBeUndefined()

    const clientResponseStage = payload.stages.find((s) => s.name === 'Client Response')
    expect(clientResponseStage?.status).toBe('BLOCKED')
    expect(clientResponseStage?.durationMs).toBeUndefined()
    expect(clientResponseStage?.reasonCode).toBeUndefined()
  })

  it('AI Contract: functional proof invariant rejects non-functional tools like initialize on projection', async () => {
    const core = new SystemHealthCore()
    // Inject corrupted / legacy proof directly into state
    ;(core as unknown as { lastFunctionalProof: unknown }).lastFunctionalProof = {
      operation: 'initialize',
      traceId: 'req-corrupted',
      at: new Date().toISOString(),
      durationMs: 12
    }

    const state = core.getState()
    expect(state.lastFunctionalProof).toBeNull()

    const result = executeGetSystemHealth(core, {})
    const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload
    expect(payload.lastFunctionalProof).toBeNull()
    expect(payload.diagnosis.state).toBe('NO_ACTIVE_FAILURE')
    expect(payload.diagnosis.disposition).toBe('NONE')
  })

  it('AI Contract: BLOCKED stages have no duration or reasonCode, and contradictory execution yields INSUFFICIENT_EVIDENCE', async () => {
    const core = new SystemHealthCore()
    const ts = new Date().toISOString()
    const base = { requestId: 'req-contradiction', sessionId: 'sess-contra', method: 'tools/call', tool: 'discover_repository', timestamp: ts }

    const events: CodeScopeTraceEvent[] = [
      { ...base, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...base, stage: 'desktop-request-received', durationMs: 10, status: 'started' },
      { ...base, stage: 'bridge-forward-started', durationMs: 20, status: 'error', error: 'LOCAL_MCP_UNAVAILABLE' },
      // Contradictory terminal success: a downstream stage reports success after MCP Request failed
      { ...base, stage: 'relay-response-delivered', durationMs: 100, status: 'success' }
    ]
    for (const e of events) core.sink.record(e)

    const result = executeGetSystemHealth(core, {})
    const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

    expect(payload.status).toBe('DEGRADED')
    expect(payload.diagnosis.state).toBe('INSUFFICIENT_EVIDENCE')
    expect(payload.diagnosis.disposition).toBe('COLLECT_EVIDENCE')
    expect(payload.diagnosis.faultScope?.precision).toBe('BOUNDED')

    const blockedStages = payload.stages.filter((s) => s.status === 'BLOCKED')
    for (const stage of blockedStages) {
      expect(stage.durationMs).toBeUndefined()
      expect(stage.reasonCode).toBeUndefined()
    }
  })

  it('AI Contract: duration semantics clamps lazy in-flight timeout to 30s deadline and logical timestamp', async () => {
    const core = new SystemHealthCore()
    const fiveMinutesAgo = new Date(Date.now() - 300_000).toISOString()
    const base = { requestId: 'req-stalled-lazy', sessionId: 'sess-lazy', method: 'tools/call', tool: 'discover_repository', timestamp: fiveMinutesAgo }

    // Start event 5 minutes ago, then stalled
    core.sink.record({ ...base, stage: 'gateway-request-started', durationMs: 0, status: 'started' })
    core.sink.record({ ...base, stage: 'desktop-request-received', durationMs: 10, status: 'started' })
    core.sink.record({ ...base, stage: 'bridge-forward-started', durationMs: 20, status: 'started' })

    // When getState() is called 5 minutes later, lazy timeout triggers
    const state = core.getState()
    expect(state.status).toBe('DEGRADED')
    expect(state.lastFailure).not.toBeNull()
    expect(state.lastFailure?.reasonCode).toBe('REQUEST_TIMEOUT')

    const startMs = Date.parse(fiveMinutesAgo)
    const atMs = Date.parse(state.lastFailure!.at)
    expect(atMs - startMs).toBe(30_000)

    const result = executeGetSystemHealth(core, {})
    const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload
    expect(payload.durationMs).toBe(30_000)
    expect(payload.diagnosis.state).toBe('BOUNDED')
    expect(payload.diagnosis.disposition).toBe('EXTEND_SYSTEM_HEALTH')
    expect(payload.diagnosis.missingEvidence).toContain('mcp-request-received')
    expect(payload.diagnosis.drilldown?.firstFailedCheckpoint).toBe('MCP Request Received')
  })

  it('AI Contract: stale state after proof-only session projects STALE diagnosis and REPRODUCE disposition', async () => {
    const core = new SystemHealthCore()
    for (const event of happyPathEvents()) core.sink.record(event)
    core.invalidate()

    const result = executeGetSystemHealth(core, {})
    const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

    expect(payload.stale).toBe(true)
    expect(payload.diagnosis.state).toBe('STALE')
    expect(payload.diagnosis.disposition).toBe('REPRODUCE')
    expect(payload.diagnosis.faultScope).toBeNull()
    expect(payload.diagnosis.investigationTarget).toBeNull()
    expect(payload.diagnosis.evidenceState).toBe('HISTORICAL')
    expect(payload.lastFailureDiagnosis).toBeNull()
    expect(payload.currentHealth.stale).toBe(true)
    expect(payload.currentHealth.status).toBe('UNKNOWN')
  })

  it('AI Contract: lastFailureDiagnosis preserves drilldown coordinates after invalidate() (reconnect)', async () => {
    const core = new SystemHealthCore()
    const ts = new Date().toISOString()
    const base = { timestamp: ts, requestId: 'req-stale-failure-01', sessionId: 'sess-stale-01', method: 'tools/call', tool: 'discover_repository', durationMs: 0 }

    core.sink.record({ ...base, stage: 'gateway-request-started', status: 'started' })
    core.sink.record({ ...base, stage: 'desktop-request-received', status: 'started' })
    core.sink.record({ ...base, stage: 'bridge-forward-started', status: 'started' })
    core.sink.record({ ...base, stage: 'mcp-request-started', status: 'started' })
    core.sink.record({ ...base, stage: 'mcp-request-received', status: 'started' })
    core.sink.record({ ...base, stage: 'codescope-handler-started', status: 'started' })
    core.sink.record({ ...base, stage: 'bridge-forward-started', status: 'error', error: 'REQUEST_TIMEOUT', durationMs: 30_000 })

    const beforeInvalidate = executeGetSystemHealth(core, {})
    const beforePayload = JSON.parse(beforeInvalidate.content[0].text) as SystemHealthDiagnosticPayload
    expect(beforePayload.status).toBe('DEGRADED')
    expect(beforePayload.diagnosis.state).toBe('BOUNDED')
    expect(beforePayload.diagnosis.evidenceState).toBe('CURRENT')
    expect(beforePayload.lastFailureDiagnosis?.evidenceState).toBe('CURRENT')
    expect(beforePayload.lastFailureDiagnosis?.traceId).toBe('req-stale-failure-01')
    expect(beforePayload.lastFailureDiagnosis?.firstFailedBoundary).toBe('CodeScope Execution')
    expect(beforePayload.lastFailureDiagnosis?.drilldown?.firstFailedCheckpoint).toBe('Operation Routing')

    core.invalidate()

    const afterInvalidate = executeGetSystemHealth(core, {})
    const afterPayload = JSON.parse(afterInvalidate.content[0].text) as SystemHealthDiagnosticPayload

    expect(afterPayload.stale).toBe(true)
    expect(afterPayload.currentHealth.stale).toBe(true)
    expect(afterPayload.currentHealth.status).toBe('UNKNOWN')

    // lastFailureDiagnosis MUST be preserved with HISTORICAL evidence state
    expect(afterPayload.lastFailureDiagnosis).not.toBeNull()
    expect(afterPayload.lastFailureDiagnosis?.evidenceState).toBe('HISTORICAL')
    expect(afterPayload.lastFailureDiagnosis?.traceId).toBe('req-stale-failure-01')
    expect(afterPayload.lastFailureDiagnosis?.firstFailedBoundary).toBe('CodeScope Execution')
    expect(afterPayload.lastFailureDiagnosis?.drilldown?.firstFailedCheckpoint).toBe('Operation Routing')
    expect(afterPayload.lastFailureDiagnosis?.investigationTarget?.investigationSeeds).toContain(
      'src/main/mcp/context-navigation-mcp-adapter.ts'
    )

    // diagnosis also carries HISTORICAL evidence and preserved coordinates
    expect(afterPayload.diagnosis.disposition).toBe('REPRODUCE')
    expect(afterPayload.diagnosis.evidenceState).toBe('HISTORICAL')
    expect(afterPayload.diagnosis.drilldown?.firstFailedCheckpoint).toBe('Operation Routing')
  })

  it('AI Contract: RELAY_CLOSED is isolated to Local MCP Connection Available with lifecycle race semantics', async () => {
    const core = new SystemHealthCore()
    const ts = new Date().toISOString()
    const base = { timestamp: ts, requestId: 'req-relay-closed-01', sessionId: 'sess-rc-01', method: 'tools/call', tool: 'discover_repository', durationMs: 0 }

    core.sink.record({ ...base, stage: 'gateway-request-started', status: 'started' })
    core.sink.record({ ...base, stage: 'desktop-request-received', status: 'started' })
    core.sink.record({ ...base, stage: 'bridge-forward-started', status: 'error', error: 'RELAY_CLOSED', durationMs: 14 })

    const result = executeGetSystemHealth(core, {})
    const payload = JSON.parse(result.content[0].text) as SystemHealthDiagnosticPayload

    expect(payload.status).toBe('DEGRADED')
    expect(payload.firstFailedBoundary).toBe('MCP Request')
    expect(payload.reasonCode).toBe('RELAY_CLOSED')

    expect(payload.diagnosis.state).toBe('LOCALIZED')
    expect(payload.diagnosis.evidenceState).toBe('CURRENT')
    const drilldown = payload.diagnosis.drilldown!
    expect(drilldown.firstFailedCheckpoint).toBe('Local MCP Connection Available')
    expect(drilldown.reasonCode).toBe('RELAY_CLOSED')

    expect(payload.lastFailureDiagnosis?.firstFailedBoundary).toBe('MCP Request')
    expect(payload.lastFailureDiagnosis?.drilldown?.firstFailedCheckpoint).toBe('Local MCP Connection Available')
    expect(payload.lastFailureDiagnosis?.drilldown?.reasonCode).toBe('RELAY_CLOSED')
    expect(payload.lastFailureDiagnosis?.investigationTarget?.investigationSeeds).toContain(
      'src/main/mcp/connection/relay-transport.ts'
    )
    expect(payload.lastFailureDiagnosis?.investigationTarget?.investigationSeeds).toContain(
      'src/main/mcp/mcp-lifecycle.ts'
    )
  })
})
