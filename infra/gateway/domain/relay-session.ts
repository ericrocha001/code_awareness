import { encodeRelayMessage, newConnectionId, newRequestId, RELAY_PROTOCOL, RelayError, type ConnectionId, type McpHttpResponse, type RelayMessage, type RequestId } from '../../../src/shared/distribution/relay-protocol'

export interface RelayChannel { send(raw: string): void; close(): void }

function metadata(body: string): { method: string; tool: string } {
  try {
    const message = JSON.parse(body) as { method?: unknown; params?: { name?: unknown } }
    const method = typeof message.method === 'string' ? message.method : 'unknown'
    return { method, tool: method === 'tools/call' && typeof message.params?.name === 'string' ? message.params.name : method }
  } catch {
    return { method: 'unknown', tool: 'unknown' }
  }
}

export class RelaySession {
  private active = true
  private readonly pending = new Map<RequestId, { resolve: (response: McpHttpResponse) => void; reject: (error: RelayError) => void; timer: ReturnType<typeof setTimeout>; startedAt: number }>()

  constructor(private readonly channel: RelayChannel, private readonly timeoutMs = 30_000, readonly connectionId: ConnectionId = newConnectionId()) {}

  ready(): void { this.channel.send(encodeRelayMessage({ protocol: RELAY_PROTOCOL, type: 'ready', connectionId: this.connectionId })) }
  isOnline(): boolean { return this.active }

  invoke(body: string, requestId: RequestId = newRequestId()): Promise<McpHttpResponse> {
    if (!this.active) return Promise.reject(new RelayError('INSTALLATION_OFFLINE'))
    if (this.pending.size >= 32) return Promise.reject(new RelayError('RELAY_BUSY'))
    const request = metadata(body)
    const startedAt = Date.now()
    const log = (stage: string, status: 'started' | 'success' | 'error', error?: string): void => {
      const elapsed = Date.now() - startedAt
      const deadlineRemainingMs = Math.max(0, this.timeoutMs - elapsed)
      console.log('[Relay]', JSON.stringify({
        component: 'relay-session',
        stage,
        requestId,
        sessionId: this.connectionId,
        method: request.method,
        tool: request.tool,
        timestamp: new Date().toISOString(),
        durationMs: elapsed,
        deadlineRemainingMs,
        status,
        ...(error ? { error } : {})
      }))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        log('relay-response-timeout', 'error', 'REQUEST_TIMEOUT')
        reject(new RelayError('REQUEST_TIMEOUT'))
      }, this.timeoutMs)
      this.pending.set(requestId, {
        resolve: (response) => {
          log('gateway-relay-response-received', 'success')
          log('relay-response-received', 'success')
          resolve(response)
        },
        reject: (error) => {
          log('gateway-relay-response-received', 'error', error.code)
          log('relay-response-received', 'error', error.code)
          reject(error)
        },
        timer,
        startedAt
      })
      try {
        log('relay-request-sent', 'started')
        log('relay-request-forwarded', 'started')
        this.channel.send(encodeRelayMessage({ protocol: RELAY_PROTOCOL, type: 'invoke', connectionId: this.connectionId, requestId, body }))
      } catch {
        clearTimeout(timer)
        this.pending.delete(requestId)
        log('relay-request-sent', 'error', 'RELAY_CLOSED')
        log('relay-request-forwarded', 'error', 'RELAY_CLOSED')
        reject(new RelayError('RELAY_CLOSED'))
      }
    })
  }

  acknowledgeHttpReturned(requestId: RequestId, durationMs: number): void {
    if (!this.active) return
    try {
      this.channel.send(encodeRelayMessage({
        protocol: RELAY_PROTOCOL,
        type: 'delivered',
        connectionId: this.connectionId,
        requestId,
        stage: 'gateway-response-delivered',
        durationMs
      }))
    } catch {}
  }

  receive(message: RelayMessage): void {
    if (!this.active) return
    if (!('connectionId' in message) || message.connectionId !== this.connectionId) { this.close('INVALID_MESSAGE'); return }
    if (message.type === 'ping') {
      this.channel.send(encodeRelayMessage({ protocol: RELAY_PROTOCOL, type: 'pong', connectionId: this.connectionId }))
      return
    }
    if (message.type === 'close') { this.close(); return }
    if (message.type !== 'result' && message.type !== 'error') { this.close('INVALID_MESSAGE'); return }
    const entry = message.requestId ? this.pending.get(message.requestId) : undefined
    if (!entry) {
      if (message.requestId) {
        console.warn('[Relay]', JSON.stringify({
          component: 'relay-session',
          stage: 'unmatched-response-received',
          requestId: message.requestId,
          sessionId: this.connectionId,
          type: message.type
        }))
      }
      return
    }
    this.pending.delete(message.requestId!)
    clearTimeout(entry.timer)
    if (message.type === 'result') {
      try {
        this.channel.send(encodeRelayMessage({
          protocol: RELAY_PROTOCOL,
          type: 'delivered',
          connectionId: this.connectionId,
          requestId: message.requestId!,
          stage: 'relay-response-delivered',
          durationMs: Date.now() - entry.startedAt
        }))
      } catch {}
      entry.resolve(message.response)
    } else {
      entry.reject(new RelayError(message.code))
    }
  }

  close(code: import('../../../src/shared/distribution/relay-protocol').RelayErrorCode = 'RELAY_CLOSED'): void {
    if (!this.active) return
    this.active = false
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new RelayError(code)) }
    this.pending.clear()
    this.channel.close()
  }
}
