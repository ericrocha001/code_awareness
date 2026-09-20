import { createServer, type IncomingMessage } from 'node:http'
import { WebSocketServer } from 'ws'
import type { AuthorizationProviderPort } from '../../../src/shared/distribution/authorization-ports'
import type { CloudflareAccessAssertionVerifierPort } from '../domain/cloudflare-access-assertion-verifier'
import { parseRelayMessage, MAX_RELAY_BYTES, MAX_REQUEST_BYTES, RELAY_PROTOCOL, RelayError, type InstallationId, type UserId } from '../../../src/shared/distribution/relay-protocol'
import { InstallationRouter, type Installation, type InstallationRegistry, type RelaySessionDirectory } from '../domain/installation-router'
import { verifyInstallationCredential } from '../domain/installation-credential'
import { PublicMcpGateway } from '../domain/public-mcp-gateway'
import { EnrollmentService } from '../domain/enrollment-service'
import type { ExternalIdentityResolverPort, VerifiedExternalIdentity } from '../domain/external-identity-resolver'
import { MemoryInstallationRegistry } from '../domain/memory-installation-registry'
import { RelaySession } from '../domain/relay-session'
export { MemoryInstallationRegistry } from '../domain/memory-installation-registry'

export class MemoryExternalIdentityResolver implements ExternalIdentityResolverPort {
  private readonly identities = new Map<string, UserId>()
  private readonly users = new Set<UserId>()

  private key(identity: VerifiedExternalIdentity): string {
    return `${identity.issuer}::${identity.subject}`
  }

  addUser(userId: UserId): void {
    this.users.add(userId)
  }

  async resolve(identity: VerifiedExternalIdentity): Promise<UserId | null> {
    return this.identities.get(this.key(identity)) ?? null
  }

  async resolveOrCreate(identity: VerifiedExternalIdentity, _nowIso: string): Promise<UserId> {
    const existing = await this.resolve(identity)
    if (existing) return existing
    const newId = crypto.randomUUID() as UserId
    this.users.add(newId)
    this.identities.set(this.key(identity), newId)
    return newId
  }

  async link(identity: VerifiedExternalIdentity, canonicalUserId: UserId, _nowIso: string): Promise<void> {
    this.users.add(canonicalUserId)
    const existing = await this.resolve(identity)
    if (existing) {
      if (existing === canonicalUserId) return
      throw new RelayError('FORBIDDEN')
    }
    this.identities.set(this.key(identity), canonicalUserId)
  }
}

export async function createLocalGateway(
  registry: MemoryInstallationRegistry,
  accessAssertions: CloudflareAccessAssertionVerifierPort,
  enrollmentAuthorization?: AuthorizationProviderPort,
  enrollmentService?: EnrollmentService,
  identityResolver?: ExternalIdentityResolverPort
) {
  const sessions = new Map<InstallationId, { session: RelaySession; credentialHash: string }>()
  const directory: RelaySessionDirectory = {
    async isOnline(id) {
      const current = sessions.get(id), row = await registry.get(id)
      if (!current) return false
      if (!row || row.status !== 'ACTIVE' || row.credentialHash !== current.credentialHash) { current.session.close('INSTALLATION_REVOKED'); return false }
      return current.session.isOnline()
    },
    async invoke(id, body, requestId) {
      if (!await directory.isOnline(id)) throw new RelayError('INSTALLATION_OFFLINE')
      return sessions.get(id)!.session.invoke(body, requestId)
    },
    async delivered(id, requestId, durationMs) {
      const current = sessions.get(id)
      if (current) current.session.acknowledgeHttpReturned(requestId, durationMs)
    }
  }
  let gateway: PublicMcpGateway
  const server = createServer(async (request, response) => {
    try {
      const body = await readRequest(request)
      const headers = new Headers()
      for (const [key, value] of Object.entries(request.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value)
      const result = await gateway.fetch(new Request(`${origin}${request.url}`, { method: request.method, headers, ... (!['GET', 'HEAD'].includes(request.method!) ? { body } : {}) }))
      response.writeHead(result.status, Object.fromEntries(result.headers))
      response.end(Buffer.from(await result.arrayBuffer()))
    } catch { response.writeHead(400); response.end() }
  })
  const websocket = new WebSocketServer({ server, maxPayload: MAX_RELAY_BYTES, perMessageDeflate: false })
  websocket.on('connection', (socket) => {
    let session: RelaySession | null = null
    let installation: InstallationId | null = null
    let queue = Promise.resolve()
    const timeout = setTimeout(() => socket.terminate(), 5_000)
    socket.on('error', () => {})
    socket.on('message', (raw, binary) => {
      queue = queue.then(async () => {
        if (binary) throw new RelayError('INVALID_MESSAGE')
        const message = parseRelayMessage(raw.toString())
        if (!session) {
          if (message.type !== 'hello') throw new RelayError('INVALID_MESSAGE')
          const row = await registry.get(message.installationId)
          if (!row || row.status !== 'ACTIVE' || !await verifyInstallationCredential(message.credential, row.credentialHash)) throw new RelayError('INVALID_CREDENTIAL')
          if (socket.readyState !== socket.OPEN) return
          installation = row.id
          sessions.get(row.id)?.session.close('SESSION_REPLACED')
          session = new RelaySession({ send: (message) => socket.send(message), close: () => socket.close() })
          sessions.set(row.id, { session, credentialHash: row.credentialHash })
          clearTimeout(timeout)
          session.ready()
        } else {
          if (!await directory.isOnline(installation!)) return
          session.receive(message)
        }
      }).catch((error) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ protocol: RELAY_PROTOCOL, type: 'error', code: error instanceof RelayError ? error.code : 'RELAY_CLOSED' }))
        socket.close()
      })
    })
    socket.on('close', () => {
      clearTimeout(timeout)
      session?.close()
      if (installation && sessions.get(installation)?.session === session) sessions.delete(installation)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const resource = `${origin}/mcp`
  const resolver = identityResolver ?? new MemoryExternalIdentityResolver()
  const enroll = enrollmentService ?? (enrollmentAuthorization ? new EnrollmentService(registry, registry, enrollmentAuthorization, resolver, resource) : undefined)
  gateway = new PublicMcpGateway(accessAssertions, resolver, new InstallationRouter(registry, directory), enroll)
  return {
    origin,
    endpoint: resource,
    directory,
    enrollment: enroll,
    resolver,
    async close() {
      for (const { session } of sessions.values()) session.close()
      for (const socket of websocket.clients) socket.terminate()
      await new Promise<void>((resolve) => websocket.close(() => resolve()))
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
    }
  }
}

async function readRequest(request: IncomingMessage): Promise<string> {
  const parts: Buffer[] = []
  let bytes = 0
  for await (const part of request) {
    bytes += part.length
    if (bytes > MAX_REQUEST_BYTES) throw new RelayError('PAYLOAD_TOO_LARGE')
    parts.push(part)
  }
  return Buffer.concat(parts).toString('utf8')
}
