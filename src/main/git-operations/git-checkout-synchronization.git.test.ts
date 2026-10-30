import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { GitService } from '../core/git-service'
import { GitHubGitTransport } from '../github/github-git-transport'
import { GitOperationsService } from './git-operations-service'
import { createTempGitRepo, cleanupTempRepo, gitExec, writeFile, stageAll, commit } from '../core/git-test-helpers'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await cleanupTempRepo(root) })
async function repo() { const root = await createTempGitRepo(); roots.push(root); return root }
async function fixture() {
  const local = await repo(), remote = await repo(), writer = await repo()
  await gitExec(remote, ['config', 'core.bare', 'true'])
  await gitExec(local, ['branch', '-m', 'topic'])
  writeFile(local, 'root.txt', 'root'); await stageAll(local); await commit(local, 'root')
  await gitExec(local, ['remote', 'add', 'origin', remote]); await gitExec(local, ['push', '-u', 'origin', 'topic'])
  await gitExec(writer, ['remote', 'add', 'origin', remote]); await gitExec(writer, ['fetch', 'origin'])
  await gitExec(writer, ['checkout', '-b', 'topic', 'origin/topic'])
  const git = new GitService(), transport = new GitHubGitTransport(null, git)
  return { local, remote, writer, git, transport, service: new GitOperationsService(local, git, transport) }
}
async function advance(root: string, file: string) { writeFile(root, file, file); await stageAll(root); await commit(root, file) }

it('distinguishes live unknown, fetched behind, dirty blocking and receipted fast-forward without a second executor', async () => {
  const f = await fixture()
  expect(await f.service.getCheckoutSynchronization()).toMatchObject({ evidence: { relationship: 'IN_SYNC' }, action: null })
  await advance(f.writer, 'remote.txt'); await gitExec(f.writer, ['push', 'origin', 'topic'])
  const refs = await gitExec(f.local, ['show-ref'])
  const reads = vi.spyOn(f.git as unknown as { runGit: (args: string[], root: string, options?: { env?: NodeJS.ProcessEnv }) => Promise<string> }, 'runGit')
  const unknown = await f.service.getCheckoutSynchronization()
  expect(unknown).toMatchObject({ evidence: { relationship: 'UNKNOWN', tracking: 'TRACKING_STALE', remoteCounts: null }, action: 'FETCH' })
  expect(await gitExec(f.local, ['show-ref'])).toBe(refs)
  expect(reads.mock.calls.some(([args, , options]) => args[0] === 'rev-list' && args[3]?.includes('...') && options?.env?.GIT_NO_LAZY_FETCH === '1')).toBe(true)
  const context = { projectId: 'p', revision: 1 }
  const fetch = { context, operationId: randomUUID(), snapshot: unknown.state, operation: { action: 'FETCH' as const, contextual: true as const } }
  expect(await f.service.executeManagementMutation(fetch, () => {})).toMatchObject({ value: { result: 'FETCHED' } })
  const behind = await f.service.getCheckoutSynchronization()
  expect(behind).toMatchObject({ evidence: { relationship: 'BEHIND', remoteCounts: { ahead: 0, behind: 1 } }, action: 'PULL_FF_ONLY' })
  writeFile(f.local, 'dirty.txt', 'dirty')
  expect(await f.service.getCheckoutSynchronization()).toMatchObject({ action: null, blockedReason: expect.stringContaining('limpa') })
  const { unlinkSync } = await import('node:fs'); const { join } = await import('node:path'); unlinkSync(join(f.local, 'dirty.txt'))
  const pull = vi.spyOn(f.transport, 'pullFastForward')
  const request = { context, operationId: randomUUID(), snapshot: behind.state, operation: { action: 'PULL_FF_ONLY' as const, contextual: true as const } }
  const receipt = await f.service.executeManagementMutation(request, () => {})
  expect(receipt.isError).not.toBe(true)
  expect((await f.service.getState()).head).toBe((await gitExec(f.writer, ['rev-parse', 'HEAD'])).trim())
  expect(await f.service.executeManagementMutation(request, () => { throw new Error('replayed') })).toEqual({ ...receipt, value: { ...receipt.value, replayed: true } })
  expect(pull).toHaveBeenCalledTimes(1)
}, 60000)

it('reviews ahead even dirty, inspects divergence and refuses stale upstream or changed remote evidence', async () => {
  const f = await fixture()
  await advance(f.local, 'local.txt')
  writeFile(f.local, 'dirty.txt', 'dirty')
  expect(await f.service.getCheckoutSynchronization()).toMatchObject({ action: 'REVIEW_PUBLICATION', evidence: { relationship: 'AHEAD', remoteCounts: { ahead: 1, behind: 0 } } })
  await advance(f.writer, 'remote.txt'); await gitExec(f.writer, ['push', 'origin', 'topic']); await gitExec(f.local, ['fetch', 'origin'])
  expect(await f.service.getCheckoutSynchronization()).toMatchObject({ action: 'COMPARE', evidence: { relationship: 'DIVERGED', remoteCounts: { ahead: 1, behind: 1 } } })
  const readonly = new GitOperationsService(f.local, f.git, f.transport, undefined, true)
  expect(await readonly.getCheckoutSynchronization()).toMatchObject({ action: null, blockedReason: expect.stringContaining('executor') })
  await gitExec(f.local, ['config', '--unset', 'branch.topic.remote'])
  expect(await f.service.getCheckoutSynchronization()).toMatchObject({ action: null, evidence: { status: 'UNAVAILABLE', reason: 'NO_UPSTREAM' } })
}, 60000)

it('revalidates upstream and remote before contextual mutation, and rejects observations crossing branch changes', async () => {
  const f = await fixture()
  await advance(f.writer, 'remote.txt'); await gitExec(f.writer, ['push', 'origin', 'topic']); await gitExec(f.local, ['fetch', 'origin'])
  const observed = await f.service.getCheckoutSynchronization()
  await gitExec(f.local, ['branch', '--set-upstream-to=origin/topic'])
  await advance(f.writer, 'new.txt'); await gitExec(f.writer, ['push', 'origin', 'topic'])
  const pull = vi.spyOn(f.transport, 'pullFastForward')
  expect(await f.service.executeManagementMutation({ context: { projectId: 'p', revision: 1 }, operationId: randomUUID(), snapshot: observed.state, operation: { action: 'PULL_FF_ONLY', contextual: true } }, () => {})).toMatchObject({ isError: true, value: { code: 'GIT_STATE_CHANGED' } })
  expect(pull).not.toHaveBeenCalled()
  const read = f.transport.readRemoteHead.bind(f.transport)
  vi.spyOn(f.transport, 'readRemoteHead').mockImplementationOnce(async (...args) => { const result = await read(...args); await gitExec(f.local, ['switch', '-c', 'other']); return result })
  await expect(f.service.getCheckoutSynchronization()).rejects.toThrow('GIT_STATE_CHANGED')
}, 60000)

it('diagnoses incompatible destinations and network errors, preserves equal-head proof with stale tracking, and disables detached actions', async () => {
  const f = await fixture()
  await advance(f.writer, 'remote.txt'); await gitExec(f.writer, ['push', 'origin', 'topic']); await gitExec(f.local, ['fetch', 'origin'])
  await gitExec(f.local, ['config', 'branch.topic.merge', 'refs/heads/other'])
  await gitExec(f.remote, ['update-ref', 'refs/heads/other', (await gitExec(f.writer, ['rev-parse', 'HEAD'])).trim()])
  await gitExec(f.local, ['fetch', 'origin'])
  expect(await f.service.getCheckoutSynchronization()).toMatchObject({ action: null, blockedReason: expect.stringContaining('destino') })
  await gitExec(f.local, ['config', 'branch.topic.merge', 'refs/heads/topic'])
  const read = vi.spyOn(f.transport, 'readRemoteHead').mockRejectedValueOnce(new Error('unreachable'))
  expect(await f.service.getCheckoutSynchronization()).toMatchObject({ action: null, evidence: { status: 'UNAVAILABLE', reason: 'NETWORK_ERROR' } })
  read.mockRestore()
  await gitExec(f.local, ['merge', '--ff-only', 'origin/topic'])
  await gitExec(f.local, ['update-ref', 'refs/remotes/origin/topic', (await gitExec(f.local, ['rev-parse', 'HEAD~1'])).trim()])
  expect(await f.service.getCheckoutSynchronization()).toMatchObject({ action: null, evidence: { relationship: 'IN_SYNC', tracking: 'TRACKING_STALE', remoteCounts: { ahead: 0, behind: 0 } } })
  await gitExec(f.local, ['checkout', '--detach'])
  expect(await f.service.getCheckoutSynchronization()).toMatchObject({ action: null, blockedReason: expect.stringContaining('detached') })
}, 60000)
