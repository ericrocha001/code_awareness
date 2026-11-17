import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { createLocalGateway, MemoryInstallationRegistry } from '../testing/local-gateway'
import { provisionCanonicalRelayIdentity } from '../testing/canonical-relay-identity-fixture'
import { type UserId } from '../../../src/shared/distribution/relay-protocol'
import type { SessionContextPort } from '../../../src/main/session-context/mcp'
import { McpLifecycle } from '../../../src/main/mcp/mcp-lifecycle'
import { RelayTransport } from '../../../src/main/mcp/connection/relay-transport'
import { ConnectionLifecycle } from '../../../src/main/mcp/connection/connection-lifecycle'
import { CloudflareAccessAssertionError, CloudflareAccessAssertionVerifier } from './cloudflare-access-assertion-verifier'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

describe('Cloudflare Access assertion to PublicMcpGateway', () => {
  const issuer = 'https://code-awareness.cloudflareaccess.com'
  const audience = 'cloudflare-access-application-aud'

  async function createKey(kid = 'kid-1') {
    const pair = await generateKeyPair('RS256')
    const publicJwk = await exportJWK(pair.publicKey)
    publicJwk.kid = kid
    publicJwk.alg = 'RS256'
    publicJwk.use = 'sig'
    return { ...pair, kid, publicJwk }
  }

  async function signAssertion(key: Awaited<ReturnType<typeof createKey>>, subject: string, options?: { audience?: string; issuer?: string; expiresIn?: string }) {
    return new SignJWT({ sub: subject, email: `${subject}@example.com` })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid })
      .setIssuer(options?.issuer ?? issuer)
      .setAudience(options?.audience ?? audience)
      .setIssuedAt()
      .setExpirationTime(options?.expiresIn ?? '1h')
      .sign(key.privateKey)
  }

  async function setup() {
    const key = await createKey('access-gateway')
    const registry = new MemoryInstallationRegistry()
    const verifier = new CloudflareAccessAssertionVerifier({
      teamDomain: issuer,
      audience,
      jwksFetcher: async () => key.publicKey
    })
    const gateway = await createLocalGateway(registry, verifier)
    cleanup.push(() => gateway.close())

    async function desktop(user: string, sessionContext?: SessionContextPort) {
      const canonicalId = `canonical-${user}` as UserId
      const identity = await provisionCanonicalRelayIdentity({
        identityResolver: gateway.resolver,
        installationRegistry: registry,
        externalIdentity: { issuer, subject: user },
        canonicalUserId: canonicalId
      })
      const mcp = new McpLifecycle({ log: () => {} })
      const navigation = {
        discoverRepository: vi.fn(async () => ({ directories: [{ relativePath: '.', children: [user] }] })),
        getRelationships: vi.fn(async () => ({ files: [] })), inspectFiles: vi.fn(async () => ({ files: [] })),
        readCode: vi.fn(async () => [])
      }
      const relay = new RelayTransport(gateway.endpoint, { getId: () => identity.installationId, getCredential: () => identity.credential })
      const connection = new ConnectionLifecycle(mcp, relay, () => ({}), () => {})
      cleanup.push(async () => { await connection.dispose(); await mcp.dispose() })
      await mcp.activateContext({ projectId: user, repoRoot: '', navigation, sessionContext })
      expect((await connection.connect()).success).toBe(true)
      return { id: identity.installationId, navigation, connection, mcp }
    }

    const call = async (assertion?: string, selected?: string, message: unknown = {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'discover_repository', arguments: {} }
    }, metadataHeaders: Record<string, string> = {}) => {
      const response = await fetch(gateway.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...metadataHeaders,
          ...(assertion ? { 'Cf-Access-Jwt-Assertion': assertion } : {}),
          ...(selected ? { 'x-code-awareness-installation': selected } : {})
        },
        body: JSON.stringify(message)
      })
      return { status: response.status, headers: response.headers, body: await response.json() as any }
    }

    return { key, gateway, desktop, call }
  }

  it('fails closed when the Access team domain or application audience is absent or invalid', () => {
    expect(() => new CloudflareAccessAssertionVerifier({ teamDomain: '', audience })).toThrow(CloudflareAccessAssertionError)
    expect(() => new CloudflareAccessAssertionVerifier({ teamDomain: issuer, audience: '' })).toThrow(CloudflareAccessAssertionError)
    expect(() => new CloudflareAccessAssertionVerifier({ teamDomain: 'late-dream-327b.cloudflareaccess.com', audience })).toThrow(CloudflareAccessAssertionError)
  })

  it('denies missing and malformed assertions without an origin OAuth challenge', async () => {
    const fixture = await setup()
    const forgedKey = await createKey('forged')
    const missing = await fixture.call()
    const malformed = await fixture.call('not-a-jwt')
    const forged = await fixture.call(await signAssertion(forgedKey, 'user-a'))
    expect(missing.status).toBe(403)
    expect(malformed.status).toBe(403)
    expect(forged.status).toBe(403)
    expect(missing.headers.get('www-authenticate')).toBeNull()
    expect(malformed.body.code).toBe('UNAUTHORIZED')
  })

  it.each([
    ['wrong audience', { audience: 'different-access-app' }],
    ['wrong issuer', { issuer: 'https://different.cloudflareaccess.com' }],
    ['expired assertion', { expiresIn: '-10s' }]
  ])('denies %s', async (_label, options) => {
    const fixture = await setup()
    const assertion = await signAssertion(fixture.key, 'user-a', options)
    expect((await fixture.call(assertion)).status).toBe(403)
  })

  it('uses the verified Access subject for installation ownership and routes to CodeScope', async () => {
    const fixture = await setup()
    const userA = await fixture.desktop('user-a')
    const userB = await fixture.desktop('user-b')
    const assertionA = await signAssertion(fixture.key, 'user-a')
    const assertionB = await signAssertion(fixture.key, 'user-b')

    const own = await fixture.call(assertionA, userA.id)
    expect(own.status).toBe(200)
    expect(own.body.result.content[0].text).toBe('[.]\nuser-a')

    expect((await fixture.call(assertionA, userB.id)).status).toBe(403)
    expect(userB.navigation.discoverRepository).not.toHaveBeenCalled()
    expect((await fixture.call(assertionB, userB.id)).status).toBe(200)
  })

  it('preserves modern status, cache policy, and JSON across the authenticated Gateway and Relay', async () => {
    const fixture = await setup()
    const call = vi.fn<SessionContextPort['call']>(async () => ({
      content: [{ type: 'text', text: '{"workLink":"FOUND"}' }]
    }))
    const desktop = await fixture.desktop('modern-user', { call })
    const assertion = await signAssertion(fixture.key, 'modern-user')
    const state = desktop.connection.getState()
    if (state.status !== 'CONNECTED') throw new Error('Relay did not connect')
    const version = '2026-07-28'
    const meta = { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {} }
    const arguments_ = { selector: { type: 'PR', id: '141' }, view: 'WORK' }
    const calls = [
      { method: 'server/discover', params: {} },
      { method: 'tools/list', params: {} },
      { method: 'tools/call', params: { name: 'discover_execution_context', arguments: arguments_ } }
    ]
    for (const { method, params } of calls) {
      const message = { jsonrpc: '2.0', id: method, method, params: { ...params, _meta: meta } }
      const headers = { 'mcp-protocol-version': version, 'mcp-method': method, ...(params.name && { 'mcp-name': params.name }) }
      const local = await fetch(state.localEndpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', ...desktop.mcp.getAgentBindingHeaders(), ...headers },
        body: JSON.stringify(message)
      })
      const publicResponse = await fixture.call(assertion, desktop.id, message, headers)
      expect(publicResponse.status).toBe(local.status)
      expect(publicResponse.status).toBe(200)
      expect(publicResponse.headers.get('content-type')).toBe(local.headers.get('content-type'))
      expect(publicResponse.headers.get('cache-control')).toBe('no-store')
      expect(publicResponse.headers.get('cache-control')).toBe(local.headers.get('cache-control'))
      expect(publicResponse.body).toEqual(await local.json())
      expect(publicResponse.body.result.resultType).toBe('complete')
      expect((await fixture.call(undefined, desktop.id, message, headers)).status).toBe(403)
    }
    expect(call).toHaveBeenCalledTimes(2)
    expect(call).toHaveBeenCalledWith('discover_execution_context', arguments_)
  })

  it('rejects verified assertion with 403 IDENTITY_NOT_LINKED when external identity has no canonical link', async () => {
    const fixture = await setup()
    const assertion = await signAssertion(fixture.key, 'unlinked-user')
    const response = await fixture.call(assertion)
    expect(response.status).toBe(403)
    expect(response.body.code).toBe('IDENTITY_NOT_LINKED')
  })
})
