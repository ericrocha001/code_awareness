import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpLifecycle } from '../mcp-lifecycle'
import { ActiveProjectService } from '../../core/active-project-service'
import type { ProjectContextNavigation } from '../../core/context/project-context-navigation'
import type { ConnectionState } from '../../../shared/types/connection-types'
import { ConnectionLifecycle } from './connection-lifecycle'
import { ConnectionError, type ConnectionTransportPort, type TransportState } from './connection-transport-port'

const navigation: ProjectContextNavigation = { discoverRepository: vi.fn(), getRelationships: vi.fn(async () => ({ files: [] })),
    inspectFiles: vi.fn(), getReferences: vi.fn(), getSymbolDependencies: vi.fn(), readCode: vi.fn() }

function fakeTransport() {
  let state: TransportState = { status: 'STOPPED' }
  let listener: (state: TransportState) => void = () => {}
  const port: ConnectionTransportPort = {
    name: 'fake',
    start: vi.fn(async () => { state = { status: 'RUNNING', externalEndpoint: 'https://stable.example/mcp' }; return { externalEndpoint: state.externalEndpoint } }),
    stop: vi.fn(async () => { state = { status: 'STOPPED' } }),
    getState: () => state,
    onChanged: (callback) => { listener = callback; return () => { listener = () => {} } }
  }
  return { port, fail: () => listener({ status: 'ERROR', error: 'NGROK_EXITED' }) }
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function setup() {
  const servers: Server[] = []
  const mcp = new McpLifecycle({ createServer: () => { const server = createServer(); servers.push(server); return server }, log: () => {} })
  const { port, fail } = fakeTransport()
  const states: ConnectionState[] = []
  const connection = new ConnectionLifecycle(mcp, port, () => ({ publicDomain: 'stable.example' }), (state) => states.push(state))
  cleanups.push(async () => { await connection.dispose(); await mcp.dispose() })
  return { mcp, port, fail, connection, states, servers }
}

describe('external connection lifecycle', () => {
  it.each(['C', 'shutdown'] as const)('invalidates pending rebind B when superseded by %s', async (next) => {
    const { mcp, connection, port, states } = setup()
    await mcp.activate('A', navigation)
    await connection.connect()
    vi.mocked(port.start).mockImplementationOnce((_endpoint, _configuration, signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ externalEndpoint: 'https://stable.example/mcp' }), { once: true })
    }))
    const b = mcp.activate('B', navigation)
    await vi.waitFor(() => expect(port.start).toHaveBeenCalledTimes(2))
    const last = next === 'C' ? mcp.activate('C', navigation) : connection.dispose()
    await Promise.all([b, last])
    expect(states.some((state) => state.status === 'CONNECTED' && state.projectId === 'B')).toBe(false)
    expect(connection.getState()).toMatchObject(next === 'C' ? { status: 'CONNECTED', projectId: 'C' } : { status: 'DISCONNECTED' })
  })
  it('removes exposure before committing canonical B and before releasing a closed project', async () => {
    const { mcp, connection, port } = setup()
    const closeRepository = vi.fn(() => {
      expect(port.getState().status).toBe('STOPPED')
      expect(mcp.getState().status).toBe('STOPPED')
    })
    const projects = new ActiveProjectService({
      getOpenProjects: () => ['A', 'B'].map((id) => ({ id, path: `/${id}`, name: id })), closeRepository
    })
    projects.onBeforeChange(() => mcp.quiesce())
    projects.onChanged(({ project }) => project ? mcp.activate(project.id, navigation) : mcp.deactivate())
    await projects.activate('A')
    await connection.connect()
    let release!: () => void
    vi.mocked(port.stop).mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const switching = projects.activate('B')
    await vi.waitFor(() => expect(connection.getState().status).toBe('REBINDING'))
    expect(projects.getState().project?.id).toBe('A')
    release()
    await switching
    expect(projects.getState().project?.id).toBe('B')
    expect(connection.getState()).toMatchObject({ status: 'CONNECTED', projectId: 'B' })
    await projects.closeRepository('/B')
    expect(closeRepository).toHaveBeenCalledWith('/B')
    await projects.dispose()
  })
  it('starts disconnected, requires MCP, coalesces explicit connect and disconnect, preserves identity on restart', async () => {
    const { mcp, connection, port } = setup()
    expect(connection.getState()).toEqual({ status: 'DISCONNECTED' })
    expect(await connection.connect()).toMatchObject({ success: false, error: 'MCP_NOT_RUNNING' })
    await mcp.activate('A', navigation)
    expect(port.start).not.toHaveBeenCalled()
    await Promise.all([connection.connect(), connection.connect(), connection.connect()])
    expect(port.start).toHaveBeenCalledTimes(1)
    const first = connection.getState()
    expect(first).toMatchObject({ status: 'CONNECTED', projectId: 'A', externalEndpoint: 'https://stable.example/mcp' })
    await Promise.all([connection.disconnect(), connection.disconnect(), connection.disconnect()])
    expect(connection.getState()).toEqual({ status: 'DISCONNECTED' })
    await connection.connect()
    expect(connection.getState()).toMatchObject({ status: 'CONNECTED', externalEndpoint: 'https://stable.example/mcp' })
  })

  it('awaits transport stop before replacing local A, rebinds B at the same public URL, and close clears intent', async () => {
    const { mcp, connection, port, states, servers } = setup()
    await mcp.activate('A', navigation)
    await connection.connect()
    const a = connection.getState()
    let release!: () => void
    vi.mocked(port.stop).mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const switching = mcp.activate('B', navigation)
    await vi.waitFor(() => expect(connection.getState().status).toBe('REBINDING'))
    expect(servers).toHaveLength(1)
    expect(servers[0].listening).toBe(true)
    release()
    await switching
    expect(servers[0].listening).toBe(false)
    const b = connection.getState()
    expect(b).toMatchObject({ status: 'CONNECTED', projectId: 'B', externalEndpoint: 'https://stable.example/mcp' })
    if (a.status === 'CONNECTED' && b.status === 'CONNECTED') expect(a.localEndpoint).not.toBe(b.localEndpoint)
    expect(states.some((state) => state.status === 'REBINDING')).toBe(true)
    await mcp.deactivate()
    expect(connection.getState()).toEqual({ status: 'DISCONNECTED' })
    const starts = vi.mocked(port.start).mock.calls.length
    await mcp.activate('C', navigation)
    expect(port.start).toHaveBeenCalledTimes(starts)
  })

  it.each(['disconnect', 'dispose', 'switch'] as const)('cancels a late startup on %s without publishing obsolete A', async (operation) => {
    const { mcp, connection, port, states } = setup()
    await mcp.activate('A', navigation)
    let finish!: () => void
    vi.mocked(port.start).mockImplementationOnce((_endpoint, _configuration, signal) => new Promise((resolve) => {
      finish = () => resolve({ externalEndpoint: 'https://stable.example/mcp' })
      signal.addEventListener('abort', finish, { once: true })
    }))
    const start = connection.connect()
    await vi.waitFor(() => expect(port.start).toHaveBeenCalledTimes(1))
    const change = operation === 'switch' ? mcp.activate('B', navigation) : operation === 'dispose' ? connection.dispose() : connection.disconnect()
    await Promise.all([start, change])
    expect(states.filter((state) => state.status === 'CONNECTED').some((state) => state.status === 'CONNECTED' && state.projectId === 'A')).toBe(false)
    expect(connection.getState()).toMatchObject({ status: operation === 'switch' ? 'CONNECTED' : 'DISCONNECTED' })
    if (operation === 'switch') expect(connection.getState()).toMatchObject({ projectId: 'B' })
  })

  it('coalesces A to B to C, isolates terminal failures and permits only manual retry', async () => {
    const { mcp, connection, port, fail, servers } = setup()
    await mcp.activate('A', navigation)
    await connection.connect()
    await Promise.all([mcp.activate('B', navigation), mcp.activate('C', navigation)])
    expect(connection.getState()).toMatchObject({ status: 'CONNECTED', projectId: 'C' })
    fail()
    await vi.waitFor(() => expect(connection.getState()).toEqual({ status: 'ERROR', error: 'NGROK_EXITED' }))
    expect(mcp.getState().status).toBe('RUNNING')
    expect(port.getState().status).toBe('STOPPED')
    await connection.connect()
    servers.at(-1)!.emit('error', new Error('private data'))
    await vi.waitFor(() => expect(connection.getState()).toEqual({ status: 'ERROR', error: 'MCP_FAILED' }))
    expect(port.getState().status).toBe('STOPPED')
  })

  it('rejects changed external identity on rebind and sanitizes startup failure', async () => {
    const { mcp, connection, port } = setup()
    await mcp.activate('A', navigation)
    vi.mocked(port.start).mockRejectedValueOnce(new ConnectionError('NGROK_NOT_AUTHENTICATED'))
    expect(await connection.connect()).toMatchObject({ success: false, error: 'NGROK_NOT_AUTHENTICATED' })
    await connection.connect()
    vi.mocked(port.start).mockResolvedValueOnce({ externalEndpoint: 'https://random.example/mcp' })
    await mcp.activate('B', navigation)
    expect(connection.getState()).toEqual({ status: 'ERROR', error: 'TRANSPORT_IDENTITY_CHANGED' })
    expect(port.getState().status).toBe('STOPPED')
    await Promise.all([connection.disconnect(), connection.dispose()])
    expect(await connection.connect()).toMatchObject({ success: false, error: 'CONNECTION_DISPOSED' })
  })
})
