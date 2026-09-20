import { describe, expect, it } from 'vitest'
import type { CodeScopeTraceEvent } from '../mcp/code-scope-health'
import { SystemHealthCore } from './system-health-core'
import type {
  CanonicalStage,
  StageDrilldownProvider,
  StageDrilldownResult
} from '../../shared/types/system-health-types'

function makeEvent(overrides: Partial<CodeScopeTraceEvent> & Pick<CodeScopeTraceEvent, 'stage' | 'status'>): CodeScopeTraceEvent {
  return {
    timestamp: new Date().toISOString(),
    requestId: 'req-drilldown-harness',
    sessionId: 'sess-drilldown-harness',
    method: 'tools/call',
    tool: 'discover_repository',
    durationMs: 0,
    ...overrides
  }
}

describe('System Health — Generic Stage Diagnostic Drilldown Harness', () => {
  it('Core remains independent of MCP concepts and accepts arbitrary stage drilldown providers', () => {
    const dummyProvider: StageDrilldownProvider = {
      canonicalStage: 'Access Assertion' as CanonicalStage,
      evaluate: (events: CodeScopeTraceEvent[], failureReason?: string | null): StageDrilldownResult => {
        return {
          canonicalStage: 'Access Assertion',
          state: 'LOCALIZED',
          precision: 'EXACT',
          lastSuccessfulCheckpoint: 'JWT Present',
          firstFailedCheckpoint: 'Signature Validated',
          firstBlockedCheckpoint: 'Claims Evaluated',
          reasonCode: failureReason ?? 'INVALID_SIGNATURE',
          checkpoints: [
            { name: 'JWT Present', status: 'OPERATIONAL' },
            { name: 'Signature Validated', status: 'FAILED', reasonCode: failureReason ?? 'INVALID_SIGNATURE' },
            { name: 'Claims Evaluated', status: 'BLOCKED' }
          ],
          refinedInvestigationTarget: {
            systemArea: 'Access Key Verification',
            component: 'Key Keystore',
            boundary: 'Public Gateway → Access Verifier',
            responsibility: 'Cryptographic validation of JWT signature against JWKS',
            investigationSeeds: ['infra/gateway/domain/cloudflare-access-assertion-verifier.ts']
          }
        }
      }
    }

    const core = new SystemHealthCore([dummyProvider])
    core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'access-assertion-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'access-assertion-validated', status: 'error', error: 'INVALID_SIGNATURE' }))

    const state = core.getState()
    expect(state.status).toBe('DEGRADED')
    expect(state.lastFailure).not.toBeNull()
    expect(state.lastFailure?.firstFailedBoundary).toBe('Access Assertion')
    expect(state.lastFailure?.drilldown).toBeDefined()
    expect(state.lastFailure?.drilldown?.canonicalStage).toBe('Access Assertion')
    expect(state.lastFailure?.drilldown?.firstFailedCheckpoint).toBe('Signature Validated')
    expect(state.lastFailure?.drilldown?.checkpoints).toHaveLength(3)
  })

  it('drilldown checkpoints are ordered deterministically', () => {
    const core = new SystemHealthCore()
    core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'desktop-request-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'error', error: 'LOCAL_MCP_UNAVAILABLE' }))

    const state = core.getState()
    const drilldown = state.lastFailure?.drilldown
    expect(drilldown).toBeDefined()
    const checkpointNames = drilldown?.checkpoints.map((c) => c.name)
    expect(checkpointNames).toEqual([
      'Local MCP Connection Available',
      'MCP Request Dispatched',
      'MCP Request Received',
      'MCP Handler Started'
    ])
  })

  it('first failed checkpoint is localized and all downstream checkpoints become BLOCKED without duration or reasonCode', () => {
    const core = new SystemHealthCore()
    core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'desktop-request-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'error', error: 'LOCAL_MCP_UNAVAILABLE' }))

    const state = core.getState()
    const drilldown = state.lastFailure?.drilldown
    expect(drilldown?.firstFailedCheckpoint).toBe('Local MCP Connection Available')
    expect(drilldown?.lastSuccessfulCheckpoint).toBeNull()
    expect(drilldown?.firstBlockedCheckpoint).toBe('MCP Request Dispatched')

    const failed = drilldown?.checkpoints.find((c) => c.name === 'Local MCP Connection Available')
    expect(failed?.status).toBe('FAILED')
    expect(failed?.reasonCode).toBe('LOCAL_MCP_UNAVAILABLE')

    const downstream = drilldown?.checkpoints.slice(1) ?? []
    expect(downstream).toHaveLength(3)
    for (const cp of downstream) {
      expect(cp.status).toBe('BLOCKED')
      expect(cp.durationMs).toBeUndefined()
      expect(cp.reasonCode).toBeUndefined()
    }
  })

  it('drilldown belongs to the same trace/request ID as the main failure', () => {
    const traceId = 'req-trace-correlation-unique'
    const core = new SystemHealthCore()
    core.sink.record(makeEvent({ requestId: traceId, stage: 'gateway-request-started', status: 'started' }))
    core.sink.record(makeEvent({ requestId: traceId, stage: 'desktop-request-received', status: 'started' }))
    core.sink.record(makeEvent({ requestId: traceId, stage: 'bridge-forward-started', status: 'error', error: 'LOCAL_MCP_UNAVAILABLE' }))

    const state = core.getState()
    expect(state.lastFailure?.traceId).toBe(traceId)
    expect(state.lastFailure?.drilldown?.canonicalStage).toBe('MCP Request')
  })

  it('multiple providers coexist and only the provider of the actual failed stage is projected', () => {
    const core = new SystemHealthCore()
    // Sequence where MCP Request succeeded, but CodeScope Execution failed
    core.sink.record(makeEvent({ stage: 'gateway-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'desktop-request-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'bridge-forward-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'mcp-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'mcp-request-received', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'codescope-request-started', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'codescope-operation-routed', status: 'started' }))
    core.sink.record(makeEvent({ stage: 'codescope-operation-routed', status: 'error', error: 'INVALID_ARGUMENT' }))

    const state = core.getState()
    expect(state.status).toBe('DEGRADED')
    expect(state.lastFailure?.firstFailedBoundary).toBe('CodeScope Execution')
    // Drilldown MUST be CodeScope Execution, NOT MCP Request
    expect(state.lastFailure?.drilldown).toBeDefined()
    expect(state.lastFailure?.drilldown?.canonicalStage).toBe('CodeScope Execution')
    expect(state.lastFailure?.drilldown?.firstFailedCheckpoint).toBe('Operation Routing')
  })

  it('drilldown of healthy stage does not pollute response on healthy runs', () => {
    const core = new SystemHealthCore()
    // Succeeded run
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

    const state = core.getState()
    expect(state.status).toBe('OPERATIONAL')
    expect(state.lastFailure).toBeNull()
  })
})

