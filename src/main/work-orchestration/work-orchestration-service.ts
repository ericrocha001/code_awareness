import { createHash } from 'node:crypto'
import { readWorktreeDocumentContext, type OrchestrationContinuumReader } from './worktree-document-context'
import type { WorktreeDocumentRequest } from '../../shared/types/worktree-document-context-types'
import type { GitOperationsService } from '../git-operations/git-operations-service'
import type { ObservableWorktree, OrchestrationOverview, WorktreeObservation, OrchestrationRequest, LocalChangesPage } from '../../shared/types/work-orchestration-types'

export type OrchestrationGitReader = Pick<GitOperationsService, 'discoverCoordinationWorktrees' | 'getCoordinationSnapshot' | 'getCoordinationCommitPaths'> & Partial<Pick<GitOperationsService, 'getWorktreeChanges' | 'getCoordinationIdentity' | 'getWorktreeCommits' | 'getCommitWorktrees' | 'getWorktreeTimeline' | 'evaluateWorktreeIntegration'>>
type Observation = Awaited<ReturnType<OrchestrationGitReader['getCoordinationSnapshot']>>
const reason = (error: unknown) => error instanceof Error ? error.message : 'GIT_READ_UNAVAILABLE'
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const project = ({ record, paths: _paths, ...observation }: Observation): ObservableWorktree => ({ ...record, ...observation, snapshotRevision: digest(observation.snapshot), head: observation.snapshot.head, branch: observation.snapshot.branch, observation: 'VERIFIED', reason: null })

export class WorkOrchestrationService {
  private known: Awaited<ReturnType<WorkOrchestrationService['records']>> | null = null
  private pendingRecords: Promise<Awaited<ReturnType<WorkOrchestrationService['readRecords']>>> | null = null
  private readonly pendingSnapshots = new Map<string, Promise<Observation>>()
  private readers = 0
  private readonly waitingReaders: Array<() => void> = []
  constructor(private readonly git: OrchestrationGitReader, private readonly continuum?: OrchestrationContinuumReader) {}

  async withReadBudget<T>(read: () => Promise<T>): Promise<T> {
    if (this.readers >= 2) await new Promise<void>(resolve => this.waitingReaders.push(resolve))
    else this.readers++
    try { return await read() }
    finally { const next = this.waitingReaders.shift(); if (next) next(); else this.readers-- }
  }
  coordinationSnapshot(id: string): Promise<Observation> {
    const existing = this.pendingSnapshots.get(id)
    if (existing) return existing
    const read = this.withReadBudget(() => this.git.getCoordinationSnapshot(id)).finally(() => { this.pendingSnapshots.delete(id) })
    this.pendingSnapshots.set(id, read)
    return read
  }

  async documents(request: WorktreeDocumentRequest) {
    if (!this.git.getCoordinationIdentity) throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
    return readWorktreeDocumentContext({ getCoordinationIdentity: id => this.git.getCoordinationIdentity!(id) }, this.continuum, request)
  }
  async timeline(request: NonNullable<OrchestrationRequest['timeline']>) {
    if (!this.git.getWorktreeTimeline) throw new Error('TIMELINE_UNAVAILABLE')
    return this.withReadBudget(async () => { const timeline = await this.git.getWorktreeTimeline!({ ...request }); return { repositoryId: timeline.repositoryId, timeline } })
  }
  async integration(request: NonNullable<OrchestrationRequest['integration']>) {
    if (!this.git.evaluateWorktreeIntegration) throw new Error('INTEGRATION_EVIDENCE_UNAVAILABLE')
    return this.withReadBudget(() => this.git.evaluateWorktreeIntegration!(request))
  }

  private records() {
    return this.pendingRecords ??= this.readRecords().finally(() => { this.pendingRecords = null })
  }
  private async readRecords() {
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
    return { repositoryId, revision, observedAt: new Date().toISOString(), inventoryCoverage: 'COMPLETE',
      worktrees: records.map(record => ({ ...record, head: record.head && !/^0+$/.test(record.head) ? record.head : null,
        snapshot: null, observation: 'NOT_OBSERVED', stagedCount: null, unstagedCount: null, untrackedCount: null, conflictCount: null,
        reason: record.missing ? 'WORKTREE_MISSING' : record.prunable ? 'WORKTREE_PRUNABLE' : null })) }
  }

  async observe(worktreeId: string): Promise<WorktreeObservation> {
    const { repositoryId, records } = this.known ?? await this.records()
    const record = records.find(record => record.worktreeId === worktreeId)
    if (!record) throw new Error('WORKTREE_NOT_DISCOVERED')
    try {
      const worktree = project(await this.coordinationSnapshot(worktreeId)), observedAt = new Date().toISOString()
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
    const page = await this.withReadBudget(() => this.git.getWorktreeChanges!({ worktreeId: request.worktreeId, pageSize: 50, cursor: request.cursor,
      pathPrefixes: request.pathPrefix ? [request.pathPrefix] : undefined }))
    if (page.generation !== request.generation || digest(page.snapshot) !== request.snapshotRevision) throw new Error('GIT_STATE_CHANGED')
    return { repositoryId, worktreeId: page.worktreeId, generation: page.generation, snapshotRevision: request.snapshotRevision,
      changes: page.changes, totalCount: page.totalCount, revision: page.revision, nextCursor: page.nextCursor }
  }

}
