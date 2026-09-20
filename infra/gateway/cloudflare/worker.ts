import type { AuthorizationProviderPort } from '../../../src/shared/distribution/authorization-ports'
import { installationId, RelayError, type RelayErrorCode } from '../../../src/shared/distribution/relay-protocol'
import { InstallationRouter, type RelaySessionDirectory } from '../domain/installation-router'
import { PublicMcpGateway } from '../domain/public-mcp-gateway'
import { EnrollmentService } from '../domain/enrollment-service'
import { CloudflareAccessAssertionVerifier, type CloudflareAccessAssertionVerifierPort } from '../domain/cloudflare-access-assertion-verifier'
import { D1InstallationRegistry } from './d1-installation-registry'
import { D1ExternalIdentityResolver } from './d1-external-identity-resolver'
import type { RelayEnvironment } from './installation-relay'
export { InstallationRelay } from './installation-relay'

export function gatewayFor(
  env: RelayEnvironment,
  resource: string,
  accessAssertions: CloudflareAccessAssertionVerifierPort,
  enrollmentAuthorization?: AuthorizationProviderPort,
  enrollment?: EnrollmentService
): PublicMcpGateway {
  const registry = new D1InstallationRegistry(env.REGISTRY)
  const identityResolver = new D1ExternalIdentityResolver(env.REGISTRY)
  const sessions: RelaySessionDirectory = {
    async isOnline(id) { return (await env.RELAY.get(env.RELAY.idFromName(id)).fetch('https://relay.internal/online')).status === 200 },
    async invoke(id, body, requestId) {
      const response = await env.RELAY.get(env.RELAY.idFromName(id)).fetch('https://relay.internal/invoke', { method: 'POST', headers: { 'x-code-awareness-request-id': requestId }, body })
      const error = response.headers.get('x-code-awareness-relay-error')
      if (error) throw new RelayError(error as RelayErrorCode)
      return { status: response.status, contentType: response.headers.get('content-type') ?? '', body: await response.text() }
    },
    async delivered(id, requestId, durationMs) {
      await env.RELAY.get(env.RELAY.idFromName(id)).fetch('https://relay.internal/delivered', {
        method: 'POST',
        headers: {
          'x-code-awareness-request-id': requestId,
          'x-code-awareness-duration-ms': String(durationMs)
        }
      }).catch(() => {})
    }
  }
  const router = new InstallationRouter(registry, sessions)
  const enroll = enrollment ?? (enrollmentAuthorization ? new EnrollmentService(registry, registry, enrollmentAuthorization, identityResolver, resource) : undefined)
  return new PublicMcpGateway(accessAssertions, identityResolver, router, enroll)
}

export async function relayUpgrade(request: Request, env: RelayEnvironment): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/relay/')) return null
  try {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 })
    const id = installationId(url.pathname.slice('/relay/'.length))
    return env.RELAY.get(env.RELAY.idFromName(id)).fetch(request)
  } catch { return new Response(null, { status: 400 }) }
}

import { Auth0AuthorizationProvider } from '../domain/auth0-authorization-provider'

let cachedAccess: { teamDomain: string; audience: string; verifier: CloudflareAccessAssertionVerifier } | undefined

function accessVerifierFor(env: RelayEnvironment): CloudflareAccessAssertionVerifier {
  const teamDomain = env.CLOUDFLARE_ACCESS_TEAM_DOMAIN ?? ''
  const audience = env.CLOUDFLARE_ACCESS_AUD ?? ''
  if (cachedAccess?.teamDomain === teamDomain && cachedAccess.audience === audience) return cachedAccess.verifier
  const verifier = new CloudflareAccessAssertionVerifier({ teamDomain, audience })
  cachedAccess = { teamDomain, audience, verifier }
  return verifier
}

export default {
  async fetch(request: Request, env: RelayEnvironment): Promise<Response> {
    const relay = await relayUpgrade(request, env)
    if (relay) return relay
    const resource = `${new URL(request.url).origin}/mcp`
    let accessAssertions
    try {
      accessAssertions = accessVerifierFor(env)
    } catch {
      return Response.json({ category: 'auth', code: 'ACCESS_CONFIGURATION_ERROR' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
    }
    const enrollmentAuthorization = new URL(request.url).pathname.startsWith('/enroll') && env.AUTHORIZATION_SERVER
      ? new Auth0AuthorizationProvider({ issuer: env.AUTHORIZATION_SERVER, audience: resource })
      : undefined
    return gatewayFor(env, resource, accessAssertions, enrollmentAuthorization).fetch(request)
  }
}
