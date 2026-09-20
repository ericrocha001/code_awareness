import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { newConnectionId, newInstallationId, newRequestId, parseRelayMessage, RELAY_PROTOCOL, type RelayMessage } from '../../../shared/distribution/relay-protocol'
import { CodeScopeHealthMonitor, type CodeScopeTraceSink } from '../code-scope-health'
import { RelayTransport } from './relay-transport'
import { ConnectionLifecycle } from './connection-lifecycle'

async function fixture(acceptCredential = true, answerHeartbeat = true, requestTimeoutMs = 25_000, localDelayMs = 0, trace?: CodeScopeTraceSink) {
  const localHeaders: Array<Record<string, string | string[] | undefined>> = []
  const local = createServer(async (request, response) => {
    localHeaders.push(request.headers)
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString()
    const { order } = JSON.parse(body)
    await new Promise((resolve) => setTimeout(resolve, localDelayMs || (3 - order) * 15))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(body)
  })
  await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve))
  const gateway = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => gateway.once('listening', resolve))
  let client: WebSocket
  const messages: RelayMessage[] = []
  const connectionId = newConnectionId()
  gateway.on('connection', (socket) => {
    client = socket
    socket.on('message', (raw) => {
      const message = parseRelayMessage(raw.toString())
      messages.push(message)
      if (message.type === 'hello') socket.send(JSON.stringify(acceptCredential
        ? { protocol: RELAY_PROTOCOL, type: 'ready', connectionId }
        : { protocol: RELAY_PROTOCOL, type: 'error', code: 'INVALID_CREDENTIAL' }))
      if (message.type === 'ping' && answerHeartbeat) socket.send(JSON.stringify({ protocol: RELAY_PROTOCOL, type: 'pong', connectionId }))
    })
  })
  const localEndpoint = `http://127.0.0.1:${(local.address() as { port: number }).port}/mcp`
  const endpoint = `http://127.0.0.1:${(gateway.address() as { port: number }).port}/mcp`
  const transport = new RelayTransport(endpoint, { getId: () => newInstallationId(), getCredential: () => 'a'.repeat(43) }, 50, requestTimeoutMs, trace)
  return {
    transport, endpoint, localEndpoint, messages, localHeaders,
    send: (message: RelayMessage) => client.send(JSON.stringify(message)), connectionId,
    drop: () => client.terminate(),
    close: async () => {
      await transport.stop()
      await new Promise<void>((resolve) => gateway.close(() => resolve()))
      await new Promise<void>((resolve) => local.close(() => resolve()))
    }
  }
}

describe('outbound RelayTransport', () => {
  it('recovers from a real socket loss without replaying a completed MCP call', async () => {
    const f = await fixture()
    const mcp = { getState: () => ({ status: 'RUNNING', available: true, projectId: 'A', endpoint: f.localEndpoint }), onChanged: () => () => {} }
    const connection = new ConnectionLifecycle(mcp as never, f.transport, () => ({}), () => {})
    try {
      await connection.setIntent(true)
      f.send({ protocol: RELAY_PROTOCOL, type: 'invoke', connectionId: f.connectionId, requestId: newRequestId(), body: JSON.stringify({ id: 1, order: 1 }) })
      await vi.waitFor(() => expect(f.messages.filter((message) => message.type === 'result')).toHaveLength(1))
      f.drop()
      await vi.waitFor(() => expect(connection.getState().status).toBe('ERROR'))
      await vi.waitFor(() => expect(f.messages.filter((message) => message.type === 'hello')).toHaveLength(2), { timeout: 4000 })
      await vi.waitFor(() => expect(connection.getState().status).toBe('CONNECTED'))
      expect(f.messages.filter((message) => message.type === 'result')).toHaveLength(1)
    } finally { await connection.dispose(); await f.close() }
  })
  it('authenticates, correlates responses out of order, heartbeats, disconnects and reconnects', async () => {
    const f = await fixture()
    try {
      const signal = new AbortController().signal
      await expect(f.transport.start(f.localEndpoint, {}, signal)).resolves.toEqual({ externalEndpoint: f.endpoint })
      const requests = [0, 1, 2].map((order) => ({ protocol: RELAY_PROTOCOL, type: 'invoke' as const, connectionId: f.connectionId, requestId: newRequestId(), body: JSON.stringify({ id: 1, order, source: 'literal Ω\n' }) }))
      for (const request of requests) f.send(request)
      await vi.waitFor(() => expect(f.messages.filter((message) => message.type === 'result')).toHaveLength(3))
      const results = f.messages.filter((message) => message.type === 'result')
      expect(results.map((message) => message.requestId)).not.toEqual(requests.map((message) => message.requestId))
      for (const result of results) expect(result.response.body).toBe(requests.find((request) => request.requestId === result.requestId)!.body)
      await vi.waitFor(() => expect(f.messages.some((message) => message.type === 'ping')).toBe(true))
      await f.transport.stop()
      expect(f.transport.getState().status).toBe('STOPPED')
      await f.transport.start(f.localEndpoint, {}, signal)
      expect(f.transport.getState().status).toBe('RUNNING')
    } finally { await f.close() }
  })
  it('rejects credentials before becoming operational', async () => {
    const f = await fixture(false)
    try { await expect(f.transport.start(f.localEndpoint, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' }) } finally { await f.close() }
  })
  it('detects an unresponsive relay without retrying invisibly', async () => {
    const f = await fixture(true, false)
    try {
      await f.transport.start(f.localEndpoint, {}, new AbortController().signal)
      await vi.waitFor(() => expect(f.transport.getState().status).toBe('ERROR'))
    } finally { await f.close() }
  })
  it('returns a correlated bridge timeout before the relay request deadline', async () => {
    const health = new CodeScopeHealthMonitor()
    const f = await fixture(true, true, 25, 100, health)
    try {
      await f.transport.start(f.localEndpoint, {}, new AbortController().signal)
      const requestId = newRequestId()
      f.send({ protocol: RELAY_PROTOCOL, type: 'invoke', connectionId: f.connectionId, requestId, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'discover_repository', arguments: {} }, order: 1 }) })
      await vi.waitFor(() => expect(f.messages.some((message) =>
        message.type === 'error' && message.requestId === requestId && message.code === 'REQUEST_TIMEOUT'
      )).toBe(true))
      expect(f.localHeaders[0]['x-code-awareness-request-id']).toBe(requestId)
      expect(f.localHeaders[0]['x-code-awareness-session-id']).toBe(f.connectionId)
      expect(health.getState()).toMatchObject({
        status: 'DEGRADED',
        lastFailedToolCall: 'discover_repository',
        lastFailureStage: 'bridge-forward-started',
        lastError: 'REQUEST_TIMEOUT'
      })
    } finally { await f.close() }
  })
})
