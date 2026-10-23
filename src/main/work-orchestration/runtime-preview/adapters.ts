import { readFile, writeFile, realpath } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, dirname, resolve } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { bytesFingerprint, previewFingerprint, type PreviewProfile } from '../preview-profile'
import { previewPath } from '../preview-preflight'
import type { PreviewPreflight } from '../../../shared/types/runtime-preview-types'
import type { NativeOwner } from './native-owner'
import type { PreviewSessionRecord } from './session-store'
import { previewDataReceipt, type PreviewContextManifest } from './context-contract'

export function diagnosticBootstrapAllowed(result: PreviewPreflight, profile: PreviewProfile) {
  return !!profile.adapter && result.status === 'UNKNOWN' && result.diagnostics.length > 0 && result.diagnostics.every(d => ['ABI_UNVERIFIED', 'RUNTIME_COMPATIBILITY_UNVERIFIED', 'DEPENDENCY_MATERIALIZATION_UNVERIFIABLE'].includes(d.reasonCode))
}
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export function verifyEndpointFree(port: number): Promise<void> {
  return new Promise((accept, reject) => {
    const socket = createServer(); socket.once('error', () => reject(new Error('ENDPOINT_COLLISION')))
    socket.listen({ host: '127.0.0.1', port, exclusive: true }, () => socket.close(error => error ? reject(error) : accept()))
  })
}
const webEvidence = z.object({ schemaVersion: z.literal(1), sessionId: z.string().uuid(), challenge: z.string().uuid(), pid: z.number().int().positive(),
  worktree: z.string(), profile: digest, runtime: z.string(), abi: z.string(),
  artifacts: z.array(z.object({ component: z.enum(['WEB', 'ELECTRON_RENDERER']), path: z.string(), sourceDigest: digest, transformDigest: digest, servedDigest: digest.nullable(), loaded: z.boolean() }).strict()).max(12)
  , electron: z.object({ sessionId: z.string().uuid(), pid: z.number().int().positive(), runtime: z.string(), abi: z.string(),
    builds: z.array(z.object({ component: z.enum(['ELECTRON_MAIN', 'ELECTRON_PRELOAD']), artifactDigest: digest, sources: z.record(z.string(), digest) }).strict()).max(16),
    rendererPid: z.number().int().nullable(), rendererFailure: z.string().nullable(), sandboxObserved: z.boolean().nullable(),
    rendererModules: z.array(z.object({ path: z.string(), sourceDigest: digest, transformDigest: digest }).strict()).max(12),
    context: z.object({ mode: z.literal('PREVIEW'), repositoryId: z.string(), worktreeId: z.string(), generation: z.string(), profileRevision: z.number().int(),
      activeCheckout: z.string(), identity: z.literal('IDENTITY_BOUND'), data: previewDataReceipt }).strict().optional(),
    resourcesIsolated: z.literal(true), channelDisabled: z.literal(true), protocolDisabled: z.literal(true), processes: z.array(z.object({ pid: z.number().int(), type: z.string() }).strict()).max(128)
  }).strict().nullable()
}).strict()
export class PreviewStackAdapter {
  private readonly token = randomBytes(32).toString('hex')
  private endpoint?: { pid: number; created: string }
  private constructor(readonly profile: PreviewProfile, readonly worktree: string, readonly directory: string, readonly sessionId: string, private readonly context?: PreviewContextManifest) {}
  static async prepare(profile: PreviewProfile, worktree: string, directory: string, sessionId: string, sdk: string, context?: PreviewContextManifest) {
    const adapter = profile.adapter!
    if ((profile.runtime === 'WEB_DEV_SERVER') !== (adapter.kind !== 'ELECTRON')) throw new Error('ADAPTER_RUNTIME_MISMATCH')
    if (!profile.resources.some(r => r.strategy === 'SESSION_ENDPOINT')) throw new Error('ENDPOINT_RESOURCE_REQUIRED')
    if (adapter.kind === 'ELECTRON') {
      if (!adapter.runtimeExecutable || !adapter.runtimeExecutableHash) throw new Error('RUNTIME_EXECUTABLE_REQUIRED')
      if (adapter.artifacts.some(a => a.component === 'WEB') || !['ELECTRON_MAIN', 'ELECTRON_PRELOAD', 'ELECTRON_RENDERER'].every(c => adapter.artifacts.some(a => a.component === c))) throw new Error('ELECTRON_COMPONENT_SCOPE_REQUIRED')
    } else if (adapter.artifacts.some(a => a.component !== 'WEB')) throw new Error('WEB_COMPONENT_SCOPE_REQUIRED')
    if (profile.command.args.length !== 1 || !profile.command.args[0].endsWith('launch.cjs')) throw new Error('SAFE_BOOTSTRAP_REQUIRED')
    const launch = await previewPath(worktree, profile.command.args[0])
    // Both approved checkout scripts must be the exact trusted SDK, not a cooperative claim.
    for (const name of ['launch.cjs', 'cooperation.cjs']) {
      if (bytesFingerprint(await readFile(join(dirname(launch), name))) !== bytesFingerprint(await readFile(join(sdk, name)))) throw new Error('SAFE_BOOTSTRAP_CHANGED')
    }
    await previewPath(worktree, adapter.configFile)
    const lock = JSON.parse(await readFile(await previewPath(worktree, profile.dependencies.lockfile), 'utf8'))
    for (const [path, raw] of Object.entries(lock.packages ?? {})) {
      const entry = raw as { hasInstallScript?: boolean; optional?: boolean }
      if (!path || !entry.hasInstallScript) continue
      if (entry.optional) {
        try { await previewPath(worktree, path) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      }
      const name = path.split('node_modules/').at(-1)!
      if (path !== `node_modules/${name}` || !adapter.nativeModules.includes(name)) throw new Error('NATIVE_DEPENDENCY_SCOPE_UNVERIFIABLE')
    }
    const readiness = new URL(profile.probes.readiness.address)
    if (profile.probes.readiness.kind !== 'HTTP' || readiness.protocol !== 'http:' || readiness.hostname !== '127.0.0.1' || Number(readiness.port) !== adapter.port || readiness.username || readiness.password || readiness.hash) throw new Error('READINESS_ENDPOINT_INVALID')
    if (profile.command.args.some(a => /no-sandbox|disable.*sandbox/i.test(a))) throw new Error('SANDBOX_DOWNGRADE_FORBIDDEN')
    await verifyEndpointFree(adapter.port)
    if (!!profile.bootstrap !== !!context) throw new Error('PREVIEW_CONTEXT_REQUIRED')
    const instance = new PreviewStackAdapter(profile, await realpath(worktree), directory, sessionId, context)
    await writeFile(join(directory, 'configuration.json'), JSON.stringify({ sessionId, token: instance.token, worktree: instance.worktree, directory,
      profile: previewFingerprint(profile), runtimeVersion: profile.runtimeVersion, abi: profile.dependencies.abi,
      packageRoot: dirname(await previewPath(worktree, profile.dependencies.manifest)), ...adapter, ...(context ? { context, approvedProfile: profile } : {}) }), { flag: 'wx', mode: 0o600 })
    return instance
  }
  environment() { return { PREVIEW_SESSION_CONFIG: join(this.directory, 'configuration.json') } }
  async permit(owner: NativeOwner, persist: (evidence: { runtime: string; abi: string; platform: 'win32'; arch: 'x64'; modules: string[] }) => Promise<void>) {
    const deadline = Date.now() + 15000
    let evidence: unknown
    while (Date.now() < deadline) {
      try { evidence = JSON.parse(await readFile(join(this.directory, 'compatibility.json'), 'utf8')); break } catch { }
      const process = await owner.inspect()
      if (process.rootSignaled) throw new Error('RUNTIME_PROBE_FAILED')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const actual = z.object({ runtime: z.string(), abi: z.string(), platform: z.literal('win32'), arch: z.literal('x64'), modules: z.array(z.string()).max(16) }).strict().parse(evidence)
    if (actual.runtime !== this.profile.runtimeVersion || actual.abi !== this.profile.dependencies.abi || previewFingerprint(actual.modules) !== previewFingerprint(this.profile.adapter!.nativeModules)) throw new Error('RUNTIME_COMPATIBILITY_MISMATCH')
    await persist(actual)
    await writeFile(join(this.directory, 'permit'), 'approved-diagnostic-completed', { flag: 'wx' })
  }
  async observe(owner: NativeOwner): Promise<Pick<PreviewSessionRecord, 'coverage' | 'readiness' | 'attestation' | 'failure'> & { processEvidence?: PreviewSessionRecord['processEvidence'] }> {
    const port = this.profile.adapter!.port, proof = await owner.endpoint(port)
    if (!proof.listeners.length) throw new Error('ENDPOINT_NOT_OBSERVED')
    if (proof.listeners.length !== 1 || !proof.listeners[0].member || !proof.listeners[0].loopback) throw new Error('WRONG_ENDPOINT_OWNER')
    const listener = proof.listeners[0], challenge = randomUUID()
    const response = await fetch(`http://127.0.0.1:${port}/__runtime_preview__/evidence`, { headers: { 'X-Preview-Token': this.token, 'X-Preview-Challenge': challenge }, redirect: 'error', signal: AbortSignal.timeout(2000) })
    if (!response.ok || Number(response.headers.get('content-length')) > 65536) throw new Error('PROBE_UNVERIFIABLE')
    const body = await response.text(); if (Buffer.byteLength(body) > 65536) throw new Error('PROBE_LIMIT')
    const evidence = webEvidence.parse(JSON.parse(body)), after = await owner.endpoint(port)
    if (previewFingerprint(after) !== previewFingerprint(proof) || evidence.pid !== listener.pid || evidence.sessionId !== this.sessionId || evidence.challenge !== challenge || evidence.profile !== previewFingerprint(this.profile) || evidence.worktree.toLowerCase() !== this.worktree.toLowerCase()) throw new Error('WRONG_CHECKOUT')
    this.endpoint = listener
    const ready = await fetch(this.profile.probes.readiness.address, { redirect: 'error', signal: AbortSignal.timeout(2000) })
    await ready.body?.cancel()
    if (!ready.ok) throw new Error('APP_NOT_READY')
    const at = new Date().toISOString(), coverage: PreviewSessionRecord['coverage'] = []
    let processEvidence: PreviewSessionRecord['processEvidence']
    if (this.profile.adapter!.kind === 'ELECTRON') {
      const electron = evidence.electron
      if (!electron || electron.sandboxObserved === null || (!electron.rendererPid && !electron.rendererFailure)) throw new Error('ELECTRON_COMPONENT_NOT_OBSERVED')
      if (!electron.sandboxObserved) throw new Error('SANDBOX_INCOMPATIBLE')
      if (electron.sessionId !== this.sessionId || electron.runtime !== this.profile.runtimeVersion || electron.abi !== this.profile.dependencies.abi) throw new Error('WRONG_CHECKOUT')
      if (this.context) {
        const context = electron.context, expected = this.context
        if (!context || context.repositoryId !== expected.selection.repositoryId || context.worktreeId !== expected.selection.worktreeId || context.generation !== expected.selection.generation ||
          context.profileRevision !== expected.profileRevision || context.activeCheckout.toLowerCase() !== this.worktree.toLowerCase() || previewFingerprint(context.data) !== previewFingerprint(expected.data)) throw new Error('PREVIEW_CONTEXT_NOT_BOUND')
      }
      const members = (await owner.processes()).processes
      if (!members.some(p => p.pid === electron.pid) || (electron.rendererPid && !members.some(p => p.pid === electron.rendererPid))) throw new Error('NESTED_JOB_INCOMPATIBLE')
      processEvidence = { at, members: members.map(p => ({ ...p, role: p.pid === electron.rendererPid ? 'Renderer' : electron.processes.find(m => m.pid === p.pid)?.type ?? 'Session bootstrap' })) }
    }
    coverage.push({ stage: 'ENDPOINT', component: 'PROCESS', status: 'VERIFIED', fingerprint: previewFingerprint(listener), evidenceRef: 'windows-tcp/job-membership', at, reasonCode: 'SESSION_ENDPOINT_OWNER_VERIFIED' })
    let served = true, loaded = true, failure: string | null = null
    for (const artifact of this.profile.adapter!.artifacts) {
      const build = evidence.electron?.builds.find(b => b.component === artifact.component && b.sources[artifact.path])
      const found = build ? { sourceDigest: build.sources[artifact.path], transformDigest: build.artifactDigest, servedDigest: null, loaded: true } : evidence.artifacts.find(a => a.path === artifact.path && a.component === artifact.component)
      const current = bytesFingerprint(await readFile(await previewPath(this.worktree, artifact.path)))
      const fresh = found?.sourceDigest === current
      if (!found?.servedDigest || !fresh) served = false
      const componentLoaded = !!found?.loaded && !(artifact.component === 'ELECTRON_RENDERER' && evidence.electron?.rendererFailure)
      if (!componentLoaded || !fresh) loaded = false
      if (found && !fresh) failure = artifact.component === 'ELECTRON_MAIN' || artifact.component === 'ELECTRON_PRELOAD' ? 'RESTART_PREVIEW_REQUIRED' : 'STALE_ARTIFACT'
      coverage.push({ stage: 'SERVED_ARTIFACT', component: artifact.component, status: found?.servedDigest ? fresh ? 'VERIFIED' : 'STALE' : 'NOT_OBSERVED', fingerprint: found?.servedDigest ?? null, evidenceRef: artifact.path, at, reasonCode: found?.servedDigest && fresh ? 'TRANSFORMED_RESPONSE_OBSERVED' : 'ARTIFACT_NOT_CURRENTLY_ATTESTED' })
      coverage.push({ stage: 'LOADED_COMPONENT', component: artifact.component, status: componentLoaded ? fresh ? 'VERIFIED' : 'STALE' : 'UNVERIFIABLE', fingerprint: componentLoaded ? found!.transformDigest : null, evidenceRef: artifact.path, at, reasonCode: fresh && componentLoaded ? 'COOPERATIVE_MODULE_INITIALIZED' : 'LOADED_COMPONENT_NOT_ATTESTED' })
    }
    if (evidence.electron?.rendererFailure) failure = 'RENDERER_CRASH'
    return { coverage, readiness: failure ? 'NOT_READY' : 'READY', attestation: { artifact: served ? 'VERIFIED' : 'UNVERIFIABLE', loadedCode: loaded ? 'VERIFIED' : 'UNVERIFIABLE' }, failure, ...(processEvidence ? { processEvidence } : {}) }
  }
  async awaitReady(owner: NativeOwner) {
    const deadline = Date.now() + this.profile.probes.readiness.timeoutMs
    while (Date.now() < deadline) {
      try {
        const failure = JSON.parse(await readFile(join(this.directory, 'bootstrap-failure.json'), 'utf8'))
        if (failure.sessionId === this.sessionId && typeof failure.code === 'string' && /^PREVIEW_[A-Z_]{1,120}$/.test(failure.code)) throw new Error(failure.code)
      } catch (error) { if (error instanceof Error && /^PREVIEW_[A-Z_]+$/.test(error.message)) throw error }
      const state = await owner.inspect(); if (state.rootSignaled) throw new Error('BOOTSTRAP_FAILURE')
      try { return await this.observe(owner) } catch (error) {
        if (error instanceof Error && ['WRONG_ENDPOINT_OWNER', 'WRONG_CHECKOUT'].includes(error.message)) throw error
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('PROBE_TIMEOUT')
  }
  async released(owner: NativeOwner) {
    const observation = await owner.endpoint(this.profile.adapter!.port)
    if (this.endpoint && observation.listeners.some(p => p.pid === this.endpoint!.pid && p.created === this.endpoint!.created)) throw new Error('ENDPOINT_CLEANUP_INCOMPLETE')
  }
}
