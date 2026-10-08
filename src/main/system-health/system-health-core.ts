import type { ChannelTraceEvent, ChannelTraceSink } from '../../shared/types/channel-types'
import type { CanonicalStage, StageDrilldownProvider, SystemHealthState } from '../../shared/types/system-health-types'
import { buildDiagnosticTrace } from './diagnostic-trace'
import { generateDiagnosticReportFromTrace } from './diagnostic-report'
import { mcpRequestDrilldownProvider } from './mcp-request-drilldown'
import { codeScopeExecutionDrilldownProvider } from './codescope-execution-drilldown'
import { relayInboundDrilldownProvider } from './relay-inbound-drilldown'

import type { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'

export const CODESCOPE_FUNCTIONAL_TOOLS = new Set([
  'discover_repository',
  'get_relationships',
  'inspect_files',
  'inspect_worktree_structure',
  'get_references',
  'get_symbol_dependencies',
  'get_symbol_hierarchy',
  'read_code',
])

export const MCP_EXCLUDED_OPERATIONS = new Set([
  'initialize',
  'notifications/initialized',
  'tools/list',
  'get_system_health',
  'get_runtime_identity',
  'ping',
])

export interface SystemHealthCoreOptions {
  drilldownProviders?: StageDrilldownProvider[]
  runtimeIdentityProvider?: RuntimeIdentityProvider
}

export interface SystemHealthProvider {
  readonly sink: ChannelTraceSink
  invalidate(): void
}

export class SystemHealthCore {
  private revision = 0
  private previous = ''
  private stale = false
  private lastFunctionalProof: SystemHealthState['lastFunctionalProof'] = null
  private lastFailure: SystemHealthState['lastFailure'] = null
  private lastProofSeq = 0
  private lastFailureSeq = 0
  private seq = 0
  private readonly pendingEvents = new Map<string, ChannelTraceEvent[]>()
  private readonly pendingTimeouts = new Map<string, NodeJS.Timeout>()
  private readonly listeners = new Set<(state: SystemHealthState) => void>()
  private readonly drilldownProviders = new Map<CanonicalStage, StageDrilldownProvider>()
  private runtimeIdentityProvider?: RuntimeIdentityProvider

  constructor(
    drilldownProvidersOrOptions?: StageDrilldownProvider[] | SystemHealthCoreOptions,
    runtimeIdentityProvider?: RuntimeIdentityProvider
  ) {
    let providers: StageDrilldownProvider[] | undefined
    if (Array.isArray(drilldownProvidersOrOptions)) {
      providers = drilldownProvidersOrOptions
      this.runtimeIdentityProvider = runtimeIdentityProvider
    } else if (drilldownProvidersOrOptions && typeof drilldownProvidersOrOptions === 'object') {
      providers = drilldownProvidersOrOptions.drilldownProviders
      this.runtimeIdentityProvider =
        drilldownProvidersOrOptions.runtimeIdentityProvider ?? runtimeIdentityProvider
    } else {
      this.runtimeIdentityProvider = runtimeIdentityProvider
    }

    if (providers) {
      for (const provider of providers) {
        this.drilldownProviders.set(provider.canonicalStage, provider)
      }
    } else {
      this.drilldownProviders.set(mcpRequestDrilldownProvider.canonicalStage, mcpRequestDrilldownProvider)
      this.drilldownProviders.set(codeScopeExecutionDrilldownProvider.canonicalStage, codeScopeExecutionDrilldownProvider)
      this.drilldownProviders.set(relayInboundDrilldownProvider.canonicalStage, relayInboundDrilldownProvider)
    }
  }

  setRuntimeIdentityProvider(provider: RuntimeIdentityProvider): void {
    this.runtimeIdentityProvider = provider
  }

  getRuntimeIdentityProvider(): RuntimeIdentityProvider | undefined {
    return this.runtimeIdentityProvider
  }

  registerDrilldownProvider(provider: StageDrilldownProvider): void {
    this.drilldownProviders.set(provider.canonicalStage, provider)
  }

  readonly sink: ChannelTraceSink = {
    record: (event: ChannelTraceEvent) => this.receive(event)
  }

  getState(): SystemHealthState {
    this.checkPendingTimeouts()
    let proof = this.lastFunctionalProof
    if (proof && !CODESCOPE_FUNCTIONAL_TOOLS.has(proof.operation)) {
      proof = null
    }
    const currentInstanceId = this.runtimeIdentityProvider?.getInstanceId()
    const failure = this.lastFailure
      ? {
          ...this.lastFailure,
          isHistoricalRuntime: Boolean(
            this.lastFailure.runtimeInstanceId &&
            currentInstanceId &&
            this.lastFailure.runtimeInstanceId !== currentInstanceId
          )
        }
      : null
    let status: SystemHealthState['status']
    if (this.stale || (!proof && !failure)) {
      status = 'UNKNOWN'
    } else if (proof && !failure) {
      status = 'OPERATIONAL'
    } else if (proof && failure) {
      status = this.lastProofSeq > this.lastFailureSeq ? 'OPERATIONAL' : 'DEGRADED'
    } else {
      status = 'DEGRADED'
    }
    const value: SystemHealthState = {
      revision: this.revision,
      feature: 'CodeScope',
      status,
      lastFunctionalProof: proof,
      lastFailure: failure,
      stale: this.stale,
    }
    const serialized = JSON.stringify(value)
    if (serialized !== this.previous) {
      this.previous = serialized
      this.revision++
      value.revision = this.revision
    }
    return value
  }

  onChanged(listener: (state: SystemHealthState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  invalidate(): void {
    if (this.lastFunctionalProof || this.lastFailure) {
      this.stale = true
      for (const timer of this.pendingTimeouts.values()) clearTimeout(timer)
      this.pendingTimeouts.clear()
      this.pendingEvents.clear()
      this.publish()
    }
  }

  getDiagnosticReport(): string {
    const proof = this.lastFunctionalProof && CODESCOPE_FUNCTIONAL_TOOLS.has(this.lastFunctionalProof.operation)
      ? this.lastFunctionalProof
      : null
    const failure = this.lastFailure
    if (failure) {
      let durationMs = failure.stages.find((s) => s.stage === failure.firstFailedBoundary)?.durationMs ?? 0
      if (failure.reasonCode === 'REQUEST_TIMEOUT' && (durationMs === 0 || durationMs > 30_000)) {
        durationMs = 30_000
      }
      return generateDiagnosticReportFromTrace({
        traceId: failure.traceId,
        operation: failure.operation,
        startedAt: failure.at,
        completedAt: failure.at,
        durationMs,
        success: false,
        stages: failure.stages,
        firstFailedBoundary: failure.firstFailedBoundary,
        lastSuccessfulStage: failure.lastSuccessfulStage,
        reasonCode: failure.reasonCode,
      })
    }
    return generateDiagnosticReportFromTrace({
      traceId: proof?.traceId ?? 'none',
      operation: proof?.operation ?? 'none',
      startedAt: proof?.at ?? '',
      completedAt: proof?.at ?? '',
      durationMs: proof?.durationMs ?? 0,
      success: true,
      stages: [],
      firstFailedBoundary: null,
      lastSuccessfulStage: null,
      reasonCode: null,
    })
  }

  private receive(event: ChannelTraceEvent): void {
    if (event.sessionId === 'local') return

    // Explicitly exclude MCP protocol/control traffic
    if (MCP_EXCLUDED_OPERATIONS.has(event.tool) || MCP_EXCLUDED_OPERATIONS.has(event.method)) {
      return
    }

    // Must be a CodeScope functional tool or early gateway event for tools/call
    const isCodeScopeTool = CODESCOPE_FUNCTIONAL_TOOLS.has(event.tool)
    const isGenericToolCall = event.method === 'tools/call' && (!event.tool || event.tool === 'unknown')
    if (!isCodeScopeTool && !isGenericToolCall) {
      return
    }

    const id = event.requestId
    if (!this.pendingEvents.has(id)) {
      this.pendingEvents.set(id, [])
      this.pendingTimeouts.set(
        id,
        setTimeout(() => {
          this.handleInFlightTimeout(id)
        }, 30_000)
      )
    }
    const events = this.pendingEvents.get(id)!
    events.push(event)

    const isTerminalSuccess =
      event.stage === 'gateway-response-delivered' ||
      event.stage === 'http-response-returned' ||
      event.stage === 'client-response-completed' ||
      event.stage === 'relay-response-delivered'

    const isError = event.status === 'error'

    if (isTerminalSuccess || isError) {
      const trace = buildDiagnosticTrace(events)
      if (!trace) return

      if (!CODESCOPE_FUNCTIONAL_TOOLS.has(trace.operation)) {
        this.pendingEvents.delete(id)
        this.clearPendingTimeout(id)
        return
      }

      const runtimeInstanceId =
        events.find((e) => e.runtimeInstanceId)?.runtimeInstanceId ??
        this.runtimeIdentityProvider?.getInstanceId() ??
        null

      if (trace.success) {
        this.lastFunctionalProof = {
          operation: trace.operation,
          traceId: trace.traceId,
          at: trace.completedAt,
          durationMs: trace.durationMs,
          runtimeInstanceId,
        }
        this.lastProofSeq = ++this.seq
        this.stale = false
        this.pendingEvents.delete(id)
        this.clearPendingTimeout(id)
        this.publish()
      } else if (trace.firstFailedBoundary !== null) {
        const drilldown = trace.firstFailedBoundary
          ? this.drilldownProviders.get(trace.firstFailedBoundary)?.evaluate(events, trace.reasonCode) ?? null
          : null

        const currentInstanceId = this.runtimeIdentityProvider?.getInstanceId()
        const isHistoricalRuntime = Boolean(
          runtimeInstanceId && currentInstanceId && runtimeInstanceId !== currentInstanceId
        )

        this.lastFailure = {
          operation: trace.operation,
          traceId: trace.traceId,
          at: trace.completedAt,
          firstFailedBoundary: trace.firstFailedBoundary,
          reasonCode: trace.reasonCode,
          lastSuccessfulStage: trace.lastSuccessfulStage,
          stages: trace.stages,
          hasContradictoryExecution: trace.hasContradictoryExecution,
          drilldown,
          runtimeInstanceId,
          isHistoricalRuntime,
        }
        this.lastFailureSeq = ++this.seq
        if (isTerminalSuccess || event.stage === 'relay-response-forwarded' || event.stage === 'desktop-relay-response-sent') {
          this.pendingEvents.delete(id)
          this.clearPendingTimeout(id)
        }
        this.publish()
      }
    }
  }

  private handleInFlightTimeout(id: string): void {
    this.clearPendingTimeout(id)
    const events = this.pendingEvents.get(id)
    if (!events || events.length === 0) return
    this.pendingEvents.delete(id)

    const toolEvent = events.find((e) => e.tool && e.tool !== 'unknown' && e.tool !== '')
    const operation = toolEvent?.tool || events[0].method
    if (!CODESCOPE_FUNCTIONAL_TOOLS.has(operation)) return

    const firstTime = Date.parse(events[0].timestamp)
    const timeoutDurationMs = 30_000
    const timeoutTimestamp = Number.isFinite(firstTime)
      ? new Date(firstTime + timeoutDurationMs).toISOString()
      : new Date().toISOString()

    const last = events[events.length - 1]
    const timeoutStage = last.status === 'started' ? last.stage : 'relay-response-forwarded'
    const timeoutEvent: ChannelTraceEvent = {
      ...last,
      stage: timeoutStage,
      status: 'error',
      error: 'REQUEST_TIMEOUT',
      durationMs: timeoutDurationMs,
      timestamp: timeoutTimestamp,
    }
    events.push(timeoutEvent)

    const trace = buildDiagnosticTrace(events)
    if (!trace || !CODESCOPE_FUNCTIONAL_TOOLS.has(trace.operation)) return

    const drilldown = trace.firstFailedBoundary
      ? this.drilldownProviders.get(trace.firstFailedBoundary)?.evaluate(events, trace.reasonCode) ?? null
      : null

    const runtimeInstanceId =
      events.find((e) => e.runtimeInstanceId)?.runtimeInstanceId ??
      this.runtimeIdentityProvider?.getInstanceId() ??
      null
    const currentInstanceId = this.runtimeIdentityProvider?.getInstanceId()
    const isHistoricalRuntime = Boolean(
      runtimeInstanceId && currentInstanceId && runtimeInstanceId !== currentInstanceId
    )

    this.lastFailure = {
      operation: trace.operation,
      traceId: trace.traceId,
      at: trace.completedAt,
      firstFailedBoundary: trace.firstFailedBoundary,
      reasonCode: trace.reasonCode,
      lastSuccessfulStage: trace.lastSuccessfulStage,
      stages: trace.stages,
      hasContradictoryExecution: trace.hasContradictoryExecution,
      drilldown,
      runtimeInstanceId,
      isHistoricalRuntime,
    }
    this.lastFailureSeq = ++this.seq
    this.publish()
  }

  private checkPendingTimeouts(): void {
    const now = Date.now()
    for (const [id, events] of Array.from(this.pendingEvents.entries())) {
      if (events.length === 0) continue
      const firstTime = Date.parse(events[0].timestamp)
      if (Number.isFinite(firstTime) && now - firstTime >= 30_000) {
        this.handleInFlightTimeout(id)
      }
    }
  }

  private clearPendingTimeout(id: string): void {
    const timer = this.pendingTimeouts.get(id)
    if (timer) {
      clearTimeout(timer)
      this.pendingTimeouts.delete(id)
    }
  }

  private publish(): void {
    const state = this.getState()
    for (const listener of this.listeners) {
      try { listener(state) } catch {}
    }
  }
}
