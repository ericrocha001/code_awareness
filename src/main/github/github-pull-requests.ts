import { sameDeliveryScope, deliveryAnchor, deliveryContextRequest, resolveEffectiveDeliveryContext, type DeliveryAnchor, type DeliveryContextRequest, type DeliveryProjectionPage } from '../../shared/types/delivery-context-types'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, renameSync, lstatSync, readdirSync }  from 'node:fs'
import { join } from 'node:path'
import { PullRequestError, type CreatePullRequestInput, type PullRequestApproval, type PullRequestContext, type PullRequestSummary } from '../../shared/types/github-pr-types'
import type { GitHubApiClient } from './github-api-client'
import type { PullRequestMutationApproval } from '../../shared/types/github-pr-types'
import { GitHubIntegrationError, githubErrorMessage } from './github-errors'

export interface PullRequestDependencies {
  receiptDirectory: string
  approve(request: PullRequestApproval): Promise<boolean>
  approveMutation?(request: PullRequestMutationApproval): Promise<boolean>
  onDeliveryObserved?(repositoryId: string): void
}

export interface PullRequestExecutionContext {
  prepareDelivery?(request: DeliveryContextRequest, worktreeId?: string): Promise<DeliveryAnchor>
  resolveDelivery?(request?: DeliveryContextRequest, worktreeId?: string): Promise<DeliveryAnchor | undefined>
  defaultDeliveryContext?: DeliveryContextRequest
  deliveryContextError?: string
  defaultWorktreeId?: string
  isActive(): boolean
  inspectWorktree?(id: string): Promise<{ branch: string | null; head: string | null }>
}

export class GitHubPullRequests {
  constructor(
    private readonly api: GitHubApiClient,
    private readonly resolve: () => Promise<PullRequestContext>,
    private readonly dependencies?: PullRequestDependencies
  ) {}

  async create(input: CreatePullRequestInput, execution: PullRequestExecutionContext) {
    validateCreatePullRequest(input)
    const resolvedDelivery = resolveEffectiveDeliveryContext(input.deliveryContext, execution.defaultDeliveryContext, execution.deliveryContextError)
    if (!resolvedDelivery.ok) throw new PullRequestError('DELIVERY_CONTEXT_INVALID')
    if (execution.defaultWorktreeId && input.worktreeId && execution.defaultWorktreeId !== input.worktreeId) throw new PullRequestError('DELIVERY_CONTEXT_INVALID')
    const effectiveInput: CreatePullRequestInput = {
      ...input,
      ...(resolvedDelivery.request ? { deliveryContext: resolvedDelivery.request } : {}),
      ...(input.worktreeId ?? execution.defaultWorktreeId ? { worktreeId: input.worktreeId ?? execution.defaultWorktreeId } : {})
    }
    const context = await this.resolve()
    const fingerprint = hash(JSON.stringify([context.repositoryId, context.repository.toLowerCase(), effectiveInput.headBranch, effectiveInput.baseBranch, effectiveInput.expectedHeadSha, effectiveInput.title, effectiveInput.body, effectiveInput.worktreeId ?? null, ...(effectiveInput.deliveryContext ? [deliveryContextRequest.parse(effectiveInput.deliveryContext)] : [])]))
    if (!this.dependencies) throw new PullRequestError('AUTHORIZATION_REQUIRED')
    const directory = join(this.dependencies.receiptDirectory, hash(context.repositoryId))
    const operationPath = join(directory, `${hash(effectiveInput.operationId)}.json`)
    let previous: { fingerprint: string; operationId?: string; completedAt?: string; deliveryContext?: unknown; createdNumber?: number } | null
    try { previous = JSON.parse(readFileSync(operationPath, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new PullRequestError('RECEIPT_UNAVAILABLE')
      previous = null
    }
    if (previous && previous.fingerprint !== fingerprint) throw new PullRequestError('IDEMPOTENCY_CONFLICT')
    await this.verify(context, effectiveInput, execution, false)
    const existing = await this.reconcile(context, effectiveInput)
    if (existing) {
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        if (!previous && !claim(operationPath, { fingerprint, operationId: effectiveInput.operationId, operation: 'CREATE_PULL_REQUEST', observedAt: new Date().toISOString() })) {
          const raced = JSON.parse(readFileSync(operationPath, 'utf8'))
          if (raced.fingerprint !== fingerprint) throw new PullRequestError('IDEMPOTENCY_CONFLICT')
        } else if (previous && !previous.completedAt && previous.operationId === effectiveInput.operationId && previous.createdNumber === existing.number) {
          await this.finalizeReceipt(operationPath, fingerprint, existing, execution, Boolean(previous.deliveryContext))
        }
      } catch (error) {
        if (error instanceof PullRequestError) throw error
        throw new PullRequestError('RECEIPT_UNAVAILABLE')
      }
      return { status: 'EXISTING_OPEN' as const, operationId: effectiveInput.operationId, replayed: !!previous, pullRequest: existing }
    }
    if (previous) throw new PullRequestError('OUTCOME_UNKNOWN')
    await this.verify(context, effectiveInput, execution)
    const expiresAt = new Date(Date.now() + 120_000).toISOString()
    const granted = await this.dependencies.approve({ ...effectiveInput, ...context, operation: 'CREATE_PULL_REQUEST', expiresAt })
    if (!granted) throw new PullRequestError('AUTHORIZATION_DENIED')
    if (Date.now() >= Date.parse(expiresAt)) throw new PullRequestError('AUTHORIZATION_EXPIRED')
    const current = await this.resolve()
    if (current.repositoryId !== context.repositoryId || current.repository !== context.repository) throw new PullRequestError('PROJECT_CHANGED')
    await this.verify(context, effectiveInput, execution)
    const raced = await this.reconcile(context, effectiveInput)
    if (raced) return { status: 'EXISTING_OPEN' as const, operationId: effectiveInput.operationId, replayed: false, pullRequest: raced }
    if (Date.now() >= Date.parse(expiresAt)) throw new PullRequestError('AUTHORIZATION_EXPIRED')
    if (!execution.isActive()) throw new PullRequestError('PROJECT_CHANGED')
    let anchor: DeliveryAnchor | undefined
    if (effectiveInput.deliveryContext) {
      if (!execution.prepareDelivery) throw new PullRequestError('DELIVERY_CONTEXT_INVALID')
      anchor = await execution.prepareDelivery(effectiveInput.deliveryContext, effectiveInput.worktreeId)
      if (anchor.repositoryId !== context.repositoryId || anchor.snapshot.head !== effectiveInput.expectedHeadSha || anchor.snapshot.branchRef !== 'refs/heads/' + effectiveInput.headBranch || effectiveInput.worktreeId && anchor.snapshot.worktreeId !== effectiveInput.worktreeId) throw new PullRequestError('DELIVERY_CONTEXT_STALE')
    } else if (effectiveInput.worktreeId && execution.resolveDelivery) {
      anchor = await execution.resolveDelivery(undefined, effectiveInput.worktreeId)
      if (anchor && (anchor.repositoryId !== context.repositoryId || anchor.snapshot.head !== effectiveInput.expectedHeadSha || anchor.snapshot.branchRef !== 'refs/heads/' + effectiveInput.headBranch || anchor.snapshot.worktreeId !== effectiveInput.worktreeId)) throw new PullRequestError('DELIVERY_CONTEXT_STALE')
    }
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      if (!claim(operationPath, { fingerprint, operationId: effectiveInput.operationId, ...(anchor ? { deliveryContext: anchor } : { deliveryStatus: 'UNBOUND' }), operation: 'CREATE_PULL_REQUEST', preparedAt: new Date().toISOString() })) throw new PullRequestError('OUTCOME_UNKNOWN')
      // A persistent head claim fences other operation IDs and process restarts after an uncertain POST.
      if (!claim(join(directory, `head-${hash(context.repository.toLowerCase() + ':' + effectiveInput.headBranch)}.json`), { operationId: effectiveInput.operationId, fingerprint })) throw new PullRequestError('OUTCOME_UNKNOWN')
    } catch (error) {
      if (error instanceof PullRequestError) throw error
      throw new PullRequestError('RECEIPT_UNAVAILABLE')
    }
    try {
      const created = await this.api.createPullRequest(context.repository, effectiveInput, () => {
        if (Date.now() >= Date.parse(expiresAt)) throw new PullRequestError('AUTHORIZATION_EXPIRED')
        if (!execution.isActive()) throw new PullRequestError('PROJECT_CHANGED')
      })
      try {
        const currentReceipt = JSON.parse(readFileSync(operationPath, 'utf8'))
        if (currentReceipt.fingerprint === fingerprint && currentReceipt.createdNumber === undefined) {
          const witnessTmp = operationPath + '.' + randomUUID() + '.tmp'
          if (claim(witnessTmp, { ...currentReceipt, createdNumber: created.number })) renameSync(witnessTmp, operationPath)
        }
      } catch {}
      const verified = await this.api.getPullRequest(context.repository, created.number)
      this.assertCompatible(context, effectiveInput, verified)
      const reconciled = await this.reconcile(context, effectiveInput)
      if (!reconciled || reconciled.number !== verified.number) throw new PullRequestError('PR_IDENTITY_CONFLICT')
      await this.finalizeReceipt(operationPath, fingerprint, reconciled, execution, Boolean(anchor))
      try { this.dependencies.onDeliveryObserved?.(context.repositoryId) }
      catch { console.warn('[GitHub] DELIVERY_PROJECTION_REQUEST_FAILED') }
      return { status: 'CREATED' as const, operationId: effectiveInput.operationId, replayed: false, pullRequest: reconciled }
    } catch (error) {
      if (error instanceof PullRequestError && ['AUTHORIZATION_EXPIRED', 'PROJECT_CHANGED'].includes(error.code)) throw error
      try {
        const recovered = await this.reconcile(context, effectiveInput)
        if (recovered) {
          await this.finalizeReceipt(operationPath, fingerprint, recovered, execution, Boolean(anchor))
          try { this.dependencies.onDeliveryObserved?.(context.repositoryId) }
          catch { console.warn('[GitHub] DELIVERY_PROJECTION_REQUEST_FAILED') }
          return { status: 'EXISTING_OPEN' as const, operationId: effectiveInput.operationId, replayed: true, pullRequest: recovered }
        }
      } catch (error) {
        if (error instanceof PullRequestError && ['PR_IDENTITY_CONFLICT', 'CLOSED_PR_REQUIRES_DECISION'].includes(error.code)) throw error
      }
      throw new PullRequestError('OUTCOME_UNKNOWN')
    }
  }

  private async finalizeReceipt(path: string, fingerprint: string, pr: PullRequestSummary, execution: PullRequestExecutionContext, hasAnchor: boolean) {
    const receipt = JSON.parse(readFileSync(path, 'utf8'))
    if (receipt.fingerprint !== fingerprint || receipt.completedAt) return
    let deliveryVerified = false
    const parsed = deliveryAnchor.safeParse(receipt.deliveryContext)
    if (hasAnchor && parsed.success && (execution.resolveDelivery || execution.prepareDelivery)) {
      const req = { bindingArtifactId: parsed.data.bindingArtifactId, bindingRevision: parsed.data.bindingRevision, planArtifactId: parsed.data.planArtifactId, planRevision: parsed.data.planRevision, executionId: parsed.data.executionId }
      try {
        const after = execution.prepareDelivery
          ? await execution.prepareDelivery(req, parsed.data.snapshot.worktreeId)
          : await execution.resolveDelivery!(req, parsed.data.snapshot.worktreeId)
        deliveryVerified = Boolean(after) && sameDeliveryScope(parsed.data, after!) && after!.snapshot.head === pr.head.sha
      } catch {}
    }
    const temporary = path + '.' + randomUUID() + '.tmp'
    const deliveryFields = parsed.success ? { deliveryVerified, deliveryStatus: deliveryVerified ? 'VERIFIED' : 'UNVERIFIED' } : { deliveryStatus: 'UNBOUND' }
    if (!claim(temporary, { ...receipt, ...deliveryFields, status: 'COMPLETED', completedAt: new Date().toISOString(), result: { number: pr.number, repository: pr.head.repository, headSha: pr.head.sha } })) throw new PullRequestError('RECEIPT_UNAVAILABLE')
    renameSync(temporary, path)
  }

  private async verify(context: PullRequestContext, input: CreatePullRequestInput, execution: PullRequestExecutionContext, mutation = true) {
    if (!execution.isActive()) throw new PullRequestError('PROJECT_CHANGED')
    if (mutation) {
      const permissions = await this.api.getPullRequestPermissions(context.repository)
      if (!permissions.create) throw new GitHubIntegrationError('PERMISSION_DENIED', githubErrorMessage('PERMISSION_DENIED'))
    }
    await this.api.getBranchSha(context.repository, input.baseBranch)
    if (await this.api.getBranchSha(context.repository, input.headBranch) !== input.expectedHeadSha) throw new PullRequestError('HEAD_DRIFT')
    if (input.worktreeId) {
      if (!execution.inspectWorktree) throw new PullRequestError('WORKTREE_DRIFT')
      const worktree = await execution.inspectWorktree(input.worktreeId).catch(() => { throw new PullRequestError('WORKTREE_DRIFT') })
      if (worktree.branch !== input.headBranch || worktree.head !== input.expectedHeadSha) throw new PullRequestError('WORKTREE_DRIFT')
    }
    if (!execution.isActive()) throw new PullRequestError('PROJECT_CHANGED')
  }

  private async reconcile(context: PullRequestContext, input: CreatePullRequestInput): Promise<PullRequestSummary | null> {
    let cursor: string | undefined
    const matches: PullRequestSummary[] = []
    for (let page = 0; page < 10; page++) {
      const result = await this.api.listPullRequests(context.repository, { state: 'all', headBranch: input.headBranch, pageSize: 100, cursor })
      matches.push(...result.pullRequests.filter(pr => pr.head.repository.toLowerCase() === context.repository.toLowerCase() && pr.head.ref === input.headBranch))
      cursor = result.nextCursor
      if (!cursor) break
    }
    if (cursor) throw new PullRequestError('RECONCILIATION_LIMIT')
    if (matches.some(pr => pr.state === 'closed' || pr.mergedAt)) throw new PullRequestError('CLOSED_PR_REQUIRES_DECISION')
    if (!matches.length) return null
    if (matches.length !== 1) throw new PullRequestError('PR_IDENTITY_CONFLICT')
    const pr = await this.api.getPullRequest(context.repository, matches[0].number)
    this.assertCompatible(context, input, pr)
    return pr
  }

  private assertCompatible(context: PullRequestContext, input: CreatePullRequestInput, pr: PullRequestSummary) {
    if (pr.state !== 'open' || pr.mergedAt) throw new PullRequestError('CLOSED_PR_REQUIRES_DECISION')
    if (pr.draft || pr.head.ref !== input.headBranch || pr.base.ref !== input.baseBranch || pr.head.sha !== input.expectedHeadSha || pr.head.repository.toLowerCase() !== context.repository.toLowerCase() || pr.base.repository.toLowerCase() !== context.repository.toLowerCase()) throw new PullRequestError('PR_IDENTITY_CONFLICT')
  }
}

export function validateBranch(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 255 || !value || value === '@' || value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.') || /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(value) || value.includes('..') || value.includes('@{') || value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) throw new PullRequestError('INVALID_ARGUMENT')
}

export function validateCreatePullRequest(input: CreatePullRequestInput) {
  if (input.deliveryContext !== undefined && !deliveryContextRequest.safeParse(input.deliveryContext).success) throw new PullRequestError('INVALID_ARGUMENT')
  validateBranch(input.headBranch)
  validateBranch(input.baseBranch)
  if (input.headBranch === input.baseBranch || typeof input.expectedHeadSha !== 'string' || !/^[a-f0-9]{40}$/.test(input.expectedHeadSha)) throw new PullRequestError('INVALID_ARGUMENT')
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 256 || /[\r\n\x00-\x1f]/.test(input.title)) throw new PullRequestError('INVALID_ARGUMENT')
  if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 60000 || input.body.includes('\0')) throw new PullRequestError('INVALID_ARGUMENT')
  if (typeof input.operationId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.operationId)) throw new PullRequestError('INVALID_ARGUMENT')
  if (input.worktreeId !== undefined && (typeof input.worktreeId !== 'string' || !/^[a-f0-9]{64}$/.test(input.worktreeId))) throw new PullRequestError('INVALID_ARGUMENT')
}

export function hash(value: string) { return createHash('sha256').update(value).digest('hex') }

export function claim(path: string, value: unknown): boolean {
  let descriptor: number
  try { descriptor = openSync(path, 'wx', 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try { writeFileSync(descriptor, JSON.stringify(value)); fsyncSync(descriptor) } finally { closeSync(descriptor) }
  return true
}

export function pullRequestDeliveryPage(directory: string, repositoryId: string, after = ''): DeliveryProjectionPage {
  if (after && !/^[a-f0-9]{64}\.json$/.test(after)) throw new Error('INVALID_CURSOR')
  const root = join(directory, hash(repositoryId)); let names: string[]
  try { if (lstatSync(root).isSymbolicLink()) throw new Error('INVALID_RECEIPT_DIRECTORY'); names = readdirSync(root).filter(name => /^[a-f0-9]{64}\.json$/.test(name) && name > after).sort() }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { observations: [] }; throw error }
  const observations: DeliveryProjectionPage['observations'] = []
  for (const name of names.slice(0, 20)) {
    const path = join(root, name), stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) continue
    let receipt: any; try { receipt = JSON.parse(readFileSync(path, 'utf8')) } catch { continue }
    const parsed = deliveryAnchor.safeParse(receipt.deliveryContext), result = receipt.result
    if (!parsed.success || parsed.data.repositoryId !== repositoryId || receipt.deliveryVerified !== true || receipt.operation !== 'CREATE_PULL_REQUEST' || !receipt.completedAt || typeof receipt.operationId !== 'string' || typeof receipt.fingerprint !== 'string' || !result || !Number.isSafeInteger(result.number) || result.number < 1 || typeof result.repository !== 'string' || result.headSha !== parsed.data.snapshot.head) continue
    observations.push({ receiptId: hash(JSON.stringify(receipt)), operationId: receipt.operationId, operation: 'CREATE_PULL_REQUEST', argumentFingerprint: receipt.fingerprint, anchor: parsed.data, pullRequest: result.number, headSha: result.headSha, repository: result.repository })
  }
  return { observations, ...(names.length > 20 ? { nextCursor: names[19] } : {}) }
}
