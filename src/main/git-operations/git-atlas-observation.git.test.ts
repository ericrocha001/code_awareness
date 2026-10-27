import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { unlinkSync, writeFileSync } from 'node:fs'
import { GitService } from '../core/git-service'
import { GitAtlasReader } from './git-atlas'
import { GitOperationsService } from './git-operations-service'
import { cleanupTempRepo, createTempGitRepo, gitExec } from '../core/git-test-helpers'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await cleanupTempRepo(root) })
async function fixture() {
  const root = await createTempGitRepo(); roots.push(root)
  await gitExec(root, ['commit', '--allow-empty', '-m', 'initial'])
  const git = new GitService()
  const reader = new GitAtlasReader(root, git, code => { throw new Error(code) })
  const read = () => git.getAtlasObservation(root, true, true)
  return { root, git, reader, read }
}

it('uses one read-only command and tracks create/rename/delete, packed refs and explicit fetch', async () => {
  const { root, git, read } = await fixture()
  const commands = vi.spyOn(git as any, 'runGit')
  const before = await read()
  expect(commands.mock.calls).toHaveLength(1)
  expect(commands.mock.calls.map(call => (call[0] as string[])[0])).toEqual(['for-each-ref'])
  await gitExec(root, ['branch', 'same-a']); const first = await read()
  await gitExec(root, ['branch', 'same-b']); const second = await read()
  expect(first.referenceFingerprint).not.toBe(before.referenceFingerprint)
  expect(second.referenceFingerprint).not.toBe(first.referenceFingerprint)
  await gitExec(root, ['pack-refs', '--all']); expect((await read()).referenceFingerprint).toBe(second.referenceFingerprint)
  await gitExec(root, ['branch', '-m', 'same-a', 'renamed']); const renamed = await read()
  expect(renamed.referenceFingerprint).not.toBe(second.referenceFingerprint)
  await gitExec(root, ['branch', '-D', 'renamed']); expect((await read()).referenceFingerprint).not.toBe(renamed.referenceFingerprint)
  const origin = await createTempGitRepo(); roots.push(origin)
  await gitExec(origin, ['commit', '--allow-empty', '-m', 'remote'])
  await gitExec(root, ['fetch', origin, 'HEAD:refs/remotes/proof/topic'])
  const fetched = await read()
  await gitExec(root, ['update-ref', '-d', 'refs/remotes/proof/topic'])
  expect((await read()).referenceFingerprint).not.toBe(fetched.referenceFingerprint)
}, 60000)

it('binds fingerprints to delivered pages and reuses known metadata after refs change', async () => {
  const { root, git, reader, read } = await fixture()
  const metadata = vi.spyOn(git, 'getAtlasCommitMetadata')
  const request = { window: 'ALL' as const, scope: { kind: 'ALL_REFS' as const, anchor: 'AUTO' as const } }
  const first = await reader.history(request)
  expect(first.observation?.referenceFingerprint).toBe((await read()).referenceFingerprint)
  expect(first.observation?.sourceFingerprint).toBe(await git.getAtlasSourceFingerprint(root))
  metadata.mockClear()
  await gitExec(root, ['branch', 'new-decoration'])
  const next = await reader.history(request)
  expect(next.snapshot).not.toBe(first.snapshot)
  expect(next.refs.some(ref => ref.name === 'new-decoration')).toBe(true)
  expect(metadata.mock.calls.every(call => call[1].length === 0)).toBe(true)
  await gitExec(root, ['commit', '--allow-empty', '-m', 'new commit'])
  metadata.mockClear()
  const added = await reader.history(request)
  expect(added.nodes).toHaveLength(2)
  const requested = [...new Set(metadata.mock.calls.flatMap(call => call[1]))]
  expect(requested).toEqual([added.head])
}, 60000)

it('covers detached HEAD changes in other worktrees through the full observation', async () => {
  const { root, git, reader, read } = await fixture()
  const other = join(root, 'other')
  await gitExec(root, ['worktree', 'add', '--detach', other, 'HEAD'])
  const light = await read(), full = await git.getAtlasSourceFingerprint(root)
  await gitExec(other, ['commit', '--allow-empty', '-m', 'other checkout'])
  expect((await read()).referenceFingerprint).toBe(light.referenceFingerprint)
  expect(await git.getAtlasSourceFingerprint(root)).not.toBe(full)
  const page = await reader.history({ window: 'ALL', scope: { kind: 'ALL_REFS', anchor: 'AUTO' } })
  expect(page.detachedHeads.map(head => head.sha)).toContain((await gitExec(other, ['rev-parse', 'HEAD'])).trim())
}, 60000)

it('does not turn a transient Git failure or concurrent operation into an empty graph', async () => {
  const { root, git } = await fixture()
  const service = new GitOperationsService(root, git, {} as any)
  const run = vi.spyOn(git as any, 'runGit').mockRejectedValueOnce(new Error('transient'))
  await expect(service.getAtlasCheckoutState(true)).rejects.toThrow('transient')
  run.mockRestore()
  const admin = (await gitExec(root, ['rev-parse', '--absolute-git-dir'])).trim()
  writeFileSync(join(admin, 'index.lock'), '')
  expect(await service.getAtlasCheckoutState(true)).toMatchObject({ operation: 'LOCKED' })
  unlinkSync(join(admin, 'index.lock'))
  expect(await service.getAtlasCheckoutState(true)).toMatchObject({ operation: null, referenceFingerprint: expect.any(String) })
}, 60000)

it('preserves unborn checkout observations and detects the first external commit', async () => {
  const root = await createTempGitRepo(); roots.push(root)
  const service = new GitOperationsService(root, new GitService(), {} as any)
  const empty = await service.getAtlasCheckoutState(true)
  expect(empty).toMatchObject({ head: null, branch: expect.any(String), operation: null, referenceFingerprint: expect.any(String) })
  await gitExec(root, ['commit', '--allow-empty', '-m', 'first external commit'])
  const first = await service.getAtlasCheckoutState(true)
  expect(first.head).toMatch(/^[a-f0-9]{40,64}$/)
  expect(first.referenceFingerprint).not.toBe(empty.referenceFingerprint)
}, 60000)

it('observes detached HEAD with the same fingerprint and falls back on Git without root-ref support', async () => {
  const { root, git } = await fixture()
  await gitExec(root, ['switch', '--detach', 'HEAD'])
  const light = await git.getAtlasObservation(root, true, true)
  expect(light.branch).toBeNull()
  expect(light.referenceFingerprint).toBe((await git.getAtlasObservation(root, false, true)).referenceFingerprint)
  const run = (git as any).runGit.bind(git)
  const commands = vi.spyOn(git as any, 'runGit').mockImplementation(async (args, ...rest) => {
    if ((args as string[]).includes('--include-root-refs')) throw new Error("error: unknown option 'include-root-refs'")
    return run(args, ...rest)
  })
  expect((await git.getAtlasObservation(root, true, true)).referenceFingerprint).toBe(light.referenceFingerprint)
  commands.mockClear()
  expect((await git.getAtlasObservation(root, true, true)).referenceFingerprint).toBe(light.referenceFingerprint)
  expect(commands).toHaveBeenCalledTimes(2)
}, 60000)
