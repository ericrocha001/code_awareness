export type LocalMcpClientId = 'codex' | 'antigravity' | 'antigravity-settings' | 'cline' | 'cline-settings' | 'cline-vscode'
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
  mechanism?: 'PLUGIN' | 'CODEX_CLI' | 'CONFIG_FALLBACK'
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
  detect(): Promise<LocalMcpClientState[]>
  verify(client: LocalMcpClientId): Promise<LocalMcpClientState>
  preview(client: LocalMcpClientId, action: LocalMcpAction): Promise<LocalMcpPreview>
  apply(token: string, confirmed: boolean, replaceConflict: boolean): Promise<LocalMcpClientState>
}
