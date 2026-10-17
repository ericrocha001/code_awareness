import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import type { GitService } from '../core/git-service'
import type { GitWorktreeRegistry, WorktreeIdentity } from './git-worktree-registry'
import type { BranchDate, BranchHistoryPage, BranchHistoryQuery, BranchInventory, BranchRecord } from '../../shared/types/branch-orchestration-types'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function chronology(common: string, ref: string): { creation: BranchDate; generation: string } {
  const unknown = { creation: { at: null, source: 'UNKNOWN' as const }, generation: 'UNKNOWN' }
  const file = join(common, 'logs', ref)
  if (!existsSync(file)) return unknown
  const path = relative(common, realpathSync(file))
  if (path.startsWith('..') || isAbsolute(path) || lstatSync(file).size > 1048576) return unknown
  const bytes = readFileSync(file)
  const lines = bytes.toString('utf8').trimEnd().split('\n')
  const parsed = lines.map(line => /^([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) .+ (\d+) [+-]\d{4}\t(.*)$/.exec(line))
  const first = parsed[0]
  const intact = parsed.every((row, i) => row && (!i || row[1] === parsed[i - 1]?.[2]))
  const at = first && Number(first[3]) * 1000
  const created = intact && first && /^0+$/.test(first[1]) && first[4].startsWith('branch: Created from ') && at && Number.isFinite(at) && at <= Date.now()
  const stat = lstatSync(file, { bigint: true })
  const generation = digest([first?.[0] ?? bytes.toString('hex'), String(stat.dev), String(stat.ino), String(stat.birthtimeNs)])
  const receiptFile = join(common, 'code-awareness-branch-events', digest(ref) + '.json')
  let creation: BranchDate = created ? { at: new Date(at).toISOString(), source: 'LOCAL_REFLOG' } : unknown.creation
  if (existsSync(receiptFile) && lstatSync(receiptFile).size < 16384) {
    try {
      const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'))
      if (receipt.ref === ref && receipt.generation === generation && typeof receipt.createdAt === 'string' && Number.isFinite(Date.parse(receipt.createdAt))) creation = { at: receipt.createdAt, source: 'APP_RECEIPT' }
    } catch { /* An unreadable receipt cannot strengthen historical evidence. */ }
  }
  return { creation, generation }
}

export async function recordBranchCreation(root: string, git: GitService, ref: string, createdAt: string) {
  const common = realpathSync(await git.getCommonDirectory(root))
  const { generation } = chronology(common, ref)
  const head = await git.resolveCommit(root, ref)
  const receipt = { ref, generation, head, createdAt }
  const directory = join(common, 'code-awareness-branch-events')
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error('BRANCH_RECEIPT_LINK_NOT_ALLOWED')
  mkdirSync(directory, { recursive: true })
  const file = join(directory, digest(ref) + '.json'), temporary = file + '.' + randomUUID() + '.tmp'
  writeFileSync(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 })
  renameSync(temporary, file)
  return receipt
}

export class GitBranchInventory {
  constructor(private readonly root: string, private readonly git: GitService, private readonly registry: GitWorktreeRegistry, private readonly identity: WorktreeIdentity) {}

  async executionSnapshot(worktreeId: string, generation: string): Promise<import('../../shared/types/execution-branch-types').ExecutionBranchSnapshot> {
    const inventory = await this.inventory()
    const tree = inventory.worktrees.find(w => w.worktreeId === worktreeId && w.generation === generation)
    if (!tree || tree.missing || tree.prunable || tree.detached || !tree.branch || !tree.head) throw new Error('WORKTREE_STALE')
    const branch = inventory.branches.find(b => b.namespace === 'LOCAL' && b.ref === 'refs/heads/' + tree.branch && b.head === tree.head && b.worktrees.some(w => w.worktreeId === tree.worktreeId && w.generation === tree.generation))
    if (!branch) throw new Error('BRANCH_IDENTITY_UNAVAILABLE')
    if (branch.generation === 'UNKNOWN') throw new Error('BRANCH_GENERATION_UNKNOWN')
    const snapshot = { repositoryId: inventory.repositoryId, branchRef: branch.ref, branchGeneration: branch.generation, branchRevision: branch.revision,
      head: branch.head, worktreeId, worktreeGeneration: generation }
    return { ...snapshot, fingerprint: digest(snapshot) }
  }

  async inventory(): Promise<BranchInventory> {
    const current = () => { if (!this.identity.isActive()) throw new Error('WORKTREE_REPOSITORY_CHANGED') }
    current()
    const common = realpathSync(await this.git.getCommonDirectory(this.root))
    const initialTrees = await this.git.listWorktreeRecords(this.root)
    const [raw, discovered] = await Promise.all([this.git.getBranchInventoryReferences(this.root), this.registry.discover({ reuseValidatedDirectories: true })])
    const occupants = new Map<string, typeof discovered.worktrees>()
    for (const tree of discovered.worktrees) {
      if (!tree.detached && !tree.missing && !tree.prunable && tree.branch) {
        const group = occupants.get(tree.branch) ?? []
        group.push(tree); occupants.set(tree.branch, group)
      }
    }
    const branches: BranchRecord[] = raw.trimEnd().split('\n').filter(Boolean).flatMap(line => {
      const [ref, head, symref, upstream, committedAt] = line.split('\0')
      if (symref) return []
      const namespace = ref.startsWith('refs/heads/') ? 'LOCAL' as const : 'TRACKING' as const
      const dates = chronology(common, ref)
      const worktrees = namespace === 'LOCAL' ? (occupants.get(ref.slice(11)) ?? []).filter(w => w.head === head).map(w => ({ worktreeId: w.worktreeId, generation: w.generation })) : []
      const record = { key: digest([this.identity.repositoryId, common, ref]), repositoryId: this.identity.repositoryId, ref, name: ref.replace(/^refs\/(heads|remotes)\//, ''), namespace, head,
        upstream: upstream || null, generation: dates.generation, creation: dates.creation, lastCommitAt: committedAt || null, worktrees }
      return [{ ...record, revision: digest(record) }]
    })
    const finalRefs = await this.git.getBranchInventoryReferences(this.root)
    const finalTrees = await this.git.listWorktreeRecords(this.root)
    current()
    if (raw !== finalRefs || finalTrees !== initialTrees) throw new Error('GIT_STATE_CHANGED')
    if (branches.some(branch => {
      const final = chronology(common, branch.ref)
      return final.generation !== branch.generation || digest(final.creation) !== digest(branch.creation)
    })) throw new Error('GIT_STATE_CHANGED')
    const assigned = new Set(branches.flatMap(b => b.worktrees.map(w => w.worktreeId)))
    return { repositoryId: this.identity.repositoryId, source: 'GIT_LOCAL', coverage: 'COMPLETE', observedAt: new Date().toISOString(), revision: digest([branches, discovered.worktrees]),
      branches, worktrees: discovered.worktrees, unassignedWorktrees: discovered.worktrees.filter(w => !assigned.has(w.worktreeId)) }
  }

  async history(query: BranchHistoryQuery): Promise<BranchHistoryPage> {
    if (!query || !['REACHABLE', 'EXCLUSIVE'].includes(query.mode) || query.mode === 'EXCLUSIVE' && !query.baseRef) throw new Error('INVALID_ARGUMENT')
    const before = await this.inventory(), branch = before.branches.find(b => b.ref === query.ref)
    if (!branch || branch.revision !== query.revision) throw new Error('GIT_STATE_CHANGED')
    const base = query.baseRef ? before.branches.find(b => b.ref === query.baseRef) : null
    if (query.baseRef && !base) throw new Error('BRANCH_NOT_FOUND')
    const fingerprint = digest([branch.revision, base?.revision, query.mode, await this.git.getCommitTopologyRevision(this.root)])
    let offset = 0
    if (query.cursor) {
      const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString())
      if (cursor.fingerprint !== fingerprint || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error('CURSOR_STALE')
      offset = cursor.offset
    }
    const raw = await this.git.getBranchHistory(this.root, [branch.head, ...(query.mode === 'EXCLUSIVE' ? ['^' + base!.head] : [])], offset, 51, 'COMMITTER')
    const commits = raw.trimEnd().split('\n').filter(Boolean).map(line => {
      const [sha, parents, author, committedAt, title] = line.split('\0')
      return { sha, parents: parents.split(' ').filter(Boolean), author, committedAt, title }
    })
    if ((await this.inventory()).revision !== before.revision) throw new Error('GIT_STATE_CHANGED')
    return { repositoryId: before.repositoryId, ref: branch.ref, head: branch.head, revision: branch.revision, mode: query.mode,
      base: base ? { ref: base.ref, head: base.head } : null, observedAt: new Date().toISOString(), commits: commits.slice(0, 50),
      nextCursor: commits.length > 50 ? Buffer.from(JSON.stringify({ fingerprint, offset: offset + 50 })).toString('base64url') : null }
  }
}
