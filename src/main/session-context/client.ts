import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import type { RegistryReader } from './checkpoint-registry'
import type { PublicationProvenancePort, PublicationAssociation } from '../../shared/types/publication-provenance-types'
import { join } from 'node:path'
import type { McpToolResult } from '../mcp/mcp-types'
import type { SessionContextPort, SessionToolName } from './mcp'
import { normalizeScopedReadArgs, parseSessionRefresh, parseSessionList, parseCaptureHealth, parseEvidenceSearch, nativeLiteralTarget } from './mcp'
import { inspectNativeTrust, matchesNativeClient, type NativeHookClient, type NativeTrustSnapshot } from './native-hook-preflight'
import type { LiveSessionTarget, SessionTargetResolver, SessionTargetSelection } from './target'
import { isLiveSessionTool, parseLiveSessionQuery } from './entire-live'
import { readExecutionSessionAssociations, sessionStorePath } from './store'
import type { SessionAssociation } from './associations'
import { nativeCaptureAgent } from './capture-health'
import { hasNativeBindingFile, nativeBindingPath, nativeHookProviders, readNativeBinding, spoolEventFiles, type NativeHookProvider } from './native-hooks'

const failure = (code: string, phase?: string): McpToolResult => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code, ...(phase ? { phase } : {}) }) }] })
interface NativeIngestionTargetReport {
  worktreeId: string
  generation: string
  remainingSpool: boolean
  remainingScan?: boolean
  progressed: boolean
  errorCode?: string
  settledSpools?: { spool: string; filesKey: string }[]
}
interface Generation { worker: Worker; cancellation: Int32Array; closing: boolean }
interface Request {
  abort?: AbortController
  resolve: (result: McpToolResult) => void
  timer: NodeJS.Timeout
  deadline: number
  generation?: Generation
  validate?: () => Promise<void>
  selectionValidators: Map<string, () => Promise<void>>
  verifyNativeTrust?: () => boolean
  isMaintenance?: boolean
  phase: string
}
export class SessionContextClient implements SessionContextPort {
  private generation?: Generation
  private terminal = false
  private retiring: Promise<void> = Promise.resolve()
  private serial = 0
  private nativeOffset = 0
  private prioritizedTarget?: SessionTargetSelection
  private readonly targetBackoff = new Map<string, { failures: number; untilMs: number }>()
  private readonly cleanMaintenanceTargets = new Set<string>()
  private readonly settledSpools = new Map<string, string>()
  private onMaintenanceNeeded?: () => void
  private pending = new Map<number, Request>()
  private refresh?: { key: string; task: Promise<McpToolResult> }
  constructor(private readonly storageBase: string, private readonly repositoryId: string, private readonly root: string, private readonly isCurrent: () => boolean,
    private readonly workerPath = join(__dirname, 'session-context-worker.js'), private readonly resolveTarget?: SessionTargetResolver,
    private readonly timeoutMs?: number,
    private readonly authorizeAssociation?: (request: ReturnType<typeof parseSessionRefresh>) => Promise<{ sourceRevision: number; sourceHash: string }>,
    private readonly registryReader?: RegistryReader, private readonly publicationPort?: PublicationProvenancePort,
    private readonly nativeHookClient?: NativeHookClient, private readonly readOnlyStore = false) {}
  setMaintenanceTrigger(trigger: () => void): void {
    this.onMaintenanceNeeded = trigger
  }
  private active(): boolean {
    if (!this.isCurrent()) void this.dispose()
    return !this.terminal
  }
  readWorkAssociations(scope: Pick<SessionAssociation, 'artifactId' | 'executionId' | 'worktreeId' | 'generation'>) {
    if (!this.active()) throw new Error('PROJECT_CONTEXT_CHANGED')
    return readExecutionSessionAssociations(sessionStorePath(this.storageBase, this.repositoryId), { ...scope, repositoryId: this.repositoryId })
  }
  call(name: SessionToolName, args: unknown, allowArtifactMetadata = false): Promise<McpToolResult> {
    if (!this.active()) return Promise.resolve(failure('PROJECT_CONTEXT_CHANGED'))
    if (Buffer.byteLength(JSON.stringify(args ?? {})) > 8192) return Promise.resolve(failure('INVALID_ARGUMENT'))
    if (name === 'refresh_agent_sessions') {
      try { parseSessionRefresh(args) } catch { return Promise.resolve(failure('INVALID_ARGUMENT')) }
    }
    if (name === 'inspect_capture_health') {
      try { parseCaptureHealth(args) } catch { return Promise.resolve(failure('INVALID_ARGUMENT')) }
    }
    if (isLiveSessionTool(name)) {
      try { parseLiveSessionQuery(name, args) } catch { return Promise.resolve(failure('INVALID_ARGUMENT')) }
    }
    const key = JSON.stringify(args ?? {})
    if (name === 'refresh_agent_sessions' && this.refresh) return this.refresh.key === key ? this.refresh.task : Promise.resolve(failure('BACKPRESSURE'))
    const task = this.dispatch(name, args, { captureNative: !this.readOnlyStore, allowArtifactMetadata: allowArtifactMetadata && !this.readOnlyStore })
    if (name === 'refresh_agent_sessions') {
      const refresh = { key, task }
      this.refresh = refresh
      void task.finally(() => { if (this.refresh === refresh) this.refresh = undefined })
    }
    return task
  }
  private finish(id: number, result: McpToolResult): void {
    const request = this.pending.get(id)
    if (!request) return
    this.pending.delete(id)
    request.abort?.abort()
    clearTimeout(request.timer)
    request.resolve(result)
  }
  private createGeneration(): Generation {
    const cancellation = new Int32Array(new SharedArrayBuffer(4))
    const worker = new Worker(this.workerPath, { workerData: { storageBase: this.storageBase, repositoryId: this.repositoryId, root: this.root, cancellation: cancellation.buffer, readOnlyStore: this.readOnlyStore }, resourceLimits: { maxOldGenerationSizeMb: 128 } })
    const generation = { worker, cancellation, closing: false }
    this.generation = generation
    worker.on('message', async (message: { id: number; result?: McpToolResult; nativeReports?: NativeIngestionTargetReport[]; validate?: number; sourceSelection?: SessionTargetSelection; phase?: string; registryRead?: { token: number; request: Parameters<RegistryReader>[0] }; publication?: { token: number; action: 'read' | 'associate' | 'invalidate'; receiptId?: string; association?: PublicationAssociation; invocationId?: string; state?: 'UNAVAILABLE' | 'PARTIAL' | 'AMBIGUOUS' } }) => {
      if (generation !== this.generation || generation.closing) return
      const request = this.pending.get(message.id)
      if (!request || request.generation !== generation) return
      if (!this.active()) return
      if (Date.now() >= request.deadline) { this.expire(message.id); return }
      if (message.phase) {
        if (/^[a-z-]{1,40}$/.test(message.phase)) request.phase = message.phase
        return
      }
      if (message.publication) {
        let result: unknown, code: string | undefined
        try {
          if (!this.publicationPort) throw new Error('PUBLICATION_PORT_UNAVAILABLE')
          const p = message.publication
          result = p.action === 'read' ? await this.publicationPort.readReceipt(p.receiptId!) : p.action === 'associate' ? await this.publicationPort.associate(p.association!) : await this.publicationPort.invalidate(p.invocationId!, p.state!)
        } catch { code = 'PUBLICATION_PORT_UNAVAILABLE' }
        if (generation !== this.generation || generation.closing || !this.pending.has(message.id) || !this.active() || Date.now() >= request.deadline) return
        worker.postMessage({ publicationResult: message.publication.token, result, code })
        return
      }
      if (message.registryRead) {
        let batches: Awaited<ReturnType<RegistryReader>> = [], code: string | undefined
        try { batches = await this.registryReader?.(message.registryRead.request) ?? [] } catch { code = 'REGISTRY_SOURCE_UNAVAILABLE' }
        if (generation !== this.generation || generation.closing || !this.pending.has(message.id) || !this.active()) return
        worker.postMessage({ registryResult: message.registryRead.token, batches, code })
        return
      }
      if (message.validate !== undefined) {
        let code: string | undefined
        let target: { root: string; fingerprint: string; selection: SessionTargetSelection } | undefined
        try {
          if (message.sourceSelection) {
            if (!this.resolveTarget) throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
            const resolved = await this.resolveTarget(message.sourceSelection)
            const key = `${message.sourceSelection.worktreeId}:${message.sourceSelection.generation}`
            request.selectionValidators.set(key, resolved.validate)
            request.validate ??= resolved.validate
            target = { root: resolved.root, fingerprint: resolved.fingerprint, selection: message.sourceSelection }
          } else {
            if (!request.validate) throw new Error('WORKTREE_STALE')
            await request.validate()
          }
        } catch (error) { code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'WORKTREE_STALE' }
        if (generation !== this.generation || generation.closing || !this.pending.has(message.id) || !this.active()) return
        if (Date.now() >= request.deadline) { this.expire(message.id); return }
        worker.postMessage({ validation: message.validate, code, ...(target ? { target } : {}) })
        return
      }
      if (message.result) {
        if (message.nativeReports?.length) {
          let needsMaintenance = false
          for (const report of message.nativeReports) {
            const key = `${report.worktreeId}:${report.generation}`
            if (report.settledSpools?.length) {
              for (const settled of report.settledSpools) this.settledSpools.set(settled.spool, settled.filesKey)
            }
            if (report.errorCode && !report.progressed) {
              const prior = this.targetBackoff.get(key)?.failures ?? 0
              const failures = prior + 1
              this.targetBackoff.set(key, { failures, untilMs: Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)) })
            } else if (report.progressed || !report.remainingSpool) {
              this.targetBackoff.delete(key)
            }
            if (report.errorCode || report.remainingSpool || report.remainingScan) {
              this.cleanMaintenanceTargets.delete(key)
            } else if (request.isMaintenance) {
              this.cleanMaintenanceTargets.add(key)
            }
            if (report.remainingSpool || report.remainingScan) needsMaintenance = true
          }
          if (needsMaintenance && !request.isMaintenance) this.onMaintenanceNeeded?.()
        }
        try {
          if (request.verifyNativeTrust) {
            await request.validate?.()
            if (!this.pending.has(message.id) || !this.active()) return
            if (Date.now() >= request.deadline) { this.expire(message.id); return }
            if (!request.verifyNativeTrust()) { this.finish(message.id, failure('SESSION_SCOPE_CHANGED')); return }
          }
          this.finish(message.id, message.result)
        } catch {
          this.finish(message.id, failure('WORKTREE_STALE'))
        }
      }
    })
    worker.on('error', () => { void this.retire(generation, 'SESSION_CONTEXT_UNAVAILABLE') })
    worker.on('exit', () => { if (!generation.closing) void this.retire(generation, 'SESSION_CONTEXT_UNAVAILABLE', true) })
    return generation
  }
  private expire(id: number): void {
    const request = this.pending.get(id)
    if (!request) return
    if (request.generation) {
      try { request.generation.worker.postMessage({ cancel: id }) } catch {}
      const hasOtherInteractive = [...this.pending.entries()].some(([otherId, other]) => otherId !== id && !other.isMaintenance)
      if (request.isMaintenance || hasOtherInteractive) {
        this.finish(id, failure('SESSION_CONTEXT_TIMEOUT', request.phase))
        return
      }
      void this.retire(request.generation, 'SESSION_CONTEXT_TIMEOUT')
    } else this.finish(id, failure('SESSION_CONTEXT_TIMEOUT', request.phase))
  }
  private retire(generation: Generation, code: string, exited = false): Promise<void> {
    if (generation.closing) return this.retiring
    generation.closing = true
    Atomics.store(generation.cancellation, 0, 1)
    if (this.generation === generation) this.generation = undefined
    this.retiring = exited ? Promise.resolve() : new Promise<void>(resolve => {
      const timer = setTimeout(() => { void generation.worker.terminate() }, 1500)
      timer.unref()
      generation.worker.once('exit', () => { clearTimeout(timer); resolve() })
      try { generation.worker.postMessage({ close: true }) } catch { void generation.worker.terminate() }
    })
    for (const [id, request] of this.pending) {
      if (request.generation === generation) this.finish(id, failure(code, request.phase))
    }
    return this.retiring
  }
  reconcileProjection(): Promise<McpToolResult> {
    return this.active()
      ? this.dispatch('reconcile_checkpoint_registry', {}, { captureNative: true, nativeMode: 'MAINTENANCE', isMaintenance: true })
      : Promise.resolve(failure('PROJECT_CONTEXT_CHANGED'))
  }
  private async resolveSelectionOnce(selection: SessionTargetSelection) {
    if (!this.resolveTarget) return undefined
    try {
      return await this.resolveTarget(selection)
    } catch (error) {
      if (error instanceof Error && error.message === 'WORKTREE_NOT_DISCOVERED' && this.resolveTarget.discover) {
        try {
          await this.resolveTarget.discover()
          return await this.resolveTarget(selection)
        } catch { return undefined }
      }
      return undefined
    }
  }
  private hasSpoolBacklog(root: string, agent?: NativeHookProvider): boolean {
    const providers = agent ? [agent] : nativeHookProviders
    for (const provider of providers) {
      const bindingPath = nativeBindingPath(root, provider)
      if (!existsSync(bindingPath)) continue
      try {
        const binding = readNativeBinding(bindingPath)
        if (!binding.enabled) continue
        const files = spoolEventFiles(binding.spool)
        if (!files.length) { this.settledSpools.delete(binding.spool); continue }
        if (this.settledSpools.get(binding.spool) !== files.join('\0')) return true
      } catch {
        return true
      }
    }
    return false
  }
  private dispatch(name: SessionToolName, args: unknown, options: { captureNative?: boolean; allowArtifactMetadata?: boolean; nativeMode?: 'FOCAL' | 'MAINTENANCE' | 'FULL'; isMaintenance?: boolean } = {}): Promise<McpToolResult> {
    if (this.pending.size >= 16) return Promise.resolve(failure('BACKPRESSURE'))
    const id = ++this.serial
    return new Promise<McpToolResult>(resolve => {
      const timeoutMs = this.timeoutMs ?? (name === 'reconcile_checkpoint_registry' || name === 'list_agent_sessions' || name === 'inspect_capture_health' ? 20_000 : isLiveSessionTool(name) ? 20_000 : name === 'read_agent_session_event' ? 14_000 : name === 'refresh_agent_sessions' ? ((parseSessionRefresh(args).sessionId || parseSessionRefresh(args).nativeSession) ? 14_000 : 12_000) : (name === 'inspect_code_provenance' || name === 'inspect_entire_checkpoint') ? 12_000 : 5000)
      const deadline = Date.now() + timeoutMs
      const request: Request = { resolve, deadline, phase: 'worker-recovery', selectionValidators: new Map(), isMaintenance: options.isMaintenance, timer: setTimeout(() => this.expire(id), timeoutMs) }
      this.pending.set(id, request)
      void (async () => {
        try {
          await this.retiring
          if (!this.pending.has(id) || !this.active()) return
          const normalizedArgs = normalizeScopedReadArgs(name, args, this.repositoryId)
          args = normalizedArgs
          let target
          let liveTargets
          let nativeTargets: LiveSessionTarget[] | undefined
          let nativeMode: 'FOCAL' | 'MAINTENANCE' | 'FULL' = options.nativeMode ?? 'FULL'
          let nativeAgent: NativeHookProvider | undefined
          let nativeBudgetMs: number | undefined
          let hasMoreNativeTargets = false
          let nativeTrust: NativeTrustSnapshot | undefined
          const paginated = !!(normalizedArgs && typeof normalizedArgs === 'object' && 'cursor' in normalizedArgs && normalizedArgs.cursor)
          if (name === 'list_agent_sessions') {
            try {
              const query = parseSessionList(normalizedArgs)
              const hasWorktree = !!(query.worktreeId && query.generation)
              const hasSelector = !!(query.commitSha || query.pullRequest || query.artifactId || query.executionId)
              if (query.agent === 'codex' || query.agent === 'antigravity') nativeAgent = query.agent
              if (hasWorktree) {
                request.phase = 'target-resolution'
                const selection = { worktreeId: query.worktreeId!, generation: query.generation! }
                const resolved = await this.resolveSelectionOnce(selection)
                if (resolved) {
                  target = { ...resolved, selection }
                  request.validate = resolved.validate
                  liveTargets = [{ ...selection, root: resolved.root, fingerprint: resolved.fingerprint }]
                  if (!paginated && !hasSelector && options.captureNative !== false && hasNativeBindingFile(resolved.root, nativeAgent)) {
                    this.prioritizedTarget = selection
                    if (this.hasSpoolBacklog(resolved.root, nativeAgent)) {
                      nativeMode = 'FOCAL'
                      nativeTargets = liveTargets
                      nativeBudgetMs = Math.max(400, Math.min(2000, timeoutMs - 2500))
                    }
                  }
                }
              } else if (!paginated && options.captureNative !== false) {
                this.onMaintenanceNeeded?.()
              }
            } catch { throw new Error('INVALID_ARGUMENT') }
          }
          const health = name === 'inspect_capture_health' ? parseCaptureHealth(normalizedArgs) : undefined
          const hasReconcileSelector = name === 'reconcile_checkpoint_registry' && !!(normalizedArgs && typeof normalizedArgs === 'object' &&
            ['artifactId', 'executionId', 'commitSha', 'pullRequest', 'checkpointId'].some(key => Boolean((normalizedArgs as Record<string, unknown>)[key])))
          if (name === 'reconcile_checkpoint_registry' && !hasReconcileSelector && !paginated && options.captureNative !== false && this.resolveTarget) {
            const maintenance = options.nativeMode === 'MAINTENANCE'
            const candidates = this.resolveTarget.discoverMatching
              ? await this.resolveTarget.discoverMatching(root => hasNativeBindingFile(root))
              : (!maintenance && this.resolveTarget.discover ? (await this.resolveTarget.discover()).filter(t => hasNativeBindingFile(t.root)) : [])
            if (candidates.length) {
              request.phase = 'native-target-resolution'
              const now = Date.now()
              const eligible = candidates.filter(candidate => {
                const key = `${candidate.worktreeId}:${candidate.generation}`
                const backoff = this.targetBackoff.get(key)
                return !backoff || backoff.untilMs <= now
              })
              const start = this.nativeOffset % Math.max(1, eligible.length)
              const rotated = [...eligible.slice(start), ...eligible.slice(0, start)]
              const prioritizedIndex = this.prioritizedTarget
                ? rotated.findIndex(item => item.worktreeId === this.prioritizedTarget!.worktreeId && item.generation === this.prioritizedTarget!.generation)
                : -1
              if (prioritizedIndex > 0) {
                const [prioritized] = rotated.splice(prioritizedIndex, 1)
                rotated.unshift(prioritized)
              }
              if (maintenance) {
                const dirty = rotated.filter(candidate => this.hasSpoolBacklog(candidate.root))
                const needsScan = rotated.filter(candidate => !this.hasSpoolBacklog(candidate.root) && !this.cleanMaintenanceTargets.has(`${candidate.worktreeId}:${candidate.generation}`))
                const selected = dirty.length ? dirty.slice(0, 2) : needsScan.slice(0, 2)
                const transientBackoffPending = candidates.some(candidate => {
                  const key = `${candidate.worktreeId}:${candidate.generation}`
                  const backoff = this.targetBackoff.get(key)
                  return !!backoff && backoff.untilMs > now && backoff.failures < 3 && (this.hasSpoolBacklog(candidate.root) || !this.cleanMaintenanceTargets.has(key))
                })
                nativeTargets = selected.length ? selected : undefined
                hasMoreNativeTargets = dirty.length + needsScan.length > selected.length || transientBackoffPending
                nativeBudgetMs = Math.max(500, Math.min(2500, timeoutMs - 2500))
                this.nativeOffset = eligible.length ? (start + selected.length) % eligible.length : 0
              } else {
                nativeTargets = rotated.slice(0, 8)
                this.nativeOffset = eligible.length ? (start + nativeTargets.length) % eligible.length : 0
              }
            }
          }
          if (health) {
            const query = health
            if (query.worktreeId && this.resolveTarget) {
              const selection = { worktreeId: query.worktreeId, generation: query.generation! }
              target = { ...await this.resolveTarget(selection), selection }
            } else if (this.resolveTarget?.current) target = await this.resolveTarget.current()
            if (!target) throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
            request.validate = target.validate
            const requestedAgent = query.source === 'native' ? nativeCaptureAgent(query) : (query.agent === 'codex' || query.agent === 'antigravity' ? query.agent : undefined)
            nativeAgent = requestedAgent
            if (options.captureNative !== false && hasNativeBindingFile(target.root, requestedAgent) && (query.trigger === 'RECHECK' || this.hasSpoolBacklog(target.root, requestedAgent))) {
              nativeMode = 'FOCAL'
              nativeTargets = [{ ...target.selection, root: target.root, fingerprint: target.fingerprint }]
              nativeBudgetMs = Math.max(400, Math.min(2000, timeoutMs - 2500))
            }
            const client = this.nativeHookClient
            if (query.inspectNativeTrust && client && query.source !== 'entire' && requestedAgent !== 'antigravity') {
              request.phase = 'native-trust-inspection'
              const root = target.root
              const scope = { repositoryId: this.repositoryId, ...target.selection }
              const assertCurrent = () => {
                if (!this.pending.has(id) || !this.active() || Date.now() >= deadline) throw new Error('PROJECT_CONTEXT_CHANGED')
              }
              const observation = await inspectNativeTrust(root, scope, true, client, assertCurrent)
              await target.validate()
              assertCurrent()
              nativeTrust = { ...scope, observation }
              if (observation.clientId) request.verifyNativeTrust = () => matchesNativeClient(client, observation, scope, root) &&
                !!observation.expiresAt && Date.parse(observation.expiresAt) > Date.now()
            }
          }
          if (isLiveSessionTool(name)) {
            const q = parseLiveSessionQuery(name, args)
            if (!this.resolveTarget?.discover) throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
            request.phase = 'target-resolution'
            if (q.worktreeId) {
              const selection = { worktreeId: q.worktreeId, generation: q.generation! }
              target = { ...await this.resolveTarget(selection), selection }
              request.validate = target.validate
              liveTargets = [{ ...selection, root: target.root, fingerprint: target.fingerprint }]
            } else {
              liveTargets = await this.resolveTarget.discover()
              const snapshot = liveTargets
              request.validate = async () => {
                const fresh = await this.resolveTarget!.discover!()
                if (snapshot.some(t => !fresh.some(f => f.worktreeId === t.worktreeId && f.generation === t.generation && f.root === t.root && f.fingerprint === t.fingerprint))) throw new Error('WORKTREE_STALE')
              }
            }
          }
          if (name === 'refresh_agent_sessions') {
            let q
            try { q = parseSessionRefresh(args) } catch { throw new Error('INVALID_ARGUMENT') }
            if (q.association) {
              if (!this.authorizeAssociation) throw new Error('ASSOCIATION_AUTHORITY_UNAVAILABLE')
              const source = await this.authorizeAssociation(q)
              q.association = { ...q.association, ...source }
              args = q
            }
            if (q.worktreeId) {
              if (!this.resolveTarget) throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
              request.phase = 'target-resolution'
              const selection = { worktreeId: q.worktreeId, generation: q.generation! }
              target = { ...await this.resolveTarget(selection), selection }
              request.validate = target.validate
            } else if (this.resolveTarget?.current) {
              target = await this.resolveTarget.current()
              request.validate = target.validate
            }
          }
          if (name === 'search_agent_session_evidence') {
            let q
            try { q = parseEvidenceSearch(normalizedArgs) } catch { throw new Error('INVALID_ARGUMENT') }
            if (!q.sourceSessionId && this.resolveTarget) {
              const wtSel = q.worktreeId && q.generation
                ? { worktreeId: q.worktreeId, generation: q.generation }
                : q.nativeSession?.worktreeId && q.nativeSession?.generation
                  ? { worktreeId: q.nativeSession.worktreeId, generation: q.nativeSession.generation }
                  : undefined
              if (wtSel) {
                request.phase = 'target-resolution'
                const resolved = await this.resolveSelectionOnce(wtSel)
                if (resolved) {
                  target = { ...resolved, selection: wtSel }
                  request.validate = resolved.validate
                  liveTargets = [{ ...wtSel, root: resolved.root, fingerprint: resolved.fingerprint }]
                }
              } else if (this.resolveTarget.discover) {
                request.phase = 'target-resolution'
                liveTargets = await this.resolveTarget.discover()
                const snapshot = liveTargets
                request.validate = async () => {
                  const fresh = await this.resolveTarget!.discover!()
                  if (snapshot.some(t => !fresh.some(f => f.worktreeId === t.worktreeId && f.generation === t.generation && f.root === t.root && f.fingerprint === t.fingerprint))) throw new Error('WORKTREE_STALE')
                }
              }
            }
          }
          const literalTarget = nativeLiteralTarget(name, args)
          if (literalTarget) {
            if (!this.resolveTarget) throw new Error('ORIGIN_UNVERIFIED')
            request.phase = 'target-resolution'
            let literalWorktree
            try { literalWorktree = await this.resolveTarget(literalTarget) }
            catch (error) {
              if (!(error instanceof Error) || error.message !== 'WORKTREE_NOT_DISCOVERED' || !this.resolveTarget.discover) throw error
              await this.resolveTarget.discover()
              literalWorktree = await this.resolveTarget(literalTarget)
            }
            target = { ...literalWorktree, selection: literalTarget }
            request.validate = target.validate
          }
          if ((name === 'inspect_code_provenance' || name === 'inspect_entire_checkpoint') && args && typeof args === 'object' && 'worktreeId' in args && (args as any).worktreeId) {
            const q = args as { worktreeId: string; generation?: string }
            if (!this.resolveTarget) throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
            request.phase = 'target-resolution'
            const selection = { worktreeId: q.worktreeId, generation: q.generation! }
            target = { ...await this.resolveTarget(selection), selection }
            request.validate = target.validate
          } else if (name === 'inspect_entire_checkpoint' && this.resolveTarget?.current) {
            target = await this.resolveTarget.current()
            request.validate = target.validate
          }
          if (!this.pending.has(id) || !this.active()) return
          if (Date.now() >= deadline) { this.expire(id); return }
          request.phase = 'worker-dispatch'
          request.generation = this.generation ?? this.createGeneration()
          request.generation.worker.postMessage({ id, name, args, deadline, allowArtifactMetadata: options.allowArtifactMetadata, nativeMode, ...(nativeAgent ? { nativeAgent } : {}), ...(nativeBudgetMs !== undefined ? { nativeBudgetMs } : {}), ...(hasMoreNativeTargets ? { hasMoreNativeTargets } : {}), ...(nativeTrust ? { nativeTrust } : {}), ...(nativeTargets ? { nativeTargets } : {}), ...(liveTargets ? { liveTargets } : {}), ...(target ? { target: { root: target.root, fingerprint: target.fingerprint, selection: target.selection } } : {}) })
        } catch (error) {
          this.finish(id, failure(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'SESSION_CONTEXT_UNAVAILABLE'))
        }
      })()
    })
  }
  dispose(code = 'PROJECT_CONTEXT_CHANGED'): Promise<void> {
    this.terminal = true
    if (this.generation) void this.retire(this.generation, code)
    for (const id of this.pending.keys()) this.finish(id, failure(code))
    return this.retiring
  }
}
