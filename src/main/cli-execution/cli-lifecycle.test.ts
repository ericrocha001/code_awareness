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
