import { randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { PreviewSelection, PreviewPreflight } from '../../../shared/types/runtime-preview-types'
import { bytesFingerprint, previewFingerprint, type PreviewProfile } from '../preview-profile'
import type { PreviewProfileStore } from '../preview-profile-store'
import { previewPath, type PreviewPreflightService } from '../preview-preflight'
import type { PreviewRepositories } from '../preview-repositories'
import { NativeOwner, nativeObservation, type NativeObservation } from './native-owner'
import { PreviewSessionStore, sessionSchema, type PreviewSessionRecord } from './session-store'
import { PreviewStackAdapter, diagnosticBootstrapAllowed, verifyEndpointFree } from './adapters'
import type { PreviewContextProvisioner } from './context-data'
import { PreviewStartClock } from './start-timing'
import type { PreviewBuildCache } from './build-cache'
import { prepareTogether } from './preparation'
import { watch, type FSWatcher } from 'node:fs'
import { freemem, availableParallelism } from 'node:os'
import type { StandbyPolicy } from './standby-policy'

export interface PreparedPreview {
  profile: PreviewProfile; worktree: string; gitFingerprint: string; preflight: PreviewPreflight;
  guard: () => Promise<void>
  presentationGuard?: () => Promise<void>
  retentionGuard?: () => Promise<void>
  classifyChanges?: (paths: string[]) => Promise<Set<string>>
  observeSource?: () => Promise<NonNullable<PreviewPreflight['snapshot']>>
}
type LaunchContext = Awaited<ReturnType<PreviewRepositories['open']>>
export interface PreviewLaunchAuthority { prepare(selection: PreviewSelection, timing?: PreviewStartClock, context?: LaunchContext, evidence?: PreviewPreflight): Promise<PreparedPreview> }
export class CatalogPreviewLaunchAuthority implements PreviewLaunchAuthority {
  constructor(private readonly repositories: PreviewRepositories, private readonly profiles: PreviewProfileStore,
    private readonly preflight: PreviewPreflightService) {}
  async prepare(selection: PreviewSelection, timing?: PreviewStartClock, knownContext?: LaunchContext, evidence?: PreviewPreflight): Promise<PreparedPreview> {
    const context = knownContext ?? await (timing ? timing.measure('repository', () => this.repositories.open(selection.repositoryId, selection.worktreeId)) : this.repositories.open(selection.repositoryId, selection.worktreeId))
    context.guard()
    const check = async () => { context.guard(); const run = () => this.preflight.check(context.git, selection, timing); const result = await (timing ? timing.measure('preflight', run) : run()); context.guard(); return result }
    const result = evidence && this.preflight.canReuse(context.git, selection, evidence) ? evidence : await check()
    const identity = await context.git.getCoordinationIdentity(selection.worktreeId)
    const profile = (await this.profiles.profiles(selection.repositoryId)).find(p => p.profileId === selection.profileId)
    if (!profile || !await this.profiles.approved(profile) || previewFingerprint(profile) !== selection.fingerprint) throw new Error('PROFILE_APPROVAL_REQUIRED')
    if (identity.repositoryId !== selection.repositoryId || identity.record.generation !== selection.generation) throw new Error('WORKTREE_STALE')
    const gitFingerprint = previewFingerprint(result.snapshot)
    const trust = await this.profiles.trusted(profile)
    const materialization = async () => {
      try { return bytesFingerprint(await readFile(await previewPath(identity.record.path, profile.dependencies.materialization))) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    }
    const materializationDigest = await materialization()
    return { profile, worktree: identity.record.path, gitFingerprint, preflight: result,
      classifyChanges: paths => context.git.classifyRuntimePreviewChanges(selection.worktreeId, paths),
      retentionGuard: async () => {
        context.guard()
        const approved = (await this.profiles.profiles(selection.repositoryId)).find(value => value.profileId === profile.profileId)
        if (!approved || previewFingerprint(approved) !== selection.fingerprint || !trust || previewFingerprint(await this.profiles.trusted(approved)) !== previewFingerprint(trust)) throw new Error('REPOSITORY_TRUST_REQUIRED')
      }, observeSource: async () => {
      context.guard()
      const current = await context.git.getCoordinationIdentity(selection.worktreeId)
      if (current.repositoryId !== selection.repositoryId || current.record.generation !== selection.generation || current.record.path !== identity.record.path) throw new Error('WORKTREE_STALE')
      const snapshot = await context.git.getCoordinationSnapshot(selection.worktreeId)
      if (snapshot.snapshot.branch !== result.snapshot?.branch || snapshot.record.detached || snapshot.record.locked || snapshot.conflictCount || snapshot.snapshot.operation) throw new Error('WORKTREE_CONTEXT_CHANGED')
      const approved = (await this.profiles.profiles(selection.repositoryId)).find(p => p.profileId === selection.profileId)
      if (!approved || previewFingerprint(approved) !== selection.fingerprint || !await this.profiles.approved(approved)) throw new Error('PROFILE_CHANGED')
      context.guard()
      return { ...snapshot.snapshot, dirty: snapshot.stagedCount + snapshot.unstagedCount + snapshot.untrackedCount > 0 }
    }, presentationGuard: async () => {
      context.guard()
      const approved = (await this.profiles.profiles(selection.repositoryId)).find(value => value.profileId === profile.profileId)
      if (!approved || previewFingerprint(approved) !== selection.fingerprint || !trust || previewFingerprint(await this.profiles.trusted(approved)) !== previewFingerprint(trust)) throw new Error('REPOSITORY_TRUST_REQUIRED')
      const files = [...profile.command.inputs, { path: profile.dependencies.manifest, fingerprint: profile.dependencies.manifestHash }, { path: profile.dependencies.lockfile, fingerprint: profile.dependencies.lockfileHash }]
      for (const file of files) if (bytesFingerprint(await readFile(await previewPath(identity.record.path, file.path))) !== file.fingerprint) throw new Error('PREPARED_INPUT_CHANGED')
      if (bytesFingerprint(await readFile(profile.command.executable)) !== profile.command.executableHash || bytesFingerprint(await readFile(await previewPath(identity.record.path, profile.adapter!.runtimeExecutable!))) !== profile.adapter!.runtimeExecutableHash) throw new Error('PREPARED_EXECUTABLE_CHANGED')
      if (await materialization() !== materializationDigest) throw new Error('PREPARED_MATERIALIZATION_CHANGED')
      const source = await context.git.getCoordinationSnapshot(selection.worktreeId)
      if (source.record.generation !== selection.generation || source.record.path !== identity.record.path || source.record.detached || source.record.locked || source.conflictCount || source.snapshot.operation ||
        previewFingerprint({ ...source.snapshot, dirty: source.stagedCount + source.unstagedCount + source.untrackedCount > 0 }) !== gitFingerprint) throw new Error('PREPARED_SOURCE_CHANGED')
      context.guard()
    }, guard: async () => {
      context.guard()
      const current = await this.preflight.revalidate(context.git, selection, result, timing)
      context.guard()
      if ((current.status !== 'SUPPORTED' && !diagnosticBootstrapAllowed(current, profile)) || previewFingerprint(current.snapshot) !== gitFingerprint || current.dependencyBasis !== result.dependencyBasis || !await this.profiles.approved(profile)) throw new Error('LAUNCH_EVIDENCE_CHANGED')
    } }
  }
}

const drained = (p: NativeObservation) => p.rootSignaled && p.knownHandlesClosed && p.activeProcesses === 0 && p.jobClosed && p.eventClosed && p.ownerOutsideJob
const terminalProof = (p: NativeObservation) => drained(p) || (!p.assignedAtCreation && p.pid === 0 && p.created === null && p.knownHandlesClosed && p.activeProcesses === 0 && p.jobClosed && p.eventClosed && p.ownerOutsideJob)
const selectionKey = (s: PreviewSelection) => previewFingerprint([s.repositoryId, s.worktreeId, s.generation, s.profileId, s.fingerprint])
const reserved = /^(SYSTEMROOT|TEMP|TMP|APPDATA|LOCALAPPDATA|USERPROFILE|HOME|PREVIEW_.*|NODE_OPTIONS|ELECTRON_RUN_AS_NODE|CODE_AWARENESS.*)$/i
class SessionPersistenceFailure extends Error {
  constructor(readonly record: PreviewSessionRecord) { super('SESSION_RECEIPT_WRITE_FAILED') }
}
export class RuntimePreviewRunner {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly owners = new Map<string, NativeOwner>()
  private readonly adapters = new Map<string, PreviewStackAdapter>()
  private readonly sources = new Map<string, NonNullable<PreparedPreview['observeSource']>>()
  private readonly retentions = new Map<string, AbortController>()
  private readonly cancellations = new Map<string, AbortController>()
  private readonly stopRequests = new Set<string>()
  private readonly slots = new Map<string, { guard: () => Promise<void>; timer?: NodeJS.Timeout; watcher: FSWatcher;
    metrics?: NonNullable<NonNullable<PreviewSessionRecord['standby']>['metrics']>; previous?: { at: number; cpu: number }; invalid: boolean; disposeContext?: () => void;
    checkChanges?: () => Promise<void>; retentionGuard?: () => Promise<void>; classifyChanges?: PreparedPreview['classifyChanges'] }>()
  constructor(private readonly store: PreviewSessionStore, private readonly authority: PreviewLaunchAuthority,
    private readonly helper: { executable: string; fingerprint: string; sdkDirectory?: string }, private readonly contextProvisioner?: PreviewContextProvisioner,
    private readonly options: { buildCache?: boolean } = {}) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(fn); this.tail = operation.catch(() => {}); return operation
  }
  private change(record: PreviewSessionRecord, update: Partial<PreviewSessionRecord>) {
    const next = { ...record, ...update, revision: record.revision + 1, at: new Date().toISOString() }
    if (update.resources) next.resourceInventory = record.resourceInventory.map(r => ({ ...r, state: r.kind === 'DISABLED' ? 'RELEASED' : update.resources! }))
    if (update.state === 'STOPPED' || update.state === 'FAILED') next.endedAt = next.at
    if (update.state === 'OWNERSHIP_UNVERIFIED') next.coverage = record.coverage.map(c => c.status === 'VERIFIED' ? { ...c, status: 'STALE', reasonCode: 'OWNER_LOST_OR_UNREACHABLE', at: next.at } : c)
    try { this.store.append(next) } catch { throw new SessionPersistenceFailure(next) }
    return next
  }
  private receiptFailure(error: unknown): PreviewSessionRecord {
    if (!(error instanceof SessionPersistenceFailure)) throw error
    return { ...error.record, persistence: 'UNVERIFIABLE', state: 'CLEANUP_INCOMPLETE', reconciliation: 'REQUIRED', resources: 'UNVERIFIABLE',
      resourceInventory: error.record.resourceInventory.map(r => ({ ...r, state: r.kind === 'DISABLED' ? 'RELEASED' : 'UNVERIFIABLE' })),
      liveness: 'UNVERIFIABLE', endedAt: null, failure: 'SESSION_RECEIPT_WRITE_FAILED' }
  }
  private command(fn: () => Promise<PreviewSessionRecord>) {
    return this.serial(fn).catch(error => this.receiptFailure(error))
  }
  private async owner(timing?: PreviewStartClock) {
    if (bytesFingerprint(await (timing ? timing.read(this.helper.executable) : readFile(this.helper.executable))) !== this.helper.fingerprint) throw new Error('NATIVE_HELPER_CHANGED')
    return new NativeOwner(this.helper.executable)
  }
  private termination(record: PreviewSessionRecord, kind: NonNullable<PreviewSessionRecord['termination']>['kind'], reasonCode: string,
    observation: NativeObservation | null, status: 'RESPONDING' | 'EXITED' | 'UNKNOWN') {
    if (record.termination && record.termination.kind !== 'UNKNOWN') return record
    const journal = this.store.nativeJournal(record.sessionId).at(-1)
    return this.change(record, { termination: { kind, reasonCode, observedAt: new Date().toISOString(),
      rootExit: observation?.rootExit ?? { status: 'UNKNOWN', code: null, reasonCode: 'EXIT_STATUS_NOT_RECORDED', observedAt: null },
      supervisor: { status, phase: typeof journal?.phase === 'string' ? journal.phase : null,
        pid: typeof journal?.ownerPid === 'number' ? journal.ownerPid : null, created: typeof journal?.ownerCreated === 'string' ? journal.ownerCreated : null }, process: observation } })
  }
  private terminal(record: PreviewSessionRecord) {
    return record.termination?.kind === 'STOP_REQUESTED' ? { state: 'STOPPED' as const, failure: null } :
      { state: 'FAILED' as const, failure: record.termination?.reasonCode ?? 'TERMINATION_REASON_UNKNOWN' }
  }
  private supervisorExited(record: PreviewSessionRecord) {
    if (!record.termination || record.termination.supervisorExit) return record
    return this.change(record, { termination: { ...record.termination, supervisorExit: { observedAt: new Date().toISOString() } } })
  }
  start(input: { operationId: string; selection: PreviewSelection; guard?: () => void | Promise<void>; timing?: PreviewStartClock; launchContext?: LaunchContext; preflightEvidence?: PreviewPreflight; standbyPolicy?: StandbyPolicy }): Promise<PreviewSessionRecord> {

    const selection = sessionSchema.shape.selection.safeParse(input.selection)
    if (!selection.success) return Promise.reject(selection.error)
    input = { ...input, selection: selection.data }
    const timing = input.timing ?? new PreviewStartClock()
    const buildCacheEnabled = this.options.buildCache ?? false
    const queued = timing.waiting('queue')
    return this.command(async () => {
      queued()
      if (!input.preflightEvidence) await input.guard?.()
      if (!sessionSchema.shape.operationId.safeParse(input.operationId).success) throw new Error('INVALID_OPERATION_ID')
      const previous = this.store.list().find(r => r.operationId === input.operationId)
      if (previous) {
        if (selectionKey(previous.selection) !== selectionKey(input.selection)) throw new Error('OPERATION_ID_CONFLICT')
        return this.inspectInternal(previous.sessionId)
      }
      if (this.store.active()) throw new Error('PREVIEW_SESSION_BUSY')
      const prepared = await timing.measure('authority', () => this.authority.prepare(input.selection, timing, input.launchContext, input.preflightEvidence))
      const originalGuard = prepared.guard
      prepared.guard = () => timing.measure('guard', originalGuard)
      const cancellation = new AbortController()
      const verify = async () => { cancellation.signal.throwIfAborted(); await prepared.guard(); await input.guard?.(); cancellation.signal.throwIfAborted() }
      const { profile, preflight } = prepared
      if (preflight.status !== 'SUPPORTED' && !diagnosticBootstrapAllowed(preflight, profile)) throw new Error('PREFLIGHT_' + preflight.status)
      if (selectionKey(preflight.selection) !== selectionKey(input.selection) || previewFingerprint(profile) !== input.selection.fingerprint || preflight.profileRevision !== profile.revision || profile.repositoryId !== input.selection.repositoryId) throw new Error('LAUNCH_IDENTITY_MISMATCH')
      if (profile.shutdown.spawn !== 'JOB_LIST_AT_CREATE') throw new Error('SAFE_SPAWN_UNAVAILABLE')
      if (profile.security.mode !== 'profile_only' || profile.security.requirements.length) throw new Error('SECURITY_ISOLATION_UNAVAILABLE')
      if (profile.resources.some(r => r.strategy === 'SESSION_ENDPOINT') && !profile.adapter) throw new Error('RESOURCE_ADAPTER_REQUIRED')
      if (Object.keys(profile.env).some(k => reserved.test(k))) throw new Error('RESERVED_ENVIRONMENT')
      this.store.assertExternal(prepared.worktree)
      const executable = await realpath(profile.command.executable)
      if (bytesFingerprint(await timing.measure('inputs', () => timing.read(executable))) !== profile.command.executableHash) throw new Error('EXECUTABLE_CHANGED')
      const cwd = await previewPath(prepared.worktree, profile.command.cwd)
      await timing.measure('inputs', async () => { for (const input of profile.command.inputs) if (bytesFingerprint(await timing.read(await previewPath(prepared.worktree, input.path))) !== input.fingerprint) throw new Error('COMMAND_INPUT_CHANGED') })
      await verify()
      const sessionId = randomUUID()
      const at = new Date().toISOString()
      const missingScope = (stage: PreviewSessionRecord['coverage'][number]['stage'], component: PreviewSessionRecord['coverage'][number]['component']): PreviewSessionRecord['coverage'][number] => ({ stage, component, status: 'NOT_OBSERVED', fingerprint: null, evidenceRef: null, at, reasonCode: stage === 'BEHAVIOR' ? 'FEATURE_ACCEPTANCE_NOT_EVALUATED' : 'ADAPTER_EVIDENCE_NOT_OBSERVED' })
      let record: PreviewSessionRecord = { schemaVersion: 1, persistence: 'PERSISTED', sessionId, operationId: input.operationId, selection: input.selection,
        profileRevision: profile.revision, gitFingerprint: prepared.gitFingerprint, revision: 0, at, startedAt: at, endedAt: null, sourceSnapshot: preflight.snapshot ?? null, state: 'PREPARING',
        reconciliation: 'NOT_REQUIRED', failure: null, resources: 'RESERVED', process: null, readiness: 'NOT_OBSERVED', liveness: 'NOT_OBSERVED',
        recoveryObservation: null, resourceInventory: [
          { name: 'process-owner', kind: 'JOB', reference: sessionId, state: 'RESERVED' },
          { name: 'graceful-stop', kind: 'STOP_EVENT', reference: sessionId, state: 'RESERVED' },
          ...profile.resources.map(r => ({ name: r.name, kind: r.strategy, reference: r.strategy === 'SESSION_ENDPOINT' ? `127.0.0.1:${profile.adapter!.port}` : sessionId + '/runtime', state: r.strategy === 'DISABLED' ? 'RELEASED' as const : 'RESERVED' as const }))
        ],
        attestation: { artifact: 'NOT_OBSERVED', loadedCode: 'NOT_OBSERVED' },
        coverage: [
          { stage: 'TARGET_CHECKOUT', component: 'TARGET', status: preflight.snapshot ? 'VERIFIED' : 'UNVERIFIABLE', fingerprint: preflight.snapshot ? prepared.gitFingerprint : null, evidenceRef: preflight.snapshot ? 'sourceSnapshot' : null, at, reasonCode: preflight.snapshot ? 'GIT_SOURCE_OBSERVED_AT_LAUNCH' : 'CHECKOUT_NOT_ATTESTED' },
          missingScope('ENDPOINT', 'PROCESS'), missingScope('SERVED_ARTIFACT', 'WEB'), missingScope('BEHAVIOR', 'TARGET'),
          ...(profile.runtime === 'WEB_DEV_SERVER' ? [missingScope('LOADED_COMPONENT', 'WEB')] : [missingScope('LOADED_COMPONENT', 'ELECTRON_MAIN'), missingScope('LOADED_COMPONENT', 'ELECTRON_PRELOAD'), missingScope('LOADED_COMPONENT', 'ELECTRON_RENDERER')])
        ],
        shutdown: { graceMs: profile.shutdown.graceMs, forceMs: profile.shutdown.forceMs, graceful: profile.shutdown.graceful === 'SESSION_EVENT' } }
      this.store.reserve(record)
      if (input.standbyPolicy) record = this.change(record, { standby: { state: 'WARMING', policy: input.standbyPolicy, expiresAt: new Date(Date.now() + input.standbyPolicy.idleMs).toISOString() } })
      this.cancellations.set(sessionId, cancellation)
      let native: NativeOwner | undefined
      let adapter: PreviewStackAdapter | undefined
      let cache: PreviewBuildCache | undefined
      let createRequested = false
      try {
        const [context] = await prepareTogether(async signal => {
          if (!profile.bootstrap) return undefined
          if (!this.contextProvisioner || !preflight.snapshot) throw new Error('PREVIEW_CONTEXT_PROVISIONER_REQUIRED')
          return timing.measure('context', () => this.contextProvisioner!.prepare({ profile, selection: input.selection, sessionId,
            directory: this.store.runtime(sessionId), worktree: prepared.worktree, source: preflight.snapshot!, timing, signal }))
        }, async signal => {
          if (!profile.adapter) return
          if (!this.helper.sdkDirectory) throw new Error('TRUSTED_SDK_REQUIRED')
          adapter = await timing.measure('adapter', () => PreviewStackAdapter.prepare(profile, prepared.worktree, this.store.runtime(sessionId), sessionId, this.helper.sdkDirectory!, undefined, true, signal))
          if (input.standbyPolicy) adapter.prepareHidden()
          cache = await timing.measure('cache', () => adapter!.prepareCache(join(this.store.root, 'build-cache'), input.selection,
            previewFingerprint([preflight.dependencyBasis, preflight.snapshot]), signal, buildCacheEnabled, timing))
          signal.throwIfAborted()
        })
        if (context) {
          record = this.change(record, { context })
        }
        if (adapter) {
          await adapter.bindContext(record.context)
          this.adapters.set(sessionId, adapter)
          if (prepared.observeSource) this.sources.set(sessionId, prepared.observeSource)
        }
        native = await timing.measure('ownership', () => this.owner(timing)); this.owners.set(sessionId, native)
        await verify()
        await cache?.guard()
        const runtime = this.store.runtime(sessionId)
        createRequested = true
        const observation = await timing.measure('spawn', () => native!.start({ sessionId, operationId: input.operationId, directory: this.store.directory(sessionId),
          slotKey: bytesFingerprint(this.store.root.toLowerCase()), executable, executableHash: profile.command.executableHash, cwd, args: profile.command.args, spawn: 'JOB_LIST_AT_CREATE',
          graceful: profile.shutdown.graceful ?? 'NONE', graceMs: profile.shutdown.graceMs, forceMs: profile.shutdown.forceMs, hostPid: process.pid,
          env: { ...profile.env, SystemRoot: process.env.SystemRoot!, TEMP: runtime, TMP: runtime, APPDATA: runtime, LOCALAPPDATA: runtime, USERPROFILE: runtime, HOME: runtime,
            PREVIEW_SESSION_ID: sessionId, PREVIEW_SESSION_DIRECTORY: runtime, ...adapter?.environment() } }))
        if (!observation.assignedAtCreation || !observation.ownerOutsideJob || !observation.pid || !observation.created) throw new Error('OWNERSHIP_UNVERIFIED')
        let stack: Awaited<ReturnType<PreviewStackAdapter['observe']>> | undefined
        if (adapter) {
          await timing.measure('abi', () => adapter!.permit(native!, async actual => {
            await verify()
            await cache?.guard()
            record = this.change(record, { process: observation, runtimeEvidence: { ...actual, preflight: preflight.status === 'SUPPORTED' ? 'SUPPORTED' : 'UNKNOWN', at: new Date().toISOString(), scope: 'DECLARED_INSTALL_SCRIPTS' } })
          }))
          stack = await timing.measure('startup', () => adapter!.awaitReady(native!, cancellation.signal))
          await adapter.measureBootstrap(timing)
          if (cache) cache.receipt.optimizerRuns = await adapter.optimizerRuns()
          if (adapter.presentedAt) timing.presented(adapter.presentedAt)
        }
        await verify()
        timing.ready()
        record = this.change(record, { state: 'RUNNING', process: observation, liveness: observation.activeProcesses > 0 ? 'VERIFIED' : 'UNVERIFIABLE', startTiming: timing.snapshot(), ...(cache ? { buildCache: cache.receipt } : {}) })
        if (stack) record = this.change(record, { ...stack, coverage: [...record.coverage.filter(c => ['TARGET_CHECKOUT', 'BEHAVIOR'].includes(c.stage)), ...stack.coverage] })
        if (input.standbyPolicy) {
          if (!adapter || !stack || stack.readiness !== 'READY' || stack.attestation.loadedCode !== 'VERIFIED') throw new Error('PREPARED_ATTESTATION_REQUIRED')
          const policy = input.standbyPolicy, preparedAt = new Date().toISOString()
          record = this.change(record, { standby: { state: 'QUIESCENT', policy, preparedAt, expiresAt: new Date(Date.now() + policy.idleMs).toISOString() } })
          this.monitorSlot(sessionId, prepared.worktree, async () => { cancellation.signal.throwIfAborted(); await (prepared.presentationGuard ?? prepared.guard)(); await input.guard?.() }, profile,
            async () => { await prepared.retentionGuard?.(); await input.guard?.() }, prepared.classifyChanges)
        }
        if (cache && cache.receipt.status !== 'DISABLED') {
          const retained = cache
          const cancellation = new AbortController(); this.retentions.set(sessionId, cancellation)
          const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(15000)])
          // STOP joins this existing serialization before deleting the private session directory.
          void this.serial(async () => {
            try {
              await timing.measure('cache', () => retained.finish(true, signal))
              this.change(this.store.read(sessionId), { buildCache: retained.receipt, startTiming: timing.snapshot() })
            } catch { await retained.finish(false) }
            finally { this.retentions.delete(sessionId) }
          })
        }
        return record
      } catch (error) {
        this.clearSlot(sessionId)
        await cache?.finish(false)
        try { await native?.stop(0, profile.shutdown.forceMs, false) } catch { }
        let ownerExited = !native && !createRequested
        try { await native?.shutdown(); ownerExited = true } catch { }
        this.owners.delete(sessionId)
        this.adapters.delete(sessionId)
        this.sources.delete(sessionId)
        // A missing create acknowledgement is not proof that CreateProcess never ran.
        const proof = this.store.nativeJournal(sessionId).at(-1)
        const observation = nativeObservation.safeParse(proof?.evidence ?? (!createRequested ? { pid: 0, created: null, rootSignaled: true, knownHandlesClosed: true, activeProcesses: 0, jobClosed: true, eventClosed: true, assignedAtCreation: false, ownerOutsideJob: true, phase: 'NOT_STARTED' } : undefined))
        const reason = error instanceof Error && /^[A-Z_0-9:]{1,160}$/.test(error.message) ? error.message : 'LAUNCH_FAILED'
        record = this.change(this.store.read(sessionId), { startTiming: timing.snapshot(), ...(cache ? { buildCache: cache.receipt } : {}) })
        record = this.termination(record, this.stopRequests.has(sessionId) ? 'STOP_REQUESTED' : 'STARTUP_FAILURE', reason, observation.success ? observation.data : null, ownerExited ? 'EXITED' : 'UNKNOWN')
        if (ownerExited && ((!createRequested) || (proof?.phase === 'DRAINED' && observation.success && terminalProof(observation.data)))) {
          if (native) record = this.supervisorExited(record)
          try { this.store.releaseResources(sessionId) }
          catch { return this.change(this.store.read(sessionId), { state: 'CLEANUP_INCOMPLETE', reconciliation: 'REQUIRED', resources: 'UNVERIFIABLE', process: observation.success ? observation.data : null, failure: 'RESOURCE_RELEASE_UNVERIFIED', readiness: 'UNVERIFIABLE', liveness: 'NOT_OBSERVED' }) }
          record = this.change(this.store.read(sessionId), { state: this.stopRequests.has(sessionId) ? 'STOPPED' : 'FAILED', resources: 'RELEASED', process: observation.success ? observation.data : null, failure: this.stopRequests.has(sessionId) ? null : reason })
          this.store.release(sessionId)
        } else record = this.change(this.store.read(sessionId), { state: 'OWNERSHIP_UNVERIFIED', reconciliation: 'REQUIRED', resources: 'UNVERIFIABLE', liveness: 'UNVERIFIABLE', failure: 'LAUNCH_UNACKNOWLEDGED' })
        return record
      }
    })
  }
  stop(sessionId: string): Promise<PreviewSessionRecord> {
    this.stopRequests.add(sessionId)
    this.cancellations.get(sessionId)?.abort(new Error('PREVIEW_CANCELLED'))
    this.clearSlot(sessionId)
    this.retentions.get(sessionId)?.abort()
    return this.command(async () => {
      let record = this.store.read(sessionId)
      if (record.state === 'STOPPED' || record.state === 'FAILED') return record
      const owner = this.owners.get(sessionId)
      if (!owner) return this.inspectInternal(sessionId)
      if (!record.stopIntent) {
        try { if ((await owner.inspect()).rootSignaled) return this.inspectInternal(sessionId) }
        catch { return this.inspectInternal(sessionId) }
        record = this.change(record, { state: 'STOPPING', stopIntent: { requestedAt: new Date().toISOString() } })
      }
      try {
        const observation = await owner.stop(record.shutdown.graceMs, record.shutdown.forceMs, record.shutdown.graceful)
        record = this.termination(record, observation.rootSignaled ? 'STOP_REQUESTED' : 'UNKNOWN', observation.rootSignaled ? 'OPERATOR_STOP' : 'STOP_EXIT_NOT_OBSERVED', observation, 'RESPONDING')
        record = this.change(record, { process: observation })
        if (!drained(observation)) return this.change(record, { state: 'CLEANUP_INCOMPLETE', process: observation, resources: 'UNVERIFIABLE', failure: 'DRAIN_UNVERIFIED', liveness: 'UNVERIFIABLE' })
        await this.adapters.get(sessionId)?.released(owner)
        await owner.shutdown()
        record = this.supervisorExited(record)
        this.store.releaseResources(sessionId)
        record = this.change(record, { ...this.terminal(record), process: observation, resources: 'RELEASED', liveness: 'NOT_OBSERVED' })
        this.store.release(sessionId); this.owners.delete(sessionId)
        this.adapters.delete(sessionId)
        this.sources.delete(sessionId)
        this.cancellations.delete(sessionId)
        return record
      } catch (error) {
        if (error instanceof SessionPersistenceFailure) throw error
        return this.change(this.store.read(sessionId), { state: 'CLEANUP_INCOMPLETE', reconciliation: 'REQUIRED', resources: 'UNVERIFIABLE', failure: 'STOP_UNVERIFIED', liveness: 'UNVERIFIABLE' })
      }
    })
  }
  private clearSlot(sessionId: string) {
    const slot = this.slots.get(sessionId)
    if (slot?.timer) clearTimeout(slot.timer)
    slot?.watcher.close(); slot?.disposeContext?.(); this.slots.delete(sessionId)
  }
  private monitorSlot(sessionId: string, worktree: string, guard: () => Promise<void>, profile: PreviewProfile, retentionGuard?: () => Promise<void>, classifyChanges?: PreparedPreview['classifyChanges']) {
    const changes = new Set<string>()
    const slot: { guard: () => Promise<void>; timer?: NodeJS.Timeout; watcher: FSWatcher; metrics?: NonNullable<NonNullable<PreviewSessionRecord['standby']>['metrics']>; previous?: { at: number; cpu: number }; invalid: boolean; disposeContext?: () => void;
      checkChanges?: () => Promise<void>; retentionGuard?: () => Promise<void>; classifyChanges?: PreparedPreview['classifyChanges'] } = {
      guard, invalid: false, watcher: watch(worktree, { recursive: true, persistent: false }, (_event, file) => {
        const path = file?.toString().replaceAll('\\', '/')
        if (!path || changes.size >= 256) { slot.invalid = true; return }
        changes.add(path)
      }) }
    slot.retentionGuard = retentionGuard; slot.classifyChanges = classifyChanges
    slot.checkChanges = async () => {
      if (!changes.size) return
      const paths = [...changes]; paths.forEach(path => changes.delete(path))
      if (paths.some(path => path === profile.dependencies.materialization || path === 'node_modules' || path.startsWith('node_modules/') || profile.command.inputs.some(input => input.path === path))) { slot.invalid = true; return }
      const ignored = await classifyChanges?.(paths)
      if (!ignored || paths.some(path => !ignored.has(path))) slot.invalid = true
    }
    slot.watcher.on('error', () => { slot.invalid = true })
    slot.disposeContext = this.contextProvisioner?.watchInvalidation?.(profile, () => { slot.invalid = true })
    this.slots.set(sessionId, slot)
    const sample = async () => {
      let reason: string | undefined
      await this.serial(async () => {
        if (this.slots.get(sessionId) !== slot) return
        const record = this.store.read(sessionId), standby = record.standby!
        if (standby.state !== 'QUIESCENT') return
        try {
          await slot.checkChanges?.()
          if (slot.invalid) throw new Error('PREPARED_FILESYSTEM_CHANGED')
          await (slot.retentionGuard ?? guard)()
          const current = await this.sampleSlot(sessionId)
          if (Date.now() >= Date.parse(standby.expiresAt)) reason = 'STANDBY_EXPIRED'
          else if (current.privateBytes > standby.policy.maxPrivateBytes || current.workingSetBytes > standby.policy.maxWorkingSetBytes || current.availableBytes < standby.policy.minAvailableBytes) reason = 'STANDBY_MEMORY_BUDGET'
          else if (current.intervalMs > 0 && current.cpuPercent > standby.policy.maxCpuPercent) reason = 'STANDBY_CPU_BUDGET'
        } catch (error) { reason = error instanceof Error ? error.message : 'STANDBY_UNVERIFIABLE' }
      }).catch(() => { reason = 'STANDBY_UNVERIFIABLE' })
      if (reason && this.slots.get(sessionId) === slot) { await this.evict(sessionId, reason); return }
      if (this.slots.get(sessionId) === slot) { slot.timer = setTimeout(() => void sample(), this.store.read(sessionId).standby!.policy.sampleMs); slot.timer.unref() }
    }
    slot.timer = setTimeout(() => void sample(), 1); slot.timer.unref()
  }
  private async sampleSlot(sessionId: string) {
    const slot = this.slots.get(sessionId), owner = this.owners.get(sessionId)
    if (!slot || !owner) throw new Error('PREPARED_OWNER_UNAVAILABLE')
    const data = await owner.metrics(), now = performance.now(), cpu = data.processes.reduce((sum, value) => sum + value.cpuMs, 0)
    const sum = (key: 'workingSetBytes' | 'privateWorkingSetBytes' | 'privateBytes') => data.processes.reduce((total, value) => total + value[key], 0)
    const intervalMs = slot.previous ? now - slot.previous.at : 0, delta = slot.previous ? Math.max(0, cpu - slot.previous.cpu) : 0
    const metrics = { at: new Date().toISOString(), processes: data.processes.length, workingSetBytes: sum('workingSetBytes'), privateWorkingSetBytes: sum('privateWorkingSetBytes'),
      privateBytes: sum('privateBytes'), cpuMs: cpu, intervalMs, cpuPercent: intervalMs ? delta / intervalMs / availableParallelism() * 100 : 0,
      peakPrivateBytes: Math.max(sum('privateBytes'), slot.metrics?.peakPrivateBytes ?? 0), peakWorkingSetBytes: Math.max(sum('workingSetBytes'), slot.metrics?.peakWorkingSetBytes ?? 0), availableBytes: freemem() }
    slot.previous = { at: now, cpu }; slot.metrics = metrics
    return metrics
  }
  slotMetrics(sessionId: string) { return this.slots.get(sessionId)?.metrics }
  cancelPreparation(sessionId: string) { this.stopRequests.add(sessionId); this.cancellations.get(sessionId)?.abort(new Error('PREVIEW_CANCELLED')) }
  async evict(sessionId: string, reason: string) {
    const metrics = this.slotMetrics(sessionId)
    let record = await this.stop(sessionId)
    if (record.state !== 'STOPPED') record = await this.inspect(sessionId)
    if (record.standby && record.state === 'STOPPED' && record.resources === 'RELEASED') record = await this.command(async () => this.change(this.store.read(sessionId), { standby: { ...record.standby!, state: 'EVICTED', reason, ...(metrics ? { metrics } : {}) } }))
    return record
  }
  async present(sessionId: string) {
    const receivedNs = process.hrtime.bigint().toString()
    try {
      return await this.command(async () => {
        let record = this.store.read(sessionId)
        const standby = record.standby, slot = this.slots.get(sessionId), owner = this.owners.get(sessionId), adapter = this.adapters.get(sessionId)
        if (!standby || standby.state !== 'QUIESCENT' || !slot || !owner || !adapter || slot.invalid || Date.now() >= Date.parse(standby.expiresAt)) throw new Error('PREPARED_SLOT_INVALID')
        await slot.checkChanges?.()
        await slot.guard()
        await slot.checkChanges?.()
        if (slot.invalid || Date.now() >= Date.parse(standby.expiresAt)) throw new Error('PREPARED_SLOT_INVALID')
        const metrics = await this.sampleSlot(sessionId)
        if (metrics.privateBytes > standby.policy.maxPrivateBytes || metrics.workingSetBytes > standby.policy.maxWorkingSetBytes || metrics.availableBytes < standby.policy.minAvailableBytes) throw new Error('STANDBY_MEMORY_BUDGET')
        if (metrics.intervalMs > 0 && metrics.cpuPercent > standby.policy.maxCpuPercent) throw new Error('STANDBY_CPU_BUDGET')
        const guardedNs = process.hrtime.bigint().toString()
        const shown = await adapter.control('SHOW', this.cancellations.get(sessionId)?.signal)
        const observed = await adapter.observe(owner)
        if (observed.readiness !== 'READY' || observed.attestation.loadedCode !== 'VERIFIED') throw new Error('PRESENTATION_NOT_ATTESTED')
        record = this.change(record, { ...observed, standby: { ...standby, state: 'RUNNING', metrics, presentation: { receivedNs, guardedNs,
          showNs: shown.showNs!, functionalNs: shown.functionalNs!, focusedNs: shown.focusedNs!, durationMs: Number(BigInt(shown.focusedNs!) - BigInt(receivedNs)) / 1e6 } } })
        if (slot.timer) clearTimeout(slot.timer)
        slot.timer = undefined
        return record
      })
    } catch (error) { await this.evict(sessionId, error instanceof Error ? error.message : 'PRESENTATION_FAILED'); throw error }
  }
  async park(sessionId: string) {
    try {
      return await this.command(async () => {
        const record = this.store.read(sessionId), slot = this.slots.get(sessionId), adapter = this.adapters.get(sessionId)
        if (!slot || !adapter || slot.invalid || record.standby?.state !== 'RUNNING') throw new Error('PREPARED_SLOT_INVALID')
        await slot.checkChanges?.(); await slot.guard(); await slot.checkChanges?.()
        if (slot.invalid) throw new Error('PREPARED_SLOT_INVALID')
        await adapter.control('QUIESCE', this.cancellations.get(sessionId)?.signal)
        const next = this.change(record, { standby: { ...record.standby, state: 'QUIESCENT', expiresAt: new Date(Date.now() + record.standby.policy.idleMs).toISOString() } })
        this.clearSlot(sessionId)
        this.monitorSlot(sessionId, adapter.worktree, slot.guard, adapter.profile, slot.retentionGuard, slot.classifyChanges)
        return next
      })
    } catch (error) { await this.evict(sessionId, error instanceof Error ? error.message : 'QUIESCENCE_FAILED'); throw error }
  }
  list(options: { cursor?: string; limit?: number } = {}) {
    return this.serial(async () => {
      const limit = options.limit ?? 20
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('INVALID_PAGE_LIMIT')
      const records = this.store.list().sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.sessionId.localeCompare(b.sessionId))
      const start = options.cursor ? records.findIndex(r => r.sessionId === options.cursor) + 1 : 0
      if (options.cursor && !start) throw new Error('INVALID_SESSION_CURSOR')
      const page = records.slice(start, start + limit)
      return { sessions: await Promise.all(page.map(record => this.inspectInternal(record.sessionId).catch(error => this.receiptFailure(error)))), nextCursor: start + limit < records.length ? page.at(-1)!.sessionId : null }
    })
  }
  inspect(sessionId: string) { return this.command(() => this.inspectInternal(sessionId)) }
  owns(sessionId: string) { return this.owners.get(sessionId)?.available === true }
  linkValidation(sessionId: string, link: import('../../../shared/types/runtime-preview-operations').PreviewValidationLink, expectedRevision: number, guard: () => Promise<void>) {
    return this.command(async () => {
      const record = this.store.read(sessionId)
      if (record.revision !== expectedRevision) throw new Error('SESSION_CHANGED')
      if ((record.validationLinks ?? []).some(value => JSON.stringify(value) === JSON.stringify(link))) return record
      if ((record.validationLinks?.length ?? 0) >= 16) throw new Error('VALIDATION_LINK_LIMIT')
      await guard()
      return this.change(record, { validationLinks: [...(record.validationLinks ?? []), link] })
    })
  }
  private async inspectInternal(sessionId: string): Promise<PreviewSessionRecord> {
    let record = this.store.read(sessionId)
    if (record.state === 'STOPPED' || record.state === 'FAILED') return record
    const owner = this.owners.get(sessionId)
    if (owner) {
      try {
        const observation = await owner.inspect()
        if (observation.rootSignaled) {
          record = this.termination(record, record.stopIntent ? 'STOP_REQUESTED' : 'UNEXPECTED_EXIT', record.stopIntent ? 'OPERATOR_STOP' : 'UNEXPECTED_PROCESS_EXIT', observation, 'RESPONDING')
          const final = await owner.stop(0, record.shutdown.forceMs, false)
          if (!drained(final)) throw new Error('DRAIN_UNVERIFIED')
          record = this.change(record, { process: final })
          await this.adapters.get(sessionId)?.released(owner)
          await owner.shutdown()
          record = this.supervisorExited(record)
          this.store.releaseResources(sessionId)
          record = this.change(record, { ...this.terminal(record), process: final, resources: 'RELEASED', liveness: 'NOT_OBSERVED', readiness: 'NOT_READY' })
          this.store.release(sessionId); this.owners.delete(sessionId)
          this.adapters.delete(sessionId); this.sources.delete(sessionId)
          return record
        }
        if (previewFingerprint(record.process) !== previewFingerprint(observation)) {
          if (record.revision >= 224) throw new Error('SESSION_EVENT_CAPACITY')
          record = this.change(record, { process: observation, liveness: observation.activeProcesses > 0 ? 'VERIFIED' : 'UNVERIFIABLE' })
        }
        const adapter = this.adapters.get(sessionId)
        if (adapter) {
          let stack: Awaited<ReturnType<PreviewStackAdapter['observe']>>
          let sourceObservation: PreviewSessionRecord['sourceObservation']
          try {
            const source = await this.sources.get(sessionId)?.()
            if (source) sourceObservation = { at: new Date().toISOString(), fingerprint: previewFingerprint(source), snapshot: source }
            stack = await adapter.observe(owner)
          }
          catch (error) {
            stack = { coverage: record.coverage.filter(c => !['TARGET_CHECKOUT', 'BEHAVIOR'].includes(c.stage)).map(c => ({ ...c, status: 'UNVERIFIABLE', reasonCode: 'CURRENT_PROBE_UNVERIFIABLE' })), readiness: 'UNVERIFIABLE', attestation: { artifact: 'UNVERIFIABLE', loadedCode: 'UNVERIFIABLE' }, failure: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'PROBE_UNVERIFIABLE' }
          }
          const coverage = [...record.coverage.filter(c => ['TARGET_CHECKOUT', 'BEHAVIOR'].includes(c.stage)), ...stack.coverage]
          if (this.sources.has(sessionId) && !sourceObservation) {
            const target = coverage.find(c => c.stage === 'TARGET_CHECKOUT')!
            Object.assign(target, { status: 'UNVERIFIABLE', at: new Date().toISOString(), reasonCode: stack.failure ?? 'CURRENT_SOURCE_UNVERIFIABLE' })
          }
          if (sourceObservation) {
            const target = coverage.find(c => c.stage === 'TARGET_CHECKOUT')!
            Object.assign(target, { status: 'VERIFIED', at: sourceObservation.at, fingerprint: sourceObservation.fingerprint, evidenceRef: 'sourceObservation', reasonCode: 'CURRENT_GIT_SOURCE_OBSERVED' })
          }
          if (record.revision >= 224) throw new Error('SESSION_EVENT_CAPACITY')
          record = this.change(record, { ...stack, coverage, ...(sourceObservation ? { sourceObservation } : {}) })
        }
        return record
      } catch (error) {
        if (error instanceof SessionPersistenceFailure) throw error
        owner.close(); this.owners.delete(sessionId)
        if (record.termination && record.termination.kind !== 'UNKNOWN') return this.change(record, { state: 'CLEANUP_INCOMPLETE', reconciliation: 'REQUIRED', resources: 'UNVERIFIABLE', failure: 'TERMINATION_CLEANUP_UNVERIFIED', liveness: 'UNVERIFIABLE' })
      }
    }
    const proof = this.store.nativeJournal(sessionId).at(-1)
    const observation = nativeObservation.safeParse(proof?.evidence)
    let supervisorExited = false
    if (proof?.phase === 'DRAINED') {
      const observer = await this.owner()
      try {
        const result = sessionSchema.shape.recoveryObservation.parse(await observer.reconcile(sessionId, Number(proof.ownerPid), String(proof.ownerCreated)))
        supervisorExited = result?.sameProcessAlive === false
      } finally { await observer.shutdown() }
    }
    if (supervisorExited && proof?.phase === 'DRAINED' && observation.success && terminalProof(observation.data)) {
      record = this.termination(record, record.stopIntent ? 'STOP_REQUESTED' : observation.data.assignedAtCreation ? 'UNEXPECTED_EXIT' : 'STARTUP_FAILURE',
        record.stopIntent ? 'OPERATOR_STOP' : observation.data.assignedAtCreation ? 'UNEXPECTED_PROCESS_EXIT' : 'LAUNCH_FAILED', observation.data, 'EXITED')
      record = this.supervisorExited(record)
      for (const resource of record.resourceInventory.filter(r => r.kind === 'SESSION_ENDPOINT')) {
        const match = /^127\.0\.0\.1:(\d+)$/.exec(resource.reference)
        const port = Number(match?.[1])
        try {
          if (!match || port < 1024 || port > 65535) throw new Error('INVALID_ENDPOINT_RECEIPT')
          await verifyEndpointFree(port)
        } catch {
          return this.change(record, { state: 'CLEANUP_INCOMPLETE', reconciliation: 'REQUIRED', resources: 'UNVERIFIABLE', readiness: 'UNVERIFIABLE', attestation: { artifact: 'UNVERIFIABLE', loadedCode: 'UNVERIFIABLE' }, failure: 'RECOVERED_ENDPOINT_UNVERIFIABLE', liveness: 'NOT_OBSERVED' })
        }
      }
      try { this.store.releaseResources(sessionId) }
      catch { return this.change(record, { state: 'CLEANUP_INCOMPLETE', reconciliation: 'REQUIRED', resources: 'UNVERIFIABLE', process: observation.data, failure: 'RESOURCE_RELEASE_UNVERIFIED', readiness: 'UNVERIFIABLE', liveness: 'NOT_OBSERVED' }) }
      record = this.change(record, { ...this.terminal(record), resources: 'RELEASED', process: observation.data, reconciliation: 'OBSERVED', liveness: 'NOT_OBSERVED', readiness: 'NOT_READY' })
      if (this.store.active() === sessionId) this.store.release(sessionId)
      this.adapters.delete(sessionId); this.sources.delete(sessionId)
      return record
    }
    if (!record.termination) record = this.termination(record, 'UNKNOWN', 'OWNER_LOST_OR_UNREACHABLE', record.process, 'UNKNOWN')
    if (record.state !== 'OWNERSHIP_UNVERIFIED') record = this.change(record, { state: 'OWNERSHIP_UNVERIFIED', reconciliation: 'REQUIRED', resources: 'UNVERIFIABLE', failure: 'OWNER_LOST_OR_UNREACHABLE', liveness: 'UNVERIFIABLE', readiness: 'UNVERIFIABLE', attestation: { artifact: 'UNVERIFIABLE', loadedCode: 'UNVERIFIABLE' } })
    // Read-only observation cannot establish ownership or prove a destroyed Job drained.
    const observer = await this.owner()
    try {
      const current = sessionSchema.shape.recoveryObservation.parse(await observer.reconcile(sessionId, record.process?.pid ?? 0, record.process?.created ?? null))
      if (previewFingerprint(current) !== previewFingerprint(record.recoveryObservation) && record.revision < 224) record = this.change(record, { recoveryObservation: current })
    }
    finally { observer.close() }
    return record
  }
}
