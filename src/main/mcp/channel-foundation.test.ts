import { textContent } from './mcp-test-content'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelMcpAdapter } from './channel-mcp-adapter'
import { McpWorkloadGovernor } from './mcp-workload-governor'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import { createMcpHttpServer } from './mcp-http-server'
import { ChannelActivityMonitor } from './channel-activity-monitor'
import { McpLifecycle } from './mcp-lifecycle'

afterEach(() => vi.useRealTimers())

describe('Channel composition', () => {
  it('terminalizes only the timed out invocation and ignores its late execution', async () => {
    vi.useFakeTimers()
    const releases: Array<(value: []) => void> = []
    const navigation = { readCode: vi.fn(() => new Promise<[]>(resolve => releases.push(resolve))) } as unknown as ProjectContextNavigation
    const adapter = new ChannelMcpAdapter(navigation)
    adapter.setWorkloadGovernor(new McpWorkloadGovernor(1000))
    const a = adapter.callTool('read_code', { targetIds: ['a'] }, { requestId: 'a', deadlineAtMs: Date.now() + 1050 })
    const b = adapter.callTool('read_code', { targetIds: ['b'] }, { requestId: 'b', deadlineAtMs: Date.now() + 1500 })
    expect(adapter.getActivityState()).toMatchObject({ activeRequests: 2, peakConcurrentRequests: 2 })
    await vi.advanceTimersByTimeAsync(50)
    expect(JSON.parse(textContent((await a).content[0])).code).toBe('REQUEST_TIMEOUT')
    expect(adapter.getActivityState()).toMatchObject({ activeRequests: 1, totalRequests: 2, timedOutRequests: 1, failedRequests: 0 })
    releases[0]([])
    await vi.advanceTimersByTimeAsync(0)
    expect(adapter.getActivityState().activeRequests).toBe(1)
    releases[1]([])
    expect((await b).isError).toBeUndefined()
    expect(adapter.getActivityState()).toMatchObject({ activeRequests: 0, succeededRequests: 1, timedOutRequests: 1 })
    await adapter.callTool('inspect_files', { unexpected: true })
    expect(adapter.getActivityState()).toMatchObject({ totalRequests: 3, failedRequests: 1, succeededRequests: 1, timedOutRequests: 1 })
  })

  it('counts actual HTTP tool calls once and excludes MCP control requests', async () => {
    const releases: Array<(value: { directories: [] }) => void> = []
    const navigation = { discoverRepository: vi.fn(() => new Promise<{ directories: [] }>(resolve => releases.push(resolve))) } as unknown as ProjectContextNavigation
    const adapter = new ChannelMcpAdapter(navigation)
    const trace = new ChannelActivityMonitor()
    const server = createMcpHttpServer(adapter, () => {}, trace)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    async function call(method: string) {
      const response = await fetch(`http://127.0.0.1:${(address as { port: number }).port}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { name: 'discover_repository', arguments: {} } })
      })
      return await response.json() as { result: { isError?: boolean } }
    }
    try {
      await Promise.all(['initialize', 'tools/list', 'ping'].map(call))
      expect(adapter.getActivityState().totalRequests).toBe(0)
      const calls = Array.from({ length: 3 }, () => call('tools/call'))
      await vi.waitFor(() => expect(navigation.discoverRepository).toHaveBeenCalledTimes(3))
      expect(adapter.getActivityState()).toMatchObject({ totalRequests: 3, activeRequests: 3, peakConcurrentRequests: 3 })
      releases.forEach(release => release({ directories: [] }))
      const results = await Promise.all(calls)
      expect(results.every(result => !result.result.isError)).toBe(true)
      expect(adapter.getActivityState()).toMatchObject({ totalRequests: 3, activeRequests: 0, succeededRequests: 3 })
      expect(trace.getState().totalRequests).toBe(0)
    } finally {
      releases.forEach(release => release({ directories: [] }))
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('keeps runtime activity across project adapter replacement', async () => {
    const navigation = { discoverRepository: async () => ({ directories: [] }) } as unknown as ProjectContextNavigation
    const lifecycle = new McpLifecycle({ log: () => {} })
    try {
      for (const project of ['a', 'b']) {
        await lifecycle.activate(project, navigation)
        const state = lifecycle.getState()
        if (state.status !== 'RUNNING') throw new Error('MCP not running')
        const response = await fetch(state.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'discover_repository', arguments: {} } }) })
        const reply = await response.json() as { result: { isError?: boolean } }
        expect(reply.result.isError).toBeUndefined()
      }
      expect(lifecycle.getActivityState()).toMatchObject({ totalRequests: 2, succeededRequests: 2, activeRequests: 0 })
    } finally {
      await lifecycle.dispose()
    }
  })
})
