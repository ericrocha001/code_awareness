import { createHash } from 'node:crypto'
import type { GitService } from '../core/git-service'
import type { GitWorktreeRegistry, WorktreeIdentity } from './git-worktree-registry'
import type { LocalCommitOperation, WorktreeTimelinePage, WorktreeTimelineQuery } from '../../shared/types/worktree-integration-evidence-types'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const operation = (message: string): LocalCommitOperation | null => message.startsWith('commit: ') ? 'COMMIT' : message.startsWith('commit (initial): ') ? 'INITIAL_COMMIT' :
  message.startsWith('commit (amend): ') ? 'AMEND' : message.startsWith('cherry-pick: ') && message !== 'cherry-pick: fast-forward' ? 'CHERRY_PICK' : message.startsWith('rebase (pick): ') ? 'REBASE_PICK' : null

export async function readWorktreeProvenance(git: GitService, registry: GitWorktreeRegistry, identity: WorktreeIdentity, query: WorktreeTimelineQuery): Promise<WorktreeTimelinePage> {
  if (!query || Object.keys(query).some(key => !['worktreeId', 'generation'].includes(key)) || !/^[a-f0-9]{64}$/.test(query.worktreeId) || typeof query.generation !== 'string' || !query.generation || query.generation.length > 256) throw new Error('INVALID_ARGUMENT')
  const current = () => { if (!identity.isActive()) throw new Error('WORKTREE_REPOSITORY_CHANGED') }
  const selection = async () => {
    try { return await registry.revalidateSelection(query.worktreeId) }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'WORKTREE_NOT_DISCOVERED') throw error
      await registry.discover({ reuseValidatedDirectories: true })
      return registry.revalidateSelection(query.worktreeId)
    }
  }
  current()
  const before = await selection()
  if (before.generation !== query.generation) throw new Error('WORKTREE_STALE')
  const topology = await git.getCommitTopologyRevision(before.path)
  const log = await git.readHeadReflog(before.path), reasons = ['REFLOG_RETENTION_NOT_ATTESTED']
  type Event = typeof log.records[number] & { operation: LocalCommitOperation; originalTip: string | null }
  const events: Event[] = []
  let originalTip: string | null = null
  for (const record of log.records) {
    if (record.message.startsWith('rebase (start): ')) originalTip = record.oldSha
    const kind = operation(record.message)
    if (kind) events.push({ ...record, operation: kind, originalTip: kind === 'REBASE_PICK' ? originalTip : null })
    if (/^rebase \((finish|abort)\): /.test(record.message)) originalTip = null
  }
  const candidates = [...new Set(events.slice().reverse().map(event => event.sha))].slice(0, 500)
  const selectedEvents = events.filter(event => candidates.includes(event.sha))
  const objectIds = [...new Set([...candidates, ...selectedEvents.filter(event => !/^0+$/.test(event.oldSha)).map(event => event.oldSha)])]
  const objects = new Map((await git.getCommitOperationObjects(before.path, objectIds.slice(0, 1000))).map(object => [object.sha, object]))
  let omitted = 0, limited = log.truncated || new Set(events.map(e => e.sha)).size > candidates.length || objectIds.length > 1000
  const rebases = new Map<string, Set<string>>()
  for (const event of selectedEvents) if (event.operation === 'REBASE_PICK' && event.originalTip) {
    const shas = rebases.get(event.originalTip) ?? new Set<string>(); shas.add(event.sha); rebases.set(event.originalTip, shas)
  }
  const rewritten = new Map<string, Set<string>>()
  for (const [tip, shas] of [...rebases].slice(0, 20)) {
    try { rewritten.set(tip, new Set(await git.getUnreachableOperationCommits(before.path, tip, [...shas]))) }
    catch { reasons.push('REBASE_REWRITE_UNVERIFIABLE') }
  }
  if (rebases.size > 20) { limited = true; reasons.push('REBASE_SESSION_LIMIT') }
  const grouped = new Map<string, WorktreeTimelinePage['items'][number]>()
  for (const event of selectedEvents.slice().reverse()) {
    const object = objects.get(event.sha), previous = objects.get(event.oldSha)
    if (!object) { omitted++; continue }
    const valid = event.operation === 'INITIAL_COMMIT' ? /^0+$/.test(event.oldSha) && !object.parents.length : event.operation === 'AMEND' ? previous && hash(previous.parents) === hash(object.parents) :
      object.parents.length === 1 && object.parents[0] === event.oldSha && (event.operation !== 'REBASE_PICK' || event.originalTip && rewritten.get(event.originalTip)?.has(event.sha))
    if (!valid) { omitted++; continue }
    const item = grouped.get(event.sha) ?? { sha: event.sha, title: object.title, reachability: 'UNKNOWN' as const, events: [] }
    item.events.push({ operation: event.operation, eventAt: event.eventAt, sequence: event.sequence }); grouped.set(event.sha, item)
  }
  const items = [...grouped.values()]
  let unreachable: Set<string> | null = null
  try { if (before.head && !/^0+$/.test(before.head)) unreachable = new Set(await git.getUnreachableOperationCommits(before.path, before.head, items.map(item => item.sha))) }
  catch { reasons.push('REACHABILITY_UNAVAILABLE') }
  for (const item of items) item.reachability = item.sha === before.head ? 'HEAD_CURRENT' : unreachable ? unreachable.has(item.sha) ? 'NOT_REACHABLE' : 'REACHABLE' : 'UNKNOWN'
  if (log.malformed) reasons.push('MALFORMED_REFLOG_RECORDS')
  if (omitted) reasons.push('OPERATIONS_OR_OBJECTS_UNVERIFIABLE')
  if (limited) reasons.push('OBSERVATION_LIMIT')
  const after = await selection(), finalLog = await git.readHeadReflog(after.path)
  current()
  if (hash(before) !== hash(after) || hash([log.admin, log.revision]) !== hash([finalLog.admin, finalLog.revision]) || topology !== await git.getCommitTopologyRevision(after.path)) throw new Error('GIT_STATE_CHANGED')
  return { repositoryId: identity.repositoryId, worktreeId: before.worktreeId, generation: before.generation, head: before.head, source: 'HEAD_REFLOG',
    revision: hash([before, log.revision, items]), observedAt: new Date().toISOString(), coverage: log.exists && log.bytes ? 'PARTIAL' : 'UNAVAILABLE', reasons: [...new Set(reasons)],
    observedEvents: log.records.length + log.malformed, identifiedCount: items.length, omitted, truncated: limited, items }
}
