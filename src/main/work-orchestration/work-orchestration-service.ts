import { createHash } from 'node:crypto'
import type { GitOperationsService } from '../git-operations/git-operations-service'
import type { ObservableWorktree, OrchestrationOverview, WorktreePair } from '../../shared/types/work-orchestration-types'

export type OrchestrationGitReader = Pick<GitOperationsService, 'discoverWorktrees' | 'getCoordinationSnapshot' | 'getCoordinationCommitPaths'>
type Observation = Awaited<ReturnType<OrchestrationGitReader['getCoordinationSnapshot']>>
const reason = (error: unknown) => error instanceof Error ? error.message : 'GIT_READ_UNAVAILABLE'
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const changed = (a: Observation, b: Observation) => a.record.generation !== b.record.generation || digest(a.snapshot) !== digest(b.snapshot)
const project = ({ record, paths: _paths, ...observation }: Observation): ObservableWorktree => ({ ...record, ...observation, head: observation.snapshot.head, branch: observation.snapshot.branch, reason: null })

export class WorkOrchestrationService {
  constructor(private readonly git: OrchestrationGitReader) {}

  private async inventory() {
    const first = await this.git.discoverWorktrees()
    const records = [...first.worktrees]
    let cursor = first.nextCursor
    while (cursor) {
      const page = await this.git.discoverWorktrees({ cursor })
      if (page.repositoryId !== first.repositoryId) throw new Error('WORKTREE_REPOSITORY_CHANGED')
      records.push(...page.worktrees)
      cursor = page.nextCursor
    }
    return { repositoryId: first.repositoryId, records }
  }

  async overview(): Promise<OrchestrationOverview> {
    const { repositoryId, records } = await this.inventory()
    const observations = new Map<string, Observation>()
    const worktrees: ObservableWorktree[] = []
    for (const record of records) {
      try {
        const observed = await this.git.getCoordinationSnapshot(record.worktreeId)
        observations.set(record.worktreeId, observed)
        worktrees.push(project(observed))
      } catch (error) {
        worktrees.push({ ...record, reference: false, snapshot: null, stagedCount: 0, unstagedCount: 0, untrackedCount: 0, conflictCount: 0, reason: reason(error) })
      }
    }
    const secondary = worktrees.filter(w => !w.reference)
    const budgetExceeded = worktrees.filter(w => !w.missing && !w.prunable).length > 12
    const pairs: WorktreePair[] = []
    if (!budgetExceeded) {
      for (let i = 0; i < secondary.length; i++) for (let j = i + 1; j < secondary.length; j++) {
        pairs.push(this.page(await this.compare(repositoryId, secondary[i], secondary[j], observations)))
      }
    }
    const stale = new Map<string, string>()
    for (const [id, observed] of observations) {
      try {
        if (changed(observed, await this.git.getCoordinationSnapshot(id))) stale.set(id, 'GIT_STATE_CHANGED')
      } catch (error) { stale.set(id, reason(error)) }
    }
    for (const worktree of worktrees) if (stale.has(worktree.worktreeId)) worktree.reason = stale.get(worktree.worktreeId)!
    for (const pair of pairs) if (stale.has(pair.left.worktreeId) || stale.has(pair.right.worktreeId)) {
      pair.category = 'STALE'; pair.reason = 'GIT_STATE_CHANGED'; pair.paths = []; pair.totalPaths = 0; pair.nextCursor = null
    }
    const incomplete = budgetExceeded || worktrees.some(w => w.reason) || pairs.some(p => ['STALE', 'INDETERMINATE'].includes(p.category))
    return { repositoryId, worktrees, pairs, coverage: incomplete ? 'PARTIAL' : 'COMPLETE',
      reason: budgetExceeded ? 'PAIR_BUDGET_EXCEEDED' : incomplete ? 'READ_INCOMPLETE' : null, automaticLimit: 12 }
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
    const { repositoryId, records } = await this.inventory()
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
