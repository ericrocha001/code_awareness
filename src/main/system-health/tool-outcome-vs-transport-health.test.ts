import { describe, expect, it } from 'vitest'
import type { CodeScopeTraceEvent } from '../mcp/code-scope-health'
import { SystemHealthCore } from './system-health-core'
import { buildDiagnosticTrace } from './diagnostic-trace'

function ts(): string {
  return new Date().toISOString()
}

function base(requestId: string, sessionId: string) {
  return { requestId, sessionId, method: 'tools/call', tool: 'discover_repository', timestamp: ts() }
}

// Cenário A — erro funcional entregue com sucesso operacional
// Representa o caminho real: discover_repository retorna UNKNOWN_DIRECTORY,
// mas todo o transporte funcionou corretamente.
describe('Cenário A — erro funcional entregue com sucesso operacional', () => {
  it('A1: trace não tem firstFailedBoundary quando todos os eventos de transporte são success', () => {
    const b = base('req-A1', 'sess-A1')
    const events: CodeScopeTraceEvent[] = [
      { ...b, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...b, stage: 'access-assertion-validated', durationMs: 30, status: 'success' },
      { ...b, stage: 'identity-resolved', durationMs: 40, status: 'success' },
      { ...b, stage: 'installation-routed', durationMs: 50, status: 'success' },
      { ...b, stage: 'relay-request-sent', durationMs: 60, status: 'started' },
      { ...b, stage: 'desktop-request-received', durationMs: 65, status: 'started' },
      { ...b, stage: 'mcp-request-started', durationMs: 70, status: 'started' },
      { ...b, stage: 'codescope-request-started', durationMs: 75, status: 'started' },
      { ...b, stage: 'codescope-response-produced', durationMs: 120, status: 'success' },
      { ...b, stage: 'codescope-handler-completed', durationMs: 121, status: 'success' },
      { ...b, stage: 'mcp-response-produced', durationMs: 130, status: 'success' },
      { ...b, stage: 'mcp-response-sent', durationMs: 135, status: 'success' },
      { ...b, stage: 'desktop-relay-response-sent', durationMs: 140, status: 'success' },
      { ...b, stage: 'relay-response-forwarded', durationMs: 145, status: 'success' },
      { ...b, stage: 'gateway-relay-response-received', durationMs: 200, status: 'success' },
      { ...b, stage: 'gateway-response-produced', durationMs: 210, status: 'success' },
      { ...b, stage: 'http-response-returned', durationMs: 220, status: 'success' },
      { ...b, stage: 'gateway-response-delivered', durationMs: 230, status: 'success' },
    ]
    const trace = buildDiagnosticTrace(events)!
    expect(trace.firstFailedBoundary).toBeNull()
    expect(trace.reasonCode).toBeNull()
    expect(trace.success).toBe(true)
    for (const s of trace.stages) {
      expect(s.status).not.toBe('FAILED')
      expect(s.status).not.toBe('BLOCKED')
    }
  })

  it('A2: SystemHealthCore não fica DEGRADED quando todos eventos de transporte são success', () => {
    const core = new SystemHealthCore()
    const b = base('req-A2', 'sess-A2')
    const events: CodeScopeTraceEvent[] = [
      { ...b, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...b, stage: 'access-assertion-validated', durationMs: 30, status: 'success' },
      { ...b, stage: 'identity-resolved', durationMs: 40, status: 'success' },
      { ...b, stage: 'installation-routed', durationMs: 50, status: 'success' },
      { ...b, stage: 'relay-request-sent', durationMs: 60, status: 'started' },
      { ...b, stage: 'desktop-request-received', durationMs: 65, status: 'started' },
      { ...b, stage: 'mcp-request-started', durationMs: 70, status: 'started' },
      { ...b, stage: 'codescope-request-started', durationMs: 75, status: 'started' },
      { ...b, stage: 'codescope-response-produced', durationMs: 120, status: 'success' },
      { ...b, stage: 'codescope-handler-completed', durationMs: 121, status: 'success' },
      { ...b, stage: 'mcp-response-produced', durationMs: 130, status: 'success' },
      { ...b, stage: 'mcp-response-sent', durationMs: 135, status: 'success' },
      { ...b, stage: 'desktop-relay-response-sent', durationMs: 140, status: 'success' },
      { ...b, stage: 'relay-response-forwarded', durationMs: 145, status: 'success' },
      { ...b, stage: 'gateway-relay-response-received', durationMs: 200, status: 'success' },
      { ...b, stage: 'gateway-response-produced', durationMs: 210, status: 'success' },
      { ...b, stage: 'http-response-returned', durationMs: 220, status: 'success' },
      { ...b, stage: 'gateway-response-delivered', durationMs: 230, status: 'success' },
    ]
    for (const event of events) core.sink.record(event)
    const state = core.getState()
    expect(state.status).toBe('OPERATIONAL')
    expect(state.lastFailure).toBeNull()
    expect(state.lastFunctionalProof).not.toBeNull()
  })

  it('A3: nenhum estágio Gateway Response ou Client Response fica FAILED quando ACKs chegam com status success', () => {
    const b = base('req-A3', 'sess-A3')
    const events: CodeScopeTraceEvent[] = [
      { ...b, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...b, stage: 'access-assertion-validated', durationMs: 30, status: 'success' },
      { ...b, stage: 'identity-resolved', durationMs: 40, status: 'success' },
      { ...b, stage: 'installation-routed', durationMs: 50, status: 'success' },
      { ...b, stage: 'relay-request-sent', durationMs: 60, status: 'started' },
      { ...b, stage: 'desktop-request-received', durationMs: 65, status: 'started' },
      { ...b, stage: 'mcp-request-started', durationMs: 70, status: 'started' },
      { ...b, stage: 'codescope-request-started', durationMs: 75, status: 'started' },
      { ...b, stage: 'codescope-response-produced', durationMs: 120, status: 'success' },
      { ...b, stage: 'mcp-response-produced', durationMs: 130, status: 'success' },
      { ...b, stage: 'mcp-response-sent', durationMs: 135, status: 'success' },
      { ...b, stage: 'desktop-relay-response-sent', durationMs: 140, status: 'success' },
      { ...b, stage: 'relay-response-forwarded', durationMs: 145, status: 'success' },
      { ...b, stage: 'gateway-relay-response-received', durationMs: 200, status: 'success' },
      { ...b, stage: 'relay-response-delivered', durationMs: 210, status: 'success' },
      { ...b, stage: 'gateway-response-delivered', durationMs: 220, status: 'success' },
    ]
    const trace = buildDiagnosticTrace(events)!
    const gatewayResponse = trace.stages.find((s) => s.stage === 'Gateway Response')
    const clientResponse = trace.stages.find((s) => s.stage === 'Client Response')
    expect(gatewayResponse?.status).not.toBe('FAILED')
    expect(clientResponse?.status).not.toBe('FAILED')
    expect(trace.firstFailedBoundary).toBeNull()
  })
})

// Cenário B — ACKs recebidos com isError=true no payload MCP
// relay-response-delivered e gateway-response-delivered são registrados como success
// porque representam entrega de transporte, não resultado funcional.
describe('Cenário B — ACKs recebidos independem do resultado funcional', () => {
  it('B1: relay-response-delivered com status success representa transporte bem-sucedido', () => {
    const b = base('req-B1', 'sess-B1')
    const events: CodeScopeTraceEvent[] = [
      { ...b, stage: 'desktop-request-received', durationMs: 0, status: 'started' },
      { ...b, stage: 'mcp-request-started', durationMs: 5, status: 'started' },
      { ...b, stage: 'codescope-response-produced', durationMs: 50, status: 'success' },
      { ...b, stage: 'mcp-response-produced', durationMs: 60, status: 'success' },
      { ...b, stage: 'mcp-response-sent', durationMs: 65, status: 'success' },
      { ...b, stage: 'desktop-relay-response-sent', durationMs: 70, status: 'success' },
      { ...b, stage: 'relay-response-forwarded', durationMs: 75, status: 'success' },
      { ...b, stage: 'relay-response-delivered', durationMs: 300, status: 'success' },
    ]
    const trace = buildDiagnosticTrace(events)!
    const relayInbound = trace.stages.find((s) => s.stage === 'Relay Inbound')
    const gatewayResponse = trace.stages.find((s) => s.stage === 'Gateway Response')
    expect(relayInbound?.status).not.toBe('FAILED')
    expect(gatewayResponse?.status).not.toBe('FAILED')
    expect(trace.firstFailedBoundary).toBeNull()
  })

  it('B2: gateway-response-delivered com status success representa entrega ao cliente sem falha operacional', () => {
    const b = base('req-B2', 'sess-B2')
    const events: CodeScopeTraceEvent[] = [
      { ...b, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...b, stage: 'access-assertion-validated', durationMs: 30, status: 'success' },
      { ...b, stage: 'identity-resolved', durationMs: 40, status: 'success' },
      { ...b, stage: 'installation-routed', durationMs: 50, status: 'success' },
      { ...b, stage: 'relay-request-sent', durationMs: 60, status: 'started' },
      { ...b, stage: 'desktop-request-received', durationMs: 65, status: 'started' },
      { ...b, stage: 'mcp-request-started', durationMs: 70, status: 'started' },
      { ...b, stage: 'codescope-request-started', durationMs: 75, status: 'started' },
      { ...b, stage: 'codescope-response-produced', durationMs: 120, status: 'success' },
      { ...b, stage: 'mcp-response-produced', durationMs: 130, status: 'success' },
      { ...b, stage: 'mcp-response-sent', durationMs: 135, status: 'success' },
      { ...b, stage: 'desktop-relay-response-sent', durationMs: 140, status: 'success' },
      { ...b, stage: 'relay-response-forwarded', durationMs: 145, status: 'success' },
      { ...b, stage: 'gateway-relay-response-received', durationMs: 200, status: 'success' },
      { ...b, stage: 'gateway-response-produced', durationMs: 210, status: 'success' },
      { ...b, stage: 'http-response-returned', durationMs: 220, status: 'success' },
      { ...b, stage: 'gateway-response-delivered', durationMs: 230, status: 'success' },
    ]
    const core = new SystemHealthCore()
    for (const event of events) core.sink.record(event)
    expect(core.getState().status).toBe('OPERATIONAL')
    expect(core.getState().lastFailure).toBeNull()
  })

  it('B3: alternância entre erro funcional e sucesso não produz DEGRADED persistente', () => {
    const core = new SystemHealthCore()

    const makeFullPath = (id: string): CodeScopeTraceEvent[] => {
      const b = base(id, 'sess-B3')
      return [
        { ...b, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
        { ...b, stage: 'access-assertion-validated', durationMs: 30, status: 'success' },
        { ...b, stage: 'identity-resolved', durationMs: 40, status: 'success' },
        { ...b, stage: 'installation-routed', durationMs: 50, status: 'success' },
        { ...b, stage: 'relay-request-sent', durationMs: 60, status: 'started' },
        { ...b, stage: 'desktop-request-received', durationMs: 65, status: 'started' },
        { ...b, stage: 'mcp-request-started', durationMs: 70, status: 'started' },
        { ...b, stage: 'codescope-request-started', durationMs: 75, status: 'started' },
        { ...b, stage: 'codescope-response-produced', durationMs: 120, status: 'success' },
        { ...b, stage: 'mcp-response-produced', durationMs: 130, status: 'success' },
        { ...b, stage: 'mcp-response-sent', durationMs: 135, status: 'success' },
        { ...b, stage: 'desktop-relay-response-sent', durationMs: 140, status: 'success' },
        { ...b, stage: 'relay-response-forwarded', durationMs: 145, status: 'success' },
        { ...b, stage: 'gateway-relay-response-received', durationMs: 200, status: 'success' },
        { ...b, stage: 'gateway-response-produced', durationMs: 210, status: 'success' },
        { ...b, stage: 'http-response-returned', durationMs: 220, status: 'success' },
        { ...b, stage: 'gateway-response-delivered', durationMs: 230, status: 'success' },
      ]
    }

    // Chamada 1: transporte perfeito (mesmo que payload fosse erro funcional)
    for (const event of makeFullPath('req-B3-a')) core.sink.record(event)
    expect(core.getState().status).toBe('OPERATIONAL')

    // Chamada 2: transporte perfeito novamente
    for (const event of makeFullPath('req-B3-b')) core.sink.record(event)
    expect(core.getState().status).toBe('OPERATIONAL')
    expect(core.getState().lastFailure).toBeNull()
  })
})

// Cenário C — Falha operacional real de socket
describe('Cenário C — falha operacional real continua degradando', () => {
  it('C1: socket fechado antes de enviar resposta → Relay Inbound FAILED, estado DEGRADED', () => {
    const core = new SystemHealthCore()
    const b = base('req-C1', 'sess-C1')
    const events: CodeScopeTraceEvent[] = [
      { ...b, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...b, stage: 'access-assertion-validated', durationMs: 30, status: 'success' },
      { ...b, stage: 'identity-resolved', durationMs: 40, status: 'success' },
      { ...b, stage: 'installation-routed', durationMs: 50, status: 'success' },
      { ...b, stage: 'relay-request-sent', durationMs: 60, status: 'started' },
      { ...b, stage: 'desktop-request-received', durationMs: 65, status: 'started' },
      { ...b, stage: 'mcp-request-started', durationMs: 70, status: 'started' },
      { ...b, stage: 'codescope-request-started', durationMs: 75, status: 'started' },
      { ...b, stage: 'codescope-response-produced', durationMs: 120, status: 'success' },
      { ...b, stage: 'mcp-response-produced', durationMs: 130, status: 'success' },
      { ...b, stage: 'mcp-response-sent', durationMs: 135, status: 'success' },
      { ...b, stage: 'desktop-relay-response-sent', durationMs: 140, status: 'error', error: 'RELAY_CLOSED' },
    ]
    for (const event of events) core.sink.record(event)
    const state = core.getState()
    expect(state.status).toBe('DEGRADED')
    expect(state.lastFailure?.firstFailedBoundary).toBe('Relay Inbound')
    expect(state.lastFailure?.reasonCode).toBe('RELAY_CLOSED')
    expect(state.lastFailure?.lastSuccessfulStage).toBe('MCP Response')
  })

  it('C2: falha de socket não causa regressão — comportamento de reconexão intacto', () => {
    const core = new SystemHealthCore()
    const b = base('req-C2', 'sess-C2')

    const socketFailEvents: CodeScopeTraceEvent[] = [
      { ...b, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...b, stage: 'access-assertion-validated', durationMs: 30, status: 'success' },
      { ...b, stage: 'identity-resolved', durationMs: 40, status: 'success' },
      { ...b, stage: 'installation-routed', durationMs: 50, status: 'success' },
      { ...b, stage: 'relay-request-sent', durationMs: 60, status: 'started' },
      { ...b, stage: 'desktop-request-received', durationMs: 65, status: 'started' },
      { ...b, stage: 'mcp-request-started', durationMs: 70, status: 'started' },
      { ...b, stage: 'codescope-response-produced', durationMs: 120, status: 'success' },
      { ...b, stage: 'mcp-response-produced', durationMs: 130, status: 'success' },
      { ...b, stage: 'mcp-response-sent', durationMs: 135, status: 'success' },
      { ...b, stage: 'desktop-relay-response-sent', durationMs: 140, status: 'error', error: 'RELAY_CLOSED' },
    ]
    for (const event of socketFailEvents) core.sink.record(event)
    expect(core.getState().status).toBe('DEGRADED')

    // Invalidar (simula reconexão)
    core.invalidate()
    expect(core.getState().stale).toBe(true)

    // Nova operação bem-sucedida restaura OPERATIONAL
    const b2 = base('req-C2-recovery', 'sess-C2')
    const recoveryEvents: CodeScopeTraceEvent[] = [
      { ...b2, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...b2, stage: 'access-assertion-validated', durationMs: 30, status: 'success' },
      { ...b2, stage: 'identity-resolved', durationMs: 40, status: 'success' },
      { ...b2, stage: 'installation-routed', durationMs: 50, status: 'success' },
      { ...b2, stage: 'relay-request-sent', durationMs: 60, status: 'started' },
      { ...b2, stage: 'desktop-request-received', durationMs: 65, status: 'started' },
      { ...b2, stage: 'mcp-request-started', durationMs: 70, status: 'started' },
      { ...b2, stage: 'codescope-response-produced', durationMs: 120, status: 'success' },
      { ...b2, stage: 'mcp-response-produced', durationMs: 130, status: 'success' },
      { ...b2, stage: 'mcp-response-sent', durationMs: 135, status: 'success' },
      { ...b2, stage: 'desktop-relay-response-sent', durationMs: 140, status: 'success' },
      { ...b2, stage: 'relay-response-forwarded', durationMs: 145, status: 'success' },
      { ...b2, stage: 'gateway-response-delivered', durationMs: 230, status: 'success' },
    ]
    for (const event of recoveryEvents) core.sink.record(event)
    expect(core.getState().status).toBe('OPERATIONAL')
  })
})

// Cenário D — Timeout real de transporte
describe('Cenário D — timeout real de transporte continua diagnosticável', () => {
  it('D1: ausência de retorno até deadline → REQUEST_TIMEOUT, Relay Inbound FAILED, DEGRADED', () => {
    const core = new SystemHealthCore()
    const b = base('req-D1', 'sess-D1')
    const events: CodeScopeTraceEvent[] = [
      { ...b, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...b, stage: 'access-assertion-validated', durationMs: 30, status: 'success' },
      { ...b, stage: 'identity-resolved', durationMs: 40, status: 'success' },
      { ...b, stage: 'installation-routed', durationMs: 50, status: 'success' },
      { ...b, stage: 'relay-request-sent', durationMs: 60, status: 'started' },
      { ...b, stage: 'desktop-request-received', durationMs: 65, status: 'started' },
      { ...b, stage: 'mcp-request-started', durationMs: 70, status: 'started' },
      { ...b, stage: 'codescope-response-produced', durationMs: 120, status: 'success' },
      { ...b, stage: 'mcp-response-produced', durationMs: 130, status: 'success' },
      { ...b, stage: 'mcp-response-sent', durationMs: 135, status: 'success' },
      { ...b, stage: 'relay-response-forwarded', durationMs: 25_000, status: 'error', error: 'REQUEST_TIMEOUT' },
    ]
    for (const event of events) core.sink.record(event)
    const state = core.getState()
    expect(state.status).toBe('DEGRADED')
    expect(state.lastFailure?.firstFailedBoundary).toBe('Relay Inbound')
    expect(state.lastFailure?.reasonCode).toBe('REQUEST_TIMEOUT')
    expect(state.lastFailure?.lastSuccessfulStage).toBe('MCP Response')
  })

  it('D2: bridge timeout (LOCAL_MCP_UNAVAILABLE) → MCP Request FAILED, DEGRADED', () => {
    const core = new SystemHealthCore()
    const b = base('req-D2', 'sess-D2')
    const events: CodeScopeTraceEvent[] = [
      { ...b, stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { ...b, stage: 'access-assertion-validated', durationMs: 30, status: 'success' },
      { ...b, stage: 'identity-resolved', durationMs: 40, status: 'success' },
      { ...b, stage: 'installation-routed', durationMs: 50, status: 'success' },
      { ...b, stage: 'relay-request-sent', durationMs: 60, status: 'started' },
      { ...b, stage: 'desktop-request-received', durationMs: 65, status: 'started' },
      { ...b, stage: 'bridge-forward-started', durationMs: 25_000, status: 'error', error: 'LOCAL_MCP_UNAVAILABLE' },
    ]
    for (const event of events) core.sink.record(event)
    const state = core.getState()
    expect(state.status).toBe('DEGRADED')
    expect(state.lastFailure?.firstFailedBoundary).toBe('MCP Request')
    expect(state.lastFailure?.reasonCode).toBe('LOCAL_MCP_UNAVAILABLE')
  })
})
