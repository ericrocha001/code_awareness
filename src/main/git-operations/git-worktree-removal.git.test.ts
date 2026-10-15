import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { GitService } from '../core/git-service'
import { createTempGitRepo, cleanupTempRepo, gitExec, stageAll, commit } from '../core/git-test-helpers'
import { GitOperationsService } from './git-operations-service'
import { GitHubGitTransport } from '../github/github-git-transport'
import type { RemovalConsent, RemovalPreview } from '../../shared/types/worktree-removal-types'
import { GitWorktreeLifecycle } from './git-worktree-lifecycle'
import { realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) cleanupTempRepo(root) })
async function fixture(managed = false) {
  const root = await createTempGitRepo(); roots.push(root)
  writeFileSync(join(root, 'file.txt'), 'original\n'); writeFileSync(join(root, '.gitignore'), '*.cache\n')
  await stageAll(root); await commit(root, 'initial')
  const directory = mkdtempSync(join(tmpdir(), 'removal-fixture-')); roots.push(directory)
  const path = managed ? new GitWorktreeLifecycle(realpathSync(join(root, '.git'))).destination() : join(directory, 'external')
  await gitExec(root, ['worktree', 'add', '-b', 'external-owner', path])
  const git = new GitService()
  let active = true
  const service = new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'test', isActive: () => active })
  const approve = vi.fn(async () => true)
  service.configureRemoval({ sourceRoot: root, isActive: () => active, approve, delivery: async () => ({ status: 'UNAVAILABLE', source: 'GITHUB_REST', reason: 'test', observedAt: new Date().toISOString() }) })
  const record = (await service.worktrees!.discover()).worktrees.find(record => record.path === path)!
  const prepare = () => service.prepareRemoval(record.worktreeId, record.generation, { mode: 'ABANDONED', delivery: null, noPullRequestConfirmed: true, abandonmentReason: 'Explicitly abandoned; useful context preserved' })
  return { root, path, service, git, record, prepare, approve, deactivate: () => { active = false } }
}
const consent = (p: RemovalPreview): RemovalConsent => ({ fingerprint: p.fingerprint, exactPath: p.path, ownerReleased: true, operatorIsOwner: true, noKnownWriter: true, discardPaths: p.content.map(file => file.path) })

it('removes an explicitly released external worktree once, preserving branch and other checkout', async () => {
  const f = await fixture(), preview = await f.prepare()
  expect(preview.state).toBe('PREPARING')
  const remove = vi.spyOn(f.git, 'removeReviewedWorktree')
  const result = await f.service.executeRemoval(preview.preparationId, 'remove-once', consent(preview))
  expect(result.state).toBe('CLOSED'); expect(existsSync(f.path)).toBe(false)
  expect(await f.git.resolveCommit(f.root, preview.preservedRef!)).toBe(preview.head)
  expect(readFileSync(join(f.root, 'file.txt'), 'utf8')).toBe('original\n')
  expect((await f.service.executeRemoval(preview.preparationId, 'remove-once', consent(preview))).state).toBe('CLOSED')
  expect(remove).toHaveBeenCalledTimes(1)
}, 60000)

it('blocks hidden index flags and a writer grant from another executor, protecting local data', async () => {
  const f = await fixture()
  await gitExec(f.path, ['update-index', '--assume-unchanged', 'file.txt'])
  writeFileSync(join(f.path, 'file.txt'), 'hidden valuable data')
  expect((await f.prepare()).blockers).toContain('REMOVAL_INDEX_FLAGS_UNSUPPORTED')
  await gitExec(f.path, ['update-index', '--no-assume-unchanged', 'file.txt'])
  const directory = join(realpathSync(await f.git.getCommonDirectory(f.root)), 'code-awareness-worktree-ownership')
  mkdirSync(directory)
  writeFileSync(join(directory, `${f.record.worktreeId}.json`), JSON.stringify({ state: 'GRANTED', observation: { path: realpathSync(f.path) } }))
  expect((await f.prepare()).blockers).toContain('WORKTREE_OWNERSHIP_CONFLICT')
  expect(readFileSync(join(f.path, 'file.txt'), 'utf8')).toBe('hidden valuable data')
}, 60000)

it('rejects closed without merge, ambiguous delivery, wrong target, stale and unavailable evidence', async () => {
  const f = await fixture()
  const delivery = { repositoryId: 'provider', repository: 'owner/repo', prId: '42', prNumber: 7, sourceRepositoryId: 'provider', sourceBranch: f.record.branch!, head: f.record.head!, targetBranch: 'main' }
  let evidence: any = { status: 'OBSERVED', source: 'GITHUB_REST', delivery, state: 'closed', merged: false, mergedAt: null, mergeCommit: null, observedAt: new Date().toISOString() }
  f.service.configureRemoval({ sourceRoot: f.root, isActive: () => true, approve: f.approve, delivery: async () => evidence })
  const prepare = () => f.service.prepareRemoval(f.record.worktreeId, f.record.generation, { mode: 'INTEGRATED', delivery, noPullRequestConfirmed: false, abandonmentReason: '' })
  expect((await prepare()).blockers).toContain('REMOVAL_MERGE_NOT_VERIFIED')
  evidence = { ...evidence, merged: true, mergedAt: new Date().toISOString(), mergeCommit: 'a'.repeat(40), delivery: { ...delivery, targetBranch: 'other' } }
  expect((await prepare()).blockers).toContain('REMOVAL_DELIVERY_MISMATCH')
  evidence = { ...evidence, delivery: { ...delivery, prId: 'another-pr' } }
  expect((await prepare()).blockers).toContain('REMOVAL_DELIVERY_MISMATCH')
  evidence = { ...evidence, delivery, observedAt: '2000-01-01T00:00:00Z' }
  expect((await prepare()).blockers).toContain('REMOVAL_PROVIDER_STALE')
  evidence = { status: 'UNAVAILABLE', reason: 'offline', observedAt: new Date().toISOString() }
  expect((await prepare()).blockers).toContain('REMOVAL_PROVIDER_UNAVAILABLE')
  expect(existsSync(f.path)).toBe(true); expect(f.approve).not.toHaveBeenCalled()
}, 120000)

it('requires exact content classification for dirty and ignored files and invalidates consent on drift', async () => {
  const f = await fixture()
  writeFileSync(join(f.path, 'scratch.cache'), 'retain evidence')
  writeFileSync(join(f.path, 'new.txt'), 'important')
  writeFileSync(join(f.path, 'file.txt'), 'changed')
  const preview = await f.prepare()
  expect(preview.content).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'scratch.cache', kind: 'IGNORED' }), expect.objectContaining({ path: 'new.txt', kind: 'UNTRACKED' })]))
  await expect(f.service.executeRemoval(preview.preparationId, 'reject-classification', { ...consent(preview), discardPaths: [] })).rejects.toThrow('REMOVAL_CONTENT_CLASSIFICATION_REQUIRED')
  writeFileSync(join(f.path, 'scratch.cache'), 'changed evidence')
  await expect(f.service.executeRemoval(preview.preparationId, 'reject-drift', consent(preview))).rejects.toThrow('REMOVAL_PREVIEW_STALE')
  expect(readFileSync(join(f.path, 'new.txt'), 'utf8')).toBe('important')
}, 60000)

it('allows a reviewed dirty discard through one Git force and retains commits', async () => {
  const f = await fixture()
  writeFileSync(join(f.path, 'new.txt'), 'explicitly discarded'); writeFileSync(join(f.path, 'scratch.cache'), 'regenerable')
  const preview = await f.prepare(), remove = vi.spyOn(f.git, 'removeReviewedWorktree')
  expect((await f.service.executeRemoval(preview.preparationId, 'dirty-discard', consent(preview))).state).toBe('CLOSED')
  expect(remove).toHaveBeenCalledWith(f.root, f.path, true)
}, 60000)

it('blocks active ownership, main checkout, lock, cancel, missing consent and project changes', async () => {
  const f = await fixture(), preview = await f.prepare()
  await expect(f.service.executeRemoval(preview.preparationId, 'missing-owner', { ...consent(preview), ownerReleased: false })).rejects.toThrow('REMOVAL_OWNER_CONFIRMATION_REQUIRED')
  await f.service.cancelPreparation(preview.preparationId)
  await expect(f.service.executeRemoval(preview.preparationId, 'cancelled', consent(preview))).rejects.toThrow('REMOVAL_NOT_PREPARED')
  await gitExec(f.root, ['worktree', 'lock', f.path])
  expect((await f.prepare()).blockers).toContain('WORKTREE_LOCKED')
  f.deactivate()
  await expect(f.service.executeRemoval(preview.preparationId, 'changed-project', consent(preview))).rejects.toThrow('PROJECT_CONTEXT_CHANGED')
  expect(existsSync(f.path)).toBe(true)
}, 60000)

it('never retries a delete with unknown outcome and reconciles physical and Git absence', async () => {
  const f = await fixture(), preview = await f.prepare()
  const remove = vi.spyOn(f.git, 'removeReviewedWorktree').mockRejectedValue(new Error('timeout'))
  expect((await f.service.executeRemoval(preview.preparationId, 'unknown', consent(preview))).state).toBe('UNKNOWN')
  expect((await f.service.executeRemoval(preview.preparationId, 'unknown', consent(preview))).state).toBe('UNKNOWN')
  expect((await f.service.reconcileRemovalReceipt(preview.preparationId, 'unknown')).state).toBe('UNKNOWN')
  expect(remove).toHaveBeenCalledTimes(1); expect(existsSync(f.path)).toBe(true)
  expect((await f.prepare()).blockers).toContain('REMOVAL_OUTCOME_UNKNOWN')
}, 60000)

it('requires opt-in and individual managed release, accepts squash metadata and revokes immediately', async () => {
  const f = await fixture(true), head = f.record.head!
  const delivery = { repositoryId: 'provider-1', repository: 'owner/repo', prNumber: 1, prId: '123', sourceRepositoryId: 'provider-1', sourceBranch: f.record.branch!, head, targetBranch: 'main' }
  let merged = false
  const read = vi.fn(async () => ({ status: 'OBSERVED' as const, source: 'GITHUB_REST' as const, delivery,
    state: merged ? 'closed' as const : 'open' as const, merged, mergedAt: merged ? new Date().toISOString() : null, mergeCommit: merged ? 'c'.repeat(40) : null, observedAt: new Date().toISOString() }))
  const mergeDate = new Date().toISOString()
  read.mockImplementation(async () => ({ status: 'OBSERVED', source: 'GITHUB_REST', delivery, state: merged ? 'closed' : 'open', merged, mergedAt: merged ? mergeDate : null, mergeCommit: merged ? 'c'.repeat(40) : null, observedAt: new Date().toISOString() }))
  f.service.configureRemoval({ sourceRoot: f.root, isActive: () => true, approve: f.approve, approvePolicy: async () => true, approveAutomatic: async () => true, delivery: read })
  expect(await f.service.removalPolicy()).toMatchObject({ enabled: false, enrolled: 0 })
  expect(await f.service.reconcileAutomaticRemoval()).toEqual([]); expect(read).not.toHaveBeenCalled()
  await f.service.removalPolicy(true)
  const common = realpathSync(await f.git.getCommonDirectory(f.root))
  new GitWorktreeLifecycle(common).save({ ...f.record, repositoryId: 'test', startPoint: head, createdAt: new Date().toISOString() })
  const preview = await f.service.prepareRemoval(f.record.worktreeId, f.record.generation, { mode: 'INTEGRATED', delivery, noPullRequestConfirmed: false, abandonmentReason: '' })
  expect(preview.blockers).toEqual(['REMOVAL_MERGE_NOT_VERIFIED'])
  await f.service.enrollAutomaticRemoval(preview.preparationId, { ...consent(preview), discardPaths: [] })
  expect(await f.service.reconcileAutomaticRemoval()).toEqual([]); expect(existsSync(f.path)).toBe(true)
  await f.service.cancelPreparation(preview.preparationId)
  expect(await f.service.removalPolicy()).toMatchObject({ enrolled: 0 })
  const reenroll = await f.service.prepareRemoval(f.record.worktreeId, f.record.generation, { mode: 'INTEGRATED', delivery, noPullRequestConfirmed: false, abandonmentReason: '' })
  await f.service.enrollAutomaticRemoval(reenroll.preparationId, { ...consent(reenroll), discardPaths: [] })
  await f.service.removalPolicy(false)
  merged = true
  expect(await f.service.reconcileAutomaticRemoval()).toEqual([]); expect(existsSync(f.path)).toBe(true)
  await f.service.removalPolicy(true)
  const fresh = await f.service.prepareRemoval(f.record.worktreeId, f.record.generation, { mode: 'INTEGRATED', delivery, noPullRequestConfirmed: false, abandonmentReason: '' })
  await f.service.enrollAutomaticRemoval(fresh.preparationId, { ...consent(fresh), discardPaths: [] })
  expect(await f.service.reconcileAutomaticRemoval()).toEqual([expect.objectContaining({ state: 'CLOSED' })])
  expect(existsSync(f.path)).toBe(false)
  expect(await f.git.resolveCommit(f.root, `refs/heads/${f.record.branch}`)).toBe(head)
  expect(f.approve).not.toHaveBeenCalled()
}, 120000)

it('serializes two actors and refuses HEAD drift', async () => {
  const f = await fixture(), first = await f.prepare(), second = await f.prepare(), remove = vi.spyOn(f.git, 'removeReviewedWorktree')
  const results = await Promise.allSettled([
    f.service.executeRemoval(first.preparationId, 'actor-one', consent(first)),
    f.service.executeRemoval(second.preparationId, 'actor-two', consent(second))
  ])
  expect(results.filter(result => result.status === 'fulfilled' && result.value.state === 'CLOSED')).toHaveLength(1)
  expect(remove).toHaveBeenCalledTimes(1)
  const g = await fixture(), preview = await g.prepare()
  writeFileSync(join(g.path, 'new.txt'), 'new commit'); await stageAll(g.path); await commit(g.path, 'after preview')
  await expect(g.service.executeRemoval(preview.preparationId, 'changed-head', consent(preview))).rejects.toThrow('REMOVAL_PREVIEW_STALE')
  expect(existsSync(g.path)).toBe(true)
}, 120000)

it('recovers after restart when Git removed the checkout but delivery of the receipt failed', async () => {
  const f = await fixture(), preview = await f.prepare(), original = f.git.removeReviewedWorktree.bind(f.git)
  vi.spyOn(f.git, 'removeReviewedWorktree').mockImplementation(async (...args) => { await original(...args); throw new Error('connection lost after effect') })
  expect((await f.service.executeRemoval(preview.preparationId, 'interrupted', consent(preview))).state).toBe('UNKNOWN')
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  expect(exited.status).toBe(0)
  writeFileSync(join(realpathSync(await f.git.getCommonDirectory(f.root)), 'code-awareness-worktrees.lock'), JSON.stringify({ pid: exited.pid }))
  const restart = new GitOperationsService(f.root, f.git, new GitHubGitTransport(null, f.git), { repositoryId: 'test', isActive: () => true })
  restart.configureRemoval({ sourceRoot: f.root, isActive: () => true, approve: async () => false, approveRecovery: async () => true, delivery: async () => { throw new Error('must not query provider for reconciliation') } })
  expect((await restart.reconcileRemovalReceipt(preview.preparationId, 'interrupted')).state).toBe('CLOSED')
  expect((await restart.executeRemoval(preview.preparationId, 'interrupted', consent(preview))).state).toBe('CLOSED')
  expect(f.git.removeReviewedWorktree).toHaveBeenCalledTimes(1)
}, 60000)

it('protects main, detached and submodule checkouts and refuses an external removal without native authorization', async () => {
  const f = await fixture(), preview = await f.prepare()
  f.approve.mockResolvedValueOnce(false)
  await expect(f.service.executeRemoval(preview.preparationId, 'denied-owner', consent(preview))).rejects.toThrow('REMOVAL_APPROVAL_DENIED')
  f.service.configureRemoval({ sourceRoot: process.platform === 'win32' ? f.path.toLowerCase() : f.path, isActive: () => true, approve: f.approve, delivery: async () => { throw new Error('not requested') } })
  expect((await f.prepare()).blockers).toContain('REMOVAL_PROTECTED_CHECKOUT')
  const main = (await f.service.worktrees!.discover()).worktrees.find(record => record.path === f.root)!
  const intent = { mode: 'ABANDONED' as const, delivery: null, noPullRequestConfirmed: true, abandonmentReason: 'Explicit abandonment' }
  expect((await f.service.prepareRemoval(main.worktreeId, main.generation, intent)).blockers).toContain('REMOVAL_PROTECTED_CHECKOUT')
  await gitExec(f.path, ['checkout', '--detach'])
  expect((await f.prepare()).blockers).toContain('REMOVAL_PROVENANCE_REQUIRED')
  await gitExec(f.path, ['switch', f.record.branch!])
  await gitExec(f.path, ['update-index', '--add', '--cacheinfo', `160000,${f.record.head},nested`])
  expect((await f.prepare()).blockers).toContain('REMOVAL_SUBMODULE_UNSUPPORTED')
  expect(existsSync(f.path)).toBe(true)
}, 120000)

it('invalidates consent if content changes while the operation receipt is being reserved', async () => {
  const f = await fixture(), preview = await f.prepare(), prepareReceipt = f.git.prepareOperationReceipt.bind(f.git)
  vi.spyOn(f.git, 'prepareOperationReceipt').mockImplementation(async (...args) => {
    const receipt = await prepareReceipt(...args)
    writeFileSync(join(f.path, 'file.txt'), 'new content after last preview')
    return receipt
  })
  const effect = vi.spyOn(f.git, 'removeReviewedWorktree')
  await expect(f.service.executeRemoval(preview.preparationId, 'late-content-drift', consent(preview))).rejects.toThrow('REMOVAL_PREVIEW_STALE')
  expect(effect).not.toHaveBeenCalled()
  expect(readFileSync(join(f.path, 'file.txt'), 'utf8')).toBe('new content after last preview')
}, 60000)

it('does not report CLOSED when persistence of the operation receipt fails', async () => {
  const f = await fixture(), preview = await f.prepare()
  const complete = vi.spyOn(f.git, 'completeOperationReceipt').mockRejectedValueOnce(new Error('disk unavailable'))
  expect((await f.service.executeRemoval(preview.preparationId, 'receipt-failure', consent(preview))).state).toBe('UNKNOWN')
  expect(existsSync(f.path)).toBe(false)
  complete.mockRestore()
  expect((await f.service.reconcileRemovalReceipt(preview.preparationId, 'receipt-failure')).state).toBe('CLOSED')
  expect((await f.git.readOperationReceipt(f.root, 'receipt-failure'))?.receipt.status).toBe('COMPLETED')
}, 60000)

it('expires a preparation while native authorization is open without removing content', async () => {
  const f = await fixture(), preview = await f.prepare()
  f.approve.mockImplementationOnce(async () => { vi.spyOn(Date, 'now').mockReturnValue(Date.parse(preview.expiresAt) + 1); return true })
  await expect(f.service.executeRemoval(preview.preparationId, 'expired-consent', consent(preview))).rejects.toThrow('REMOVAL_PREPARATION_EXPIRED')
  expect(existsSync(f.path)).toBe(true)
}, 60000)
