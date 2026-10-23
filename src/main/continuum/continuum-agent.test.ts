import { afterEach, expect, it } from 'vitest'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { fixture, markdown } from './continuum-test-fixtures'
import { RepositoryContinuumSession } from './project-continuum-session'
import { ContinuumLocalChannel } from './local-channel'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { createMcpHttpServer } from '../mcp/mcp-http-server'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import { CONTINUUM_AGENT_TOOLS } from './continuum-agent'
const cleanup: (() => void)[] = []
afterEach(() => { cleanup.reverse().forEach(close => close()); cleanup.length = 0 })

it('registers dedicated tools and enforces strict atomic CAS via real MCP HTTP and authenticated local pipe', async () => {
  const f = fixture(); cleanup.push(f.close)
  const root = join(f.dir, 'repo'), profile = join(f.dir, 'profile'); mkdirSync(root)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' })
  git('init'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'baseline')
  const session = new RepositoryContinuumSession(join(f.dir, 'storage'), { findByPath: () => ({ id: 'A', localCheckout: { path: root } }) }, { ingestCheckout: false }); session.activate(root); cleanup.push(() => session.dispose())
  const service = session.getActiveService()!, one = service.publish(markdown('Literal'))
  const adapter = new ChannelMcpAdapter({ projectId: 'A', repoRoot: root, navigation: {} as ProjectContextNavigation, continuum: service })
  const server = createMcpHttpServer(adapter, () => {})
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const rpc = async (method: string, params: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    expect(response.status).toBe(200); return ((await response.json()) as { result: any }).result
  }
  const call = (name: string, args: unknown) => rpc('tools/call', { name, arguments: args })
  const read = async (name: string, args: unknown) => { const result = await call(name, args); expect(result.isError).not.toBe(true); return JSON.parse(result.content[0].text) }
  const channel = new ContinuumLocalChannel(session, profile); await channel.start()
  const descriptor = JSON.parse(readFileSync(join(profile, 'continuum-local', 'endpoint.json'), 'utf8'))
  const local = (operation: string, args: object = {}, token = descriptor.token): Promise<any> => new Promise((resolve, reject) => {
    const socket = createConnection(descriptor.endpoint); let response = ''
    socket.setEncoding('utf8'); socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify({ protocol: 'continuum-local/v1', token, operation, ...args }) + '\n'))
    socket.on('data', chunk => { response += chunk; if (response.endsWith('\n')) { socket.destroy(); resolve(JSON.parse(response)) } })
  })
  try {
    const advertised = await rpc('tools/list', {})
    for (const tool of CONTINUUM_AGENT_TOOLS) expect(advertised.tools.find((item: { name: string }) => item.name === tool.name)?.inputSchema.additionalProperties).toBe(false)
    const status = await local('status'), worktreeId = status.result.worktrees.find((item: { path: string }) => item.path.replace(/\\/g, '/').toLowerCase() === root.replace(/\\/g, '/').toLowerCase()).worktreeId
    const selected = [{ artifactId: one.artifactId, expectedRevision: 1 }], scope = { repositoryId: 'A', worktreeId }
    expect((await local('list_continuum_tags', scope, 'forged')).error.code).toBe('UNAUTHORIZED')
    expect((await local('list_continuum_tags', { ...scope, repositoryId: 'B' })).error.code).toBe('REPOSITORY_MISMATCH')
    expect((await local('list_continuum_tags', { ...scope, worktreeId: 'forged' })).error.code).toBe('WORKTREE_UNLINKED')
    const created = await read('create_continuum_tag', { name: 'Contexto rápido', selected })
    expect(created).toMatchObject({ state: 'PERSISTED', creation: 'CREATED', tag: { slug: 'contexto-rapido', count: 1 }, artifacts: [{ revision: 2 }] })
    expect(created.tag).toEqual({ slug: 'contexto-rapido', name: 'Contexto rápido', count: 1 })
    for (const removed of [{ color: '#123456' }, { description: 'Removed objective' }]) {
      expect((await call('create_continuum_tag', { name: 'Rejected field', ...removed })).isError).toBe(true)
      expect((await local('create_continuum_tag', { ...scope, name: 'Rejected field', ...removed })).error.code).toBe('INVALID_ARGUMENT')
    }
    expect((await read('create_continuum_tag', { name: 'Contexto rápido' })).creation).toBe('EXISTING')
    expect((await call('create_continuum_tag', { name: 'Contexto rapido' })).isError).toBe(true)
    expect((await call('create_continuum_tag', { name: 'Orphan', selected })).isError).toBe(true)
    expect(service.tags().some(tag => tag.slug === 'orphan')).toBe(false)
    expect((await local('list_continuum_tags', scope)).result.tags[0].count).toBe(1)
    expect((await local('list', { ...scope, filter: { tag: 'contexto-rapido' } })).result.artifacts.map((a: { artifactId: string }) => a.artifactId)).toEqual([one.artifactId])
    const receipt = await local('assign_continuum_tag', { ...scope, slug: 'contexto-rapido', action: 'add', selected: [{ artifactId: one.artifactId, expectedRevision: 2 }] })
    expect(receipt.result.artifacts[0].revision).toBe(2)
    expect((await local('assign_continuum_tag', { ...scope, slug: 'contexto-rapido', action: 'add', selected })).error.code).toBe('REVISION_CONFLICT')
    for (const args of [{ slug: 'contexto-rapido', action: 'add', selected: [...selected, ...selected] }, { slug: 'contexto-rapido', action: 'add', selected, confirmed: true }, { slug: 'contexto-rapido', action: 'add', selected: [{ ...selected[0], expectedRevision: '2' }] }]) expect((await call('assign_continuum_tag', args)).isError).toBe(true)
    const current = service.get(one.artifactId)!
    expect((await call('update_artifact', { artifactId: one.artifactId, expectedRevision: 2, rawMarkdown: markdown('Removed') })).isError).toBe(true)
    expect((await local('update', { ...scope, artifactId: one.artifactId, expectedRevision: 2, rawMarkdown: markdown('Removed') })).error.code).toBe('HUMAN_TAG_AUTHORSHIP_REQUIRED')
    const preview = await read('create_context_bundle', { tag: 'contexto-rapido' })
    expect(preview).toMatchObject({ outcome: 'preview', count: 1, hasVisuals: false }); expect(preview).not.toHaveProperty('markdown'); expect(preview).not.toHaveProperty('objective')
    expect((await local('create_context_bundle', { ...scope, tag: 'contexto-rapido', action: 'preview' })).result).toMatchObject({ count: 1, outcome: 'preview' })
    expect((await call('create_context_bundle', { tag: 'contexto-rapido', action: 'zip', path: '/arbitrary' })).isError).toBe(true)
    expect((await local('create_context_bundle', { ...scope, tag: 'contexto-rapido', action: 'markdown' })).error.code).toBe('INTERACTIVE_SESSION_REQUIRED')
    expect(service.get(one.artifactId)!.contentHash).toBe(current.contentHash)
    expect((await local('assign_continuum_tag', { ...scope, slug: 'contexto-rapido', action: 'remove', selected: [{ artifactId: one.artifactId, expectedRevision: 2 }] })).result.artifacts[0].revision).toBe(3)
    expect((await call('create_context_bundle', { tag: 'contexto-rapido' })).isError).toBe(true)
    session.deactivate()
    expect((await local('list_continuum_tags', scope)).error.code).toBe('NO_ACTIVE_REPOSITORY')
    expect((await call('list_continuum_tags', {})).isError).toBe(true)
  } finally { channel.dispose(); await new Promise<void>(resolve => server.close(() => resolve())) }
}, 30000)
