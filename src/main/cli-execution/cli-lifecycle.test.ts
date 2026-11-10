import './cli-native-test-setup'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CliExecutionService } from './cli-execution-service'
import { CliProcessSupervisor } from './cli-process-supervisor'

const directories: string[] = []
const services: CliExecutionService[] = []
function directory() { const path = mkdtempSync(join(tmpdir(), 'ca-cli-lifecycle-')); directories.push(path); return path }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate() && Date.now() < deadline) await new Promise(done => setTimeout(done, 20))
  expect(predicate()).toBe(true)
}
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown()
  vi.restoreAllMocks()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
describe('CLI lifecycle authorization and tree completion', () => {
  it('reserves operation atomically, cancels pending approval, and replay cannot spawn later', async () => {
    const approval = deferred<boolean>(), root = directory(), sentinel = join(root, 'effect')
    const service = new CliExecutionService({ repoRoot: root, enabledByDefault: true, approvalHandler: () => approval.promise })
    services.push(service)
    const proposal = await service.prepare({ executable: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)},'unsafe')`] })
    const input = { proposalId: proposal.proposalId, operationId: 'pending' }
    expect(service.start(input).status).toBe('AWAITING_APPROVAL')
    expect(service.start(input).status).toBe('AWAITING_APPROVAL')
    expect(() => service.start({ ...input, operationId: 'concurrent' })).toThrow('CLI_EXECUTION_BUSY')
    expect((await service.cancel({ operationId: 'pending' })).status).toBe('CANCELLED')
    approval.resolve(true)
    await new Promise(done => setTimeout(done, 50))
    expect(service.start(input).status).toBe('CANCELLED')
    expect(() => service.start({ ...input, operationId: 'reuse' })).toThrow('PROPOSAL_REFUSED')
    expect(existsSync(sentinel)).toBe(false)
  })
  it.each(['cancel', 'shutdown'] as const)('%s during suspended OWNED handshake prevents every target instruction and retains slot until terminal receipt', async action => {
    const barrier = deferred<string>(), owned = deferred<void>(), root = directory(), sentinel = join(root, 'effect')
    let calls = 0
    const service = new CliExecutionService({ repoRoot: root, enabledByDefault: true, approvalHandler: async () => true,
      getFingerprint: async () => { if (++calls === 3) { owned.resolve(); return barrier.promise } return 'identity' } })
    services.push(service)
    const proposal = await service.prepare({ executable: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)},'unsafe')`] })
    service.start({ proposalId: proposal.proposalId, operationId: action })
    await owned.promise
    expect(service.get({ operationId: action }).status).toBe('AWAITING_APPROVAL')
    const completion = action === 'cancel' ? service.cancel({ operationId: action }) : service.shutdown()
    expect(service.getActiveOperationId()).toBe(action)
    barrier.resolve('identity')
    await completion
    expect(service.get({ operationId: action }).status).toBe('CANCELLED')
    expect(service.get({ operationId: action }).phase).toBe('TERMINAL')
    expect(service.getActiveOperationId()).toBe(null)
    expect(existsSync(sentinel)).toBe(false)
  })
  it('expiry after fingerprint await refuses launch and never exposes RUNNING', async () => {
    const barrier = deferred<string>(), waiting = deferred<void>(), root = directory()
    let calls = 0
    const service = new CliExecutionService({ repoRoot: root, enabledByDefault: true, approvalHandler: async () => true,
      getFingerprint: async () => { if (++calls === 2) { waiting.resolve(); return barrier.promise } return 'identity' } })
    services.push(service)
    const proposal = await service.prepare({ executable: process.execPath, args: ['-v'] })
    service.start({ proposalId: proposal.proposalId, operationId: 'expired' })
    await waiting.promise
    proposal.expiresAt = new Date(0).toISOString()
    barrier.resolve('identity')
    await until(() => service.getActiveOperationId() === null)
    expect(service.get({ operationId: 'expired' }).status).toBe('CANCELLED')
  })
  it.each(['owner', 'control'] as const)('%s loss quarantines slot instead of claiming cancellation or freeing a spawn', async loss => {
    const root = directory(), supervisor = new CliProcessSupervisor()
    const completion = supervisor.launch({ executable: process.execPath, originalExecutable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: root, relativeCwd: '.', displayCommandLine: 'fixture' })
    await until(() => supervisor.phase === 'RUNNING')
    if (loss === 'owner') (supervisor as any).owner.kill()
    else (supervisor as any).control.destroy()
    const result = await completion
    expect(result.status).toBe('FAILED')
    expect(result.diagnostic).toContain('TERMINATION_UNCONFIRMED')
    expect(supervisor.isRunning).toBe(true)
    expect(supervisor.phase).toBe('TERMINATION_UNCONFIRMED')
    expect(() => supervisor.launch({} as any)).toThrow('SUPERVISOR_BUSY')
    expect((await supervisor.cancel()).status).toBe('FAILED')
  }, 10000)
  it('simulated failed termination cannot become CANCELLED on cancel/shutdown or release the service slot', async () => {
    const service = new CliExecutionService({ repoRoot: directory(), enabledByDefault: true, approvalHandler: async () => true })
    services.push(service)
    const supervisor = (service as any).supervisor as CliProcessSupervisor
    const failure = { status: 'FAILED' as const, durationMs: 1, diagnostic: 'TERMINATION_UNCONFIRMED:FAILED_TERMINATION' }
    vi.spyOn(supervisor, 'launch').mockImplementation(() => {
      Object.defineProperty(supervisor, 'isRunning', { configurable: true, get: () => true })
      return Promise.resolve(failure)
    })
    vi.spyOn(supervisor, 'cancel').mockResolvedValue(failure)
    const proposal = await service.prepare({ executable: process.execPath, args: ['-v'] })
    service.start({ proposalId: proposal.proposalId, operationId: 'uncertain' })
    await until(() => service.get({ operationId: 'uncertain' }).phase === 'TERMINATION_UNCONFIRMED')
    expect((await service.cancel({ operationId: 'uncertain' })).status).toBe('FAILED')
    await expect(service.shutdown()).rejects.toThrow('TERMINATION_UNCONFIRMED')
    services.splice(services.indexOf(service), 1)
    expect(service.get({ operationId: 'uncertain' }).finishedAt).toBeUndefined()
    expect(service.getActiveOperationId()).toBe('uncertain')
    service.setEnabled(true)
    expect(() => service.start({ proposalId: proposal.proposalId, operationId: 'late' })).toThrow('CLI_EXECUTION_BUSY')
  })
})

function mockControlledSupervisor(service: CliExecutionService) {
  const supervisor = (service as any).supervisor as CliProcessSupervisor
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let finish!: (res: { status: 'SUCCEEDED' | 'CANCELLED' | 'TIMED_OUT'; exitCode?: number; durationMs: number; diagnostic?: string; treeObservation: { activeProcesses: 0; handlesClosed: true } }) => void
  const launches: Array<{ timeoutMs?: number; maxTimeoutMs?: number; resumeAllowed?: boolean }> = []
  let cancelledCount = 0
  let startedAt = 0

  Object.defineProperty(supervisor, 'isRunning', { configurable: true, get: () => running })
  const settle = (status: 'SUCCEEDED' | 'CANCELLED' | 'TIMED_OUT', extra: { exitCode?: number; diagnostic?: string } = {}) => {
    if (!running) return
    running = false
    if (timer) { clearTimeout(timer); timer = undefined }
    finish({ status, durationMs: Date.now() - startedAt, treeObservation: { activeProcesses: 0, handlesClosed: true }, ...extra })
  }
  const launchSpy = vi.spyOn(supervisor, 'launch').mockImplementation((_cmd, options = {}) => {
    startedAt = Date.now()
    running = true
    const entry: { timeoutMs?: number; maxTimeoutMs?: number; resumeAllowed?: boolean } = { timeoutMs: options.timeoutMs, maxTimeoutMs: options.maxTimeoutMs }
    launches.push(entry)
    return new Promise(resolve => {
      finish = resolve
      void Promise.resolve(options.authorizeResume ? options.authorizeResume() : true).then(
        allowed => {
          entry.resumeAllowed = allowed
          if (!allowed) { settle('CANCELLED'); return }
          if (!running) return
          options.onRunning?.()
          const hardCap = Math.min(options.maxTimeoutMs ?? 120000, 900000)
          const effectiveTimeout = Math.max(1, Math.min(options.timeoutMs ?? 60000, hardCap))
          timer = setTimeout(() => settle('TIMED_OUT'), effectiveTimeout)
        },
        () => { entry.resumeAllowed = false; settle('CANCELLED') }
      )
    })
  })
  const cancelSpy = vi.spyOn(supervisor, 'cancel').mockImplementation(async () => {
    cancelledCount++
    settle('CANCELLED')
    return { status: 'CANCELLED', durationMs: Date.now() - startedAt, treeObservation: { activeProcesses: 0, handlesClosed: true } }
  })
  return { launches, launchSpy, cancelSpy, cancelledCount: () => cancelledCount, finishSuccess: () => settle('SUCCEEDED', { exitCode: 0 }) }
}

describe('Proposal admission TTL vs active execution authority', () => {
  it('rejects proposals expired before admission and native approvals received past the 5-minute TTL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-10T03:00:00Z'))
    const approval = deferred<boolean>(), root = directory()
    const service = new CliExecutionService({ repoRoot: root, enabledByDefault: true, approvalHandler: () => approval.promise })
    try {
      const { launchSpy } = mockControlledSupervisor(service)
      const expiredBeforeStart = await service.prepare({ executable: process.execPath, args: ['-v'] })
      expect(Date.parse(expiredBeforeStart.expiresAt) - Date.parse(expiredBeforeStart.createdAt)).toBe(300000)

      await vi.advanceTimersByTimeAsync(300001)
      expect(() => service.start({ proposalId: expiredBeforeStart.proposalId, operationId: 'expired-before-start' })).toThrow('PROPOSAL_EXPIRED')
      expect(launchSpy).not.toHaveBeenCalled()

      const lateApproval = await service.prepare({ executable: process.execPath, args: ['-v'] })
      service.start({ proposalId: lateApproval.proposalId, operationId: 'late-approval' })
      await vi.advanceTimersByTimeAsync(1)
      expect(service.get({ operationId: 'late-approval' }).status).toBe('AWAITING_APPROVAL')

      await vi.advanceTimersByTimeAsync(300001)
      approval.resolve(true)
      await vi.advanceTimersByTimeAsync(1)

      const snap = service.get({ operationId: 'late-approval' })
      expect(snap.status).toBe('CANCELLED')
      expect(snap.phase).toBe('TERMINAL')
      expect(snap.diagnostic).toBe('POLICY_CHANGED_OR_PROPOSAL_EXPIRED')
      expect(lateApproval.status).toBe('EXPIRED')
      expect(service.getActiveOperationId()).toBeNull()
      expect(launchSpy).not.toHaveBeenCalled()
    } finally {
      await service.shutdown()
      vi.useRealTimers()
    }
  })

  it('keeps already-admitted YOLO executions active past 5 simulated minutes and preserves 600s/900s BuildX timeout limits', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-10T03:00:00Z'))
    const root = directory()
    const service = new CliExecutionService({
      repoRoot: root,
      repositoryId: 'repo-yolo',
      enabledByDefault: true,
      getPolicy: () => ({ mode: 'AUTONOMOUS_TRUSTED', scope: 'REPOSITORY_WORKTREES', revision: 'yolo-1', rule: 'local-repository-worktree-trust' }),
      getRuntimeIdentity: async () => 'stable-runtime'
    })
    try {
      const mock = mockControlledSupervisor(service)
      const pDefault = await service.prepare({ executable: process.execPath, args: ['-v'], executionProfile: 'BUILDX_AGENTIC_UNIT' })
      expect(pDefault.timeoutProfile).toBe('BUILDX_AGENTIC_UNIT')
      expect(pDefault.timeoutMs).toBe(600000)

      service.start({ proposalId: pDefault.proposalId, operationId: 'yolo-over-5m' })
      await vi.advanceTimersByTimeAsync(5)
      expect(pDefault.status).toBe('CONSUMED')
      expect(mock.launches[0]).toEqual({ timeoutMs: 600000, maxTimeoutMs: 900000, resumeAllowed: true })
      expect(service.get({ operationId: 'yolo-over-5m' }).status).toBe('RUNNING')

      await vi.advanceTimersByTimeAsync(360000)
      expect(service.get({ operationId: 'yolo-over-5m' }).status).toBe('RUNNING')
      expect(service.get({ operationId: 'yolo-over-5m' }).phase).toBe('RUNNING')
      expect(mock.cancelledCount()).toBe(0)

      mock.finishSuccess()
      await vi.advanceTimersByTimeAsync(1)
      expect(service.get({ operationId: 'yolo-over-5m' }).status).toBe('SUCCEEDED')

      const pCapped = await service.prepare({ executable: process.execPath, args: ['-v'], executionProfile: 'BUILDX_AGENTIC_UNIT', timeoutMs: 1200000 })
      expect(pCapped.timeoutMs).toBe(900000)
      service.start({ proposalId: pCapped.proposalId, operationId: 'yolo-budget-cap' })
      await vi.advanceTimersByTimeAsync(5)
      expect(mock.launches[1]).toEqual({ timeoutMs: 900000, maxTimeoutMs: 900000, resumeAllowed: true })

      await vi.advanceTimersByTimeAsync(899000)
      expect(service.get({ operationId: 'yolo-budget-cap' }).status).toBe('RUNNING')

      await vi.advanceTimersByTimeAsync(2000)
      expect(service.get({ operationId: 'yolo-budget-cap' }).status).toBe('TIMED_OUT')
      expect(service.get({ operationId: 'yolo-budget-cap' }).timeoutMs).toBe(900000)
    } finally {
      await service.shutdown()
      vi.useRealTimers()
    }
  })

  it('still aborts admitted executions past 5 minutes when policy is revoked or runtime identity changes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-10T03:00:00Z'))
    const root = directory()
    let currentPolicy: { mode: 'AUTONOMOUS_TRUSTED' | 'SUPERVISED'; scope: 'REPOSITORY_WORKTREES' | 'ACTIVE_CHECKOUT_ONLY'; revision: string; rule: string } = {
      mode: 'AUTONOMOUS_TRUSTED', scope: 'REPOSITORY_WORKTREES', revision: 'yolo-1', rule: 'local-repository-worktree-trust'
    }
    let runtimeIdentity = 'stable-runtime'
    const service = new CliExecutionService({
      repoRoot: root,
      repositoryId: 'repo-yolo',
      enabledByDefault: true,
      getPolicy: () => currentPolicy,
      getRuntimeIdentity: async () => runtimeIdentity
    })
    try {
      const mock = mockControlledSupervisor(service)
      const p1 = await service.prepare({ executable: process.execPath, args: ['-v'], executionProfile: 'BUILDX_AGENTIC_UNIT' })
      service.start({ proposalId: p1.proposalId, operationId: 'yolo-revoke' })
      await vi.advanceTimersByTimeAsync(310000)
      expect(service.get({ operationId: 'yolo-revoke' }).status).toBe('RUNNING')

      currentPolicy = { mode: 'SUPERVISED', scope: 'ACTIVE_CHECKOUT_ONLY', revision: 'revoked-2', rule: 'native-command-consent' }
      await vi.advanceTimersByTimeAsync(600)
      expect(mock.cancelSpy).toHaveBeenCalledTimes(1)
      expect(service.get({ operationId: 'yolo-revoke' }).status).toBe('CANCELLED')
      expect(service.get({ operationId: 'yolo-revoke' }).diagnostic).toBe('POLICY_CHANGED')

      currentPolicy = { mode: 'AUTONOMOUS_TRUSTED', scope: 'REPOSITORY_WORKTREES', revision: 'yolo-3', rule: 'local-repository-worktree-trust' }
      service.refreshPolicy()
      const p2 = await service.prepare({ executable: process.execPath, args: ['-v'], executionProfile: 'BUILDX_AGENTIC_UNIT' })
      service.start({ proposalId: p2.proposalId, operationId: 'yolo-drift' })
      await vi.advanceTimersByTimeAsync(310000)
      expect(service.get({ operationId: 'yolo-drift' }).status).toBe('RUNNING')

      runtimeIdentity = 'changed-runtime'
      await vi.advanceTimersByTimeAsync(600)
      expect(mock.cancelSpy).toHaveBeenCalledTimes(2)
      expect(service.get({ operationId: 'yolo-drift' }).status).toBe('CANCELLED')
      expect(service.get({ operationId: 'yolo-drift' }).diagnostic).toBe('CHECKOUT_CHANGED')

      runtimeIdentity = 'stable-runtime'
      const p3 = await service.prepare({ executable: process.execPath, args: ['-v'], executionProfile: 'BUILDX_AGENTIC_UNIT' })
      service.start({ proposalId: p3.proposalId, operationId: 'yolo-disable' })
      await vi.advanceTimersByTimeAsync(310000)
      expect(service.get({ operationId: 'yolo-disable' }).status).toBe('RUNNING')

      service.setEnabled(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(mock.cancelSpy).toHaveBeenCalledTimes(3)
      expect(service.get({ operationId: 'yolo-disable' }).status).toBe('CANCELLED')
      expect(service.get({ operationId: 'yolo-disable' }).diagnostic).toBe('CLI_EXECUTION_DISABLED')
    } finally {
      await service.shutdown()
      vi.useRealTimers()
    }
  })
})
