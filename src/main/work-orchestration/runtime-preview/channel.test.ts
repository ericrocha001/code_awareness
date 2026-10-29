import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { startPreviewChannel } from './channel-server'
import { invokePreviewChannel } from './channel-client'
import type { PreviewContextManifest } from './context-contract'
import type { NativeOwner } from './native-owner'
import { RuntimePreviewOperations } from './operations'
import { executeRuntimePreviewTool } from './mcp'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0 })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'preview-channel-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const checkout = join(root, 'checkout'); await mkdir(checkout); await writeFile(join(checkout, 'feature.ts'), 'export const feature = true')
  const scope = { sessionId: randomUUID(), repositoryId: 'selected-repository', worktreeId: 'tree', generation: 'generation' }
  const context = { sessionId: scope.sessionId, selection: scope, worktree: checkout,
    source: { head: 'head', branch: 'feature', indexRevision: 'index', worktreeRevision: 'source', dirty: false } } as unknown as PreviewContextManifest
  let current = true
  const token = 'a'.repeat(64), close = await startPreviewChannel(context, token, root, () => current ? { continuum: { state: 'UNAVAILABLE' } } : undefined)
  cleanup.push(close)
  const endpoint = JSON.parse(await readFile(join(root, 'channel.json'), 'utf8'))
  const owner = { endpoint: vi.fn(async () => ({ port: endpoint.port, listeners: [{ pid: process.pid, created: 'creation-identity', member: true, loopback: true }] })),
    inspect: vi.fn(async () => ({ rootSignaled: false, assignedAtCreation: true, jobClosed: false })) } as unknown as NativeOwner
  const call = (operation: string, input = {}, target = scope) => invokePreviewChannel(context, root, token, owner, target, operation, input,
    { pid: process.pid, runtime: process.versions.node, abi: process.versions.modules })
  return { context, root, scope, endpoint, token, owner, call, close, stale: () => { current = false } }
}

it('uses the authenticated peer and actual capability catalog; never falls back for unsupported or mutable operations', async () => {
  const f = await fixture()
  const identity = await f.call('runtime.identity')
  expect(identity.result).toMatchObject({ success: true, data: { kind: 'IDENTITY', identity: { pid: process.pid, ...f.scope } } })
  expect((await f.call('runtime.capabilities')).result).toMatchObject({ success: true, data: { version: 1, capabilities: expect.arrayContaining([{ operation: 'runtime.identity', input: expect.any(Object) }]), readiness: { continuum: { state: 'UNAVAILABLE' } } } })
  expect((await f.call('checkout.list')).result).toMatchObject({ success: true, data: { entries: [{ name: 'feature.ts' }] } })
  expect((await f.call('runtime.restart')).result).toEqual({ success: false, code: 'CAPABILITY_UNAVAILABLE' })
  expect((await f.call('checkout.list', { path: '../host' })).result).toEqual({ success: false, code: 'SCOPE_REJECTED' })
  expect(JSON.stringify(identity)).not.toContain(f.token)
  expect(JSON.stringify(identity)).not.toContain(f.endpoint.port.toString())
})
it('rejects scope, credentials, non-member processes and PID replacement; revokes stale contexts', async () => {
  const f = await fixture()
  expect((await f.call('runtime.liveness', {}, { ...f.scope, repositoryId: 'visually-active-other-repository' })).result).toEqual({ success: false, code: 'SCOPE_REJECTED' })
  const response = await fetch(`http://127.0.0.1:${f.endpoint.port}/`, { method: 'POST', headers: { 'X-Preview-Channel-Token': 'é'.repeat(64) } })
  expect(response.status).toBe(403)
  vi.mocked(f.owner.endpoint).mockResolvedValueOnce({ port: f.endpoint.port, listeners: [{ pid: process.pid, created: 'creation-identity', member: false, loopback: true }] })
  await expect(f.call('runtime.identity')).rejects.toThrow('SCOPE_REJECTED')
  const original = await f.owner.endpoint(f.endpoint.port)
  vi.mocked(f.owner.endpoint).mockResolvedValueOnce(original).mockResolvedValueOnce({ ...original, listeners: [{ ...original.listeners[0], created: 'replacement' }] })
  await expect(f.call('runtime.identity')).rejects.toThrow('SESSION_STALE')
  f.stale()
  expect((await f.call('runtime.liveness')).result).toEqual({ success: false, code: 'SESSION_STALE' })
})
it('routes canonical knowledge by the exact session repository and fails explicitly after Host project switching', async () => {
  const f = await fixture(), get = vi.fn(() => ({ artifactId: 'artifact', rawMarkdown: 'selected repository knowledge' }))
  let repositoryId = f.scope.repositoryId
  const runner = { invokeChannel: vi.fn(async (scope, operation, input, guard) => { guard(); const value = await f.call(operation, input, scope); guard(); return value }) }
  const canonical = { get }
  const service = new RuntimePreviewOperations({ resolve: () => ({ guard() {} }) } as never, {} as never, {} as never, runner as never, async () => false, undefined,
    { getActiveSession: () => ({ repositoryId }) as never, getActiveService: () => canonical as never })
  const request = { scope: f.scope, operation: 'continuum.get', input: { artifactId: 'artifact' } }
  expect(await service.invokeChannel(request)).toMatchObject({ success: true, data: { target: 'HOST_CANONICAL', repositoryId: f.scope.repositoryId } })
  expect(get).toHaveBeenCalledTimes(1)
  repositoryId = 'another-repository'
  expect(await service.invokeChannel(request)).toEqual({ success: false, code: 'PREVIEW_UNAVAILABLE' })
  expect(get).toHaveBeenCalledTimes(1)
  expect(await service.invokeChannel({ ...request, operation: 'continuum.publish' })).toEqual({ success: false, code: 'CAPABILITY_UNAVAILABLE' })
  const discovery = await executeRuntimePreviewTool(service, 'discover_runtime_preview_capabilities', { scope: f.scope }, () => {})
  expect(discovery.isError).toBeUndefined()
  expect(JSON.stringify(discovery)).not.toContain(f.token)
})
