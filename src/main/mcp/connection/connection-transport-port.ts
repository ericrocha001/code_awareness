import type { ConnectionErrorCode } from '../../../shared/types/connection-types'

export interface ConnectionConfiguration {
  publicDomain?: string
}

export type TransportState =
  | { status: 'STOPPED' | 'STARTING' }
  | { status: 'RUNNING'; externalEndpoint: string }
  | { status: 'ERROR'; error: ConnectionErrorCode }

export class ConnectionError extends Error {
  constructor(readonly code: ConnectionErrorCode) { super(code) }
}

export interface ConnectionTransportPort {
  readonly name: string
  start(localEndpoint: string, configuration: ConnectionConfiguration, signal: AbortSignal): Promise<{ externalEndpoint: string }>
  stop(): Promise<void>
  getState(): TransportState
  onChanged(listener: (state: TransportState) => void): () => void
}
