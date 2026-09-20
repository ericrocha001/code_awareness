declare const identityKind: unique symbol
export type UserId = string & { readonly [identityKind]: 'user' }
export type InstallationId = string & { readonly [identityKind]: 'installation' }
export type ConnectionId = string & { readonly [identityKind]: 'connection' }
export type RequestId = string & { readonly [identityKind]: 'request' }

export const RELAY_PROTOCOL = 'relay/v1' as const
export const MAX_RELAY_BYTES = 16 * 1024 * 1024
export const MAX_REQUEST_BYTES = 64 * 1024
export const READ_SCOPE = 'code-awareness:read'

export type RelayErrorCode = 'INVALID_MESSAGE' | 'PROTOCOL_UNSUPPORTED' | 'INVALID_CREDENTIAL'
  | 'INSTALLATION_OFFLINE' | 'INSTALLATION_REVOKED' | 'INSTALLATION_AMBIGUOUS' | 'FORBIDDEN'
  | 'REQUEST_TIMEOUT' | 'SESSION_REPLACED' | 'RELAY_CLOSED' | 'PAYLOAD_TOO_LARGE' | 'RELAY_BUSY'
  | 'LOCAL_MCP_UNAVAILABLE' | 'IDENTITY_NOT_LINKED'

export class RelayError extends Error {
  constructor(readonly code: RelayErrorCode) { super(code) }
}

export interface McpHttpResponse { status: number; contentType: string; body: string }
type Envelope = { protocol: typeof RELAY_PROTOCOL }
export type RelayMessage = Envelope & (
  | { type: 'hello'; installationId: InstallationId; credential: string; capabilities: ['mcp-http'] }
  | { type: 'ready'; connectionId: ConnectionId }
  | { type: 'invoke'; connectionId: ConnectionId; requestId: RequestId; body: string }
  | { type: 'result'; connectionId: ConnectionId; requestId: RequestId; response: McpHttpResponse }
  | { type: 'error'; connectionId?: ConnectionId; requestId?: RequestId; code: RelayErrorCode }
  | { type: 'delivered'; connectionId: ConnectionId; requestId: RequestId; stage: 'relay-response-delivered' | 'gateway-response-delivered'; durationMs?: number }
  | { type: 'ping' | 'pong' | 'close'; connectionId: ConnectionId }
)

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const codes: RelayErrorCode[] = ['INVALID_MESSAGE', 'PROTOCOL_UNSUPPORTED', 'INVALID_CREDENTIAL', 'INSTALLATION_OFFLINE', 'INSTALLATION_REVOKED', 'INSTALLATION_AMBIGUOUS', 'FORBIDDEN', 'REQUEST_TIMEOUT', 'SESSION_REPLACED', 'RELAY_CLOSED', 'PAYLOAD_TOO_LARGE', 'RELAY_BUSY', 'LOCAL_MCP_UNAVAILABLE', 'IDENTITY_NOT_LINKED']
export function installationId(value: unknown): InstallationId {
  if (typeof value !== 'string' || !uuid.test(value)) throw new RelayError('INVALID_MESSAGE')
  return value as InstallationId
}
export function requestId(value: unknown): RequestId {
  if (typeof value !== 'string' || !uuid.test(value)) throw new RelayError('INVALID_MESSAGE')
  return value as RequestId
}
export function newInstallationId(): InstallationId { return crypto.randomUUID() as InstallationId }
export function newConnectionId(): ConnectionId { return crypto.randomUUID() as ConnectionId }
export function newRequestId(): RequestId { return crypto.randomUUID() as RequestId }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RelayError('INVALID_MESSAGE')
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw new RelayError('INVALID_MESSAGE')
}
function id(value: unknown): void { installationId(value) }
function body(value: unknown, limit: number): void {
  if (typeof value !== 'string') throw new RelayError('INVALID_MESSAGE')
  if (new TextEncoder().encode(value).byteLength > limit) throw new RelayError('PAYLOAD_TOO_LARGE')
}

export function parseRelayMessage(raw: string): RelayMessage {
  body(raw, MAX_RELAY_BYTES)
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new RelayError('INVALID_MESSAGE') }
  const message = object(parsed)
  if (message.protocol !== RELAY_PROTOCOL) throw new RelayError('PROTOCOL_UNSUPPORTED')
  const base = ['protocol', 'type']
  switch (message.type) {
    case 'hello':
      keys(message, [...base, 'installationId', 'credential', 'capabilities'])
      id(message.installationId)
      if (typeof message.credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(message.credential) || JSON.stringify(message.capabilities) !== '["mcp-http"]') throw new RelayError('INVALID_MESSAGE')
      break
    case 'ready': case 'ping': case 'pong': case 'close':
      keys(message, [...base, 'connectionId'])
      id(message.connectionId)
      break
    case 'invoke':
      keys(message, [...base, 'connectionId', 'requestId', 'body'])
      id(message.connectionId); id(message.requestId); body(message.body, MAX_REQUEST_BYTES)
      break
    case 'result': {
      keys(message, [...base, 'connectionId', 'requestId', 'response'])
      id(message.connectionId); id(message.requestId)
      const response = object(message.response)
      keys(response, ['status', 'contentType', 'body'])
      if (!Number.isInteger(response.status) || Number(response.status) < 200 || Number(response.status) > 599 || !['application/json', ''].includes(String(response.contentType))) throw new RelayError('INVALID_MESSAGE')
      body(response.body, MAX_RELAY_BYTES)
      break
    }
    case 'error':
      keys(message, [...base, 'code'], ['connectionId', 'requestId'])
      if (!codes.includes(message.code as RelayErrorCode)) throw new RelayError('INVALID_MESSAGE')
      if (message.connectionId !== undefined) id(message.connectionId)
      if (message.requestId !== undefined) { id(message.requestId); id(message.connectionId) }
      break
    case 'delivered':
      keys(message, [...base, 'connectionId', 'requestId', 'stage'], ['durationMs'])
      id(message.connectionId); id(message.requestId)
      if (message.stage !== 'relay-response-delivered' && message.stage !== 'gateway-response-delivered') throw new RelayError('INVALID_MESSAGE')
      if (message.durationMs !== undefined && (typeof message.durationMs !== 'number' || !Number.isFinite(message.durationMs))) throw new RelayError('INVALID_MESSAGE')
      break
    default: throw new RelayError('INVALID_MESSAGE')
  }
  return message as RelayMessage
}

export function encodeRelayMessage(message: RelayMessage): string {
  const raw = JSON.stringify(message)
  parseRelayMessage(raw)
  return raw
}
