import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { GitService } from '../core/git-service'
import type { GitOperationsService } from './git-operations-service'
import { GitWorktreeLifecycle } from './git-worktree-lifecycle'
import { assertNoWorktreeGrant, ownershipDigest, reconcileAbandonedLocks, withWorktreeTransaction } from './git-worktree-ownership'
import { assertRemovalPath, inventoryRemovalContent } from './worktree-removal-content'
import type { PullRequestDeliveryEvidence, RemovalConsent, RemovalIntent, RemovalPreview, RemovalReceipt } from '../../shared/types/worktree-removal-types'

const pathIdentity = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)

export interface WorktreeRemovalPorts {
  delivery(prNumber: number): Promise<PullRequestDeliveryEvidence>
  approve(preview: RemovalPreview, consent: RemovalConsent): Promise<boolean>
  approvePolicy?(enabled: boolean): Promise<boolean>
  approveAutomatic?(preview: RemovalPreview): Promise<boolean>
  approveRecovery?(preview: RemovalPreview): Promise<boolean>
  isActive(): boolean
  sourceRoot: string
}

export class GitWorktreeRemoval {
  private automaticRunning = false
  private automaticOffset = 0
  constructor(private readonly root: string, private readonly repositoryId: string, private readonly git: GitService,
    private readonly operations: GitOperationsService, private readonly ports: WorktreeRemovalPorts) {}

  private current(): void { if (!this.ports.isActive()) throw new Error('PROJECT_CONTEXT_CHANGED') }
  private async store() {
    this.current()
    return new GitWorktreeLifecycle(realpathSync(await this.git.getCommonDirectory(this.root)))
  }

  async recover(worktreeId: string, generation: string) {
    const lifecycle = await this.store(), stored = lifecycle.pendingRemoval(this.repositoryId, worktreeId, generation)
    this.current()
    return stored ? this.reconcileReceipt(stored.preview.preparationId, stored.operationId!) : { state: 'NO_PENDING_REMOVAL' as const }
  }

  private async observe(worktreeId: string, generation: string, intent: RemovalIntent, verifiedEvidence?: PullRequestDeliveryEvidence | null) {
    this.current()
    const { record, service } = await this.operations.selectWorktree(worktreeId)
    if (record.generation !== generation) throw new Error('WORKTREE_STALE')
    const common = realpathSync(await this.git.getCommonDirectory(this.root))
    const admin = realpathSync(await this.git.getWorktreeDirectory(record.path))
    const blockers: string[] = []
    if (new GitWorktreeLifecycle(common).pendingRemoval(this.repositoryId, worktreeId, generation)) blockers.push('REMOVAL_OUTCOME_UNKNOWN')
    if (this.operations.worktrees!.isReference(worktreeId) || pathIdentity(record.path) === pathIdentity(this.root) || pathIdentity(record.path) === pathIdentity(this.ports.sourceRoot)) blockers.push('REMOVAL_PROTECTED_CHECKOUT')
    if (record.locked) blockers.push('WORKTREE_LOCKED')
    if (existsSync(join(common, 'code-awareness-validation-locks', `${worktreeId}.lock`))) blockers.push('WORKTREE_VALIDATION_BUSY')
    if (['index.lock', 'HEAD.lock', 'locked'].some(name => existsSync(join(admin, name))) || existsSync(join(common, 'packed-refs.lock'))) blockers.push('REMOVAL_GIT_LOCKED')
    if (record.detached || !record.branch || !record.head) blockers.push('REMOVAL_PROVENANCE_REQUIRED')
    if (['main', 'master'].includes(record.branch ?? '')) blockers.push('REMOVAL_PROTECTED_BRANCH')
    if (this.operations.ownership && await this.operations.ownership.state(worktreeId) !== 'NOT_GRANTED') blockers.push('WORKTREE_OWNERSHIP_CONFLICT')
    try { assertNoWorktreeGrant(common, record.path) } catch { blockers.push('WORKTREE_OWNERSHIP_CONFLICT') }
    let evidence: PullRequestDeliveryEvidence | null = null
    if (intent.delivery) {
      evidence = verifiedEvidence ?? await this.ports.delivery(intent.delivery.prNumber)
      if (evidence.status !== 'OBSERVED') blockers.push('REMOVAL_PROVIDER_UNAVAILABLE')
      else {
        const age = Date.now() - Date.parse(evidence.observedAt)
        if (!Number.isFinite(age) || age < -1000 || age > 30000) blockers.push('REMOVAL_PROVIDER_STALE')
        if (ownershipDigest(evidence.delivery) !== ownershipDigest(intent.delivery) || intent.delivery.head !== record.head || intent.delivery.sourceBranch !== record.branch) blockers.push('REMOVAL_DELIVERY_MISMATCH')
        if (intent.mode === 'INTEGRATED' && (!evidence.merged || evidence.state !== 'closed' || !evidence.mergedAt || !evidence.mergeCommit)) blockers.push('REMOVAL_MERGE_NOT_VERIFIED')
        if (intent.mode === 'ABANDONED' && (evidence.state !== 'closed' || evidence.merged)) blockers.push('REMOVAL_PR_MUST_BE_CLOSED_WITHOUT_MERGE')
      }
    } else if (intent.mode === 'INTEGRATED' || !intent.noPullRequestConfirmed) blockers.push('EVIDENCE_PENDING')
    if (intent.mode === 'ABANDONED' && !intent.abandonmentReason.trim()) blockers.push('REMOVAL_ABANDONMENT_REQUIRED')
    const confirmed = await this.operations.selectWorktree(worktreeId, { revalidateSelection: true })
    if (confirmed.record.generation !== generation || confirmed.record.head !== record.head || confirmed.record.branch !== record.branch || confirmed.record.locked !== record.locked) throw new Error('REMOVAL_PREVIEW_STALE')
    const paths = await this.git.readRemovalPaths(record.path)
    if (paths.hasSubmodules) blockers.push('REMOVAL_SUBMODULE_UNSUPPORTED')
    if (paths.hiddenChangesPossible) blockers.push('REMOVAL_INDEX_FLAGS_UNSUPPORTED')
    const changes = await service.getChanges()
    if (changes.some(change => change.conflicted)) blockers.push('REMOVAL_CONFLICTS')
    const state = await service.getState()
    if (state.operation) blockers.push('GIT_OPERATION_IN_PROGRESS')
    if (record.branch && record.head && await this.git.resolveCommit(this.root, `refs/heads/${record.branch}`) !== record.head) blockers.push('REMOVAL_PRESERVATION_REQUIRED')
    const content = inventoryRemovalContent(record.path, paths.tracked, paths.ignored)
    const present = new Set(content.map(file => file.path))
    for (const path of paths.tracked) if (!present.has(path)) content.push({ path, kind: 'TRACKED', sha256: 'ABSENT', bytes: 0 })
    const snapshot = { branch: state.branch, head: state.head, indexRevision: state.indexRevision, worktreeRevision: state.worktreeRevision, operation: state.operation }
    const workspaceRevision = ownershipDigest({ repositoryId: this.repositoryId, record, snapshot, content })
    const revision = ownershipDigest({ workspaceRevision, intent, blockers,
      evidence: evidence?.status === 'OBSERVED' ? { ...evidence, observedAt: undefined } : evidence })
    this.current()
    return { record, common, admin, content, blockers, revision, workspaceRevision, evidence }
  }

  async policy(enabled?: boolean) {
    const lifecycle = await this.store()
    if (enabled !== undefined) {
      if (enabled && !await this.ports.approvePolicy?.(enabled)) throw new Error('REMOVAL_APPROVAL_DENIED')
      const common = realpathSync(await this.git.getCommonDirectory(this.root)), admin = realpathSync(await this.git.getWorktreeDirectory(this.root))
      await withWorktreeTransaction(common, admin, async () => {
        this.current()
        lifecycle.saveRemovalPolicy({ repositoryId: this.repositoryId, enabled, revision: randomUUID(), enrollments: [] })
      })
    }
    const policy = lifecycle.removalPolicy(this.repositoryId)
    return { enabled: policy.enabled, revision: policy.revision, enrolled: policy.enrollments.length,
      candidates: policy.enrollments.map(entry => ({ path: entry.preview.path, state: entry.lastResult?.state ?? 'DELIVERY_PENDING', code: entry.lastResult?.code })) }
  }

  async enrollAutomatic(id: string, consent: RemovalConsent) {
    const lifecycle = await this.store(), stored = lifecycle.removal(id), preview = stored.preview
    this.consent(preview, consent)
    if (stored.state !== 'PREPARED' || preview.intent.mode !== 'INTEGRATED' || !preview.intent.delivery || Date.now() >= Date.parse(preview.expiresAt)) throw new Error('REMOVAL_NOT_PREPARED')
    if (!await this.ports.approveAutomatic?.(preview)) throw new Error('REMOVAL_APPROVAL_DENIED')
    const observation = await this.observe(preview.worktreeId, preview.generation, preview.intent)
    return withWorktreeTransaction(observation.common, observation.admin, async () => {
      const policy = lifecycle.removalPolicy(this.repositoryId)
      if (!policy.enabled) throw new Error('REMOVAL_POLICY_DISABLED')
      const fresh = await this.observe(preview.worktreeId, preview.generation, preview.intent)
      if (Date.now() >= Date.parse(preview.expiresAt)) throw new Error('REMOVAL_PREPARATION_EXPIRED')
      if (fresh.revision !== stored.revision || fresh.blockers.some(code => code !== 'REMOVAL_MERGE_NOT_VERIFIED')) throw new Error('REMOVAL_PREVIEW_STALE')
      if (!lifecycle.get(fresh.record) || dirname(fresh.record.path) !== join(fresh.common, 'code-awareness-workspaces') || fresh.content.some(file => file.kind !== 'TRACKED') || (await (await this.operations.selectWorktree(preview.worktreeId)).service.getChanges()).length) throw new Error('REMOVAL_AUTO_MANAGED_CLEAN_REQUIRED')
      if (policy.enrollments.length >= 100) throw new Error('REMOVAL_ENROLLMENT_LIMIT')
      policy.enrollments = policy.enrollments.filter(entry => entry.preview.worktreeId !== preview.worktreeId)
      policy.enrollments.push({ preview, workspaceRevision: fresh.workspaceRevision, policyRevision: policy.revision, operatorReleaseConfirmedAt: new Date().toISOString() })
      this.current(); lifecycle.saveRemovalPolicy(policy)
      return { state: 'ENROLLED' as const }
    })
  }

  async reconcileAutomatic(): Promise<RemovalReceipt[]> {
    if (this.automaticRunning) return []
    this.automaticRunning = true
    try {
      const lifecycle = await this.store(), policy = lifecycle.removalPolicy(this.repositoryId)
      if (!policy.enabled || !policy.enrollments.length) return []
      const entries = policy.enrollments.slice(this.automaticOffset, this.automaticOffset + 2)
      this.automaticOffset = (this.automaticOffset + 2) % policy.enrollments.length
      const receipts: RemovalReceipt[] = []
      for (const entry of entries) {
        this.current()
        if (entry.policyRevision !== policy.revision) continue
        if (['CLOSED', 'UNKNOWN'].includes(entry.lastResult?.state ?? '')) continue
        const p = entry.preview
        let outcome: { state: string; code?: string; observedAt: string } = { state: 'BLOCKED', observedAt: new Date().toISOString() }
        try {
          const observation = await this.observe(p.worktreeId, p.generation, p.intent)
          if (observation.workspaceRevision !== entry.workspaceRevision) throw new Error('REMOVAL_PREVIEW_STALE')
          if (observation.blockers.length) throw new Error(observation.blockers[0])
          const preview = await this.prepareRemoval(p.worktreeId, p.generation, p.intent)
          const consent: RemovalConsent = { fingerprint: preview.fingerprint, exactPath: preview.path, ownerReleased: true, operatorIsOwner: true, noKnownWriter: true, discardPaths: [] }
          const receipt = await this.executeRemoval(preview.preparationId, `auto-${p.preparationId}`, consent, { worktreeId: p.worktreeId, policyRevision: policy.revision, workspaceRevision: entry.workspaceRevision })
          receipts.push(receipt); outcome = { state: receipt.state, code: receipt.code, observedAt: new Date().toISOString() }
        } catch (error) { outcome.code = error instanceof Error ? error.message : 'REMOVAL_UNAVAILABLE' }
        const common = realpathSync(await this.git.getCommonDirectory(this.root)), admin = realpathSync(await this.git.getWorktreeDirectory(this.root))
        await withWorktreeTransaction(common, admin, async () => {
          this.current()
          const current = lifecycle.removalPolicy(this.repositoryId)
          if (!current.enabled || current.revision !== policy.revision) return
          const enrolled = current.enrollments.find(candidate => candidate.preview.preparationId === p.preparationId)
          if (enrolled) { enrolled.lastResult = outcome; lifecycle.saveRemovalPolicy(current) }
        })
      }
      return receipts
    } finally { this.automaticRunning = false }
  }

  async prepareRemoval(worktreeId: string, generation: string, intent: RemovalIntent, prNumber?: number): Promise<RemovalPreview> {
    if (prNumber !== undefined) {
      const evidence = await this.ports.delivery(prNumber)
      if (evidence.status !== 'OBSERVED') throw new Error('REMOVAL_PROVIDER_UNAVAILABLE')
      intent = { ...intent, delivery: evidence.delivery, noPullRequestConfirmed: false }
    }
    const observation = await this.observe(worktreeId, generation, intent)
    const { record, blockers, content, revision } = observation
    const preview: RemovalPreview = { managed: !!new GitWorktreeLifecycle(observation.common).get(record), preparationId: randomUUID(), repositoryId: this.repositoryId, worktreeId, generation, path: record.path,
      branch: record.branch, head: record.head, fingerprint: revision, expiresAt: new Date(Date.now() + 120000).toISOString(), state: blockers.length ? 'BLOCKED' : 'PREPARING',
      blockers, content, preservedRef: record.branch ? `refs/heads/${record.branch}` : null, intent, observedAt: new Date().toISOString() }
    const lifecycle = await this.store()
    await withWorktreeTransaction(observation.common, observation.admin, async () => {
      this.current()
      lifecycle.saveRemoval({ preview, revision, administrativeDirectory: observation.admin, state: 'PREPARED' })
    })
    return preview
  }

  async cancelPreparation(id: string) {
    const lifecycle = await this.store(), stored = lifecycle.removal(id)
    if (stored.preview.repositoryId !== this.repositoryId) throw new Error('WORKTREE_IDENTITY_MISMATCH')
    const common = realpathSync(await this.git.getCommonDirectory(this.root)), admin = realpathSync(await this.git.getWorktreeDirectory(this.root))
    return withWorktreeTransaction(common, admin, async () => {
      const current = lifecycle.removal(id)
      this.current()
      if (!['PREPARED', 'CANCELLED'].includes(current.state)) throw new Error('REMOVAL_ALREADY_STARTED')
      current.state = 'CANCELLED'; lifecycle.saveRemoval(current)
      const policy = lifecycle.removalPolicy(this.repositoryId)
      policy.enrollments = policy.enrollments.filter(entry => entry.preview.preparationId !== id)
      lifecycle.saveRemovalPolicy(policy)
      return { state: 'CANCELLED' as const }
    })
  }

  private consent(preview: RemovalPreview, consent: RemovalConsent): void {
    if (!consent || consent.fingerprint !== preview.fingerprint || consent.exactPath !== preview.path || consent.ownerReleased !== true || consent.operatorIsOwner !== true || consent.noKnownWriter !== true) throw new Error('REMOVAL_OWNER_CONFIRMATION_REQUIRED')
    const expected = preview.content.filter(file => file.kind !== 'TRACKED').map(file => file.path)
    if (!Array.isArray(consent.discardPaths) || expected.some(path => !consent.discardPaths.includes(path)) || consent.discardPaths.some(path => !preview.content.some(file => file.path === path))) throw new Error('REMOVAL_CONTENT_CLASSIFICATION_REQUIRED')
  }

  async executeRemoval(id: string, operationId: string, consent: RemovalConsent, automatic?: { worktreeId: string; policyRevision: string; workspaceRevision: string }): Promise<RemovalReceipt> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(operationId)) throw new Error('INVALID_ARGUMENT')
    const lifecycle = await this.store(), initial = lifecycle.removal(id), preview = initial.preview
    if (preview.repositoryId !== this.repositoryId) throw new Error('WORKTREE_IDENTITY_MISMATCH')
    if (initial.operationId) {
      if (initial.operationId !== operationId || initial.consentDigest !== ownershipDigest(consent)) throw new Error('IDEMPOTENCY_CONFLICT')
      return initial.receipt ?? { operationId, preparationId: id, state: 'UNKNOWN', code: 'RECONCILE_OPERATION', path: preview.path, preservedRef: preview.preservedRef }
    }
    this.consent(preview, consent)
    if (initial.state !== 'PREPARED' || preview.state !== 'PREPARING') throw new Error('REMOVAL_NOT_PREPARED')
    if (!automatic && !await this.ports.approve(preview, consent)) throw new Error('REMOVAL_APPROVAL_DENIED')
    const observation = await this.observe(preview.worktreeId, preview.generation, preview.intent)
    return withWorktreeTransaction(observation.common, observation.admin, async () => {
      const stored = lifecycle.removal(id)
      if (stored.state !== 'PREPARED') throw new Error('REMOVAL_ALREADY_STARTED')
      if (Date.now() >= Date.parse(preview.expiresAt)) throw new Error('REMOVAL_PREPARATION_EXPIRED')
      const fresh = await this.observe(preview.worktreeId, preview.generation, preview.intent)
      if (fresh.revision !== stored.revision || fresh.blockers.length) throw new Error('REMOVAL_PREVIEW_STALE')
      if (automatic) {
        const policy = lifecycle.removalPolicy(this.repositoryId)
        const enrollment = policy.enrollments.find(entry => entry.preview.worktreeId === automatic.worktreeId && entry.policyRevision === policy.revision && entry.workspaceRevision === fresh.workspaceRevision)
        if (!policy.enabled || policy.revision !== automatic.policyRevision || fresh.workspaceRevision !== automatic.workspaceRevision ||
          !enrollment || lifecycle.removal(enrollment.preview.preparationId).state !== 'PREPARED' ||
          !lifecycle.get(fresh.record) || dirname(fresh.record.path) !== join(fresh.common, 'code-awareness-workspaces') || fresh.content.some(file => file.kind !== 'TRACKED')) throw new Error('REMOVAL_AUTO_AUTHORITY_REVOKED')
      }
      const { service } = await this.operations.selectWorktree(preview.worktreeId)
      const dirty = await service.getChanges()
      if (dirty.some(change => !consent.discardPaths.includes(change.path))) throw new Error('REMOVAL_CONTENT_CLASSIFICATION_REQUIRED')
      const globalReceipt = await this.git.prepareOperationReceipt(this.root, { operationId, operation: 'execute_worktree_removal',
        argumentFingerprint: ownershipDigest({ repositoryId: this.repositoryId, preparationId: id, consent }), status: 'PREPARED', createdAt: new Date().toISOString() })
      if (!globalReceipt.created) throw new Error('IDEMPOTENCY_CONFLICT')
      const final = await this.observe(preview.worktreeId, preview.generation, preview.intent, fresh.evidence)
      if (final.revision !== stored.revision || final.blockers.length) throw new Error('REMOVAL_PREVIEW_STALE')
      if (Date.now() >= Date.parse(preview.expiresAt)) throw new Error('REMOVAL_PREPARATION_EXPIRED')
      if (final.evidence && Date.now() - Date.parse(final.evidence.observedAt) > 30000) throw new Error('REMOVAL_PROVIDER_STALE')
      stored.operationId = operationId; stored.consentDigest = ownershipDigest(consent); stored.state = 'EXECUTING'
      lifecycle.saveRemoval(stored)
      const enrollment = automatic ? lifecycle.removalPolicy(this.repositoryId).enrollments.find(entry => entry.preview.worktreeId === automatic.worktreeId) : undefined
      const enrolledPreparation = enrollment ? lifecycle.removal(enrollment.preview.preparationId) : undefined
      if (enrolledPreparation) { enrolledPreparation.state = 'EXECUTING'; lifecycle.saveRemoval(enrolledPreparation) }
      let receipt: RemovalReceipt
      try {
        assertRemovalPath(preview.path)
        this.current()
        await this.git.removeReviewedWorktree(this.root, preview.path, dirty.length > 0 || preview.content.some(file => file.kind !== 'TRACKED'))
        const discovery = await this.operations.worktrees!.discover()
        const absent = !existsSync(preview.path) && !discovery.worktrees.some(record => resolve(record.path) === resolve(preview.path))
        const retained = preview.preservedRef && await this.git.resolveCommit(this.root, preview.preservedRef) === preview.head
        receipt = { operationId, preparationId: id, state: absent && retained ? 'CLOSED' : 'UNKNOWN', path: preview.path, preservedRef: preview.preservedRef }
      } catch (error) {
        receipt = { operationId, preparationId: id, state: 'UNKNOWN', code: error instanceof Error ? error.message : 'REMOVAL_FAILED', path: preview.path, preservedRef: preview.preservedRef }
      }
      if (receipt.state === 'CLOSED') {
        try {
          await this.git.completeOperationReceipt(this.root, { ...globalReceipt.receipt, status: 'COMPLETED', completedAt: new Date().toISOString(),
            result: { content: [{ type: 'text', text: JSON.stringify(receipt) }] } }, globalReceipt.sha)
        } catch { receipt = { ...receipt, state: 'UNKNOWN', code: 'REMOVAL_RECEIPT_PERSISTENCE_UNCONFIRMED' } }
      }
      stored.state = receipt.state; stored.receipt = receipt; lifecycle.saveRemoval(stored)
      if (enrolledPreparation) { enrolledPreparation.state = receipt.state; enrolledPreparation.receipt = receipt; lifecycle.saveRemoval(enrolledPreparation) }
      if (receipt.state === 'CLOSED') {
        const managed = lifecycle.get(fresh.record)
        if (managed) lifecycle.save({ ...managed, closedAt: new Date().toISOString() })
      }
      return receipt
    })
  }

  async reconcileReceipt(id: string, operationId: string): Promise<RemovalReceipt> {
    const lifecycle = await this.store(), stored = lifecycle.removal(id), preview = stored.preview
    if (preview.repositoryId !== this.repositoryId || stored.operationId !== operationId) throw new Error('REMOVAL_RECEIPT_NOT_FOUND')
    const common = realpathSync(await this.git.getCommonDirectory(this.root)), admin = realpathSync(await this.git.getWorktreeDirectory(this.root))
    if (existsSync(join(common, 'code-awareness-worktrees.lock'))) {
      if (!stored.administrativeDirectory || dirname(stored.administrativeDirectory) !== join(common, 'worktrees') || !await this.ports.approveRecovery?.(preview)) throw new Error('WORKTREE_RECOVERY_REQUIRED')
      this.current()
      reconcileAbandonedLocks({ commonDirectory: common, administrativeDirectory: stored.administrativeDirectory, worktreeId: preview.worktreeId })
    }
    return withWorktreeTransaction(common, admin, async () => {
      const discovery = await this.operations.worktrees!.discover()
      const absent = !existsSync(preview.path) && !discovery.worktrees.some(record => resolve(record.path) === resolve(preview.path))
      const retained = preview.preservedRef && await this.git.resolveCommit(this.root, preview.preservedRef) === preview.head
      this.current()
      const receipt: RemovalReceipt = { operationId, preparationId: id, state: absent && retained ? 'CLOSED' : 'UNKNOWN', path: preview.path, preservedRef: preview.preservedRef }
      if (receipt.state === 'CLOSED') {
        const global = await this.git.readOperationReceipt(this.root, operationId)
        if (global?.receipt.operation !== 'execute_worktree_removal') throw new Error('REMOVAL_RECEIPT_NOT_FOUND')
        if (global.receipt.status === 'PREPARED') await this.git.completeOperationReceipt(this.root, { ...global.receipt, status: 'COMPLETED', completedAt: new Date().toISOString(),
          result: { content: [{ type: 'text', text: JSON.stringify(receipt) }] } }, global.sha)
      }
      stored.state = receipt.state; stored.receipt = receipt; lifecycle.saveRemoval(stored)
      return receipt
    })
  }
}
