import { describe, expect, it } from 'vitest'
import { encodeRelayMessage, MAX_REQUEST_BYTES, newConnectionId, newInstallationId, newRequestId, parseRelayMessage, RELAY_PROTOCOL, type RelayMessage } from './relay-protocol'

describe('relay/v1 contracts', () => {
  const connectionId = newConnectionId()
  const requestId = newRequestId()
  const messages: RelayMessage[] = [
    { protocol: RELAY_PROTOCOL, type: 'hello', installationId: newInstallationId(), credential: 'a'.repeat(43), capabilities: ['mcp-http'] },
    { protocol: RELAY_PROTOCOL, type: 'ready', connectionId },
    { protocol: RELAY_PROTOCOL, type: 'invoke', connectionId, requestId, body: '{"id":1}' },
    { protocol: RELAY_PROTOCOL, type: 'result', connectionId, requestId, response: { status: 200, contentType: 'application/json', body: 'literal Ω\n' } },
    { protocol: RELAY_PROTOCOL, type: 'error', connectionId, requestId, code: 'REQUEST_TIMEOUT' },
    ...(['ping', 'pong', 'close'] as const).map((type) => ({ protocol: RELAY_PROTOCOL, type, connectionId }))
  ]
  it.each(messages)('roundtrips $type without changing payload/correlation', (message) => {
    expect(parseRelayMessage(encodeRelayMessage(message))).toEqual(message)
  })
  it('rejects unknown versions, invalid IDs, surplus fields and oversized requests', () => {
    expect(() => parseRelayMessage('{"protocol":"relay/v2"}')).toThrow('PROTOCOL_UNSUPPORTED')
    for (const raw of ['[]', 'null', '{', JSON.stringify({ ...messages[1], connectionId: 1 }), JSON.stringify({ ...messages[0], project: 'private' })]) {
      expect(() => parseRelayMessage(raw)).toThrow()
    }
    expect(() => parseRelayMessage(JSON.stringify({ ...messages[2], body: 'é'.repeat(MAX_REQUEST_BYTES) }))).toThrow('PAYLOAD_TOO_LARGE')
  })
  it('allocates independent infrastructure IDs even when MCP IDs repeat', () => {
    const ids = Array.from({ length: 100 }, () => newRequestId())
    expect(new Set(ids).size).toBe(100)
    expect(ids).not.toContain(connectionId)
  })
})
