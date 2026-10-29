import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { PullRequestError, type PullRequestContext, type PullRequestMutationInput, type PullRequestMutationApproval, type PullRequestOperationResult, type PullRequestSummary } from '../../shared/types/github-pr-types'
import type { GitHubApiClient } from './github-api-client'
import { claim, hash, type PullRequestDependencies, type PullRequestExecutionContext } from './github-pull-requests'
import { summarizePullRequestChecks } from './github-pr-evidence'

type Operation = PullRequestMutationApproval['operation']
interface Receipt {
  operation: Operation
  fingerprint: string
  input: PullRequestMutationInput & { expectedBaseSha: string }
  context: PullRequestContext
  head: PullRequestSummary['head']
  base: PullRequestSummary['base']
  mergeMethod: 'merge' | 'QUEUE_CONTROLLED' | null
  mergeAction: 'default' | null
  mayEnqueue: boolean
  expiresAt: string
  preparedAt: string
  stage: 'PREPARED'
}
interface Observation { uuid?: string; providerState?: string; reason?: string; status?: PullRequestOperationResult['status']; headSha?: string; baseSha?: string; mergeCommitSha?: string; observedAt?: string }
const concurrency = 'PROVIDER_RULES_NO_ATOMIC_BASE_CAS' as const

export class GitHubPrIntegration {
  constructor(private readonly api: GitHubApiClient, private readonly resolve: () => Promise<PullRequestContext>, private readonly dependencies?: PullRequestDependencies) {}

  async mutate(operation: Operation, input: PullRequestMutationInput, execution: PullRequestExecutionContext): Promise<PullRequestOperationResult> {
    validateMutation(input, operation === 'MERGE_PULL_REQUEST')
    const context = await this.resolve()
    if (!this.dependencies?.approveMutation) throw new PullRequestError('AUTHORIZATION_REQUIRED')
    const directory = join(this.dependencies.receiptDirectory, hash(context.repositoryId))
    const path = join(directory, `${hash(input.operationId)}.json`)
    const fingerprint = hash(JSON.stringify([operation, context.repositoryId, context.repository.toLowerCase(), input.prNumber, input.expectedHeadSha, input.expectedBaseSha]))
    const existing = this.read(path)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new PullRequestError('IDEMPOTENCY_CONFLICT')
      return this.reconcile(existing, path)
    }
    const before = await this.preflight(operation, input, context)
    const boundInput = { ...input, expectedBaseSha: before.pr.base.sha }
    const expiresAt = new Date(Date.now() + 120_000).toISOString()
    const approval: PullRequestMutationApproval = { ...boundInput, ...context, operation, headBranch: before.pr.head.ref, baseBranch: before.pr.base.ref, observedState: 'OPEN', mayEnqueue: before.queue, baseConcurrency: concurrency, expiresAt,
      ...(operation === 'MERGE_PULL_REQUEST' ? { mergeMethod: before.queue ? 'QUEUE_CONTROLLED' as const : 'merge' as const, mergeAction: 'default' as const } : {}) }
    if (!await this.dependencies.approveMutation(approval)) throw new PullRequestError('AUTHORIZATION_DENIED')
    const assertActive = () => {
      if (Date.now() >= Date.parse(expiresAt)) throw new PullRequestError('AUTHORIZATION_EXPIRED')
      if (!execution.isActive()) throw new PullRequestError('PROJECT_CHANGED')
    }
    assertActive()
    const beforeSend = async () => {
      assertActive()
      const latest = await this.resolve()
      if (JSON.stringify(latest) !== JSON.stringify(context)) throw new PullRequestError('PROJECT_CHANGED')
      const proof = await this.preflight(operation, boundInput, context)
      if (proof.queue !== before.queue || proof.pr.head.ref !== before.pr.head.ref || proof.pr.base.ref !== before.pr.base.ref) throw new PullRequestError('PR_IDENTITY_CONFLICT')
      assertActive()
    }
    const current = await this.resolve()
    if (JSON.stringify(current) !== JSON.stringify(context)) throw new PullRequestError('PROJECT_CHANGED')
    const after = await this.preflight(operation, boundInput, context)
    if (after.queue !== before.queue || after.pr.head.ref !== before.pr.head.ref || after.pr.base.ref !== before.pr.base.ref) throw new PullRequestError('PR_IDENTITY_CONFLICT')
    assertActive()
    const receipt: Receipt = { operation, fingerprint, input: boundInput, context, head: after.pr.head, base: after.pr.base, mergeMethod: approval.mergeMethod ?? null, mergeAction: approval.mergeAction ?? null, mayEnqueue: approval.mayEnqueue, expiresAt, preparedAt: new Date().toISOString(), stage: 'PREPARED' }
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      if (!claim(path, receipt)) throw new PullRequestError('OUTCOME_UNKNOWN')
      if (!claim(join(directory, `pr-${input.prNumber}.json`), { operationId: input.operationId, fingerprint })) throw new PullRequestError('OPERATION_CONFLICT')
    } catch (error) {
      if (error instanceof PullRequestError) throw error
      throw new PullRequestError('RECEIPT_UNAVAILABLE')
    }
    try {
      if (operation === 'CLOSE_PULL_REQUEST') await this.api.closePullRequest(context.repository, input.prNumber, beforeSend)
      else {
        const response = await this.api.requestPullRequestMerge(context.repository, input.prNumber, input.expectedHeadSha, after.queue, beforeSend)
        if (response.httpStatus === 409) this.observe(path, { reason: 'FOREIGN_PENDING_REQUEST' })
        else if ([400, 403, 404, 422].includes(response.httpStatus)) this.observe(path, { providerState: 'failed', reason: `PROVIDER_HTTP_${response.httpStatus}` })
        else {
          const value = response.value
          const uuid = value?.details?.uuid
          if (response.httpStatus === 202 && value.status === 'pending' && typeof uuid === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(uuid) && value.details.expected_head_sha === input.expectedHeadSha && value.details.bypass_rules === false && value.details.merge_action === 'default' && value.details.merge_method === 'merge') this.observe(path, { uuid, providerState: 'pending' })
          else if (response.httpStatus === 200 && ['merged', 'enqueued'].includes(value?.status)) this.observe(path, { providerState: value.status })
          else this.observe(path, { reason: 'PROVIDER_RECEIPT_UNAVAILABLE' })
        }
      }
    } catch {
      this.observe(path, { reason: 'REQUEST_OUTCOME_UNCERTAIN' })
    }
    return this.reconcile(receipt, path)
  }

  async status(operationId: string): Promise<PullRequestOperationResult> {
    validateOperationId(operationId)
    const context = await this.resolve()
    if (!this.dependencies) throw new PullRequestError('OPERATION_NOT_FOUND')
    const path = join(this.dependencies.receiptDirectory, hash(context.repositoryId), `${hash(operationId)}.json`)
    const receipt = this.read(path)
    if (!receipt || !['MERGE_PULL_REQUEST', 'CLOSE_PULL_REQUEST'].includes(receipt.operation)) throw new PullRequestError('OPERATION_NOT_FOUND')
    if (receipt.context.repository.toLowerCase() !== context.repository.toLowerCase()) throw new PullRequestError('PROJECT_CHANGED')
    return this.reconcile(receipt, path)
  }

  private async preflight(operation: Operation, input: PullRequestMutationInput, context: PullRequestContext) {
    const permissions = await this.api.getPullRequestEndpointPermissions(context.repository)
    if (!permissions.read || !(operation === 'MERGE_PULL_REQUEST' ? permissions.merge && permissions.checks && permissions.statuses : permissions.close)) throw new PullRequestError('PERMISSION_REQUIRED')
    const pr = await this.api.getPullRequest(context.repository, input.prNumber)
    if (pr.head.repository.toLowerCase() !== context.repository.toLowerCase() || pr.base.repository.toLowerCase() !== context.repository.toLowerCase()) throw new PullRequestError('PR_IDENTITY_CONFLICT')
    if (pr.state !== 'open' || pr.mergedAt) throw new PullRequestError('PR_NOT_OPEN')
    if (pr.head.sha !== input.expectedHeadSha || await this.api.getBranchSha(context.repository, pr.head.ref) !== input.expectedHeadSha) throw new PullRequestError('HEAD_DRIFT')
    const expectedBaseSha = input.expectedBaseSha ?? pr.base.sha
    if (pr.base.sha !== expectedBaseSha || await this.api.getBranchSha(context.repository, pr.base.ref) !== expectedBaseSha) throw new PullRequestError('BASE_DRIFT')
    if (operation === 'CLOSE_PULL_REQUEST') return { pr, queue: false }
    if (pr.draft) throw new PullRequestError('DRAFT_PR')
    if (pr.mergeability === 'NOT_MERGEABLE') throw new PullRequestError('POLICY_BLOCKED')
    if (pr.stack === 'PRESENT') throw new PullRequestError('STACKED_PR_UNSUPPORTED')
    if (pr.stack !== 'NONE') {
      const evidence = await this.api.getPullRequestStackEvidence(context.repository, pr)
      if (evidence.state !== 'NONE') throw new PullRequestError(evidence.state === 'PRESENT' ? 'STACKED_PR_UNSUPPORTED' : 'STACK_UNKNOWN', evidence)
    }
    const policy = await this.api.getPullRequestPolicy(context.repository, pr.base.ref)
    if (policy.coverage !== 'COMPLETE') throw new PullRequestError('POLICY_UNKNOWN')
    if (!policy.mergeCommitAllowed || (policy.queue && policy.queueMethod !== 'merge')) throw new PullRequestError('METHOD_NOT_ALLOWED')
    const reviews = await this.api.getPullRequestReviews(context.repository, input.prNumber)
    const checks = await this.api.getPullRequestChecks(context.repository, input.prNumber)
    if (reviews.headSha !== input.expectedHeadSha || checks.headSha !== input.expectedHeadSha) throw new PullRequestError('HEAD_DRIFT')
    if (reviews.completeness !== 'COMPLETE' || reviews.decision === 'CHANGES_REQUESTED' || reviews.approvalCount < policy.requiredApprovals) throw new PullRequestError('REVIEWS_NOT_READY')
    const checkState = summarizePullRequestChecks(checks.checks, checks.completeness === 'COMPLETE', policy.requiredChecks)
    if (checkState.requirements === 'UNKNOWN' || checkState.requirements === 'NOT_SATISFIED' || ['FAILED', 'PENDING', 'UNKNOWN'].includes(checkState.state)) throw new PullRequestError('CHECKS_NOT_READY')
    return { pr, queue: policy.queue }
  }

  private async reconcile(receipt: Receipt, path: string): Promise<PullRequestOperationResult> {
    const observations = this.observations(path)
    const own = observations.find(item => item.uuid)
    let status: PullRequestOperationResult['status'] = 'OUTCOME_UNKNOWN'
    if (observations.some(item => item.providerState === 'enqueued')) status = 'ENQUEUED'
    if (observations.some(item => item.providerState === 'failed')) status = 'FAILED'
    if (observations.some(item => item.status === 'FAILED')) status = 'FAILED'
    let reason = observations.at(-1)?.reason
    if (own?.uuid) {
      try {
        const response = await this.api.getPullRequestMergeRequest(receipt.context.repository, receipt.input.prNumber, own.uuid)
        if (response.response.status === 404) reason = 'REQUEST_EXPIRED_OR_UNAVAILABLE'
        else {
          const value = response.value
          if (value?.status === 'pending' && value.details?.uuid === own.uuid && value.details?.expected_head_sha === receipt.input.expectedHeadSha && value.details?.bypass_rules === false && value.details?.merge_action === 'default' && value.details?.merge_method === 'merge') status = 'PENDING'
          else if (value?.status === 'enqueued') status = 'ENQUEUED'
          else if (value?.status === 'failed') { status = 'FAILED'; reason = 'PROVIDER_REJECTED' }
        }
      } catch { reason = 'REQUEST_STATUS_UNAVAILABLE' }
    }
    let pr: PullRequestSummary | undefined
    try { pr = await this.api.getPullRequest(receipt.context.repository, receipt.input.prNumber) } catch { reason = 'PR_STATUS_UNAVAILABLE' }
    const matches = pr && pr.head.repository.toLowerCase() === receipt.context.repository.toLowerCase() && pr.base.repository.toLowerCase() === receipt.context.repository.toLowerCase() && pr.head.ref === receipt.head.ref && pr.base.ref === receipt.base.ref && pr.head.sha === receipt.input.expectedHeadSha
    if (pr && !matches) { status = 'OUTCOME_UNKNOWN'; reason = 'PR_IDENTITY_OR_HEAD_CHANGED' }
    else if (matches && pr) {
      if (pr.mergedAt && pr.mergeCommitSha) status = 'MERGED'
      else if (pr.state === 'closed' && !pr.mergedAt) status = 'CLOSED'
    }
    if (['MERGED', 'CLOSED', 'FAILED'].includes(status) && this.dependencies) {
      const fence = join(this.dependencies.receiptDirectory, hash(receipt.context.repositoryId), `pr-${receipt.input.prNumber}.json`)
      try {
        if (claim(`${fence}.${hash(receipt.input.operationId)}.released`, { operationId: receipt.input.operationId })) {
          const owner = JSON.parse(readFileSync(fence, 'utf8'))
          if (owner.fingerprint === receipt.fingerprint && owner.operationId === receipt.input.operationId) unlinkSync(fence)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new PullRequestError('RECEIPT_UNAVAILABLE')
      }
    }
    this.observe(path, { status, ...(reason ? { reason } : {}), ...(pr ? { headSha: pr.head.sha, baseSha: pr.base.sha } : {}), ...(status === 'MERGED' && pr?.mergeCommitSha ? { mergeCommitSha: pr.mergeCommitSha } : {}) })
    return { operationId: receipt.input.operationId, operation: receipt.operation, repository: receipt.context.repository, prNumber: receipt.input.prNumber,
      status, head: pr?.head ?? receipt.head, base: pr?.base ?? receipt.base, ...(own?.uuid ? { uuid: own.uuid } : {}), ...(status === 'MERGED' && pr?.mergeCommitSha ? { mergeCommitSha: pr.mergeCommitSha } : {}), ...(reason ? { reason } : {}), observedAt: new Date().toISOString(), nextAction: ['MERGED', 'CLOSED', 'FAILED'].includes(status) ? 'NONE' : own?.uuid ? 'READ_OPERATION_STATUS' : 'INSPECT_PR', localGitChanged: false, baseConcurrency: concurrency }
  }

  private read(path: string): Receipt | null {
    try { return JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new PullRequestError('RECEIPT_UNAVAILABLE')
    }
  }
  private observations(path: string): Observation[] {
    try { return readFileSync(`${path}.observations`, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new PullRequestError('RECEIPT_UNAVAILABLE')
    }
  }
  private observe(path: string, value: Observation) {
    const descriptor = openSync(`${path}.observations`, 'a', 0o600)
    try { appendFileSync(descriptor, `${JSON.stringify({ ...value, observedAt: new Date().toISOString() })}\n`); fsyncSync(descriptor) } finally { closeSync(descriptor) }
  }
}

export function validateOperationId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new PullRequestError('INVALID_ARGUMENT')
}
export function validateMutation(input: PullRequestMutationInput, requireBase = true) {
  validateOperationId(input.operationId)
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0 || !/^[a-f0-9]{40}$/.test(input.expectedHeadSha) || ((requireBase || input.expectedBaseSha !== undefined) && !/^[a-f0-9]{40}$/.test(input.expectedBaseSha ?? ''))) throw new PullRequestError('INVALID_ARGUMENT')
}
