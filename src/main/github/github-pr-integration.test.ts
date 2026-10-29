import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubPrIntegration } from './github-pr-integration'
import { GitHubApiClient } from './github-api-client'
import { effectivePullRequestReviews, evaluatePullRequestPolicy, summarizePullRequestChecks } from './github-pr-evidence'
import type { PullRequestReview, PullRequestSummary } from '../../shared/types/github-pr-types'

const roots: string[] = []
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const head = 'b'.repeat(40), base = 'a'.repeat(40)
const input = { prNumber: 42, operationId: 'merge-proof', expectedHeadSha: head, expectedBaseSha: base }
const context = { repositoryId: 'selected', repository: 'owner/repo' }
const uuid = '630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42'
const pending = () => ({ status: 'pending', details: { uuid, expected_head_sha: head, bypass_rules: false, merge_action: 'default', merge_method: 'merge' } })
const pr = (): PullRequestSummary => ({ number: 42, url: 'https://github.com/owner/repo/pull/42', title: 'Proof', state: 'open', draft: false, head: { ref: 'cline/feature', sha: head, repository: context.repository }, base: { ref: 'main', sha: base, repository: context.repository }, mergedAt: null, mergeability: 'UNKNOWN', stack: 'NONE', observedAt: new Date().toISOString() })
function fixture() {
  const receiptDirectory = mkdtempSync(join(tmpdir(), 'pr-review-')); roots.push(receiptDirectory)
  const current = pr()
  const api = {
    getPullRequest: vi.fn(async () => current),
    getPullRequestStackEvidence: vi.fn(async () => ({ state: 'UNKNOWN', source: 'GITHUB_REST_STACK_FILTER', repository: context.repository, prNumber: 42, complete: false, observedAt: new Date().toISOString(), reason: 'PROVIDER_RESPONSE_INCONCLUSIVE' } as any)),
    getPullRequestEndpointPermissions: vi.fn(async () => ({ read: true, close: true, merge: true, checks: true, statuses: true })),
    getBranchSha: vi.fn(async (_repo: string, ref: string) => ref === 'main' ? base : head),
    getPullRequestPolicy: vi.fn(async () => evaluatePullRequestPolicy([], null, { allow_merge_commit: true })),
    getPullRequestReviews: vi.fn(async () => ({ headSha: head, completeness: 'COMPLETE', decision: 'NO_APPROVAL', approvalCount: 0 })),
    getPullRequestChecks: vi.fn(async () => ({ headSha: head, completeness: 'COMPLETE', checks: [] })),
    requestPullRequestMerge: vi.fn(async (_repo: string, _number: number, _head: string, _queue: boolean, beforeSend: () => Promise<void>) => { await beforeSend(); return { httpStatus: 202, value: pending() } }),
    getPullRequestMergeRequest: vi.fn(async () => ({ response: { status: 200 }, value: pending() })),
    closePullRequest: vi.fn(async (_repo: string, _number: number, beforeSend: () => Promise<void>) => { await beforeSend(); current.state = 'closed'; return current })
  }
  const approveMutation = vi.fn(async () => true)
  const resolve = vi.fn(async () => context)
  const execution = { isActive: vi.fn(() => true) }
  const dependencies = { receiptDirectory, approve: vi.fn(async () => true), approveMutation }
  return { api, current, dependencies, execution, approveMutation, resolve, build: () => new GitHubPrIntegration(api as any, resolve, dependencies) }
}

describe('durable controlled PR integration', () => {
  it('composes omitted inline REST data with the official empty filter and a durable approved merge receipt', async () => {
    const f = fixture()
    const fetcher = vi.fn(async (url: any, init: any) => {
      const path = new URL(String(url)).pathname
      if (path.endsWith('/stacks')) {
        expect(new URL(String(url)).searchParams.get('pull_request')).toBe('42')
        return new Response('[]')
      }
      if (path.endsWith('/merge-async')) {
        expect(init.method).toBe('PUT')
        expect(JSON.parse(init.body)).toEqual({ sha: head, bypass_rules: false, merge_action: 'default', merge_method: 'merge' })
        return new Response(JSON.stringify(pending()), { status: 202 })
      }
      if (path.endsWith('/pulls/42')) return new Response(JSON.stringify({ number: 42, html_url: f.current.url, title: 'Proof', state: 'open', draft: false, merged_at: null,
        head: { ...f.current.head, repo: { full_name: context.repository } }, base: { ...f.current.base, repo: { full_name: context.repository } } }))
      throw new Error('Unexpected endpoint')
    })
    const actual = new GitHubApiClient(async () => 'secret', fetcher)
    f.api.getPullRequest.mockImplementation(() => actual.getPullRequest(context.repository, 42))
    f.api.getPullRequestStackEvidence.mockImplementation(() => actual.getPullRequestStackEvidence(context.repository, f.current))
    f.api.requestPullRequestMerge.mockImplementation((repo, number, sha, queue, beforeSend) => actual.requestPullRequestMerge(repo, number, sha, queue, beforeSend))
    f.approveMutation.mockImplementation(async () => { expect(fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith('/stacks'))).toHaveLength(1); return true })
    expect(await f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)).toMatchObject({ status: 'PENDING', uuid })
    expect(fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith('/stacks'))).toHaveLength(3)
    expect(fetcher.mock.calls.filter(([, init]) => init.method === 'PUT')).toHaveLength(1)
    expect(f.approveMutation).toHaveBeenCalledTimes(1)
  })
  it('resolves an omitted inline stack before approval and again immediately before PUT', async () => {
    const f = fixture(); f.current.stack = 'UNKNOWN'
    f.api.getPullRequestStackEvidence.mockResolvedValue({ state: 'NONE' } as any)
    expect(await f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)).toMatchObject({ status: 'PENDING', uuid })
    expect(f.api.getPullRequestStackEvidence).toHaveBeenCalledTimes(3)
    expect(f.approveMutation).toHaveBeenCalledTimes(1)
    await f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)
    expect(f.api.getPullRequestStackEvidence).toHaveBeenCalledTimes(3)
    expect(f.api.requestPullRequestMerge).toHaveBeenCalledTimes(1)
  })
  it.each(['PRESENT', 'UNKNOWN'])('refuses supplementary %s evidence without approval or receipt', async state => {
    const f = fixture(); f.current.stack = 'UNKNOWN'
    f.api.getPullRequestStackEvidence.mockResolvedValue({ state } as any)
    await expect(f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)).rejects.toMatchObject({ code: state === 'PRESENT' ? 'STACKED_PR_UNSUPPORTED' : 'STACK_UNKNOWN' })
    expect(f.approveMutation).not.toHaveBeenCalled(); expect(f.api.requestPullRequestMerge).not.toHaveBeenCalled()
    expect(readdirSync(f.dependencies.receiptDirectory)).toEqual([])
  })
  it.each(['403', '404', '422', 'timeout', 'malformed', 'partial'])('blocks the real supplementary %s source before approval and receipt', async failure => {
    const f = fixture(); f.current.stack = 'UNKNOWN'
    const actual = new GitHubApiClient(async () => 'secret', vi.fn(async () => {
      if (failure === 'timeout') throw new DOMException('timeout', 'TimeoutError')
      if (failure === 'malformed') return new Response('invalid json')
      if (failure === 'partial') return new Response('[]', { headers: { link: '<https://api.github.com/repos/owner/repo/stacks?page=2>; rel="next"' } })
      return new Response('{}', { status: Number(failure) })
    }))
    f.api.getPullRequestStackEvidence.mockImplementation(() => actual.getPullRequestStackEvidence(context.repository, f.current))
    await expect(f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)).rejects.toMatchObject({ code: 'STACK_UNKNOWN', stackEvidence: { state: 'UNKNOWN', source: 'GITHUB_REST_STACK_FILTER', complete: false } })
    expect(f.approveMutation).not.toHaveBeenCalled(); expect(f.api.requestPullRequestMerge).not.toHaveBeenCalled()
    expect(readdirSync(f.dependencies.receiptDirectory)).toEqual([])
  })
  it.each(['NONE', 'PRESENT'])('does not supplement trusted inline %s', async state => {
    const f = fixture(); f.current.stack = state as any
    try { await f.build().mutate('MERGE_PULL_REQUEST', input, f.execution) } catch (error) { expect(error).toMatchObject({ code: 'STACKED_PR_UNSUPPORTED' }) }
    expect(f.api.getPullRequestStackEvidence).not.toHaveBeenCalled()
  })
  it('rejects a stack appearing during native approval before preparing any receipt', async () => {
    const f = fixture(); f.current.stack = 'UNKNOWN'
    f.api.getPullRequestStackEvidence.mockResolvedValue({ state: 'NONE' } as any)
    f.approveMutation.mockImplementation(async () => { f.api.getPullRequestStackEvidence.mockResolvedValue({ state: 'PRESENT' } as any); return true })
    await expect(f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)).rejects.toMatchObject({ code: 'STACKED_PR_UNSUPPORTED' })
    expect(f.api.requestPullRequestMerge).not.toHaveBeenCalled(); expect(readdirSync(f.dependencies.receiptDirectory)).toEqual([])
  })
  it.each(['stack', 'head', 'base', 'expiry'])('refuses %s drift at the final pre-send barrier', async change => {
    const f = fixture(); f.current.stack = 'UNKNOWN'
    f.api.getPullRequestStackEvidence.mockResolvedValue({ state: 'NONE' } as any)
    const sent = vi.fn()
    f.api.requestPullRequestMerge.mockImplementation(async (_repo, _number, _head, _queue, beforeSend) => {
      if (change === 'stack') f.api.getPullRequestStackEvidence.mockResolvedValue({ state: 'PRESENT' } as any)
      if (change === 'head') f.current.head.sha = 'd'.repeat(40)
      if (change === 'base') f.current.base.sha = 'd'.repeat(40)
      if (change === 'expiry') { vi.useFakeTimers(); vi.setSystemTime(Date.now() + 130_000) }
      await beforeSend(); sent(); return { httpStatus: 202, value: pending() }
    })
    expect(await f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)).toMatchObject({ status: 'OUTCOME_UNKNOWN' })
    expect(sent).not.toHaveBeenCalled()
  })
  it('refuses denial and missing mutation approval independently from CREATE approval', async () => {
    const f = fixture(); f.approveMutation.mockResolvedValue(false)
    await expect(f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' })
    await expect(new GitHubPrIntegration(f.api as any, f.resolve, { receiptDirectory: f.dependencies.receiptDirectory, approve: async () => true }).mutate('CLOSE_PULL_REQUEST', input, f.execution)).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED' })
    expect(f.api.requestPullRequestMerge).not.toHaveBeenCalled(); expect(f.api.closePullRequest).not.toHaveBeenCalled()
  })
  it('retains a definitive UUID failure after provider retention expires', async () => {
    const f = fixture()
    f.api.getPullRequestMergeRequest.mockResolvedValue({ response: { status: 200 }, value: { status: 'failed', details: { message: 'secret payload' } } } as any)
    expect(await f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)).toMatchObject({ status: 'FAILED', reason: 'PROVIDER_REJECTED' })
    f.api.getPullRequestMergeRequest.mockResolvedValue({ response: { status: 404 }, value: {} } as any)
    expect(await f.build().status(input.operationId)).toMatchObject({ status: 'FAILED' })
    expect(f.api.requestPullRequestMerge).toHaveBeenCalledTimes(1)
  })
  it('persists the owned UUID and reconciles after restart without a second PUT or approval', async () => {
    const f = fixture()
    expect(await f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)).toMatchObject({ status: 'PENDING', uuid, localGitChanged: false })
    expect(await f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)).toMatchObject({ status: 'PENDING', uuid })
    expect(f.api.requestPullRequestMerge).toHaveBeenCalledTimes(1)
    expect(f.approveMutation).toHaveBeenCalledTimes(1)
    expect(f.approveMutation).toHaveBeenCalledWith(expect.objectContaining({ ...input, ...context, operation: 'MERGE_PULL_REQUEST', headBranch: 'cline/feature', baseBranch: 'main', mergeMethod: 'merge', mergeAction: 'default', mayEnqueue: false }))
    f.current.state = 'closed'; f.current.mergedAt = new Date().toISOString(); f.current.mergeCommitSha = 'c'.repeat(40)
    expect(await f.build().status(input.operationId)).toMatchObject({ status: 'MERGED', mergeCommitSha: 'c'.repeat(40) })
  })

  it('keeps queue acceptance distinct from eventual merge', async () => {
    const f = fixture()
    f.api.getPullRequestPolicy.mockResolvedValue(evaluatePullRequestPolicy([{ type: 'merge_queue', parameters: { merge_method: 'MERGE' } }], null, { allow_merge_commit: true }))
    f.api.getPullRequestMergeRequest.mockResolvedValue({ response: { status: 200 }, value: { status: 'enqueued' } } as any)
    expect(await f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)).toMatchObject({ status: 'ENQUEUED' })
    expect(f.api.requestPullRequestMerge).toHaveBeenCalledWith(context.repository, 42, head, true, expect.any(Function))
  })

  it.each([400, 403, 404, 422, 500])('never retries a rejected or uncertain HTTP %s', async code => {
    const f = fixture(); f.api.requestPullRequestMerge.mockRejectedValue(new Error(String(code)))
    expect(await f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)).toMatchObject({ status: 'OUTCOME_UNKNOWN' })
    await f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)
    expect(f.api.requestPullRequestMerge).toHaveBeenCalledTimes(1)
    await expect(f.build().mutate('MERGE_PULL_REQUEST', { ...input, operationId: 'another' }, f.execution)).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
  })

  it('does not adopt a foreign 409 UUID, even when options coincide', async () => {
    const f = fixture(); f.api.requestPullRequestMerge.mockResolvedValue({ httpStatus: 409, value: pending() })
    expect(await f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)).toMatchObject({ status: 'OUTCOME_UNKNOWN', reason: 'FOREIGN_PENDING_REQUEST' })
    expect(f.api.getPullRequestMergeRequest).not.toHaveBeenCalled()
  })

  it('uses PR readback after UUID expiry without repeating PUT', async () => {
    const f = fixture(); await f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)
    f.api.getPullRequestMergeRequest.mockResolvedValue({ response: { status: 404 }, value: {} } as any)
    expect(await f.build().status(input.operationId)).toMatchObject({ status: 'OUTCOME_UNKNOWN', reason: 'REQUEST_EXPIRED_OR_UNAVAILABLE' })
    expect(f.api.requestPullRequestMerge).toHaveBeenCalledTimes(1)
  })

  it.each(['PRESENT', 'UNKNOWN'])('blocks unsafe stack %s before approval', async stack => {
    const f = fixture(); f.current.stack = stack as any
    await expect(f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)).rejects.toMatchObject({ code: stack === 'PRESENT' ? 'STACKED_PR_UNSUPPORTED' : 'STACK_UNKNOWN' })
    expect(f.approveMutation).not.toHaveBeenCalled()
  })

  it.each(['head', 'base', 'project', 'expiry'])('rechecks %s after native approval', async change => {
    const f = fixture()
    f.approveMutation.mockImplementation(async () => {
      if (change === 'head') f.current.head.sha = 'd'.repeat(40)
      if (change === 'base') f.current.base.sha = 'd'.repeat(40)
      if (change === 'project') f.execution.isActive.mockReturnValue(false)
      if (change === 'expiry') { vi.useFakeTimers(); vi.setSystemTime(Date.now() + 121_000) }
      return true
    })
    await expect(f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)).rejects.toMatchObject({ code: { head: 'HEAD_DRIFT', base: 'BASE_DRIFT', project: 'PROJECT_CHANGED', expiry: 'AUTHORIZATION_EXPIRED' }[change] })
    expect(f.api.requestPullRequestMerge).not.toHaveBeenCalled()
  })

  it('closes independently, reconciles concurrent merge and rejects changed intent', async () => {
    const f = fixture()
    f.api.closePullRequest.mockImplementation(async () => { f.current.state = 'closed'; f.current.mergedAt = new Date().toISOString(); f.current.mergeCommitSha = 'c'.repeat(40); throw new Error('timeout') })
    expect(await f.build().mutate('CLOSE_PULL_REQUEST', input, f.execution)).toMatchObject({ status: 'MERGED' })
    await f.build().mutate('CLOSE_PULL_REQUEST', input, f.execution)
    expect(f.api.closePullRequest).toHaveBeenCalledTimes(1)
    await expect(f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  })
  it.each(['permission', 'draft', 'policy', 'method', 'queueMethod', 'reviews', 'checks'])('blocks %s before native approval or mutation', async failure => {
    const f = fixture()
    if (failure === 'permission') f.api.getPullRequestEndpointPermissions.mockResolvedValue({ read: true, close: true, merge: true, checks: false, statuses: true })
    if (failure === 'draft') f.current.draft = true
    if (failure === 'policy') f.api.getPullRequestPolicy.mockResolvedValue(evaluatePullRequestPolicy([{ type: 'required_deployments' }], null, { allow_merge_commit: true }))
    if (failure === 'method') f.api.getPullRequestPolicy.mockResolvedValue(evaluatePullRequestPolicy([], null, { allow_merge_commit: false }))
    if (failure === 'queueMethod') f.api.getPullRequestPolicy.mockResolvedValue(evaluatePullRequestPolicy([{ type: 'merge_queue', parameters: { merge_method: 'SQUASH' } }], null, { allow_merge_commit: true }))
    if (failure === 'reviews') f.api.getPullRequestReviews.mockResolvedValue({ headSha: head, completeness: 'INCOMPLETE', decision: 'UNKNOWN', approvalCount: 0 })
    if (failure === 'checks') f.api.getPullRequestChecks.mockResolvedValue({ headSha: head, completeness: 'INCOMPLETE', checks: [] })
    await expect(f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)).rejects.toMatchObject({ code: { permission: 'PERMISSION_REQUIRED', draft: 'DRAFT_PR', policy: 'POLICY_UNKNOWN', method: 'METHOD_NOT_ALLOWED', queueMethod: 'METHOD_NOT_ALLOWED', reviews: 'REVIEWS_NOT_READY', checks: 'CHECKS_NOT_READY' }[failure] })
    expect(f.approveMutation).not.toHaveBeenCalled(); expect(f.api.requestPullRequestMerge).not.toHaveBeenCalled()
  })
  it.each([400, 403, 404, 422])('records definitive async rejection %s as FAILED without replay', async httpStatus => {
    const f = fixture(); f.api.requestPullRequestMerge.mockResolvedValue({ httpStatus, value: {} } as any)
    expect(await f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)).toMatchObject({ status: 'FAILED', reason: `PROVIDER_HTTP_${httpStatus}` })
    await f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)
    expect(f.api.requestPullRequestMerge).toHaveBeenCalledTimes(1)
  })
  it('rechecks again inside the post-token callback and never sends after revocation', async () => {
    const f = fixture()
    f.api.requestPullRequestMerge.mockImplementation(async (_repo, _number, _head, _queue, beforeSend) => { f.execution.isActive.mockReturnValue(false); await beforeSend(); throw new Error('unreachable') })
    expect(await f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)).toMatchObject({ status: 'OUTCOME_UNKNOWN' })
    expect(f.api.getPullRequestMergeRequest).not.toHaveBeenCalled()
  })
  it.each(['enqueued', 'merged'])('reconciles HTTP 200 %s without claiming an owned UUID', async status => {
    const f = fixture()
    f.api.requestPullRequestMerge.mockImplementation(async () => {
      if (status === 'merged') { f.current.mergedAt = new Date().toISOString(); f.current.state = 'closed'; f.current.mergeCommitSha = 'c'.repeat(40) }
      return { httpStatus: 200, value: { status } } as any
    })
    const result = await f.build().mutate('MERGE_PULL_REQUEST', input, f.execution)
    expect(result.status).toBe(status.toUpperCase()); expect(result.uuid).toBeUndefined()
    expect(f.api.getPullRequestMergeRequest).not.toHaveBeenCalled()
  })
  it('requires a separate close approval and preserves local checkout', async () => {
    const f = fixture()
    expect(await f.build().mutate('CLOSE_PULL_REQUEST', input, f.execution)).toMatchObject({ status: 'CLOSED', localGitChanged: false })
    expect(f.approveMutation).toHaveBeenCalledWith(expect.objectContaining({ operation: 'CLOSE_PULL_REQUEST', expectedHeadSha: head, expectedBaseSha: base }))
    expect(f.api.requestPullRequestMerge).not.toHaveBeenCalled()
  })
  it('observes and binds close base without requiring the merge-only base argument', async () => {
    const f = fixture()
    const { expectedBaseSha: _base, ...closeInput } = input
    expect(await f.build().mutate('CLOSE_PULL_REQUEST', closeInput, f.execution)).toMatchObject({ status: 'CLOSED' })
    expect(f.approveMutation).toHaveBeenCalledWith(expect.objectContaining({ expectedBaseSha: base }))
    await expect(f.build().mutate('MERGE_PULL_REQUEST', { ...closeInput, operationId: 'missing-base' }, f.execution)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})

describe('current evidence and cumulative policies', () => {
  const review = (id: number, state: PullRequestReview['state'], sha = head): PullRequestReview => ({ id, reviewer: 'reviewer', state, commitSha: sha, submittedAt: `2026-10-17T12:00:0${id}Z` })
  it('does not count dismissed, stale, superseded or incomplete approvals', () => {
    expect(effectivePullRequestReviews([review(1, 'APPROVED'), review(2, 'COMMENTED')], head, true).approvalCount).toBe(1)
    for (const reviews of [[review(1, 'APPROVED'), review(2, 'DISMISSED')], [review(1, 'APPROVED', base)], [review(1, 'APPROVED'), review(2, 'CHANGES_REQUESTED')]]) expect(effectivePullRequestReviews(reviews, head, true).approvalCount).toBe(0)
    expect(effectivePullRequestReviews([review(1, 'APPROVED')], head, false)).toMatchObject({ decision: 'UNKNOWN', approvalCount: 0 })
  })
  it('combines legacy protection and inherited rules without erasing stronger requirements', () => {
    const result = evaluatePullRequestPolicy([{ type: 'pull_request', parameters: { required_approving_review_count: 2 } }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci', integration_id: 12 }] } }], { required_pull_request_reviews: { required_approving_review_count: 1 }, required_status_checks: { contexts: ['legacy'] } }, { allow_merge_commit: true })
    expect(result).toMatchObject({ coverage: 'COMPLETE', requiredApprovals: 2, requiredChecks: [{ name: 'legacy', appId: null }, { name: 'ci', appId: 12 }] })
    expect(evaluatePullRequestPolicy([{ type: 'required_deployments' }], null, { allow_merge_commit: true }).coverage).toBe('INCOMPLETE')
    expect(summarizePullRequestChecks([], true, null)).toMatchObject({ state: 'NO_CHECKS', requirements: 'UNKNOWN' })
    expect(summarizePullRequestChecks([], true, []).requirements).toBe('NO_REQUIRED_CHECKS')
    expect(summarizePullRequestChecks([], false, []).state).toBe('UNKNOWN')
  })
})

describe('async REST wire contract', () => {
  const dto = () => ({ number: 42, html_url: pr().url, title: 'Proof', state: 'open', draft: false, head: { ref: 'cline/feature', sha: head, repo: { full_name: context.repository } }, base: { ref: 'main', sha: base, repo: { full_name: context.repository } }, merged_at: null, mergeable: null, stack: null })
  const json = (value: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(value), { status, headers })
  const stack = (number = 42) => ({ id: 7, number: 9, url: 'https://api.github.com/repos/owner/repo/stacks/9', pull_requests: [{ number, head: { ref: 'cline/feature', sha: head } }] })
  it.each([
    { inline: null, expected: 'NONE' }, { inline: stack(), expected: 'PRESENT' },
    { inline: undefined, expected: 'UNKNOWN' }, { inline: {}, expected: 'UNKNOWN' },
    { inline: stack(99), expected: 'UNKNOWN' }, { inline: [], expected: 'UNKNOWN' }
  ])('normalizes strict inline stack $expected without supplementary calls', async ({ inline, expected }) => {
    const fetcher = vi.fn(async () => json({ ...dto(), stack: inline }))
    const result = await new GitHubApiClient(async () => 'secret', fetcher).getPullRequest(context.repository, 42)
    expect(result.stack).toBe(expected); expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([
    { body: [], expected: 'NONE' }, { body: [stack()], expected: 'PRESENT' },
    { body: [stack(99)], expected: 'UNKNOWN' }, { body: {}, expected: 'UNKNOWN' },
    { body: [stack(), stack()], expected: 'UNKNOWN' }, { body: [{ ...stack(), url: 'https://api.github.com/repos/other/repo/stacks/9' }], expected: 'UNKNOWN' },
    { body: [{ ...stack(), pull_requests: [{ number: 42, head: { ref: 'cline/feature', sha: base } }] }], expected: 'UNKNOWN' },
    { body: [{ ...stack(), pull_requests: [{ number: 42 }] }], expected: 'UNKNOWN' },
    { body: [{ ...stack(), pull_requests: [...stack().pull_requests, ...stack().pull_requests] }], expected: 'UNKNOWN' }
  ])('reads only the officially filtered stack and returns $expected', async ({ body, expected }) => {
    const fetcher = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toBe('https://api.github.com/repos/owner/repo/stacks?pull_request=42&per_page=100&page=1')
      expect(init.headers['X-GitHub-Api-Version']).toBe('2026-03-10'); expect(init.method ?? 'GET').toBe('GET')
      expect(init.headers.Authorization).toBe('Bearer secret')
      return json(body)
    })
    const result = await new GitHubApiClient(async () => 'secret', fetcher).getPullRequestStackEvidence(context.repository, pr())
    expect(result).toMatchObject({ state: expected, source: 'GITHUB_REST_STACK_FILTER', prNumber: 42, repository: context.repository, complete: expected !== 'UNKNOWN' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([403, 404, 422, 500])('fails closed for stack HTTP %s', async status => {
    const api = new GitHubApiClient(async () => 'secret', vi.fn(async () => json({}, status)))
    expect(await api.getPullRequestStackEvidence(context.repository, pr())).toMatchObject({ state: 'UNKNOWN', complete: false })
  })
  it.each(['next', 'prev', 'malformed'])('does not authorize partial or uncertain pagination %s', async relation => {
    const fetcher = vi.fn(async () => json([], 200, { link: relation === 'malformed' ? 'invalid' : `<https://api.github.com/repos/owner/repo/stacks?page=2>; rel="${relation}"` }))
    expect(await new GitHubApiClient(async () => 'secret', fetcher).getPullRequestStackEvidence(context.repository, pr())).toMatchObject({ state: 'UNKNOWN', complete: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each(['timeout', 'malformed', 'network'])('fails closed for a %s source', async cause => {
    const fetcher = vi.fn(async () => { if (cause === 'malformed') return new Response('invalid json'); throw new DOMException('unavailable', cause === 'timeout' ? 'TimeoutError' : 'NetworkError') })
    expect(await new GitHubApiClient(async () => 'secret', fetcher).getPullRequestStackEvidence(context.repository, pr())).toMatchObject({ state: 'UNKNOWN', complete: false })
  })
  it('rejects cross-repository and invalid-number selectors before HTTP', async () => {
    const fetcher = vi.fn()
    const api = new GitHubApiClient(async () => 'secret', fetcher)
    for (const current of [{ ...pr(), number: 0 }, { ...pr(), base: { ...pr().base, repository: 'other/repo' } }]) expect(await api.getPullRequestStackEvidence(context.repository, current)).toMatchObject({ state: 'UNKNOWN', complete: false })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('reads raw reviews without bodies and bounds untrusted pagination', async () => {
    const fetcher = vi.fn(async (url: any) => String(url).includes('/reviews?') ? json([{ id: 1, user: { login: 'reviewer' }, state: 'APPROVED', commit_id: head, submitted_at: '2026-10-17T12:00:00Z', body: 'private review' }], 200, { link: '<https://evil.example/token>; rel="next"' }) : json(dto()))
    const result = await new GitHubApiClient(async () => 'secret', fetcher as any).getPullRequestReviews(context.repository, 42)
    expect(result).toMatchObject({ completeness: 'INCOMPLETE', decision: 'UNKNOWN', approvalCount: 0 })
    expect(fetcher).toHaveBeenCalledTimes(6)
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('https://api.github.com/'))).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private review')
  })
  it.each([false, true])('combines statuses and checks; unavailable checks=%s never becomes NO_CHECKS', async unavailable => {
    const fetcher = vi.fn(async (url: any) => {
      const path = String(url)
      if (path.includes('/check-runs?')) return unavailable ? json({}, 403) : json({ check_runs: [{ id: 1, name: 'ci', head_sha: head, app: { id: 12 }, status: 'completed', conclusion: 'success', updated_at: '2026-10-17T12:00:00Z' }] })
      if (path.includes('/statuses?')) return json([{ id: 2, context: 'legacy', state: 'pending', updated_at: '2026-10-17T12:00:00Z' }])
      if (path.includes('/rules/branches/')) return json([])
      if (path.endsWith('/protection')) return json({}, 404)
      if (path.endsWith('/branches/main')) return json({ protected: false })
      if (path.endsWith('/pulls/42')) return json(dto())
      return json({ allow_merge_commit: true })
    })
    const result = await new GitHubApiClient(async () => 'secret', fetcher as any).getPullRequestChecks(context.repository, 42)
    expect(result).toMatchObject({ state: unavailable ? 'UNKNOWN' : 'PENDING', requirements: unavailable ? 'UNKNOWN' : 'NO_REQUIRED_CHECKS', completeness: unavailable ? 'INCOMPLETE' : 'COMPLETE' })
    expect(result.checks.every(item => item.sha === head)).toBe(true)
    if (unavailable) expect(result.availability.CHECK_RUN).toBe('UNAVAILABLE')
  })
  it('requires proof of absent legacy protection and preserves cumulative policy', async () => {
    const fetcher = vi.fn(async (url: any) => {
      const path = String(url)
      if (path.includes('/rules/branches/')) return json([])
      if (path.endsWith('/protection')) return json({}, 404)
      if (path.endsWith('/branches/main')) return json({ protected: true })
      return json({ allow_merge_commit: true })
    })
    expect(await new GitHubApiClient(async () => 'secret', fetcher as any).getPullRequestPolicy(context.repository, 'main')).toMatchObject({ coverage: 'INCOMPLETE', limitations: ['POLICY_COVERAGE_UNKNOWN'] })
  })
  it('sends only async default merge with immutable no-bypass and post-token authorization', async () => {
    const events: string[] = []
    const fetcher = vi.fn(async (_url: any, init: any) => { events.push('http'); expect(JSON.parse(init.body)).toEqual({ sha: head, bypass_rules: false, merge_action: 'default', merge_method: 'merge' }); return new Response(JSON.stringify(pending()), { status: 202 }) })
    const api = new GitHubApiClient(async () => { events.push('token'); return 'secret' }, fetcher as any)
    await api.requestPullRequestMerge(context.repository, 42, head, false, async () => { events.push('approved') })
    expect(events).toEqual(['token', 'approved', 'http'])
    expect(fetcher.mock.calls[0][0]).toBe('https://api.github.com/repos/owner/repo/pulls/42/merge-async')
  })
})
