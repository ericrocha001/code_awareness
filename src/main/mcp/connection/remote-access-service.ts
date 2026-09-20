import type { AppSettings } from '../../../shared/types'
import type { ConnectionResult, ConnectionState } from '../../../shared/types/connection-types'
import type { ConnectionLifecycle } from './connection-lifecycle'

interface RemoteSettings {
  loadSettings(): AppSettings
  saveSettings(settings: AppSettings): void
  onChanged(listener: () => void): () => void
}

export class RemoteAccessService {
  private intent: { remoteAccessEnabled: boolean; transportKind: 'relay' | 'ngrok'; ngrokDomain?: string } | null = null
  private applying: Promise<ConnectionResult> | null = null
  private unsubscribe: (() => void) | null = null
  private disposed = false

  constructor(private readonly settings: RemoteSettings, private readonly connection: ConnectionLifecycle) {}

  start(): void {
    if (this.unsubscribe || this.disposed) return
    this.unsubscribe = this.settings.onChanged(() => { void this.apply() })
    void this.apply()
  }

  getState(): ConnectionState {
    const settings = this.settings.loadSettings()
    return { ...this.connection.getState(), remoteAccessEnabled: settings.remoteAccessEnabled === true, transportKind: settings.transportKind === 'relay' ? 'relay' : 'ngrok', ...this.connection.getRetryState() }
  }

  onChanged(listener: (state: ConnectionState) => void): () => void {
    return this.connection.onChanged(() => listener(this.getState()))
  }

  connect(): Promise<ConnectionResult> { return this.setEnabled(true) }
  disconnect(): Promise<ConnectionResult> { return this.setEnabled(false) }

  private async setEnabled(enabled: boolean): Promise<ConnectionResult> {
    if (this.disposed) return { success: false, error: 'CONNECTION_DISPOSED', state: this.getState() }
    this.settings.saveSettings({ ...this.settings.loadSettings(), remoteAccessEnabled: enabled })
    const result = await this.apply()
    return { ...result, state: this.getState() }
  }

  private apply(): Promise<ConnectionResult> {
    if (this.disposed) return Promise.resolve({ success: false, error: 'CONNECTION_DISPOSED', state: this.getState() })
    const settings = this.settings.loadSettings()
    const next = { remoteAccessEnabled: settings.remoteAccessEnabled === true, transportKind: settings.transportKind === 'relay' ? 'relay' as const : 'ngrok' as const, ngrokDomain: settings.ngrokDomain }
    console.log('[RemoteAccess] apply intent:', next.remoteAccessEnabled, 'transport:', next.transportKind)
    if (JSON.stringify(next) === JSON.stringify(this.intent) && this.applying) return this.applying
    this.intent = next
    this.applying = this.connection.setIntent(next.remoteAccessEnabled)
    return this.applying
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.unsubscribe?.()
    await this.connection.dispose()
  }
}
