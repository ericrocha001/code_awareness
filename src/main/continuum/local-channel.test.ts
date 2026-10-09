import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { ContinuumLocalChannel, LOCAL_MAX_BYTES } from './local-channel'
import type { RepositoryContinuumSession } from './project-continuum-session'

const mocks = vi.hoisted(() => ({ discover: vi.fn(), revalidate: vi.fn() }))
vi.mock('../core/git-service', () => ({ GitService: class {} }))
vi.mock('../git-operations/git-worktree-registry', () => ({ GitWorktreeRegistry: class {
  discover = mocks.discover
  revalidateSelection = mocks.revalidate
} }))

describe('Continuum local transport boundaries', () => {
  let channel: ContinuumLocalChannel, profile: string
  const clients: Socket[] = []
  afterEach(() => { for (const client of clients.splice(0)) client.destroy(); channel?.dispose(); if (profile) rmSync(profile, { recursive: true, force: true }); vi.resetAllMocks() })
  async function setup(active: object | null = null) {
    profile = mkdtempSync(join(tmpdir(), 'continuum-channel-'))
    let current = active
    const publish = vi.fn(() => ({ success: true, artifactId: 'new', revision: 1, updatedAt: 'now' }))
    channel = new ContinuumLocalChannel({ getActiveSession: () => current, getActiveService: () => ({ publish }) } as unknown as RepositoryContinuumSession, profile)
    await channel.start()
    const descriptor = JSON.parse(readFileSync(join(profile, 'continuum-local', 'endpoint.json'), 'utf8'))
    const request = (value: unknown) => new Promise<any>((resolve, reject) => {
      const socket = createConnection(descriptor.endpoint); clients.push(socket)
      let response = ''
      socket.setEncoding('utf8'); socket.on('error', reject)
      socket.on('connect', () => socket.write(JSON.stringify({ protocol: 'continuum-local/v1', token: descriptor.token, ...value as object }) + '\n'))
      socket.on('data', data => { response += data; if (response.endsWith('\n')) resolve(JSON.parse(response)) })
    })
    return { descriptor, request, publish, switchRepository: () => { current = null } }
  }
  it('rejects unauthenticated/malformed requests and reports absent active repository', async () => {
    const { request } = await setup()
    expect((await request({ operation: 'status', token: 'invalid' })).error.code).toBe('UNAUTHORIZED')
    expect((await request({ operation: 'status', protocol: 'wrong' })).error.code).toBe('INVALID_ARGUMENT')
    expect((await request({ operation: 'status' })).result).toEqual({ available: true, repository: null })
    expect((await request({ operation: 'list', repositoryId: 'wrong' })).error.code).toBe('NO_ACTIVE_REPOSITORY')
  })
  it('rejects a repository switch during worktree validation before committing', async () => {
    const { request, publish, switchRepository } = await setup({ repositoryId: 'A', repositoryPath: profile })
    mocks.discover.mockResolvedValue({ worktrees: [] })
    mocks.revalidate.mockImplementation(async () => { switchRepository() })
    expect((await request({ operation: 'publish', repositoryId: 'B', worktreeId: 'w', rawMarkdown: 'raw' })).error.code).toBe('REPOSITORY_MISMATCH')
    expect(mocks.discover).not.toHaveBeenCalled()
    expect((await request({ operation: 'publish', repositoryId: 'A', worktreeId: 'w', rawMarkdown: 'raw' })).error.code).toBe('REPOSITORY_MISMATCH')
    expect(publish).not.toHaveBeenCalled()
  })
  it('bounds frame size and removes endpoint discovery and open connections on shutdown', async () => {
    const { descriptor } = await setup()
    const socket = createConnection(descriptor.endpoint); clients.push(socket)
    const response = await new Promise<string>((resolve, reject) => {
      let data = ''; socket.setEncoding('utf8'); socket.on('error', reject)
      socket.on('connect', () => socket.write('x'.repeat(LOCAL_MAX_BYTES + 1)))
      socket.on('data', chunk => { data += chunk; if (data.endsWith('\n')) resolve(data) })
    })
    expect(JSON.parse(response).error.code).toBe('REQUEST_TOO_LARGE')
    const idle = createConnection(descriptor.endpoint); clients.push(idle)
    await new Promise<void>(resolve => idle.once('connect', resolve))
    const closed = new Promise<void>(resolve => idle.once('close', () => resolve()))
    channel.dispose(); await closed
    expect(existsSync(join(profile, 'continuum-local', 'endpoint.json'))).toBe(false)
  })
})
