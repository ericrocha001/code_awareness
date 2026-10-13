import { createHash } from 'node:crypto'
import type { GitOperationsService } from '../git-operations/git-operations-service'
import type { ObservableWorktree, OrchestrationOverview, WorktreePair, WorktreeObservation, OrchestrationRequest, LocalChangesPage } from '../../shared/types/work-orchestration-types'

export type OrchestrationGitReader = Pick<GitOperationsService, 'discoverCoordinationWorktrees' | 'getCoordinationSnapshot' | 'getCoordinationCommitPaths'> & Partial<Pick<GitOperationsService, 'getWorktreeChanges'>>
type Observation = Awaited<ReturnType<OrchestrationGitReader['getCoordinationSnapshot']>>
const reason = (error: unknown) => error instanceof Error ? error.message : 'GIT_READ_UNAVAILABLE'
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const changed = (a: Observation, b: Observation) => a.record.generation !== b.record.generation || digest(a.snapshot) !== digest(b.snapshot)
const project = ({ record, paths: _paths, ...observation }: Observation): ObservableWorktree => ({ ...record, ...observation, snapshotRevision: digest(observation.snapshot), head: observation.snapshot.head, branch: observation.snapshot.branch, observation: 'VERIFIED', reason: null })

export class WorkOrchestrationService {
  private known: Awaited<ReturnType<WorkOrchestrationService['records']>> | null = null
  constructor(private readonly git: OrchestrationGitReader) {}

  private async records() {
    const first = await this.git.discoverCoordinationWorktrees()
    const records = [...first.worktrees]
    let cursor = first.nextCursor
    while (cursor) {
      const page = await this.git.discoverCoordinationWorktrees({ cursor })
      if (page.repositoryId !== first.repositoryId) throw new Error('WORKTREE_REPOSITORY_CHANGED')
      records.push(...page.worktrees)
      cursor = page.nextCursor
    }
    return { repositoryId: first.repositoryId, records, revision: first.revision }
  }

  async inventory(): Promise<OrchestrationOverview> {
    const { repositoryId, records, revision } = await this.records()
    this.known = { repositoryId, records, revision }
    return { repositoryId, revision, observedAt: new Date().toISOString(), inventoryCoverage: 'COMPLETE', relationsCoverage: 'NOT_EVALUATED', pairs: [],
      worktrees: records.map(record => ({ ...record, head: record.head && !/^0+$/.test(record.head) ? record.head : null,
        snapshot: null, observation: 'NOT_OBSERVED', stagedCount: null, unstagedCount: null, untrackedCount: null, conflictCount: null,
        reason: record.missing ? 'WORKTREE_MISSING' : record.prunable ? 'WORKTREE_PRUNABLE' : null })) }
  }

  async observe(worktreeId: string): Promise<WorktreeObservation> {
    const { repositoryId, records } = this.known ?? await this.records()
    const record = records.find(record => record.worktreeId === worktreeId)
    if (!record) throw new Error('WORKTREE_NOT_DISCOVERED')
    try {
      const worktree = project(await this.git.getCoordinationSnapshot(worktreeId)), observedAt = new Date().toISOString()
      return { repositoryId, worktree: { ...worktree, observedAt }, observedAt }
    } catch (error) {
      return { repositoryId, observedAt: new Date().toISOString(), worktree: { ...record, snapshot: null, observation: 'UNAVAILABLE',
        stagedCount: null, unstagedCount: null, untrackedCount: null, conflictCount: null, reason: reason(error) } }
    }
  }

  async changes(request: NonNullable<OrchestrationRequest['changes']>): Promise<LocalChangesPage> {
    const { repositoryId, records } = this.known ?? await this.records()
    if (!records.some(record => record.worktreeId === request.worktreeId && record.generation === request.generation)) throw new Error('WORKTREE_STALE')
    if (!this.git.getWorktreeChanges) throw new Error('GIT_READ_UNAVAILABLE')
    const page = await this.git.getWorktreeChanges({ worktreeId: request.worktreeId, pageSize: 50, cursor: request.cursor,
      pathPrefixes: request.pathPrefix ? [request.pathPrefix] : undefined })
    if (page.generation !== request.generation || digest(page.snapshot) !== request.snapshotRevision) throw new Error('GIT_STATE_CHANGED')
    return { repositoryId, worktreeId: page.worktreeId, generation: page.generation, snapshotRevision: request.snapshotRevision,
      changes: page.changes, totalCount: page.totalCount, revision: page.revision, nextCursor: page.nextCursor }
  }

  private async compare(repositoryId: string, left: ObservableWorktree, right: ObservableWorktree, observations: Map<string, Observation>): Promise<WorktreePair> {
    const pair: WorktreePair = { repositoryId, left, right, base: null, category: 'INDETERMINATE', reason: left.reason ?? right.reason,
      paths: [], totalPaths: 0, revision: '', nextCursor: null }
    if (!left.snapshot?.head || !right.snapshot?.head) pair.reason ??= 'HEAD_UNAVAILABLE'
    if (!pair.reason) try {
      const commits = await this.git.getCoordinationCommitPaths(left.snapshot!.head!, right.snapshot!.head!)
      pair.base = commits.base
      const leftPaths = new Set([...commits.left, ...observations.get(left.worktreeId)!.paths])
      const rightPaths = new Set([...commits.right, ...observations.get(right.worktreeId)!.paths])
      pair.paths = [...leftPaths].filter(path => rightPaths.has(path)).sort()
      pair.totalPaths = pair.paths.length
      pair.category = pair.totalPaths ? 'PATH_OVERLAP' : 'NO_PATH_OVERLAP'
    } catch (error) { pair.reason = reason(error) }
    pair.revision = digest([repositoryId, left.worktreeId, left.generation, left.snapshot, right.worktreeId, right.generation, right.snapshot, pair.base, pair.category, pair.paths])
    return pair
  }

  private page(pair: WorktreePair, cursor?: string): WorktreePair {
    let offset = 0
    if (cursor) {
      if (!/^[a-f0-9]{64}:\d+$/.test(cursor)) throw new Error('INVALID_ARGUMENT')
      const [revision, raw] = cursor.split(':')
      offset = Number(raw)
      if (revision !== pair.revision) throw new Error('GIT_STATE_CHANGED')
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > pair.totalPaths) throw new Error('INVALID_ARGUMENT')
    }
    const end = Math.min(offset + 100, pair.totalPaths)
    return { ...pair, paths: pair.paths.slice(offset, end), nextCursor: end < pair.totalPaths ? `${pair.revision}:${end}` : null }
  }

  async pair(leftId: string, rightId: string, cursor?: string): Promise<WorktreePair> {
    if (leftId === rightId) throw new Error('INVALID_ARGUMENT')
    const { repositoryId, records } = await this.records()
    if (![leftId, rightId].every(id => records.some(r => r.worktreeId === id))) throw new Error('WORKTREE_NOT_DISCOVERED')
    const observations = new Map<string, Observation>()
    const sides: ObservableWorktree[] = []
    for (const id of [leftId, rightId]) {
      const observed = await this.git.getCoordinationSnapshot(id)
      observations.set(id, observed); sides.push(project(observed))
    }
    const pair = await this.compare(repositoryId, sides[0], sides[1], observations)
    for (const [id, observed] of observations) {
      try {
        if (changed(observed, await this.git.getCoordinationSnapshot(id))) throw new Error('GIT_STATE_CHANGED')
      } catch (error) {
        pair.category = 'STALE'; pair.reason = reason(error); pair.paths = []; pair.totalPaths = 0; pair.nextCursor = null
      }
    }
    return this.page(pair, cursor)
  }
}
