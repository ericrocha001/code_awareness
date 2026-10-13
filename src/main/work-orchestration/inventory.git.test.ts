import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { transformSync } from 'esbuild'
import { GitService } from '../core/git-service'
import { createTempGitRepo, cleanupTempRepo, gitExec, stageAll, commit } from '../core/git-test-helpers'
import { GitOperationsService } from '../git-operations/git-operations-service'
import { GitHubGitTransport } from '../github/github-git-transport'
import { WorkOrchestrationService } from './work-orchestration-service'
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await cleanupTempRepo(root) })
it('discovers 1, 21 and 101 real worktrees without snapshots or pair analysis, measures the baseline and preserves Git', async () => {
  const root = await createTempGitRepo(); roots.push(root)
  const parent = mkdtempSync(join(tmpdir(), 'inventory-')); roots.push(parent)
  writeFileSync(join(root, 'file.txt'), 'base\n'); await stageAll(root); await commit(root, 'base')
  await gitExec(root, ['branch', '-m', 'reference-is-not-named-main'])
  const git = new GitService()
  const reader = new GitOperationsService(root, git, new GitHubGitTransport(null, git), { repositoryId: 'inventory', isActive: () => true })
  const service = new WorkOrchestrationService(reader)
  const snapshots = vi.spyOn(reader, 'getCoordinationSnapshot'), pairs = vi.spyOn(reader, 'getCoordinationCommitPaths')
  expect((await service.inventory()).worktrees).toHaveLength(1)
  for (let i = 0; i < 20; i++) await gitExec(root, ['worktree', 'add', '--detach', join(parent, `tree-${i}`)])
  const before = { head: await git.getCurrentCommitHash(root), refs: await gitExec(root, ['show-ref']), index: readFileSync(join(root, '.git/index')).toString('hex'), content: readFileSync(join(root, 'file.txt'), 'utf8') }
  const started = performance.now()
  const inventory = await service.inventory()
  const inventoryMs = performance.now() - started
  expect(inventory).toMatchObject({ inventoryCoverage: 'COMPLETE', relationsCoverage: 'NOT_EVALUATED', pairs: [] })
  expect(inventory.worktrees).toHaveLength(21)
  expect(inventory.worktrees.filter(w => w.reference)).toHaveLength(1)
  expect(inventory.worktrees.every(w => w.observation === 'NOT_OBSERVED' && w.snapshot === null && w.stagedCount === null)).toBe(true)
  expect(snapshots).not.toHaveBeenCalled(); expect(pairs).not.toHaveBeenCalled()
  const oldSource = execFileSync('git', ['show', 'dcdd7a12e923eaa941795075bb2220b7685745ed:src/main/work-orchestration/work-orchestration-service.ts'], { cwd: process.cwd(), encoding: 'utf8' })
  const module = { exports: {} as any }
  new Function('require', 'module', transformSync(oldSource, { loader: 'ts', format: 'cjs' }).code)(createRequire(join(process.cwd(), 'package.json')), module)
  const baselineStart = performance.now()
  const baseline = await new module.exports.WorkOrchestrationService(reader).overview()
  const baselineMs = performance.now() - baselineStart
  expect(baseline.worktrees).toHaveLength(21)
  expect(snapshots).toHaveBeenCalledTimes(42)
  console.log(JSON.stringify({ measurement: 'same 21-worktree fixture, time to inventory availability', baselineMs, inventoryMs, baselineSnapshots: 42, inventorySnapshots: 0, pairReads: pairs.mock.calls.length }))
  snapshots.mockClear(); pairs.mockClear()
  for (let i = 20; i < 100; i++) await gitExec(root, ['worktree', 'add', '--detach', join(parent, `tree-${i}`)])
  const pages = vi.spyOn(reader, 'discoverCoordinationWorktrees')
  expect((await service.inventory()).worktrees).toHaveLength(101)
  expect(pages).toHaveBeenCalledTimes(2)
  expect(snapshots).not.toHaveBeenCalled(); expect(pairs).not.toHaveBeenCalled()
  const inspected = await service.observe(inventory.worktrees[1].worktreeId)
  expect(inspected.worktree).toMatchObject({ observation: 'VERIFIED', stagedCount: 0 })
  expect(snapshots).toHaveBeenCalledTimes(1)
  expect({ head: await git.getCurrentCommitHash(root), refs: await gitExec(root, ['show-ref']), index: readFileSync(join(root, '.git/index')).toString('hex'), content: readFileSync(join(root, 'file.txt'), 'utf8') }).toEqual(before)
}, 240000)

it('fails explicit inventory discovery on cursor drift instead of returning partial success', async () => {
  const reader = { discoverCoordinationWorktrees: vi.fn().mockResolvedValueOnce({ repositoryId: 'a', revision: 'r', worktrees: [], nextCursor: 'r:100' }).mockRejectedValueOnce(new Error('GIT_STATE_CHANGED')), getCoordinationSnapshot: vi.fn(), getCoordinationCommitPaths: vi.fn() }
  await expect(new WorkOrchestrationService(reader).inventory()).rejects.toThrow('GIT_STATE_CHANGED')
  expect(reader.getCoordinationSnapshot).not.toHaveBeenCalled()
})
