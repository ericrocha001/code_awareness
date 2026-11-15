import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import { ChannelMcpAdapter } from './channel-mcp-adapter'
import { createMcpHttpServer } from './mcp-http-server'
import { McpWorkloadGovernor } from './mcp-workload-governor'
import { ChannelActivityMonitor } from './channel-activity-monitor'
import type { ChannelTraceSink } from '../../shared/types/channel-types'
import type { IArtifactReader } from '../continuum/continuum-types'
import type { McpProjectContext } from './project-mcp-context'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../continuum/agent-authority'

export type McpLifecycleState =
  | { status: 'STOPPED' | 'STARTING' | 'STOPPING'; available: false }
  | { status: 'RUNNING'; available: true; endpoint: string; projectId: string }
  | { status: 'ERROR'; available: false; error: 'MCP_START_FAILED' | 'MCP_SERVER_FAILED' }

interface McpLifecycleOptions {
  disabled?: boolean
  createServer?: (navigation: ProjectContextNavigation, artifactReader?: IArtifactReader) => Server
  createContextServer?: (context: McpProjectContext) => Server
  log?: (state: McpLifecycleState) => void
  trace?: ChannelTraceSink
  activity?: ChannelActivityMonitor
  usage?: import('./channel-usage').ChannelUsage
  systemHealth?: import('../system-health/system-health-core').SystemHealthCore
  runtimeIdentity?: import('../runtime-identity/runtime-identity-provider').RuntimeIdentityProvider
  validationLedger?: import('../validation-ledger/validation-ledger').ValidationLedger
  academy?: import('../academy/academy-service').AcademyService
}

export class McpLifecycle {
  private readonly governor = new McpWorkloadGovernor()
  private readonly activity: ChannelActivityMonitor
  private readonly usage?: import('./channel-usage').ChannelUsage
  private state: McpLifecycleState = { status: 'STOPPED', available: false }
  private server: Server | null = null
  private binding: string | null = null
  private bindingReader: IArtifactReader | undefined = undefined
  private currentAdapter: ChannelMcpAdapter | null = null
  private requested: McpProjectContext | null = null
  private revision = 0
  private transition = Promise.resolve()
  private disposed = false
  private runtimeFailure = false
  private endpointGeneration: string | null = null
  private globalServer: Server | null = null
  private globalEndpoint: string | null = null
  private globalGeneration: string | null = null
  private readonly instanceId: string
  private readonly listeners = new Set<(state: McpLifecycleState) => void | Promise<void>>()
  private readonly createServer: (context: McpProjectContext) => Server
  private readonly log: (state: McpLifecycleState) => void
  private readonly disabled: boolean
  private readonly academy?: import('../academy/academy-service').AcademyService
  private readonly systemHealth?: import('../system-health/system-health-core').SystemHealthCore
  private readonly runtimeIdentity?: import('../runtime-identity/runtime-identity-provider').RuntimeIdentityProvider
  private readonly validationLedger?: import('../validation-ledger/validation-ledger').ValidationLedger
  private readonly trace?: ChannelTraceSink

  constructor(options: McpLifecycleOptions = {}) {
    this.instanceId = options.runtimeIdentity?.getInstanceId() ?? randomUUID()
    this.disabled = options.disabled ?? false
    this.activity = options.activity ?? new ChannelActivityMonitor()
    this.usage = options.usage
    this.academy = options.academy
    this.systemHealth = options.systemHealth
    this.runtimeIdentity = options.runtimeIdentity
    this.validationLedger = options.validationLedger
    this.trace = options.trace
    this.createServer = options.createContextServer ?? (options.createServer
      ? ((context) => options.createServer!(context.navigation, context.artifactReader))
      : ((context) => {
      const adapter = new ChannelMcpAdapter(
        context,
        options.systemHealth,
        options.runtimeIdentity,
        options.validationLedger,
        options.academy
      )
      this.currentAdapter = adapter
      adapter.setWorkloadGovernor(this.governor)
      adapter.setActivityMonitor(this.activity)
      const generation = this.endpointGeneration
      return createMcpHttpServer(adapter, console.log, options.trace, headers => {
        const supplied = headers['x-code-awareness-binding']
        if (supplied === undefined) return true
        return this.state.status === 'RUNNING' && this.endpointGeneration === generation && supplied === generation &&
          headers['x-code-awareness-instance'] === this.instanceId &&
          headers['x-code-awareness-project'] === context.projectId
      }, (headers, connected) => {
        const isActive = () => this.state.status === 'RUNNING' && this.endpointGeneration === generation && connected()
        if (!headers['x-code-awareness-binding'] || headers['x-code-awareness-binding'] !== generation || headers['x-code-awareness-instance'] !== this.instanceId || headers['x-code-awareness-project'] !== context.projectId || !isActive()) return undefined
        if (!context.continuum?.repositoryId) return undefined
        return authorizeArtifactAgent(authenticatedAgentPrincipal('MCP', isActive), context.continuum.repositoryId, isActive)
      })
    }))
    this.log = options.log ?? ((state) => console.log('[MCP Lifecycle]', state))
  }


  getState(): McpLifecycleState {
    return { ...this.state }
  }
  getAgentBindingHeaders(): Record<string, string> {
    if (this.state.status !== 'RUNNING' || !this.endpointGeneration) return {}
    return { 'x-code-awareness-binding': this.endpointGeneration, 'x-code-awareness-instance': this.instanceId, 'x-code-awareness-project': this.state.projectId }
  }

  getLocalEndpoint(instanceId: string) {
    const observedAt = new Date().toISOString()
    if (this.state.status !== 'RUNNING' || !this.endpointGeneration) {
      return { status: 'UNAVAILABLE', reason: this.state.status, observedAt }
    }
    return { status: 'RUNNING', endpoint: this.state.endpoint, projectId: this.state.projectId,
      instanceId, bindingId: this.endpointGeneration, observedAt, protocol: 'code-awareness-mcp-bootstrap/v1' }
  }

  async ensureGlobalSkillsEndpoint() {
    const observedAt = new Date().toISOString()
    if (this.disabled || this.disposed) {
      return { status: 'UNAVAILABLE' as const, reason: this.disposed ? 'DISPOSED' : 'DISABLED', observedAt }
    }
    if (this.state.status === 'RUNNING' && this.endpointGeneration) {
      return {
        mode: 'PROJECT' as const,
        status: 'RUNNING' as const,
        endpoint: this.state.endpoint,
        projectId: this.state.projectId,
        instanceId: this.instanceId,
        bindingId: this.endpointGeneration,
        observedAt,
        protocol: 'code-awareness-mcp-bootstrap/v1' as const
      }
    }
    if (!this.academy) {
      return { status: 'UNAVAILABLE' as const, reason: this.state.status, observedAt }
    }
    if (this.globalServer && this.globalEndpoint && this.globalGeneration) {
      return {
        mode: 'GLOBAL_ONLY' as const,
        status: 'RUNNING' as const,
        endpoint: this.globalEndpoint,
        projectId: null,
        instanceId: this.instanceId,
        bindingId: this.globalGeneration,
        observedAt,
        protocol: 'code-awareness-mcp-bootstrap/v1' as const
      }
    }
    const generation = randomUUID()
    const adapter = ChannelMcpAdapter.createGlobalOnly(this.academy, this.systemHealth, this.runtimeIdentity, this.validationLedger)
    adapter.setWorkloadGovernor(this.governor)
    adapter.setActivityMonitor(this.activity)
    const server = createMcpHttpServer(adapter, console.log, this.trace, headers => {
      const supplied = headers['x-code-awareness-binding']
      if (supplied === undefined) return true
      return !this.disposed && this.globalGeneration === generation && supplied === generation &&
        headers['x-code-awareness-instance'] === this.instanceId &&
        (headers['x-code-awareness-project'] ?? '') === ''
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => { server.removeListener('listening', onListening); reject(err) }
      const onListening = () => { server.removeListener('error', onError); resolve() }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '127.0.0.1')
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections() })
      throw new Error('GLOBAL_MCP_ADDRESS_UNAVAILABLE')
    }
    this.globalServer = server
    this.globalGeneration = generation
    this.globalEndpoint = `http://127.0.0.1:${address.port}/mcp`
    return {
      mode: 'GLOBAL_ONLY' as const,
      status: 'RUNNING' as const,
      endpoint: this.globalEndpoint,
      projectId: null,
      instanceId: this.instanceId,
      bindingId: generation,
      observedAt: new Date().toISOString(),
      protocol: 'code-awareness-mcp-bootstrap/v1' as const
    }
  }

  getActivityState() { return this.activity.getState() }
  onActivityChanged(listener: () => void) { return this.activity.onChanged(listener) }

  getCatalogProbe(): { getToolCatalogHash: () => string } | null {
    return this.currentAdapter ? { getToolCatalogHash: () => this.currentAdapter!.getToolCatalogHash() } : null
  }

  onChanged(listener: (state: McpLifecycleState) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  activate(identity: string, navigation: ProjectContextNavigation, artifactReader?: IArtifactReader): Promise<void> {
    return this.activateContext({ projectId: identity, repoRoot: '', navigation, artifactReader })
  }

  activateContext(context: McpProjectContext): Promise<void> {
    if (this.disabled) return Promise.resolve()
    if (this.disposed) return this.transition
    if (
      this.requested?.projectId === context.projectId &&
      this.requested.navigation === context.navigation &&
      this.requested.artifactReader === context.artifactReader &&
      this.requested.continuum === context.continuum &&
      this.requested.visualContinuum === context.visualContinuum &&
      this.requested.validationExecution === context.validationExecution &&
      this.requested.diagnosticSourceAccess === context.diagnosticSourceAccess &&
      this.requested.runtimeRestart === context.runtimeRestart &&
      this.requested.gitOperations === context.gitOperations &&
      this.requested.githubIntegration === context.githubIntegration &&
      this.requested.repositoryFileIngress === context.repositoryFileIngress &&
      this.requested.repositoryFileEditing === context.repositoryFileEditing &&
      this.state.status !== 'ERROR' &&
      this.state.status !== 'STOPPING'
    ) {
      return this.transition
    }
    this.requested = context
    this.runtimeFailure = false
    return this.schedule()
  }

  deactivate(): Promise<void> {
    this.runtimeFailure = false
    this.requested = null
    return this.schedule()
  }

  quiesce(): Promise<void> {
    const revision = ++this.revision
    const invalidating = this.invalidate()
    this.transition = this.transition.then(async () => {
      await invalidating
      if (revision === this.revision) await this.stop()
    })
    return this.transition
  }

  dispose(): Promise<void> {
    if (this.disposed) return this.transition
    this.disposed = true
    return this.deactivate().then(async () => {
      await this.stopGlobalServer()
      await this.usage?.close()
    })
  }

  private async stopGlobalServer(): Promise<void> {
    const server = this.globalServer
    this.globalServer = null
    this.globalEndpoint = null
    this.globalGeneration = null
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeIdleConnections()
    })
    server.removeAllListeners('error')
  }

  private schedule(): Promise<void> {
    const revision = ++this.revision
    const invalidating = this.invalidate()
    this.transition = this.transition.then(async () => {
      await invalidating
      await this.reconcile(revision)
    })
    return this.transition
  }

  private invalidate(): Promise<void> {
    return this.state.status === 'RUNNING'
      ? this.setState({ status: 'STOPPING', available: false })
      : Promise.resolve()
  }

  private async setState(state: McpLifecycleState): Promise<void> {
    this.state = state
    try { this.log({ ...state }) } catch {}
    await Promise.all(Array.from(this.listeners, async (listener) => {
      try { await listener({ ...state }) } catch { console.error('[MCP Lifecycle] Observer failed') }
    }))
  }

  private async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    await this.setState({ status: 'STOPPING', available: false })
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeIdleConnections()
    })
    this.server = null
    this.currentAdapter?.stopUsage()
    this.currentAdapter = null
    void this.usage?.flush()
    this.binding = null
    this.bindingReader = undefined
    server.removeAllListeners('error')
  }

  private async reconcile(revision: number): Promise<void> {
    if (revision !== this.revision) return
    if (
      this.requested && this.binding === this.requested.projectId &&
      this.bindingReader === (this.requested.continuum ?? this.requested.artifactReader) &&
      this.state.status === 'RUNNING'
    ) {
      return
    }
    await this.stop()
    await this.stopGlobalServer()
    if (revision !== this.revision) return
    const requested = this.requested
    if (!requested || this.disposed) {
      await this.setState(this.runtimeFailure
        ? { status: 'ERROR', available: false, error: 'MCP_SERVER_FAILED' }
        : { status: 'STOPPED', available: false })
      return
    }
    await this.setState({ status: 'STARTING', available: false })
    try {
      this.endpointGeneration = randomUUID()
      const server = this.createServer(requested)
      this.server = server
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(0, '127.0.0.1')
      })
      server.on('error', () => {
        if (this.server !== server || revision !== this.revision) return
        this.requested = null
        this.runtimeFailure = true
        void this.schedule()
      })
      if (revision !== this.revision || this.disposed) {
        await this.stop()
        return
      }
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('MCP address unavailable')
      this.binding = requested.projectId
      if (this.usage) this.currentAdapter?.setUsage(this.usage)
      this.bindingReader = requested.continuum ?? requested.artifactReader
      await this.setState({ status: 'RUNNING', available: true, endpoint: `http://127.0.0.1:${address.port}/mcp`, projectId: requested.projectId })
    } catch {
      await this.stop()
      if (revision === this.revision) await this.setState({ status: 'ERROR', available: false, error: 'MCP_START_FAILED' })
    }
  }
}
