import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  assertCanonicalRealPath,
  ExtensionEnrollmentStore
} from './extension-enrollment-store'
import {
  promoteStagedArtifactsTransactionally,
  pruneStagingDirectories,
  recoverPendingSwapJournal,
  verifyBuildArtifactsIntegrity
} from './extension-transaction-swap'
import type {
  BuildArtifactMetadata,
  EnrollManagedInstallationInput,
  ExtensionManagerStatusSnapshot,
  ExtensionMaintenanceAuthorization,
  ExtensionOperationRecord,
  ExtensionRuntimeAttestation,
  MaintenanceCheckRequest,
  MaintenanceCheckResponse,
  MaintenanceClaimRequest,
  MaintenanceClaimResponse,
  MaintenanceReportRequest,
  MaintenanceReportResponse,
  ManagedInstallationEnrollment,
  StartExtensionOperationInput,
  StartExtensionOperationResult
} from './extension-manager-types'

const execFileAsync = promisify(execFile)
const requireFromHere = createRequire(__filename)

const DEFAULT_OPERATION_TTL_MS = 5 * 60_000
const ACTIVE_OPERATION_STATES = new Set<ExtensionOperationRecord['state']>([
  'PENDING',
  'BUILDING',
  'WAITING_BROWSER',
  'WAITING_IDLE',
  'PROMOTING',
  'PROMOTED',
  'RELOADING',
  'REINJECTING'
])

export interface GitSourceInspection {
  head: string
  branch: string | null
  dirty: boolean
}

export type GitSourceInspector = (repoPath: string) => Promise<GitSourceInspection>
export type InputsFingerprintReader = (repoPath: string) => string | Promise<string>
export type StagingBuildRunner = (options: {
  sourceRepoPath: string
  extOutDir: string
  hostOutDir: string
  metaOutPath: string
  buildId: string
  sourceHead: string
  nativeHostApplication: string
}) => Promise<BuildArtifactMetadata>

export interface ExtensionManagerServiceOptions {
  userDataPath: string
  operationTtlMs?: number
  now?: () => number
  inspectGitSource?: GitSourceInspector
  computeInputsFingerprint?: InputsFingerprintReader
  buildRunner?: StagingBuildRunner
}

export async function defaultInspectGitSource(repoPath: string): Promise<GitSourceInspection> {
  const cwd = resolve(repoPath)
  const runGit = async (args: string[], allowFail = false): Promise<string> => {
    try {
      const result = await execFileAsync('git', args, {
        cwd,
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 1024 * 1024
      })
      return result.stdout.trim()
    } catch (err) {
      if (allowFail) return ''
      throw err
    }
  }

  const head = await runGit(['rev-parse', 'HEAD'])
  if (!/^[a-f0-9]{40,64}$/i.test(head)) {
    throw new Error(`INVALID_GIT_HEAD:${cwd}`)
  }
  const branch = (await runGit(['symbolic-ref', '-q', '--short', 'HEAD'], true)) || null
  const porcelain = await runGit(['status', '--porcelain', '--untracked-files=normal'])
  return {
    head,
    branch,
    dirty: porcelain.length > 0
  }
}

export function defaultComputeInputsFingerprint(repoPath: string): string {
  const buildScriptPath = join(resolve(repoPath), 'scripts', 'web-activation', 'build.cjs')
  const mod = requireFromHere(buildScriptPath) as {
    computeWebActivationInputsFingerprint: (root: string) => string
  }
  return mod.computeWebActivationInputsFingerprint(repoPath)
}

export async function defaultStagingBuildRunner(options: {
  sourceRepoPath: string
  extOutDir: string
  hostOutDir: string
  metaOutPath: string
  buildId: string
  sourceHead: string
  nativeHostApplication: string
}): Promise<BuildArtifactMetadata> {
  const scriptPath = join(resolve(options.sourceRepoPath), 'scripts', 'web-activation', 'build.cjs')
  const args = [
    scriptPath,
    '--repo-root',
    options.sourceRepoPath,
    '--ext-out',
    options.extOutDir,
    '--host-out',
    options.hostOutDir,
    '--meta-out',
    options.metaOutPath,
    '--build-id',
    options.buildId,
    '--source-head',
    options.sourceHead,
    '--native-host',
    options.nativeHostApplication,
    '--json'
  ]
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (process.versions.electron) {
    env.ELECTRON_RUN_AS_NODE = '1'
  }
  const fallbackNodeModules = join(process.cwd(), 'node_modules')
  if (!existsSync(join(options.sourceRepoPath, 'node_modules')) && existsSync(fallbackNodeModules)) {
    env.NODE_PATH = env.NODE_PATH
      ? `${fallbackNodeModules}${process.platform === 'win32' ? ';' : ':'}${env.NODE_PATH}`
      : fallbackNodeModules
  }
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: options.sourceRepoPath,
    env,
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024
  })
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
  const lastLine = lines[lines.length - 1]
  if (!lastLine) {
    throw new Error('BUILD_OUTPUT_EMPTY')
  }
  return JSON.parse(lastLine) as BuildArtifactMetadata
}

function sameStartParameters(a: ExtensionOperationRecord, b: StartExtensionOperationInput): boolean {
  return (
    a.action === b.action &&
    (a.expectedSourceHead ?? undefined) === (b.expectedSourceHead?.trim() || undefined) &&
    (a.requestedTargetBuildId ?? undefined) === (b.targetBuildId?.trim() || undefined) &&
    Boolean(a.allowDirtyWorktree) === Boolean(b.allowDirtyWorktree)
  )
}

/**
 * Coordinates managed Chrome web-activation extension builds, isolated staging,
 * transactional swap, quiescence coordination, runtime attestation, and status queries.
 */
export class ExtensionManagerService {
  private readonly store: ExtensionEnrollmentStore
  private readonly operationTtlMs: number
  private readonly now: () => number
  private readonly inspectGitSource: GitSourceInspector
  private readonly computeInputsFingerprint: InputsFingerprintReader
  private readonly buildRunner: StagingBuildRunner
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(options: ExtensionManagerServiceOptions) {
    this.store = new ExtensionEnrollmentStore(options.userDataPath)
    this.operationTtlMs = options.operationTtlMs ?? DEFAULT_OPERATION_TTL_MS
    this.now = options.now ?? (() => Date.now())
    this.inspectGitSource = options.inspectGitSource ?? defaultInspectGitSource
    this.computeInputsFingerprint = options.computeInputsFingerprint ?? defaultComputeInputsFingerprint
    this.buildRunner = options.buildRunner ?? defaultStagingBuildRunner
    recoverPendingSwapJournal(this.store.managerDir)
  }

  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn)
    this.mutationQueue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private expireOverdueOperations(): void {
    const state = this.store.loadState()
    const currentMs = this.now()
    let changed = false
    const updatedOps = state.operations.map((op) => {
      if (!ACTIVE_OPERATION_STATES.has(op.state) || !op.expiresAt) {
        return op
      }
      const expMs = Date.parse(op.expiresAt)
      if (!Number.isNaN(expMs) && currentMs > expMs) {
        changed = true
        return {
          ...op,
          state: 'EXPIRED' as const,
          errorCode: 'OPERATION_EXPIRED',
          errorMessage: 'Operation expired before completion',
          updatedAt: new Date(currentMs).toISOString(),
          completedAt: new Date(currentMs).toISOString()
        }
      }
      return op
    })
    if (changed) {
      this.store.saveState({ ...state, operations: updatedOps })
    }
  }

  getEnrollment(): ManagedInstallationEnrollment | null {
    return this.store.loadEnrollment()
  }

  enrollInstallation(
    input: EnrollManagedInstallationInput,
    options: { replace?: boolean } = {}
  ): ManagedInstallationEnrollment {
    return this.store.enroll(input, options)
  }

  revokeInstallation(): ManagedInstallationEnrollment | null {
    const revoked = this.store.revoke()
    if (!revoked) return null
    const state = this.store.loadState()
    const nowIso = new Date(this.now()).toISOString()
    const updatedOps = state.operations.map((op) =>
      ACTIVE_OPERATION_STATES.has(op.state)
        ? {
            ...op,
            state: 'FAILED' as const,
            errorCode: 'ENROLLMENT_REVOKED',
            errorMessage: 'Managed installation was revoked',
            updatedAt: nowIso,
            completedAt: nowIso
          }
        : op
    )
    this.store.saveState({ ...state, operations: updatedOps })
    return revoked
  }

  getStatus(): ExtensionManagerStatusSnapshot {
    this.expireOverdueOperations()
    const enrollment = this.store.loadEnrollment()
    const state = this.store.loadState()
    const activeOperation = state.operations.find((op) => ACTIVE_OPERATION_STATES.has(op.state)) ?? null
    return {
      enrolled: Boolean(enrollment),
      managed: Boolean(enrollment && enrollment.enabled && !enrollment.revokedAt),
      enrollment,
      activeOperation,
      lastValidBuild: state.lastValidBuild,
      lastAttestation: state.lastAttestation,
      recentOperations: state.operations.slice(0, 10)
    }
  }

  getOperation(operationId: string): ExtensionOperationRecord | null {
    if (typeof operationId !== 'string' || !operationId.trim()) {
      return null
    }
    this.expireOverdueOperations()
    const state = this.store.loadState()
    return state.operations.find((op) => op.operationId === operationId.trim()) ?? null
  }

  async startOperation(input: StartExtensionOperationInput): Promise<StartExtensionOperationResult> {
    return this.runSerialized(async () => {
      this.expireOverdueOperations()

      if (!input || !['BUILD', 'RELOAD', 'UPDATE'].includes(input.action)) {
        return {
          accepted: false,
          code: 'INVALID_ARGUMENT',
          message: 'action must be BUILD, RELOAD, or UPDATE'
        }
      }

      const enrollment = this.store.loadEnrollment()
      if (!enrollment) {
        return {
          accepted: false,
          code: 'NOT_ENROLLED',
          message: 'No managed Chrome extension installation is enrolled'
        }
      }
      if (!enrollment.enabled || enrollment.revokedAt) {
        return {
          accepted: false,
          code: 'REVOKED',
          message: 'Managed Chrome extension enrollment is revoked'
        }
      }

      const requestedId = input.operationId?.trim() || randomUUID()
      const state = this.store.loadState()
      const existingById = state.operations.find((op) => op.operationId === requestedId)
      if (existingById) {
        if (!sameStartParameters(existingById, input)) {
          return {
            accepted: false,
            code: 'INVALID_ARGUMENT',
            message: `operationId "${requestedId}" already exists with different parameters`
          }
        }
        return {
          accepted: true,
          operation: existingById
        }
      }

      const active = state.operations.find((op) => ACTIVE_OPERATION_STATES.has(op.state))
      if (active) {
        return {
          accepted: false,
          code: 'BUSY',
          activeOperationId: active.operationId,
          operation: active,
          message: `Another operation (${active.operationId}, ${active.action} in state ${active.state}) is in progress`
        }
      }

      if (input.action === 'RELOAD') {
        return this.prepareReloadOperation(requestedId, input, enrollment)
      }

      return this.executeBuildOrUpdateStart(requestedId, input, enrollment)
    })
  }

  private async verifySourcePreconditions(
    enrollment: ManagedInstallationEnrollment,
    expectedSourceHead?: string,
    allowDirtyWorktree?: boolean
  ): Promise<
    | { ok: true; git: GitSourceInspection; inputsFingerprint: string }
    | { ok: false; code: 'SOURCE_HEAD_MISMATCH' | 'DIRTY_SOURCE_WORKTREE' | 'FAILED'; message: string }
  > {
    assertCanonicalRealPath(enrollment.sourceRepoPath, 'sourceRepoPath', {
      mustExist: true,
      expectedType: 'dir'
    })
    assertCanonicalRealPath(enrollment.unpackedPath, 'unpackedPath', {
      mustExist: true,
      expectedType: 'dir'
    })
    assertCanonicalRealPath(enrollment.hostInstallDir, 'hostInstallDir', {
      mustExist: true,
      expectedType: 'dir'
    })
    assertCanonicalRealPath(enrollment.hostScriptPath, 'hostScriptPath', {
      mustExist: false
    })

    const git = await this.inspectGitSource(enrollment.sourceRepoPath)
    const trimmedExpected = expectedSourceHead?.trim()
    if (trimmedExpected && git.head !== trimmedExpected) {
      return {
        ok: false,
        code: 'SOURCE_HEAD_MISMATCH',
        message: `Expected source HEAD ${trimmedExpected}, found ${git.head}`
      }
    }
    if (git.dirty && !allowDirtyWorktree) {
      return {
        ok: false,
        code: 'DIRTY_SOURCE_WORKTREE',
        message: 'Source repository has uncommitted changes'
      }
    }

    const inputsFingerprint = await this.computeInputsFingerprint(enrollment.sourceRepoPath)
    return { ok: true, git, inputsFingerprint }
  }

  private upsertOperation(op: ExtensionOperationRecord, lastValidBuild?: BuildArtifactMetadata): void {
    const current = this.store.loadState()
    const filtered = current.operations.filter((item) => item.operationId !== op.operationId)
    this.store.saveState({
      ...current,
      lastValidBuild: lastValidBuild ?? current.lastValidBuild,
      operations: [op, ...filtered]
    })
  }

  private prepareReloadOperation(
    operationId: string,
    input: StartExtensionOperationInput,
    enrollment: ManagedInstallationEnrollment
  ): StartExtensionOperationResult {
    const state = this.store.loadState()
    const requestedTarget = input.targetBuildId?.trim()
    let resolvedTargetBuildId = requestedTarget
    let candidateMetadata: BuildArtifactMetadata | undefined

    if (requestedTarget) {
      if (state.lastValidBuild?.buildId === requestedTarget) {
        candidateMetadata = state.lastValidBuild
      } else if (state.lastAttestation?.buildId !== requestedTarget) {
        return {
          accepted: false,
          code: 'BUILD_NOT_FOUND',
          message: `Build "${requestedTarget}" is neither the last valid candidate nor the attested live build`
        }
      }
    } else if (state.lastValidBuild) {
      resolvedTargetBuildId = state.lastValidBuild.buildId
      candidateMetadata = state.lastValidBuild
    } else if (state.lastAttestation?.buildId) {
      resolvedTargetBuildId = state.lastAttestation.buildId
    } else {
      return {
        accepted: false,
        code: 'BUILD_NOT_FOUND',
        message: 'No staged or attested live build exists to reload'
      }
    }

    if (candidateMetadata) {
      verifyBuildArtifactsIntegrity(candidateMetadata)
    }

    const nowMs = this.now()
    const nowIso = new Date(nowMs).toISOString()
    const epoch = state.epoch + 1
    const nonce = randomBytes(16).toString('hex')
    const expiresAt = new Date(nowMs + this.operationTtlMs).toISOString()

    const op: ExtensionOperationRecord = {
      operationId,
      action: 'RELOAD',
      state: 'WAITING_BROWSER',
      installationId: enrollment.installationId,
      targetBuildId: resolvedTargetBuildId,
      ...(input.expectedSourceHead?.trim() ? { expectedSourceHead: input.expectedSourceHead.trim() } : {}),
      ...(requestedTarget ? { requestedTargetBuildId: requestedTarget } : {}),
      ...(input.allowDirtyWorktree ? { allowDirtyWorktree: true } : {}),
      epoch,
      nonce,
      expiresAt,
      ...(candidateMetadata ? { candidateMetadata } : {}),
      createdAt: nowIso,
      updatedAt: nowIso
    }

    this.store.saveState({
      ...state,
      epoch,
      operations: [op, ...state.operations]
    })

    return { accepted: true, operation: op }
  }

  private async executeBuildOrUpdateStart(
    operationId: string,
    input: StartExtensionOperationInput,
    enrollment: ManagedInstallationEnrollment
  ): Promise<StartExtensionOperationResult> {
    let sourceCheck
    try {
      sourceCheck = await this.verifySourcePreconditions(
        enrollment,
        input.expectedSourceHead,
        input.allowDirtyWorktree
      )
    } catch (err) {
      return {
        accepted: false,
        code: 'FAILED',
        message: err instanceof Error ? err.message : String(err)
      }
    }

    if (!sourceCheck.ok) {
      return {
        accepted: false,
        code: sourceCheck.code,
        message: sourceCheck.message
      }
    }

    const startMs = this.now()
    const startIso = new Date(startMs).toISOString()
    const buildId = `b-${sourceCheck.git.head.slice(0, 8)}-${sourceCheck.inputsFingerprint.slice(0, 8)}-${randomUUID().slice(0, 6)}`
    const stagingRoot = join(this.store.managerDir, 'staging')
    const opStageDir = join(stagingRoot, operationId)
    const extOutDir = join(opStageDir, 'ext')
    const hostOutDir = join(opStageDir, 'host')
    const metaOutPath = join(opStageDir, 'build-metadata.json')
    mkdirSync(opStageDir, { recursive: true })

    let operation: ExtensionOperationRecord = {
      operationId,
      action: input.action,
      state: 'BUILDING',
      installationId: enrollment.installationId,
      ...(input.expectedSourceHead?.trim() ? { expectedSourceHead: input.expectedSourceHead.trim() } : {}),
      ...(input.targetBuildId?.trim() ? { requestedTargetBuildId: input.targetBuildId.trim() } : {}),
      ...(input.allowDirtyWorktree ? { allowDirtyWorktree: true } : {}),
      targetBuildId: buildId,
      createdAt: startIso,
      updatedAt: startIso
    }
    this.upsertOperation(operation)

    let metadata: BuildArtifactMetadata
    try {
      const built = await this.buildRunner({
        sourceRepoPath: enrollment.sourceRepoPath,
        extOutDir,
        hostOutDir,
        metaOutPath,
        buildId,
        sourceHead: sourceCheck.git.head,
        nativeHostApplication: enrollment.nativeHostApplication
      })
      metadata = {
        ...built,
        dirty: sourceCheck.git.dirty,
        branch: sourceCheck.git.branch
      }
      verifyBuildArtifactsIntegrity(metadata)
      if (metadata.inputsFingerprint !== sourceCheck.inputsFingerprint) {
        throw new Error('INPUTS_FINGERPRINT_CHANGED_DURING_BUILD')
      }
    } catch (err) {
      const failIso = new Date(this.now()).toISOString()
      const failed: ExtensionOperationRecord = {
        ...operation,
        state: 'FAILED',
        errorCode: 'BUILD_FAILED',
        errorMessage: err instanceof Error ? err.message : String(err),
        updatedAt: failIso,
        completedAt: failIso
      }
      this.upsertOperation(failed)
      return {
        accepted: false,
        code: 'FAILED',
        message: failed.errorMessage,
        operation: failed
      }
    }

    const retainedDirs = new Set([operationId])
    pruneStagingDirectories(stagingRoot, retainedDirs)

    const builtMs = this.now()
    const builtIso = new Date(builtMs).toISOString()

    if (input.action === 'BUILD') {
      const staged: ExtensionOperationRecord = {
        ...operation,
        state: 'STAGED',
        targetBuildId: metadata.buildId,
        candidateMetadata: metadata,
        updatedAt: builtIso,
        completedAt: builtIso
      }
      this.upsertOperation(staged, metadata)
      return { accepted: true, operation: staged }
    }

    const state = this.store.loadState()
    const epoch = state.epoch + 1
    const nonce = randomBytes(16).toString('hex')
    const expiresAt = new Date(builtMs + this.operationTtlMs).toISOString()

    const waiting: ExtensionOperationRecord = {
      ...operation,
      state: 'WAITING_BROWSER',
      targetBuildId: metadata.buildId,
      epoch,
      nonce,
      expiresAt,
      candidateMetadata: metadata,
      updatedAt: builtIso
    }
    this.store.saveState({
      ...state,
      epoch,
      lastValidBuild: metadata,
      operations: [waiting, ...state.operations.filter((item) => item.operationId !== operationId)]
    })
    return { accepted: true, operation: waiting }
  }

  private validateIdentity(
    req: { installationId: string; extensionId: string; profileId: string; installType?: string },
    enrollment: ManagedInstallationEnrollment | null
  ): { ok: true; enrollment: ManagedInstallationEnrollment } | { ok: false; revoked: boolean; reason: string } {
    if (!enrollment) {
      return { ok: false, revoked: false, reason: 'NOT_ENROLLED' }
    }
    if (!enrollment.enabled || enrollment.revokedAt) {
      return { ok: false, revoked: true, reason: 'ENROLLMENT_REVOKED' }
    }
    if (req.installType && req.installType !== 'development') {
      return { ok: false, revoked: false, reason: 'UNSUPPORTED_INSTALL_TYPE' }
    }
    if (
      req.installationId !== enrollment.installationId ||
      req.extensionId.toLowerCase() !== enrollment.extensionId.toLowerCase() ||
      req.profileId !== enrollment.profileId
    ) {
      return { ok: false, revoked: false, reason: 'IDENTITY_MISMATCH' }
    }
    return { ok: true, enrollment }
  }

  handleMaintenanceCheck(req: MaintenanceCheckRequest): MaintenanceCheckResponse {
    this.expireOverdueOperations()
    const enrollment = this.store.loadEnrollment()
    const identity = this.validateIdentity(req, enrollment)
    if (!identity.ok) {
      return {
        managed: false,
        ...(identity.revoked ? { revoked: true } : {}),
        reason: identity.reason,
        pendingOperation: null
      }
    }

    const state = this.store.loadState()
    const pending = state.operations.find(
      (op) =>
        (op.state === 'WAITING_BROWSER' || op.state === 'WAITING_IDLE') &&
        op.installationId === identity.enrollment.installationId &&
        Boolean(op.targetBuildId) &&
        Boolean(op.nonce) &&
        typeof op.epoch === 'number' &&
        Boolean(op.expiresAt)
    )

    const authorization: ExtensionMaintenanceAuthorization | null = pending
      ? {
          operationId: pending.operationId,
          installationId: pending.installationId,
          targetBuildId: pending.targetBuildId!,
          epoch: pending.epoch!,
          nonce: pending.nonce!,
          expiresAt: pending.expiresAt!
        }
      : null

    return {
      managed: true,
      pendingOperation: authorization
    }
  }

  async handleMaintenanceClaim(req: MaintenanceClaimRequest): Promise<MaintenanceClaimResponse> {
    return this.runSerialized(async () => {
      this.expireOverdueOperations()
      const enrollment = this.store.loadEnrollment()
      const identity = this.validateIdentity(
        { ...req, installType: 'development' },
        enrollment
      )
      if (!identity.ok) {
        return { decision: 'REJECT', reason: identity.reason }
      }

      const op = this.getOperation(req.operationId)
      if (!op) {
        return { decision: 'REJECT', reason: 'OPERATION_NOT_FOUND' }
      }
      if (op.state === 'EXPIRED') {
        return { decision: 'REJECT', reason: 'OPERATION_EXPIRED' }
      }
      if (op.state !== 'WAITING_BROWSER' && op.state !== 'WAITING_IDLE') {
        return { decision: 'REJECT', reason: `INVALID_OPERATION_STATE:${op.state}` }
      }
      if (
        op.installationId !== req.installationId ||
        op.targetBuildId !== req.targetBuildId ||
        op.nonce !== req.nonce ||
        op.epoch !== req.epoch
      ) {
        return { decision: 'REJECT', reason: 'AUTHORIZATION_MISMATCH' }
      }
      if (op.expiresAt && this.now() > Date.parse(op.expiresAt)) {
        const expIso = new Date(this.now()).toISOString()
        this.upsertOperation({
          ...op,
          state: 'EXPIRED',
          errorCode: 'OPERATION_EXPIRED',
          updatedAt: expIso,
          completedAt: expIso
        })
        return { decision: 'REJECT', reason: 'OPERATION_EXPIRED' }
      }

      if (!req.readyToReload) {
        const busyReason = req.activeBusyReason?.trim() || 'QUIESCENCE_PENDING'
        const updated: ExtensionOperationRecord = {
          ...op,
          state: 'WAITING_IDLE',
          busyReason,
          updatedAt: new Date(this.now()).toISOString()
        }
        this.upsertOperation(updated)
        return {
          decision: 'DEFER',
          retryAfterMs: 1000,
          reason: busyReason
        }
      }

      if (op.candidateMetadata) {
        const promoting: ExtensionOperationRecord = {
          ...op,
          state: 'PROMOTING',
          previousBootId: req.bootId,
          updatedAt: new Date(this.now()).toISOString()
        }
        this.upsertOperation(promoting)

        try {
          const check = await this.verifySourcePreconditions(
            identity.enrollment,
            op.candidateMetadata.sourceHead,
            op.allowDirtyWorktree
          )
          if (!check.ok) {
            throw new Error(check.message)
          }
          if (check.inputsFingerprint !== op.candidateMetadata.inputsFingerprint) {
            throw new Error('SOURCE_DRIFT_DETECTED:inputsFingerprint changed since staging build')
          }

          promoteStagedArtifactsTransactionally({
            managerDir: this.store.managerDir,
            operationId: op.operationId,
            enrollment: identity.enrollment,
            metadata: op.candidateMetadata
          })
        } catch (err) {
          const failIso = new Date(this.now()).toISOString()
          this.upsertOperation({
            ...promoting,
            state: 'FAILED',
            errorCode: 'PROMOTION_FAILED',
            errorMessage: err instanceof Error ? err.message : String(err),
            updatedAt: failIso,
            completedAt: failIso
          })
          return {
            decision: 'REJECT',
            reason: err instanceof Error ? err.message : String(err)
          }
        }
      }

      const reloadingIso = new Date(this.now()).toISOString()
      const reloading: ExtensionOperationRecord = {
        ...op,
        state: 'RELOADING',
        previousBootId: req.bootId,
        busyReason: undefined,
        updatedAt: reloadingIso
      }
      this.upsertOperation(reloading)

      return {
        decision: 'RELOAD_NOW',
        authorization: {
          operationId: reloading.operationId,
          installationId: reloading.installationId,
          targetBuildId: reloading.targetBuildId!,
          epoch: reloading.epoch!,
          nonce: reloading.nonce!,
          expiresAt: reloading.expiresAt!
        }
      }
    })
  }

  async handleMaintenanceReport(req: MaintenanceReportRequest): Promise<MaintenanceReportResponse> {
    return this.runSerialized(async () => {
      this.expireOverdueOperations()
      const report: ExtensionRuntimeAttestation = req.report
      const enrollment = this.store.loadEnrollment()
      const identity = this.validateIdentity(report, enrollment)
      if (!identity.ok) {
        return { accepted: false, reason: identity.reason }
      }

      const state = this.store.loadState()
      const op = report.reloadedOperationId
        ? state.operations.find((item) => item.operationId === report.reloadedOperationId)
        : undefined

      if (!op) {
        if (req.phase === 'BOOT_ATTESTATION') {
          this.store.saveState({ ...state, lastAttestation: report })
          return { accepted: true, verified: false, operation: null }
        }
        return { accepted: false, reason: 'OPERATION_NOT_FOUND' }
      }

      if (req.phase === 'QUIESCENCE_BLOCKED') {
        const updated: ExtensionOperationRecord = {
          ...op,
          state: 'WAITING_IDLE',
          busyReason: 'QUIESCENCE_BLOCKED',
          updatedAt: new Date(this.now()).toISOString()
        }
        this.upsertOperation(updated)
        return { accepted: true, verified: false, operation: updated }
      }

      if (op.state === 'EXPIRED') {
        return { accepted: false, verified: false, operation: op, reason: 'OPERATION_EXPIRED' }
      }

      const failure = this.verifyPostReloadAttestation(op, identity.enrollment, report)
      const nowIso = new Date(this.now()).toISOString()
      if (failure) {
        const notAttested: ExtensionOperationRecord = {
          ...op,
          state: 'NOT_ATTESTED',
          errorCode: 'ATTESTATION_MISMATCH',
          errorMessage: failure,
          attestation: report,
          updatedAt: nowIso,
          completedAt: nowIso
        }
        this.upsertOperation(notAttested)
        return { accepted: false, verified: false, operation: notAttested, reason: failure }
      }

      if (req.phase === 'BOOT_ATTESTATION') {
        const reinjecting: ExtensionOperationRecord = {
          ...op,
          state: 'REINJECTING',
          attestation: report,
          updatedAt: nowIso
        }
        const current = this.store.loadState()
        this.store.saveState({
          ...current,
          lastAttestation: report,
          operations: [reinjecting, ...current.operations.filter((item) => item.operationId !== reinjecting.operationId)]
        })
        return { accepted: true, verified: false, operation: reinjecting }
      }

      const tabStates = Array.isArray(report.tabStates) ? report.tabStates : []
      const hasUnverifiedTab = tabStates.some(
        (tab) => tab.status !== 'REINJECTED' || (tab.buildId && tab.buildId !== op.targetBuildId)
      )
      const finalState: ExtensionOperationRecord['state'] = hasUnverifiedTab ? 'PARTIAL' : 'VERIFIED'
      const completed: ExtensionOperationRecord = {
        ...op,
        state: finalState,
        attestation: report,
        tabStates,
        updatedAt: nowIso,
        completedAt: nowIso
      }
      const current = this.store.loadState()
      this.store.saveState({
        ...current,
        lastAttestation: report,
        operations: [completed, ...current.operations.filter((item) => item.operationId !== completed.operationId)]
      })
      return { accepted: true, verified: finalState === 'VERIFIED', operation: completed }
    })
  }

  private verifyPostReloadAttestation(
    op: ExtensionOperationRecord,
    enrollment: ManagedInstallationEnrollment,
    report: ExtensionRuntimeAttestation
  ): string | null {
    if (op.expiresAt && this.now() > Date.parse(op.expiresAt)) {
      return 'OPERATION_EXPIRED'
    }
    if (report.reloadedNonce !== op.nonce || report.reloadedEpoch !== op.epoch) {
      return 'NONCE_OR_EPOCH_MISMATCH'
    }
    if (!report.bootId || !report.bootId.trim()) {
      return 'BOOT_ID_MISSING'
    }
    if (op.previousBootId && report.bootId === op.previousBootId) {
      return `BOOT_ID_NOT_ROTATED:${report.bootId}`
    }
    if (report.buildId !== op.targetBuildId) {
      return `EXTENSION_BUILD_MISMATCH:expected=${op.targetBuildId ?? 'none'},actual=${report.buildId}`
    }
    if (!report.hostBuildId || !report.hostBuildId.trim()) {
      return 'HOST_BUILD_ID_MISSING'
    }
    if (report.hostCompatible !== true) {
      return 'HOST_INCOMPATIBLE'
    }
    if (op.candidateMetadata) {
      if (report.manifestVersion !== op.candidateMetadata.manifestVersion) {
        return `MANIFEST_VERSION_MISMATCH:expected=${op.candidateMetadata.manifestVersion},actual=${report.manifestVersion}`
      }
      if (report.hostBuildId !== op.targetBuildId) {
        return `HOST_BUILD_MISMATCH:expected=${op.targetBuildId ?? 'none'},actual=${report.hostBuildId ?? 'none'}`
      }
    }
    const unpackedManifestPath = join(enrollment.unpackedPath, 'manifest.json')
    if (existsSync(unpackedManifestPath)) {
      try {
        const diskManifest = JSON.parse(readFileSync(unpackedManifestPath, 'utf8')) as { version?: string }
        if (diskManifest.version && diskManifest.version !== report.manifestVersion) {
          return `DISK_MANIFEST_VERSION_MISMATCH:${diskManifest.version}!=${report.manifestVersion}`
        }
      } catch {
        return 'DISK_MANIFEST_UNREADABLE'
      }
    }
    return null
  }
}
