import { describe, expect, it, vi } from 'vitest'
import { DevUpdateService } from './dev-update-service'
import type { IDevUpdateSupervisorClient } from './dev-update-supervisor-client'
import type { GitService } from '../core/git-service'
import type { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'

function createMockRuntimeIdentity(overrides: {
  mode?: 'development' | 'production'
  instanceId?: string
  status?: 'GIT_WORKTREE' | 'NON_GIT'
  detached?: boolean
  branch?: string | null
  head?: string | null
  rootPath?: string
  freshnessState?: 'MATCH' | 'SOURCE_CHANGED_SINCE_START'
} = {}) {
  const mode = overrides.mode ?? 'development'
  const instanceId = overrides.instanceId ?? 'test-instance-123'
  const status = overrides.status ?? 'GIT_WORKTREE'
  const detached = overrides.detached ?? false
  const branch = overrides.branch !== undefined ? overrides.branch : 'main'
  const head = overrides.head !== undefined ? overrides.head : 'head-sha-1'
  const rootPath = overrides.rootPath ?? '/app/root'
  const freshnessState = overrides.freshnessState ?? 'MATCH'

  return {
    sourceOriginReady: Promise.resolve(),
    getRuntimeInfo: () => ({ instanceId, mode, startedAt: '2026-11-20', appVersion: '1.0.0', protocolVersion: '1' }),
    getInstanceId: () => instanceId,
    getIdentityPayload: () => ({
      sourceOrigin: {
        status,
        sourceRootPath: rootPath,
        worktree: status === 'GIT_WORKTREE' ? { rootPath, branch, head, detached, worktreeId: 'wt-1' } : null,
        capturedAt: '2026-11-20'
      },
      runtime: { instanceId, mode, startedAt: '2026-11-20', appVersion: '1.0.0', protocolVersion: '1' },
      startupSource: { fingerprint: 'fp1', fileCount: 10, capturedAt: '2026-11-20' },
      currentSource: { fingerprint: 'fp1', fileCount: 10, capturedAt: '2026-11-20' },
      freshness: { state: freshnessState }
    }),
    evaluateFreshness: () => ({
      currentSnapshot: { fingerprint: 'fp1', fileCount: 10, capturedAt: '2026-11-20' },
      freshness: { state: freshnessState }
    })
  } as unknown as RuntimeIdentityProvider
}

function createMockSupervisor(available = true): IDevUpdateSupervisorClient & { receipts: Map<string, any> } {
  const receipts = new Map<string, any>()
  return {
    receipts,
    isAvailable: () => available,
    reserve: vi.fn(async () => true),
    cancel: vi.fn(async () => true),
    commit: vi.fn(async () => true),
    announceReady: vi.fn(async () => true),
    getStatus: vi.fn(async (opId?: string) => opId ? receipts.get(opId) || null : null)
  }
}

function createMockGitService(overrides: Partial<GitService> = {}) {
  return {
    getModifiedFiles: vi.fn(async () => []),
    getUpstreamReference: vi.fn(async () => ({ remote: 'origin', ref: 'refs/heads/main', trackingHead: 'head-sha-2' })),
    fetchRemote: vi.fn(async () => {}),
    getCurrentCommitHash: vi.fn(async () => 'head-sha-1'),
    compareCommits: vi.fn(async () => ({ ahead: 0, behind: 1 })),
    pullFastForward: vi.fn(async () => {}),
    isCommitReachable: vi.fn(async () => true),
    ...overrides
  } as unknown as GitService
}

describe('DevUpdateService', () => {
  it('rejects execution when in production or packaged mode', async () => {
    const identity = createMockRuntimeIdentity({ mode: 'production' })
    const supervisor = createMockSupervisor()
    const git = createMockGitService()
    const service = new DevUpdateService({
      runtimeIdentity: identity,
      supervisor,
      gitService: git,
      requestShutdown: vi.fn()
    })

    const result = await service.executeDevUpdate({ operationId: 'op-1', expectedInstanceId: 'test-instance-123' })
    expect(result.status).toBe('UNSUPPORTED')
    expect(result.message).toContain('modo de desenvolvimento')
  })

  it('rejects execution when supervisor is unavailable', async () => {
    const identity = createMockRuntimeIdentity()
    const supervisor = createMockSupervisor(false)
    const git = createMockGitService()
    const service = new DevUpdateService({
      runtimeIdentity: identity,
      supervisor,
      gitService: git,
      requestShutdown: vi.fn()
    })

    const result = await service.executeDevUpdate({ operationId: 'op-1', expectedInstanceId: 'test-instance-123' })
    expect(result.status).toBe('UNSUPPORTED')
    expect(result.message).toContain('Supervisor não está acessível')
  })

  it('rejects execution when instance ID does not match expected', async () => {
    const identity = createMockRuntimeIdentity({ instanceId: 'actual-inst' })
    const supervisor = createMockSupervisor()
    const git = createMockGitService()
    const service = new DevUpdateService({
      runtimeIdentity: identity,
      supervisor,
      gitService: git,
      requestShutdown: vi.fn()
    })

    const result = await service.executeDevUpdate({ operationId: 'op-1', expectedInstanceId: 'different-inst' })
    expect(result.status).toBe('INSTANCE_MISMATCH')
    expect(result.oldInstanceId).toBe('actual-inst')
  })

  it('rejects execution when HEAD is detached', async () => {
    const identity = createMockRuntimeIdentity({ detached: true })
    const supervisor = createMockSupervisor()
    const git = createMockGitService()
    const service = new DevUpdateService({
      runtimeIdentity: identity,
      supervisor,
      gitService: git,
      requestShutdown: vi.fn()
    })

    const result = await service.executeDevUpdate({ operationId: 'op-1', expectedInstanceId: 'test-instance-123' })
    expect(result.status).toBe('DETACHED_HEAD')
  })

  it('rejects execution when worktree is dirty', async () => {
    const identity = createMockRuntimeIdentity()
    const supervisor = createMockSupervisor()
    const git = createMockGitService({
      getModifiedFiles: vi.fn(async () => [{ relativePath: 'src/main.ts', name: 'main.ts', changeType: 'modified' as const, mtime: 100, size: 100 }])
    })
    const service = new DevUpdateService({
      runtimeIdentity: identity,
      supervisor,
      gitService: git,
      requestShutdown: vi.fn()
    })

    const result = await service.executeDevUpdate({ operationId: 'op-1', expectedInstanceId: 'test-instance-123' })
    expect(result.status).toBe('DIRTY_WORKTREE')
    expect(supervisor.reserve).not.toHaveBeenCalled()
  })

  it('rejects execution on asymmetric tracking', async () => {
    const identity = createMockRuntimeIdentity({ branch: 'feat/local' })
    const supervisor = createMockSupervisor()
    const git = createMockGitService({
      getUpstreamReference: vi.fn(async () => ({ remote: 'origin', ref: 'refs/heads/main', trackingHead: 'upstream-head' }))
    })
    const service = new DevUpdateService({
      runtimeIdentity: identity,
      supervisor,
      gitService: git,
      requestShutdown: vi.fn()
    })

    const result = await service.executeDevUpdate({ operationId: 'op-1', expectedInstanceId: 'test-instance-123' })
    expect(result.status).toBe('ASYMMETRIC_TRACKING_UNSUPPORTED')
  })

  it('releases supervisor lock and reports error when fetch fails', async () => {
    const identity = createMockRuntimeIdentity()
    const supervisor = createMockSupervisor()
    const git = createMockGitService({
      fetchRemote: vi.fn(async () => { throw new Error('Remote host unreachable') })
    })
    const service = new DevUpdateService({
      runtimeIdentity: identity,
      supervisor,
      gitService: git,
      requestShutdown: vi.fn()
    })

    const result = await service.executeDevUpdate({ operationId: 'op-1', expectedInstanceId: 'test-instance-123' })
    expect(result.status).toBe('FAILED')
    expect(result.message).toContain('Remote host unreachable')
    expect(supervisor.cancel).toHaveBeenCalledWith('op-1')
  })

  it('rejects when local branch is ahead of upstream', async () => {
    const identity = createMockRuntimeIdentity()
    const supervisor = createMockSupervisor()
    const git = createMockGitService({
      getCurrentCommitHash: vi.fn(async () => 'head-ahead'),
      getUpstreamReference: vi.fn(async () => ({ remote: 'origin', ref: 'refs/heads/main', trackingHead: 'head-behind' })),
      compareCommits: vi.fn(async () => ({ ahead: 2, behind: 1 }))
    })
    const service = new DevUpdateService({
      runtimeIdentity: identity,
      supervisor,
      gitService: git,
      requestShutdown: vi.fn()
    })

    const result = await service.executeDevUpdate({ operationId: 'op-1', expectedInstanceId: 'test-instance-123' })
    expect(result.status).toBe('AHEAD_OR_DIVERGED')
    expect(supervisor.cancel).toHaveBeenCalledWith('op-1')
  })

  it('validates expectedIntegratedCommit and rejects when not reachable in upstream', async () => {
    const identity = createMockRuntimeIdentity()
    const supervisor = createMockSupervisor()
    const git = createMockGitService({
      getCurrentCommitHash: vi.fn(async () => 'head-sha-1'),
      getUpstreamReference: vi.fn(async () => ({ remote: 'origin', ref: 'refs/heads/main', trackingHead: 'head-sha-2' })),
      isCommitReachable: vi.fn(async () => false)
    })
    const service = new DevUpdateService({
      runtimeIdentity: identity,
      supervisor,
      gitService: git,
      requestShutdown: vi.fn()
    })

    const result = await service.executeDevUpdate({
      operationId: 'op-1',
      expectedInstanceId: 'test-instance-123',
      expectedIntegratedCommit: 'commit-from-pr'
    })
    expect(result.status).toBe('EXPECTED_COMMIT_NOT_INTEGRATED')
    expect(supervisor.cancel).toHaveBeenCalledWith('op-1')
  })

  it('performs pull fast-forward, commits to supervisor, and returns SCHEDULED with postResponse', async () => {
    const identity = createMockRuntimeIdentity()
    const supervisor = createMockSupervisor()
    const shutdownFn = vi.fn()
    let currentHash = 'head-sha-1'
    const git = createMockGitService({
      getCurrentCommitHash: vi.fn(async () => currentHash),
      getUpstreamReference: vi.fn(async () => ({ remote: 'origin', ref: 'refs/heads/main', trackingHead: 'head-sha-2' })),
      compareCommits: vi.fn(async () => ({ ahead: 0, behind: 1 })),
      pullFastForward: vi.fn(async () => { currentHash = 'head-sha-2' })
    })
    const service = new DevUpdateService({
      runtimeIdentity: identity,
      supervisor,
      gitService: git,
      requestShutdown: shutdownFn
    })

    const result = await service.executeDevUpdate({
      operationId: 'op-successful-update',
      expectedInstanceId: 'test-instance-123'
    })

    expect(result.status).toBe('SCHEDULED')
    expect(result.head).toBe('head-sha-2')
    expect(result.message).toContain('DevUpdate agendado')
    expect(git.pullFastForward).toHaveBeenCalledWith('/app/root', 'origin', 'main')
    expect(supervisor.commit).toHaveBeenCalledWith({
      operationId: 'op-successful-update',
      origin: { rootPath: '/app/root', branch: 'main' },
      expectedHead: 'head-sha-2',
      oldInstanceId: 'test-instance-123'
    })

    // Execute postResponse -> triggers shutdown
    expect(shutdownFn).not.toHaveBeenCalled()
    await result.postResponse?.()
    expect(shutdownFn).toHaveBeenCalled()
  })

  it('returns ALREADY_CURRENT for MCP caller when in sync and freshness is MATCH', async () => {
    const identity = createMockRuntimeIdentity({ freshnessState: 'MATCH' })
    const supervisor = createMockSupervisor()
    const git = createMockGitService({
      getCurrentCommitHash: vi.fn(async () => 'head-same'),
      getUpstreamReference: vi.fn(async () => ({ remote: 'origin', ref: 'refs/heads/main', trackingHead: 'head-same' }))
    })
    const service = new DevUpdateService({
      runtimeIdentity: identity,
      supervisor,
      gitService: git,
      requestShutdown: vi.fn()
    })

    const result = await service.executeDevUpdate({
      operationId: 'op-already-current',
      expectedInstanceId: 'test-instance-123',
      caller: 'MCP'
    })

    expect(result.status).toBe('ALREADY_CURRENT')
    expect(result.head).toBe('head-same')
    expect(supervisor.cancel).toHaveBeenCalledWith('op-already-current')
    expect(git.pullFastForward).not.toHaveBeenCalled()
  })

  it('proceeds with renewal when caller is UI even if HEAD is in sync', async () => {
    const identity = createMockRuntimeIdentity({ freshnessState: 'MATCH' })
    const supervisor = createMockSupervisor()
    const shutdownFn = vi.fn()
    const git = createMockGitService({
      getCurrentCommitHash: vi.fn(async () => 'head-same'),
      getUpstreamReference: vi.fn(async () => ({ remote: 'origin', ref: 'refs/heads/main', trackingHead: 'head-same' }))
    })
    const service = new DevUpdateService({
      runtimeIdentity: identity,
      supervisor,
      gitService: git,
      requestShutdown: shutdownFn
    })

    const result = await service.executeDevUpdate({
      operationId: 'op-ui-update',
      expectedInstanceId: 'test-instance-123',
      caller: 'UI'
    })

    expect(result.status).toBe('SCHEDULED')
    expect(result.head).toBe('head-same')
    expect(supervisor.commit).toHaveBeenCalled()
  })
})
