import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitService } from '../core/git-service'
import { DevUpdateService } from './dev-update-service'
import type { IDevUpdateSupervisorClient } from './dev-update-supervisor-client'
import type { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'
import {
  createTempGitRepo,
  cleanupTempRepo,
  gitExec,
  writeFile,
  stageAll,
  commit
} from '../core/git-test-helpers'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await cleanupTempRepo(root)
  }
})

async function createRepo() {
  const root = await createTempGitRepo()
  roots.push(root)
  return root
}

async function fixture() {
  const local = await createRepo()
  const remote = await createRepo()
  const writer = await createRepo()

  await gitExec(remote, ['config', 'core.bare', 'true'])
  await gitExec(local, ['branch', '-m', 'main'])
  writeFile(local, 'file.txt', 'init')
  await stageAll(local)
  await commit(local, 'initial')

  await gitExec(local, ['remote', 'add', 'origin', remote])
  await gitExec(local, ['push', '-u', 'origin', 'main'])

  await gitExec(writer, ['remote', 'add', 'origin', remote])
  await gitExec(writer, ['fetch', 'origin'])
  await gitExec(writer, ['checkout', '-b', 'main', 'origin/main'])

  const git = new GitService()
  return { local, remote, writer, git }
}

function mockIdentity(localPath: string, instanceId = 'test-inst-git') {
  return {
    sourceOriginReady: Promise.resolve(),
    getRuntimeInfo: () => ({ instanceId, mode: 'development', startedAt: '2026-11-20', appVersion: '1.0.0', protocolVersion: '1' }),
    getInstanceId: () => instanceId,
    getIdentityPayload: () => ({
      sourceOrigin: {
        status: 'GIT_WORKTREE',
        sourceRootPath: localPath,
        worktree: { rootPath: localPath, branch: 'main', head: null, detached: false, worktreeId: 'wt-git' },
        capturedAt: '2026-11-20'
      },
      runtime: { instanceId, mode: 'development', startedAt: '2026-11-20', appVersion: '1.0.0', protocolVersion: '1' },
      startupSource: { fingerprint: 'fp1', fileCount: 1, capturedAt: '2026-11-20' },
      currentSource: { fingerprint: 'fp1', fileCount: 1, capturedAt: '2026-11-20' },
      freshness: { state: 'MATCH' }
    }),
    evaluateFreshness: () => ({
      currentSnapshot: { fingerprint: 'fp1', fileCount: 1, capturedAt: '2026-11-20' },
      freshness: { state: 'MATCH' }
    })
  } as unknown as RuntimeIdentityProvider
}

function mockSupervisor(): IDevUpdateSupervisorClient {
  return {
    isAvailable: () => true,
    reserve: vi.fn(async () => true),
    cancel: vi.fn(async () => true),
    commit: vi.fn(async () => true),
    announceReady: vi.fn(async () => true),
    getStatus: vi.fn(async () => null)
  }
}

describe('DevUpdateService real Git integration', () => {
  it('fetches remote, detects behind, fast-forwards cleanly and schedules restart', async () => {
    const f = await fixture()
    const identity = mockIdentity(f.local)
    const supervisor = mockSupervisor()
    const shutdown = vi.fn()

    const service = new DevUpdateService({
      runtimeIdentity: identity,
      supervisor,
      gitService: f.git,
      requestShutdown: shutdown
    })

    // Advance writer and push to remote
    writeFile(f.writer, 'feature.txt', 'external feature')
    await stageAll(f.writer)
    await commit(f.writer, 'external update')
    await gitExec(f.writer, ['push', 'origin', 'main'])
    const expectedHead = (await gitExec(f.writer, ['rev-parse', 'HEAD'])).trim()

    const result = await service.executeDevUpdate({
      operationId: 'update-real-1',
      expectedInstanceId: 'test-inst-git'
    })

    expect(result.status).toBe('SCHEDULED')
    expect(result.head).toBe(expectedHead)

    const finalLocalHead = (await gitExec(f.local, ['rev-parse', 'HEAD'])).trim()
    expect(finalLocalHead).toBe(expectedHead)
    expect(supervisor.commit).toHaveBeenCalled()

    await result.postResponse?.()
    expect(shutdown).toHaveBeenCalled()
  }, 60000)

  it('rejects fast-forward if local has unpushed commits ahead of upstream', async () => {
    const f = await fixture()
    const identity = mockIdentity(f.local)
    const supervisor = mockSupervisor()

    const service = new DevUpdateService({
      runtimeIdentity: identity,
      supervisor,
      gitService: f.git,
      requestShutdown: vi.fn()
    })

    // Advance local
    writeFile(f.local, 'local-ahead.txt', 'local')
    await stageAll(f.local)
    await commit(f.local, 'local commit')

    // Advance writer as well to create divergence
    writeFile(f.writer, 'remote-feat.txt', 'remote')
    await stageAll(f.writer)
    await commit(f.writer, 'remote commit')
    await gitExec(f.writer, ['push', 'origin', 'main'])

    const result = await service.executeDevUpdate({
      operationId: 'update-ahead',
      expectedInstanceId: 'test-inst-git'
    })

    expect(result.status).toBe('AHEAD_OR_DIVERGED')
    expect(supervisor.cancel).toHaveBeenCalledWith('update-ahead')
  }, 60000)

  it('returns ALREADY_CURRENT when local is already up to date with remote for MCP caller', async () => {
    const f = await fixture()
    const identity = mockIdentity(f.local)
    const supervisor = mockSupervisor()

    const service = new DevUpdateService({
      runtimeIdentity: identity,
      supervisor,
      gitService: f.git,
      requestShutdown: vi.fn()
    })

    const result = await service.executeDevUpdate({
      operationId: 'update-mcp-noop',
      expectedInstanceId: 'test-inst-git',
      caller: 'MCP'
    })

    expect(result.status).toBe('ALREADY_CURRENT')
    expect(supervisor.cancel).toHaveBeenCalledWith('update-mcp-noop')
  }, 60000)
})
