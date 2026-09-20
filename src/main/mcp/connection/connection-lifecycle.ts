import type { ConnectionErrorCode, ConnectionResult, ConnectionState } from '../../../shared/types/connection-types'
import type { McpLifecycle, McpLifecycleState } from '../mcp-lifecycle'
import { ConnectionError, type ConnectionConfiguration, type ConnectionTransportPort } from './connection-transport-port'

export class ConnectionLifecycle {
  private state: ConnectionState = { status: 'DISCONNECTED' }
  private desired = false
  private continuous = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private nextReconnectAt: number | null = null
  private disposed = false
  private revision = 0
  private transition: Promise<void> = Promise.resolve()
  private startup: AbortController | null = null
  private local: McpLifecycleState
  private identity: string | null = null
  private configuration: ConnectionConfiguration = {}
  private terminalError: ConnectionErrorCode | null = null
  private readonly listeners = new Set<(state: ConnectionState) => void>()
  private readonly unsubscribe: (() => void)[]

  constructor(
    mcp: Pick<McpLifecycle, 'getState' | 'onChanged'>,
    private readonly transport: ConnectionTransportPort,
    private readonly getConfiguration: () => ConnectionConfiguration,
    private readonly log: (state: ConnectionState) => void = (state) => console.log('[Connection]', state.status, state.status === 'CONNECTED' ? `${state.transport} -> ${state.projectId} (${state.externalEndpoint})` : state.status === 'ERROR' ? state.error : '')
  ) {
    this.local = mcp.getState()
    this.unsubscribe = [mcp.onChanged((state) => {
      this.local = state
      if (state.status === 'STOPPED' && !this.continuous) { this.desired = false; this.terminalError = null }
      if (state.status === 'ERROR' && this.desired) { this.desired = false; this.terminalError = 'MCP_FAILED' }
      const transition = this.schedule()
      return this.continuous && state.status === 'RUNNING' ? undefined : transition
    }), transport.onChanged((state) => {
      if (state.status !== 'ERROR' || !this.desired || this.state.status !== 'CONNECTED') return
      this.desired = this.continuous
      this.terminalError = state.error
      void this.schedule()
    })]
  }

  getState(): ConnectionState { return { ...this.state } }

  getRetryState(): { attempt: number; nextReconnectAt: number | null } {
    return { attempt: this.attempt, nextReconnectAt: this.nextReconnectAt }
  }

  async setIntent(enabled: boolean): Promise<ConnectionResult> {
    if (this.disposed) return { success: false, error: 'CONNECTION_DISPOSED', state: this.getState() }
    this.continuous = enabled
    this.desired = enabled
    this.terminalError = null
    this.identity = null
    this.attempt = 0
    try { this.configuration = { ...this.getConfiguration() } } catch {
      this.terminalError = 'INVALID_MESSAGE'
    }
    await this.schedule()
    return this.result()
  }

  onChanged(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async connect(): Promise<ConnectionResult> {
    if (this.disposed) return { success: false, error: 'CONNECTION_DISPOSED', state: this.getState() }
    if (this.local.status !== 'RUNNING') return { success: false, error: 'MCP_NOT_RUNNING', state: this.getState() }
    if (!this.desired) {
      try { this.configuration = { ...this.getConfiguration() } } catch {
        return { success: false, error: 'TRANSPORT_FAILED', state: this.getState() }
      }
      this.identity = null
      this.terminalError = null
      this.desired = true
      await this.schedule()
    } else await this.transition
    return this.result()
  }

  async disconnect(): Promise<ConnectionResult> {
    this.continuous = false
    this.desired = false
    this.terminalError = null
    await this.schedule()
    return this.result()
  }

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true
      this.unsubscribe.forEach((unsubscribe) => unsubscribe())
    }
    await this.disconnect()
    this.listeners.clear()
  }

  private result(): ConnectionResult {
    const state = this.getState()
    return state.status === 'ERROR' ? { success: false, error: state.error, state } : { success: true, state }
  }

  private schedule(): Promise<void> {
    this.cancelRetry()
    const revision = ++this.revision
    this.startup?.abort()
    this.transition = this.transition.then(() => this.reconcile(revision)).catch(() => {
      this.desired = false
      this.setState({ status: 'ERROR', error: 'TRANSPORT_STOP_FAILED' })
    })
    return this.transition
  }

  private async reconcile(revision: number): Promise<void> {
    if (revision !== this.revision) return
    const local = this.local
    if (this.desired && !this.terminalError && this.identity && local.status === 'RUNNING' && this.state.status === 'CONNECTED' && this.state.localEndpoint === local.endpoint && this.state.projectId === local.projectId) return
    if (!this.desired || this.disposed || this.terminalError || (this.continuous && local.status !== 'RUNNING')) {
      if (this.state.status !== 'DISCONNECTED') this.setState({ status: 'DISCONNECTING' })
      await this.transport.stop()
      if (revision !== this.revision) return
      this.identity = null
      this.setState(this.terminalError ? { status: 'ERROR', error: this.terminalError } : { status: 'DISCONNECTED' })
      this.retryIfTransient()
      return
    }
    this.setState({ status: this.identity ? 'REBINDING' : 'CONNECTING' })
    await this.transport.stop()
    if (revision !== this.revision || local.status !== 'RUNNING') return
    const controller = new AbortController()
    this.startup = controller
    try {
      const result = await this.transport.start(local.endpoint, this.configuration, controller.signal)
      if (revision !== this.revision || controller.signal.aborted) { await this.transport.stop(); return }
      if (this.identity && result.externalEndpoint !== this.identity) throw new ConnectionError('TRANSPORT_IDENTITY_CHANGED')
      this.identity = result.externalEndpoint
      this.attempt = 0
      this.setState({ status: 'CONNECTED', transport: this.transport.name, externalEndpoint: result.externalEndpoint, projectId: local.projectId, localEndpoint: local.endpoint, connectedAt: new Date().toISOString() })
    } catch (error) {
      await this.transport.stop()
      if (revision !== this.revision) return
      const normalized = error instanceof ConnectionError ? error.code : 'TRANSPORT_FAILED'
      console.warn('[Connection] transport start failed at stage=transport_start code=' + normalized)
      this.desired = this.continuous
      this.terminalError = normalized
      this.setState({ status: 'ERROR', error: this.terminalError })
      this.retryIfTransient()
    } finally {
      if (this.startup === controller) this.startup = null
    }
  }

  private setState(state: ConnectionState): void {
    this.state = state
    try { this.log({ ...state }) } catch {}
    for (const listener of this.listeners) { try { listener({ ...state }) } catch {} }
  }

  private cancelRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.nextReconnectAt = null
  }

  private retryIfTransient(): void {
    if (!this.continuous || !this.desired || this.disposed || this.local.status !== 'RUNNING' || this.transport.name !== 'relay') return
    if (!this.terminalError || !['RELAY_CLOSED', 'REQUEST_TIMEOUT', 'INSTALLATION_OFFLINE'].includes(this.terminalError)) return
    const delay = [1000, 2000, 5000, 10000, 30000][Math.min(this.attempt++, 4)]
    this.nextReconnectAt = Date.now() + delay
    const revision = this.revision
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.nextReconnectAt = null
      if (revision !== this.revision || this.disposed || !this.continuous) return
      this.terminalError = null
      void this.schedule()
    }, delay)
  }
}
