import { describe, expect, it } from 'vitest'
import type { CodeScopeTraceEvent } from '../mcp/code-scope-health'
import { SystemHealthCore } from './system-health-core'
import { buildDiagnosticTrace, type DiagnosticTrace } from './diagnostic-trace'
import { CANONICAL_PIPELINE } from './canonical-pipeline'
import type { CanonicalStage } from '../../shared/types/system-health-types'

function makeEvent(overrides: Partial<CodeScopeTraceEvent> & Pick<CodeScopeTraceEvent, 'stage' | 'status'>): CodeScopeTraceEvent {
  return {
    timestamp: new Date().toISOString(),
    requestId: 'req-00000000-0000-4000-8000-000000000001',
    sessionId: 'sess-00000000-0000-4000-8000-000000000001',
    method: 'tools/call',
    tool: 'discover_repository',
    durationMs: 0,
    ...overrides,
  }
}

function happyPathEvents(requestId = 'req-00000000-0000-4000-8000-000000000001', sessionId = 'sess-00000000-0000-4000-8000-000000000001'): CodeScopeTraceEvent[] {
  const ts = new Date().toISOString()
  const base = { requestId, sessionId, method: 'tools/call', tool: 'discover_repository', timestamp: ts }
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

function assertFaultLocalization(
  trace: DiagnosticTrace,
  expected: {
    lastSuccessfulStage: CanonicalStage | null
    firstFailedStage: CanonicalStage
    reasonCode: string
    blockedStages: CanonicalStage[]
  }
): void {
  expect(trace.lastSuccessfulStage).toBe(expected.lastSuccessfulStage)
  expect(trace.firstFailedBoundary).toBe(expected.firstFailedStage)
  expect(trace.reasonCode).toBe(expected.reasonCode)

  const failedResult = trace.stages.find((s) => s.stage === expected.firstFailedStage)
  expect(failedResult?.status).toBe('FAILED')
  expect(failedResult?.reasonCode).toBe(expected.reasonCode)

  if (expected.lastSuccessfulStage) {
    const lastSuccessResult = trace.stages.find((s) => s.stage === expected.lastSuccessfulStage)
    expect(lastSuccessResult?.status).toBe('OPERATIONAL')
  }

  const actualBlockedStages = trace.stages
    .filter((s) => s.status === 'BLOCKED')
    .map((s) => s.stage)
  expect(actualBlockedStages).toEqual(expected.blockedStages)
}

function downstreamBlocked(afterStage: CanonicalStage): CanonicalStage[] {
  const idx = CANONICAL_PIPELINE.indexOf(afterStage)
  return CANONICAL_PIPELINE.slice(idx + 1)
}

// ─── Reliability Harness ───────────────────────────────────────────────────

describe('Reliability Harness — full functional path', () => {
  it('produces OPERATIONAL and last functional proof after successful end-to-end operation', async () => {
    const core = new SystemHealthCore()
    const states: ReturnType<typeof core.getState>[] = []
    core.onChanged((s) => states.push(s))

    for (const event of happyPathEvents()) core.sink.record(event)

    const state = core.getState()
    expect(state.status).toBe('OPERATIONAL')
    expect(state.lastFunctionalProof).not.toBeNull()
    expect(state.lastFunctionalProof?.operation).toBe('discover_repository')
    expect(state.stale).toBe(false)
    expect(states.length).toBeGreaterThan(0)
    expect(states.at(-1)?.status).toBe('OPERATIONAL')
  })

  it('correlation ID is preserved through all stages', () => {
    const traceId = 'req-aaaa0000-0000-4000-8000-000000000001'
    const events = happyPathEvents(traceId)
    const trace = buildDiagnosticTrace(events)
    expect(trace).not.toBeNull()
    expect(trace!.traceId).toBe(traceId)
  })

  it('deadline is not exceeded in a normal response scenario', () => {
    const events = happyPathEvents()
    const last = events[events.length - 1]
    expect(last.durationMs).toBeLessThan(30_000)
  })

  it('valid response delivered is recognized as functional proof and not confused with mcp-response-sent alone', () => {
    const core = new SystemHealthCore()
    const requestId = 'req-00000000-0000-4000-8000-000000000002'
    const sessionId = 'sess-00000000-0000-4000-8000-000000000002'
    const ts = new Date().toISOString()
    const base = { requestId, sessionId, method: 'tools/call', tool: 'discover_repository', timestamp: ts }

    // Send only up to mcp-response-sent (no relay delivery or gateway confirmation)
    const partialEvents: CodeScopeTraceEvent[] = [
      { ...base, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...base, stage: 'access-assertion-validated', durationMs: 31, status: 'success' },
      { ...base, stage: 'identity-resolved', durationMs: 40, status: 'success' },
      { ...base, stage: 'installation-routed', durationMs: 50, status: 'success' },
      { ...base, stage: 'mcp-request-started', durationMs: 10, status: 'started' },
      { ...base, stage: 'codescope-response-produced', durationMs: 200, status: 'success' },
      { ...base, stage: 'mcp-response-produced', durationMs: 210, status: 'success' },
      { ...base, stage: 'mcp-response-sent', durationMs: 215, status: 'success' },
    ]
    for (const event of partialEvents) core.sink.record(event)

    // Without a delivery stage, the trace is not finalized — no functional proof
    expect(core.getState().status).toBe('UNKNOWN')
    expect(core.getState().lastFunctionalProof).toBeNull()
  })

  it('reconnect after operational run marks evidence stale', () => {
    const core = new SystemHealthCore()
    for (const event of happyPathEvents()) core.sink.record(event)
    expect(core.getState().status).toBe('OPERATIONAL')

    core.invalidate()

    const state = core.getState()
    expect(state.stale).toBe(true)
    expect(state.status).toBe('UNKNOWN')
    expect(state.lastFunctionalProof).not.toBeNull()
  })

  it('OPERATIONAL returns after a new functional operation following reconnect', () => {
    const core = new SystemHealthCore()
    for (const event of happyPathEvents()) core.sink.record(event)
    core.invalidate()
    expect(core.getState().stale).toBe(true)

    const secondId = 'req-00000000-0000-4000-8000-000000000099'
    for (const event of happyPathEvents(secondId)) core.sink.record(event)

    const state = core.getState()
    expect(state.stale).toBe(false)
    expect(state.status).toBe('OPERATIONAL')
    expect(state.lastFunctionalProof?.traceId).toBe(secondId)
  })

  it('local session events (sessionId=local) are ignored', () => {
    const core = new SystemHealthCore()
    const localEvent = makeEvent({ stage: 'mcp-response-sent', status: 'success', sessionId: 'local' })
    core.sink.record(localEvent)
    expect(core.getState().status).toBe('UNKNOWN')
    expect(core.getState().lastFunctionalProof).toBeNull()
  })
})

// ─── Diagnostic Accuracy Harness ─────────────────────────────────────────

describe('Diagnostic Accuracy Harness — semantic fault localization audit', () => {
  const ts = '2026-09-19T20:00:00.000Z'
  const sessionId = 'sess-00000000-0000-4000-8000-000000000003'
  const requestId = 'req-00000000-0000-4000-8000-000000000003'
  const base = { requestId, sessionId, method: 'tools/call', tool: 'discover_repository', timestamp: ts }

  it('1. Access assertion invalid → Access Assertion FAILED, lastSuccessfulStage=Remote Request', () => {
    const events: CodeScopeTraceEvent[] = [
      { ...base, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...base, stage: 'access-assertion-validated', durationMs: 31, status: 'error', error: 'ACCESS_ASSERTION_INVALID' },
    ]
    const trace = buildDiagnosticTrace(events)!
    assertFaultLocalization(trace, {
      lastSuccessfulStage: 'Remote Request',
      firstFailedStage: 'Access Assertion',
      reasonCode: 'ACCESS_ASSERTION_INVALID',
      blockedStages: downstreamBlocked('Access Assertion'),
    })
  })

  it('2. Access configuration error → Access Assertion FAILED, lastSuccessfulStage=Remote Request', () => {
    const events: CodeScopeTraceEvent[] = [
      { ...base, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...base, stage: 'access-assertion-validated', durationMs: 31, status: 'error', error: 'ACCESS_CONFIGURATION_ERROR' },
    ]
    const trace = buildDiagnosticTrace(events)!
    assertFaultLocalization(trace, {
      lastSuccessfulStage: 'Remote Request',
      firstFailedStage: 'Access Assertion',
      reasonCode: 'ACCESS_CONFIGURATION_ERROR',
      blockedStages: downstreamBlocked('Access Assertion'),
    })
  })

  it('3. Identity not linked → Identity Resolution FAILED, lastSuccessfulStage=Access Assertion', () => {
    const events: CodeScopeTraceEvent[] = [
      { ...base, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...base, stage: 'access-assertion-validated', durationMs: 31, status: 'success' },
      { ...base, stage: 'identity-resolved', durationMs: 40, status: 'error', error: 'IDENTITY_NOT_LINKED' },
    ]
    const trace = buildDiagnosticTrace(events)!
    assertFaultLocalization(trace, {
      lastSuccessfulStage: 'Access Assertion',
      firstFailedStage: 'Identity Resolution',
      reasonCode: 'IDENTITY_NOT_LINKED',
      blockedStages: downstreamBlocked('Identity Resolution'),
    })
  })

  it('4. Installation selection failure (offline) → Installation Routing FAILED, lastSuccessfulStage=Identity Resolution', () => {
    const events: CodeScopeTraceEvent[] = [
      { ...base, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...base, stage: 'access-assertion-validated', durationMs: 31, status: 'success' },
      { ...base, stage: 'identity-resolved', durationMs: 40, status: 'success' },
      { ...base, stage: 'installation-routed', durationMs: 50, status: 'error', error: 'INSTALLATION_OFFLINE' },
    ]
    const trace = buildDiagnosticTrace(events)!
    assertFaultLocalization(trace, {
      lastSuccessfulStage: 'Identity Resolution',
      firstFailedStage: 'Installation Routing',
      reasonCode: 'INSTALLATION_OFFLINE',
      blockedStages: downstreamBlocked('Installation Routing'),
    })
  })

  it('5. Installation ambiguous → Installation Routing FAILED, lastSuccessfulStage=Identity Resolution', () => {
    const events: CodeScopeTraceEvent[] = [
      { ...base, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...base, stage: 'access-assertion-validated', durationMs: 31, status: 'success' },
      { ...base, stage: 'identity-resolved', durationMs: 40, status: 'success' },
      { ...base, stage: 'installation-routed', durationMs: 50, status: 'error', error: 'INSTALLATION_AMBIGUOUS' },
    ]
    const trace = buildDiagnosticTrace(events)!
    assertFaultLocalization(trace, {
      lastSuccessfulStage: 'Identity Resolution',
      firstFailedStage: 'Installation Routing',
      reasonCode: 'INSTALLATION_AMBIGUOUS',
      blockedStages: downstreamBlocked('Installation Routing'),
    })
  })

  it('6. Installation routed, but Relay Outbound fails → Relay Outbound FAILED, lastSuccessfulStage=Installation Routing', () => {
    const events: CodeScopeTraceEvent[] = [
      { ...base, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...base, stage: 'access-assertion-validated', durationMs: 31, status: 'success' },
      { ...base, stage: 'identity-resolved', durationMs: 40, status: 'success' },
      { ...base, stage: 'installation-routed', durationMs: 50, status: 'success' },
      { ...base, stage: 'relay-request-sent', durationMs: 60, status: 'error', error: 'RELAY_DISCONNECTED' },
    ]
    const trace = buildDiagnosticTrace(events)!
    assertFaultLocalization(trace, {
      lastSuccessfulStage: 'Installation Routing',
      firstFailedStage: 'Relay Outbound',
      reasonCode: 'RELAY_DISCONNECTED',
      blockedStages: downstreamBlocked('Relay Outbound'),
    })
  })

  it('7. Desktop request parsing/connection fails → Desktop Request FAILED, lastSuccessfulStage=Relay Outbound', () => {
    const events: CodeScopeTraceEvent[] = [
      { ...base, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...base, stage: 'access-assertion-validated', durationMs: 31, status: 'success' },
      { ...base, stage: 'identity-resolved', durationMs: 40, status: 'success' },
      { ...base, stage: 'installation-routed', durationMs: 50, status: 'success' },
      { ...base, stage: 'relay-request-sent', durationMs: 60, status: 'started' },
      { ...base, stage: 'desktop-request-received', durationMs: 65, status: 'error', error: 'INVALID_MESSAGE' },
    ]
    const trace = buildDiagnosticTrace(events)!
    assertFaultLocalization(trace, {
      lastSuccessfulStage: 'Relay Outbound',
      firstFailedStage: 'Desktop Request',
      reasonCode: 'INVALID_MESSAGE',
      blockedStages: downstreamBlocked('Desktop Request'),
    })
  })

  it('8. Local MCP server unavailable → MCP Request FAILED, lastSuccessfulStage=Desktop Request', () => {
    const events: CodeScopeTraceEvent[] = [
      { ...base, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...base, stage: 'access-assertion-validated', durationMs: 31, status: 'success' },
      { ...base, stage: 'identity-resolved', durationMs: 40, status: 'success' },
      { ...base, stage: 'installation-routed', durationMs: 50, status: 'success' },
      { ...base, stage: 'relay-request-sent', durationMs: 60, status: 'started' },
      { ...base, stage: 'desktop-request-received', durationMs: 65, status: 'started' },
      { ...base, stage: 'bridge-forward-started', durationMs: 70, status: 'error', error: 'LOCAL_MCP_UNAVAILABLE' },
    ]
    const trace = buildDiagnosticTrace(events)!
    assertFaultLocalization(trace, {
      lastSuccessfulStage: 'Desktop Request',
      firstFailedStage: 'MCP Request',
      reasonCode: 'LOCAL_MCP_UNAVAILABLE',
      blockedStages: downstreamBlocked('MCP Request'),
    })
  })

  it('9. CodeScope tool returns error → CodeScope Execution FAILED, lastSuccessfulStage=MCP Request', () => {
    const events: CodeScopeTraceEvent[] = [
      { ...base, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...base, stage: 'access-assertion-validated', durationMs: 31, status: 'success' },
      { ...base, stage: 'identity-resolved', durationMs: 40, status: 'success' },
      { ...base, stage: 'installation-routed', durationMs: 50, status: 'success' },
      { ...base, stage: 'relay-request-sent', durationMs: 60, status: 'started' },
      { ...base, stage: 'desktop-request-received', durationMs: 65, status: 'started' },
      { ...base, stage: 'mcp-request-started', durationMs: 70, status: 'started' },
      { ...base, stage: 'codescope-request-started', durationMs: 75, status: 'started' },
      { ...base, stage: 'codescope-response-produced', durationMs: 120, status: 'error', error: 'ELEMENT_NOT_FOUND' },
    ]
    const trace = buildDiagnosticTrace(events)!
    assertFaultLocalization(trace, {
      lastSuccessfulStage: 'MCP Request',
      firstFailedStage: 'CodeScope Execution',
      reasonCode: 'ELEMENT_NOT_FOUND',
      blockedStages: downstreamBlocked('CodeScope Execution'),
    })
  })

  it('10. Relay return timeout → Relay Inbound FAILED, lastSuccessfulStage=MCP Response', () => {
    const events: CodeScopeTraceEvent[] = [
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
    const trace = buildDiagnosticTrace(events)!
    assertFaultLocalization(trace, {
      lastSuccessfulStage: 'MCP Response',
      firstFailedStage: 'Relay Inbound',
      reasonCode: 'REQUEST_TIMEOUT',
      blockedStages: downstreamBlocked('Relay Inbound'),
    })
  })

  it('11. Gateway response processing fails → Gateway Response FAILED, lastSuccessfulStage=Relay Inbound', () => {
    const events: CodeScopeTraceEvent[] = [
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
      { ...base, stage: 'desktop-relay-response-sent', durationMs: 140, status: 'success' },
      { ...base, stage: 'relay-response-forwarded', durationMs: 145, status: 'success' },
      { ...base, stage: 'gateway-relay-response-received', durationMs: 200, status: 'error', error: 'GATEWAY_ERROR' },
    ]
    const trace = buildDiagnosticTrace(events)!
    assertFaultLocalization(trace, {
      lastSuccessfulStage: 'Relay Inbound',
      firstFailedStage: 'Gateway Response',
      reasonCode: 'GATEWAY_ERROR',
      blockedStages: downstreamBlocked('Gateway Response'),
    })
  })

  it('12. Client response HTTP return fails → Client Response FAILED, lastSuccessfulStage=Gateway Response', () => {
    const events: CodeScopeTraceEvent[] = [
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
      { ...base, stage: 'desktop-relay-response-sent', durationMs: 140, status: 'success' },
      { ...base, stage: 'relay-response-forwarded', durationMs: 145, status: 'success' },
      { ...base, stage: 'gateway-relay-response-received', durationMs: 200, status: 'success' },
      { ...base, stage: 'gateway-response-produced', durationMs: 210, status: 'success' },
      { ...base, stage: 'http-response-returned', durationMs: 220, status: 'error', error: 'HTTP_RETURN_FAILED' },
    ]
    const trace = buildDiagnosticTrace(events)!
    assertFaultLocalization(trace, {
      lastSuccessfulStage: 'Gateway Response',
      firstFailedStage: 'Client Response',
      reasonCode: 'HTTP_RETURN_FAILED',
      blockedStages: downstreamBlocked('Client Response'),
    })
  })

  it('mcp-response-sent alone is NOT a functional proof — regression for original timeout incident', () => {
    const core = new SystemHealthCore()
    const requestId = 'req-00000000-0000-4000-8000-000000000007'
    const sessionId = 'sess-00000000-0000-4000-8000-000000000007'
    const base = { requestId, sessionId, method: 'tools/call', tool: 'discover_repository', timestamp: ts }

    // Exactly the scenario from the original incident: mcp-response-sent appears but relay never delivers
    const events: CodeScopeTraceEvent[] = [
      { ...base, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...base, stage: 'access-assertion-validated', durationMs: 31, status: 'success' },
      { ...base, stage: 'identity-resolved', durationMs: 40, status: 'success' },
      { ...base, stage: 'installation-routed', durationMs: 50, status: 'success' },
      { ...base, stage: 'relay-request-sent', durationMs: 156, status: 'started' },
      { ...base, stage: 'mcp-request-started', durationMs: 10, status: 'started' },
      { ...base, stage: 'codescope-response-produced', durationMs: 200, status: 'success' },
      { ...base, stage: 'mcp-response-produced', durationMs: 210, status: 'success' },
      { ...base, stage: 'mcp-response-sent', durationMs: 215, status: 'success' },
      // No relay-response-forwarded, no gateway-response-delivered — the relay timed out
      { ...base, stage: 'relay-response-forwarded', durationMs: 25_000, status: 'error', error: 'REQUEST_TIMEOUT' },
    ]
    for (const event of events) core.sink.record(event)

    const state = core.getState()
    expect(state.status).not.toBe('OPERATIONAL')
    expect(state.lastFunctionalProof).toBeNull()
    expect(state.lastFailure).not.toBeNull()
    expect(state.lastFailure?.firstFailedBoundary).toBe('Relay Inbound')
    expect(state.lastFailure?.reasonCode).toBe('REQUEST_TIMEOUT')
    expect(state.lastFailure?.lastSuccessfulStage).toBe('MCP Response')
  })

  it('DEGRADED is set in SystemHealthCore when trace fails', () => {
    const core = new SystemHealthCore()
    const events: CodeScopeTraceEvent[] = [
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
      { ...base, stage: 'relay-response-forwarded', durationMs: 140, status: 'error', error: 'REQUEST_TIMEOUT' },
    ]
    for (const event of events) core.sink.record(event)
    const state = core.getState()
    expect(state.status).toBe('DEGRADED')
    expect(state.lastFailure).not.toBeNull()
    expect(state.lastFailure?.firstFailedBoundary).toBe('Relay Inbound')
    expect(state.lastFailure?.reasonCode).toBe('REQUEST_TIMEOUT')
    expect(state.lastFailure?.lastSuccessfulStage).toBe('MCP Response')
  })

  it('reconnect marks evidence stale — OPERATIONAL requires a new proof', () => {
    const core = new SystemHealthCore()
    for (const event of happyPathEvents()) core.sink.record(event)
    expect(core.getState().status).toBe('OPERATIONAL')
    core.invalidate()

    // After reconnect, without a new operation, status is UNKNOWN (not OPERATIONAL)
    expect(core.getState().status).toBe('UNKNOWN')
    expect(core.getState().stale).toBe(true)
  })
})

// ─── buildDiagnosticTrace unit tests ─────────────────────────────────────

describe('buildDiagnosticTrace', () => {
  it('returns null for empty events', () => {
    expect(buildDiagnosticTrace([])).toBeNull()
  })

  it('all 12 canonical stages appear in the result', () => {
    const trace = buildDiagnosticTrace(happyPathEvents())
    expect(trace).not.toBeNull()
    expect(trace!.stages).toHaveLength(12)
    for (const stage of CANONICAL_PIPELINE) {
      expect(trace!.stages.find((s) => s.stage === stage)).toBeDefined()
    }
  })

  it('successful happy path has no failed stages and no firstFailedBoundary', () => {
    const trace = buildDiagnosticTrace(happyPathEvents())!
    expect(trace.success).toBe(true)
    expect(trace.firstFailedBoundary).toBeNull()
    expect(trace.reasonCode).toBeNull()
    for (const s of trace.stages) {
      expect(s.status).not.toBe('FAILED')
      expect(s.status).not.toBe('BLOCKED')
    }
  })

  it('only stages after the first failed stage are BLOCKED, never propagating FAILED downstream', () => {
    const events = [
      makeEvent({ stage: 'relay-request-sent', status: 'started', durationMs: 0 }),
      makeEvent({ stage: 'desktop-request-received', status: 'started', durationMs: 10 }),
      makeEvent({ stage: 'mcp-request-started', status: 'started', durationMs: 20 }),
      makeEvent({ stage: 'relay-response-forwarded', status: 'error', error: 'REQUEST_TIMEOUT', durationMs: 25_000 }),
    ]
    const trace = buildDiagnosticTrace(events)!
    const relayInbound = trace.stages.find((s) => s.stage === 'Relay Inbound')
    expect(relayInbound?.status).toBe('FAILED')
    const gatewayResponse = trace.stages.find((s) => s.stage === 'Gateway Response')
    expect(gatewayResponse?.status).toBe('BLOCKED')
    const desktopRequest = trace.stages.find((s) => s.stage === 'Desktop Request')
    expect(desktopRequest?.status).toBe('OPERATIONAL')
  })
})
