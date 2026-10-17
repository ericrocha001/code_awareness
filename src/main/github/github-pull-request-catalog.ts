import { createHash } from 'node:crypto'
import type { GitHubApiClient } from './github-api-client'
import type { BranchInventory } from '../../shared/types/branch-orchestration-types'
import type { BranchPullRequestRelation, BranchPullRequests, PullRequestCatalog, PullRequestRecord } from '../../shared/types/branch-pull-request-types'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export class GitHubPullRequestCatalog {
  private epoch = 0
  private readonly cache = new Map<string, { at: number; catalog: PullRequestCatalog }>()
  private readonly pending = new Map<string, Promise<PullRequestCatalog>>()
  private readonly verified = new Map<string, { generation: string; pr: PullRequestRecord; observedAt: string }>()
  constructor(private readonly api: GitHubApiClient) {}

  clear() { this.epoch++; this.cache.clear(); this.verified.clear(); this.pending.clear() }

  async read(repositoryId: string, fullName: string, force = false): Promise<PullRequestCatalog> {
    const key = `${repositoryId}:${fullName.toLowerCase()}`
    const pending = this.pending.get(key)
    if (pending) return pending
    const cached = this.cache.get(key)
    if (!force && cached && Date.now() - cached.at < 30000) return cached.catalog
    const version = this.epoch
    const run = this.load(repositoryId, fullName).then(catalog => {
      if (version !== this.epoch) throw new Error('REMOTE_CONTEXT_CHANGED')
      if (this.cache.size >= 10) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(key, { at: Date.now(), catalog }); return catalog
    }).finally(() => { if (this.pending.get(key) === run) this.pending.delete(key) })
    this.pending.set(key, run)
    return run
  }

  private async load(repositoryId: string, fullName: string): Promise<PullRequestCatalog> {
    const observedAt = new Date().toISOString(), items = new Map<string, PullRequestRecord>()
    let repository: Awaited<ReturnType<GitHubApiClient['getPullRequestRepository']>> | null = null
    let coverage: PullRequestCatalog['coverage'] = 'PARTIAL', reason: string | null = 'PAGE_LIMIT'
    try {
      repository = await this.api.getPullRequestRepository(fullName)
      for (let page = 1; page <= 10; page++) {
        const result = await this.api.listPullRequests(fullName, page)
        for (const pr of result.items) {
          if (pr.base.repositoryId !== repository.id || pr.base.repository.toLowerCase() !== fullName.toLowerCase()) throw new Error('REMOTE_IDENTITY_MISMATCH')
          items.set(pr.id, pr)
        }
        if (!result.hasNext) { coverage = 'COMPLETE'; reason = null; break }
      }
    } catch (error) {
      coverage = items.size ? 'PARTIAL' : 'UNAVAILABLE'
      reason = error && typeof error === 'object' && 'code' in error ? String(error.code) : error instanceof Error ? error.message : 'GITHUB_UNAVAILABLE'
    }
    const values = [...items.values()]
    return { repositoryId, repository: repository?.fullName ?? fullName, providerRepositoryId: repository?.id ?? null, defaultBranch: repository?.defaultBranch ?? null,
      source: 'GITHUB_REST', observedAt, coverage, reason, revision: digest([repositoryId, repository, values, coverage, observedAt]), items: values }
  }

  project(inventory: BranchInventory, catalog: PullRequestCatalog): BranchPullRequests {
    if (inventory.repositoryId !== catalog.repositoryId) throw new Error('REPOSITORY_CONTEXT_CHANGED')
    const relations: BranchPullRequestRelation[] = [], linked = new Set<string>()
    const byRef = new Map<string, PullRequestRecord[]>()
    for (const pr of catalog.items) {
      const group = byRef.get(pr.head.ref) ?? []; group.push(pr); byRef.set(pr.head.ref, group)
    }
    for (const branch of inventory.branches) {
      if (branch.namespace !== 'LOCAL') continue
      const candidates = byRef.get(branch.name) ?? []
      for (const pr of candidates) {
        const proofKey = `${inventory.repositoryId}:${branch.key}:${pr.id}`
        const prior = this.verified.get(proofKey)
        const origin = catalog.providerRepositoryId !== null && pr.head.repositoryId === catalog.providerRepositoryId && pr.head.repository?.toLowerCase() === catalog.repository?.toLowerCase() && pr.base.repositoryId === catalog.providerRepositoryId
        const current = origin && pr.head.sha === branch.head
        const historical = origin && prior?.generation === branch.generation && branch.generation !== 'UNKNOWN'
        const classification = current ? 'CONFIRMED_CURRENT' : historical ? 'CONFIRMED_HISTORICAL' : candidates.length > 1 ? 'AMBIGUOUS' : origin ? 'CANDIDATE' : 'UNKNOWN'
        if (current) {
          if (this.verified.size >= 5000) this.verified.delete(this.verified.keys().next().value!)
          this.verified.set(proofKey, { generation: branch.generation, pr, observedAt: catalog.observedAt })
        }
        relations.push({ branchKey: branch.key, branchRevision: branch.revision, branchGeneration: branch.generation, repositoryId: inventory.repositoryId,
          ref: branch.ref, head: branch.head, source: 'GITHUB_REST', catalogRevision: catalog.revision, observedAt: catalog.observedAt, coverage: catalog.coverage, classification, pullRequest: pr,
          ...(classification === 'CONFIRMED_HISTORICAL' ? { historicalEvidence: { sha: prior!.pr.head.sha, observedAt: prior!.observedAt } } : {}) })
        if (current || historical) linked.add(pr.id)
      }
    }
    return { repositoryId: inventory.repositoryId, catalog, relations, orphaned: catalog.items.filter(pr => !linked.has(pr.id)) }
  }
}
