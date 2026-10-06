import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import { ChannelMcpAdapter, type McpToolResult } from './channel-mcp-adapter'
import { createMcpHttpServer } from './mcp-http-server'
import { McpLifecycle, type McpLifecycleState } from './mcp-lifecycle'

function navigation(project: string): ProjectContextNavigation {
  return {
    discoverRepository: vi.fn(async () => ({ directories: [{ relativePath: '.', children: [project] }] })),
    getRelationships: vi.fn(async () => ({ files: [] })),
    inspectFiles: vi.fn(async () => ({ files: [] })),
    getReferences: vi.fn(async () => ({ targets: [] })),
    getSymbolDependencies: vi.fn(async () => ({ sources: [] })),
    readCode: vi.fn(async () => [])
  }
}

async function call(endpoint: string, tool = 'discover_repository') {
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: {} } })
  })
  return (await response.json() as { result: McpToolResult }).result
}

function endpoint(lifecycle: McpLifecycle): string {
  const state = lifecycle.getState()
  if (state.status !== 'RUNNING') throw new Error(`Expected RUNNING, received ${state.status}`)
  return state.endpoint
}

const lifecycles: McpLifecycle[] = []
afterEach(async () => { await Promise.all(lifecycles.splice(0).map((lifecycle) => lifecycle.dispose())) })

function setup(factory?: (navigation: ProjectContextNavigation) => Server) {
  const states: McpLifecycleState[] = []
  const lifecycle = new McpLifecycle({ createServer: factory, log: (state) => states.push(state) })
  lifecycles.push(lifecycle)
  return { lifecycle, states }
}

describe('MCP lifecycle', () => {
  it('serves the supplied project on loopback, replaces bindings and closes the endpoint', async () => {
    const servers: Server[] = []
    const { lifecycle, states } = setup((port) => {
      expect(servers.every((server) => !server.listening)).toBe(true)
      const server = createMcpHttpServer(new ChannelMcpAdapter(port), () => {})
      servers.push(server)
      return server
    })
    expect(lifecycle.getState()).toEqual({ status: 'STOPPED', available: false })
    const a = navigation('A')
    await Promise.all([lifecycle.activate('A', a), lifecycle.activate('A', a), lifecycle.activate('A', a)])
    const first = endpoint(lifecycle)
    expect(first).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(servers[0].address()).toMatchObject({ address: '127.0.0.1' })
    expect((await call(first)).content[0].text).toBe('[.]\nA')
    await lifecycle.activate('A', a)
    expect(endpoint(lifecycle)).toBe(first)
    expect(servers).toHaveLength(1)
    await lifecycle.activate('B', navigation('B'))
    expect((await call(endpoint(lifecycle))).content[0].text).toBe('[.]\nB')
    expect(servers[0].listening).toBe(false)
    const last = endpoint(lifecycle)
    await lifecycle.deactivate()
    await expect(call(last)).rejects.toThrow()
    expect(lifecycle.getState()).toEqual({ status: 'STOPPED', available: false })
    expect(states.map((state) => state.status)).toContain('STOPPING')
  })

  it('coalesces rapid A B C requests and prevents activation after disposal', async () => {
    const factory = vi.fn((port: ProjectContextNavigation) => createMcpHttpServer(new ChannelMcpAdapter(port), () => {}))
    const { lifecycle } = setup(factory)
    await Promise.all(['A', 'B', 'C'].map((id) => lifecycle.activate(id, navigation(id))))
    expect(factory).toHaveBeenCalledTimes(1)
    expect((await call(endpoint(lifecycle))).content[0].text).toBe('[.]\nC')
    const last = endpoint(lifecycle)
    await lifecycle.dispose()
    await lifecycle.activate('D', navigation('D'))
    await expect(call(last)).rejects.toThrow()
    expect(lifecycle.getState().status).toBe('STOPPED')
  })

  it('does not publish a stale start after disposal has been requested', async () => {
    let release!: () => void
    const { lifecycle, states } = setup((port) => {
      const server = createMcpHttpServer(new ChannelMcpAdapter(port), () => {})
      const listen = server.listen.bind(server)
      vi.spyOn(server, 'listen').mockImplementation((...args: any[]) => {
        release = () => (listen as Function)(...args)
        return server
      })
      return server
    })
    const activation = lifecycle.activate('A', navigation('A'))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const disposal = lifecycle.dispose()
    release()
    await Promise.all([activation, disposal])
    expect(states.some((state) => state.status === 'RUNNING')).toBe(false)
    expect(lifecycle.getState().status).toBe('STOPPED')
  })

  it('drains an in-flight A request before starting B without changing its binding', async () => {
    let release!: () => void
    const a = navigation('A')
    vi.mocked(a.discoverRepository).mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ directories: [{ relativePath: '.', children: ['A'] }] })
    }))
    const { lifecycle } = setup()
    await lifecycle.activate('A', a)
    const pending = call(endpoint(lifecycle))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const replacement = lifecycle.activate('B', navigation('B'))
    await vi.waitFor(() => expect(lifecycle.getState().status).toBe('STOPPING'))
    release()
    expect((await pending).content[0].text).toBe('[.]\nA')
    await replacement
    expect((await call(endpoint(lifecycle))).content[0].text).toBe('[.]\nB')
  })

  it('isolates start failures, redacts details and permits an explicit retry', async () => {
    let fail = true
    const { lifecycle, states } = setup((port) => {
      if (fail) throw new Error('private repo path or credential')
      return createMcpHttpServer(new ChannelMcpAdapter(port), () => {})
    })
    await expect(lifecycle.activate('A', navigation('A'))).resolves.toBeUndefined()
    expect(lifecycle.getState()).toEqual({ status: 'ERROR', available: false, error: 'MCP_START_FAILED' })
    expect(JSON.stringify(states)).not.toContain('private')
    fail = false
    await lifecycle.activate('A', navigation('A'))
    expect(lifecycle.getState().status).toBe('RUNNING')
  })

  it('handles asynchronous listen errors without retaining the failed server', async () => {
    const occupied = createServer()
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve))
    const address = occupied.address() as { port: number }
    try {
      const { lifecycle } = setup(() => {
        const server = createServer()
        const listen = server.listen.bind(server)
        vi.spyOn(server, 'listen').mockImplementation(() => listen(address.port, '127.0.0.1'))
        return server
      })
      await lifecycle.activate('A', navigation('A'))
      expect(lifecycle.getState().status).toBe('ERROR')
      await lifecycle.dispose()
      expect(lifecycle.getState().status).toBe('STOPPED')
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()))
    }
  })

  it('reports runtime errors without allowing stale errors to overwrite newer state', async () => {
    const servers: Server[] = []
    const { lifecycle } = setup((port) => {
      const server = createMcpHttpServer(new ChannelMcpAdapter(port), () => {})
      servers.push(server)
      return server
    })
    await lifecycle.activate('A', navigation('A'))
    servers[0].emit('error', new Error('private details'))
    await vi.waitFor(() => expect(lifecycle.getState()).toEqual({ status: 'ERROR', available: false, error: 'MCP_SERVER_FAILED' }))
    expect(servers[0].listening).toBe(false)
    expect(servers[0].listenerCount('error')).toBe(0)
    await lifecycle.activate('B', navigation('B'))
    servers[1].emit('error', new Error('private details'))
    await lifecycle.deactivate()
    expect(lifecycle.getState()).toEqual({ status: 'STOPPED', available: false })
  })
})
