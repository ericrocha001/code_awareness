import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTempGitRepo, cleanupTempRepo, gitExec, stageAll, commit } from '../core/git-test-helpers'
import { GitService } from '../core/git-service'
import { GitOperationsService } from '../git-operations/git-operations-service'
import { GitHubGitTransport } from '../github/github-git-transport'
import { WorktreeContractNavigation } from '../core/context/worktree-contract-navigation'
import { SelectiveContractDiscovery } from './structural-discovery'
import { selectWorklineBatch } from './workline-priority'
import type { CoordinationReference } from '../git-operations/git-coordination-evidence'
import type { ObservableWorktree } from '../../shared/types/work-orchestration-types'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await cleanupTempRepo(root) })
async function fixture() {
  const root = await createTempGitRepo(), parent = mkdtempSync(join(tmpdir(), 'workline-history-')); roots.push(root, parent)
  await gitExec(root, ['branch', '-m', 'technical-reference'])
  writeFileSync(join(root, 'service.ts'), 'export function service(value: number): number { return value }\n')
  writeFileSync(join(root, 'consumer.ts'), 'import { service } from "./service"\nexport function consume() { return service(1) }\n')
  await stageAll(root); await commit(root, 'base')
  const paths = ['ancestral', 'exclusive', 'local', 'consumer'].map(name => join(parent, name))
  for (let n = 0; n < paths.length; n++) await gitExec(root, ['worktree', 'add', '-b', `w-${n}`, paths[n]])
  writeFileSync(join(paths[1], 'service.ts'), 'export function service(value: string): string { return value }\n')
  await stageAll(paths[1]); await commit(paths[1], 'exclusive public contract')
  writeFileSync(join(paths[3], 'consumer.ts'), 'import { service } from "./service"\nexport function consume() { return service(2) }\n')
  await gitExec(root, ['commit', '--allow-empty', '-m', 'reference history'])
  const git = new GitService(); let active = true
  const reader = new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'history', isActive: () => active })
  const records = (await reader.discoverCoordinationWorktrees()).worktrees, referenceRecord = records.find(r => r.path === root)!
  const reference: CoordinationReference = { repositoryId: 'history', worktreeId: referenceRecord.worktreeId, generation: referenceRecord.generation, head: referenceRecord.head! }
  const engine = new SelectiveContractDiscovery(reader, new WorktreeContractNavigation(reader))
  const [a, b, c, d] = paths.map(path => records.find(r => r.path === path)!)
  return { root, git, reader, engine, reference, a, b, c, d, paths, deactivate: () => { active = false } }
}
it('reuses canonical history without new commands and changes a real qualified selection', async () => {
  const f = await fixture(), comparisons = vi.spyOn(f.reader, 'getCoordinationCommitPaths')
  for (const r of [f.a, f.b, f.c, f.d]) await f.engine.observe(r.worktreeId, f.reference.head, f.reference)
  expect(f.engine.observedStates.get(f.a.worktreeId)).toMatchObject({ stable: false, changed: false, clean: true, history: { relation: 'HEAD_INCLUDED', reference: f.reference } })
  const acquired = comparisons.mock.calls.length
  for (const r of [f.a, f.b, f.c, f.d]) await f.engine.observe(r.worktreeId, f.reference.head, f.reference)
  expect(comparisons).toHaveBeenCalledTimes(acquired)
  const projected = (r: typeof f.a): ObservableWorktree => ({ ...r, reference: false, snapshot: null, observation: 'NOT_OBSERVED', reason: null, stagedCount: null, unstagedCount: null, untrackedCount: null, conflictCount: null })
  const selected = selectWorklineBatch([projected(f.a), projected(f.b)], { reference: f.reference, facts: f.engine.observedStates,
    attempted: new Map([[f.a.worktreeId, 1001], [f.b.worktreeId, 1002]]), attemptedRound: new Map([[f.a.worktreeId, 1], [f.b.worktreeId, 1]]),
    observed: new Map([[f.a.worktreeId, 1001], [f.b.worktreeId, 1002]]), structural: new Set(), pending: f.engine.pending, round: 2, now: 2000, inventoryAt: 1000, cadenceMs: 30000, budget: 2 })
  expect(selected.map(c => c.record.worktreeId)).toEqual([f.b.worktreeId, f.a.worktreeId])
  expect(selected[0].reason).toBe('HISTORICAL_DIVERGENCE_TIE')
  const findings = await f.engine.investigate(1)
  expect(findings).toHaveLength(1); expect(findings[0].consumer).toBe(f.d.worktreeId)
}, 90000)
it('distinguishes first observation, actual local changes and reference-only changes', async () => {
  const f = await fixture()
  await f.engine.observe(f.c.worktreeId, f.reference.head, f.reference)
  expect(f.engine.observedStates.get(f.c.worktreeId)!.changed).toBe(false)
  const before = f.engine.observedStates.get(f.c.worktreeId)!
  writeFileSync(join(f.paths[2], 'external.txt'), 'uncommitted change\n')
  expect(f.engine.observedStates.get(f.c.worktreeId)!.localRevision).toBe(before.localRevision)
  await f.engine.observe(f.c.worktreeId, f.reference.head, f.reference)
  expect(f.engine.observedStates.get(f.c.worktreeId)).toMatchObject({ changed: true, clean: false })
  const local = f.engine.observedStates.get(f.c.worktreeId)!.localRevision
  await gitExec(f.root, ['commit', '--allow-empty', '-m', 'only reference advances'])
  const reference = { ...f.reference, head: (await f.git.getCurrentCommitHash(f.root))! }
  expect(await f.engine.observe(f.c.worktreeId, reference.head, reference)).toBe(true)
  expect(f.engine.observedStates.get(f.c.worktreeId)).toMatchObject({ changed: false, localRevision: local, history: { reference } })
  await gitExec(f.paths[2], ['checkout', '--detach']); await f.engine.observe(f.c.worktreeId, reference.head, reference)
  expect(f.engine.observedStates.get(f.c.worktreeId)!.changed).toBe(true)
}, 60000)
it('drops late history after invalidation and rejects no-base and changed project', async () => {
  const f = await fixture(), original = f.reader.getCoordinationCommitPaths.bind(f.reader)
  let release!: () => void
  vi.spyOn(f.reader, 'getCoordinationCommitPaths').mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve }); return original(...args) })
  const pending = f.engine.observe(f.a.worktreeId, f.reference.head, f.reference)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 10000 })
  f.engine.invalidate(); release(); await expect(pending).rejects.toThrow('ORCHESTRATION_PAUSED')
  expect(f.engine.observedStates.size).toBe(0)
  await expect(f.reader.getCoordinationCommitPaths('0'.repeat(40), f.a.head!)).rejects.toMatchObject({ code: 'MERGE_BASE_UNAVAILABLE' })
  f.deactivate(); await expect(f.reader.getCoordinationCommitPaths(f.reference.head, f.a.head!)).rejects.toMatchObject({ code: 'WORKTREE_REPOSITORY_CHANGED' })
}, 60000)
