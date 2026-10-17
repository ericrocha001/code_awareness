import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PullRequestError, type CreatePullRequestInput, type PullRequestApproval, type PullRequestContext, type PullRequestSummary } from '../../shared/types/github-pr-types'
import type { GitHubApiClient } from './github-api-client'
import { GitHubIntegrationError, githubErrorMessage } from './github-errors'

export interface PullRequestDependencies {
  receiptDirectory: string
  approve(request: PullRequestApproval): Promise<boolean>
}

export interface PullRequestExecutionContext {
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
    const context = await this.resolve()
    const fingerprint = hash(JSON.stringify([context.repositoryId, context.repository.toLowerCase(), input.headBranch, input.baseBranch, input.expectedHeadSha, input.title, input.body, input.worktreeId ?? null]))
    if (!this.dependencies) throw new PullRequestError('AUTHORIZATION_REQUIRED')
    const directory = join(this.dependencies.receiptDirectory, hash(context.repositoryId))
    const operationPath = join(directory, `${hash(input.operationId)}.json`)
    let previous: { fingerprint: string } | null
    try { previous = JSON.parse(readFileSync(operationPath, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new PullRequestError('RECEIPT_UNAVAILABLE')
      previous = null
    }
    if (previous && previous.fingerprint !== fingerprint) throw new PullRequestError('IDEMPOTENCY_CONFLICT')
    await this.verify(context, input, execution, false)
    const existing = await this.reconcile(context, input)
    if (existing) {
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        if (!previous && !claim(operationPath, { fingerprint, operation: 'CREATE_PULL_REQUEST', observedAt: new Date().toISOString() })) {
          const raced = JSON.parse(readFileSync(operationPath, 'utf8'))
          if (raced.fingerprint !== fingerprint) throw new PullRequestError('IDEMPOTENCY_CONFLICT')
        }
      } catch (error) {
        if (error instanceof PullRequestError) throw error
        throw new PullRequestError('RECEIPT_UNAVAILABLE')
      }
      return { status: 'EXISTING_OPEN' as const, operationId: input.operationId, replayed: !!previous, pullRequest: existing }
    }
    if (previous) throw new PullRequestError('OUTCOME_UNKNOWN')
    await this.verify(context, input, execution)
    const expiresAt = new Date(Date.now() + 120_000).toISOString()
    const granted = await this.dependencies.approve({ ...input, ...context, operation: 'CREATE_PULL_REQUEST', expiresAt })
    if (!granted) throw new PullRequestError('AUTHORIZATION_DENIED')
    if (Date.now() >= Date.parse(expiresAt)) throw new PullRequestError('AUTHORIZATION_EXPIRED')
    const current = await this.resolve()
    if (current.repositoryId !== context.repositoryId || current.repository !== context.repository) throw new PullRequestError('PROJECT_CHANGED')
    await this.verify(context, input, execution)
    const raced = await this.reconcile(context, input)
    if (raced) return { status: 'EXISTING_OPEN' as const, operationId: input.operationId, replayed: false, pullRequest: raced }
    if (Date.now() >= Date.parse(expiresAt)) throw new PullRequestError('AUTHORIZATION_EXPIRED')
    if (!execution.isActive()) throw new PullRequestError('PROJECT_CHANGED')
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      if (!claim(operationPath, { fingerprint, operation: 'CREATE_PULL_REQUEST', preparedAt: new Date().toISOString() })) throw new PullRequestError('OUTCOME_UNKNOWN')
      // A persistent head claim fences other operation IDs and process restarts after an uncertain POST.
      if (!claim(join(directory, `head-${hash(context.repository.toLowerCase() + ':' + input.headBranch)}.json`), { operationId: input.operationId, fingerprint })) throw new PullRequestError('OUTCOME_UNKNOWN')
    } catch (error) {
      if (error instanceof PullRequestError) throw error
      throw new PullRequestError('RECEIPT_UNAVAILABLE')
    }
    try {
      const created = await this.api.createPullRequest(context.repository, input, () => {
        if (Date.now() >= Date.parse(expiresAt)) throw new PullRequestError('AUTHORIZATION_EXPIRED')
        if (!execution.isActive()) throw new PullRequestError('PROJECT_CHANGED')
      })
      const verified = await this.api.getPullRequest(context.repository, created.number)
      this.assertCompatible(context, input, verified)
      const reconciled = await this.reconcile(context, input)
      if (!reconciled || reconciled.number !== verified.number) throw new PullRequestError('PR_IDENTITY_CONFLICT')
      return { status: 'CREATED' as const, operationId: input.operationId, replayed: false, pullRequest: reconciled }
    } catch (error) {
      if (error instanceof PullRequestError && ['AUTHORIZATION_EXPIRED', 'PROJECT_CHANGED'].includes(error.code)) throw error
      try {
        const recovered = await this.reconcile(context, input)
        if (recovered) return { status: 'EXISTING_OPEN' as const, operationId: input.operationId, replayed: true, pullRequest: recovered }
      } catch (error) {
        if (error instanceof PullRequestError && ['PR_IDENTITY_CONFLICT', 'CLOSED_PR_REQUIRES_DECISION'].includes(error.code)) throw error
      }
      throw new PullRequestError('OUTCOME_UNKNOWN')
    }
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
  validateBranch(input.headBranch)
  validateBranch(input.baseBranch)
  if (input.headBranch === input.baseBranch || typeof input.expectedHeadSha !== 'string' || !/^[a-f0-9]{40}$/.test(input.expectedHeadSha)) throw new PullRequestError('INVALID_ARGUMENT')
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 256 || /[\r\n\x00-\x1f]/.test(input.title)) throw new PullRequestError('INVALID_ARGUMENT')
  if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 60000 || input.body.includes('\0')) throw new PullRequestError('INVALID_ARGUMENT')
  if (typeof input.operationId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.operationId)) throw new PullRequestError('INVALID_ARGUMENT')
  if (input.worktreeId !== undefined && (typeof input.worktreeId !== 'string' || !/^[a-f0-9]{64}$/.test(input.worktreeId))) throw new PullRequestError('INVALID_ARGUMENT')
}

function hash(value: string) { return createHash('sha256').update(value).digest('hex') }

function claim(path: string, value: unknown): boolean {
  let descriptor: number
  try { descriptor = openSync(path, 'wx', 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try { writeFileSync(descriptor, JSON.stringify(value)); fsyncSync(descriptor) } finally { closeSync(descriptor) }
  return true
}
