import type { ChannelState, ChannelAvailability } from '../../shared/types/channel-state-types'
import type { ChannelFunctionalHealth } from '../../shared/types/channel-types'
import type { ActiveProjectService } from '../core/active-project-service'
import type { RemoteAccessService } from '../mcp/connection/remote-access-service'
import type { McpLifecycle } from '../mcp/mcp-lifecycle'

const transientErrors = new Set(['RELAY_CLOSED', 'REQUEST_TIMEOUT', 'INSTALLATION_OFFLINE'])
const publicErrors = new Set([...transientErrors, 'INVALID_CREDENTIAL', 'INSTALLATION_REVOKED', 'PROTOCOL_UNSUPPORTED', 'INVALID_MESSAGE', 'TRANSPORT_FAILED', 'TRANSPORT_IDENTITY_CHANGED', 'TRANSPORT_STOP_FAILED', 'MCP_FAILED', 'MCP_NOT_RUNNING', 'CONNECTION_DISPOSED', 'FORBIDDEN', 'INSTALLATION_AMBIGUOUS', 'SESSION_REPLACED', 'LOCAL_MCP_UNAVAILABLE', 'RELAY_BUSY', 'PAYLOAD_TOO_LARGE', 'INVALID_ARGUMENT', 'INVALID_ARGUMENTS', 'INVALID_TARGET', 'REPOSITORY_NOT_OPEN', 'INDEX_NOT_READY', 'INTERNAL_ERROR'])
const publicError = (error: string | null): string | null => error ? publicErrors.has(error) ? error : 'CHANNEL_ERROR' : null

export class ChannelStateProjection {
  private revision = 0
  private previous = ''
  private readonly listeners = new Set<(state: ChannelState) => void>()
  private readonly unsubscribes: Array<() => void>

  constructor(
    private readonly remote: Pick<RemoteAccessService, 'getState' | 'onChanged'>,
    private readonly projects: Pick<ActiveProjectService, 'getState' | 'onChanged'>,
    private readonly mcp: Pick<McpLifecycle, 'getState' | 'onChanged' | 'getActivityState' | 'onActivityChanged'>,
    private readonly installationConfigured: () => boolean,
    settings: { onChanged(listener: () => void): () => void },
    private readonly functional: { getState(): ChannelFunctionalHealth; onChanged(listener: () => void): () => void }
  ) {
    this.getState()
    const publish = () => {
      const previousRevision = this.revision
      const state = this.getState()
      if (state.revision === previousRevision) return
      for (const listener of this.listeners) {
        try { listener(structuredClone(state)) } catch {}
      }
    }
    this.unsubscribes = [remote.onChanged(publish), projects.onChanged(publish), mcp.onChanged(publish), settings.onChanged(publish), functional.onChanged(publish), mcp.onActivityChanged(publish)]
  }

  getState(): ChannelState {
    const remote = this.remote.getState(), mcp = this.mcp.getState(), project = this.projects.getState().project
    const health = this.functional.getState()
    let configured = false
    try { configured = this.installationConfigured() } catch {}
    const enabled = remote.remoteAccessEnabled === true
    const transport = remote.transportKind === 'relay' ? 'relay' : 'ngrok'
    const error = remote.status === 'ERROR' ? remote.error : null
    let lastError = publicError(error)
    const ready = mcp.status === 'RUNNING' && remote.status === 'CONNECTED' && remote.transport === 'relay' && project !== null && mcp.projectId === project.id && remote.projectId === project.id
    let availability: ChannelAvailability
    if (!enabled) availability = 'DISABLED'
    else if (transport !== 'relay') { availability = 'ERROR'; lastError = 'DEVELOPMENT_TRANSPORT' }
    else if (mcp.status === 'ERROR' || (error && !transientErrors.has(error))) { availability = 'ERROR'; if (mcp.status === 'ERROR') lastError = 'MCP_FAILED' }
    else if (!configured) availability = 'SETUP_REQUIRED'
    else if (!project) availability = 'WAITING_FOR_PROJECT'
    else if (error) availability = 'OFFLINE'
    else availability = ready ? 'READY' : 'CONNECTING'
    const value: Omit<ChannelState, 'revision'> = {
      availability, remoteAccessEnabled: enabled, installationConfigured: configured, transport,
      connectionStatus: remote.status, mcpStatus: mcp.status,
      activeProject: project ? { id: project.id, name: project.name } : null,
      lastError,
      functionalHealth: {
        status: health.status,
        lastSuccessfulToolCall: health.lastSuccessfulToolCall,
        lastSuccessfulAt: health.lastSuccessfulAt,
        lastFailedToolCall: health.lastFailedToolCall,
        lastFailedAt: health.lastFailedAt,
        lastFailureStage: health.lastFailureStage,
        lastError: publicError(health.lastError),
        lastStageLatencyMs: health.lastStageLatencyMs,
        lastDeadlineRemainingMs: health.lastDeadlineRemainingMs
      },
      activity: this.mcp.getActivityState()
    }
    const serialized = JSON.stringify(value)
    if (serialized !== this.previous) { this.previous = serialized; this.revision++ }
    return { revision: this.revision, ...value }
  }

  onChanged(listener: (state: ChannelState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void { for (const unsubscribe of this.unsubscribes) unsubscribe(); this.listeners.clear() }
}
