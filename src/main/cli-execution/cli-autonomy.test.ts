import './cli-native-test-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CliPolicy } from '../../shared/types/cli-policy-types'
import { CliExecutionService } from './cli-execution-service'
import { CliOutputBuffer } from './cli-output-buffer'
import { executeCliTool, CLI_EXECUTION_TOOLS } from './cli-execution-mcp'
import { CliProcessSupervisor } from './cli-process-supervisor'

async function until<T>(get: () => T, ready: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + 12000
  while (performance.now() < deadline) { const value = get(); if (ready(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)) }
  throw new Error('TEST_TIMEOUT')
}
const query = { executable: process.execPath, args: ['--version'] }
const metadata = (name = 'whoami.exe') => ({ executable: join(process.env.SystemRoot!, 'System32', name), args: [] })

describe('Autonomous CLI and sequential investigations on the native Windows owner', () => {
  let root: string, service: CliExecutionService, policy: CliPolicy, fingerprint: string
  const approval = vi.fn(async () => true)
  const unitDone = (operationId: string) => until(() => service.get({ operationId }), result => result.phase === 'TERMINAL')
  const batchDone = (operationId: string) => until(() => service.getInvestigation({ operationId }), result => result.phase === 'TERMINAL')
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ca-cli-auto-'))
    policy = { mode: 'AUTONOMOUS_TRUSTED', revision: 'local-1', rule: 'local-repository-trust' }; fingerprint = 'checkout'
    approval.mockReset().mockResolvedValue(true)
    service = new CliExecutionService({ repoRoot: root, repositoryId: 'repo', enabledByDefault: true,
      getPolicy: () => policy, getFingerprint: async () => fingerprint, approvalHandler: approval })
  })
  afterEach(async () => { await service.shutdown(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
  it('runs three real unit queries, an interpreter and a package manager with zero command dialogs', async () => {
    for (const [index, input] of [query, metadata(), metadata('hostname.exe'), { executable: process.execPath, args: ['-e', "require('fs').writeFileSync('trusted-write','yes')"] }, { executable: 'npm.cmd', args: ['--version'] }].entries()) {
      const proposal = await service.prepare(input), operationId = `query-${index}`
      service.start({ proposalId: proposal.proposalId, operationId })
      const result = await unitDone(operationId)
      expect(result.status, JSON.stringify(result)).toBe('SUCCEEDED')
      expect(result.policy?.mode).toBe('AUTONOMOUS_TRUSTED')
      expect(result.treeObservation).toEqual({ activeProcesses: 0, handlesClosed: true })
      expect(service.start({ proposalId: proposal.proposalId, operationId }).status).toBe('SUCCEEDED')
    }
    expect(approval).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'trusted-write'))).toBe(true)
  }, 20000)
  it('permits only actual system metadata grammar in consultative mode and rejects remote mode injection', async () => {
    policy = { ...policy, mode: 'AUTONOMOUS_CONSULTATIVE' }
    const proposal = await service.prepare(metadata())
    service.start({ proposalId: proposal.proposalId, operationId: 'metadata' })
    expect((await unitDone('metadata')).status).toBe('SUCCEEDED')
    for (const input of [query, { ...metadata(), args: ['--help'] }, { executable: 'cmd.exe', args: ['/c', 'whoami'] }]) {
      const rejected = await service.prepare(input)
      expect(() => service.start({ proposalId: rejected.proposalId, operationId: 'rejected' })).toThrow('NOT_AUTO_AUTHORIZED')
    }
    const batch = await service.prepareInvestigation({ commands: [metadata(), query] })
    expect(() => service.startInvestigation({ proposalId: batch.proposalId, operationId: 'invalid-batch' })).toThrow('NOT_AUTO_AUTHORIZED')
    const bypass = await executeCliTool(service, 'prepare_cli_execution', { ...query, mode: 'AUTONOMOUS_TRUSTED' })
    expect(bypass.isError).toBe(true)
    expect(approval).not.toHaveBeenCalled()
  })
  it.each(['SUPERVISED', 'AUTONOMOUS_CONSULTATIVE', 'AUTONOMOUS_TRUSTED'] as const)('runs one closed manifest under %s with the expected approval count and selective output', async mode => {
    policy = { ...policy, mode }
    const proposal = await service.prepareInvestigation({ commands: mode === 'AUTONOMOUS_CONSULTATIVE' ? [metadata(), metadata('hostname.exe')] : [query, query, query] })
    const input = { proposalId: proposal.proposalId, operationId: 'manifest' }
    service.startInvestigation(input)
    expect(() => proposal.commands!.push(query as never)).toThrow()
    expect(() => service.start({ proposalId: (proposal.proposalId), operationId: 'another' })).toThrow('CLI_EXECUTION_BUSY')
    const result = await batchDone('manifest')
    expect(result.status).toBe('SUCCEEDED')
    expect(result.steps.every(step => step.status === 'SUCCEEDED')).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/stdout|stderr|originalArgs|displayCommandLine/)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192)
    const output = service.getInvestigation({ operationId: 'manifest', index: 0 })
    expect('output' in output && output.output.stdout.length).toBeGreaterThan(0)
    expect(service.startInvestigation(input)).toEqual(result)
    expect(approval).toHaveBeenCalledTimes(mode === 'SUPERVISED' ? 1 : 0)
    if (mode === 'SUPERVISED') expect(approval).toHaveBeenCalledWith(expect.objectContaining({ manifestHash: proposal.manifestHash, commands: proposal.commands, budgets: proposal.budgets }))
  }, 20000)
  it('stops the sequence on failure and never exposes private output in aggregate summaries', async () => {
    const proposal = await service.prepareInvestigation({ commands: [
      { executable: process.execPath, args: ['-e', "console.log('private-output'); process.exit(7)"] },
      { executable: process.execPath, args: ['-e', "require('fs').writeFileSync('must-not-run','unsafe')"] }
    ] })
    service.startInvestigation({ proposalId: proposal.proposalId, operationId: 'failed' })
    const result = await batchDone('failed')
    expect(result.status).toBe('FAILED'); expect(result.steps[1].status).toBe('NOT_STARTED')
    expect(JSON.stringify(result)).not.toContain('private-output')
    expect(existsSync(join(root, 'must-not-run'))).toBe(false)
  })
  it('never reports a terminal batch while the authority check of a subsequent step is pending', async () => {
    let release!: () => void, firstCompleted = false, waiting = false
    const barrier = new Promise<void>(resolve => { release = resolve })
    await service.shutdown()
    service = new CliExecutionService({ repoRoot: root, enabledByDefault: true, getPolicy: () => policy,
      getFingerprint: async () => { if (firstCompleted && !waiting) { waiting = true; await barrier } return fingerprint } })
    const supervisor = (service as unknown as { supervisor: CliProcessSupervisor }).supervisor
    const launch = supervisor.launch.bind(supervisor)
    vi.spyOn(supervisor, 'launch').mockImplementation((command, options) => launch(command, options).then(result => { firstCompleted = true; return result }))
    const proposal = await service.prepareInvestigation({ commands: [query, query] })
    service.startInvestigation({ proposalId: proposal.proposalId, operationId: 'between' })
    await until(() => waiting, Boolean)
    const running = service.getInvestigation({ operationId: 'between' })
    expect(running.phase).toBe('RUNNING'); expect(running.status).toBe('RUNNING')
    expect(running.steps[0].status).toBe('SUCCEEDED'); expect(running.steps[1].status).toBe('NOT_STARTED')
    release()
    expect((await batchDone('between')).status).toBe('SUCCEEDED')
  })
  it.each(['revocation', 'drift', 'cancel'] as const)('terminates the active tree on %s and blocks remaining steps', async change => {
    const proposal = await service.prepareInvestigation({ commands: [
      { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, query
    ] })
    service.startInvestigation({ proposalId: proposal.proposalId, operationId: 'running' })
    await until(() => service.getInvestigation({ operationId: 'running' }), result => result.status === 'RUNNING')
    if (change === 'revocation') { policy = { ...policy, mode: 'SUPERVISED', revision: 'revoked' }; service.refreshPolicy() }
    if (change === 'drift') fingerprint = 'different-checkout'
    if (change === 'cancel') await service.cancelInvestigation({ operationId: 'running' })
    const result = await batchDone('running')
    expect(result.status).toBe('CANCELLED'); expect(result.steps[1].status).toBe('NOT_STARTED')
    expect(service.getActiveOperationId()).toBe(null)
  }, 20000)
  it('enforces UTF-8 combined output budgets and page budgets without changing unitary limits', async () => {
    const buffer = new CliOutputBuffer(undefined, undefined, 65536)
    buffer.appendStdout('😀'.repeat(20000)); buffer.appendStderr('private-error'.repeat(10000))
    let cursor: string | undefined, reconstructed = ''
    do {
      const page = buffer.readBoundedPage(cursor)
      expect(Buffer.byteLength(page.stdout) + Buffer.byteLength(page.stderr)).toBeLessThanOrEqual(8192)
      expect(page.totalStdoutBytes + page.totalStderrBytes).toBeLessThanOrEqual(65536)
      expect(page.truncated).toBe(true)
      reconstructed += page.stdout; cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(reconstructed).not.toContain('�')
    const proposal = await service.prepareInvestigation({ commands: Array.from({ length: 5 }, () => ({ executable: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(100000));process.stderr.write("y".repeat(100000))'] })) })
    service.startInvestigation({ proposalId: proposal.proposalId, operationId: 'output' })
    expect((await batchDone('output')).status).toBe('SUCCEEDED')
    let bytes = 0
    for (let index = 0; index < 5; index++) { const result = service.getInvestigation({ operationId: 'output', index }); if ('output' in result) bytes += result.output.totalStdoutBytes + result.output.totalStderrBytes }
    expect(bytes).toBeLessThanOrEqual(262144)
  }, 20000)
  it('keeps unconfirmed native termination quarantined for both unitary and batch admissions', async () => {
    const supervisor = (service as unknown as { supervisor: CliProcessSupervisor }).supervisor
    vi.spyOn(supervisor, 'launch').mockImplementation(() => {
      Object.defineProperty(supervisor, 'isRunning', { configurable: true, get: () => true })
      return Promise.resolve({ status: 'FAILED', diagnostic: 'TERMINATION_UNCONFIRMED', durationMs: 1 })
    })
    vi.spyOn(supervisor, 'cancel').mockResolvedValue({ status: 'FAILED', diagnostic: 'TERMINATION_UNCONFIRMED', durationMs: 1 })
    const proposal = await service.prepareInvestigation({ commands: [query, query] })
    service.startInvestigation({ proposalId: proposal.proposalId, operationId: 'quarantine' })
    await until(() => service.getInvestigation({ operationId: 'quarantine' }), result => result.phase === 'TERMINATION_UNCONFIRMED')
    expect(() => service.start({ proposalId: 'another', operationId: 'unit' })).toThrow('CLI_EXECUTION_BUSY')
    expect((await service.cancelInvestigation({ operationId: 'quarantine' })).phase).toBe('TERMINATION_UNCONFIRMED')
    await expect(service.shutdown()).rejects.toThrow('TERMINATION_UNCONFIRMED')
    Object.defineProperty(supervisor, 'isRunning', { configurable: true, get: () => false })
  })
  it('keeps step output immutable when a later unitary operation uses the same printable suboperation ID', async () => {
    const proposal = await service.prepareInvestigation({ commands: [query, query] })
    service.startInvestigation({ proposalId: proposal.proposalId, operationId: 'namespace' })
    await batchDone('namespace')
    const before = service.getInvestigation({ operationId: 'namespace', index: 0 })
    const unit = await service.prepare({ executable: process.execPath, args: ['-e', "console.log('other-operation-output')"] })
    service.start({ proposalId: unit.proposalId, operationId: 'namespace:0' })
    await unitDone('namespace:0')
    const after = service.getInvestigation({ operationId: 'namespace', index: 0 })
    expect('output' in after && after.output).toEqual('output' in before && before.output)
    expect(JSON.stringify(after)).not.toContain('other-operation-output')
  })
  it('enforces the real 30-second per-command timeout and never starts the following step', async () => {
    const proposal = await service.prepareInvestigation({ commands: [{ executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, query] })
    service.startInvestigation({ proposalId: proposal.proposalId, operationId: 'timeout' })
    const deadline = Date.now() + 40000
    while (service.getInvestigation({ operationId: 'timeout' }).phase !== 'TERMINAL' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
    const result = service.getInvestigation({ operationId: 'timeout' })
    expect(result.status).toBe('TIMED_OUT'); expect(result.steps[1].status).toBe('NOT_STARTED')
    expect(result.treeObservation).toEqual({ activeProcesses: 0, handlesClosed: true })
  }, 45000)
  it('enforces the total deadline before admitting the next process', async () => {
    const supervisor = (service as unknown as { supervisor: CliProcessSupervisor }).supervisor
    const launch = supervisor.launch.bind(supervisor)
    const now = Date.now.bind(Date)
    let offset = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now() + offset)
    vi.spyOn(supervisor, 'launch').mockImplementation((command, options) => launch(command, options).then(result => { offset = 91000; return result }))
    const proposal = await service.prepareInvestigation({ commands: [query, query] })
    service.startInvestigation({ proposalId: proposal.proposalId, operationId: 'deadline' })
    const result = await batchDone('deadline')
    expect(result.status).toBe('TIMED_OUT'); expect(result.diagnostic).toBe('INVESTIGATION_TIME_BUDGET')
    expect(supervisor.launch).toHaveBeenCalledTimes(1)
    expect(result.steps[1].status).toBe('NOT_STARTED')
  })
  it('registers all batch tools and reports unknown operations as unrecoverable instead of executing again', async () => {
    expect(CLI_EXECUTION_TOOLS.filter(tool => tool.name.endsWith('_cli_investigation'))).toHaveLength(4)
    expect(() => service.getInvestigation({ operationId: 'lost-after-restart' })).toThrow('UNKNOWN_NOT_RECOVERABLE_AFTER_RESTART')
    await expect(service.prepareInvestigation({ commands: [query] })).rejects.toThrow('INVESTIGATION_COMMAND_LIMIT')
    const result = await executeCliTool(service, 'prepare_cli_investigation', { commands: [query, query], autoMode: true })
    expect(result.isError).toBe(true)
  })
})
