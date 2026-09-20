import type { ConnectionConfiguration, ConnectionTransportPort, TransportState } from './connection-transport-port'

export class SelectedTransport implements ConnectionTransportPort {
  private active: ConnectionTransportPort | null = null
  private unsubscribe: (() => void) | null = null
  private readonly listeners = new Set<(state: TransportState) => void>()

  constructor(private readonly kind: () => 'relay' | 'ngrok', private readonly create: (kind: 'relay' | 'ngrok') => ConnectionTransportPort) {}

  get name(): string { return this.active?.name ?? this.kind() }
  getState(): TransportState { return this.active?.getState() ?? { status: 'STOPPED' } }
  onChanged(listener: (state: TransportState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(endpoint: string, configuration: ConnectionConfiguration, signal: AbortSignal): Promise<{ externalEndpoint: string }> {
    if (this.active) throw new Error('TRANSPORT_ALREADY_STARTED')
    this.active = this.create(this.kind())
    this.unsubscribe = this.active.onChanged((state) => { for (const listener of this.listeners) listener(state) })
    return this.active.start(endpoint, configuration, signal)
  }

  async stop(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    await this.active?.stop()
    this.active = null
  }
}
