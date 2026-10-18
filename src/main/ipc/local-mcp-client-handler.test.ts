import { expect, it, vi } from 'vitest'
import type { LocalMcpClientService } from '../local-mcp-clients/local-mcp-client-service'
const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, Function>() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: Function) => handlers.set(name, fn) } }))
import { registerLocalMcpClientHandlers } from './local-mcp-client-handler'

it('exposes only typed setup operations to the main frame and binds confirmation to the sender', async () => {
  const service = { detect: vi.fn(() => []), verify: vi.fn(), preview: vi.fn(), apply: vi.fn() }
  registerLocalMcpClientHandlers(service as unknown as LocalMcpClientService, 'file:///app/index.html')
  const frame = { url: 'file:///app/index.html' }; const sender = { id: 17, mainFrame: frame, isDestroyed: () => false }
  const event = { sender, senderFrame: frame }
  expect(handlers.get('local-mcp:detect')!(event)).toEqual([])
  handlers.get('local-mcp:preview')!(event, 'codex', 'connect')
  expect(service.preview).toHaveBeenCalledWith('codex', 'connect', 17)
  handlers.get('local-mcp:apply')!(event, 'token', true, false)
  expect(service.apply).toHaveBeenCalledWith('token', true, false, 17)
  expect(() => handlers.get('local-mcp:apply')!(event, 'token', 'yes', false)).toThrow('INVALID_LOCAL_SETUP_REQUEST')
  expect(() => handlers.get('local-mcp:detect')!(event, '/arbitrary/path')).toThrow('INVALID_LOCAL_SETUP_REQUEST')
  expect(() => handlers.get('local-mcp:verify')!(event, 'arbitrary-client')).toThrow('UNKNOWN_CLIENT')
  expect(() => handlers.get('local-mcp:preview')!(event, 'codex', 'run-shell')).toThrow('INVALID_ACTION')
  expect(() => handlers.get('local-mcp:detect')!({ ...event, senderFrame: {} })).toThrow('INVALID_LOCAL_SETUP_REQUEST')
  frame.url = 'https://external.invalid'
  expect(() => handlers.get('local-mcp:detect')!(event)).toThrow('INVALID_LOCAL_SETUP_REQUEST')
})
