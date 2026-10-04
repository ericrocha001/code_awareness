import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalGateway, MemoryInstallationRegistry } from '../testing/local-gateway'
import { provisionCanonicalRelayIdentity } from '../testing/canonical-relay-identity-fixture'
import { type UserId } from '../../../src/shared/distribution/relay-protocol'
import { McpLifecycle } from '../../../src/main/mcp/mcp-lifecycle'
import { RelayTransport } from '../../../src/main/mcp/connection/relay-transport'
import { ConnectionLifecycle } from '../../../src/main/mcp/connection/connection-lifecycle'
import { ContextNavigationError } from '../../../src/shared/types/context-navigation-types'
import { CodeScopeHealthMonitor, type CodeScopeTraceEvent } from '../../../src/main/mcp/code-scope-health'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function setup() {
  const issuer = 'https://test.cloudflareaccess.com'
  const registry = new MemoryInstallationRegistry()
  const gateway = await createLocalGateway(registry, { async verify(assertion) {
    if (!['user-a', 'user-b'].includes(assertion)) throw new Error('secret-invalid-assertion')
    return { issuer, subject: assertion }
  } })
  cleanup.push(() => gateway.close())
  async function desktop(user: string, trace?: import('../../../src/main/mcp/code-scope-health').CodeScopeTraceSink) {
    const canonicalId = `canonical-${user}` as UserId
    const identity = await provisionCanonicalRelayIdentity({
      identityResolver: gateway.resolver,
      installationRegistry: registry,
      externalIdentity: { issuer, subject: user },
      canonicalUserId: canonicalId
    })
    const mcp = new McpLifecycle({ log: () => {}, trace })
    const navigation = {
      discoverRepository: vi.fn(async () => ({ directories: [{ relativePath: '.', children: [user] }] })),
      getRelationships: vi.fn(async () => ({ files: [] })), inspectFiles: vi.fn(async () => ({ files: [] })),
      readCode: vi.fn(async () => { throw new ContextNavigationError('ELEMENT_NOT_FOUND', 'missing target') })
    }
    const relay = new RelayTransport(gateway.endpoint, { getId: () => identity.installationId, getCredential: () => identity.credential }, 30_000, 25_000, trace)
    const connection = new ConnectionLifecycle(mcp, relay, () => ({}), () => {})
    cleanup.push(async () => { await connection.dispose(); await mcp.dispose() })
    await mcp.activate(user, navigation)
    expect((await connection.connect()).success).toBe(true)
    return { id: identity.installationId, mcp, connection, navigation, canonicalId, relay }
  }
  const call = async (assertion?: string, selected?: string, method = 'tools/call', params: unknown = { name: 'discover_repository', arguments: {} }) => {
    const response = await fetch(gateway.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(assertion ? { 'Cf-Access-Jwt-Assertion': assertion } : {}), ...(selected ? { 'x-code-awareness-installation': selected } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    return { status: response.status, headers: response.headers, body: await response.json() as any }
  }
  return { registry, gateway, desktop, call }
}

describe('authenticated gateway and local relay', () => {
  it('isolates users, preserves MCP errors and stores no source or tool responses', async () => {
    const f = await setup()
    const a = await f.desktop('user-a'), b = await f.desktop('user-b')
    const before = JSON.stringify(await f.registry.listOwned(a.canonicalId))
    const own = await f.call('user-a', a.id)
    expect(own.status).toBe(200)
    expect(own.body.result.content[0].text).toBe('[.]\nuser-a')
    expect((await f.call('user-a', b.id)).status).toBe(403)
    expect(b.navigation.discoverRepository).not.toHaveBeenCalled()
    const implicit = await f.call('user-a')
    expect(implicit.status).toBe(200)
    expect(implicit.body.result.content[0].text).toBe('[.]\nuser-a')
    expect(b.navigation.discoverRepository).not.toHaveBeenCalled()
    const negative = await f.call('user-a', a.id, 'tools/call', { name: 'read_code', arguments: { targetIds: ['target:missing:full'] } })
    expect(negative.status).toBe(200)
    expect(JSON.stringify(negative.body)).toContain('ELEMENT_NOT_FOUND')
    expect(JSON.stringify(await f.registry.listOwned(a.canonicalId))).toBe(before)
    await f.registry.revoke(a.id, a.canonicalId)
    expect((await f.call('user-a', a.id)).status).toBe(403)
    expect(await f.gateway.directory.isOnline(a.id)).toBe(false)
  })
  it('requires a Cloudflare Access assertion without exposing competing OAuth metadata', async () => {
    const f = await setup()
    const missing = await f.call()
    const metadata = await fetch(new URL('/.well-known/oauth-protected-resource/mcp', f.gateway.endpoint))
    expect(metadata.status).toBe(404)
    expect(missing.status).toBe(403)
    expect(missing.headers.get('www-authenticate')).toBeNull()
    expect((await f.call('invalid')).status).toBe(403)
    const unlinked = await f.call('user-a')
    expect(unlinked.status).toBe(403)
    expect(unlinked.body.code).toBe('IDENTITY_NOT_LINKED')

    await f.gateway.resolver.link({ issuer: 'https://test.cloudflareaccess.com', subject: 'user-a' }, 'canonical-user-a' as UserId, new Date().toISOString())
    const offline = await f.call('user-a')
    expect(offline.status).toBe(503)
    expect(offline.body.code).toBe('INSTALLATION_OFFLINE')
  })
  it('rejects ambiguous installations and forwards concurrent calls without mixing MCP IDs', async () => {
    const f = await setup()
    const a = await f.desktop('user-a')
    await f.desktop('user-a')
    expect((await f.call('user-a')).body.code).toBe('INSTALLATION_AMBIGUOUS')
    const results = await Promise.all(['initialize', 'tools/list', 'tools/call'].map((method) => f.call('user-a', a.id, method, method === 'tools/call' ? { name: 'discover_repository', arguments: {} } : {})))
    expect(results.every((result) => result.status === 200)).toBe(true)
    expect(results[0].body.result.serverInfo).toBeDefined()
    expect(results[1].body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'discover_repository', 'get_relationships', 'inspect_files', 'get_references', 'get_symbol_dependencies', 'get_symbol_hierarchy', 'read_code', 'get_system_health', 'get_runtime_identity'
    ])
    expect(results[2].body.result.content[0].text).toBe('[.]\nuser-a')
    await a.connection.disconnect()
    expect((await f.call('user-a', a.id)).body.code).toBe('INSTALLATION_OFFLINE')
  })

  it('tracks the full operational lifecycle across all stages and delivered acknowledgments', async () => {
    const f = await setup()
    const recordedEvents: CodeScopeTraceEvent[] = []
    const health = new CodeScopeHealthMonitor()
    health.onChanged(() => {})
    const traceSink = {
      record(event: CodeScopeTraceEvent) {
        recordedEvents.push(event)
        health.record(event)
      }
    }
    const a = await f.desktop('user-a', traceSink)
    const result = await f.call('user-a', a.id, 'tools/call', { name: 'discover_repository', arguments: {} })
    expect(result.status).toBe(200)
    expect(result.body.result.content[0].text).toBe('[.]\nuser-a')

    await vi.waitFor(() => expect(health.getState().status).toBe('OPERATIONAL'))
    const state = health.getState()
    expect(state.lastSuccessfulToolCall).toBe('discover_repository')
    expect(state.lastError).toBeNull()
    expect(typeof state.lastStageLatencyMs).toBe('number')

    const stages = recordedEvents.map((e) => e.stage)
    expect(stages).toContain('desktop-connection-established')
    expect(stages).toContain('desktop-request-received')
    expect(stages).toContain('mcp-request-started')
    expect(stages).toContain('codescope-request-started')
    expect(stages).toContain('codescope-response-produced')
    expect(stages).toContain('mcp-response-produced')
    expect(stages).toContain('mcp-response-sent')
    expect(stages).toContain('desktop-relay-response-sent')
    expect(stages).toContain('relay-response-delivered')
    expect(stages).toContain('gateway-response-delivered')

    for (const event of recordedEvents) {
      expect(typeof event.durationMs).toBe('number')
      expect(event.durationMs).toBeGreaterThanOrEqual(0)
    }

    const established = recordedEvents.find((e) => e.stage === 'desktop-connection-established')
    expect(established?.installationId).toBe(a.id)
    expect(typeof established?.sessionId).toBe('string')
    expect(established?.sessionId).not.toBe('none')
  })

  it('preserves functional tool error to client without degrading operational health', async () => {
    const f = await setup()
    const recordedEvents: CodeScopeTraceEvent[] = []
    const health = new CodeScopeHealthMonitor()
    const traceSink = {
      record(event: CodeScopeTraceEvent) {
        recordedEvents.push(event)
        health.record(event)
      }
    }
    const a = await f.desktop('user-a', traceSink)
    const result = await f.call('user-a', a.id, 'tools/call', { name: 'read_code', arguments: { targetIds: ['target:missing:full'] } })
    expect(result.status).toBe(200)
    expect(result.body.result.isError).toBe(true)
    expect(result.body.result.content[0].text).toContain('ELEMENT_NOT_FOUND')

    await vi.waitFor(() => expect(health.getState().status).toBe('OPERATIONAL'))
    const state = health.getState()
    expect(state.lastSuccessfulToolCall).toBe('read_code')

    const responseSent = recordedEvents.find((e) => e.stage === 'mcp-response-sent')
    expect(responseSent).toBeDefined()
    expect(responseSent?.status).toBe('success')
  })

  it('proves valid response delivered near deadline without race condition', async () => {
    const f = await setup()
    const a = await f.desktop('user-a')
    a.navigation.discoverRepository = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80))
      return { directories: [{ relativePath: '.', children: ['delayed-user-a'] }] }
    })
    const result = await f.call('user-a', a.id, 'tools/call', { name: 'discover_repository', arguments: {} })
    expect(result.status).toBe(200)
    expect(result.body.result.content[0].text).toBe('[.]\ndelayed-user-a')
  })
})
