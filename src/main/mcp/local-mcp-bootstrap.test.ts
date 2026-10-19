import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { LocalChannelHost } from '../local-agent-channel/local-channel-host'
import { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'
import { McpLifecycle } from './mcp-lifecycle'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'

const require = createRequire(resolve('package.json'))
const { discover } = require(resolve('scripts/local-mcp/bootstrap.cjs'))
const { start } = require(resolve('scripts/local-mcp/launcher.cjs'))
const cleanups: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup() {
  const profile = mkdtempSync(join(tmpdir(), 'mcp-bootstrap-'))
  cleanups.push(() => rmSync(profile, { recursive: true, force: true }))
  const identity = new RuntimeIdentityProvider({ rootDir: profile, packaged: true })
  const lifecycle = new McpLifecycle({ runtimeIdentity: identity, log: () => {} })
  cleanups.push(() => lifecycle.dispose())
  const navigation = {
    discoverRepository: async () => ({ directories: [{ relativePath: '.', children: ['proof.ts'] }] }),
    readCode: async () => []
  } as unknown as ProjectContextNavigation
  await lifecycle.activate('project-A', navigation)
  const host = new LocalChannelHost([], profile, () => lifecycle.getLocalEndpoint(identity.getInstanceId()))
  await host.start()
  cleanups.push(() => host.dispose())
  async function connect() {
    const client = new Client({ name: 'bootstrap-proof', version: '1' })
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [resolve('out/local-mcp/launcher.cjs'), '--profile', profile, '--project', 'project-A'], stderr: 'pipe' })
    let diagnostics = ''
    await client.connect(transport)
    transport.stderr?.on('data', chunk => { diagnostics += chunk })
    cleanups.push(() => client.close())
    return { client, diagnostics: () => diagnostics }
  }
  return { profile, identity, lifecycle, navigation, connect }
}

describe('authenticated IPC to Desktop MCP over real STDIO', () => {
  it('preserves the full catalog, identity and read-only tools; reconnects after port change without config edits', async () => {
    const fixture = await setup()
    const first = await discover(fixture.profile, 'project-A')
    const { client } = await fixture.connect()
    const identity = await client.callTool({ name: 'get_runtime_identity', arguments: {} })
    expect(JSON.parse((identity.content as { text: string }[])[0].text).runtime.instanceId).toBe(fixture.identity.getInstanceId())
    const repository = await client.callTool({ name: 'discover_repository', arguments: {} })
    expect(JSON.stringify(repository)).toContain('proof.ts')
    const direct = await fetch(first.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }).then(response => response.json()) as { result: { tools: unknown[] } }
    expect((await client.request({ method: 'tools/list' }, ResultSchema)).tools).toEqual(direct.result.tools)
    await fixture.lifecycle.deactivate()
    await fixture.lifecycle.activate('project-A', fixture.navigation)
    const next = await discover(fixture.profile, 'project-A')
    expect(next.bindingId).not.toBe(first.bindingId)
    expect(next.endpoint).not.toBe(first.endpoint)
    await expect(client.listTools()).rejects.toThrow(/INVALIDATED/)
    const reconnected = await fixture.connect()
    expect((await reconnected.client.listTools()).tools.length).toBe(direct.result.tools.length)
    await fixture.lifecycle.activate('project-B', fixture.navigation)
    await expect(reconnected.client.callTool({ name: 'discover_repository', arguments: {} })).rejects.toThrow(/INVALIDATED/)
    await expect(discover(fixture.profile, 'project-A')).rejects.toThrow(/PROJECT_MISMATCH/)
    await fixture.lifecycle.deactivate()
    await expect(discover(fixture.profile)).rejects.toThrow(/UNAVAILABLE/)
  }, 45000)

  it('rejects stale credentials and wrong profiles without selecting another instance', async () => {
    const fixture = await setup()
    await expect(discover(join(fixture.profile, 'absent'))).rejects.toMatchObject({ code: 'APP_UNAVAILABLE' })
    const path = join(fixture.profile, 'local-agent-channel', 'endpoint.json')
    const original = readFileSync(path, 'utf8')
    writeFileSync(path, JSON.stringify({ ...JSON.parse(original), token: 'stale' }))
    await expect(discover(fixture.profile)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    writeFileSync(path, original)
  }, 15000)

  it('refuses unexpected instance headers before calling a tool on the backend', async () => {
    const fixture = await setup()
    const endpoint = await discover(fixture.profile)
    const response = await fetch(endpoint.endpoint, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-code-awareness-instance': 'other',
      'x-code-awareness-project': endpoint.projectId, 'x-code-awareness-binding': endpoint.bindingId
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'discover_repository', arguments: {} } }) })
    expect(response.status).toBe(409)
    expect(await response.text()).toContain('MCP_SESSION_INVALIDATED')
  }, 15000)

  it('bounds a stalled backend request and keeps stdout as MCP messages', async () => {
    const fixture = await setup()
    const input = new PassThrough(), output = new PassThrough()
    const bootstrap = await start({ profile: fixture.profile, input, output, timeoutMs: 3000 })
    cleanups.push(() => bootstrap.close())
    const client = new Client({ name: 'timeout-proof', version: '1' })
    await client.connect(new StdioServerTransport(output, input))
    cleanups.push(() => client.close())
    await client.notification({ method: 'notifications/bootstrap-probe' })
    expect((await client.listTools()).tools.length).toBeGreaterThan(0)
    fixture.navigation.discoverRepository = () => new Promise(() => {})
    await expect(client.callTool({ name: 'discover_repository', arguments: {} })).rejects.toThrow(/BACKEND_UNAVAILABLE|timed out/)
    await expect(client.listTools()).rejects.toThrow(/INVALIDATED/)
  }, 15000)
})
