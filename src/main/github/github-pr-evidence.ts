import type { PullRequestReview, PullRequestCheck, PullRequestPolicy, RequiredPullRequestCheck } from '../../shared/types/github-pr-types'

export function effectivePullRequestReviews(reviews: PullRequestReview[], headSha: string, complete: boolean) {
  const latest = new Map<string, PullRequestReview>()
  for (const review of [...reviews].sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? '') || a.id - b.id)) {
    if (review.state !== 'PENDING' && review.state !== 'COMMENTED') latest.set(review.reviewer.toLowerCase(), review)
  }
  const reviewers = [...latest.values()].map(review => ({ ...review, effectiveApproval: complete && review.state === 'APPROVED' && review.commitSha === headSha }))
  const approvalCount = reviewers.filter(review => review.effectiveApproval).length
  const changesRequested = reviewers.some(review => review.state === 'CHANGES_REQUESTED')
  return { completeness: complete ? 'COMPLETE' as const : 'INCOMPLETE' as const, approvalCount, reviewers,
    decision: !complete ? 'UNKNOWN' : changesRequested ? 'CHANGES_REQUESTED' : approvalCount > 0 ? 'APPROVED' : 'NO_APPROVAL' }
}

export function latestPullRequestChecks(checks: PullRequestCheck[]) {
  const latest = new Map<string, PullRequestCheck>()
  for (const check of [...checks].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id - b.id)) latest.set(`${check.kind}:${check.name}:${check.appId ?? 'any'}`, check)
  return [...latest.values()]
}

export function summarizePullRequestChecks(checks: PullRequestCheck[], complete: boolean, required: RequiredPullRequestCheck[] | null) {
  if (!complete) return { state: 'UNKNOWN' as const, requirements: 'UNKNOWN' as const }
  const current = latestPullRequestChecks(checks)
  const state = current.length === 0 ? 'NO_CHECKS' : current.some(item => item.status === 'FAILED') ? 'FAILED' : current.some(item => item.status === 'UNKNOWN') ? 'UNKNOWN' : current.some(item => item.status === 'PENDING') ? 'PENDING' : 'PASSED'
  const requirements = required === null ? 'UNKNOWN' : required.length === 0 ? 'NO_REQUIRED_CHECKS' : required.every(rule => {
    const matches = current.filter(check => check.name === rule.name && (rule.appId === null || check.appId === rule.appId))
    return matches.length > 0 && matches.every(check => check.status === 'PASSED')
  }) ? 'PASSED' : 'NOT_SATISFIED'
  return { state, requirements }
}

export function evaluatePullRequestPolicy(rules: any[], protection: any, repository: any): PullRequestPolicy {
  const requiredChecks: RequiredPullRequestCheck[] = []
  const limitations: string[] = []
  let requiredApprovals = 0, queue = false, mergeCommitAllowed = repository.allow_merge_commit === true
  let queueMethod: PullRequestPolicy['queueMethod'] = null
  const addChecks = (checks: any) => {
    if (!Array.isArray(checks)) { limitations.push('CHECK_REQUIREMENTS_UNKNOWN'); return }
    for (const check of checks) {
      if (typeof check.context !== 'string' || (check.app_id != null && !Number.isInteger(check.app_id)) || (check.integration_id != null && !Number.isInteger(check.integration_id))) { limitations.push('CHECK_REQUIREMENTS_UNKNOWN'); continue }
      const appId = check.integration_id ?? check.app_id ?? null
      requiredChecks.push({ name: check.context, appId: appId === -1 ? null : appId })
    }
  }
  const reviews = (parameters: any) => {
    if (!parameters || !Number.isSafeInteger(parameters.required_approving_review_count) || parameters.required_approving_review_count < 0) { limitations.push('REVIEW_REQUIREMENTS_UNKNOWN'); return }
    requiredApprovals = Math.max(requiredApprovals, parameters.required_approving_review_count)
    if (parameters.require_code_owner_review || parameters.require_code_owner_reviews) limitations.push('CODEOWNER_APPROVAL_NOT_OBSERVABLE')
    if (parameters.require_last_push_approval) limitations.push('LAST_PUSH_APPROVAL_NOT_OBSERVABLE')
    if (parameters.required_review_thread_resolution) limitations.push('REVIEW_CONVERSATIONS_NOT_OBSERVABLE')
    if (Array.isArray(parameters.allowed_merge_methods) && !parameters.allowed_merge_methods.includes('merge')) mergeCommitAllowed = false
  }
  if (protection?.required_status_checks) {
    const checks = protection.required_status_checks
    addChecks(checks.checks ?? checks.contexts?.map((context: string) => ({ context })))
  }
  if (protection?.required_pull_request_reviews) reviews(protection.required_pull_request_reviews)
  if (protection?.required_conversation_resolution?.enabled) limitations.push('REVIEW_CONVERSATIONS_NOT_OBSERVABLE')
  if (protection?.required_linear_history?.enabled) mergeCommitAllowed = false
  if (protection?.required_signatures?.enabled) limitations.push('REQUIRED_SIGNATURES_PROVIDER_EVALUATION')
  for (const rule of rules) {
    if (rule.type === 'required_status_checks') addChecks(rule.parameters?.required_status_checks)
    else if (rule.type === 'pull_request') reviews(rule.parameters)
    else if (rule.type === 'merge_queue') {
      queue = true
      const method = rule.parameters?.merge_method?.toLowerCase()
      if (!['merge', 'squash', 'rebase'].includes(method)) { limitations.push('QUEUE_METHOD_UNKNOWN'); queueMethod = 'UNKNOWN' }
      else if (queueMethod && queueMethod !== method) { limitations.push('QUEUE_METHOD_CONFLICT'); queueMethod = 'UNKNOWN' }
      else queueMethod = method
    } else if (rule.type === 'required_linear_history') mergeCommitAllowed = false
    else if (!['deletion', 'creation', 'non_fast_forward'].includes(rule.type)) limitations.push(`PROVIDER_POLICY_NOT_OBSERVABLE:${String(rule.type).slice(0, 80)}`)
  }
  return { coverage: limitations.length ? 'INCOMPLETE' : 'COMPLETE', requiredChecks, requiredApprovals, queue, mergeCommitAllowed, queueMethod, limitations: [...new Set(limitations)], observedAt: new Date().toISOString() }
}
