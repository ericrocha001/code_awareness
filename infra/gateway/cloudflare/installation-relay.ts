import { DurableObject } from 'cloudflare:workers'
import { installationId, parseRelayMessage, RELAY_PROTOCOL, RelayError, requestId, type ConnectionId, type InstallationId } from '../../../src/shared/distribution/relay-protocol'
import { verifyInstallationCredential } from '../domain/installation-credential'
import { RelaySession } from '../domain/relay-session'
import { D1InstallationRegistry } from './d1-installation-registry'

export interface RelayEnvironment {
  REGISTRY: D1Database
  RELAY: DurableObjectNamespace
  CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string
  CLOUDFLARE_ACCESS_AUD?: string
  AUTHORIZATION_SERVER?: string
}
interface SessionAttachment { installationId: InstallationId; connectionId?: ConnectionId; credentialHash?: string }

export class InstallationRelay extends DurableObject<RelayEnvironment> {
  private readonly sessions = new Map<WebSocket, RelaySession>()
  private readonly registry: D1InstallationRegistry

  constructor(ctx: DurableObjectState, env: RelayEnvironment) {
    super(ctx, env)
    this.registry = new D1InstallationRegistry(env.REGISTRY)
    for (const socket of ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SessionAttachment
      if (attachment.connectionId && attachment.credentialHash) this.sessions.set(socket, this.session(socket, attachment.connectionId))
      else socket.close(1008, 'RELAY_CLOSED')
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      let id: InstallationId
      try { id = installationId(url.pathname.split('/')[2]) } catch { return new Response(null, { status: 400 }) }
      if (this.ctx.id.toString() !== this.env.RELAY.idFromName(id).toString()) return new Response(null, { status: 403 })
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      this.ctx.acceptWebSocket(server)
      server.serializeAttachment({ installationId: id } satisfies SessionAttachment)
      const timeout = setTimeout(() => { if (!this.sessions.has(server)) server.close(1008, 'INVALID_CREDENTIAL') }, 5_000)
      this.ctx.waitUntil(new Promise<void>((resolve) => setTimeout(() => { clearTimeout(timeout); resolve() }, 5_100)))
      return new Response(null, { status: 101, webSocket: client })
    }
    const live = await this.liveSession()
    if (!live) return new Response(null, { status: 503, headers: { 'x-code-awareness-relay-error': 'INSTALLATION_OFFLINE' } })
    if (url.pathname === '/online' && request.method === 'GET') return new Response(null, { status: 200 })
    if (url.pathname === '/delivered' && request.method === 'POST') {
      const durationMs = Number(request.headers.get('x-code-awareness-duration-ms') ?? '0')
      live.acknowledgeHttpReturned(requestId(request.headers.get('x-code-awareness-request-id')), durationMs)
      return new Response(null, { status: 204 })
    }
    if (url.pathname !== '/invoke' || request.method !== 'POST') return new Response(null, { status: 404 })
    try {
      const response = await live.invoke(await request.text(), requestId(request.headers.get('x-code-awareness-request-id')))
      return new Response(response.status === 204 ? null : response.body, { status: response.status, headers: response.contentType ? { 'content-type': response.contentType } : {} })
    } catch (error) {
      return new Response(null, { status: 503, headers: { 'x-code-awareness-relay-error': error instanceof RelayError ? error.code : 'RELAY_CLOSED' } })
    }
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    try {
      if (typeof raw !== 'string') throw new RelayError('INVALID_MESSAGE')
      const message = parseRelayMessage(raw)
      const attachment = socket.deserializeAttachment() as SessionAttachment
      let session = this.sessions.get(socket)
      if (!session) {
        if (message.type !== 'hello' || message.installationId !== attachment.installationId) throw new RelayError('INVALID_MESSAGE')
        const row = await this.registry.get(message.installationId)
        if (!row || row.status !== 'ACTIVE' || !await verifyInstallationCredential(message.credential, row.credentialHash)) throw new RelayError('INVALID_CREDENTIAL')
        for (const [previous, old] of this.sessions) { old.close('SESSION_REPLACED'); this.sessions.delete(previous) }
        session = this.session(socket)
        socket.serializeAttachment({ installationId: row.id, credentialHash: row.credentialHash, connectionId: session.connectionId } satisfies SessionAttachment)
        this.sessions.set(socket, session)
        session.ready()
      } else {
        if (!await this.authorized(socket)) { session.close('INSTALLATION_REVOKED'); return }
        session.receive(message)
      }
    } catch (error) {
      try { socket.send(JSON.stringify({ protocol: RELAY_PROTOCOL, type: 'error', code: error instanceof RelayError ? error.code : 'RELAY_CLOSED' })) } catch {}
      socket.close(1008, 'RELAY_CLOSED')
    }
  }

  webSocketClose(socket: WebSocket): void { this.sessions.get(socket)?.close(); this.sessions.delete(socket) }
  webSocketError(socket: WebSocket): void { this.webSocketClose(socket) }

  private session(socket: WebSocket, connectionId?: ConnectionId): RelaySession {
    return new RelaySession({ send: (raw) => socket.send(raw), close: () => { try { socket.close(1000, 'RELAY_CLOSED') } catch {} } }, 30_000, connectionId)
  }

  private async authorized(socket: WebSocket): Promise<boolean> {
    const attachment = socket.deserializeAttachment() as SessionAttachment
    const row = await this.registry.get(attachment.installationId)
    return !!row && row.status === 'ACTIVE' && row.credentialHash === attachment.credentialHash
  }

  private async liveSession(): Promise<RelaySession | null> {
    for (const [socket, session] of this.sessions) {
      if (session.isOnline() && await this.authorized(socket)) return session
      session.close('INSTALLATION_REVOKED')
      this.sessions.delete(socket)
    }
    return null
  }
}
