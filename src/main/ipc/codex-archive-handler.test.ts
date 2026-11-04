import { expect, it, vi } from 'vitest'
const { handlers, choose } = vi.hoisted(() => ({ handlers: new Map<string, Function>(), choose: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, callback: Function) => handlers.set(name, callback) }, dialog: { showOpenDialog: choose } }))
import { registerCodexArchiveHandlers } from './codex-archive-handler'

it('exposes no-argument Desktop-only operations and rejects remote frames or arbitrary profile/command inputs', async () => {
  const frame = { url: 'file:///app/index.html' }, sender = { mainFrame: frame }, window = { webContents: sender, isDestroyed: () => false }
  const bridge = { inspect: vi.fn(() => ({ state: 'NOT_CONFIGURED' })), disable: vi.fn(() => ({ state: 'NOT_CONFIGURED' })), enable: vi.fn(async () => ({ state: 'READY' })) }
  registerCodexArchiveHandlers(() => bridge as any, () => window as any, frame.url)
  const event = { sender, senderFrame: frame }
  expect(handlers.get('codex-archive:inspect')!(event)).toEqual({ state: 'NOT_CONFIGURED' })
  expect(bridge.enable).not.toHaveBeenCalled()
  expect(() => handlers.get('codex-archive:enable')!(event, { executable: 'arbitrary' })).toThrow('UNAUTHORIZED')
  expect(() => handlers.get('codex-archive:enable')!({ sender: {}, senderFrame: frame })).toThrow('UNAUTHORIZED')
  expect(() => handlers.get('codex-archive:enable')!({ sender, senderFrame: {} })).toThrow('UNAUTHORIZED')
  frame.url = 'https://remote.invalid'
  expect(() => handlers.get('codex-archive:enable')!(event)).toThrow('UNAUTHORIZED')
  frame.url = 'file:///app/index.html'
  choose.mockResolvedValueOnce({ canceled: false, filePaths: ['C:/fixture/codex.exe'] }).mockResolvedValueOnce({ canceled: false, filePaths: ['C:/fixture/profile'] })
  expect(await handlers.get('codex-archive:enable')!(event)).toEqual({ state: 'READY' })
  expect(bridge.enable).toHaveBeenCalledExactlyOnceWith({ executable: 'C:/fixture/codex.exe', directory: 'C:/fixture/profile' })
  choose.mockResolvedValueOnce({ canceled: true, filePaths: [] })
  await handlers.get('codex-archive:enable')!(event)
  expect(bridge.enable).toHaveBeenCalledOnce()
})
