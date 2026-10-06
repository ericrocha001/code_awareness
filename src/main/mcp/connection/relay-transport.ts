import WebSocket from 'ws'
import { encodeRelayMessage, MAX_RELAY_BYTES, parseRelayMessage, RELAY_PROTOCOL, RelayError, type ConnectionId, type InstallationId, type RelayMessage, type RequestId } from '../../../shared/distribution/relay-protocol'
import { ConnectionError, type ConnectionConfiguration, type ConnectionTransportPort, type TransportState } from './connection-transport-port'
import type { ChannelTraceEvent, ChannelTraceSink } from '../../../shared/types/channel-types'

interface RelayIdentity { getId(): InstallationId; getCredential(): string | null }

function requestMetadata(body: string): { method: string; tool: string } {
  try {
    const message = JSON.parse(body) as { method?: unknown; params?: { name?: unknown } }
    const method = typeof message.method === 'string' ? message.method : 'unknown'
    return {
      method,
      tool: method === 'tools/call' && typeof message.params?.name === 'string' ? message.params.name : method
    }
  } catch {
    return { method: 'unknown', tool: 'unknown' }
  }
}

export class RelayTransport implements ConnectionTransportPort {
  readonly name = 'relay'
  private state: TransportState = { status: 'STOPPED' }
  private socket: WebSocket | null = null
  private controller: AbortController | null = null
  private starting: Promise<{ externalEndpoint: string }> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private readonly pending = new Map<RequestId, Promise<void>>()
  private readonly outcomes = new Map<RequestId, { tool: string }>()
  private readonly listeners = new Set<(state: TransportState) => void>()

  constructor(
    private readonly endpoint: string,
    private readonly identity: RelayIdentity,
    private readonly heartbeatMs = 30_000,
    private readonly requestTimeoutMs = 25_000,
    private readonly trace?: ChannelTraceSink
  ) {}

  getState(): TransportState { return { ...this.state } }
  onChanged(listener: (state: TransportState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(localEndpoint: string, _configuration: ConnectionConfiguration, signal: AbortSignal): Promise<{ externalEndpoint: string }> {
    if (this.starting) return this.starting
    if (this.socket) return Promise.reject(new ConnectionError('RELAY_BUSY'))
    const operation = this.launch(localEndpoint, signal)
    this.starting = operation
    void operation.finally(() => { if (this.starting === operation) this.starting = null }).catch(() => {})
    return operation
  }

  private async launch(localEndpoint: string, signal: AbortSignal): Promise<{ externalEndpoint: string }> {
    let publicUrl: URL, local: URL
    try { publicUrl = new URL(this.endpoint); local = new URL(localEndpoint) } catch { throw new ConnectionError('INVALID_MESSAGE') }
    if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/mcp' || (publicUrl.protocol !== 'https:' && !(publicUrl.protocol === 'http:' && publicUrl.hostname === '127.0.0.1'))) throw new ConnectionError('INVALID_MESSAGE')
    if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || !local.port || local.pathname !== '/mcp' || local.username || local.password || local.search || local.hash) throw new ConnectionError('MCP_NOT_RUNNING')
    let credential: string | null
    try {
      credential = this.identity.getCredential()
    } catch {
      console.warn('[RelayTransport] credential read failed at stage=read_credential code=INVALID_CREDENTIAL')
      throw new ConnectionError('INVALID_CREDENTIAL')
    }
    if (!credential) throw new ConnectionError('INVALID_CREDENTIAL')
    if (signal.aborted) throw new ConnectionError('RELAY_CLOSED')
    try {
      const id = this.identity.getId()
      const controller = new AbortController()
      this.controller = controller
      const relayUrl = new URL(`/relay/${id}`, publicUrl)
      relayUrl.protocol = publicUrl.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(relayUrl, { maxPayload: MAX_RELAY_BYTES, perMessageDeflate: false, handshakeTimeout: 10_000, followRedirects: false })
      this.socket = socket
      this.setState({ status: 'STARTING' })
      let connectionId: ConnectionId | null = null
      let awaitingPong = false
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => fail('REQUEST_TIMEOUT'), 10_000)
        const abort = () => fail('RELAY_CLOSED')
        const cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', abort) }
        const fail = (code: import('../../../shared/distribution/relay-protocol').RelayErrorCode) => {
          cleanup()
          reject(new ConnectionError(code))
          this.failConnection(code)
        }
        signal.addEventListener('abort', abort, { once: true })
        socket.on('error', () => fail('RELAY_CLOSED'))
        socket.on('close', () => fail('RELAY_CLOSED'))
        socket.on('open', () => {
          socket.send(encodeRelayMessage({ protocol: RELAY_PROTOCOL, type: 'hello', installationId: this.identity.getId(), credential, capabilities: ['mcp-http'] }))
        })
        socket.on('message', (raw, binary) => {
          try {
            if (binary) throw new RelayError('INVALID_MESSAGE')
            const message = parseRelayMessage(raw.toString())
            if (message.type === 'error') { fail(message.code); return }
            if (!connectionId) {
              if (message.type !== 'ready') throw new RelayError('INVALID_MESSAGE')
              connectionId = message.connectionId
              cleanup()
              this.heartbeat = setInterval(() => {
                if (awaitingPong) { fail('REQUEST_TIMEOUT'); return }
                awaitingPong = true
                this.send(socket, { protocol: RELAY_PROTOCOL, type: 'ping', connectionId: connectionId! }).catch(() => fail('RELAY_CLOSED'))
              }, this.heartbeatMs)
              resolve()
              return
            }
            if (!('connectionId' in message) || message.connectionId !== connectionId) throw new RelayError('INVALID_MESSAGE')
            if (message.type === 'pong') { awaitingPong = false; return }
            if (message.type === 'ping') { this.send(socket, { protocol: RELAY_PROTOCOL, type: 'pong', connectionId }).catch(() => fail('RELAY_CLOSED')); return }
            if (message.type === 'close') { fail('RELAY_CLOSED'); return }
            if (message.type === 'delivered') {
              const outcome = this.outcomes.get(message.requestId)
              if (message.stage === 'gateway-response-delivered') this.outcomes.delete(message.requestId)
              this.trace?.record({
                timestamp: new Date().toISOString(),
                requestId: message.requestId,
                sessionId: message.connectionId,
                method: 'tools/call',
                tool: outcome?.tool ?? '',
                stage: message.stage,
                durationMs: message.durationMs ?? 0,
                status: 'success'
              })
              return
            }
            if (message.type !== 'invoke' || this.pending.has(message.requestId)) throw new RelayError('INVALID_MESSAGE')
            if (this.pending.size >= 32) {
              this.send(socket, { protocol: RELAY_PROTOCOL, type: 'error', connectionId, requestId: message.requestId, code: 'RELAY_BUSY' }).catch(() => fail('RELAY_CLOSED'))
              return
            }
            const request = this.invoke(socket, localEndpoint, message, controller.signal).finally(() => this.pending.delete(message.requestId))
            this.pending.set(message.requestId, request)
          } catch (error) { fail(error instanceof RelayError ? error.code : 'INVALID_MESSAGE') }
        })
      })
      if (signal.aborted || controller.signal.aborted) throw new ConnectionError('RELAY_CLOSED')
      this.setState({ status: 'RUNNING', externalEndpoint: publicUrl.href })
      return { externalEndpoint: publicUrl.href }
    } catch (error) {
      await this.stop()
      throw error instanceof ConnectionError ? error : new ConnectionError('RELAY_CLOSED')
    }
  }

  private async invoke(socket: WebSocket, endpoint: string, message: Extract<RelayMessage, { type: 'invoke' }>, signal: AbortSignal): Promise<void> {
    const startedAt = performance.now()
    const metadata = requestMetadata(message.body)
    const record = (stage: ChannelTraceEvent['stage'], status: ChannelTraceEvent['status'], error?: string): void => {
      const elapsed = Math.round((performance.now() - startedAt) * 100) / 100
      const deadlineRemainingMs = Math.max(0, Math.round((this.requestTimeoutMs - elapsed) * 100) / 100)
      this.trace?.record({
        timestamp: new Date().toISOString(),
        requestId: message.requestId,
        sessionId: message.connectionId,
        method: metadata.method,
        tool: metadata.tool,
        stage,
        durationMs: elapsed,
        deadlineRemainingMs,
        status,
        ...(error ? { error } : {})
      })
    }
    record('desktop-request-received', 'started')
    record('relay-request-received', 'started')
    try {
      record('bridge-forward-started', 'started')
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-code-awareness-request-id': message.requestId,
          'x-code-awareness-session-id': message.connectionId
        },
        body: message.body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]),
        redirect: 'error'
      })
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      if (reader) {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          if (size > MAX_RELAY_BYTES / 2) { await reader.cancel(); throw new RelayError('PAYLOAD_TOO_LARGE') }
          chunks.push(part.value)
        }
      }
      const body = Buffer.concat(chunks).toString('utf8')
      this.outcomes.set(message.requestId, { tool: metadata.tool })
      record('bridge-response-received', 'success')
      if (!signal.aborted) {
        try {
          await this.send(socket, { protocol: RELAY_PROTOCOL, type: 'result', connectionId: message.connectionId, requestId: message.requestId, response: { status: response.status, contentType: response.headers.get('content-type')?.split(';')[0] ?? '', body } })
          record('desktop-relay-response-sent', 'success')
          record('relay-response-forwarded', 'success')
        } catch {
          record('desktop-relay-response-sent', 'error', 'RELAY_CLOSED')
          this.failConnection('RELAY_CLOSED')
        }
      }
    } catch (error) {
      const code = error instanceof RelayError
        ? error.code
        : error instanceof Error && error.name === 'AbortError' && signal.aborted
          ? 'RELAY_CLOSED'
          : error instanceof Error && error.name === 'TimeoutError'
            ? 'REQUEST_TIMEOUT'
            : 'LOCAL_MCP_UNAVAILABLE'
      record('bridge-forward-started', 'error', code)
      if (!signal.aborted) {
        try {
          await this.send(socket, { protocol: RELAY_PROTOCOL, type: 'error', connectionId: message.connectionId, requestId: message.requestId, code })
        } catch {
          this.failConnection('RELAY_CLOSED')
        }
      }
    }
  }

  async stop(): Promise<void> {
    const socket = this.socket
    this.socket = null
    this.controller?.abort()
    this.controller = null
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        socket.once('close', resolve)
        socket.terminate()
      })
    }
    await Promise.allSettled(this.pending.values())
    this.pending.clear()
    this.outcomes.clear()
    this.setState({ status: 'STOPPED' })
  }

  private send(socket: WebSocket, message: RelayMessage): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new RelayError('RELAY_CLOSED'))
        return
      }
      socket.send(encodeRelayMessage(message), (error) => {
        if (error) {
          reject(new RelayError('RELAY_CLOSED'))
        } else {
          resolve()
        }
      })
    })
  }

  private failConnection(code: import('../../../shared/distribution/relay-protocol').RelayErrorCode): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    const socket = this.socket
    this.controller?.abort()
    if (socket) {
      if (this.state.status === 'RUNNING') {
        this.setState({ status: 'ERROR', error: code })
      }
      socket.terminate()
    }
  }

  private setState(state: TransportState): void {
    this.state = state
    for (const listener of this.listeners) { try { listener({ ...state }) } catch {} }
  }
}
