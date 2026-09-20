export type ChatGptIntegrationStatus = 'DISABLED' | 'SETUP_REQUIRED' | 'WAITING_FOR_PROJECT' | 'CONNECTING' | 'READY' | 'OFFLINE' | 'NEEDS_ATTENTION'

export interface ChatGptIntegrationState {
  revision: number
  status: ChatGptIntegrationStatus
  remoteAccessEnabled: boolean
  transport: 'relay' | 'ngrok'
  connectionStatus: string
  mcpStatus: string
  activeProject: { id: string; name: string } | null
  installationConfigured: boolean
  codeScopeStatus: 'OPERATIONAL' | 'DEGRADED' | 'UNAVAILABLE' | 'UNKNOWN'
  lastSuccessfulToolCall: string | null
  lastSuccessfulAt: string | null
  lastFailedToolCall: string | null
  lastFailedAt: string | null
  lastFailureStage: string | null
  lastError: string | null
  lastStageLatencyMs: number | null
  lastDeadlineRemainingMs: number | null
}
