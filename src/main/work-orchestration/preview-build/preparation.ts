import { join, relative, resolve, isAbsolute } from 'node:path'
import { z } from 'zod'
import type { PreviewRepositories } from '../preview-repositories'
import type { PreviewProfileStore } from '../preview-profile-store'
import { PreviewPreflightService } from '../preview-preflight'
import { previewFingerprint } from '../preview-profile'
import type { PreviewBuildResult } from '../../../shared/types/preview-build-types'
import { PreviewCaptureStore, type CaptureBasis } from './capture'
import { PreviewBuildToolchains } from './toolchain'
import { PreviewBuildStore, type BuildApproval } from './build-store'
import { physical } from './files'

const text = z.string().min(1).max(512).regex(/^[^\0\r\n]+$/)
export const buildPreparationRequest = z.object({ selection: z.object({ repositoryId: text, worktreeId: text, generation: text, profileId: text,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), allowDirty: z.boolean(), captureId: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()
export class PreviewBuildPreparation {
  readonly captures: PreviewCaptureStore
  readonly toolchains: PreviewBuildToolchains
  readonly bundles: PreviewBuildStore
  private readonly preflight: PreviewPreflightService
  private pending = false
  constructor(private readonly root: string, private readonly repositories: PreviewRepositories, private readonly profiles: PreviewProfileStore, approve: BuildApproval) {
    this.captures = new PreviewCaptureStore(join(root, 'captures'))
    this.toolchains = new PreviewBuildToolchains(join(root, 'toolchains'))
    this.bundles = new PreviewBuildStore(join(root, 'bundles'), this.captures, this.toolchains, approve)
    this.preflight = new PreviewPreflightService(profiles)
  }
  async prepare(input: unknown, guard: () => void = () => {}): Promise<PreviewBuildResult> {
    const parsed = buildPreparationRequest.safeParse(input)
    if (!parsed.success) return { success: false, code: 'BUILD_SCOPE_REJECTED' }
    if (this.pending) return { success: false, code: 'BUILD_STORE_BUSY' }
    this.pending = true
    let captureId = parsed.data.captureId
    try {
      const request = parsed.data, { selection } = request
      const target = await this.repositories.open(selection.repositoryId, selection.worktreeId)
      const current = () => { guard(); target.guard() }
      const identity = await target.git.getCoordinationIdentity(selection.worktreeId)
      if (identity.repositoryId !== selection.repositoryId || identity.record.generation !== selection.generation || identity.record.detached || identity.record.locked || identity.record.prunable || identity.record.missing) throw Error('CAPTURE_WORKTREE_REJECTED')
      const checkout = await physical(identity.record.path), scope = relative(checkout, resolve(this.root))
      if (!scope || !scope.startsWith('..') && !isAbsolute(scope)) throw Error('CAPTURE_STORE_INSIDE_WORKTREE')
      current()
      if (!captureId) {
        const preflight = await this.preflight.check(target.git, selection)
        const admitted = new Set(['PROFILE_APPROVAL_REQUIRED', 'ABI_UNVERIFIED', 'RUNTIME_COMPATIBILITY_UNVERIFIED', 'DEPENDENCY_MATERIALIZATION_UNVERIFIABLE'])
        if (preflight.diagnostics.some(d => !admitted.has(d.reasonCode))) throw Error('BUILD_PREFLIGHT_REJECTED')
        const profile = (await this.profiles.profiles(selection.repositoryId)).find(p => p.profileId === selection.profileId)
        if (!profile || previewFingerprint(profile) !== selection.fingerprint || profile.adapter?.kind !== 'ELECTRON' || Object.keys(profile.env).some(key => key !== 'PATH')) throw Error('BUILD_PROFILE_UNSUPPORTED')
        const observe = async (): Promise<CaptureBasis> => {
          current()
          const value = await target.git.getCoordinationSnapshot(selection.worktreeId)
          if (value.record.generation !== selection.generation || value.reference || value.conflictCount || value.snapshot.operation || value.record.detached || value.record.locked) throw Error('CAPTURE_INDEX_REJECTED')
          const active = (await this.profiles.profiles(selection.repositoryId)).find(p => p.profileId === selection.profileId)
          if (!active || previewFingerprint(active) !== selection.fingerprint) throw Error('CAPTURE_PROFILE_CHANGED')
          current()
          return { selection, profile: active, source: { ...value.snapshot, dirty: value.stagedCount + value.unstagedCount + value.untrackedCount > 0 } }
        }
        const toolchain = await this.toolchains.freeze(checkout, profile)
        const capture = await this.captures.capture(checkout, observe, { toolchainId: toolchain.toolchainId, runtimeId: toolchain.runtime.runtimeId }, request.allowDirty)
        captureId = capture.captureId
      }
      const capture = await this.captures.get(captureId)
      if (previewFingerprint(capture.selection) !== previewFingerprint(selection)) throw Error('BUILD_SCOPE_REJECTED')
      const receipt = await this.bundles.prepare(captureId, current)
      current()
      return { success: true, captureId, buildId: receipt.buildId, runtimeId: receipt.runtimeId, reused: receipt.reused, bundleDirectory: receipt.directory, compatibility: receipt.manifest.compatibility }
    } catch (error) {
      const code = error instanceof Error && /^[A-Z][A-Z_]{1,120}$/.test(error.message) ? error.message : 'BUILD_PREPARATION_FAILED'
      return { success: false, code, ...(captureId ? { captureId } : {}) }
    } finally { this.pending = false }
  }
}
