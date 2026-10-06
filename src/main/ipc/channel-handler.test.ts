import { expect, it, vi } from 'vitest'
import { McpLifecycle } from '../mcp/mcp-lifecycle'
import { ConnectionLifecycle } from '../mcp/connection/connection-lifecycle'
import { RemoteAccessService } from '../mcp/connection/remote-access-service'
import { ActiveProjectService } from '../core/active-project-service'
import { ChannelStateProjection } from '../integrations/channel-state-projection'
import { registerChannelHandlers } from './channel-handler'
import { registerConnectionHandlers } from './connection-handler'
import type { AppSettings } from '../../shared/types'
import { ChannelFunctionalHealthMonitor } from '../mcp/channel-functional-health'
import { newConnectionId, newRequestId } from '../../shared/distribution/relay-protocol'

const { handlers, send } = vi.hoisted(() => ({ handlers: new Map<string, Function>(), send: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, callback: Function) => handlers.set(channel, callback) }, BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }] } }))

it('reuses existing commands, persists intent and publishes the authoritative projection', async () => {
  let saved = { remoteAccessEnabled: false, transportKind: 'relay' } as AppSettings
  const settingsListeners = new Set<() => void>()
  const settings = { loadSettings: () => saved, saveSettings: vi.fn((next: AppSettings) => { saved = next; settingsListeners.forEach((listener) => listener()) }), onChanged: (listener: () => void) => { settingsListeners.add(listener); return () => { settingsListeners.delete(listener) } } }
  const mcp = new McpLifecycle({ log: () => {} })
  const stop = vi.fn(async () => {})
  const connection = new ConnectionLifecycle(mcp, { name: 'relay', start: async () => ({ externalEndpoint: 'https://example.test/mcp' }), stop, getState: () => ({ status: 'STOPPED' }), onChanged: () => () => {} }, () => ({}), () => {})
  const remote = new RemoteAccessService(settings, connection)
  const projects = new ActiveProjectService({ getOpenProjects: () => [{ id: 'A', name: 'project-a', path: '/a' }], closeRepository: () => {} })
  projects.onBeforeChange(() => mcp.quiesce())
  projects.onChanged(({ project }) => project ? mcp.activate(project.id, { discoverRepository: vi.fn(), getRelationships: vi.fn(async () => ({ files: [] })), inspectFiles: vi.fn(), readCode: vi.fn(), getReferences: vi.fn(), getSymbolDependencies: vi.fn(), getSymbolHierarchy: vi.fn() }) : mcp.deactivate())
  const configured = vi.fn(() => true)
  const health = new ChannelFunctionalHealthMonitor()
  const projection = new ChannelStateProjection(remote, projects, mcp, configured, settings, health)
  registerChannelHandlers(projection); registerConnectionHandlers(remote); remote.start()
  const query = () => handlers.get('channel:get-state')!({})
  try {
    expect(query().availability).toBe('DISABLED')
    expect(() => handlers.get('channel:get-state')!({}, 'extra')).toThrow('INVALID_ARGUMENTS')
    await handlers.get('connection:connect')!({})
    expect(saved.remoteAccessEnabled).toBe(true); expect(query().availability).toBe('WAITING_FOR_PROJECT')
    await projects.activate('A')
    await vi.waitFor(() => expect(query().availability).toBe('READY'))
    health.record({ timestamp: new Date(Date.now() + 1000).toISOString(), requestId: newRequestId(), sessionId: newConnectionId(), method: 'tools/call', tool: 'discover_repository', stage: 'relay-response-forwarded', durationMs: 1, status: 'success' })
    await vi.waitFor(() => expect(query().availability).toBe('READY'))
    expect(send).toHaveBeenCalledWith('channel:changed', expect.objectContaining({ availability: 'READY' }))
    const stopsBefore = stop.mock.calls.length
    await handlers.get('connection:disconnect')!({})
    expect(saved.remoteAccessEnabled).toBe(false); expect(query().availability).toBe('DISABLED')
    expect(stop.mock.calls.length).toBeGreaterThan(stopsBefore)
    expect(query().installationConfigured).toBe(true)
    await handlers.get('connection:connect')!({})
    health.record({ timestamp: new Date(Date.now() + 2000).toISOString(), requestId: newRequestId(), sessionId: newConnectionId(), method: 'tools/call', tool: 'discover_repository', stage: 'relay-response-forwarded', durationMs: 1, status: 'success' })
    await vi.waitFor(() => expect(query().availability).toBe('READY'))
    await projects.activate(null)
    expect(query()).toMatchObject({ availability: 'WAITING_FOR_PROJECT', activeProject: null })
  } finally { projection.dispose(); await remote.dispose(); await projects.dispose(); await mcp.dispose() }
})
