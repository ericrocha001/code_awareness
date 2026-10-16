import type { GitHubApiClient } from './github-api-client'
import type { GitHubRepositoryIdentity } from '../../shared/types/repository-catalog-types'
import type { BranchPullRequests, GitHubPullRequest, PullRequestHistoryQuery } from '../../shared/types/github-pr-types'

/**
 * Projeção de PRs do GitHub por branch, preservando origem (`head`) e destino (`base`) separadamente.
 *
 * Autoridade remota: GitHub via `GitHubApiClient.listPullRequests(state='all')`.
 * Nenhuma segunda base de dados; o catálogo serve apenas como projeção legível.
 *
 * Regras de projeção:
 * - `origin`  = PRs cujo `head.ref` bate com o nome da branch (enviados)
 * - `destination` = PRs cujo `base.ref` bate com o nome da branch (recebidos)
 * - Um PR pode aparecer nos dois sentidos, mas mantém uma única identidade.
 * - Estados `merged` com `mergedAt` são entregas confirmadas; `closed` sem merge
 *   não é entrega concluída.
 */
export class GitHubPullRequestCatalog {
  constructor(private readonly api: GitHubApiClient, private readonly repository: GitHubRepositoryIdentity) {}

  async project(query: PullRequestHistoryQuery): Promise<BranchPullRequests> {
    const { limit = 30, includeMerged = true } = query
    const values: GitHubPullRequest[] = []
    let cursor: string | null = null

    do {
      const page = await this.api.listPullRequests(
        this.repository.fullName.split('/')[0],
        this.repository.fullName.split('/')[1],
        includeMerged ? null : query.branch,
        'all',
        cursor
      )
      values.push(...page.values)
      cursor = page.nextCursor
    } while (cursor && values.length < limit * 2)

    const origin: GitHubPullRequest[] = []
    const destination: GitHubPullRequest[] = []

    for (const pr of values) {
      if (pr.head.ref === query.branch) origin.push(pr)
      if (pr.base.ref === query.branch) destination.push(pr)
    }

    origin.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    destination.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))

    return { branch: query.branch, origin: origin.slice(0, limit), destination: destination.slice(0, limit) }
  }
}
