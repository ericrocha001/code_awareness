import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { NgrokTransport } from './ngrok-transport'

function agent() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as string | null,
    kill: vi.fn(() => { queueMicrotask(() => { child.exitCode = 0; child.emit('close', 0) }); return true })
  })
  return child
}

const local = 'http://127.0.0.1:12345/mcp'
const config = { publicDomain: 'stable.ngrok.app' }
const signal = () => new AbortController().signal

describe('ngrok process adapter', () => {
  it('does not report RUNNING until public HTTPS forwards, even after the agent readiness log', async () => {
    const child = agent()
    let confirm!: (ready: boolean) => void
    const probe = vi.fn(() => new Promise<boolean>((resolve) => { confirm = resolve }))
    const transport = new NgrokTransport(() => child as unknown as ChildProcess, 2_000, probe)
    const started = transport.start(local, config, signal())
    await vi.waitFor(() => expect(transport.getState().status).toBe('STARTING'))
    child.stdout.write('{"msg":"started tunnel","url":"https://stable.ngrok.app"}\n')
    await vi.waitFor(() => expect(probe).toHaveBeenCalled())
    expect(transport.getState().status).toBe('STARTING')
    confirm(true)
    await started
    expect(transport.getState().status).toBe('RUNNING')
    await transport.stop()
  })
  it('requires an exact stable domain, disables capture, shares start and owns only its child', async () => {
    const child = agent()
    const unrelated = agent()
    const spawn = vi.fn(() => child as unknown as ChildProcess)
    const transport = new NgrokTransport(spawn, 2_000, async () => true)
    const first = transport.start(local, config, signal())
    expect(transport.start(local, config, signal())).toBe(first)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    expect(spawn.mock.calls[0]).toEqual([['http', 'http://127.0.0.1:12345', '--url', 'https://stable.ngrok.app', '--inspect=false', '--log=stdout', '--log-format=json', '--log-level=info']])
    child.stdout.write('{"msg":"started tunnel","url":"https://stable.ngrok.app"}\n')
    await expect(first).resolves.toEqual({ externalEndpoint: 'https://stable.ngrok.app/mcp' })
    await transport.start(local, config, signal())
    expect(spawn).toHaveBeenCalledTimes(1)
    await Promise.all([transport.stop(), transport.stop(), transport.stop()])
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(unrelated.kill).not.toHaveBeenCalled()
    expect(transport.getState()).toEqual({ status: 'STOPPED' })
  })

  it('rejects absent/invalid domain and non-loopback upstream before spawning', async () => {
    const spawn = vi.fn()
    const transport = new NgrokTransport(spawn, 2_000, async () => true)
    await expect(transport.start(local, {}, signal())).rejects.toMatchObject({ code: 'NGROK_DOMAIN_NOT_CONFIGURED' })
    await expect(transport.start(local, { publicDomain: 'https://host.test/secret' }, signal())).rejects.toMatchObject({ code: 'NGROK_DOMAIN_INVALID' })
    await expect(transport.start('http://example.com/mcp', config, signal())).rejects.toMatchObject({ code: 'MCP_NOT_RUNNING' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each(['missing', 'authentication', 'unexpected', 'identity', 'timeout', 'abort'] as const)('cleans up and sanitizes %s failures', async (scenario) => {
    const child = agent()
    const transport = new NgrokTransport(() => child as unknown as ChildProcess, scenario === 'timeout' ? 50 : 2_000, async () => true)
    const states: unknown[] = []
    transport.onChanged((state) => states.push(state))
    const controller = new AbortController()
    const started = transport.start(local, config, controller.signal)
    const expected = { missing: 'NGROK_NOT_FOUND', authentication: 'NGROK_NOT_AUTHENTICATED', identity: 'TRANSPORT_IDENTITY_CHANGED', timeout: 'NGROK_START_TIMEOUT', abort: 'NGROK_START_FAILED' }
    const assertion = scenario === 'unexpected' ? started : expect(started).rejects.toMatchObject({ code: expected[scenario] })
    await vi.waitFor(() => expect(transport.getState().status).toBe('STARTING'))
    if (scenario === 'missing') { child.emit('error', Object.assign(new Error('sensitive'), { code: 'ENOENT' })); child.exitCode = -1; child.emit('close', -1) }
    if (scenario === 'authentication') { child.stderr.write('secret ERR_NGROK_4018 secret-token\n'); child.exitCode = 1; child.emit('close', 1) }
    if (scenario === 'identity') child.stdout.write('{"msg":"started tunnel","url":"https://random.ngrok.app"}\n')
    if (scenario === 'abort') controller.abort()
    if (scenario === 'unexpected') {
      child.stdout.write('{"msg":"started tunnel","url":"https://stable.ngrok.app"}\n')
      await started
      child.exitCode = 1
      child.emit('close', 1)
      expect(transport.getState()).toEqual({ status: 'ERROR', error: 'NGROK_EXITED' })
    }
    await assertion
    await transport.stop()
    expect(JSON.stringify(states)).not.toContain('secret')
    expect(child.exitCode).not.toBeNull()
  })
})
