import { describe, expect, it } from 'vitest'
import { ChannelActivityMonitor } from './channel-activity-monitor'
import type { ChannelTraceEvent } from '../../shared/types/channel-types'

function event(requestId: string, overrides: Partial<ChannelTraceEvent> = {}): ChannelTraceEvent {
  return {
    requestId, timestamp: new Date().toISOString(), sessionId: 'local', method: 'tools/call',
    tool: 'read_code', channelCapability: 'Code Navigation', stage: 'channel-request-started',
    status: 'started', durationMs: 0, ...overrides
  }
}

describe('Channel activity', () => {
  it('starts empty and publishes each real change while isolating observer failures', () => {
    const monitor = new ChannelActivityMonitor()
    expect(monitor.getState()).toMatchObject({ activeRequests: 0, peakConcurrentRequests: 0, totalRequests: 0, byCapability: {}, latency: { completedRequests: 0, maxDurationMs: null } })
    let changes = 0
    const unsubscribe = monitor.onChanged(() => { changes++ })
    monitor.onChanged(() => { throw new Error('observer failed') })
    monitor.record(event('one')); monitor.record(event('one'))
    monitor.record(event('one', { stage: 'channel-request-completed', status: 'success' }))
    monitor.record(event('one', { stage: 'channel-request-completed', status: 'error' }))
    expect(changes).toBe(2)
    unsubscribe(); monitor.record(event('two'))
    expect(changes).toBe(2)
  })
  it('correlates concurrent calls, deduplicates stages and terminalizes timeout once', () => {
    const monitor = new ChannelActivityMonitor()
    for (const id of ['a', 'b', 'c']) {
      monitor.record(event(id))
      monitor.record(event(id))
      monitor.record(event(id, { stage: 'codescope-handler-started' }))
    }
    expect(monitor.getState()).toMatchObject({ activeRequests: 3, peakConcurrentRequests: 3, totalRequests: 3 })
    const done = (id: string, status: 'success' | 'error', error?: string) => monitor.record(event(id, { stage: 'channel-request-completed', status, error, durationMs: 10 }))
    done('a', 'error', 'REQUEST_TIMEOUT')
    done('a', 'success')
    monitor.record(event('a'))
    expect(monitor.getState()).toMatchObject({ activeRequests: 2, timedOutRequests: 1, totalRequests: 3 })
    done('b', 'success')
    done('c', 'error', 'INVALID_ARGUMENT')
    expect(monitor.getState()).toMatchObject({
      activeRequests: 0, peakConcurrentRequests: 3, totalRequests: 3,
      succeededRequests: 1, failedRequests: 1, timedOutRequests: 1,
      latency: { completedRequests: 3, totalDurationMs: 30, lastDurationMs: 10, maxDurationMs: 10 },
      byTool: { read_code: { totalRequests: 3, timedOutRequests: 1 } },
      byCapability: { 'Code Navigation': { totalRequests: 3, succeededRequests: 1 } }
    })
    monitor.record(event('unknown-terminal', { stage: 'channel-request-completed', status: 'error' }))
    expect(monitor.getState().activeRequests).toBe(0)
    const snapshot = monitor.getState()
    snapshot.byTool.read_code.totalRequests = 999
    expect(monitor.getState().byTool.read_code.totalRequests).toBe(3)
  })

  it('ignores MCP control calls and readiness capability, attributes independent tools', () => {
    const monitor = new ChannelActivityMonitor()
    for (const method of ['initialize', 'tools/list', 'ping', 'notifications/initialized']) monitor.record(event(method, { method }))
    monitor.record(event('a', { tool: 'get_git_state', channelCapability: 'Git Operations', capability: 'READINESS' }))
    monitor.record(event('b', { tool: 'get_artifact', channelCapability: 'Continuum' }))
    monitor.record(event('c', { tool: 'unknown', channelCapability: undefined }))
    expect(monitor.getState()).toMatchObject({
      totalRequests: 3, activeRequests: 3,
      byTool: { get_git_state: { totalRequests: 1 }, get_artifact: { totalRequests: 1 }, unknown: { totalRequests: 1 } },
      byCapability: { 'Git Operations': { totalRequests: 1 }, Continuum: { totalRequests: 1 } }
    })
    expect(monitor.getState().byCapability).not.toHaveProperty('READINESS')
  })

  it('bounds completed identities and label cardinality without limiting active calls', () => {
    const monitor = new ChannelActivityMonitor()
    for (let i = 0; i < 1000; i++) {
      monitor.record(event(String(i), { tool: `tool-${i}` }))
      monitor.record(event(String(i), { stage: 'channel-request-completed', status: 'success' }))
    }
    expect(monitor.getState().totalRequests).toBe(1000)
    expect(Object.keys(monitor.getState().byTool)).toHaveLength(129)
    expect((monitor as unknown as { completed: Set<string> }).completed.size).toBe(256)
    for (let i = 0; i < 300; i++) monitor.record(event(`active-${i}`))
    expect(monitor.getState().activeRequests).toBe(300)
    monitor.record(event('prototype', { tool: '__proto__', channelCapability: 'constructor' }))
    expect(monitor.getState().activeRequests).toBe(301)
  })
})
