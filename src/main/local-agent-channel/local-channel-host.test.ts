import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { LocalChannelHost, LOCAL_MAX_BYTES } from './local-channel-host'
import { operation } from './local-channel-types'
import { object } from './request-validation'

describe('domain-neutral local host', () => {
  let host: LocalChannelHost, profile: string
  const sockets: Socket[] = []
  afterEach(() => { sockets.splice(0).forEach(socket => socket.destroy()); host?.dispose(); if (profile) rmSync(profile, { recursive: true, force: true }) })
  async function setup() {
    profile = mkdtempSync(join(tmpdir(), 'local-host-'))
    host = new LocalChannelHost([{ domain: 'probe', operations: {
      echo: operation(input => object(input, ['value']), input => input),
      large: operation(input => object(input, []), () => 'x'.repeat(LOCAL_MAX_BYTES * 2))
    } }], profile)
    await host.start()
    const descriptor = JSON.parse(readFileSync(join(profile, 'local-agent-channel/endpoint.json'), 'utf8'))
    const request = (payload: object) => new Promise<any>((resolve, reject) => {
      const socket = createConnection(descriptor.endpoint); sockets.push(socket)
      let raw = ''; socket.setEncoding('utf8'); socket.once('error', reject)
      socket.once('connect', () => socket.write(JSON.stringify({ protocol: descriptor.protocol, token: descriptor.token, ...payload }) + '\n'))
      socket.on('data', data => { raw += data; if (raw.endsWith('\n')) resolve(JSON.parse(raw)) })
    })
    return { descriptor, request }
  }
  it('routes only explicit registered actions and rejects schema/protocol/domain violations', async () => {
    const { request, descriptor } = await setup()
    expect((await request({ domain: 'channel', action: 'status', args: {} })).result).toEqual({ available: true, domains: ['probe'] })
    expect((await request({ domain: 'probe', action: 'echo', args: { value: 'literal' } })).result).toEqual({ value: 'literal' })
    for (const payload of [{ domain: 'absent', action: 'echo', args: {} }, { domain: 'probe', action: 'constructor', args: {} }, { domain: 'probe', action: 'archive', args: {} }]) expect((await request(payload)).error.code).toBe('METHOD_NOT_FOUND')
    expect((await request({ domain: 'probe', action: 'echo', args: { command: 'bad' } })).error.code).toBe('INVALID_ARGUMENT')
    expect((await request({ domain: 'probe', action: 'echo', args: {}, path: 'bad' })).error.code).toBe('INVALID_ARGUMENT')
    expect((await request({ domain: 'probe', action: 'echo', args: {}, protocol: 'wrong' })).error.code).toBe('INVALID_ARGUMENT')
    const legacy = JSON.parse(readFileSync(join(profile, 'continuum-local/endpoint.json'), 'utf8'))
    expect(legacy.endpoint).toBe(descriptor.endpoint); expect(legacy.token).toBe(descriptor.token)
  })
  it('fails explicitly on oversized responses and bounds simultaneous connections', async () => {
    const { request, descriptor } = await setup()
    expect((await request({ domain: 'probe', action: 'large', args: {} })).error.code).toBe('RESPONSE_TOO_LARGE')
    await new Promise<void>(resolve => setImmediate(resolve))
    sockets.splice(0).forEach(socket => socket.destroy())
    await new Promise<void>(resolve => setImmediate(resolve))
    for (let index = 0; index < 16; index++) {
      const socket = createConnection(descriptor.endpoint); sockets.push(socket)
      await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.once('connect', resolve) })
    }
    const excess = createConnection(descriptor.endpoint); sockets.push(excess)
    await new Promise<void>(resolve => { excess.once('close', () => resolve()); excess.once('error', () => resolve()) })
    expect(excess.destroyed).toBe(true)
    host.dispose()
    expect(existsSync(join(profile, 'local-agent-channel/endpoint.json'))).toBe(false)
    expect(existsSync(join(profile, 'continuum-local/endpoint.json'))).toBe(false)
  }, 10000)
})
