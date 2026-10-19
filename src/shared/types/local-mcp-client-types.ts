export const LOCAL_MCP_CLIENT_IDS = ['codex', 'antigravity', 'antigravity-settings', 'cline', 'cline-settings', 'cline-vscode'] as const
export type LocalMcpClientId = typeof LOCAL_MCP_CLIENT_IDS[number]
export type LocalMcpMechanism = 'PLUGIN' | 'CODEX_CLI' | 'CONFIG_FALLBACK'
export interface LocalMcpInstallation {
  id: LocalMcpClientId
  mechanism: LocalMcpMechanism
  state: 'CONFIGURED' | 'REMOVED' | 'NEEDS_ATTENTION'
  evidence: 'MANAGED_ENTRY' | 'APPLY_CONNECT' | 'APPLY_REPAIR' | 'APPLY_DISCONNECT' | 'APPLY_MIGRATION' | 'CONFIG_ABSENT' | 'CONFIG_DIVERGENT' | 'READ_INCONCLUSIVE'
  installationEvidence?: 'MANAGED_ENTRY' | 'APPLY_CONNECT' | 'APPLY_REPAIR'
}
export interface LocalMcpInstallationSnapshot {
  revision: number
  restoration: 'RESTORING' | 'READY' | 'ERROR'
  installations: LocalMcpInstallation[]
  diagnostic?: string
}
export type LocalMcpAction = 'connect' | 'repair' | 'disconnect'
export interface LocalMcpClientState {
  id: LocalMcpClientId
  name: string
  path: string
  detected: boolean
  configuration: 'ABSENT' | 'INSTALLED' | 'CONFLICT' | 'ERROR' | 'UNSUPPORTED'
  launcherPresent: boolean
  bootstrap: 'NOT_CHECKED' | 'RESPONDS' | 'ERROR'
  clientUse: 'NOT_CONFIRMED'
  mechanism?: LocalMcpMechanism
  persistence?: 'SAVED' | 'FAILED'
  recognition?: 'NOT_CONFIRMED'
  reconnection?: 'NOT_CONFIRMED'
  diagnostic?: string
}
export interface LocalMcpPreview {
  token: string
  client: LocalMcpClientId
  path: string
  action: LocalMcpAction
  before: string
  after: string
  conflict: boolean
  changes: boolean
  launcherPath: string
  restartRequired: true
  migration?: boolean
  mechanism?: LocalMcpClientState['mechanism']
}
export interface LocalMcpClientApi {
  snapshot(): Promise<LocalMcpInstallationSnapshot>
  onChanged(callback: (snapshot: LocalMcpInstallationSnapshot) => void): () => void
  detect(): Promise<LocalMcpClientState[]>
  verify(client: LocalMcpClientId): Promise<LocalMcpClientState>
  preview(client: LocalMcpClientId, action: LocalMcpAction): Promise<LocalMcpPreview>
  apply(token: string, confirmed: boolean, replaceConflict: boolean): Promise<LocalMcpClientState>
}
