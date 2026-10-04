import type { Server } from 'node:http'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import { ContextNavigationMcpAdapter } from './context-navigation-mcp-adapter'
import { createMcpHttpServer } from './mcp-http-server'
import type { CodeScopeTraceSink } from './code-scope-health'
import type { IArtifactReader } from '../continuum/continuum-types'
import type { McpProjectContext } from './project-mcp-context'

export type McpLifecycleState =
  | { status: 'STOPPED' | 'STARTING' | 'STOPPING'; available: false }
  | { status: 'RUNNING'; available: true; endpoint: string; projectId: string }
  | { status: 'ERROR'; available: false; error: 'MCP_START_FAILED' | 'MCP_SERVER_FAILED' }

interface McpLifecycleOptions {
  createServer?: (navigation: ProjectContextNavigation, artifactReader?: IArtifactReader) => Server
  createContextServer?: (context: McpProjectContext) => Server
  log?: (state: McpLifecycleState) => void
  trace?: CodeScopeTraceSink
  systemHealth?: import('../system-health/system-health-core').SystemHealthCore
  runtimeIdentity?: import('../runtime-identity/runtime-identity-provider').RuntimeIdentityProvider
  validationLedger?: import('../validation-ledger/validation-ledger').ValidationLedger
  academy?: import('../academy/academy-service').AcademyService
}

export class McpLifecycle {
  private state: McpLifecycleState = { status: 'STOPPED', available: false }
  private server: Server | null = null
  private binding: string | null = null
  private bindingReader: IArtifactReader | undefined = undefined
  private currentAdapter: ContextNavigationMcpAdapter | null = null
  private requested: McpProjectContext | null = null
  private revision = 0
  private transition = Promise.resolve()
  private disposed = false
  private runtimeFailure = false
  private readonly listeners = new Set<(state: McpLifecycleState) => void | Promise<void>>()
  private readonly createServer: (context: McpProjectContext) => Server
  private readonly log: (state: McpLifecycleState) => void

  constructor(options: McpLifecycleOptions = {}) {
    this.createServer = options.createContextServer ?? (options.createServer
      ? ((context) => options.createServer!(context.navigation, context.artifactReader))
      : ((context) => {
      const adapter = new ContextNavigationMcpAdapter(
        context,
        options.systemHealth,
        options.runtimeIdentity,
        options.validationLedger,
        options.academy
      )
      this.currentAdapter = adapter
      return createMcpHttpServer(adapter, console.log, options.trace)
    }))
    this.log = options.log ?? ((state) => console.log('[MCP Lifecycle]', state))
  }


  getState(): McpLifecycleState {
    return { ...this.state }
  }

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
    if (this.disposed) return this.transition
    if (
      this.requested?.projectId === context.projectId &&
      this.requested.navigation === context.navigation &&
      this.requested.artifactReader === context.artifactReader &&
      this.requested.validationExecution === context.validationExecution &&
      this.requested.diagnosticSourceAccess === context.diagnosticSourceAccess &&
      this.requested.runtimeRestart === context.runtimeRestart &&
      this.requested.gitOperations === context.gitOperations &&
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
    return this.deactivate()
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
    this.binding = null
    this.bindingReader = undefined
    server.removeAllListeners('error')
  }

  private async reconcile(revision: number): Promise<void> {
    if (revision !== this.revision) return
    if (
      this.requested && this.binding === this.requested.projectId &&
      this.bindingReader === this.requested.artifactReader &&
      this.state.status === 'RUNNING'
    ) {
      return
    }
    await this.stop()
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
      this.bindingReader = requested.artifactReader
      await this.setState({ status: 'RUNNING', available: true, endpoint: `http://127.0.0.1:${address.port}/mcp`, projectId: requested.projectId })
    } catch {
      await this.stop()
      if (revision === this.revision) await this.setState({ status: 'ERROR', available: false, error: 'MCP_START_FAILED' })
    }
  }
}
