import { EventEmitter } from 'node:events'
import { createConnection, type Socket } from 'node:net'
import { createRequire } from 'node:module'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createDevSupervisor } = require('../../../scripts/dev-supervisor-core.cjs') as {
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
    const supervisor = createDevSupervisor({
      token: 'integration-token',
      spawnRuntime: () => {
        const child = spawn(process.execPath, ['-e', "console.log(require('node:crypto').randomUUID()); setInterval(() => {}, 1000)"], { stdio: 'pipe' }) as ChildProcessWithoutNullStreams
        child.stdout.once('data', (chunk) => instanceIds.push(chunk.toString('utf8').trim()))
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
    socket.end()
    supervisor.stop()
  })
})
