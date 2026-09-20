import type { AuthenticatedPrincipal } from '../../../src/shared/distribution/authorization-ports'
import { installationId, MAX_REQUEST_BYTES, newRequestId, RelayError, type UserId } from '../../../src/shared/distribution/relay-protocol'
import { CloudflareAccessAssertionError, type CloudflareAccessAssertionVerifierPort } from './cloudflare-access-assertion-verifier'
import type { ExternalIdentityResolverPort, VerifiedExternalIdentity } from './external-identity-resolver'
import type { InstallationRouter } from './installation-router'
import { EnrollmentService } from './enrollment-service'

export class PublicMcpGateway {
  constructor(
    private readonly accessAssertions: CloudflareAccessAssertionVerifierPort,
    private readonly identityResolver: ExternalIdentityResolverPort,
    private readonly router: InstallationRouter,
    private readonly enrollment?: EnrollmentService
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const origin = url.origin

    if (url.pathname.startsWith('/enroll')) {
      if (!this.enrollment) return Response.json({ category: 'relay', code: 'LOCAL_MCP_UNAVAILABLE' }, { status: 503 })
      return this.handleEnrollment(request, url, origin)
    }

    if (url.pathname !== '/mcp') return new Response(null, { status: 404 })

    const requestId = newRequestId()
    const startedAt = Date.now()
    const accessLog = (stage: string, status: 'started' | 'success' | 'error', error?: string): void => console.log('[Access]', JSON.stringify({
      component: 'public-gateway', stage, requestId, timestamp: new Date().toISOString(),
      durationMs: Date.now() - startedAt, deadlineRemainingMs: Math.max(0, 30_000 - (Date.now() - startedAt)), status, ...(error ? { error } : {})
    }))
    accessLog('gateway-request-started', 'started')
    const unauthorized = () => Response.json({ category: 'auth', code: 'UNAUTHORIZED' }, {
      status: 403,
      headers: { 'Cache-Control': 'no-store' }
    })

    const assertion = request.headers.get('cf-access-jwt-assertion')
    if (!assertion) {
      accessLog('access-assertion-received', 'error', 'ACCESS_ASSERTION_MISSING')
      return unauthorized()
    }

    accessLog('access-assertion-received', 'success')
    let identity: VerifiedExternalIdentity
    let relayLog: ((stage: string, status: 'started' | 'success' | 'error', error?: string) => void) | null = null
    try {
      identity = await this.accessAssertions.verify(assertion)
    } catch (error) {
      accessLog('access-assertion-validated', 'error', error instanceof CloudflareAccessAssertionError ? error.code : 'ACCESS_ASSERTION_INVALID')
      return unauthorized()
    }
    accessLog('access-assertion-validated', 'success')

    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })

    try {
      const canonicalUserId = await this.identityResolver.resolve(identity)
      if (!canonicalUserId) {
        accessLog('identity-resolved', 'error', 'IDENTITY_NOT_LINKED')
        console.log('[Access]', JSON.stringify({
          component: 'public-gateway',
          stage: 'identity-unlinked-details',
          requestId,
          timestamp: new Date().toISOString(),
          status: 'error',
          issuer: identity.issuer,
          subject: identity.subject
        }))
        throw new RelayError('IDENTITY_NOT_LINKED')
      }
      const principal: AuthenticatedPrincipal = { id: canonicalUserId }

      const body = await this.readBody(request)
      const selection = request.headers.get('x-code-awareness-installation')
      let method = 'unknown', tool = 'unknown'
      try {
        const message = JSON.parse(body) as { method?: unknown; params?: { name?: unknown } }
        method = typeof message.method === 'string' ? message.method : 'unknown'
        tool = method === 'tools/call' && typeof message.params?.name === 'string' ? message.params.name : method
      } catch {}
      relayLog = (stage: string, status: 'started' | 'success' | 'error', error?: string): void => {
        const elapsed = Date.now() - startedAt
        console.log('[Relay]', JSON.stringify({
          component: 'public-gateway', stage, requestId, sessionId: null, method, tool,
          timestamp: new Date().toISOString(), durationMs: elapsed,
          deadlineRemainingMs: Math.max(0, 30_000 - elapsed), status,
          ...(error ? { error } : {})
        }))
      }
      relayLog('gateway-request-started', 'started')
      relayLog('client-request-received', 'started')
      const response = await this.router.forward(principal, body, selection ? installationId(selection) : undefined, requestId)
      relayLog('gateway-response-produced', 'success')
      relayLog('http-response-returned', 'success')
      relayLog('client-response-completed', 'success')
      if (response.installationId) {
        void this.router.notifyDelivered(response.installationId, requestId, Date.now() - startedAt).catch(() => {})
      }
      return new Response(response.status === 204 ? null : response.body, {
        status: response.status,
        headers: { ...(response.contentType ? { 'Content-Type': response.contentType } : {}), 'Cache-Control': 'no-store' }
      })
    } catch (error) {
      relayLog?.('http-response-returned', 'error', error instanceof RelayError ? error.code : 'RELAY_CLOSED')
      relayLog?.('client-response-completed', 'error', error instanceof RelayError ? error.code : 'RELAY_CLOSED')
      return this.handleRelayError(error)
    }
  }

  private async handleEnrollment(request: Request, url: URL, origin: string): Promise<Response> {
    try {
      if (url.pathname === '/enroll/begin' && request.method === 'POST') {
        const input = JSON.parse(await this.readBody(request))
        const output = await this.enrollment!.beginEnrollment(input, origin)
        return Response.json(output, { status: 200, headers: { 'Cache-Control': 'no-store' } })
      }

      if (url.pathname === '/enroll/claim' && request.method === 'POST') {
        const token = request.headers.get('authorization')?.match(/^Bearer ([^\s,]+)$/i)?.[1]
        if (!token) return Response.json({ category: 'auth', code: 'UNAUTHORIZED' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
        let inst
        try {
          const input = JSON.parse(await this.readBody(request))
          inst = await this.enrollment!.claimEnrollment(token, input)
        } catch (err: any) {
          if (err?.name === 'Auth0AuthorizationError' || err?.code === 'AUTH_INVALID' || err?.code === 'AUTH_EXPIRED' || err?.code === 'AUTH_MISSING') {
            return Response.json({ category: 'auth', code: 'UNAUTHORIZED' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
          }
          throw err
        }
        return Response.json({ installationId: inst.id, status: inst.status }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
      }

      if (url.pathname.startsWith('/enroll/status/') && request.method === 'GET') {
        const enrollmentId = url.pathname.slice('/enroll/status/'.length)
        const status = await this.enrollment!.getStatus(enrollmentId)
        return Response.json(status, { status: 200, headers: { 'Cache-Control': 'no-store' } })
      }

      return new Response(null, { status: 404 })
    } catch (error) {
      return this.handleRelayError(error)
    }
  }

  private async readBody(request: Request): Promise<string> {
    const reader = request.body?.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    let body = '', length = 0
    if (reader) while (true) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > MAX_REQUEST_BYTES) { await reader.cancel(); throw new RelayError('PAYLOAD_TOO_LARGE') }
      body += decoder.decode(part.value, { stream: true })
    }
    body += decoder.decode()
    return body
  }

  private handleRelayError(error: unknown): Response {
    const code = error instanceof RelayError ? error.code : 'RELAY_CLOSED'
    const status =
      code === 'IDENTITY_NOT_LINKED' || code === 'FORBIDDEN' || code === 'INSTALLATION_REVOKED' ? 403 :
      code === 'REQUEST_TIMEOUT' ? 504 :
      code === 'INVALID_MESSAGE' || code === 'PAYLOAD_TOO_LARGE' || code === 'INVALID_CREDENTIAL' ? 400 :
      503
    const category = code === 'IDENTITY_NOT_LINKED' ? 'auth' : 'relay'
    return Response.json({ category, code }, { status, headers: { 'Cache-Control': 'no-store' } })
  }
}
