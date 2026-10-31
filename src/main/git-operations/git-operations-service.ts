import { readWorktreeProvenance } from './git-worktree-provenance'
import { GitAtlasReader } from './git-atlas'
import type { GitAtlasQuery } from '../../shared/types/git-atlas-types'
import type { GitAtlasCoreEvidence, GitAtlasEvidenceQuery, GitAtlasPrEvidence } from '../../shared/types/git-atlas-evidence-types'
import type { BranchInventory } from '../../shared/types/branch-orchestration-types'
import type { BranchPullRequests } from '../../shared/types/branch-pull-request-types'
import { AtlasCache, type AtlasPersistence } from './git-atlas-cache'
import { GitBranchInventory, recordBranchCreation } from './git-branch-inventory'
import { GitBranchDiscard } from './git-branch-discard'
import type { BranchDiscardExecute, BranchDiscardRemoteReader } from '../../shared/types/branch-discard-types'
import { randomUUID } from 'node:crypto'
import type { WorktreeRemovalExecute, WorktreeRemovalPreview } from '../../shared/types/worktree-removal-types'
import type { BranchHistoryQuery } from '../../shared/types/branch-orchestration-types'
import { createHash } from 'node:crypto'
import { summarizeLocalChanges } from './local-change-summary'
import type { RemoteEvidence } from '../../shared/types/git-evidence-types'
import ignore from 'ignore'
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { GitService, GitWorktreeReadSnapshot } from '../core/git-service'
import type { GitRemoteTransport } from '../core/git-remote-transport'
import { GitOperationReceipts, type LegacyGitReceiptResult } from './git-operation-receipts'
import type { McpToolResult } from '../mcp/channel-mcp-adapter'
import { GitWorktreeRegistry, type WorktreeIdentity, type WorktreeRecord } from './git-worktree-registry'
import type { CoordinationHistory } from './git-coordination-evidence'
import { GitCommitCorrelation } from './git-commit-correlation'
import type { GitWorktreeCommitsQuery, GitCommitWorktreesQuery } from '../../shared/types/git-commit-correlation-types'
import { assertNoWorktreeGrant, GitWorktreeOwnership, ownershipDigest, withWorktreeTransaction, type WorktreeApprovalPort, type WorktreeIntent, type WorktreeObservation, type WorktreeScope, type WorktreeSnapshot } from './git-worktree-ownership'
import { GitWorktreeLifecycle } from './git-worktree-lifecycle'
import { GitWorktreeIntegration, type WorktreeIntegrationPreview } from './git-worktree-integration'
import type { CapturedText, WorktreeStructureCapture, WorktreeStructureRequest } from './git-worktree-capture'
import type { GitDecoration, GitHistoryPage, GitCommitDetail, GitCommitFile, GitPatch, GitOperationalResult, GitMutationRequest, GitCheckoutSynchronization, GitManagementState } from '../../shared/types/git-management-types'

function sameCheckoutSnapshot(left: GitManagementState, right: GitManagementState) {
  return left.head === right.head && left.branch === right.branch && left.upstream === right.upstream &&
    left.indexRevision === right.indexRevision && left.worktreeRevision === right.worktreeRevision && left.operation === right.operation
}

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
  inspectIntegrationProof?(id: string, commit: string, profileId: string, proofId: string): Promise<import('../../shared/types/worktree-integration-evidence-types').IntegrationEvidence['proofs'][number]>
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
  private readonly removalPreviews = new Map<string, WorktreeRemovalPreview>()
  async prepareWorktreeRemoval(worktreeId: string, generation: string): Promise<WorktreeRemovalPreview> {
    const inventory = await this.getBranchInventory()
    const record = inventory.worktrees.find(w => w.worktreeId === worktreeId && w.generation === generation)
    if (!record || !this.worktrees) fail('WORKTREE_STALE')
    const blockers: string[] = []
    if (this.worktrees.isReference(worktreeId) || resolve(record.path) === resolve(this.repoRoot)) blockers.push('WORKTREE_PRIMARY_OR_ACTIVE')
    if (record.locked) blockers.push('WORKTREE_LOCKED')
    if (record.missing || record.prunable) blockers.push('WORKTREE_STALE')
    if (!record.branch || !record.head) blockers.push('WORKTREE_PRESERVATION_REQUIRED')
    let stagedCount: number | null = null, unstagedCount: number | null = null, untrackedCount: number | null = null, ignoredCount: number | null = null, snapshotRevision = 'UNAVAILABLE'
    try {
      await this.git.assertWorktreeRemovalSafe(record.path)
      const selected = await this.selectWorktree(worktreeId), state = await selected.service.getState()
      stagedCount = state.stagedCount; unstagedCount = state.unstagedCount; untrackedCount = state.untrackedCount
      ignoredCount = await this.git.countIgnoredWorktreeFiles(record.path)
      snapshotRevision = ownershipDigest([this.snapshot(state), await this.git.getWorktreeRevision(record.path), ignoredCount])
      if (state.operation) blockers.push('GIT_OPERATION_IN_PROGRESS')
      if (state.stagedCount || state.unstagedCount || state.untrackedCount || state.conflictCount) blockers.push('DIRTY_WORKTREE')
      if (ignoredCount) blockers.push('WORKTREE_IGNORED_CONTENT')
      const common = realpathSync(await this.git.getCommonDirectory(record.path))
      assertNoWorktreeGrant(common, record.path)
      if (await this.worktreeValidation?.busy(worktreeId)) blockers.push('WORKTREE_VALIDATION_BUSY')
    } catch (error) { blockers.push(error instanceof Error ? error.message : 'WORKTREE_OBSERVATION_UNAVAILABLE') }
    const preservation = record.branch ? inventory.branches.find(b => b.namespace === 'LOCAL' && b.name === record.branch && b.head === record.head) : null
    if (!preservation) blockers.push('WORKTREE_PRESERVATION_REQUIRED')
    if ((await this.getBranchInventory()).revision !== inventory.revision) fail('GIT_STATE_CHANGED')
    const preview: WorktreeRemovalPreview = { previewId: randomUUID(), repositoryId: inventory.repositoryId, worktree: record, inventoryRevision: inventory.revision, snapshotRevision,
      preservationRef: preservation?.ref ?? null, preservationHead: preservation?.head ?? null, stagedCount, unstagedCount, untrackedCount, ignoredCount, blockers: [...new Set(blockers)], expiresAt: new Date(Date.now() + 300000).toISOString() }
    for (const [id, prior] of this.removalPreviews) if (Date.parse(prior.expiresAt) < Date.now()) this.removalPreviews.delete(id)
    if (this.removalPreviews.size >= 100) this.removalPreviews.delete(this.removalPreviews.keys().next().value!)
    this.removalPreviews.set(preview.previewId, preview)
    return preview
  }
  executeWorktreeRemoval(request: WorktreeRemovalExecute, confirmRelease: (preview: WorktreeRemovalPreview) => Promise<boolean>, guard: () => void) {
    return this.serialized(() => new GitOperationReceipts(this.repoRoot, this.git).executeResult(request.operationId, 'remove_worktree_assisted', { ...request }, async () => {
      try {
        const before = this.removalPreviews.get(request.previewId)
        if (!before || Date.parse(before.expiresAt) < Date.now()) throw new Error('WORKTREE_PREVIEW_STALE')
        if (request.releasedByUser !== true || !await confirmRelease(before)) throw new Error('WORKTREE_RELEASE_NOT_CONFIRMED')
        guard()
        const current = await this.prepareWorktreeRemoval(before.worktree.worktreeId, before.worktree.generation)
        this.removalPreviews.delete(current.previewId)
        if (current.inventoryRevision !== before.inventoryRevision || current.snapshotRevision !== before.snapshotRevision) throw new Error('GIT_STATE_CHANGED')
        if (current.blockers.length) throw new Error(current.blockers[0])
        guard()
        await this.git.assertWorktreeRemovalSafe(before.worktree.path)
        const lifecycle = new GitWorktreeLifecycle(realpathSync(await this.git.getCommonDirectory(this.repoRoot)))
        const managed = lifecycle.get(before.worktree)
        await this.git.removeWorktree(this.repoRoot, before.worktree.path)
        if (managed) lifecycle.save({ ...managed, closedAt: new Date().toISOString() })
        this.removalPreviews.delete(before.previewId)
        return { value: { result: 'WORKTREE_REMOVED', repositoryId: before.repositoryId, worktreeId: before.worktree.worktreeId, preservationRef: before.preservationRef, preservationHead: before.preservationHead } }
      } catch (error) { return { value: { code: error instanceof Error ? error.message : 'WORKTREE_REMOVAL_FAILED' }, isError: true } }
    }))
  }
  private branchDiscard: GitBranchDiscard | undefined
  private discardService() { return this.branchDiscard ??= new GitBranchDiscard(this.repoRoot, this.git, this.branchReader(), id => this.getCoordinationSnapshot(id)) }
  prepareBranchDiscard(ref: string, revision: string, baseRef: string, remote: BranchDiscardRemoteReader) {
    return this.discardService().prepare(ref, revision, baseRef, remote)
  }
  executeBranchDiscard(request: BranchDiscardExecute, remote: BranchDiscardRemoteReader, guard: () => void) {
    return this.serialized(() => new GitOperationReceipts(this.repoRoot, this.git).executeResult(request.operationId, 'discard_git_branch', { ...request }, async () => {
      try { return { value: await this.discardService().execute(request, remote, guard) } }
      catch (error) { return { value: { code: error instanceof Error ? error.message : 'BRANCH_DISCARD_FAILED' }, isError: true } }
    }))
  }
  private branchReader(): GitBranchInventory {
    if (!this.worktrees || !this.coordinationIdentity) fail('WORKTREE_IDENTITY_UNAVAILABLE')
    return new GitBranchInventory(this.repoRoot, this.git, this.worktrees, this.coordinationIdentity)
  }
  getBranchInventory() { return this.branchReader().inventory() }
  getBranchCommits(query: BranchHistoryQuery) { return this.branchReader().history(query) }
  async executeReceipted(operationId: string, name: string, args: Record<string, unknown>, mutate: () => Promise<LegacyGitReceiptResult>): Promise<LegacyGitReceiptResult> {
    if (this.readOnlyWorktree) fail('WORKTREE_OWNERSHIP_REQUIRED')
    const result = await new GitOperationReceipts(this.repoRoot, this.git).execute(operationId, name, args, mutate)
    const changesTopology = ['commit_git_changes', 'manage_git_branch', 'merge_git_branch', 'revert_git_commit', 'integrate_worktree', 'manage_worktree'].includes(name)
      || name === 'sync_git_remote' && args.action !== 'PUSH'
      || name === 'mutate_worktree' && ['COMMIT', 'CREATE_BRANCH'].includes(String(args.action))
    if (!result.isError && changesTopology) this.atlasReader?.invalidate()
    return result
  }
  async executeManagementMutation(request: GitMutationRequest, assertCurrent: () => void): Promise<GitOperationalResult> {
    const { operation, snapshot, operationId } = request
    if (this.automaticFetchRequest && this.automaticFetchRequest.operationId !== operationId) return { value: { code: 'GIT_OPERATION_IN_PROGRESS' }, isError: true }
    let name: string, args: Record<string, unknown>
    if (operation.action === 'STAGE' || operation.action === 'UNSTAGE') {
      name = 'stage_git_changes'; args = { mode: operation.action, paths: operation.paths, expectedIndexRevision: snapshot.indexRevision, expectedWorktreeRevision: snapshot.worktreeRevision }
    } else if (operation.action === 'COMMIT') {
      name = 'commit_git_changes'; args = { message: operation.message, expectedHead: snapshot.head, expectedIndexRevision: snapshot.indexRevision }
    } else if (operation.action === 'CREATE' || operation.action === 'SWITCH') {
      name = 'manage_git_branch'; args = { action: operation.action, branch: operation.branch, ...(operation.action === 'CREATE' ? { expectedHead: snapshot.head } : {}) }
    } else {
      name = 'sync_git_remote'; args = { action: operation.action, ...(operation.action === 'FETCH' ? {} : { expectedHead: snapshot.head }) }
      if ('contextual' in operation && operation.contextual) Object.assign(args, { contextual: true, upstream: snapshot.upstream, remoteEvidence: snapshot.remoteEvidence })
    }
    const guard = async () => {
      assertCurrent()
      const current = await this.getState()
      if (!sameCheckoutSnapshot(current, snapshot)) fail('GIT_STATE_CHANGED')
      if ('contextual' in operation && operation.contextual) {
        const synchronization = await this.getCheckoutSynchronization()
        const observed = snapshot.remoteEvidence, fresh = synchronization.evidence
        if (!sameCheckoutSnapshot(synchronization.state, snapshot) || synchronization.action !== operation.action || observed?.status !== 'VERIFIED' || fresh.status !== 'VERIFIED' ||
          observed.localHead !== fresh.localHead || observed.remoteHead !== fresh.remoteHead || observed.remote !== fresh.remote || observed.ref !== fresh.ref) fail('GIT_STATE_CHANGED')
      }
      assertCurrent()
    }
    try {
      if (this.readOnlyWorktree) fail('WORKTREE_OWNERSHIP_REQUIRED')
      return await new GitOperationReceipts(this.repoRoot, this.git).executeResult(operationId, name, args, async () => {
        try {
          let value: unknown
          if (operation.action === 'STAGE' || operation.action === 'UNSTAGE') value = await this.stage(args as Parameters<GitOperationsService['stage']>[0], guard)
          else if (operation.action === 'COMMIT') value = await this.commit(args as Parameters<GitOperationsService['commit']>[0], guard)
          else if (operation.action === 'CREATE' || operation.action === 'SWITCH') value = await this.manageBranch(args as BranchRequest, guard)
          else value = await this.sync(args as SyncRequest, guard)
          if (!['STAGE', 'UNSTAGE', 'PUSH'].includes(operation.action)) this.atlasReader?.invalidate()
          return { value: value as Record<string, unknown> }
        } catch (error) {
          const code = error instanceof GitOperationsError ? error.code : this.normalizeError(error).code
          return { value: { code, ...(['GIT_STATE_CHANGED', 'CONFLICT_STATE_CHANGED'].includes(code) ? { retryability: 'AFTER_STATE_REFRESH', recommendedAction: 'REFRESH_STATE' } : {}) }, isError: true }
        }
      })
    } catch (error) {
      const code = error instanceof Error && ['RECEIPT_BUSY', 'RECEIPT_CAPACITY_EXCEEDED'].includes(error.message) ? error.message : 'RECEIPT_UNAVAILABLE'
      return { value: { code, operationId, retryability: 'SAME_OPERATION_ID', retryAfterMs: 2000, recommendedAction: 'RECOVER_SAME_OPERATION' }, isError: true }
    }
  }
  private pending: Promise<unknown> = Promise.resolve()
  readonly worktrees: GitWorktreeRegistry | undefined
  readonly ownership: GitWorktreeOwnership | undefined
  private readonly worktreeRepositoryId: string | undefined
  private readonly coordinationIdentity: WorktreeIdentity | undefined
  private commitCorrelation: GitCommitCorrelation | undefined
  private pendingCorrelation: Promise<unknown> = Promise.resolve()
  constructor(private readonly repoRoot: string, private readonly git: GitService, private readonly transport: GitRemoteTransport, identity?: WorktreeIdentity, private readonly readOnlyWorktree = false, approval?: WorktreeApprovalPort, private readonly transactionAlreadyHeld = false, private readonly worktreeValidation?: WorktreeValidationPort) {
    this.worktreeRepositoryId = identity?.repositoryId
    this.coordinationIdentity = identity
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
              const createdAt = new Date().toISOString()
              await this.git.createAndSwitchBranch(selected.record.path, branch)
              await recordBranchCreation(selected.record.path, this.git, `refs/heads/${branch}`, createdAt)
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
        const createdAt = new Date().toISOString()
        await this.git.createWorktree(this.repoRoot, destination, request.branch, startPoint)
        await recordBranchCreation(this.repoRoot, this.git, `refs/heads/${request.branch}`, createdAt)
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

  async evaluateWorktreeIntegration(input: import('../../shared/types/worktree-integration-evidence-types').IntegrationEvidenceRequest): Promise<import('../../shared/types/worktree-integration-evidence-types').IntegrationEvidence> {
    const request = JSON.parse(JSON.stringify(input)) as typeof input
    if (!request || Object.keys(request).some(key => !['worktreeId', 'generation', 'targetBranch', 'candidate'].includes(key)) ||
      !/^[a-f0-9]{64}$/.test(request.worktreeId) || typeof request.generation !== 'string' || !request.generation || typeof request.targetBranch !== 'string' || !request.targetBranch) fail('INVALID_ARGUMENT')
    const candidate = request.candidate
    if (candidate && (Object.keys(candidate).some(key => !['worktreeId', 'generation', 'head', 'sourceHead', 'targetHead', 'requirements'].includes(key)) ||
      !/^[a-f0-9]{64}$/.test(candidate.worktreeId) || typeof candidate.generation !== 'string' || !candidate.generation ||
      ![candidate.head, candidate.sourceHead, candidate.targetHead].every(value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) ||
      !Array.isArray(candidate.requirements) || candidate.requirements.length > 10 || candidate.requirements.some(r => !r || Object.keys(r).some(k => !['profileId', 'proofIds'].includes(k)) ||
        typeof r.profileId !== 'string' || !r.profileId || r.profileId.length > 256 || !Array.isArray(r.proofIds) || r.proofIds.length > 20 || r.proofIds.some(p => typeof p !== 'string' || !p || p.length > 256)) || candidate.requirements.reduce((count, r) => count + r.proofIds.length, 0) > 20)) fail('INVALID_ARGUMENT')
    const capture = async () => {
      if (!this.coordinationIdentity?.isActive()) fail('WORKTREE_REPOSITORY_CHANGED')
      const records = await this.worktrees!.discover({ reuseValidatedDirectories: true })
      const selected = await this.selectWorktree(request.worktreeId, { revalidateSelection: true })
      if (selected.record.generation !== request.generation) fail('WORKTREE_STALE')
      const snapshot = this.snapshot(await selected.service.getState())
      const branch = await selected.service.branch(request.targetBranch)
      const head = await this.git.resolveCommit(this.repoRoot, `refs/heads/${branch}`, { noLazyFetch: true })
      const target = records.worktrees.find(r => r.branch === branch)
      const targetSnapshot = target ? this.snapshot(await (await this.selectWorktree(target.worktreeId, { revalidateSelection: true })).service.getState()) : null
      if (targetSnapshot && targetSnapshot.head !== head) fail('GIT_STATE_CHANGED')
      const prepared = candidate ? await this.selectWorktree(candidate.worktreeId, { revalidateSelection: true }) : null
      const preparedSnapshot = prepared ? this.snapshot(await prepared.service.getState()) : null
      const changes = await selected.service.getChanges()
      const targetChanges = target ? await (await this.selectWorktree(target.worktreeId, { revalidateSelection: true })).service.getChanges() : []
      const candidateChanges = prepared ? await prepared.service.getChanges() : []
      return { record: selected.record, snapshot, branch, head, target, targetSnapshot, changes, targetChanges, prepared: prepared?.record ?? null, preparedSnapshot, candidateChanges,
        topology: await this.git.getCommitTopologyRevision(this.repoRoot) }
    }
    const before = await capture(), blockers: string[] = [], missing: string[] = []
    if (!before.snapshot.head) blockers.push('SOURCE_HEAD_UNAVAILABLE')
    if (before.snapshot.operation) blockers.push('SOURCE_GIT_OPERATION_IN_PROGRESS')
    if (before.changes.length) blockers.push('SOURCE_DIRTY')
    if (before.target) blockers.push('TARGET_OWNERSHIP_REQUIRED')
    if (before.targetSnapshot?.operation) blockers.push('TARGET_GIT_OPERATION_IN_PROGRESS')
    if (before.targetChanges.length) blockers.push('TARGET_DIRTY')
    let mergeBase: string | null = null
    if (before.snapshot.head) { try { mergeBase = await this.git.mergeBase(this.repoRoot, before.snapshot.head, before.head, true) } catch { missing.push('MERGE_BASE_UNAVAILABLE') } }
    const ff = !!before.snapshot.head && await this.git.isCommitReachable(this.repoRoot, before.head, before.snapshot.head)
    const commits = before.snapshot.head ? await this.git.getReachableCommitPage(this.repoRoot, before.snapshot.head, before.head, 0, 21) : []
    const inspectProofs = async () => {
      const proofs: import('../../shared/types/worktree-integration-evidence-types').IntegrationEvidence['proofs'] = []
      if (candidate) for (const requirement of candidate.requirements) for (const proofId of requirement.proofIds) {
        proofs.push(this.worktreeValidation?.inspectIntegrationProof ? await this.worktreeValidation.inspectIntegrationProof(candidate.worktreeId, candidate.head, requirement.profileId, proofId) :
          { proofId, profileId: requirement.profileId, freshness: 'UNVERIFIABLE', status: 'UNAVAILABLE' })
      }
      return proofs
    }
    const proofs = await inspectProofs()
    let candidateVerified = false, stale = false
    if (candidate) {
      stale = candidate.sourceHead !== before.snapshot.head || candidate.targetHead !== before.head || candidate.generation !== before.prepared?.generation || candidate.head !== before.preparedSnapshot?.head
      if (!stale && !before.preparedSnapshot?.operation && !before.candidateChanges.length && before.snapshot.head) candidateVerified =
        await this.git.isCommitReachable(this.repoRoot, before.snapshot.head, candidate.head) && await this.git.isCommitReachable(this.repoRoot, before.head, candidate.head)
      if (!candidateVerified) missing.push('INTEGRATED_CANDIDATE_NOT_VERIFIED')
    } else missing.push('INTEGRATED_CANDIDATE_NOT_PREPARED')
    const requirements = candidate?.requirements ?? []
    if (!requirements.length) missing.push('VALIDATION_REQUIREMENTS_NOT_DEFINED')
    if (requirements.some(r => !r.proofIds.length || r.proofIds.some(id => !proofs.some(p => p.proofId === id && p.profileId === r.profileId && p.freshness === 'CURRENT' && p.status === 'PASSED')))) missing.push('CURRENT_CANDIDATE_VALIDATION_REQUIRED')
    if (!ff && !candidateVerified) missing.push('MERGE_COMPATIBILITY_NOT_VERIFIED')
    const after = await capture(), finalProofs = await inspectProofs()
    if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(proofs) !== JSON.stringify(finalProofs) || !this.coordinationIdentity?.isActive()) stale = true
    const state = stale ? 'STALE' : blockers.length ? 'BLOCKED' : missing.length ? 'EVIDENCE_PENDING' : 'ELIGIBLE_FOR_REVIEW'
    return { repositoryId: this.worktreeRepositoryId!, revision: createHash('sha256').update(JSON.stringify([before, candidate, proofs])).digest('hex'), observedAt: new Date().toISOString(), state,
      source: { worktreeId: before.record.worktreeId, generation: before.record.generation, ...before.snapshot },
      target: { branch: before.branch, head: before.head, worktreeId: before.target?.worktreeId ?? null, generation: before.target?.generation ?? null, snapshot: before.targetSnapshot }, candidate: candidate ?? null,
      mode: ff ? 'FF_ONLY' : 'MERGE', mergeBase, compatibility: candidateVerified ? 'CANDIDATE_VERIFIED' : ff ? 'FAST_FORWARD_VERIFIED' : 'MERGE_COMPATIBILITY_NOT_VERIFIED',
      blockers, missing, commits: commits.slice(0, 20), coverage: commits.length > 20 ? 'PARTIAL' : 'COMPLETE', proofs,
      nextAction: stale ? 'Atualizar origem, destino e provas antes de avaliar novamente.' : blockers.length ? 'Resolver os impedimentos operacionais indicados; esta avaliação não concede autorização.' : missing.length ? 'Preparar e validar a candidata no checkout isolado autorizado, com requisitos explícitos.' : 'Solicitar revisão da candidata verificada; integração continua sujeita à autorização.' }
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

  async discoverCoordinationWorktrees(request: { cursor?: string } = {}) {
    const page = await this.discoverWorktrees(request)
    return { ...page, worktrees: page.worktrees.map(record => ({ ...record, reference: this.worktrees!.isReference(record.worktreeId) })) }
  }

  async getCoordinationSnapshot(worktreeId: string) {
    return this.readWorktree(worktreeId, async (service, snapshot, record) => {
      const changes = service.parseChanges(snapshot.status)
      const paths = [...new Set(changes.flatMap(change => change.previousPath ? [change.path, change.previousPath] : [change.path]))].sort()
      if (paths.length > 10000) fail('GIT_PATH_LIMIT')
      return { record, localChanges: summarizeLocalChanges(changes), snapshot: { head: snapshot.head, branch: snapshot.branch, operation: snapshot.operation,
        indexRevision: snapshot.indexRevision, worktreeRevision: snapshot.worktreeRevision }, paths,
        stagedCount: changes.filter(c => c.stagedState).length, unstagedCount: changes.filter(c => c.unstagedState).length,
        untrackedCount: changes.filter(c => c.untracked).length, conflictCount: changes.filter(c => c.conflicted).length,
        reference: this.worktrees!.isReference(worktreeId) }
    })
  }

  async getCoordinationIdentity(worktreeId: string) {
    if (!this.worktrees || !this.worktreeRepositoryId) fail('WORKTREE_IDENTITY_UNAVAILABLE')
    return { repositoryId: this.worktreeRepositoryId!, record: await this.worktrees!.revalidateSelection(worktreeId) }
  }

  private correlation() {
    if (!this.worktrees || !this.coordinationIdentity) fail('WORKTREE_IDENTITY_UNAVAILABLE')
    return this.commitCorrelation ??= new GitCommitCorrelation(this.repoRoot, this.git, this.worktrees!, this.coordinationIdentity!)
  }
  private withCorrelationRead<T>(read: (provider: GitCommitCorrelation) => Promise<T>): Promise<T> {
    const result = this.pendingCorrelation.then(() => read(this.correlation())).catch(error => fail(error instanceof Error ? error.message : 'GIT_READ_UNAVAILABLE'))
    this.pendingCorrelation = result.then(() => undefined, () => undefined)
    return result
  }
  getWorktreeCommits(query: GitWorktreeCommitsQuery) {
    const request = { ...query }
    return this.withCorrelationRead(provider => provider.worktreeCommits(request))
  }
  getWorktreeTimeline(query: import('../../shared/types/worktree-integration-evidence-types').WorktreeTimelineQuery) {
    const request = { ...query }
    return this.withCorrelationRead(() => readWorktreeProvenance(this.git, this.worktrees!, this.coordinationIdentity!, request))
  }
  getCommitWorktrees(query: GitCommitWorktreesQuery) {
    const request = { ...query }
    return this.withCorrelationRead(provider => provider.commitWorktrees(request))
  }

  async getCoordinationCommitPaths(leftHead: string, rightHead: string): Promise<{ base: string; left: string[]; right: string[]; history?: CoordinationHistory }> {
    if (this.coordinationIdentity && !this.coordinationIdentity.isActive()) fail('WORKTREE_REPOSITORY_CHANGED')
    if (![leftHead, rightHead].every(value => /^[a-f0-9]{40,64}$/.test(value))) fail('INVALID_ARGUMENT')
    let base: string
    try { base = await this.git.mergeBase(this.repoRoot, leftHead, rightHead) }
    catch { fail('MERGE_BASE_UNAVAILABLE') }
    if (!base) fail('MERGE_BASE_UNAVAILABLE')
    const [left, right] = await Promise.all([
      this.git.getChangedPathsBetweenCommits(this.repoRoot, base, leftHead),
      this.git.getChangedPathsBetweenCommits(this.repoRoot, base, rightHead)
    ])
    if (this.coordinationIdentity && !this.coordinationIdentity.isActive()) fail('WORKTREE_REPOSITORY_CHANGED')
    return { base, left, right, history: { repositoryId: this.worktreeRepositoryId, referenceHead: leftHead, head: rightHead, base,
      relation: base === rightHead ? 'HEAD_INCLUDED' : 'EXCLUSIVE_COMMITS', provenance: 'EXACT_MERGE_BASE' } }
  }

  async selectWorktree(worktreeId: string, options?: { revalidateSelection: true }) {
    if (!this.worktrees) fail('WORKTREE_IDENTITY_UNAVAILABLE')
    try {
      const record = options?.revalidateSelection ? await this.worktrees!.revalidateSelection(worktreeId) : await this.worktrees!.select(worktreeId)
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
    return this.readWorktree(request.worktreeId, async (service, state, record) => {
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
      return { worktreeId: request.worktreeId, generation: record.generation,
        snapshot: { head: state.head, branch: state.branch, operation: state.operation, indexRevision: state.indexRevision, worktreeRevision: state.worktreeRevision },
        totalCount: changes.length, changes: changes.slice(offset, end), revision, nextCursor: end < changes.length ? `${revision}:${end}` : null }
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
    this.atlasActivity++
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
    return result.finally(() => { this.atlasActivity-- })
  }

  private normalizeError(error: unknown): GitOperationsError {
    if (error instanceof GitOperationsError) return error
    const message = error instanceof Error ? error.message : ''
    if (['WORKTREE_TRANSACTION_BUSY', 'WORKTREE_OWNERSHIP_REQUIRED'].includes(message)) return new GitOperationsError(message)
    for (const code of ['PROJECT_CONTEXT_CHANGED', 'GIT_STATE_CHANGED', 'NOTHING_TO_COMMIT', 'SHELF_NOT_FOUND', 'SHELF_REQUIRES_HEAD', 'CONFLICT_STATE_CHANGED', 'CONFLICT_SIDE_UNAVAILABLE', 'UNSUPPORTED_GIT_PATH']) if (message === code) return new GitOperationsError(code)
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

  async getState(remoteCheck: 'NONE' | 'VERIFY' = 'NONE') {
    const [changes, branch, head, upstream, operation, indexRevision] = await Promise.all([
      this.getChanges(), this.git.getCurrentBranch(this.repoRoot), this.git.getCurrentCommitHash(this.repoRoot),
      this.git.getUpstreamState(this.repoRoot), this.git.getGitOperation(this.repoRoot), this.git.getIndexRevision(this.repoRoot)
    ])
    const remoteEvidence: RemoteEvidence = remoteCheck === 'VERIFY' ? await this.verifyRemote(head) : { status: 'NOT_CHECKED', source: 'LOCAL_TRACKING' }
    return { repositoryState: 'GIT', branch, head, remoteEvidence,
      ...upstream, dirty: changes.length > 0,
      stagedCount: changes.filter((c) => c.stagedState).length, unstagedCount: changes.filter((c) => c.unstagedState).length,
      untrackedCount: changes.filter((c) => c.untracked).length, conflictCount: changes.filter((c) => c.conflicted).length,
      operation, indexRevision, worktreeRevision: await this.git.getWorktreeRevision(this.repoRoot, this.readOnlyWorktree),
      ...(this.readOnlyWorktree ? { worktreeRevisionKind: 'GIT_STATUS_FILE_METADATA' } : {}) }
  }

  private async verifyRemote(localHead: string | null): Promise<RemoteEvidence> {
    const unavailable = (reason: Extract<RemoteEvidence, { status: 'UNAVAILABLE' }>['reason']): RemoteEvidence =>
      ({ status: 'UNAVAILABLE', source: 'GIT_LS_REMOTE', reason, observedAt: new Date().toISOString() })
    try {
      const upstream = await this.git.getUpstreamReference(this.repoRoot)
      if (!upstream) return unavailable('NO_UPSTREAM')
      const remoteHead = this.transport.readRemoteHead
        ? await this.transport.readRemoteHead(this.repoRoot, upstream.remote, upstream.ref)
        : await this.git.readRemoteHead(this.repoRoot, upstream.remote, upstream.ref)
      if (!remoteHead) return unavailable('REMOTE_REF_MISSING')
      const remoteCounts = localHead === remoteHead ? { ahead: 0, behind: 0 }
        : localHead ? await this.git.compareCommits(this.repoRoot, localHead, remoteHead) : null
      return { status: 'VERIFIED', source: 'GIT_LS_REMOTE', ...upstream, localHead, remoteHead,
        observedAt: new Date().toISOString(), tracking: upstream.trackingHead === remoteHead ? 'TRACKING_CURRENT' : 'TRACKING_STALE',
        relationship: localHead === remoteHead ? 'IN_SYNC' : !remoteCounts ? 'UNKNOWN'
          : remoteCounts.ahead > 0 && remoteCounts.behind > 0 ? 'DIVERGED' : remoteCounts.ahead > 0 ? 'AHEAD' : 'BEHIND', remoteCounts }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      return unavailable(message === 'REMOTE_MISSING' || message === 'INVALID_REMOTE_RESPONSE' ? message
        : /timed out|timeout/i.test(message) ? 'TIMEOUT'
        : /authentication|permission denied|access denied|could not read Username|403|401/i.test(message) ? 'ACCESS_DENIED' : 'NETWORK_ERROR')
    }
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
    if (normalized.startsWith('.agents/skills/')) return { classification: 'GENERATED_PROJECTION', group: '.agents/skills', suggestedRule: '.agents/skills/' }
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

  clearAtlasCache() { this.remoteEpoch++; this.atlasReader?.invalidate(true); this.atlasReader = undefined; this.atlasCores.clear() }
  private remoteEpoch = 0
  private remotePending?: Promise<GitCheckoutSynchronization>
  private automaticFetchRequest?: GitMutationRequest
  private automaticFetch = () => false
  private publicationPolicy?: (branch: string) => Promise<{ defaultBranch: string; protected: boolean; canPush: boolean }>
  bindManagementPublicationPolicy(reader: NonNullable<GitOperationsService['publicationPolicy']>) { this.publicationPolicy = reader }
  bindAtlasRemotePolicy(enabled: () => boolean) { this.automaticFetch = enabled }
  async observeCheckoutSynchronization(context: GitMutationRequest['context'], assertCurrent: () => void): Promise<GitCheckoutSynchronization> {
    if (this.remotePending) return this.remotePending
    const epoch = this.remoteEpoch
    const guard = () => {
      assertCurrent()
      if (epoch !== this.remoteEpoch || this.coordinationIdentity && !this.coordinationIdentity.isActive()) fail('PROJECT_CONTEXT_CHANGED')
    }
    const run = async () => {
      const observed = await this.getCheckoutSynchronization()
      guard()
      const evidence = observed.evidence
      const remoteKey = evidence.status === 'VERIFIED' ? JSON.stringify([context, observed.state.branch, evidence.remote, evidence.ref, evidence.remoteHead]) : null
      if (remoteKey && this.lastRemoteHead !== remoteKey) {
        this.atlasPrRevision++
        this.lastRemoteHead = remoteKey
      }
      if (!this.automaticFetchRequest && (!this.automaticFetch() || observed.action !== 'FETCH' || observed.blockedReason)) return observed
      const request = this.automaticFetchRequest ??= { context, operationId: randomUUID(), snapshot: observed.state, operation: { action: 'FETCH', contextual: true } }
      const receipt = await this.executeManagementMutation(request, () => {
        guard()
        if (!this.automaticFetch()) fail('GIT_STATE_CHANGED')
      })
      guard()
      if (['OPERATION_OUTCOME_UNKNOWN', 'RECEIPT_UNAVAILABLE', 'RECEIPT_BUSY', 'RECEIPT_CAPACITY_EXCEEDED'].includes(String(receipt.value.code))) return { ...observed, action: null, blockedReason: 'O resultado do fetch automático ainda não foi confirmado. Verifique novamente para recuperar a mesma operação.', automaticFetch: 'PENDING' as const }
      this.automaticFetchRequest = undefined
      if (receipt.isError) return { ...observed, automaticFetch: 'FAILED' as const }
      return { ...await this.getCheckoutSynchronization(), automaticFetch: 'FETCHED' as const }
    }
    const promise = run().finally(() => { if (this.remotePending === promise) this.remotePending = undefined })
    this.remotePending = promise
    return promise
  }
  private lastRemoteHead?: string
  private atlasPrRevision = 0
  private atlasPrReadRevision = 0
  private atlasActivity = 0
  beginAtlasInteraction() { this.atlasActivity++; return () => { this.atlasActivity-- } }
  stopAtlasCollection() { this.atlasReader?.stopCollection() }
  async getAtlasCatalog(snapshot: string, contextKey: string, changed: (state: import('../../shared/types/git-atlas-catalog-types').AtlasCatalogState) => void) {
    await this.repository()
    return this.atlas().startCollection(snapshot, contextKey, changed)
  }
  getAtlasCatalogDiagnostic() { return this.atlas().catalogDiagnostic() }
  private atlasPersistence?: (common: string) => AtlasPersistence | Promise<AtlasPersistence>
  private atlasCatalogClear?: (common: string, authorization: {repositoryId:string;confirmed:true}) => void | Promise<void>
  bindAtlasPersistence(factory: (common: string) => AtlasPersistence | Promise<AtlasPersistence>, clear?: (common: string, authorization: {repositoryId:string;confirmed:true}) => void | Promise<void>) { this.atlasPersistence = factory; this.atlasCatalogClear=clear }
  async clearAtlasCatalog(authorization: {repositoryId:string;confirmed:true}) {
    if(!this.coordinationIdentity?.isActive() || authorization.confirmed!==true || authorization.repositoryId!==this.coordinationIdentity.repositoryId || !this.atlasCatalogClear) fail('ATLAS_CLEAR_NOT_AUTHORIZED')
    const common=await this.git.getCommonDirectory(this.repoRoot)
    this.clearAtlasCache()
    await this.atlasCatalogClear(common,authorization)
  }
  async getAtlasCheckoutState(lightweight = false) {
    return this.git.getAtlasObservation(this.repoRoot, lightweight, true)
  }
  private atlasPullRequests?: (inventory: BranchInventory, force?: boolean) => Promise<BranchPullRequests>
  private readonly atlasCores = new AtlasCache(8, 2 * 1024 * 1024)
  private readonly atlasCorePending = new Map<string, Promise<GitAtlasCoreEvidence>>()
  private readonly atlasPrPending = new Map<string, Promise<GitAtlasPrEvidence>>()
  private atlasCoreKey(request: GitAtlasEvidenceQuery) { return JSON.stringify([request.contextKey, request.scope, request.window, request.limit ?? 100, request.cursor ?? null]) }

  bindAtlasPullRequests(reader: (inventory: BranchInventory, force?: boolean) => Promise<BranchPullRequests>) {
    this.atlasPullRequests = reader
  }

  async getAtlasCoreEvidence(request: GitAtlasEvidenceQuery): Promise<GitAtlasCoreEvidence> {
    const key = JSON.stringify([this.atlasCoreKey(request), request.comparisonRef, !!request.refresh])
    const existing = this.atlasCorePending.get(key)
    if (existing) return structuredClone(await existing)
    const promise = this.readAtlasCoreEvidence(request)
    this.atlasCorePending.set(key, promise)
    try { return structuredClone(await promise) }
    finally { if (this.atlasCorePending.get(key) === promise) this.atlasCorePending.delete(key) }
  }

  private async readAtlasCoreEvidence(request: GitAtlasEvidenceQuery): Promise<GitAtlasCoreEvidence> {
    if (request.comparisonRef !== undefined && (typeof request.comparisonRef !== 'string' || !request.comparisonRef.length || request.comparisonRef.length > 256)) fail('INVALID_ARGUMENT')
    await this.repository()
    const identity = this.coordinationIdentity
    if (!identity || !this.worktrees || !identity.isActive()) fail('WORKTREE_IDENTITY_UNAVAILABLE')
    const page = await this.atlas().history(request)
    if (!identity.isActive()) fail('REPOSITORY_CONTEXT_CHANGED')
    const cached = this.atlasCores.getReadonly<GitAtlasCoreEvidence>(this.atlasCoreKey(request))
    if (cached?.gitSnapshot === page.snapshot && cached.checkout.comparisonRef === (request.comparisonRef ?? null)) return { ...structuredClone(cached), git: page }
    const trees = request.scope?.kind === 'CHECKOUT'
      ? { repositoryId: identity.repositoryId, worktrees: [await this.worktrees.current({ head: page.head, branch: page.branch })] }
      : await this.worktrees.discover({ reuseValidatedDirectories: true })
    const normalize = (path: string) => process.platform === 'win32' ? realpathSync(path).toLowerCase() : realpathSync(path)
    const selected = trees.worktrees.find(tree => !tree.missing && !tree.prunable && normalize(tree.path) === normalize(this.repoRoot))
    const selectedHead = selected?.head && !/^0+$/.test(selected.head) ? selected.head : null
    if (!selected || selectedHead !== page.head || selected.branch !== page.branch || page.worktreeGeneration && page.worktreeGeneration !== selected.generation) fail('GIT_STATE_CHANGED')
    const ref = page.branch ? 'refs/heads/' + page.branch : null
    const checkout: GitAtlasCoreEvidence['checkout'] = {
      head: page.head, ref, detached: selected.detached,
      upstream: page.refs.find(item => item.ref === ref)?.upstream ?? null,
      comparisonRef: request.comparisonRef ?? null,
      comparisonSource: request.comparisonRef ? request.comparisonRef.startsWith('refs/remotes/') ? 'LOCAL_REMOTE_TRACKING' : 'LOCAL_REF_OR_OBJECT' : 'NOT_REQUESTED',
      relation: 'UNKNOWN', ahead: null, behind: null, comparison: null
    }
    if (request.comparisonRef && page.head) {
      const comparison = await this.atlas().compare({ snapshot: page.snapshot, left: 'HEAD', right: request.comparisonRef === 'HEAD' ? page.head : request.comparisonRef, contextKey: request.contextKey, scope: request.scope })
      checkout.comparison = comparison
      checkout.ahead = comparison.leftOnly; checkout.behind = comparison.rightOnly
      checkout.relation = comparison.left.sha === comparison.right.sha ? 'EQUAL' : !comparison.mergeBases.length ? 'UNRELATED' :
        comparison.leftOnly === 0 ? 'BEHIND_ONLY' : comparison.rightOnly === 0 ? 'AHEAD_ONLY' : 'DIVERGED'
    }
    if (request.scope?.kind !== 'CHECKOUT') await this.atlas().assertSnapshot(page.snapshot, request.contextKey, request.scope)
    if (!identity.isActive() || trees.repositoryId !== identity.repositoryId) fail('REPOSITORY_CONTEXT_CHANGED')
    const observedAt = new Date().toISOString()
    const core: GitAtlasCoreEvidence = {
      phase: 'CORE', repositoryId: identity.repositoryId, worktreeId: selected.worktreeId, worktreeGeneration: selected.generation,
      observedAt, gitSnapshot: page.snapshot, source: 'GIT_LOCAL',
      coverage: { git: page.nextCursor || page.detachedCoverage !== 'COMPLETE' ? 'PARTIAL' : 'COMPLETE', github: 'NOT_REQUESTED' },
      gitCoverageScope: 'REQUESTED_WINDOW',
      git: page, checkout,
      worktrees: trees.worktrees.map(tree => ({ worktreeId: tree.worktreeId, generation: tree.generation, head: tree.head && !/^0+$/.test(tree.head) ? tree.head : null, branch: tree.branch, detached: tree.detached, available: !tree.missing && !tree.prunable })),
      events: page.nodes.filter(node => node.parents.length > 1).map(node => ({ kind: 'GIT_MERGE_COMMIT', evidenceSource: 'GIT_LOCAL', confidence: 'CONFIRMED', sha: node.sha, parents: node.parents, firstParent: node.parents[0], committedAt: node.timestamp, observedAt })),
      historicalIntegrationCoverage: 'UNKNOWN'
    }
    this.atlasCores.set(this.atlasCoreKey(request), core)
    return core
  }

  async getAtlasPrEvidence(request: GitAtlasEvidenceQuery & { snapshot: string }): Promise<GitAtlasPrEvidence> {
    const key = JSON.stringify([this.atlasCoreKey(request), request.snapshot])
    const existing = this.atlasPrPending.get(key)
    if (existing) return structuredClone(await existing)
    const promise = this.readAtlasPrEvidence(request)
    this.atlasPrPending.set(key, promise)
    try { return structuredClone(await promise) }
    finally { if (this.atlasPrPending.get(key) === promise) this.atlasPrPending.delete(key) }
  }

  private async readAtlasPrEvidence(request: GitAtlasEvidenceQuery & { snapshot: string }): Promise<GitAtlasPrEvidence> {
    await this.repository()
    const core = this.atlasCores.getReadonly<GitAtlasCoreEvidence>(this.atlasCoreKey(request))
    if (!core || core.gitSnapshot !== request.snapshot) fail('GIT_STATE_CHANGED')
    if (!this.coordinationIdentity?.isActive() || this.coordinationIdentity.repositoryId !== core.repositoryId) fail('REPOSITORY_CONTEXT_CHANGED')
    await this.atlas().assertSnapshot(core.gitSnapshot, request.contextKey, request.scope)
    const result: GitAtlasPrEvidence = {
      phase: 'PR_ENRICHMENT', repositoryId: core.repositoryId, worktreeId: core.worktreeId, worktreeGeneration: core.worktreeGeneration,
      gitSnapshot: core.gitSnapshot, observedAt: new Date().toISOString(), source: 'GITHUB_REST', providerRevision: null,
      coverage: 'UNAVAILABLE', reason: 'GITHUB_UNAVAILABLE', branches: null, pullRequests: [], events: []
    }
    if (!this.atlasPullRequests) return result
    const inventory = await this.getBranchInventory()
    if (inventory.repositoryId !== core.repositoryId) fail('REPOSITORY_CONTEXT_CHANGED')
    await this.atlas().assertSnapshot(core.gitSnapshot, request.contextKey, request.scope)
    let branches: BranchPullRequests
    const remoteRevision = this.atlasPrRevision
    try { branches = await this.atlasPullRequests(inventory, remoteRevision !== this.atlasPrReadRevision); this.atlasPrReadRevision = remoteRevision }
    catch {
      await this.atlas().assertSnapshot(core.gitSnapshot, request.contextKey, request.scope)
      if (!this.coordinationIdentity?.isActive()) fail('REPOSITORY_CONTEXT_CHANGED')
      return result
    }
    if (!this.coordinationIdentity?.isActive() || branches.repositoryId !== core.repositoryId || branches.catalog.repositoryId !== core.repositoryId) fail('REPOSITORY_CONTEXT_CHANGED')
    const after = await this.getBranchInventory()
    if (after.revision !== inventory.revision) fail('GIT_STATE_CHANGED')
    await this.atlas().assertSnapshot(core.gitSnapshot, request.contextKey, request.scope)
    if (!this.coordinationIdentity?.isActive()) fail('REPOSITORY_CONTEXT_CHANGED')
    const catalog = branches.catalog
    if (catalog.items.length > 1000 || branches.relations.length > 5000 || branches.received.length > 5000) fail('ATLAS_REFERENCE_LIMIT')
    const branchRevisions = new Map(inventory.branches.map(branch => [branch.key, branch]))
    for (const relation of [...branches.relations, ...branches.received]) {
      const branch = branchRevisions.get(relation.branchKey)
      if (!branch || relation.repositoryId !== core.repositoryId || relation.branchRevision !== branch.revision || relation.catalogRevision !== catalog.revision ||
        'branchGeneration' in relation && relation.branchGeneration !== branch.generation) fail('GIT_STATE_CHANGED')
    }
    result.branches = branches; result.coverage = catalog.coverage; result.reason = catalog.reason
    result.providerRevision = catalog.revision; result.observedAt = catalog.observedAt
    for (const pr of catalog.items) {
      const providerMatches = catalog.providerRepositoryId !== null && catalog.repository !== null && pr.base.repositoryId === catalog.providerRepositoryId && pr.base.repository.toLowerCase() === catalog.repository.toLowerCase()
      if (!providerMatches) fail('REPOSITORY_CONTEXT_CHANGED')
      result.pullRequests.push({ record: pr, lifecycle: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED_UNMERGED', openInterval: 'UNKNOWN', localInclusion: 'UNKNOWN' })
      result.events.push({ kind: 'PR_CREATED', evidenceSource: 'GITHUB_REST', confidence: 'CONFIRMED', prNumber: pr.number, url: pr.url, at: pr.createdAt, observedAt: catalog.observedAt })
      if (!pr.merged || !pr.mergedAt) continue
      const merge = core.git.nodes.find(node => node.sha === pr.mergeCommit && node.parents.length === 2 && node.parents[1] === pr.head.sha)
      result.events.push({ kind: 'PR_MERGED', evidenceSource: 'GITHUB_REST', confidence: 'CONFIRMED', prNumber: pr.number, url: pr.url, at: pr.mergedAt, mergeCommitSha: pr.mergeCommit, observedAt: catalog.observedAt,
        integrationMethod: merge ? 'MERGE_COMMIT' : 'MERGED_METHOD_UNKNOWN', methodEvidenceSource: merge ? 'GIT_AND_GITHUB' : 'UNKNOWN' })
    }
    return result
  }

  private atlasReader?: GitAtlasReader
  private atlas(): GitAtlasReader {
    return this.atlasReader ??= new GitAtlasReader(this.repoRoot, this.git, fail, this.atlasPersistence, () => this.atlasActivity > 0)
  }
  async getAtlasHistory(request: GitAtlasQuery) {
    await this.repository()
    return this.atlas().history(request)
  }
  async compareAtlas(request: { snapshot: string; left: string; right: string; contextKey?: string; scope?: GitAtlasQuery['scope'] }) {
    await this.repository()
    return this.atlas().compare(request)
  }
  async getGraphHistory(request: { limit?: number; cursor?: string; contextKey?: string }): Promise<GitHistoryPage> {
    await this.repository()
    const limit = request.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_ARGUMENT')
    const observe = async () => {
      const refs = await this.git.getBranchReferences(this.repoRoot)
      const head = await this.git.getCurrentCommitHash(this.repoRoot)
      const branch = await this.git.getCurrentBranch(this.repoRoot)
      return { refs, head, branch, snapshot: createHash('sha256').update(JSON.stringify({ refs, head, branch, contextKey: request.contextKey })).digest('hex') }
    }
    const before = await observe()
    let offset = 0
    if (request.cursor) {
      const parts = request.cursor.split(':')
      if (parts.length !== 2 || parts[0] !== before.snapshot) fail('GIT_STATE_CHANGED')
      offset = Number(parts[1])
      if (!Number.isSafeInteger(offset) || offset < 0) fail('INVALID_ARGUMENT')
    }
    const refs: GitDecoration[] = before.refs.trimEnd().split('\n').filter(Boolean).flatMap(line => {
      const [ref, sha, symbolic, upstream] = line.split('\0')
      if (symbolic) return []
      return [{ ref, sha, name: ref.replace(/^refs\/(heads|remotes)\//, ''), kind: ref.startsWith('refs/heads/') ? 'LOCAL' as const : 'REMOTE' as const, upstream: upstream || null }]
    })
    if (before.head) refs.push({ ref: 'HEAD', name: before.branch ? 'HEAD' : 'HEAD (detached)', kind: 'HEAD', sha: before.head, upstream: null })
    const tips = [...new Set(refs.map(ref => ref.sha))].sort()
    const rows = (await this.git.getBranchHistory(this.repoRoot, tips, offset, limit + 1)).trimEnd().split('\n').filter(Boolean)
    if ((await observe()).snapshot !== before.snapshot) fail('GIT_STATE_CHANGED')
    const nodes = rows.slice(0, limit).map(line => {
      const [sha, parents, author, timestamp, subject] = line.split('\0')
      return { sha, parents: parents.split(' ').filter(Boolean), author, timestamp, subject, decorations: refs.filter(ref => ref.sha === sha) }
    })
    const present = new Set(nodes.map(node => node.sha))
    return { snapshot: before.snapshot, head: before.head, branch: before.branch, refs, nodes,
      pendingParents: [...new Set(nodes.flatMap(node => node.parents).filter(parent => !present.has(parent)))],
      nextCursor: rows.length > limit ? `${before.snapshot}:${offset + limit}` : null }
  }

  async getManagementOverview() {
    const state = await this.getState()
    const changes = await this.getChanges()
    const after = await this.getState()
    if (state.head !== after.head || state.branch !== after.branch || state.indexRevision !== after.indexRevision || state.worktreeRevision !== after.worktreeRevision) fail('GIT_STATE_CHANGED')
    return { state, changes }
  }

  async getCheckoutSynchronization(): Promise<GitCheckoutSynchronization> {
    const state = await this.getState('VERIFY')
    const after = await this.getState()
    if (!sameCheckoutSnapshot(state, after)) fail('GIT_STATE_CHANGED')
    const evidence = state.remoteEvidence
    let blockedReason: string | null = null
    if (!state.head) blockedReason = 'Repositório sem commits.'
    else if (!state.branch) blockedReason = 'HEAD detached: nenhuma branch em checkout.'
    else if (state.operation || state.conflictCount) blockedReason = 'Resolva a operação Git ou os conflitos antes de sincronizar.'
    else if (this.readOnlyWorktree) blockedReason = 'O controle Git desta worktree pertence a outro executor.'
    else {
      try { assertNoWorktreeGrant(realpathSync(await this.git.getCommonDirectory(this.repoRoot)), this.repoRoot) }
      catch { blockedReason = 'O controle Git desta worktree pertence a outro executor.' }
    }
    const result = (action: GitCheckoutSynchronization['action'], reason = blockedReason): GitCheckoutSynchronization => ({ state, evidence, action, blockedReason: reason })
    if (blockedReason || evidence.status !== 'VERIFIED') return result(null)
    if (evidence.relationship === 'IN_SYNC') return result(null)
    if (evidence.tracking === 'TRACKING_STALE' || evidence.relationship === 'UNKNOWN' || !evidence.remoteCounts)
      return evidence.remote === 'origin' ? result('FETCH') : result(null, `Fetch contextual disponível somente para origin; upstream em ${evidence.remote}.`)
    if (evidence.relationship === 'AHEAD') {
      if (this.publicationPolicy && evidence.remote === 'origin' && evidence.ref === `refs/heads/${state.branch}` && !['main', 'master'].includes(state.branch!)) {
        try {
          const primary = await this.git.getAtlasSelectedBase(this.repoRoot)
          const policy = await this.publicationPolicy(state.branch!)
          if (!sameCheckoutSnapshot(state, await this.getState())) fail('GIT_STATE_CHANGED')
          if (primary !== `refs/heads/${state.branch}` && primary !== `refs/remotes/${evidence.remote}/${state.branch}` && policy.canPush === true && policy.protected === false && policy.defaultBranch && policy.defaultBranch !== state.branch) return result('PUSH')
        } catch (error) { if (error instanceof GitOperationsError && error.code === 'GIT_STATE_CHANGED') throw error }
      }
      return result('REVIEW_PUBLICATION', 'Push direto depende de política e autorização comprovadas; revise os commits e use o fluxo autorizado de publicação.')
    }
    if (evidence.relationship === 'DIVERGED') return result('COMPARE')
    if (evidence.remote !== 'origin') return result(null, `O executor atual usa origin; upstream ${evidence.remote}/${evidence.ref.replace('refs/heads/', '')} não suportado pelo atalho.`)
    if (evidence.ref !== `refs/heads/${state.branch}`) return result(null, 'O upstream difere de origin/<branch ativa>; Pull contextual indisponível para este destino.')
    if (evidence.relationship === 'BEHIND') return state.dirty ? result(null, 'Pull exige uma worktree limpa; há alterações locais.') : result('PULL_FF_ONLY')
    return result(null)
  }

  async getCommitDetail(request: { sha: string; cursor?: string }): Promise<GitCommitDetail> {
    if (typeof request.sha !== 'string' || !/^[a-f0-9]{40,64}$/.test(request.sha)) fail('INVALID_REF')
    const [commit] = await this.getHistory({ ref: request.sha, limit: 1 })
    const base = commit.parents[0] ?? null
    let raw: string
    try { raw = await this.git.getCommitFileStatus(this.repoRoot, commit.sha, base) }
    catch (error) { if (error instanceof Error && error.message === 'GIT_OUTPUT_BYTE_LIMIT') fail('DIFF_TOO_LARGE'); throw error }
    const entries = raw.split('\0'), files: GitCommitFile[] = []
    for (let index = 0; index < entries.length && entries[index];) {
      const status = entries[index++], first = entries[index++]
      files.push(/^[RC]/.test(status) ? { status, previousPath: first, path: entries[index++] } : { status, path: first })
    }
    const revision = createHash('sha256').update(commit.sha + raw).digest('hex')
    const offset = this.pageOffset(request.cursor, revision, files.length)
    return { commit: { ...commit, decorations: [] }, base, comparison: !base ? 'ROOT' : commit.parents.length > 1 ? 'FIRST_PARENT' : 'PARENT', files: files.slice(offset, offset + 100), nextCursor: files.length > offset + 100 ? `${revision}:${offset + 100}` : null }
  }

  private pageOffset(cursor: string | undefined, revision: string, length: number): number {
    if (!cursor) return 0
    const [expected, position, extra] = cursor.split(':')
    if (expected !== revision) fail('GIT_STATE_CHANGED')
    const offset = Number(position)
    if (extra !== undefined || !Number.isSafeInteger(offset) || offset < 0 || offset > length) fail('INVALID_ARGUMENT')
    return offset
  }

  async getManagementPatch(request: { path: string; mode: 'WORKTREE' | 'STAGED' | 'COMMIT'; sha?: string; cursor?: string }): Promise<GitPatch> {
    await this.repository()
    const paths = this.paths([request.path])
    let patch: string
    try {
      if (request.mode === 'COMMIT') {
        if (!request.sha || !/^[a-f0-9]{40,64}$/.test(request.sha)) fail('INVALID_REF')
        const [commit] = await this.getHistory({ ref: request.sha, limit: 1 })
        patch = commit.parents.length ? await this.git.getOperationsDiff(this.repoRoot, paths, 'BETWEEN_REFS', commit.parents[0], commit.sha, 512000) : await this.git.getRootCommitPatch(this.repoRoot, commit.sha, paths)
      } else {
        if (!['WORKTREE', 'STAGED'].includes(request.mode)) fail('INVALID_ARGUMENT')
        patch = await this.git.getOperationsDiff(this.repoRoot, paths, request.mode, undefined, undefined, 512000)
      }
    } catch (error) { if (error instanceof Error && error.message === 'GIT_OUTPUT_BYTE_LIMIT') fail('DIFF_TOO_LARGE'); throw error }
    const revision = createHash('sha256').update(JSON.stringify({ path: request.path, mode: request.mode, sha: request.sha, patch })).digest('hex')
    const offset = this.pageOffset(request.cursor, revision, patch.length), end = Math.min(offset + 24000, patch.length)
    return { patch: patch.slice(offset, end), binary: /Binary files .* differ|GIT binary patch/.test(patch), truncated: end < patch.length, nextCursor: end < patch.length ? `${revision}:${end}` : null, revision }
  }

  async stage(request: { mode: 'STAGE' | 'UNSTAGE'; paths: string[]; expectedIndexRevision: string; expectedWorktreeRevision: string }, guard?: () => Promise<void>) {
    return this.serialized(async () => {
      await this.repository()
      const paths = this.paths(request.paths)
      if (![request.expectedIndexRevision, request.expectedWorktreeRevision].every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) fail('INVALID_ARGUMENT')
      const expected = { indexRevision: request.expectedIndexRevision, worktreeRevision: request.expectedWorktreeRevision }
      await guard?.()
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

  async commit(request: { message: string; expectedHead: string | null; expectedIndexRevision: string }, guard?: () => Promise<void>) {
    return this.serialized(async () => {
      await this.ready(true)
      await this.checkHead(request.expectedHead)
      if ((await this.getChanges('CONFLICTED')).length) fail('MERGE_CONFLICT')
      if (typeof request.message !== 'string' || !request.message.trim() || request.message.length > 10000 || request.message.includes('\0')) fail('INVALID_ARGUMENT')
      await guard?.()
      const sha = await this.git.commitInspectedIndex(this.repoRoot, request.message, request.expectedHead, request.expectedIndexRevision)
      return this.observeMutation(async () => ({ sha, parent: request.expectedHead, branch: await this.git.getCurrentBranch(this.repoRoot), message: request.message, paths: await this.git.getCommittedPaths(this.repoRoot, sha) }))
    })
  }

  async manageBranch(request: BranchRequest, guard?: () => Promise<void>) {
    return this.serialized(async () => {
      await this.repository()
      if (request.action === 'LIST') return (await this.git.listBranches(this.repoRoot)).trimEnd().split('\n').filter(Boolean).map((line) => {
        const [branch, head, current] = line.split('\0'); return { branch, head, current: current === '*' }
      })
      await this.ready()
      const branch = await this.branch(request.branch)
      if (request.action === 'RENAME' || request.action === 'DELETE' || request.action === 'SWITCH') {
        const fields = (await this.git.listWorktreeRecords(this.repoRoot)).split('\0\0').filter(Boolean)
        if (fields.some(group => {
          const parts = group.split('\0')
          const path = parts.find(value => value.startsWith('worktree '))?.slice(9)
          const sameRoot = path && (process.platform === 'win32' ? resolve(path).toLowerCase() === resolve(this.repoRoot).toLowerCase() : resolve(path) === resolve(this.repoRoot))
          return !sameRoot && parts.includes('branch refs/heads/' + branch)
        })) fail('WORKTREE_BRANCH_OCCUPIED')
      }
      await guard?.()
      if (request.action === 'CREATE') {
        await this.checkHead(request.expectedHead)
        const createdAt = new Date().toISOString()
        await this.git.createBranch(this.repoRoot, branch, await this.ref(request.startPoint ?? 'HEAD'))
        return this.observeMutation(async () => ({ ...await this.getState(), branchCreation: await recordBranchCreation(this.repoRoot, this.git, `refs/heads/${branch}`, createdAt) }))
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

  async sync(request: SyncRequest, guard?: () => Promise<void>) {
    return this.serialized(async () => {
      await this.ready()
      const remote = request.remote ?? 'origin'
      if (typeof remote !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) fail('REMOTE_NOT_FOUND')
      if (!await this.git.getRemoteUrl(this.repoRoot, remote)) fail('REMOTE_NOT_FOUND')
      await guard?.()
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
