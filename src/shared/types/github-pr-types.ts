import type { GitHubRepositoryIdentity } from './repository-catalog-types'

/**
 * Projected evidence of a pull request as observed in GitHub.
 *
 * Origin (`head`) preserves the branch that opened the PR. Destination
 * (`base`) preserves the reference the PR was opened against. A PR may be
 * projected in both perspectives (sent by a local branch and received by a
 * remote one) but always keeps a single identity: repository + PR number.
 */
export interface GitHubPullRequest {
  /** Stable GitHub identity: repository full name + PR number */
  repository: GitHubRepositoryIdentity
  prNumber: number
  /** State of the PR at the remote */
  state: 'open' | 'closed' | 'merged'
  /** Whether the PR is still a draft */
  draft: boolean
  /** Branch that opened the PR (origin) */
  head: { ref: string; sha: string }
  /** Branch the PR targets (destination) */
  base: { ref: string; sha: string }
  /** Commit SHA at the merge button time, if merged */
  mergeCommitSha?: string | null
  /** When the PR was created */
  createdAt: string
  /** When the PR was last updated */
  updatedAt: string
  /** When the PR was merged, only when `state` is `merged` */
  mergedAt?: string | null
  /** Title of the PR (used for display) */
  title: string
  /** Remote URL for the PR page (external, authorized path) */
  htmlUrl: string
}

/**
 * Additive projection of GitHub pull requests for a single branch.
 *
 * `origin` contains PRs opened from this branch (sent).
 * `destination` contains PRs opened against this branch (received).
 *
 * The projection is additive: it enriches an existing origin relationship
 * classification without reusing `CONFIRMED_CURRENT` for destinations.
 */
export interface BranchPullRequests {
  /** Identity of the branch used as projection key */
  branch: string
  /** PRs originating from this branch, newest first */
  origin: GitHubPullRequest[]
  /** PRs destined to this branch, newest first */
  destination: GitHubPullRequest[]
}

/**
 * Capability query for fetching pull-request history for a branch.
 * Used by the projection layer to keep GitHub as the only authority.
 */
export interface PullRequestHistoryQuery {
  repository: GitHubRepositoryIdentity
  branch: string
  /** Limit per direction. Defaults to 30. */
  limit?: number
  /** When true, include merged PRs in both directions. Defaults to true. */
  includeMerged?: boolean
}
