import { randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import type { PreviewSelection, PreviewPreflight } from '../../../shared/types/runtime-preview-types'
import { bytesFingerprint, previewFingerprint, type PreviewProfile } from '../preview-profile'
import type { PreviewProfileStore } from '../preview-profile-store'
import { previewPath, type PreviewPreflightService } from '../preview-preflight'
import type { PreviewRepositories } from '../preview-repositories'
import { NativeOwner, nativeObservation, type NativeObservation } from './native-owner'
import { PreviewSessionStore, sessionSchema, type PreviewSessionRecord } from './session-store'
import { PreviewStackAdapter, diagnosticBootstrapAllowed, verifyEndpointFree } from './adapters'
import type { PreviewContextProvisioner } from './context-data'

export interface PreparedPreview {
  profile: PreviewProfile; worktree: string; gitFingerprint: string; preflight: PreviewPreflight;
  guard: () => Promise<void>
  observeSource?: () => Promise<NonNullable<PreviewPreflight['snapshot']>>
}
export interface PreviewLaunchAuthority { prepare(selection: PreviewSelection): Promise<PreparedPreview> }
export class CatalogPreviewLaunchAuthority implements PreviewLaunchAuthority {
  constructor(private readonly repositories: PreviewRepositories, private readonly profiles: PreviewProfileStore,
    private readonly preflight: PreviewPreflightService) {}
  async prepare(selection: PreviewSelection): Promise<PreparedPreview> {
    const context = await this.repositories.open(selection.repositoryId, selection.worktreeId)
    const check = async () => { context.guard(); const result = await this.preflight.check(context.git, selection); context.guard(); return result }
    const result = await check()
    const identity = await context.git.getCoordinationIdentity(selection.worktreeId)
    const profile = (await this.profiles.profiles(selection.repositoryId)).find(p => p.profileId === selection.profileId)
    if (!profile || !await this.profiles.approved(profile) || previewFingerprint(profile) !== selection.fingerprint) throw new Error('PROFILE_APPROVAL_REQUIRED')
    if (identity.repositoryId !== selection.repositoryId || identity.record.generation !== selection.generation) throw new Error('WORKTREE_STALE')
    const gitFingerprint = previewFingerprint(result.snapshot)
    return { profile, worktree: identity.record.path, gitFingerprint, preflight: result, observeSource: async () => {
      context.guard()
      const current = await context.git.getCoordinationIdentity(selection.worktreeId)
      if (current.repositoryId !== selection.repositoryId || current.record.generation !== selection.generation || current.record.path !== identity.record.path) throw new Error('WORKTREE_STALE')
      const snapshot = await context.git.getCoordinationSnapshot(selection.worktreeId)
      if (snapshot.snapshot.branch !== result.snapshot?.branch || snapshot.record.detached || snapshot.record.locked || snapshot.conflictCount || snapshot.snapshot.operation) throw new Error('WORKTREE_CONTEXT_CHANGED')
      const approved = (await this.profiles.profiles(selection.repositoryId)).find(p => p.profileId === selection.profileId)
      if (!approved || previewFingerprint(approved) !== selection.fingerprint || !await this.profiles.approved(approved)) throw new Error('PROFILE_CHANGED')
      context.guard()
      return { ...snapshot.snapshot, dirty: snapshot.stagedCount + snapshot.unstagedCount + snapshot.untrackedCount > 0 }
    }, guard: async () => {
      const current = await check()
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
  constructor(private readonly store: PreviewSessionStore, private readonly authority: PreviewLaunchAuthority,
    private readonly helper: { executable: string; fingerprint: string; sdkDirectory?: string }, private readonly contextProvisioner?: PreviewContextProvisioner) {}
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
  private async owner() {
    if (bytesFingerprint(await readFile(this.helper.executable)) !== this.helper.fingerprint) throw new Error('NATIVE_HELPER_CHANGED')
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
  start(input: { operationId: string; selection: PreviewSelection; guard?: () => void | Promise<void> }): Promise<PreviewSessionRecord> {

    const selection = sessionSchema.shape.selection.safeParse(input.selection)
    if (!selection.success) return Promise.reject(selection.error)
    input = { operationId: input.operationId, selection: selection.data, guard: input.guard }
    return this.command(async () => {
      await input.guard?.()
      if (!sessionSchema.shape.operationId.safeParse(input.operationId).success) throw new Error('INVALID_OPERATION_ID')
      const previous = this.store.list().find(r => r.operationId === input.operationId)
      if (previous) {
        if (selectionKey(previous.selection) !== selectionKey(input.selection)) throw new Error('OPERATION_ID_CONFLICT')
        return this.inspectInternal(previous.sessionId)
      }
      if (this.store.active()) throw new Error('PREVIEW_SESSION_BUSY')
      const prepared = await this.authority.prepare(input.selection)
      const { profile, preflight } = prepared
      if (preflight.status !== 'SUPPORTED' && !diagnosticBootstrapAllowed(preflight, profile)) throw new Error('PREFLIGHT_' + preflight.status)
      if (selectionKey(preflight.selection) !== selectionKey(input.selection) || previewFingerprint(profile) !== input.selection.fingerprint || preflight.profileRevision !== profile.revision || profile.repositoryId !== input.selection.repositoryId) throw new Error('LAUNCH_IDENTITY_MISMATCH')
      if (profile.shutdown.spawn !== 'JOB_LIST_AT_CREATE') throw new Error('SAFE_SPAWN_UNAVAILABLE')
      if (profile.security.mode !== 'profile_only' || profile.security.requirements.length) throw new Error('SECURITY_ISOLATION_UNAVAILABLE')
      if (profile.resources.some(r => r.strategy === 'SESSION_ENDPOINT') && !profile.adapter) throw new Error('RESOURCE_ADAPTER_REQUIRED')
      if (Object.keys(profile.env).some(k => reserved.test(k))) throw new Error('RESERVED_ENVIRONMENT')
      this.store.assertExternal(prepared.worktree)
      const executable = await realpath(profile.command.executable)
      if (bytesFingerprint(await readFile(executable)) !== profile.command.executableHash) throw new Error('EXECUTABLE_CHANGED')
      const cwd = await previewPath(prepared.worktree, profile.command.cwd)
      for (const input of profile.command.inputs) if (bytesFingerprint(await readFile(await previewPath(prepared.worktree, input.path))) !== input.fingerprint) throw new Error('COMMAND_INPUT_CHANGED')
      await prepared.guard()
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
      let native: NativeOwner | undefined
      let adapter: PreviewStackAdapter | undefined
      let createRequested = false
      try {
        if (profile.bootstrap) {
          if (!this.contextProvisioner || !preflight.snapshot) throw new Error('PREVIEW_CONTEXT_PROVISIONER_REQUIRED')
          const context = await this.contextProvisioner.prepare({ profile, selection: input.selection, sessionId,
            directory: this.store.runtime(sessionId), worktree: prepared.worktree, source: preflight.snapshot })
          await prepared.guard()
          await input.guard?.()
          record = this.change(record, { context })
        }
        if (profile.adapter) {
          if (!this.helper.sdkDirectory) throw new Error('TRUSTED_SDK_REQUIRED')
          adapter = await PreviewStackAdapter.prepare(profile, prepared.worktree, this.store.runtime(sessionId), sessionId, this.helper.sdkDirectory, record.context)
          this.adapters.set(sessionId, adapter)
          if (prepared.observeSource) this.sources.set(sessionId, prepared.observeSource)
        }
        native = await this.owner(); this.owners.set(sessionId, native)
        await prepared.guard()
        await input.guard?.()
        const runtime = this.store.runtime(sessionId)
        createRequested = true
        const observation = await native.start({ sessionId, operationId: input.operationId, directory: this.store.directory(sessionId),
          slotKey: bytesFingerprint(this.store.root.toLowerCase()), executable, executableHash: profile.command.executableHash, cwd, args: profile.command.args, spawn: 'JOB_LIST_AT_CREATE',
          graceful: profile.shutdown.graceful ?? 'NONE', graceMs: profile.shutdown.graceMs, forceMs: profile.shutdown.forceMs, hostPid: process.pid,
          env: { ...profile.env, SystemRoot: process.env.SystemRoot!, TEMP: runtime, TMP: runtime, APPDATA: runtime, LOCALAPPDATA: runtime, USERPROFILE: runtime, HOME: runtime,
            PREVIEW_SESSION_ID: sessionId, PREVIEW_SESSION_DIRECTORY: runtime, ...adapter?.environment() } })
        if (!observation.assignedAtCreation || !observation.ownerOutsideJob || !observation.pid || !observation.created) throw new Error('OWNERSHIP_UNVERIFIED')
        await prepared.guard()
        let stack: Awaited<ReturnType<PreviewStackAdapter['observe']>> | undefined
        if (adapter) {
          await adapter.permit(native, async actual => {
            await prepared.guard()
            await input.guard?.()
            record = this.change(record, { process: observation, runtimeEvidence: { ...actual, preflight: preflight.status === 'SUPPORTED' ? 'SUPPORTED' : 'UNKNOWN', at: new Date().toISOString(), scope: 'DECLARED_INSTALL_SCRIPTS' } })
          })
          stack = await adapter.awaitReady(native)
          await prepared.guard()
        }
        await input.guard?.()
        record = this.change(record, { state: 'RUNNING', process: observation, liveness: observation.activeProcesses > 0 ? 'VERIFIED' : 'UNVERIFIABLE' })
        if (stack) record = this.change(record, { ...stack, coverage: [...record.coverage.filter(c => ['TARGET_CHECKOUT', 'BEHAVIOR'].includes(c.stage)), ...stack.coverage] })
        return record
      } catch (error) {
        try { await native?.stop(0, profile.shutdown.forceMs, false) } catch { }
        let ownerExited = !native && !createRequested
        try { await native?.shutdown(); ownerExited = true } catch { }
        this.owners.delete(sessionId)
        this.adapters.delete(sessionId)
        this.sources.delete(sessionId)
        // A missing create acknowledgement is not proof that CreateProcess never ran.
        const proof = this.store.nativeJournal(sessionId).at(-1)
        const observation = nativeObservation.safeParse(proof?.evidence)
        const reason = error instanceof Error && /^[A-Z_0-9:]{1,160}$/.test(error.message) ? error.message : 'LAUNCH_FAILED'
        record = this.termination(this.store.read(sessionId), 'STARTUP_FAILURE', reason, observation.success ? observation.data : null, native && ownerExited ? 'EXITED' : 'UNKNOWN')
        if (ownerExited && ((!createRequested) || (proof?.phase === 'DRAINED' && observation.success && terminalProof(observation.data)))) {
          if (native) record = this.supervisorExited(record)
          try { this.store.releaseResources(sessionId) }
          catch { return this.change(this.store.read(sessionId), { state: 'CLEANUP_INCOMPLETE', reconciliation: 'REQUIRED', resources: 'UNVERIFIABLE', process: observation.success ? observation.data : null, failure: 'RESOURCE_RELEASE_UNVERIFIED', readiness: 'UNVERIFIABLE', liveness: 'NOT_OBSERVED' }) }
          record = this.change(this.store.read(sessionId), { state: 'FAILED', resources: 'RELEASED', process: observation.success ? observation.data : null, failure: reason })
          this.store.release(sessionId)
        } else record = this.change(this.store.read(sessionId), { state: 'OWNERSHIP_UNVERIFIED', reconciliation: 'REQUIRED', resources: 'UNVERIFIABLE', liveness: 'UNVERIFIABLE', failure: 'LAUNCH_UNACKNOWLEDGED' })
        return record
      }
    })
  }
  stop(sessionId: string): Promise<PreviewSessionRecord> {
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
        return record
      } catch (error) {
        if (error instanceof SessionPersistenceFailure) throw error
        return this.change(this.store.read(sessionId), { state: 'CLEANUP_INCOMPLETE', reconciliation: 'REQUIRED', resources: 'UNVERIFIABLE', failure: 'STOP_UNVERIFIED', liveness: 'UNVERIFIABLE' })
      }
    })
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
