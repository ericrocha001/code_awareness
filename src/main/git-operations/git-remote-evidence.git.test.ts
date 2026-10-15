import { afterEach, expect, it, vi } from 'vitest'
import { GitService } from '../core/git-service'
import { createTempGitRepo, cleanupTempRepo, gitExec, writeFile, stageAll, commit } from '../core/git-test-helpers'
import { GitHubGitTransport } from '../github/github-git-transport'
import { GitOperationsService } from './git-operations-service'
import { executeGitOperationsTool } from './git-operations-mcp'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await cleanupTempRepo(root) })
async function repo() { const root = await createTempGitRepo(); roots.push(root); return root }

it('detects live remote advancement without changing tracking, index or worktree', async () => {
  const local = await repo(), remote = await repo(), writer = await repo()
  await gitExec(remote, ['config', 'core.bare', 'true'])
  await gitExec(local, ['branch', '-m', 'main'])
  writeFile(local, 'a.txt', 'first'); await stageAll(local); await commit(local, 'first')
  await gitExec(local, ['remote', 'add', 'origin', remote]); await gitExec(local, ['push', '-u', 'origin', 'main'])
  const git = new GitService(), transport = new GitHubGitTransport(null, git)
  const service = new GitOperationsService(local, git, transport)
  expect((await service.getState('VERIFY')).remoteEvidence).toMatchObject({ status: 'VERIFIED', relationship: 'IN_SYNC' })
  await gitExec(writer, ['remote', 'add', 'origin', remote]); await gitExec(writer, ['fetch', 'origin'])
  await gitExec(writer, ['checkout', '-b', 'main', 'origin/main'])
  writeFile(writer, 'a.txt', 'second'); await stageAll(writer); await commit(writer, 'second'); await gitExec(writer, ['push', 'origin', 'main'])
  const before = await service.getState()
  const refs = await gitExec(local, ['show-ref'])
  expect(before).toMatchObject({ ahead: 0, behind: 0, remoteEvidence: { status: 'NOT_CHECKED' } })
  const result = await executeGitOperationsTool(service, 'get_git_state', { remoteCheck: 'VERIFY' })
  expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ ahead: 0, behind: 0, remoteEvidence: { status: 'VERIFIED', tracking: 'TRACKING_STALE', relationship: 'UNKNOWN', remoteCounts: null } })
  expect(await gitExec(local, ['show-ref'])).toBe(refs)
  expect(await service.getState()).toEqual(before)
  await gitExec(local, ['fetch', 'origin'])
  expect(await service.getState('VERIFY')).toMatchObject({ behind: 1, remoteEvidence: { tracking: 'TRACKING_CURRENT', relationship: 'BEHIND', remoteCounts: { ahead: 0, behind: 1 } } })
  await gitExec(local, ['merge', '--ff-only', 'origin/main'])
  expect((await service.getState('VERIFY')).remoteEvidence).toMatchObject({ relationship: 'IN_SYNC' })
}, 30_000)

it('does not probe by default and preserves unavailable evidence', async () => {
  const root = await repo(), git = new GitService(), transport = new GitHubGitTransport(null, git)
  const service = new GitOperationsService(root, git, transport)
  const read = vi.spyOn(transport, 'readRemoteHead')
  await service.getState(); expect(read).not.toHaveBeenCalled()
  expect((await service.getState('VERIFY')).remoteEvidence).toMatchObject({ status: 'UNAVAILABLE', reason: 'NO_UPSTREAM' })
  vi.spyOn(git, 'getUpstreamReference').mockResolvedValue({ remote: 'origin', ref: 'refs/heads/main', trackingHead: null })
  for (const [message, reason] of [['Git process timed out', 'TIMEOUT'], ['Permission denied', 'ACCESS_DENIED'], ['unreachable', 'NETWORK_ERROR'], ['REMOTE_MISSING', 'REMOTE_MISSING']] as const) {
    read.mockRejectedValueOnce(new Error(message))
    expect((await service.getState('VERIFY')).remoteEvidence).toMatchObject({ status: 'UNAVAILABLE', reason })
  }
  expect((await executeGitOperationsTool(service, 'get_git_state', { remoteCheck: 'FETCH' })).isError).toBe(true)
}, 30_000)
