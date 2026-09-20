import { describe, expect, it, vi } from 'vitest'
import { McpLifecycle } from '../mcp/mcp-lifecycle'
import { ConnectionLifecycle } from '../mcp/connection/connection-lifecycle'
import type { ConnectionTransportPort } from '../mcp/connection/connection-transport-port'
import { registerConnectionHandlers } from './connection-handler'

const { handlers, send } = vi.hoisted(() => ({ handlers: new Map<string, Function>(), send: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, callback: Function) => handlers.set(channel, callback) },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }] }
}))

describe('connection IPC authority', () => {
  it('returns canonical state, rejects arguments and survives reload/out-of-order intents', async () => {
    const mcp = new McpLifecycle({ log: () => {} })
    const transport: ConnectionTransportPort = {
      name: 'fake', start: vi.fn(async () => ({ externalEndpoint: 'https://stable.example/mcp' })),
      stop: vi.fn(async () => {}), getState: () => ({ status: 'STOPPED' }), onChanged: () => () => {}
    }
    const connection = new ConnectionLifecycle(mcp, transport, () => ({ publicDomain: 'stable.example' }), () => {})
    registerConnectionHandlers(connection)
    const call = (channel: string, ...args: unknown[]) => handlers.get(`connection:${channel}`)!({}, ...args)
    try {
      expect(await call('connect')).toMatchObject({ success: false, error: 'MCP_NOT_RUNNING' })
      await mcp.activate('A', { discoverRepository: vi.fn(), getRelationships: vi.fn(async () => ({ files: [] })), inspectFiles: vi.fn(), readCode: vi.fn() })
      for (const channel of ['connect', 'disconnect', 'get-state']) {
        expect(await call(channel, { endpoint: 'http://untrusted' })).toMatchObject({ success: false, error: 'INVALID_ARGUMENTS' })
      }
      const connected = await call('connect')
      expect(connected).toEqual({ success: true, state: connection.getState() })
      expect(connected.state.status).toBe('CONNECTED')
      expect(send).toHaveBeenCalledWith('connection:changed', connected.state)
      expect(await call('get-state')).toEqual(connected)
      await Promise.all([call('disconnect'), call('connect'), call('disconnect')])
      expect(await call('get-state')).toEqual({ success: true, state: { status: 'DISCONNECTED' } })
    } finally { await connection.dispose(); await mcp.dispose() }
  })
})
