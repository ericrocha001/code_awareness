import type { ChatGptIntegrationState, ChatGptIntegrationStatus } from '../../shared/types/chatgpt-integration-types'
import type { ActiveProjectService } from '../core/active-project-service'
import type { RemoteAccessService } from '../mcp/connection/remote-access-service'
import type { McpLifecycle } from '../mcp/mcp-lifecycle'
import type { CodeScopeFunctionalHealth } from '../mcp/code-scope-health'

const transientErrors = new Set(['RELAY_CLOSED', 'REQUEST_TIMEOUT', 'INSTALLATION_OFFLINE'])
const publicErrors = new Set([...transientErrors, 'INVALID_CREDENTIAL', 'INSTALLATION_REVOKED', 'PROTOCOL_UNSUPPORTED', 'INVALID_MESSAGE', 'TRANSPORT_FAILED', 'TRANSPORT_IDENTITY_CHANGED', 'TRANSPORT_STOP_FAILED', 'MCP_FAILED', 'MCP_NOT_RUNNING', 'CONNECTION_DISPOSED', 'FORBIDDEN', 'INSTALLATION_AMBIGUOUS', 'SESSION_REPLACED', 'LOCAL_MCP_UNAVAILABLE', 'RELAY_BUSY', 'PAYLOAD_TOO_LARGE'])

export class ChatGptIntegrationProjection {
  private revision = 0
  private previous = ''
  private readonly listeners = new Set<(state: ChatGptIntegrationState) => void>()
  private readonly unsubscribes: Array<() => void>

  constructor(
    private readonly remote: Pick<RemoteAccessService, 'getState' | 'onChanged'>,
    private readonly projects: Pick<ActiveProjectService, 'getState' | 'onChanged'>,
    private readonly mcp: Pick<McpLifecycle, 'getState' | 'onChanged'>,
    private readonly installationConfigured: () => boolean,
    settings: { onChanged(listener: () => void): () => void },
    private readonly functionalHealth: { getState(): CodeScopeFunctionalHealth; onChanged(listener: () => void): () => void }
  ) {
    const publish = () => { const state = this.getState(); for (const listener of this.listeners) listener(state) }
    this.unsubscribes = [remote.onChanged(publish), projects.onChanged(publish), mcp.onChanged(publish), settings.onChanged(publish), functionalHealth.onChanged(publish)]
  }

  getState(): ChatGptIntegrationState {
    const remote = this.remote.getState(), mcp = this.mcp.getState(), project = this.projects.getState().project
    const functional = this.functionalHealth.getState()
    let configured = false
    try { configured = this.installationConfigured() } catch {}
    const enabled = remote.remoteAccessEnabled === true
    const transport = remote.transportKind === 'relay' ? 'relay' : 'ngrok'
    const error = remote.status === 'ERROR' ? remote.error : null
    let lastError = error ? publicErrors.has(error) ? error : 'CONNECTION_ERROR' : null
    const transportReady = mcp.status === 'RUNNING' && remote.status === 'CONNECTED' && remote.transport === 'relay' && project !== null && mcp.projectId === project.id && remote.projectId === project.id
    const connectedAt = remote.status === 'CONNECTED' ? Date.parse(remote.connectedAt) : Number.NaN
    const healthObservedAt = Date.parse(functional.status === 'OPERATIONAL' ? functional.lastSuccessfulAt ?? '' : functional.lastFailedAt ?? '')
    const currentHealth = transportReady && Number.isFinite(healthObservedAt) && (!Number.isFinite(connectedAt) || healthObservedAt >= connectedAt)
      ? functional.status
      : 'UNKNOWN'
    const codeScopeStatus = !transportReady ? 'UNAVAILABLE' : currentHealth
    let status: ChatGptIntegrationStatus
    if (!enabled) status = 'DISABLED'
    else if (transport !== 'relay') { status = 'NEEDS_ATTENTION'; lastError = 'DEVELOPMENT_TRANSPORT' }
    else if (mcp.status === 'ERROR' || (error && !transientErrors.has(error))) { status = 'NEEDS_ATTENTION'; if (mcp.status === 'ERROR') lastError = 'MCP_FAILED' }
    else if (!configured) status = 'SETUP_REQUIRED'
    else if (!project) status = 'WAITING_FOR_PROJECT'
    else if (error) status = 'OFFLINE'
    else if (transportReady && codeScopeStatus === 'OPERATIONAL') status = 'READY'
    else if (transportReady && codeScopeStatus === 'DEGRADED') { status = 'NEEDS_ATTENTION'; lastError = functional.lastError }
    else status = 'CONNECTING'
    const value: Omit<ChatGptIntegrationState, 'revision'> = {
      status,
      remoteAccessEnabled: enabled,
      transport,
      connectionStatus: remote.status,
      mcpStatus: mcp.status,
      activeProject: project ? { id: project.id, name: project.name } : null,
      installationConfigured: configured,
      codeScopeStatus,
      lastSuccessfulToolCall: functional.lastSuccessfulToolCall,
      lastSuccessfulAt: functional.lastSuccessfulAt,
      lastFailedToolCall: functional.lastFailedToolCall,
      lastFailedAt: functional.lastFailedAt,
      lastFailureStage: functional.lastFailureStage,
      lastError,
      lastStageLatencyMs: functional.lastStageLatencyMs,
      lastDeadlineRemainingMs: functional.lastDeadlineRemainingMs
    }
    const serialized = JSON.stringify(value)
    if (serialized !== this.previous) { this.previous = serialized; this.revision++ }
    return { revision: this.revision, ...value }
  }

  onChanged(listener: (state: ChatGptIntegrationState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void { for (const unsubscribe of this.unsubscribes) unsubscribe(); this.listeners.clear() }
}
