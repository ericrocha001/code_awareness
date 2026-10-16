import { createHash, randomUUID } from 'node:crypto'
import type { GitService } from '../core/git-service'
import type { GitBranchInventory } from './git-branch-inventory'
import type { BranchDiscardExecute, BranchDiscardPreview, BranchDiscardRemoteReader } from '../../shared/types/branch-discard-types'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class GitBranchDiscard {
  private readonly previews = new Map<string, BranchDiscardPreview>()
  constructor(private readonly root: string, private readonly git: GitService, private readonly reader: GitBranchInventory,
    private readonly observeCheckout: (worktreeId: string) => Promise<{ stagedCount: number; unstagedCount: number; untrackedCount: number }> ) {}

  async prepare(ref: string, revision: string, baseRef: string, remoteReader: BranchDiscardRemoteReader): Promise<BranchDiscardPreview> {
    const inventory = await this.reader.inventory(), branch = inventory.branches.find(b => b.ref === ref && b.namespace === 'LOCAL')
    if (!branch || branch.revision !== revision || branch.generation === 'UNKNOWN') throw new Error('GIT_STATE_CHANGED')
    const base = inventory.branches.find(b => b.ref === baseRef && b.namespace === 'LOCAL')
    if (!base || base.ref === branch.ref) throw new Error('INVALID_BASE_REF')
    const remote = await remoteReader(inventory, branch)
    if (remote.repositoryId !== inventory.repositoryId) throw new Error('REPOSITORY_CONTEXT_CHANGED')
    const blockers: string[] = []
    if (['main', 'master', remote.defaultBranch].includes(branch.name)) blockers.push('BRANCH_PROTECTED')
    if (remote.coverage !== 'COMPLETE' || remote.protected === null) blockers.push('REMOTE_EVIDENCE_INCONCLUSIVE')
    if (remote.protected) blockers.push('BRANCH_PROTECTED')
    if (remote.openPullRequests.length) blockers.push('BRANCH_HAS_OPEN_PR')
    const worktrees = inventory.worktrees.filter(w => w.branch === branch.name)
    if (worktrees.length) blockers.push('WORKTREE_BRANCH_OCCUPIED')
    const checkouts: BranchDiscardPreview['checkouts'] = []
    for (const tree of worktrees) {
      try {
        const state = await this.observeCheckout(tree.worktreeId), ignoredCount = await this.git.countIgnoredWorktreeFiles(tree.path)
        checkouts.push({ worktreeId: tree.worktreeId, path: tree.path, coverage: 'OBSERVED', stagedCount: state.stagedCount, unstagedCount: state.unstagedCount, untrackedCount: state.untrackedCount, ignoredCount })
      } catch { checkouts.push({ worktreeId: tree.worktreeId, path: tree.path, coverage: 'UNAVAILABLE', stagedCount: null, unstagedCount: null, untrackedCount: null, ignoredCount: null }) }
    }
    const current = await this.git.getCurrentBranch(this.root)
    if (current === branch.name) blockers.push('CURRENT_BRANCH')
    if (await this.git.getGitOperation(this.root)) blockers.push('GIT_OPERATION_IN_PROGRESS')
    const summary = await this.git.getExclusiveCommitSummary(this.root, branch.head, base.head)
    if ((await this.reader.inventory()).revision !== inventory.revision) throw new Error('GIT_STATE_CHANGED')
    const preview: BranchDiscardPreview = { previewId: randomUUID(), repositoryId: inventory.repositoryId, branch, inventoryRevision: inventory.revision,
      base: { ref: base.ref, head: base.head }, integrated: summary.count === 0, exclusiveCount: summary.count, exclusiveSample: summary.sample,
      worktrees, checkouts, remote, blockers: [...new Set(blockers)], recoveryRequired: summary.count > 0, expiresAt: new Date(Date.now() + 300000).toISOString() }
    for (const [id, value] of this.previews) if (Date.parse(value.expiresAt) <= Date.now()) this.previews.delete(id)
    if (this.previews.size >= 100) this.previews.delete(this.previews.keys().next().value!)
    this.previews.set(preview.previewId, preview)
    return preview
  }

  async execute(request: BranchDiscardExecute, remoteReader: BranchDiscardRemoteReader, guard: () => void) {
    const before = this.previews.get(request.previewId)
    if (!before || Date.parse(before.expiresAt) <= Date.now()) throw new Error('BRANCH_PREVIEW_EXPIRED')
    if (request.confirmed !== true || before.recoveryRequired && request.preserveExclusive !== true) throw new Error('BRANCH_PRESERVATION_CONSENT_REQUIRED')
    guard()
    const current = await this.prepare(before.branch.ref, before.branch.revision, before.base.ref, remoteReader)
    this.previews.delete(current.previewId)
    if (before.inventoryRevision !== current.inventoryRevision || digest(before.base) !== digest(current.base) || before.remote.revision !== current.remote.revision) throw new Error('BRANCH_PREVIEW_STALE')
    if (current.blockers.length) throw new Error(current.blockers[0])
    guard()
    const recoveryRef = `refs/code-awareness/recovery/${randomUUID()}`
    await this.git.preserveAndDiscardBranch(this.root, before.branch.ref, before.branch.head, before.base, recoveryRef)
    this.previews.delete(before.previewId)
    return { result: 'BRANCH_DISCARDED', repositoryId: before.repositoryId, ref: before.branch.ref, head: before.branch.head,
      recoveryRef, recoveryHead: await this.git.resolveCommit(this.root, recoveryRef), exclusiveCount: before.exclusiveCount }
  }
}
