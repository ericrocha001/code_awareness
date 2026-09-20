import { afterEach, expect, it, vi } from 'vitest'
import type { AppSettings } from '../../../shared/types'
import type { ConnectionErrorCode } from '../../../shared/types/connection-types'
import type { McpLifecycleState } from '../mcp-lifecycle'
import { ConnectionLifecycle } from './connection-lifecycle'
import { ConnectionError, type ConnectionTransportPort, type TransportState } from './connection-transport-port'
import { RemoteAccessService } from './remote-access-service'
import { SelectedTransport } from './selected-transport'

const disposals: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); vi.useRealTimers() })
const flush = () => vi.advanceTimersByTimeAsync(0)

function fixture(initial: Partial<AppSettings> = {}, initialProject?: string) {
  vi.useFakeTimers()
  let settings = { remoteAccessEnabled: false, transportKind: 'relay', ...initial } as AppSettings
  const settingsListeners = new Set<() => void>()
  const store = {
    loadSettings: () => ({ ...settings }),
    saveSettings: vi.fn((next: AppSettings) => { settings = JSON.parse(JSON.stringify(next)); settingsListeners.forEach((fn) => fn()) }),
    onChanged: (fn: () => void) => { settingsListeners.add(fn); return () => { settingsListeners.delete(fn) } }
  }
  let local: McpLifecycleState = initialProject ? { status: 'RUNNING', available: true, projectId: initialProject, endpoint: `http://127.0.0.1:8765/${initialProject}` } : { status: 'STOPPED', available: false }
  let onLocal: (state: McpLifecycleState) => unknown = () => {}
  const mcp = { getState: () => local, onChanged: (fn: typeof onLocal) => { onLocal = fn; return () => { onLocal = () => {} } } }
  let onTransport: (state: TransportState) => void = () => {}
  let sockets = 0
  const port: ConnectionTransportPort = {
    name: 'relay',
    start: vi.fn(async () => { expect(sockets).toBe(0); sockets++; return { externalEndpoint: 'https://stable.example/mcp' } }),
    stop: vi.fn(async () => { sockets = 0 }),
    getState: () => sockets ? { status: 'RUNNING', externalEndpoint: 'https://stable.example/mcp' } : { status: 'STOPPED' },
    onChanged: (fn) => { onTransport = fn; return () => { onTransport = () => {} } }
  }
  const lifecycle = new ConnectionLifecycle(mcp as never, port, () => ({}), () => {})
  const service = new RemoteAccessService(store, lifecycle)
  disposals.push(() => service.dispose())
  const activate = async (id: string | null) => {
    local = id ? { status: 'RUNNING', available: true, projectId: id, endpoint: `http://127.0.0.1:8765/${id}` } : { status: 'STOPPED', available: false }
    await onLocal(local)
    await flush()
  }
  return { store, service, lifecycle, port, activate, fail: (error: ConnectionErrorCode = 'RELAY_CLOSED') => onTransport({ status: 'ERROR', error }) }
}

it('defaults disabled, persists enable/disable, waits for readiness and never selects a project', async () => {
  const f = fixture()
  f.service.start()
  await flush()
  expect(f.port.start).not.toHaveBeenCalled()
  await Promise.all([f.service.connect(), f.service.connect()])
  expect(f.store.loadSettings().remoteAccessEnabled).toBe(true)
  expect(f.port.start).not.toHaveBeenCalled()
  await f.activate('A')
  expect(f.service.getState()).toMatchObject({ status: 'CONNECTED', projectId: 'A', remoteAccessEnabled: true })
  await f.service.connect()
  expect(f.port.start).toHaveBeenCalledTimes(1)
  await f.activate(null)
  expect(f.service.getState()).toMatchObject({ status: 'DISCONNECTED', remoteAccessEnabled: true })
  await f.activate('B')
  expect(f.service.getState()).toMatchObject({ status: 'CONNECTED', projectId: 'B' })
  await f.service.disconnect()
  const restart = fixture(f.store.loadSettings(), 'B')
  restart.service.start()
  await flush()
  expect(restart.port.start).not.toHaveBeenCalled()
  expect(JSON.stringify(f.store.loadSettings())).not.toMatch(/CONNECTED|attempt|nextReconnect|token|credential|localEndpoint/i)
})

it('restores enabled intent on a new runtime without OAuth or enrollment', async () => {
  const first = fixture({}, 'A')
  first.service.start()
  await first.service.connect()
  await first.service.dispose()
  const second = fixture(first.store.loadSettings(), 'A')
  second.service.start()
  await flush()
  expect(second.service.getState()).toMatchObject({ status: 'CONNECTED', remoteAccessEnabled: true })
})

it('propagates persisted true and relay through service reconstruction to RemoteAccessService', async () => {
  const f = fixture({ remoteAccessEnabled: true, transportKind: 'relay' }, 'A')
  f.service.start()
  await flush()
  expect(f.service.getState()).toMatchObject({ remoteAccessEnabled: true, transportKind: 'relay', status: 'CONNECTED' })
  await f.service.dispose()
  const restarted = fixture(f.store.loadSettings(), 'A')
  restarted.service.start()
  await flush()
  expect(restarted.service.getState()).toMatchObject({ remoteAccessEnabled: true, transportKind: 'relay', status: 'CONNECTED' })
})

it('does not block project readiness while the remote connection is unavailable', async () => {
  const f = fixture({ remoteAccessEnabled: true })
  vi.mocked(f.port.start).mockImplementationOnce((_endpoint, _configuration, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new ConnectionError('RELAY_CLOSED')), { once: true })
  }))
  f.service.start()
  await f.activate('A')
  expect(f.service.getState().status).toBe('CONNECTING')
  await f.service.disconnect()
  expect(f.service.getState().status).toBe('DISCONNECTED')
})

it('bounds connection retries, recovers and resets backoff without invoking tools', async () => {
  const f = fixture({ remoteAccessEnabled: true }, 'A')
  vi.mocked(f.port.start).mockRejectedValue(new ConnectionError('RELAY_CLOSED'))
  f.service.start()
  await flush()
  for (const delay of [1000, 2000, 5000, 10000, 30000, 30000]) {
    const calls = vi.mocked(f.port.start).mock.calls.length
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(f.port.start).toHaveBeenCalledTimes(calls)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.port.start).toHaveBeenCalledTimes(calls + 1)
  }
  vi.mocked(f.port.start).mockResolvedValue({ externalEndpoint: 'https://stable.example/mcp' })
  await vi.advanceTimersByTimeAsync(30000)
  expect(f.service.getState()).toMatchObject({ status: 'CONNECTED', attempt: 0 })
  f.fail(); f.fail()
  await flush()
  expect(f.lifecycle.getRetryState().attempt).toBe(1)
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.service.getState().status).toBe('CONNECTED')
})

it.each(['INVALID_CREDENTIAL', 'INSTALLATION_REVOKED', 'PROTOCOL_UNSUPPORTED', 'INVALID_MESSAGE'] as const)('does not retry terminal %s', async (error) => {
  const f = fixture({ remoteAccessEnabled: true }, 'A')
  vi.mocked(f.port.start).mockRejectedValue(new ConnectionError(error))
  f.service.start()
  await flush()
  await vi.advanceTimersByTimeAsync(120000)
  expect(f.port.start).toHaveBeenCalledTimes(1)
  expect(f.service.getState()).toMatchObject({ status: 'ERROR', error, nextReconnectAt: null })
})

it.each(['disable', 'shutdown'] as const)('cancels stale startup and pending retry on %s', async (operation) => {
  const f = fixture({ remoteAccessEnabled: true }, 'A')
  vi.mocked(f.port.start).mockImplementationOnce((_endpoint, _configuration, signal) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ externalEndpoint: 'https://stable.example/mcp' }), { once: true })
  }))
  f.service.start()
  await flush()
  if (operation === 'disable') await f.service.disconnect()
  else await f.service.dispose()
  await vi.advanceTimersByTimeAsync(120000)
  expect(f.service.getState().status).toBe('DISCONNECTED')
  expect(f.port.start).toHaveBeenCalledTimes(1)

  const retry = fixture({ remoteAccessEnabled: true }, 'A')
  vi.mocked(retry.port.start).mockRejectedValue(new ConnectionError('RELAY_CLOSED'))
  retry.service.start()
  await flush()
  if (operation === 'disable') await retry.service.disconnect()
  else await retry.service.dispose()
  await vi.advanceTimersByTimeAsync(120000)
  expect(retry.port.start).toHaveBeenCalledTimes(1)
})

it('rebinds a retry to the latest project and preserves enabled intent through no project', async () => {
  const f = fixture({ remoteAccessEnabled: true }, 'A')
  vi.mocked(f.port.start).mockRejectedValueOnce(new ConnectionError('RELAY_CLOSED'))
  f.service.start()
  await flush()
  await f.activate('B')
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.service.getState()).toMatchObject({ status: 'CONNECTED', projectId: 'B' })
  expect(vi.mocked(f.port.start).mock.calls.at(-1)![0]).toContain('/B')
  await f.activate(null)
  await vi.advanceTimersByTimeAsync(60000)
  expect(f.service.getState()).toMatchObject({ status: 'DISCONNECTED', remoteAccessEnabled: true })
  await f.activate('C')
  expect(f.service.getState()).toMatchObject({ status: 'CONNECTED', projectId: 'C' })
})

it('selects one adapter at a time and releases it before switching kinds', async () => {
  const f = fixture()
  let kind: 'relay' | 'ngrok' = 'relay'
  const create = vi.fn((_kind: 'relay' | 'ngrok') => f.port)
  const selected = new SelectedTransport(() => kind, create)
  await selected.start('http://local', {}, new AbortController().signal)
  kind = 'ngrok'
  await expect(selected.start('http://local', {}, new AbortController().signal)).rejects.toThrow()
  await selected.stop()
  await selected.start('http://local', {}, new AbortController().signal)
  expect(create.mock.calls.map((call) => call[0])).toEqual(['relay', 'ngrok'])
  await selected.stop()
})
