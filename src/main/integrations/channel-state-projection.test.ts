import { describe, expect, it } from 'vitest'
import type { ConnectionState } from '../../shared/types/connection-types'
import type { McpLifecycleState } from '../mcp/mcp-lifecycle'
import { ChannelStateProjection } from './channel-state-projection'
import { ChannelActivityMonitor } from '../mcp/channel-activity-monitor'
import type { ChannelFunctionalHealth } from '../../shared/types/channel-types'

function fixture() {
  const listeners = new Set<() => void>()
  const onChanged = (listener: (...args: any[]) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  let remote: ConnectionState = { remoteAccessEnabled: true, transportKind: 'relay', status: 'CONNECTED', transport: 'relay', projectId: 'A', externalEndpoint: 'secret-endpoint', localEndpoint: 'local-secret', connectedAt: '2026-09-17T20:00:00.000Z' }
  let mcp: McpLifecycleState = { status: 'RUNNING', available: true, projectId: 'A', endpoint: 'local-secret' }
  let project: { id: string; name: string; path: string } | null = { id: 'A', name: 'project-a', path: '/private-path' }
  let configured = true
  let health: ChannelFunctionalHealth = { status: 'UNKNOWN', lastSuccessfulToolCall: null, lastSuccessfulAt: null, lastFailedToolCall: null, lastFailedAt: null, lastFailureStage: null, lastError: null, lastStageLatencyMs: null, lastDeadlineRemainingMs: null }
  const activity = new ChannelActivityMonitor()
  const projection = new ChannelStateProjection({ getState: () => remote, onChanged }, { getState: () => ({ revision: 1, project }), onChanged }, { getState: () => mcp, onChanged, getActivityState: () => activity.getState(), onActivityChanged: listener => activity.onChanged(listener) }, () => configured, { onChanged }, { getState: () => health, onChanged })
  return { projection, activity, listeners, remote: (value: Partial<ConnectionState>) => { remote = { ...remote, ...value } as ConnectionState }, mcp: (value: McpLifecycleState) => { mcp = value }, project: (value: typeof project) => { project = value }, configured: (value: boolean) => { configured = value }, health: (value: Partial<ChannelFunctionalHealth>) => { health = { ...health, ...value } }, emit: () => { for (const listener of listeners) listener() } }
}

describe('Channel local state', () => {
  it.each<[string, (f: ReturnType<typeof fixture>) => void]>([
    ['DISABLED', f => { f.remote({ remoteAccessEnabled: false }); f.mcp({ status: 'STOPPED', available: false }) }],
    ['SETUP_REQUIRED', f => { f.configured(false); f.mcp({ status: 'STOPPED', available: false }) }],
    ['WAITING_FOR_PROJECT', f => { f.project(null); f.mcp({ status: 'STOPPED', available: false }) }],
    ['CONNECTING', f => f.mcp({ status: 'STARTING', available: false })],
    ['CONNECTING', f => f.remote({ status: 'CONNECTING' })],
    ['READY', () => {}],
    ['OFFLINE', f => f.remote({ status: 'ERROR', error: 'RELAY_CLOSED' })],
    ['ERROR', f => f.remote({ status: 'ERROR', error: 'INVALID_CREDENTIAL' })],
    ['ERROR', f => f.mcp({ status: 'ERROR', available: false, error: 'MCP_SERVER_FAILED' })],
    ['ERROR', f => f.remote({ transportKind: 'ngrok' })],
    ['CONNECTING', f => f.project({ id: 'B', name: 'project-b', path: '/b' })]
  ])('projects %s without calling MCP', (availability, arrange) => {
    const f = fixture(); arrange(f)
    expect(f.projection.getState().availability).toBe(availability)
    f.projection.dispose(); expect(f.listeners.size).toBe(0)
  })

  it.each(['UNKNOWN', 'OPERATIONAL', 'DEGRADED'] as const)('keeps READY independent of %s functional health', status => {
    const f = fixture()
    f.health({ status, lastSuccessfulAt: '2026-09-17T20:00:01Z', lastFailedAt: '2026-09-17T20:00:01Z' })
    expect(f.projection.getState()).toMatchObject({ availability: 'READY', functionalHealth: { status } })
    f.projection.dispose()
  })

  it('publishes only changes and retains runtime counters across projects', () => {
    const f = fixture(), states: ReturnType<typeof f.projection.getState>[] = []
    f.projection.onChanged(state => states.push(state))
    f.emit(); expect(states).toHaveLength(0)
    const event = { timestamp: new Date().toISOString(), requestId: 'request-a', sessionId: 'session', method: 'tools/call', tool: 'read_code', channelCapability: 'code-navigation', durationMs: 12 }
    f.activity.record({ ...event, stage: 'channel-request-started', status: 'started' })
    expect(states.at(-1)?.activity.activeRequests).toBe(1)
    f.activity.record({ ...event, stage: 'channel-request-completed', status: 'success' })
    expect(states.at(-1)?.activity).toMatchObject({ activeRequests: 0, peakConcurrentRequests: 1, totalRequests: 1, succeededRequests: 1 })
    f.project({ id: 'B', name: 'project-b', path: '/b' }); f.emit()
    expect(states.at(-1)).toMatchObject({ availability: 'CONNECTING', activeProject: { id: 'B' }, activity: { totalRequests: 1 } })
    expect(states.map(s => s.revision)).toEqual([2, 3, 4])
    f.emit(); expect(states).toHaveLength(3)
    f.projection.dispose()
  })

  it('sanitizes errors and hides credentials, endpoints and paths', () => {
    const f = fixture()
    f.remote({ status: 'ERROR', error: 'Bearer secret-token' as never })
    f.health({ lastError: 'secret-token' })
    expect(f.projection.getState().lastError).toBe('CHANNEL_ERROR')
    for (const forbidden of ['secret-token', 'secret-endpoint', '/private-path', 'local-secret']) expect(JSON.stringify(f.projection.getState())).not.toContain(forbidden)
    f.projection.dispose()
  })

  it('preserves observed functional health independently of infrastructure availability', () => {
    const f = fixture()
    f.health({ status: 'DEGRADED', lastFailedAt: '2026-09-17T20:01:00Z' })
    f.remote({ remoteAccessEnabled: false })
    expect(f.projection.getState()).toMatchObject({ availability: 'DISABLED', functionalHealth: { status: 'DEGRADED' } })
    f.remote({ remoteAccessEnabled: true, status: 'ERROR', error: 'RELAY_CLOSED' })
    expect(f.projection.getState()).toMatchObject({ availability: 'OFFLINE', functionalHealth: { status: 'DEGRADED' } })
    f.projection.dispose()
  })
})
