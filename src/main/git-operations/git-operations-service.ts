import { createHash } from 'node:crypto'
import ignore from 'ignore'
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { GitService, GitWorktreeReadSnapshot } from '../core/git-service'
import type { GitRemoteTransport } from '../core/git-remote-transport'
import { GitOperationReceipts } from './git-operation-receipts'
import type { McpToolResult } from '../mcp/channel-mcp-adapter'
import { GitWorktreeRegistry, type WorktreeIdentity, type WorktreeRecord } from './git-worktree-registry'
import { assertNoWorktreeGrant, GitWorktreeOwnership, ownershipDigest, withWorktreeTransaction, type WorktreeApprovalPort, type WorktreeIntent, type WorktreeObservation, type WorktreeScope, type WorktreeSnapshot } from './git-worktree-ownership'
import { GitWorktreeLifecycle } from './git-worktree-lifecycle'
import { GitWorktreeIntegration, type WorktreeIntegrationPreview } from './git-worktree-integration'
import type { CapturedText, WorktreeStructureCapture, WorktreeStructureRequest } from './git-worktree-capture'

export class GitOperationsError extends Error {
  constructor(readonly code: string, readonly details?: { revisionKind?: 'FILE_BYTES_SHA256'; totalLines?: number; validRange?: { startLine: number; endLine: number } | null; maxLines?: number }) { super(code) }
}
function fail(code: string): never { throw new GitOperationsError(code) }
export interface GitChange {
  path: string
  stagedState: string | null
  unstagedState: string | null
  untracked: boolean
  deleted: boolean
  renamed: boolean
  conflicted: boolean
  previousPath?: string
}
interface ScopedWorktreeRequest {
  worktreeId: string
  leaseId: string
  leaseCredential: string
  operationId: string
  snapshot: WorktreeSnapshot
}
export interface WorktreeValidationPort {
  verify(worktreeId: string, commit: string, proofIds: string[]): Promise<boolean>
  busy(worktreeId: string): Promise<boolean>
  start(worktreeId: string, input: { profileId: string; targets?: string[]; evidenceFor?: string[] }): Promise<unknown>
  get(runId: string): unknown
}
export type ChangeFilter = 'ALL' | 'STAGED' | 'UNSTAGED' | 'UNTRACKED' | 'CONFLICTED'
export type BranchRequest =
  | { action: 'LIST' }
  | { action: 'CREATE'; branch: string; startPoint?: string; expectedHead: string | null }
  | { action: 'SWITCH' | 'DELETE'; branch: string }
  | { action: 'RENAME'; branch: string; newBranch: string }
  | { action: 'SET_UPSTREAM'; branch: string; remote: string; remoteBranch: string; expectedHead: string | null }
export type MergeRequest = { action: 'ABORT' } | { action: 'MERGE'; source: string; expectedHead: string | null; mode?: 'FF_ONLY' | 'MERGE' }
export type SyncRequest = { action: 'FETCH'; remote?: string } | { action: 'PUSH' | 'PULL_FF_ONLY'; remote?: string; branch?: string; expectedHead: string | null }
export type ShelfRequest =
  | { action: 'LIST' }
  | { action: 'CREATE'; paths: string[]; expectedWorktreeRevision: string; label?: string }
  | { action: 'RESTORE'; shelfId: string; expectedHead: string | null; expectedWorktreeRevision: string }
  | { action: 'DROP'; shelfId: string }
export type ConflictSide = 'BASE' | 'OURS' | 'THEIRS' | 'WORKTREE'
export type ConflictResolution = 'OURS' | 'THEIRS' | 'CONTENT' | 'DELETE'
export type RevertRequest = { action?: 'START'; commit: string; expectedHead: string | null }
  | { action: 'CONTINUE'; expectedHead: string | null; expectedIndexRevision: string }
  | { action: 'ABORT'; expectedHead: string | null }
export type GitIgnoreRequest =
  | { action: 'PREVIEW_ADD'; rules: string[] }
  | { action: 'ADD'; rules: string[]; expectedWorktreeRevision: string; expectedPreviewId: string }

function isBinary(bytes: Buffer): boolean {
  if (bytes.includes(0)) return true
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return false } catch { return true }
}

export class GitOperationsService {
  async executeReceipted(operationId: string, name: string, args: Record<string, unknown>, mutate: () => Promise<McpToolResult>): Promise<McpToolResult> {
    if (this.readOnlyWorktree) fail('WORKTREE_OWNERSHIP_REQUIRED')
    return new GitOperationReceipts(this.repoRoot, this.git).execute(operationId, name, args, mutate)
  }
  private pending: Promise<unknown> = Promise.resolve()
  readonly worktrees: GitWorktreeRegistry | undefined
  readonly ownership: GitWorktreeOwnership | undefined
  private readonly worktreeRepositoryId: string | undefined
  constructor(private readonly repoRoot: string, private readonly git: GitService, private readonly transport: GitRemoteTransport, identity?: WorktreeIdentity, private readonly readOnlyWorktree = false, approval?: WorktreeApprovalPort, private readonly transactionAlreadyHeld = false, private readonly worktreeValidation?: WorktreeValidationPort) {
    this.worktreeRepositoryId = identity?.repositoryId
    if (identity) this.worktrees = new GitWorktreeRegistry(repoRoot, git, identity)
    if (identity && approval) this.ownership = new GitWorktreeOwnership(async id => {
      const { record, service } = await this.selectWorktree(id)
      const state = await service.getState()
      for (const change of await service.getChanges()) service.paths([change.path])
      const contentRevision = await this.git.getWorktreeRevision(record.path)
      if (state.worktreeRevision !== (await service.getState()).worktreeRevision) fail('GIT_STATE_CHANGED')
      return { repositoryId: identity.repositoryId, worktreeId: id, generation: record.generation, path: record.path,
        commonDirectory: realpathSync(await this.git.getCommonDirectory(record.path)), administrativeDirectory: realpathSync(await this.git.getWorktreeDirectory(record.path)),
        snapshot: { branch: state.branch, head: state.head, indexRevision: state.indexRevision, worktreeRevision: state.worktreeRevision, operation: state.operation }, contentRevision }
    }, approval)
  }

  async handoffWorktree(request: { action: 'REQUEST' | 'RECOVER' | 'ACCEPT' | 'RELEASE'; worktreeId?: string; snapshot?: WorktreeSnapshot; scope?: WorktreeScope; durationSeconds?: number; requestId?: string; requestCredential?: string; leaseId?: string; leaseCredential?: string }) {
    if (!this.ownership) fail('WORKTREE_LOCAL_APPROVAL_UNAVAILABLE')
    try {
      if (request.action === 'ACCEPT') return await this.ownership!.accept(request.requestId!, request.requestCredential!)
      if (request.action === 'RELEASE') return await this.ownership!.execute(request.worktreeId!, request.leaseId!, request.leaseCredential!, 'RELEASE', async () => ({ state: 'RELEASED', mutationAllowed: false }))
      const scope = request.scope!
      const { service } = await this.selectWorktree(request.worktreeId!)
      if (scope.paths.length) scope.paths = service.paths(scope.paths)
      for (const branch of scope.branches) await service.branch(branch)
      if ((scope.operations.includes('STAGE') || scope.operations.includes('UNSTAGE') || scope.operations.includes('COMMIT')) && !scope.paths.length) fail('INVALID_ARGUMENT')
      return await this.ownership!.request(request.worktreeId!, request.snapshot!, scope, request.durationSeconds!, request.action === 'RECOVER')
    } catch (error) { throw new GitOperationsError(error instanceof Error ? error.message : 'WORKTREE_APPROVAL_FAILED') }
  }

  async mutateWorktree(request: { action: 'STAGE' | 'UNSTAGE' | 'COMMIT' | 'CREATE_BRANCH'; worktreeId: string; leaseId: string; leaseCredential: string; operationId: string; snapshot: WorktreeSnapshot; paths?: string[]; message?: string; branch?: string }): Promise<McpToolResult> {
    if (!this.ownership) fail('WORKTREE_LOCAL_APPROVAL_UNAVAILABLE')
    const { leaseCredential, operationId, ...fingerprint } = request
    try {
      const selectedForReceipt = await this.selectWorktree(request.worktreeId)
      const receiptArgs = { ...fingerprint, credentialHash: ownershipDigest(leaseCredential), repositoryId: this.worktreeRepositoryId, generation: selectedForReceipt.record.generation, commonDirectory: realpathSync(await this.git.getCommonDirectory(selectedForReceipt.record.path)) }
      const receipts = new GitOperationReceipts(this.repoRoot, this.git)
      if (await this.git.readOperationReceipt(this.repoRoot, operationId)) return receipts.execute(operationId, 'mutate_worktree', receiptArgs, async () => { throw new Error('RECEIPT_REPLAY_REQUIRED') })
      return await this.ownership!.execute(request.worktreeId, request.leaseId, leaseCredential, request.action, async (observed, scope, assertCurrent) => {
        if (this.worktreeValidation && new GitWorktreeLifecycle(observed.commonDirectory).get(selectedForReceipt.record) && await this.worktreeValidation.busy(request.worktreeId)) fail('WORKTREE_VALIDATION_BUSY')
        return receipts.execute(operationId, 'mutate_worktree', receiptArgs, async () => {
          try {
            if (ownershipDigest(request.snapshot) !== ownershipDigest(observed.snapshot)) fail('GIT_STATE_CHANGED')
            const selected = await this.selectWorktree(request.worktreeId)
            const service = new GitOperationsService(selected.record.path, this.git, this.transport, undefined, false, undefined, true)
            if (request.action === 'STAGE' || request.action === 'UNSTAGE') {
              const paths = service.paths(request.paths!)
              if (paths.some(path => !scope.paths.includes(path))) fail('WORKTREE_SCOPE_NOT_GRANTED')
              await assertCurrent()
              await service.stage({ mode: request.action, paths, expectedIndexRevision: observed.snapshot.indexRevision, expectedWorktreeRevision: observed.contentRevision })
            } else if (request.action === 'COMMIT') {
              if (!observed.snapshot.branch) fail('WORKTREE_BRANCH_REQUIRED')
              if ((await service.getChanges('STAGED')).some(change => !scope.paths.includes(change.path) || change.previousPath && !scope.paths.includes(change.previousPath))) fail('WORKTREE_SCOPE_NOT_GRANTED')
              await assertCurrent()
              await service.commit({ message: request.message!, expectedHead: observed.snapshot.head, expectedIndexRevision: observed.snapshot.indexRevision })
            } else {
              if (!scope.branches.includes(request.branch!)) fail('WORKTREE_SCOPE_NOT_GRANTED')
              if ((await this.worktrees!.discover()).worktrees.some(w => w.branch === request.branch)) fail('WORKTREE_BRANCH_OCCUPIED')
              const branch = await service.branch(request.branch!)
              if ((await this.git.listBranches(selected.record.path)).split('\n').some(existing => existing.split('\0')[0] === branch)) fail('BRANCH_ALREADY_EXISTS')
              await assertCurrent()
              await this.git.createAndSwitchBranch(selected.record.path, branch)
            }
            const current = await this.selectWorktree(request.worktreeId)
            return { content: [{ type: 'text', text: JSON.stringify({ worktreeId: request.worktreeId, ...await current.service.getState() }) }] }
          } catch (error) {
            return { content: [{ type: 'text', text: JSON.stringify({ code: error instanceof Error ? error.message : 'GIT_OPERATION_FAILED' }) }], isError: true }
          }
        })
      })
    } catch (error) { throw new GitOperationsError(error instanceof Error ? error.message : 'WORKTREE_OPERATION_FAILED') }
  }

  private async scopedWorktreeMutation<T extends ScopedWorktreeRequest>(operation: string, request: T, intent: WorktreeIntent,
    effect: (observation: WorktreeObservation, scope: WorktreeScope, assertCurrent: () => Promise<void>) => Promise<unknown>): Promise<McpToolResult> {
    if (!this.ownership) fail('WORKTREE_LOCAL_APPROVAL_UNAVAILABLE')
    const { leaseCredential, operationId, ...values } = request
    const existing = await this.git.readOperationReceipt(this.repoRoot, operationId)
    const common = realpathSync(await this.git.getCommonDirectory(this.repoRoot))
    const discovery = await this.worktrees!.discover()
    const closed = existing ? new GitWorktreeLifecycle(common).closed(request.worktreeId) : null
    if (closed && closed.repositoryId !== this.worktreeRepositoryId) fail('WORKTREE_IDENTITY_MISMATCH')
    const record = discovery.worktrees.find(w => w.worktreeId === request.worktreeId) ?? closed
    if (!record) fail('WORKTREE_STALE')
    const args = { ...values, credentialHash: ownershipDigest(leaseCredential), repositoryId: this.worktreeRepositoryId, generation: record.generation, commonDirectory: common }
    const receipts = new GitOperationReceipts(this.repoRoot, this.git)
    if (existing) return receipts.execute(operationId, operation, args, async () => { throw new Error('RECEIPT_REPLAY_REQUIRED') })
    try {
      return await this.ownership!.execute(request.worktreeId, request.leaseId, leaseCredential, intent, async (observed, scope, assertCurrent) => receipts.execute(operationId, operation, args, async () => {
        try {
          if (ownershipDigest(request.snapshot) !== ownershipDigest(observed.snapshot)) fail('GIT_STATE_CHANGED')
          if (operation !== 'start_worktree_validation' && this.worktreeValidation && new GitWorktreeLifecycle(observed.commonDirectory).get(record) && await this.worktreeValidation.busy(request.worktreeId)) fail('WORKTREE_VALIDATION_BUSY')
          const result = await effect(observed, scope, assertCurrent)
          return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        } catch (error) {
          return { content: [{ type: 'text', text: JSON.stringify({ code: error instanceof Error ? error.message : 'WORKTREE_OPERATION_FAILED' }) }], isError: true }
        }
      }))
    } catch (error) { throw new GitOperationsError(error instanceof Error ? error.message : 'WORKTREE_OPERATION_FAILED') }
  }

  async manageWorktree(request: ScopedWorktreeRequest & ({ action: 'CREATE'; branch: string; startPoint: string } | { action: 'CLOSE'; preservedBranch: string })) {
    return this.scopedWorktreeMutation('manage_worktree', request, request.action === 'CREATE' ? 'CREATE_WORKTREE' : 'CLOSE', async (observed, scope, assertCurrent) => {
      const lifecycle = new GitWorktreeLifecycle(observed.commonDirectory)
      const { record, service } = await this.selectWorktree(request.worktreeId)
      if (request.action === 'CREATE') {
        if (!scope.branches.includes(request.branch) || !(scope.startPoints ?? []).includes(request.startPoint)) fail('WORKTREE_SCOPE_NOT_GRANTED')
        await service.branch(request.branch)
        const startPoint = await service.ref(request.startPoint)
        if ((await this.worktrees!.discover()).worktrees.some(w => w.branch === request.branch)) fail('WORKTREE_BRANCH_OCCUPIED')
        if ((await this.git.listBranches(record.path)).split('\n').some(existing => existing.split('\0')[0] === request.branch)) fail('BRANCH_ALREADY_EXISTS')
        const destination = lifecycle.destination()
        await assertCurrent()
        await this.git.createWorktree(this.repoRoot, destination, request.branch, startPoint)
        const created = (await this.worktrees!.discover()).worktrees.find(w => w.path === destination)
        if (!created) fail('OPERATION_OUTCOME_UNKNOWN')
        lifecycle.save({ ...created, repositoryId: observed.repositoryId, startPoint, createdAt: new Date().toISOString() })
        return { result: 'CREATED', managed: true, worktree: created, projectChanged: false }
      }
      const managed = lifecycle.get(record)
      if (!managed || managed.repositoryId !== observed.repositoryId) fail('WORKTREE_NOT_MANAGED')
      if (record.locked) fail('WORKTREE_LOCKED')
      if (request.snapshot.operation) fail('GIT_OPERATION_IN_PROGRESS')
      if ((await service.getChanges()).length) fail('DIRTY_WORKTREE')
      if (!scope.branches.includes(request.preservedBranch) || request.preservedBranch === record.branch) fail('WORKTREE_PRESERVATION_REQUIRED')
      await service.branch(request.preservedBranch)
      const preserved = await service.ref(`refs/heads/${request.preservedBranch}`)
      if (!record.head || !await this.git.isAncestor(this.repoRoot, record.head, preserved)) fail('WORKTREE_PRESERVATION_REQUIRED')
      await assertCurrent()
      await this.git.removeWorktree(this.repoRoot, record.path)
      lifecycle.save({ ...managed, closedAt: new Date().toISOString() })
      return { result: 'CLOSED', worktreeId: record.worktreeId, preservedBranch: request.preservedBranch, preservedHead: preserved }
    })
  }

  private snapshot(state: WorktreeSnapshot): WorktreeSnapshot {
    return { branch: state.branch, head: state.head, indexRevision: state.indexRevision, worktreeRevision: state.worktreeRevision, operation: state.operation }
  }

  async startWorktreeValidation(request: ScopedWorktreeRequest & { profileId: string; targets?: string[]; evidenceFor?: string[] }) {
    return this.scopedWorktreeMutation('start_worktree_validation', request, 'INTEGRATE', async (observed, scope, assertCurrent) => {
      if (!this.worktreeValidation) fail('WORKTREE_VALIDATION_UNAVAILABLE')
      if (!observed.snapshot.head || !(scope.startPoints ?? []).includes(observed.snapshot.head) || !scope.branches.includes(observed.snapshot.branch!)) fail('WORKTREE_SCOPE_NOT_GRANTED')
      const selected = await this.selectWorktree(request.worktreeId)
      if (observed.snapshot.operation || (await selected.service.getChanges()).length) fail('DIRTY_WORKTREE')
      await assertCurrent()
      return this.worktreeValidation!.start(request.worktreeId, { profileId: request.profileId, targets: request.targets, evidenceFor: request.evidenceFor })
    })
  }

  getWorktreeValidation(runId: string) {
    if (!this.worktreeValidation) fail('WORKTREE_VALIDATION_UNAVAILABLE')
    return this.worktreeValidation!.get(runId)
  }

  async getWorktreeConflict(request: { worktreeId: string; path: string; side?: ConflictSide; cursor?: string }) {
    const selected = await this.selectWorktree(request.worktreeId)
    return selected.service.getConflict(request)
  }

  async resolveWorktreeConflict(request: ScopedWorktreeRequest & { path: string; resolution: ConflictResolution; expectedConflictRevision: string; content?: string }) {
    return this.scopedWorktreeMutation('resolve_worktree_conflict', request, 'INTEGRATE', async (observed, scope, assertCurrent) => {
      const selected = await this.selectWorktree(request.worktreeId)
      if (!new GitWorktreeLifecycle(observed.commonDirectory).get(selected.record)) fail('WORKTREE_NOT_MANAGED')
      const paths = selected.service.paths([request.path])
      if (!scope.paths.includes(paths[0])) fail('WORKTREE_SCOPE_NOT_GRANTED')
      await assertCurrent()
      const service = new GitOperationsService(selected.record.path, this.git, this.transport, undefined, false, undefined, true)
      return service.resolveConflict({ ...request, expectedHead: observed.snapshot.head })
    })
  }

  async previewWorktreeIntegration(request: { sourceWorktreeId: string; targetBranch: string }) {
    const source = await this.selectWorktree(request.sourceWorktreeId)
    const sourceState = this.snapshot(await source.service.getState())
    if (!sourceState.head || sourceState.operation) fail('GIT_OPERATION_IN_PROGRESS')
    const targetBranch = await source.service.branch(request.targetBranch)
    const targetHead = await source.service.ref(`refs/heads/${targetBranch}`)
    const common = realpathSync(await this.git.getCommonDirectory(this.repoRoot))
    const targetRecord = (await this.worktrees!.discover()).worktrees.find(w => w.branch === targetBranch)
    const targetState = targetRecord ? this.snapshot(await (await this.selectWorktree(targetRecord.worktreeId)).service.getState()) : null
    if (targetRecord && targetState?.head !== targetHead) fail('GIT_STATE_CHANGED')
    const mergeBase = await this.git.mergeBase(this.repoRoot, sourceState.head, targetHead)
    const mode = await this.git.isAncestor(this.repoRoot, targetHead, sourceState.head) ? 'FF_ONLY' as const : 'MERGE' as const
    const blockers: string[] = []
    if (targetRecord) {
      blockers.push('TARGET_OWNERSHIP_REQUIRED')
      if ((await (await this.selectWorktree(targetRecord.worktreeId)).service.getChanges()).length) blockers.push('TARGET_DIRTY')
      if (targetState?.operation) blockers.push('TARGET_GIT_OPERATION_IN_PROGRESS')
    }
    const preview = new GitWorktreeIntegration(common).save({ repositoryId: this.worktreeRepositoryId!,
      source: { worktreeId: source.record.worktreeId, generation: source.record.generation, snapshot: sourceState },
      target: { branch: targetBranch, head: targetHead, worktreeId: targetRecord?.worktreeId ?? null, generation: targetRecord?.generation ?? null, snapshot: targetState },
      mergeBase, sourceCommits: await this.git.integrationCommits(this.repoRoot, sourceState.head, targetHead), mode, promotionBlockers: blockers })
    await this.revalidateIntegration(preview)
    return preview
  }

  private async revalidateIntegration(preview: WorktreeIntegrationPreview, sourceSnapshot = true, targetSnapshot = true): Promise<void> {
    if (preview.repositoryId !== this.worktreeRepositoryId || Date.parse(preview.expiresAt) <= Date.now()) fail('WORKTREE_PREVIEW_STALE')
    const source = await this.selectWorktree(preview.source.worktreeId)
    if (source.record.generation !== preview.source.generation || source.record.head !== preview.source.snapshot.head) fail('WORKTREE_PREVIEW_STALE')
    if (sourceSnapshot && ownershipDigest(this.snapshot(await source.service.getState())) !== ownershipDigest(preview.source.snapshot)) fail('WORKTREE_PREVIEW_STALE')
    if (await source.service.ref(`refs/heads/${preview.target.branch}`) !== preview.target.head) fail('WORKTREE_PREVIEW_STALE')
    const target = (await this.worktrees!.discover()).worktrees.find(w => w.branch === preview.target.branch)
    if ((target?.worktreeId ?? null) !== preview.target.worktreeId || (target?.generation ?? null) !== preview.target.generation) fail('WORKTREE_PREVIEW_STALE')
    if (targetSnapshot && target && ownershipDigest(this.snapshot(await (await this.selectWorktree(target.worktreeId)).service.getState())) !== ownershipDigest(preview.target.snapshot)) fail('WORKTREE_PREVIEW_STALE')
  }

  async integrateWorktree(request: ScopedWorktreeRequest & { action: 'APPLY' | 'PROMOTE'; previewId: string; integrationWorktreeId?: string; proofIds?: string[] }) {
    return this.scopedWorktreeMutation('integrate_worktree', request, 'INTEGRATE', async (observed, scope, assertCurrent) => {
      const preview = new GitWorktreeIntegration(observed.commonDirectory).get(request.previewId)
      const { record } = await this.selectWorktree(request.action === 'APPLY' ? request.worktreeId : request.integrationWorktreeId!)
      const managed = new GitWorktreeLifecycle(observed.commonDirectory).get(record)
      if (!managed || managed.repositoryId !== observed.repositoryId) fail('WORKTREE_NOT_MANAGED')
      if (!scope.branches.includes(preview.target.branch)) fail('WORKTREE_SCOPE_NOT_GRANTED')
      await this.revalidateIntegration(preview, request.action === 'APPLY', true)
      const integration = new GitOperationsService(record.path, this.git, this.transport, undefined, false, undefined, true)
      if (request.action === 'APPLY') {
        if (request.worktreeId === preview.source.worktreeId || record.head !== preview.target.head || !scope.branches.includes(record.branch!) || !(scope.startPoints ?? []).includes(preview.source.snapshot.head!)) fail('WORKTREE_SCOPE_NOT_GRANTED')
        await assertCurrent()
        const result = await integration.merge({ action: 'MERGE', source: preview.source.snapshot.head!, expectedHead: preview.target.head, mode: preview.mode })
        return { ...result, result: 'result' in result && result.result === 'CONFLICTS' ? 'CONFLICTS' : 'INTEGRATION_PREPARED', worktreeId: record.worktreeId, previewId: preview.previewId, integrationValidated: false }
      }
      if (!record.head || !(scope.startPoints ?? []).includes(record.head)) fail('WORKTREE_SCOPE_NOT_GRANTED')
      if ((await integration.getState()).operation || (await integration.getChanges()).length) fail('DIRTY_WORKTREE')
      if (!this.worktreeValidation || !await this.worktreeValidation.verify(record.worktreeId, record.head, request.proofIds ?? [])) fail('WORKTREE_INTEGRATION_VALIDATION_REQUIRED')
      if (!await this.git.isAncestor(this.repoRoot, preview.target.head, record.head) || !await this.git.isAncestor(this.repoRoot, preview.source.snapshot.head!, record.head)) fail('WORKTREE_INTEGRATION_INVALID')
      if (preview.target.worktreeId) {
        if (request.worktreeId !== preview.target.worktreeId) fail('WORKTREE_TARGET_OWNERSHIP_REQUIRED')
        const selected = await this.selectWorktree(request.worktreeId)
        const target = new GitOperationsService(selected.record.path, this.git, this.transport, undefined, false, undefined, true)
        await assertCurrent()
        await target.merge({ action: 'MERGE', source: record.head, expectedHead: preview.target.head, mode: 'FF_ONLY' })
      } else {
        if (request.worktreeId !== record.worktreeId || !record.branch || !scope.branches.includes(record.branch)) fail('WORKTREE_SCOPE_NOT_GRANTED')
        await assertCurrent()
        await this.git.switchBranch(record.path, preview.target.branch)
        await integration.merge({ action: 'MERGE', source: record.head, expectedHead: preview.target.head, mode: 'FF_ONLY' })
        await this.git.switchBranch(record.path, record.branch)
      }
      return { result: 'INTEGRATED', targetBranch: preview.target.branch, integratedHead: record.head, integrationWorktreeId: record.worktreeId, validation: 'INTEGRATION_VALIDATED', proofIds: request.proofIds }
    })
  }

  async publishWorktree(request: ScopedWorktreeRequest & { branch: string; remote: string }) {
    return this.scopedWorktreeMutation('publish_worktree', request, 'PUSH', async (observed, scope, assertCurrent) => {
      if (!scope.branches.includes(request.branch) || observed.snapshot.branch !== request.branch || !observed.snapshot.head) fail('WORKTREE_SCOPE_NOT_GRANTED')
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.remote) || !await this.git.getRemoteUrl(this.repoRoot, request.remote)) fail('REMOTE_NOT_FOUND')
      await assertCurrent()
      await this.transport.push(observed.path, request.branch, request.remote, observed.snapshot.head)
      return { result: 'PUBLISHED', branch: request.branch, pushedHead: observed.snapshot.head, remote: request.remote, integrated: false }
    })
  }

  async discoverWorktrees(request: { cursor?: string } = {}) {
    if (!this.worktrees) fail('WORKTREE_IDENTITY_UNAVAILABLE')
    try {
      const discovered = await this.worktrees!.discover()
      const revision = createHash('sha256').update(JSON.stringify(discovered)).digest('hex')
      let offset = 0
      if (request.cursor) {
        const [expected, position] = request.cursor.split(':')
        if (expected !== revision) fail('GIT_STATE_CHANGED')
        offset = Number(position)
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > discovered.worktrees.length) fail('INVALID_ARGUMENT')
      }
      const end = Math.min(offset + 100, discovered.worktrees.length)
      return { repositoryId: discovered.repositoryId, worktrees: discovered.worktrees.slice(offset, end), revision, nextCursor: end < discovered.worktrees.length ? `${revision}:${end}` : null }
    }
    catch (error) { throw new GitOperationsError(error instanceof Error ? error.message : 'WORKTREE_IDENTITY_MISMATCH') }
  }

  async inspectWorktree(worktreeId: string) {
    return this.readWorktree(worktreeId, async (service, snapshot, record) => {
      const changes = service.parseChanges(snapshot.status)
      const upstream = await this.git.getUpstreamState(record.path)
      const ownership = this.ownership?.peek({ worktreeId, generation: record.generation, commonDirectory: realpathSync(await this.git.getCommonDirectory(record.path)) }) ?? 'NOT_GRANTED'
      return { worktreeId, generation: record.generation, ownership, mutationAllowed: false,
        repositoryState: 'GIT', branch: snapshot.branch, head: snapshot.head, ...upstream, dirty: changes.length > 0,
        stagedCount: changes.filter(c => c.stagedState).length, unstagedCount: changes.filter(c => c.unstagedState).length,
        untrackedCount: changes.filter(c => c.untracked).length, conflictCount: changes.filter(c => c.conflicted).length,
        operation: snapshot.operation, indexRevision: snapshot.indexRevision, worktreeRevision: snapshot.worktreeRevision,
        worktreeRevisionKind: 'GIT_STATUS_FILE_METADATA' }
    })
  }

  async selectWorktree(worktreeId: string) {
    if (!this.worktrees) fail('WORKTREE_IDENTITY_UNAVAILABLE')
    try {
      const record = await this.worktrees!.select(worktreeId)
      return { record, service: new GitOperationsService(record.path, this.git, this.transport, undefined, true) }
    } catch (error) { throw new GitOperationsError(error instanceof Error ? error.message : 'WORKTREE_IDENTITY_MISMATCH') }
  }

  private async readWorktree<T>(worktreeId: string, read: (service: GitOperationsService, snapshot: GitWorktreeReadSnapshot, record: WorktreeRecord) => Promise<T>): Promise<T> {
    if (!this.worktrees) fail('WORKTREE_IDENTITY_UNAVAILABLE')
    try {
      const record = await this.worktrees!.revalidateSelection(worktreeId)
      const service = new GitOperationsService(record.path, this.git, this.transport, undefined, true)
      const before = await this.git.captureWorktreeReadSnapshot(record.path)
      const value = await read(service, before, record)
      const after = await this.git.captureWorktreeReadSnapshot(record.path)
      const current = await this.worktrees!.revalidateSelection(worktreeId)
      const registeredHead = current.head && !/^0+$/.test(current.head) ? current.head : null
      if (JSON.stringify(before) !== JSON.stringify(after) || registeredHead !== after.head || current.branch !== after.branch) fail('GIT_STATE_CHANGED')
      return value
    } catch (error) {
      if (error instanceof GitOperationsError) throw error
      throw new GitOperationsError(error instanceof Error ? error.message : 'WORKTREE_IDENTITY_MISMATCH')
    }
  }

  async getWorktreeChanges(request: { worktreeId: string; cursor?: string; pathPrefixes?: string[]; categories?: Array<'STAGED' | 'UNSTAGED' | 'UNTRACKED' | 'DELETED' | 'CONFLICTED'>; pageSize?: number }) {
    return this.readWorktree(request.worktreeId, async (service, state) => {
      const prefixes = request.pathPrefixes === undefined ? [] : service.paths(request.pathPrefixes, 20).sort()
      if (prefixes.some(path => /[*?\[\]]/.test(path))) fail('INVALID_ARGUMENT')
      const categories = [...new Set(request.categories ?? [])].sort()
      if (request.categories !== undefined && (!Array.isArray(request.categories) || !request.categories.length || request.categories.length > 5) || categories.some(category => !['STAGED', 'UNSTAGED', 'UNTRACKED', 'DELETED', 'CONFLICTED'].includes(category))) fail('INVALID_ARGUMENT')
      const pageSize = request.pageSize ?? 100
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) fail('INVALID_ARGUMENT')
      const all = service.parseChanges(state.status)
      const changes = all.filter(change => (!prefixes.length || prefixes.some(prefix => change.path === prefix || change.path.startsWith(prefix + '/'))) && (!categories.length || categories.some(category => category === 'STAGED' && !!change.stagedState || category === 'UNSTAGED' && !!change.unstagedState || category === 'UNTRACKED' && change.untracked || category === 'DELETED' && change.deleted || category === 'CONFLICTED' && change.conflicted)))
        .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      const revision = createHash('sha256').update(JSON.stringify([request.worktreeId, state.head, state.indexRevision, state.worktreeRevision, changes, prefixes, categories, pageSize])).digest('hex')
      let offset = 0
      if (request.cursor) {
        if (!/^[a-f0-9]{64}:\d+$/.test(request.cursor)) fail('INVALID_ARGUMENT')
        const [expected, position] = request.cursor.split(':')
        if (expected !== revision) fail('GIT_STATE_CHANGED')
        offset = Number(position)
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > changes.length) fail('INVALID_ARGUMENT')
      }
      const end = Math.min(offset + pageSize, changes.length)
      return { worktreeId: request.worktreeId, changes: changes.slice(offset, end), revision, nextCursor: end < changes.length ? `${revision}:${end}` : null }
    })
  }

  async getWorktreeDiff(request: { worktreeId: string; paths: string[]; mode: 'WORKTREE' | 'STAGED' | 'BETWEEN_REFS'; base?: string; head?: string; cursor?: string }) {
    return this.readWorktree(request.worktreeId, async (service, state) => {
      const paths = service.paths(request.paths, 20)
      for (const path of paths) {
        const full = resolve(service.repoRoot, path)
        if (existsSync(full) && !statSync(full).isFile()) fail('WORKTREE_FILE_UNSUPPORTED')
      }
      if (!['WORKTREE', 'STAGED', 'BETWEEN_REFS'].includes(request.mode)) fail('INVALID_ARGUMENT')
      const base = request.mode === 'BETWEEN_REFS' ? await service.ref(request.base!) : undefined
      const head = request.mode === 'BETWEEN_REFS' ? await service.ref(request.head!) : undefined
      let patch: string
      try { patch = await this.git.getOperationsDiff(service.repoRoot, paths, request.mode, base, head, 8 * 1024 * 1024) }
      catch (error) {
        if (error instanceof Error && error.message === 'GIT_OUTPUT_BYTE_LIMIT') fail('WORKTREE_DIFF_BYTE_LIMIT')
        throw error
      }
      const revision = createHash('sha256').update(JSON.stringify([request.worktreeId, paths, request.mode, base, head, state.head, state.indexRevision, state.worktreeRevision, patch])).digest('hex')
      let offset = 0
      if (request.cursor) {
        const [expected, position] = request.cursor.split(':')
        if (expected !== revision) fail('GIT_STATE_CHANGED')
        offset = Number(position)
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > patch.length) fail('INVALID_ARGUMENT')
      }
      let end = Math.min(offset + 24000, patch.length)
      while (Buffer.byteLength(patch.slice(offset, end)) > 24000) end--
      if (end < patch.length && /[\uD800-\uDBFF]/.test(patch[end - 1] ?? '')) end--
      return { worktreeId: request.worktreeId, patch: patch.slice(offset, end), binary: /Binary files .* differ/.test(patch), truncated: end < patch.length, nextCursor: end < patch.length ? `${revision}:${end}` : null, revision }
    })
  }

  async readWorktreeFile(request: { worktreeId: string; path: string; startLine: number; endLine: number; expectedRevision?: string; expectedFileRevision?: string }) {
    if (request.expectedRevision !== undefined && request.expectedFileRevision !== undefined && request.expectedRevision !== request.expectedFileRevision) fail('INVALID_ARGUMENT')
    const result = await this.readWorktree(request.worktreeId, async service => {
      try { return { value: await service.readLiteralFile(request) } }
      catch (error) {
        if (error instanceof GitOperationsError && error.code === 'WORKTREE_LINE_OUT_OF_BOUNDS') return { error }
        throw error
      }
    })
    if (result.error) throw result.error
    return result.value!
  }

  async captureWorktreeStructure<T>(request: WorktreeStructureRequest, project: (capture: WorktreeStructureCapture) => Promise<T>): Promise<T> {
    if (request.baseCommit !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(request.baseCommit)) fail('INVALID_ARGUMENT')
    return this.readWorktree(request.worktreeId, async (service, snapshot, record) => {
      const paths = service.paths(request.paths, 10)
      if (paths.some(path => path.length > 500)) fail('INVALID_ARGUMENT')
      const canonicalHead = await this.git.getCurrentCommitHash(this.repoRoot)
      let baseCommit: string | null = null
      if (request.baseCommit) {
        baseCommit = await this.git.resolveCommit(service.repoRoot, request.baseCommit)
        if (baseCommit !== request.baseCommit) fail('INVALID_ARGUMENT')
      } else if (canonicalHead && snapshot.head) {
        try { baseCommit = await this.git.mergeBase(service.repoRoot, canonicalHead, snapshot.head) }
        catch { baseCommit = null }
      }
      const committed = new Map<string, { status: string; previousPath?: string; renamedTo?: string }>()
      if (baseCommit && snapshot.head) {
        const entries = (await this.git.getSelectedCommitChanges(service.repoRoot, baseCommit, snapshot.head, paths)).split('\0')
        for (let i = 0; i < entries.length - 1;) {
          const status = entries[i++]
          const path = entries[i++]
          if (/^R/.test(status)) {
            const destination = entries[i++]
            committed.set(destination, { status, previousPath: path })
            committed.set(path, { status: 'R_SOURCE', renamedTo: destination })
          }
          else committed.set(path, { status })
        }
      }
      const changes = service.parseChanges(snapshot.status)
      let totalBytes = 0
      const decode = (bytes: Buffer): CapturedText => {
        totalBytes += bytes.length
        if (totalBytes > 4 * 1024 * 1024) fail('WORKTREE_CAPTURE_BYTE_LIMIT')
        if (isBinary(bytes)) fail('WORKTREE_FILE_BINARY')
        return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), hash: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
      }
      const files: WorktreeStructureCapture['files'] = []
      for (const path of paths) {
        const change = changes.find(c => c.path === path)
        const committedChange = committed.get(path)
        const previousPath = change?.previousPath ?? committedChange?.previousPath
        const renamedTo = committedChange?.renamedTo ?? changes.find(c => c.renamed && c.previousPath === path && paths.includes(c.path))?.path
        if (previousPath) service.paths([previousPath], 1)
        const bytes = baseCommit ? await this.git.readCommitFile(service.repoRoot, baseCommit, previousPath ?? path, 1024 * 1024) : null
        const current = service.readLiteralText(path, 1024 * 1024)
        files.push({ path, previousPath, renamedTo, committedStatus: committedChange?.status ?? null, change, base: bytes ? decode(bytes) : null, current: current ? decode(current) : null })
      }
      const fingerprint = createHash('sha256').update(JSON.stringify([request.worktreeId, record.generation, canonicalHead, baseCommit, snapshot, files.map(f => [f.path, f.base?.hash, f.current?.hash])])).digest('hex')
      const result = await project({ repositoryId: this.worktreeRepositoryId!, worktreeId: request.worktreeId, generation: record.generation, canonicalHead, baseCommit,
        baseSelection: request.baseCommit ? 'EXPLICIT' : baseCommit ? 'MERGE_BASE' : 'UNAVAILABLE', snapshot,
        state: { dirty: changes.length > 0, staged: changes.some(c => !!c.stagedState), untracked: changes.some(c => c.untracked), conflicted: changes.some(c => c.conflicted) }, fingerprint, files })
      for (const file of files) {
        const current = service.readLiteralText(file.path, 1024 * 1024)
        const hash = current ? createHash('sha256').update(current).digest('hex') : null
        if (hash !== (file.current?.hash ?? null)) fail('GIT_STATE_CHANGED')
      }
      if (await this.git.getCurrentCommitHash(this.repoRoot) !== canonicalHead) fail('GIT_STATE_CHANGED')
      return result
    })
  }

  private readLiteralText(path: string, maxBytes: number, rejectLinks = true): Buffer | null {
    this.paths([path], 1)
    const full = resolve(this.repoRoot, path)
    let ancestor = full
    while (ancestor !== this.repoRoot) {
      if (rejectLinks && lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) fail('INVALID_PATH')
      ancestor = dirname(ancestor)
    }
    if (!existsSync(full)) return null
    const actual = realpathSync(full)
    this.paths([path], 1)
    if (realpathSync(full) !== actual) fail('GIT_STATE_CHANGED')
    const stats = statSync(actual)
    if (!stats.isFile()) fail('WORKTREE_FILE_UNSUPPORTED')
    if (stats.size > maxBytes) fail('WORKTREE_FILE_BYTE_LIMIT')
    const fd = openSync(actual, 'r')
    try {
      const opened = fstatSync(fd)
      if (!opened.isFile() || opened.size !== stats.size || opened.ino !== stats.ino || opened.dev !== stats.dev) fail('GIT_STATE_CHANGED')
      const buffer = Buffer.alloc(opened.size + 1)
      let length = 0
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null)
        if (!count) break
        length += count
      }
      if (length !== opened.size) fail('GIT_STATE_CHANGED')
      const after = fstatSync(fd)
      const current = statSync(full)
      if (realpathSync(full) !== actual || current.ino !== opened.ino || current.dev !== opened.dev || current.birthtimeMs !== opened.birthtimeMs || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail('GIT_STATE_CHANGED')
      return buffer.subarray(0, length)
    } finally { closeSync(fd) }
  }

  private async readLiteralFile(request: { worktreeId: string; path: string; startLine: number; endLine: number; expectedRevision?: string; expectedFileRevision?: string }) {
    const path = this.paths([request.path], 1)[0]
    if (!Number.isInteger(request.startLine) || !Number.isInteger(request.endLine) || request.startLine < 1 || request.endLine < request.startLine || request.endLine - request.startLine >= 400) fail('INVALID_ARGUMENT')
    const bytes = this.readLiteralText(path, 16 * 1024 * 1024, false)
    if (!bytes) fail('WORKTREE_FILE_NOT_FOUND')
    if (isBinary(bytes)) fail('WORKTREE_FILE_BINARY')
    const revision = createHash('sha256').update(bytes).digest('hex')
    const expected = request.expectedFileRevision ?? request.expectedRevision
    if (expected && expected !== revision) throw new GitOperationsError('GIT_STATE_CHANGED', { revisionKind: 'FILE_BYTES_SHA256' })
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
    if (request.startLine > lines.length || request.endLine > lines.length) throw new GitOperationsError('WORKTREE_LINE_OUT_OF_BOUNDS', { totalLines: lines.length, validRange: lines.length ? { startLine: 1, endLine: lines.length } : null, maxLines: 400 })
    const content = lines.slice(request.startLine - 1, request.endLine).join('')
    if (Buffer.byteLength(content, 'utf8') > 24000) fail('WORKTREE_RANGE_BYTE_LIMIT')
    return { worktreeId: request.worktreeId, path, startLine: request.startLine, endLine: request.endLine, content, revision, fileRevision: revision, revisionKind: 'FILE_BYTES_SHA256', byteLength: Buffer.byteLength(content), totalLines: lines.length, encoding: 'UTF-8' }
  }

  private async observeMutation<T>(observe: () => Promise<T>): Promise<T> {
    try { return await observe() }
    catch { throw new GitOperationsError('OPERATION_OUTCOME_UNKNOWN') }
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    if (this.readOnlyWorktree) fail('WORKTREE_OWNERSHIP_REQUIRED')
    const result = this.pending.then(async () => {
      if (this.transactionAlreadyHeld) return operation()
      const common = realpathSync(await this.git.getCommonDirectory(this.repoRoot))
      const administrative = realpathSync(await this.git.getWorktreeDirectory(this.repoRoot))
      return withWorktreeTransaction(common, administrative, async () => {
        assertNoWorktreeGrant(common, this.repoRoot)
        return operation()
      })
    }).catch((error: unknown) => { throw this.normalizeError(error) })
    this.pending = result.catch(() => {})
    return result
  }

  private normalizeError(error: unknown): GitOperationsError {
    if (error instanceof GitOperationsError) return error
    const message = error instanceof Error ? error.message : ''
    if (['WORKTREE_TRANSACTION_BUSY', 'WORKTREE_OWNERSHIP_REQUIRED'].includes(message)) return new GitOperationsError(message)
    for (const code of ['GIT_STATE_CHANGED', 'NOTHING_TO_COMMIT', 'SHELF_NOT_FOUND', 'SHELF_REQUIRES_HEAD', 'CONFLICT_STATE_CHANGED', 'CONFLICT_SIDE_UNAVAILABLE', 'UNSUPPORTED_GIT_PATH']) if (message === code) return new GitOperationsError(code)
    const text = message.toLowerCase()
    const codes: Array<[string[], string]> = [
      [['not a git repository'], 'NOT_GIT_REPOSITORY'],
      [['already exists'], 'BRANCH_ALREADY_EXISTS'],
      [['not found', 'invalid reference', 'unknown revision'], 'BRANCH_NOT_FOUND'],
      [['would be overwritten', 'local changes', 'not fully merged'], 'DIRTY_WORKTREE'],
      [['non-fast-forward', 'fetch first', '[rejected]', 'not possible to fast-forward'], 'NON_FAST_FORWARD'],
      [['authentication', 'could not read username', 'permission denied', '403', '401'], 'AUTHENTICATION_REQUIRED']
    ]
    return new GitOperationsError(codes.find(([parts]) => parts.some((part) => text.includes(part)))?.[1] ?? 'GIT_OPERATION_FAILED')
  }

  private paths(values: string[], max = 500): string[] {
    if (!Array.isArray(values) || !values.length || values.length > max) fail('INVALID_ARGUMENT')
    const root = realpathSync(this.repoRoot)
    return [...new Set(values.map((value) => {
      if (typeof value !== 'string' || !value || isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes('\0')) fail('PATH_OUTSIDE_REPOSITORY')
      const path = value.replace(/\\/g, '/')
      if (path.split('/').some((part) => part === '..' || part.replace(/[ .]+$/, '').toLowerCase() === '.git' || process.platform === 'win32' && part.includes(':')) || path === '.' || path.startsWith(':')) fail('PATH_OUTSIDE_REPOSITORY')
      const absolute = resolve(root, path)
      const normalized = relative(root, absolute).replace(/\\/g, '/')
      if (!normalized || normalized.startsWith('../') || isAbsolute(normalized)) fail('PATH_OUTSIDE_REPOSITORY')
      let ancestor = absolute
      while (!existsSync(ancestor) && ancestor !== root) ancestor = dirname(ancestor)
      const actual = relative(root, realpathSync(ancestor))
      if (actual === '..' || actual.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(actual)) fail('PATH_OUTSIDE_REPOSITORY')
      if (actual.split(/[\\/]/).some((part) => part.toLowerCase() === '.git')) fail('PATH_OUTSIDE_REPOSITORY')
      return normalized
    }))]
  }

  private async repository(): Promise<void> {
    if (!await this.git.isGitRepository(this.repoRoot)) fail('NOT_GIT_REPOSITORY')
  }

  private async checkHead(expected: string | null): Promise<void> {
    if (expected !== null && (typeof expected !== 'string' || !/^[a-f0-9]{40,64}$/.test(expected))) fail('INVALID_ARGUMENT')
    if (await this.git.getCurrentCommitHash(this.repoRoot) !== expected) fail('GIT_STATE_CHANGED')
  }

  private async ready(allowMergeCommit = false): Promise<void> {
    await this.repository()
    const operation = await this.git.getGitOperation(this.repoRoot)
    if (operation && !(allowMergeCommit && operation === 'MERGE')) fail('GIT_OPERATION_IN_PROGRESS')
  }

  private async branch(value: string): Promise<string> {
    if (typeof value !== 'string' || !value || value.startsWith('-') || value.startsWith('@{-')) fail('INVALID_REF')
    try { await this.git.validateBranch(this.repoRoot, value) } catch { fail('INVALID_REF') }
    return value
  }

  private async ref(value: string): Promise<string> {
    if (typeof value !== 'string' || !value || value.startsWith('-')) fail('INVALID_REF')
    try { return await this.git.resolveCommit(this.repoRoot, value) } catch { return fail('INVALID_REF') }
  }

  async getChanges(filter: ChangeFilter = 'ALL'): Promise<GitChange[]> {
    await this.repository()
    if (!['ALL', 'STAGED', 'UNSTAGED', 'UNTRACKED', 'CONFLICTED'].includes(filter)) fail('INVALID_ARGUMENT')
    return this.parseChanges(await this.git.getOperationsStatus(this.repoRoot)).filter((change) => filter === 'ALL' || filter === 'STAGED' && !!change.stagedState || filter === 'UNSTAGED' && !!change.unstagedState || filter === 'UNTRACKED' && change.untracked || filter === 'CONFLICTED' && change.conflicted)
  }

  private parseChanges(status: string): GitChange[] {
    const entries = status.split('\0')
    const changes: GitChange[] = []
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]
      if (!entry) continue
      const x = entry[0], y = entry[1]
      const untracked = x === '?' && y === '?'
      const conflicted = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(x + y)
      const renamed = x === 'R' || y === 'R' || x === 'C' || y === 'C'
      changes.push({ path: entry.slice(3), stagedState: x === ' ' || untracked ? null : x, unstagedState: y === ' ' || untracked ? null : y,
        untracked, deleted: x === 'D' || y === 'D', renamed, conflicted, ...(renamed ? { previousPath: entries[++index] } : {}) })
    }
    return changes
  }

  async getState() {
    const [changes, branch, head, upstream, operation, indexRevision] = await Promise.all([
      this.getChanges(), this.git.getCurrentBranch(this.repoRoot), this.git.getCurrentCommitHash(this.repoRoot),
      this.git.getUpstreamState(this.repoRoot), this.git.getGitOperation(this.repoRoot), this.git.getIndexRevision(this.repoRoot)
    ])
    return { repositoryState: 'GIT', branch, head,
      ...upstream, dirty: changes.length > 0,
      stagedCount: changes.filter((c) => c.stagedState).length, unstagedCount: changes.filter((c) => c.unstagedState).length,
      untrackedCount: changes.filter((c) => c.untracked).length, conflictCount: changes.filter((c) => c.conflicted).length,
      operation, indexRevision, worktreeRevision: await this.git.getWorktreeRevision(this.repoRoot, this.readOnlyWorktree),
      ...(this.readOnlyWorktree ? { worktreeRevisionKind: 'GIT_STATUS_FILE_METADATA' } : {}) }
  }

  private normalizeIgnoreRules(values: string[]): string[] {
    if (!Array.isArray(values) || values.length < 1 || values.length > 100) fail('INVALID_ARGUMENT')
    return [...new Set(values.map((value) => {
      if (typeof value !== 'string') fail('INVALID_ARGUMENT')
      const rule = value.trim().replace(/\\/g, '/')
      if (!rule || rule.length > 500 || rule.includes('\0') || /[\r\n]/.test(rule) || rule.startsWith('!')) fail('INVALID_ARGUMENT')
      const pathLike = rule.replace(/^\/+/, '').replace(/^\.\//, '')
      if (!pathLike || /^[A-Za-z]:/.test(pathLike) || pathLike.split('/').some((part) => part === '..' || part.toLowerCase() === '.git')) fail('INVALID_ARGUMENT')
      return rule
    }))]
  }

  private hygieneDescriptor(path: string): { classification: string; group: string; suggestedRule?: string } {
    const normalized = path.replace(/\\/g, '/')
    const parts = normalized.split('/')
    if (normalized.startsWith('.claude/skills/')) return { classification: 'GENERATED_PROJECTION', group: '.claude/skills', suggestedRule: '.claude/skills/' }
    if (/^\.code-awareness\/[^/]+-runtime\//.test(normalized)) {
      const group = parts.slice(0, 2).join('/')
      return { classification: 'GENERATED_RUNTIME', group, suggestedRule: group + '/' }
    }
    if (normalized.startsWith('.code-awareness/continuum/rollback-baseline/')) return { classification: 'GENERATED_VALIDATION', group: '.code-awareness/continuum/rollback-baseline', suggestedRule: '.code-awareness/continuum/rollback-baseline/' }
    if (/^\.code-awareness\/continuum\/[^/]*validation[^/]*\//.test(normalized)) {
      const group = parts.slice(0, 3).join('/')
      return { classification: 'GENERATED_VALIDATION', group, suggestedRule: group + '/' }
    }
    if (normalized.endsWith('.log')) return { classification: 'LOG', group: '*.log', suggestedRule: '*.log' }
    return { classification: 'UNCLASSIFIED', group: parts.length > 1 ? parts.slice(0, 2).join('/') : normalized }
  }

  private hygieneGroups(paths: string[]) {
    const groups = new Map<string, { classification: string; group: string; count: number; suggestedRule?: string }>()
    for (const path of paths) {
      const descriptor = this.hygieneDescriptor(path)
      const key = descriptor.classification + ':' + descriptor.group
      const existing = groups.get(key)
      if (existing) existing.count++
      else groups.set(key, { ...descriptor, count: 1 })
    }
    return [...groups.values()].sort((a, b) => b.count - a.count || a.group.localeCompare(b.group))
  }

  async analyzeHygiene() {
    await this.repository()
    const changes = await this.getChanges()
    const untracked = changes.filter((change) => change.untracked).map((change) => change.path)
    const groups = this.hygieneGroups(untracked)
    return {
      dirtyCount: changes.length,
      trackedDirtyCount: changes.filter((change) => !change.untracked).length,
      untrackedCount: untracked.length,
      groups,
      recommendedRules: [...new Set(groups.map((group) => group.suggestedRule).filter((rule): rule is string => !!rule))]
    }
  }

  private async previewGitignore(rules: string[]) {
    await this.repository()
    const normalizedRules = this.normalizeIgnoreRules(rules)
    const beforeRevision = await this.git.getWorktreeRevision(this.repoRoot)
    const gitignorePath = join(this.repoRoot, '.gitignore')
    const content = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : ''
    const present = new Set(content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')))
    const alreadyPresent = normalizedRules.filter((rule) => present.has(rule))
    const candidateRules = normalizedRules.filter((rule) => !present.has(rule))
    const before = (await this.getChanges('UNTRACKED')).map((change) => change.path.replace(/\\/g, '/'))
    const matcher = ignore().add(candidateRules)
    const newlyIgnored = candidateRules.length ? before.filter((path) => matcher.ignores(path)) : []
    const ignoredSet = new Set(newlyIgnored)
    const after = before.filter((path) => !ignoredSet.has(path))
    const afterRevision = await this.git.getWorktreeRevision(this.repoRoot)
    if (beforeRevision !== afterRevision) fail('GIT_STATE_CHANGED')
    const previewId = createHash('sha256').update(JSON.stringify({ worktreeRevision: beforeRevision, candidateRules, newlyIgnored })).digest('hex')
    return {
      rules: normalizedRules,
      candidateRules,
      alreadyPresent,
      newlyIgnoredCount: newlyIgnored.length,
      remainingUntrackedCount: after.length,
      affectedGroups: this.hygieneGroups(newlyIgnored),
      worktreeRevision: beforeRevision,
      previewId
    }
  }

  async manageGitignore(request: GitIgnoreRequest) {
    if (request.action === 'PREVIEW_ADD') return this.previewGitignore(request.rules)
    return this.serialized(async () => {
      await this.ready()
      if (typeof request.expectedWorktreeRevision !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedWorktreeRevision) || typeof request.expectedPreviewId !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedPreviewId)) fail('INVALID_ARGUMENT')
      const preview = await this.previewGitignore(request.rules)
      if (preview.worktreeRevision !== request.expectedWorktreeRevision || preview.previewId !== request.expectedPreviewId) fail('GIT_STATE_CHANGED')
      if (!preview.candidateRules.length) return { result: 'NO_CHANGES', addedRules: [], ...preview }
      if (await this.git.getWorktreeRevision(this.repoRoot) !== request.expectedWorktreeRevision) fail('GIT_STATE_CHANGED')
      const path = join(this.repoRoot, '.gitignore')
      const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
      const newline = current.includes('\r\n') ? '\r\n' : '\n'
      const separator = current.length && !current.endsWith('\n') && !current.endsWith('\r') ? newline : ''
      writeFileSync(path, current + separator + preview.candidateRules.join(newline) + newline, 'utf8')
      return this.observeMutation(async () => {
        const state = await this.getState()
        return { result: 'UPDATED', addedRules: preview.candidateRules, newlyIgnoredCount: preview.newlyIgnoredCount, remainingUntrackedCount: state.untrackedCount, worktreeRevision: state.worktreeRevision }
      })
    })
  }

  async getDiff(request: { paths: string[]; mode: 'WORKTREE' | 'STAGED' | 'BETWEEN_REFS'; base?: string; head?: string; cursor?: string }) {
    await this.repository()
    const paths = this.paths(request.paths, 20)
    if (!['WORKTREE', 'STAGED', 'BETWEEN_REFS'].includes(request.mode)) fail('INVALID_ARGUMENT')
    const base = request.mode === 'BETWEEN_REFS' ? await this.ref(request.base!) : undefined
    const head = request.mode === 'BETWEEN_REFS' ? await this.ref(request.head!) : undefined
    const patch = await this.git.getOperationsDiff(this.repoRoot, paths, request.mode, base, head)
    const revision = createHash('sha256').update(JSON.stringify({ paths, mode: request.mode, base, head, patch })).digest('hex')
    let offset = 0
    if (request.cursor) {
      const [expected, position] = request.cursor.split(':')
      if (expected !== revision) fail('GIT_STATE_CHANGED')
      offset = Number(position)
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > patch.length) fail('INVALID_ARGUMENT')
    }
    const end = Math.min(offset + 24000, patch.length)
    return { patch: patch.slice(offset, end), binary: /Binary files .* differ/.test(patch), truncated: end < patch.length, nextCursor: end < patch.length ? `${revision}:${end}` : null, revision }
  }

  async getHistory(request: { ref?: string; limit?: number; path?: string }) {
    await this.repository()
    const limit = request.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_ARGUMENT')
    const ref = await this.ref(request.ref ?? 'HEAD')
    const path = request.path ? this.paths([request.path])[0] : undefined
    return (await this.git.getOperationsHistory(this.repoRoot, ref, limit, path)).trimEnd().split('\n').filter(Boolean).map((line) => {
      const [sha, parents, author, timestamp, subject] = line.split('\0')
      return { sha, parents: parents.split(' ').filter(Boolean), author, timestamp, subject }
    })
  }

  async stage(request: { mode: 'STAGE' | 'UNSTAGE'; paths: string[]; expectedIndexRevision: string; expectedWorktreeRevision: string }) {
    return this.serialized(async () => {
      await this.repository()
      const paths = this.paths(request.paths)
      if (![request.expectedIndexRevision, request.expectedWorktreeRevision].every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) fail('INVALID_ARGUMENT')
      const expected = { indexRevision: request.expectedIndexRevision, worktreeRevision: request.expectedWorktreeRevision }
      try {
        if (request.mode === 'STAGE') await this.git.stagePaths(this.repoRoot, paths, expected)
        else if (request.mode === 'UNSTAGE') await this.git.unstagePaths(this.repoRoot, paths, expected)
        else fail('INVALID_ARGUMENT')
      } catch (error) {
        if (error instanceof Error && error.message === 'INDEX_MUTATION_FAILED') fail('INDEX_MUTATION_FAILED')
        throw error
      }
      return this.observeMutation(async () => {
        const state = await this.getState()
        return { paths, stagedCount: state.stagedCount, indexRevision: state.indexRevision }
      })
    })
  }

  async commit(request: { message: string; expectedHead: string | null; expectedIndexRevision: string }) {
    return this.serialized(async () => {
      await this.ready(true)
      await this.checkHead(request.expectedHead)
      if ((await this.getChanges('CONFLICTED')).length) fail('MERGE_CONFLICT')
      if (typeof request.message !== 'string' || !request.message.trim() || request.message.length > 10000 || request.message.includes('\0')) fail('INVALID_ARGUMENT')
      const sha = await this.git.commitInspectedIndex(this.repoRoot, request.message, request.expectedHead, request.expectedIndexRevision)
      return this.observeMutation(async () => ({ sha, parent: request.expectedHead, branch: await this.git.getCurrentBranch(this.repoRoot), message: request.message, paths: await this.git.getCommittedPaths(this.repoRoot, sha) }))
    })
  }

  async manageBranch(request: BranchRequest) {
    return this.serialized(async () => {
      await this.repository()
      if (request.action === 'LIST') return (await this.git.listBranches(this.repoRoot)).trimEnd().split('\n').filter(Boolean).map((line) => {
        const [branch, head, current] = line.split('\0'); return { branch, head, current: current === '*' }
      })
      await this.ready()
      const branch = await this.branch(request.branch)
      if (request.action === 'RENAME' || request.action === 'DELETE') {
        const fields = (await this.git.listWorktreeRecords(this.repoRoot)).split('\0\0').filter(Boolean)
        if (fields.some(group => {
          const parts = group.split('\0')
          const path = parts.find(value => value.startsWith('worktree '))?.slice(9)
          const sameRoot = path && (process.platform === 'win32' ? resolve(path).toLowerCase() === resolve(this.repoRoot).toLowerCase() : resolve(path) === resolve(this.repoRoot))
          return !sameRoot && parts.includes('branch refs/heads/' + branch)
        })) fail('WORKTREE_BRANCH_OCCUPIED')
      }
      if (request.action === 'CREATE') {
        await this.checkHead(request.expectedHead)
        await this.git.createBranch(this.repoRoot, branch, await this.ref(request.startPoint ?? 'HEAD'))
      } else if (request.action === 'SWITCH') await this.git.switchBranch(this.repoRoot, branch)
      else if (request.action === 'DELETE') await this.git.deleteBranch(this.repoRoot, branch)
      else if (request.action === 'RENAME') await this.git.renameBranch(this.repoRoot, branch, await this.branch(request.newBranch))
      else if (request.action === 'SET_UPSTREAM') {
        if (branch !== await this.git.getCurrentBranch(this.repoRoot)) fail('GIT_STATE_CHANGED')
        await this.checkHead(request.expectedHead)
        const remote = request.remote
        if (typeof remote !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote) || !await this.git.getRemoteUrl(this.repoRoot, remote)) fail('REMOTE_NOT_FOUND')
        const remoteBranch = await this.branch(request.remoteBranch)
        try { await this.git.resolveCommit(this.repoRoot, `refs/remotes/${remote}/${remoteBranch}`) }
        catch { fail('BRANCH_NOT_FOUND') }
        await this.git.setBranchUpstream(this.repoRoot, branch, remote, remoteBranch, request.expectedHead)
      }
      else fail('INVALID_ARGUMENT')
      return this.observeMutation(() => this.getState())
    })
  }

  async merge(request: MergeRequest) {
    return this.serialized(async () => {
      await this.repository()
      if (request.action === 'ABORT') {
        if (await this.git.getGitOperation(this.repoRoot) !== 'MERGE') fail('GIT_OPERATION_NOT_IN_PROGRESS')
        await this.git.abortMerge(this.repoRoot)
        return this.observeMutation(async () => ({ result: 'ABORTED', ...await this.getState() }))
      }
      await this.ready(); await this.checkHead(request.expectedHead)
      const source = await this.ref(request.source)
      const mode = request.mode ?? 'FF_ONLY'
      if (!['FF_ONLY', 'MERGE'].includes(mode)) fail('INVALID_ARGUMENT')
      if ((await this.getChanges()).length) fail('DIRTY_WORKTREE')
      try { await this.git.mergeBranch(this.repoRoot, source, mode) }
      catch (error) {
        const conflicts = await this.getChanges('CONFLICTED')
        if (conflicts.length) return { result: 'CONFLICTS', paths: conflicts.map((c) => c.path) }
        throw error
      }
      return this.observeMutation(async () => {
        const head = await this.git.getCurrentCommitHash(this.repoRoot)
        return { result: head === request.expectedHead ? 'ALREADY_UP_TO_DATE' : head === source ? 'FAST_FORWARDED' : 'MERGED', head }
      })
    })
  }

  async sync(request: SyncRequest) {
    return this.serialized(async () => {
      await this.ready()
      const remote = request.remote ?? 'origin'
      if (typeof remote !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) fail('REMOTE_NOT_FOUND')
      if (!await this.git.getRemoteUrl(this.repoRoot, remote)) fail('REMOTE_NOT_FOUND')
      if (request.action === 'FETCH') {
        if (this.transport.fetch) await this.transport.fetch(this.repoRoot, remote)
        else await this.git.fetchRemote(this.repoRoot, remote)
        return { remote, result: 'FETCHED' }
      }
      await this.checkHead(request.expectedHead)
      const branch = await this.branch(request.branch ?? await this.git.getCurrentBranch(this.repoRoot) ?? '')
      if (request.action === 'PUSH') {
        if (await this.ref(branch) !== request.expectedHead) fail('GIT_STATE_CHANGED')
        await this.transport.push(this.repoRoot, branch, remote, request.expectedHead ?? undefined)
        return { remote, branch, pushedHead: request.expectedHead }
      }
      if (request.action !== 'PULL_FF_ONLY') fail('INVALID_ARGUMENT')
      if (branch !== await this.git.getCurrentBranch(this.repoRoot)) fail('INVALID_REF')
      if ((await this.getChanges()).length) fail('DIRTY_WORKTREE')
      if (this.transport.pullFastForward) await this.transport.pullFastForward(this.repoRoot, remote, branch)
      else await this.git.pullFastForward(this.repoRoot, remote, branch)
      return this.observeMutation(async () => ({ remote, branch, head: await this.git.getCurrentCommitHash(this.repoRoot) }))
    })
  }

  private async observeCompletedShelf<T>(observe: () => Promise<T>) {
    try { return await observe() }
    catch (error) {
      return { worktreeRevision: null, observation: { status: 'UNAVAILABLE' as const, code: this.normalizeError(error).code } }
    }
  }

  async manageShelf(request: ShelfRequest) {
    return this.serialized(async () => {
      await this.repository()
      if (request.action === 'LIST') return (await this.git.listShelves(this.repoRoot)).map((shelf) => ({ shelfId: shelf.shelfId, label: shelf.label, date: shelf.date, baseHead: shelf.baseHead, pathCount: shelf.files.length }))
      if (request.action === 'DROP') {
        await this.git.dropShelf(this.repoRoot, request.shelfId)
        return { shelfId: request.shelfId, result: 'DROPPED' }
      }
      await this.ready()
      if ((await this.getChanges('CONFLICTED')).length) fail('GIT_OPERATION_IN_PROGRESS')
      if (await this.git.getWorktreeRevision(this.repoRoot) !== request.expectedWorktreeRevision) fail('GIT_STATE_CHANGED')
      if (request.action === 'RESTORE') {
        await this.checkHead(request.expectedHead)
        const shelf = await this.git.readShelf(this.repoRoot, request.shelfId)
        for (const file of shelf.files) this.paths([file.path])
        const result = await this.git.restoreShelf(this.repoRoot, shelf, request.expectedHead, request.expectedWorktreeRevision)
        return { shelfId: shelf.shelfId, result, ...await this.observeCompletedShelf(() => this.getState()) }
      }
      const selected = this.paths(request.paths)
      if (request.label !== undefined && (typeof request.label !== 'string' || request.label.length > 200 || request.label.includes('\0'))) fail('INVALID_ARGUMENT')
      const includes = (path: string) => selected.some((selectedPath) => path === selectedPath || path.startsWith(`${selectedPath}/`))
      const changes = (await this.getChanges()).filter((change) => includes(change.path) || !!change.previousPath && includes(change.previousPath))
      if (!changes.length) fail('NOTHING_TO_SHELVE')
      if (changes.some((change) => change.previousPath && (!includes(change.path) || !includes(change.previousPath)))) fail('INVALID_ARGUMENT')
      const paths = this.paths(changes.flatMap((change) => change.previousPath ? [change.path, change.previousPath] : [change.path]), 100000)
      const shelf = await this.git.createShelf(this.repoRoot, paths, changes.filter((change) => change.untracked).map((change) => change.path), request.expectedWorktreeRevision, request.label ?? '')
      return { shelfId: shelf.shelfId, pathCount: paths.length, baseHead: shelf.baseHead,
        ...await this.observeCompletedShelf(async () => ({ worktreeRevision: await this.git.getWorktreeRevision(this.repoRoot) })) }
    })
  }

  async getConflict(request: { path: string; side?: ConflictSide; cursor?: string }) {
    await this.repository()
    const path = this.paths([request.path])[0]
    const entries = await this.git.getConflictEntries(this.repoRoot, path)
    if (!entries.length) fail('CONFLICT_NOT_FOUND')
    const conflictRevision = await this.git.getConflictRevision(this.repoRoot, path)
    const sides: Array<{ side: ConflictSide; available: boolean; classification: 'TEXT' | 'BINARY' | null }> = []
    for (const side of ['BASE', 'OURS', 'THEIRS', 'WORKTREE'] as const) {
      const bytes = await this.git.readConflictSide(this.repoRoot, path, side, entries)
      sides.push({ side, available: bytes !== null, classification: bytes === null ? null : isBinary(bytes) ? 'BINARY' : 'TEXT' })
    }
    if (await this.git.getConflictRevision(this.repoRoot, path) !== conflictRevision) fail('CONFLICT_STATE_CHANGED')
    const status = (await this.getChanges('CONFLICTED')).find((change) => change.path === path)
    if (!request.side) return { path, kind: `${status?.stagedState ?? ''}${status?.unstagedState ?? ''}`, sides, conflictRevision }
    const side = sides.find((entry) => entry.side === request.side)
    if (!side) fail('INVALID_ARGUMENT')
    if (!side.available) fail('CONFLICT_SIDE_UNAVAILABLE')
    const bytes = await this.git.readConflictSide(this.repoRoot, path, request.side, entries)
    if (await this.git.getConflictRevision(this.repoRoot, path) !== conflictRevision) fail('CONFLICT_STATE_CHANGED')
    if (side.classification === 'BINARY') return { path, side: request.side, classification: 'BINARY', conflictRevision, content: null, truncated: false, nextCursor: null }
    const content = bytes!.toString('utf8')
    const cursorRevision = createHash('sha256').update(JSON.stringify({ path, side: request.side, conflictRevision })).digest('hex')
    let offset = 0
    if (request.cursor) {
      const [revision, position] = request.cursor.split(':')
      if (revision !== cursorRevision) fail('CONFLICT_STATE_CHANGED')
      offset = Number(position)
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.length) fail('INVALID_ARGUMENT')
    }
    let end = Math.min(offset + 24000, content.length)
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--
    return { path, side: request.side, classification: 'TEXT', conflictRevision, content: content.slice(offset, end), truncated: end < content.length, nextCursor: end < content.length ? `${cursorRevision}:${end}` : null }
  }

  async resolveConflict(request: { path: string; resolution: ConflictResolution; expectedHead: string | null; expectedConflictRevision: string; content?: string }) {
    return this.serialized(async () => {
      await this.repository()
      const path = this.paths([request.path])[0]
      await this.checkHead(request.expectedHead)
      const operation = await this.git.getGitOperation(this.repoRoot)
      if (operation && !['MERGE', 'REVERT'].includes(operation)) fail('GIT_OPERATION_IN_PROGRESS')
      const revision = await this.git.getConflictRevision(this.repoRoot, path)
      if (!revision) fail('CONFLICT_NOT_FOUND')
      if (revision !== request.expectedConflictRevision) fail('CONFLICT_STATE_CHANGED')
      if (!['OURS', 'THEIRS', 'CONTENT', 'DELETE'].includes(request.resolution)) fail('INVALID_ARGUMENT')
      if (request.resolution === 'CONTENT') {
        if (typeof request.content !== 'string' || Buffer.byteLength(request.content, 'utf8') > 1024 * 1024 || request.content.includes('\0')) fail('INVALID_ARGUMENT')
        if (Buffer.from(request.content, 'utf8').toString('utf8') !== request.content) fail('INVALID_ARGUMENT')
        const metadata = await this.getConflict({ path })
        if ('sides' in metadata && metadata.sides!.some((side) => side.classification === 'BINARY')) fail('BINARY_CONFLICT_CONTENT_UNSUPPORTED')
      } else if (request.content !== undefined) fail('INVALID_ARGUMENT')
      await this.git.resolveConflict(this.repoRoot, path, request.resolution, request.expectedHead, request.expectedConflictRevision, request.content)
      return this.observeMutation(async () => ({ path, resolution: request.resolution, remainingConflictCount: (await this.getChanges('CONFLICTED')).length, indexRevision: await this.git.getIndexRevision(this.repoRoot) }))
    })
  }

  async revert(request: RevertRequest) {
    return this.serialized(async () => {
      if (request.action === 'CONTINUE' || request.action === 'ABORT') {
        await this.repository(); await this.checkHead(request.expectedHead)
        if (await this.git.getGitOperation(this.repoRoot) !== 'REVERT') fail('GIT_OPERATION_NOT_IN_PROGRESS')
        if (request.action === 'ABORT') {
          await this.git.abortRevert(this.repoRoot)
          return this.observeMutation(async () => ({ result: 'ABORTED', head: await this.git.getCurrentCommitHash(this.repoRoot) }))
        }
        if ((await this.getChanges('CONFLICTED')).length) fail('MERGE_CONFLICT')
        if (await this.git.getIndexRevision(this.repoRoot) !== request.expectedIndexRevision) fail('GIT_STATE_CHANGED')
        await this.git.continueRevert(this.repoRoot, request.expectedHead, request.expectedIndexRevision)
        return this.observeMutation(async () => ({ result: 'REVERTED', head: await this.git.getCurrentCommitHash(this.repoRoot) }))
      }
      await this.ready(); await this.checkHead(request.expectedHead)
      if ((await this.getChanges()).length) fail('DIRTY_WORKTREE')
      if (typeof request.commit !== 'string' || !/^[a-f0-9]{40,64}$/.test(request.commit)) fail('INVALID_REF')
      const commit = await this.ref(request.commit)
      try { await this.git.revertCommit(this.repoRoot, commit) }
      catch (error) {
        const conflicts = await this.getChanges('CONFLICTED')
        if (conflicts.length) return { result: 'CONFLICTS', paths: conflicts.map((c) => c.path) }
        throw error
      }
      return this.observeMutation(async () => ({ result: 'REVERTED', head: await this.git.getCurrentCommitHash(this.repoRoot) }))
    })
  }
}
