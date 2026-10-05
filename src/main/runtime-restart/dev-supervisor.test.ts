import { EventEmitter } from 'node:events'
import { createConnection, type Socket } from 'node:net'
import { createRequire } from 'node:module'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { resolveRelayEndpoint } from '../mcp/connection/relay-endpoint'

const require = createRequire(import.meta.url)
const { createDevSupervisor, createDevRuntimeEnvironment } = require('../../../scripts/dev-supervisor-core.cjs') as {
  createDevRuntimeEnvironment(environment: NodeJS.ProcessEnv, supervisor: { port: number; token: string }): NodeJS.ProcessEnv
  createDevSupervisor(options: { token: string; spawnRuntime(input: { port: number; token: string }): EventEmitter & { kill(signal?: string): void } }): { server: import('node:net').Server; stop(): void }
}

function exchange(socket: Socket, message: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.once('data', (chunk) => resolve(chunk.toString('utf8').trim()))
    socket.write(`${JSON.stringify(message)}\n`)
  })
}

describe('development supervisor', () => {
  it('supplies a public Relay default without manual env and preserves explicit overrides', () => {
    const supervisor = { port: 12345, token: 'test-token' }
    const defaults = createDevRuntimeEnvironment({}, supervisor)
    expect(resolveRelayEndpoint(defaults.CODE_AWARENESS_RELAY_ENDPOINT)).toBe('https://code-awareness-gateway.eric-rocha.workers.dev/mcp')
    expect(defaults.CODE_AWARENESS_DEV_SUPERVISOR_ENDPOINT).toBe('12345')
    const override = createDevRuntimeEnvironment({ CODE_AWARENESS_RELAY_ENDPOINT: 'http://127.0.0.1:8787/mcp' }, supervisor)
    expect(resolveRelayEndpoint(override.CODE_AWARENESS_RELAY_ENDPOINT)).toBe('http://127.0.0.1:8787/mcp')
    for (const value of ['', 'invalid', 'https://gateway.example/mcp?token=secret']) {
      const invalid = createDevRuntimeEnvironment({ CODE_AWARENESS_RELAY_ENDPOINT: value }, supervisor)
      expect(() => resolveRelayEndpoint(invalid.CODE_AWARENESS_RELAY_ENDPOINT)).toThrowError(expect.objectContaining({ code: 'RELAY_ENDPOINT_NOT_CONFIGURED' }))
    }
  })
  it('starts the fixed runtime again only after an authorized committed restart and child exit', async () => {
    const children: Array<EventEmitter & { kill: ReturnType<typeof vi.fn> }> = []
    const spawnRuntime = vi.fn(() => {
      const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
      children.push(child)
      return child
    })
    const supervisor = createDevSupervisor({ token: 'test-token', spawnRuntime })
    await new Promise<void>((resolve) => supervisor.server.once('listening', resolve))
    const port = (supervisor.server.address() as { port: number }).port
    expect(spawnRuntime).toHaveBeenCalledTimes(1)
    const socket = createConnection({ host: '127.0.0.1', port })
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    expect(await exchange(socket, { action: 'PREPARE', token: 'test-token' })).toBe('READY')
    expect(await exchange(socket, { action: 'COMMIT', token: 'test-token' })).toBe('ACK')
    children[0].emit('exit', 0)
    await vi.waitFor(() => expect(spawnRuntime).toHaveBeenCalledTimes(2))
    expect(spawnRuntime.mock.calls[1][0]).toMatchObject({ port, token: 'test-token' })
    socket.end()
    supervisor.stop()
    children[1].emit('exit', 0)
  })

  it('relaunches a real child process with a new runtime instance identity', async () => {
    const children: ChildProcessWithoutNullStreams[] = []
    const instanceIds: string[] = []
    const endpoints: string[] = []
    const supervisor = createDevSupervisor({
      token: 'integration-token',
      spawnRuntime: (supervisor: { port: number; token: string }) => {
        const child = spawn(process.execPath, ['-e', "console.log(JSON.stringify([require('node:crypto').randomUUID(), process.env.CODE_AWARENESS_RELAY_ENDPOINT])); setInterval(() => {}, 1000)"], { stdio: 'pipe', env: createDevRuntimeEnvironment({}, supervisor) }) as ChildProcessWithoutNullStreams
        child.stdout.once('data', (chunk) => {
          const [id, endpoint] = JSON.parse(chunk.toString('utf8'))
          instanceIds.push(id); endpoints.push(endpoint)
        })
        children.push(child)
        return child
      }
    })
    await new Promise<void>((resolve) => supervisor.server.once('listening', resolve))
    await vi.waitFor(() => expect(instanceIds).toHaveLength(1))
    const port = (supervisor.server.address() as { port: number }).port
    const socket = createConnection({ host: '127.0.0.1', port })
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    expect(await exchange(socket, { action: 'PREPARE', token: 'integration-token' })).toBe('READY')
    expect(await exchange(socket, { action: 'COMMIT', token: 'integration-token' })).toBe('ACK')
    children[0].kill()
    await vi.waitFor(() => expect(instanceIds).toHaveLength(2))
    expect(instanceIds[1]).not.toBe(instanceIds[0])
    expect(endpoints).toEqual(['https://code-awareness-gateway.eric-rocha.workers.dev/mcp', 'https://code-awareness-gateway.eric-rocha.workers.dev/mcp'])
    socket.end()
    supervisor.stop()
  })
})
