import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { GitService } from '../core/git-service'
import type { GitWorktreeRegistry, WorktreeIdentity, WorktreeRecord } from './git-worktree-registry'
import type { GitCorrelationQuery, GitWorktreeCommitsQuery, GitCommitWorktreesQuery, GitWorktreeCommitsPage, GitCommitWorktreesPage, GitCorrelationWorktree } from '../../shared/types/git-commit-correlation-types'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function fail(code: string): never { throw new Error(code) }
const fullSha = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
const project = (r: WorktreeRecord): GitCorrelationWorktree => ({ worktreeId: r.worktreeId, generation: r.generation, branch: r.branch, detached: r.detached, head: r.head! })
type Position = { revision: string; offset: number; matched: number; unavailable: number }

export class GitCommitCorrelation {
  private readonly cursorKey = randomBytes(32)
  constructor(private readonly root: string, private readonly git: GitService, private readonly registry: GitWorktreeRegistry, private readonly identity: WorktreeIdentity) {}
  private current() { if (!this.identity.isActive()) fail('WORKTREE_REPOSITORY_CHANGED') }
  private validate(query: GitCorrelationQuery, fields: string[]) {
    if (!query || Object.keys(query).some(key => ![...fields, 'mode', 'reference', 'limit', 'cursor', 'contextKey'].includes(key)) ||
      query.mode !== undefined && !['REACHABLE', 'EXCLUSIVE'].includes(query.mode) || query.contextKey !== undefined && (typeof query.contextKey !== 'string' || query.contextKey.length > 512) ||
      query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length > 2048)) fail('INVALID_ARGUMENT')
    const mode = query.mode ?? 'REACHABLE', limit = query.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (mode === 'EXCLUSIVE') !== (query.reference !== undefined)) fail('INVALID_ARGUMENT')
    if (query.reference !== undefined && (typeof query.reference !== 'string' || query.reference.length > 256 ||
      !(fullSha(query.reference) || query.reference === 'HEAD' || /^refs\/(heads|remotes|tags)\/[^\s~^:?*\[\\]+$/.test(query.reference)) || query.reference.includes('..') || query.reference.endsWith('/'))) fail('INVALID_ARGUMENT')
    return { mode, limit }
  }
  private async reference(query: GitCorrelationQuery) {
    if (!query.reference) return null
    try { return { ref: query.reference, sha: await this.git.resolveCommit(this.root, query.reference, { noLazyFetch: true }) } }
    catch { return fail('REFERENCE_UNAVAILABLE') }
  }
  private cursor(position: Position) {
    const payload = Buffer.from(JSON.stringify(position)).toString('base64url')
    return payload + '.' + createHmac('sha256', this.cursorKey).update(payload).digest('base64url')
  }
  private position(cursor: string | undefined, revision: string): Position {
    if (!cursor) return { revision, offset: 0, matched: 0, unavailable: 0 }
    try {
      const [payload, signature, extra] = cursor.split('.'), expected = createHmac('sha256', this.cursorKey).update(payload).digest(), actual = Buffer.from(signature, 'base64url')
      if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('GIT_STATE_CHANGED')
      const position = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Position
      if (position.revision !== revision || ![position.offset, position.matched, position.unavailable].every(n => Number.isSafeInteger(n) && n >= 0)) fail('GIT_STATE_CHANGED')
      return position
    } catch { return fail('GIT_STATE_CHANGED') }
  }
  private async selection(id: string) {
    try { return await this.registry.revalidateSelection(id) }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'WORKTREE_NOT_DISCOVERED') throw error
      const record = (await this.registry.discover()).worktrees.find(r => r.worktreeId === id)
      if (!record || record.missing || record.prunable) fail('WORKTREE_STALE')
      return record
    }
  }
  async worktreeCommits(query: GitWorktreeCommitsQuery): Promise<GitWorktreeCommitsPage> {
    this.current()
    const { mode, limit } = this.validate(query, ['worktreeId', 'generation'])
    if (typeof query.worktreeId !== 'string' || !/^[a-f0-9]{64}$/.test(query.worktreeId) || typeof query.generation !== 'string' || !query.generation || query.generation.length > 256) fail('INVALID_ARGUMENT')
    const before = await this.selection(query.worktreeId), reference = await this.reference(query), topology = await this.git.getCommitTopologyRevision(this.root)
    if (before.generation !== query.generation) fail('WORKTREE_STALE')
    if (!fullSha(before.head) || /^0+$/.test(before.head)) fail('HEAD_UNAVAILABLE')
    const revision = digest([this.identity.repositoryId, 'WORKTREE_COMMITS', before, mode, reference, topology, limit, query.contextKey]), position = this.position(query.cursor, revision)
    const rows = await this.git.getReachableCommitPage(this.root, before.head, reference?.sha ?? null, position.offset, limit + 1)
    const after = await this.selection(query.worktreeId), currentReference = await this.reference(query)
    this.current()
    if (digest(before) !== digest(after) || digest(reference) !== digest(currentReference) || topology !== await this.git.getCommitTopologyRevision(this.root)) fail('GIT_STATE_CHANGED')
    const items = rows.slice(0, limit).map(sha => ({ sha, relation: sha === before.head ? 'HEAD_EXACT' as const : 'REACHABLE_FROM_HEAD' as const, referenceRelation: reference ? 'EXCLUSIVE_RELATIVE_TO_REFERENCE' as const : null }))
    const more = rows.length > limit
    return { direction: 'WORKTREE_COMMITS', repositoryId: this.identity.repositoryId, worktree: project(before), revision, observedAt: new Date().toISOString(), reference, mode,
      items, coverage: more ? 'PARTIAL' : 'COMPLETE', outcome: items.length || position.matched ? 'MATCHES' : 'NONE_VERIFIED',
      nextCursor: more ? this.cursor({ revision, offset: position.offset + items.length, matched: position.matched + items.length, unavailable: 0 }) : null }
  }
  async commitWorktrees(query: GitCommitWorktreesQuery): Promise<GitCommitWorktreesPage> {
    this.current()
    const { mode, limit } = this.validate(query, ['sha'])
    if (!fullSha(query.sha)) fail('INVALID_ARGUMENT')
    try { if (await this.git.resolveCommit(this.root, query.sha, { noLazyFetch: true }) !== query.sha) fail('COMMIT_UNAVAILABLE') } catch { fail('COMMIT_UNAVAILABLE') }
    const before = await this.registry.discover({ reuseValidatedDirectories: true }), reference = await this.reference(query), topology = await this.git.getCommitTopologyRevision(this.root)
    const records = [...before.worktrees].sort((a, b) => a.worktreeId.localeCompare(b.worktreeId)), revision = digest([before.repositoryId, 'COMMIT_WORKTREES', records, query.sha, mode, reference, topology, limit, query.contextKey])
    const position = this.position(query.cursor, revision)
    if (position.offset > records.length) fail('GIT_STATE_CHANGED')
    let excluded = false
    if (reference) excluded = await this.git.isCommitReachable(this.root, query.sha, reference.sha)
    const candidates = records.slice(position.offset, position.offset + limit), proofs = new Map<string, boolean | null>(), unavailable: GitCommitWorktreesPage['unavailable'] = [], items: GitCommitWorktreesPage['items'] = []
    for (let start = 0; start < candidates.length; start += 4) {
      const heads = [...new Set(candidates.slice(start, start + 4).filter(r => !r.missing && !r.prunable && fullSha(r.head) && !/^0+$/.test(r.head!) && r.head !== query.sha && !excluded).map(r => r.head!))].filter(head => !proofs.has(head))
      await Promise.all(heads.map(async head => { try { proofs.set(head, await this.git.isCommitReachable(this.root, query.sha, head)) } catch { proofs.set(head, null) } }))
      for (const r of candidates.slice(start, start + 4)) {
        if (r.missing || r.prunable || !fullSha(r.head) || /^0+$/.test(r.head)) { unavailable.push({ worktreeId: r.worktreeId, generation: r.generation, reason: r.missing ? 'WORKTREE_MISSING' : r.prunable ? 'WORKTREE_PRUNABLE' : 'HEAD_UNAVAILABLE' }); continue }
        if (excluded) continue
        if (r.head !== query.sha && (proofs.get(r.head) === null || !proofs.has(r.head))) { unavailable.push({ worktreeId: r.worktreeId, generation: r.generation, reason: 'REACHABILITY_UNAVAILABLE' }); continue }
        if (r.head === query.sha || proofs.get(r.head)) items.push({ ...project(r), sha: query.sha, relation: r.head === query.sha ? 'HEAD_EXACT' : 'REACHABLE_FROM_HEAD', referenceRelation: reference ? 'EXCLUSIVE_RELATIVE_TO_REFERENCE' : null })
      }
    }
    const after = await this.registry.discover({ reuseValidatedDirectories: true }), currentReference = await this.reference(query)
    this.current()
    if (after.repositoryId !== before.repositoryId || digest(records) !== digest([...after.worktrees].sort((a, b) => a.worktreeId.localeCompare(b.worktreeId))) || digest(reference) !== digest(currentReference) || topology !== await this.git.getCommitTopologyRevision(this.root)) fail('GIT_STATE_CHANGED')
    const end = position.offset + candidates.length, matched = position.matched + items.length, unknown = position.unavailable + unavailable.length, more = end < records.length
    return { direction: 'COMMIT_WORKTREES', repositoryId: before.repositoryId, sha: query.sha, revision, observedAt: new Date().toISOString(), reference, mode, items, unavailable,
      scope: { total: records.length, start: position.offset, end, matched, unavailable: unknown }, coverage: more || unknown ? 'PARTIAL' : 'COMPLETE', outcome: matched ? 'MATCHES' : more || unknown ? 'UNKNOWN' : 'NONE_VERIFIED',
      nextCursor: more ? this.cursor({ revision, offset: end, matched, unavailable: unknown }) : null }
  }
}
