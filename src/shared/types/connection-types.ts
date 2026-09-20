import type { RelayErrorCode } from '../distribution/relay-protocol'

export type ConnectionErrorCode = RelayErrorCode
  | 'MCP_NOT_RUNNING' | 'MCP_FAILED' | 'CONNECTION_DISPOSED' | 'INVALID_ARGUMENTS'
  | 'TRANSPORT_FAILED' | 'TRANSPORT_IDENTITY_CHANGED' | 'TRANSPORT_STOP_FAILED'
  | 'NGROK_NOT_FOUND' | 'NGROK_NOT_AUTHENTICATED' | 'NGROK_DOMAIN_NOT_CONFIGURED'
  | 'NGROK_DOMAIN_INVALID' | 'NGROK_START_FAILED' | 'NGROK_START_TIMEOUT' | 'NGROK_EXITED'

export type ConnectionState = {
  remoteAccessEnabled?: boolean
  transportKind?: 'relay' | 'ngrok'
  attempt?: number
  nextReconnectAt?: number | null
} & (
  | { status: 'DISCONNECTED' | 'CONNECTING' | 'REBINDING' | 'DISCONNECTING' }
  | { status: 'ERROR'; error: ConnectionErrorCode }
  | { status: 'CONNECTED'; transport: string; externalEndpoint: string; projectId: string; localEndpoint: string; connectedAt: string }
)

export type ConnectionResult = { success: true; state: ConnectionState } | { success: false; error: ConnectionErrorCode; state: ConnectionState }
