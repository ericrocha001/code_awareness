import { readBootstrapFailure } from './bootstrap-failure'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { PreviewBuildPreparation } from '../preview-build/preparation'
import { absent, digest, verify, type BuildFile } from '../preview-build/files'
import { previewFingerprint } from '../preview-profile'
import type { PreviewRepositories } from '../preview-repositories'
import type { PreviewProfileStore } from '../preview-profile-store'
import type { PreviewSelection } from '../../../shared/types/runtime-preview-types'
import type { PreviewContextManifest } from './context-contract'
import type { NativeOwner } from './native-owner'
import type { PreviewSessionRecord } from './session-store'
import { invokePreviewChannel } from './channel-client'
import type { PreviewChannelScope } from './channel-contract'

export const snapshotSelector = z.object({ captureId: z.string().regex(/^[a-f0-9]{64}$/), buildId: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export type SnapshotSelector = z.infer<typeof snapshotSelector>
export class SnapshotLaunch {
  constructor(readonly builds: PreviewBuildPreparation, private readonly repositories: PreviewRepositories, private readonly profiles: PreviewProfileStore) {}
  async prepare(selection: PreviewSelection, requested: SnapshotSelector) {
    snapshotSelector.parse(requested)
    const manifest = await this.builds.bundles.readManifest(requested.buildId).catch(error => { if (absent(error)) throw Error('PREPARE_REQUIRED'); throw error })
    const capture = await this.builds.captures.get(requested.captureId)
    if (manifest.captureId !== capture.captureId || manifest.runtimeId !== capture.runtimeId || previewFingerprint(capture.selection) !== previewFingerprint(selection) || capture.profile.bootstrap?.dataPolicy !== 'ARTIFACT_FIRST') throw Error('BUILD_SCOPE_REJECTED')
    for (const input of capture.profile.command.inputs) if (capture.files.find(file => file.path === input.path)?.sha256 !== input.fingerprint) throw Error('CAPTURE_PROFILE_INPUT_MISMATCH')
    const target = await this.repositories.open(selection.repositoryId, selection.worktreeId)
    const identity = await target.git.getCoordinationIdentity(selection.worktreeId)
    const guard = async () => {
      target.guard()
      const current = await target.git.getCoordinationIdentity(selection.worktreeId)
      if (current.record.generation !== selection.generation || current.record.path !== identity.record.path || current.record.missing || current.record.locked || current.record.prunable || current.repositoryId !== selection.repositoryId) throw Error('WORKTREE_STALE')
      const profile = (await this.profiles.profiles(selection.repositoryId)).find(p => p.profileId === selection.profileId)
      if (!profile || previewFingerprint(profile) !== selection.fingerprint || !await this.profiles.approved(profile)) throw Error('PROFILE_APPROVAL_REQUIRED')
      target.guard()
    }
    await guard()
    const runtimeRoot = this.builds.toolchains.runtimeRoot(manifest.runtimeId)
    const runtime = JSON.parse(await readFile(join(runtimeRoot, 'runtime.json'), 'utf8'))
    const { runtimeId, ...basis } = runtime
    if (runtimeId !== manifest.runtimeId || digest(basis) !== runtimeId || ['electron', 'abi', 'platform', 'arch'].some(key => runtime[key] !== manifest.compatibility[key as keyof typeof manifest.compatibility])) throw Error('BUILD_RUNTIME_INCOMPATIBLE')
    await verify(join(runtimeRoot, 'dist'), runtime.files)
    const executable = join(runtimeRoot, 'dist/electron.exe'), executableHash = (runtime.files as BuildFile[]).find(file => file.path === 'electron.exe')?.sha256
    if (!executableHash) throw Error('BUILD_RUNTIME_INCOMPATIBLE')
    if (capture.profile.adapter?.runtimeExecutableHash && capture.profile.adapter.runtimeExecutableHash !== executableHash) throw Error('BUILD_RUNTIME_INCOMPATIBLE')
    const bundle = join(this.builds.bundles.root, 'bundle-' + manifest.buildId, 'bundle')
    return { profile: capture.profile, worktree: identity.record.path, gitFingerprint: previewFingerprint(capture.source),
      preflight: { status: 'SUPPORTED' as const, selection, profileRevision: capture.profile.revision, snapshot: capture.source, diagnostics: [], readiness: 'NOT_OBSERVED' as const, process: 'NOT_IMPLEMENTED' as const }, guard,
      snapshot: { ...requested, runtimeId, bundle, approvedProfile: capture.profile, sourceDirectory: this.builds.captures.source(capture.captureId), executable, executableHash, manifest } }
  }
}
export type PreparedSnapshot = Awaited<ReturnType<SnapshotLaunch['prepare']>>['snapshot']
const evidenceSchema = z.object({ sessionId: z.string().uuid(), pid: z.number().int().positive(), runtime: z.string(), abi: z.string(),
  buildId: z.string(), captureId: z.string(), runtimeId: z.string(), mainDigest: z.string(), preloadDigest: z.string(), rendererDigest: z.string(),
  rendererPid: z.number().int().positive().nullable(), sandboxObserved: z.boolean().nullable(), functionalAt: z.string().nullable(), rendererFailure: z.string().nullable(), contextBound: z.boolean() }).strict()
export class SnapshotAdapter {
  private readonly token = randomBytes(32).toString('hex')
  private endpoint?: { port: number; pid: number }
  private electronMain?: { pid: number; runtime: string; abi: string }
  constructor(private readonly snapshot: PreparedSnapshot, private readonly context: PreviewContextManifest, private readonly directory: string) {}
  async prepare() {
    await writeFile(join(this.directory, 'configuration.json'), JSON.stringify({ sessionId: this.context.sessionId, kind: 'ELECTRON', mode: 'SNAPSHOT',
      directory: this.directory, worktree: this.context.worktree, profile: this.context.selection.fingerprint, context: this.context,
      approvedProfile: this.snapshot.approvedProfile, channelToken: this.token, snapshot: this.snapshot }), { flag: 'wx', mode: 0o600 })
    return this
  }
  environment() { return { PREVIEW_SESSION_CONFIG: join(this.directory, 'configuration.json') } }
  async permit(_owner: NativeOwner, persist: (evidence: { runtime: string; abi: string; platform: 'win32'; arch: 'x64'; modules: string[] }) => Promise<void>) {
    const compatibility = this.snapshot.manifest.compatibility
    await persist({ runtime: compatibility.electron, abi: compatibility.abi, platform: 'win32', arch: 'x64', modules: compatibility.nativeModules })
  }
  async observe(owner: NativeOwner): Promise<Pick<PreviewSessionRecord, 'coverage' | 'readiness' | 'attestation' | 'failure'> & { processEvidence?: PreviewSessionRecord['processEvidence']; functionalAt?: string }> {
    this.electronMain = undefined
    const value = evidenceSchema.parse(JSON.parse(await readFile(join(this.directory, 'snapshot-evidence.json'), 'utf8')))
    const s = this.snapshot, c = s.manifest.compatibility
    if (value.sessionId !== this.context.sessionId || value.buildId !== s.buildId || value.captureId !== s.captureId || value.runtimeId !== s.runtimeId || value.runtime !== c.electron || value.abi !== c.abi) throw Error('WRONG_CHECKOUT')
    const files = ['app/out/main/main.js', 'app/out/preload/preload.js', 'app/out/renderer/index.html']
    for (const [index, expected] of [value.mainDigest, value.preloadDigest, value.rendererDigest].entries()) if (s.manifest.files.find(f => f.path === files[index])?.sha256 !== expected) throw Error('BUILD_INTEGRITY_FAILED')
    const members = (await owner.processes()).processes
    if (!members.some(p => p.pid === value.pid) || !value.rendererPid || !members.some(p => p.pid === value.rendererPid)) throw Error('NESTED_JOB_INCOMPATIBLE')
    if (!value.sandboxObserved || !value.functionalAt || !value.contextBound || value.rendererFailure) throw Error('APP_NOT_READY')
    this.electronMain = { pid: value.pid, runtime: value.runtime, abi: value.abi }
    const liveness = await this.invokeChannel(owner, { sessionId: this.context.sessionId, repositoryId: this.context.selection.repositoryId, worktreeId: this.context.selection.worktreeId, generation: this.context.selection.generation }, 'runtime.liveness', {})
    if (!liveness.result.success) throw Error(liveness.result.code)
    const channel = JSON.parse(await readFile(join(this.directory, 'channel.json'), 'utf8'))
    this.endpoint = { port: z.number().int().min(1).max(65535).parse(channel.port), pid: value.pid }
    const at = new Date().toISOString()
    const coverage: PreviewSessionRecord['coverage'] = [{ stage: 'ENDPOINT', component: 'PROCESS', status: 'VERIFIED', fingerprint: String(value.pid), evidenceRef: 'preview-channel/job-membership', at, reasonCode: 'SESSION_ENDPOINT_OWNER_VERIFIED' }]
    for (const component of ['ELECTRON_MAIN', 'ELECTRON_PRELOAD', 'ELECTRON_RENDERER'] as const) for (const stage of ['SERVED_ARTIFACT', 'LOADED_COMPONENT'] as const) coverage.push({ stage, component, status: 'VERIFIED', fingerprint: s.buildId, evidenceRef: 'snapshot-evidence.json', at, reasonCode: 'IMMUTABLE_BUNDLE_COMPONENT_OBSERVED' })
    return { coverage, functionalAt: value.functionalAt, readiness: 'READY', attestation: { artifact: 'VERIFIED', loadedCode: 'VERIFIED' }, failure: null,
      processEvidence: { at, members: members.map(p => ({ ...p, role: p.pid === value.pid ? 'Electron main' : p.pid === value.rendererPid ? 'Renderer' : 'Electron child' })) } }
  }
  async awaitReady(owner: NativeOwner) {
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      const failure = await readBootstrapFailure(this.directory, this.context.sessionId)
      if (failure) throw Error(failure.code)
      if ((await owner.inspect()).rootSignaled) throw Error('BOOTSTRAP_FAILURE')
      try { return await this.observe(owner) } catch (error) { if (error instanceof Error && ['WRONG_CHECKOUT', 'BUILD_INTEGRITY_FAILED'].includes(error.message)) throw error }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw Error('PROBE_TIMEOUT')
  }
  invokeChannel(owner: NativeOwner, scope: PreviewChannelScope, operation: string, input: Record<string, unknown>) {
    if (!this.electronMain) throw Error('PREVIEW_UNAVAILABLE')
    return invokePreviewChannel(this.context, this.directory, this.token, owner, scope, operation, input, this.electronMain)
  }
  endpointReference() {
    if (!this.endpoint) throw Error('PREVIEW_CHANNEL_NOT_OBSERVED')
    return '127.0.0.1:' + this.endpoint.port
  }
  async released(owner: NativeOwner) {
    if (this.endpoint && (await owner.endpoint(this.endpoint.port)).listeners.some(peer => peer.pid === this.endpoint!.pid && peer.member)) throw Error('ENDPOINT_CLEANUP_INCOMPLETE')
  }
}
