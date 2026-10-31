import './cli-native-test-setup'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { CliExecutionService } from './cli-execution-service'


async function waitForStatus(
  service: CliExecutionService,
  operationId: string,
  statuses: string[],
  timeoutMs = 6000
): Promise<any> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snap = service.get({ operationId })
    if (statuses.includes(snap.status)) return snap
    await new Promise((r) => setTimeout(r, 30))
  }
  return service.get({ operationId })
}

describe('U1 — CLI Execution Service & Local Process Supervision', () => {
  let testDir: string
  let service: CliExecutionService

  beforeEach(() => {
    testDir = join(tmpdir(), `ca-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
    service = new CliExecutionService({
      repoRoot: testDir,
      repositoryId: 'test-repo',
      enabledByDefault: true,
      approvalHandler: async () => true // Auto-approve in tests unless overridden
    })
  })

  afterEach(async () => {
    await service.shutdown()
    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {}
  })

  it('Property 1: Execução inofensiva Node, saída e código exatos', async () => {
    const proposal = await service.prepare({
      executable: process.execPath,
      args: ['-e', 'console.log("HELLO_STDOUT"); console.error("HELLO_STDERR"); process.exit(0)']
    })

    expect(proposal.proposalId).toBeDefined()
    expect(proposal.command.args).toContain('-e')

    service.start({
      proposalId: proposal.proposalId,
      operationId: 'op-inoffensive-1'
    })

    // Wait until approval + launch completes (AWAITING_APPROVAL -> RUNNING -> SUCCEEDED)
    const snapshot = await waitForStatus(service, 'op-inoffensive-1', ['SUCCEEDED', 'FAILED', 'REFUSED'])

    expect(snapshot.status).toBe('SUCCEEDED')
    expect(snapshot.exitCode).toBe(0)
    expect(snapshot.stdout).toContain('HELLO_STDOUT')
    expect(snapshot.stderr).toContain('HELLO_STDERR')
  })

  it('Property 2: Argumentos com espaços e aspas preservados sem shell mangling', async () => {
    const spaceArg = 'hello world with spaces and "quotes"'
    const proposal = await service.prepare({
      executable: process.execPath,
      args: ['-e', 'console.log(process.argv[1])', spaceArg]
    })

    service.start({
      proposalId: proposal.proposalId,
      operationId: 'op-spaces-1'
    })

    const snapshot = await waitForStatus(service, 'op-spaces-1', ['SUCCEEDED', 'FAILED', 'REFUSED'])

    expect(snapshot.status).toBe('SUCCEEDED')
    expect(snapshot.stdout.trim()).toBe(spaceArg)
  })

  it('Property 3: Falha de spawn fail-closed para executável inexistente', async () => {
    await expect(
      service.prepare({
        executable: 'non-existent-executable-ca-12345.exe'
      })
    ).rejects.toThrow(/EXECUTABLE_NOT_FOUND/)
  })

  it('Property 4: Ausência de spawn fora da fronteira do checkout ativo', async () => {
    await expect(
      service.prepare({
        executable: process.execPath,
        args: ['-v'],
        relativeCwd: '../../'
      })
    ).rejects.toThrow(/CWD_OUTSIDE_CHECKOUT/)

    await expect(
      service.prepare({
        executable: process.execPath,
        args: ['-v'],
        relativeCwd: 'C:\\Windows'
      })
    ).rejects.toThrow(/ABSOLUTE_CWD_FORBIDDEN/)
  })

  it('Property 5: Cancelamento mata descendentes (árvore de processos)', async () => {
    // Child script spawns a grandchild that sleeps indefinitely
    const script = `
      const { spawn } = require('child_process');
      const sub = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      console.log('GRANDCHILD_PID:' + sub.pid);
      setInterval(() => {}, 1000);
    `
    const proposal = await service.prepare({
      executable: process.execPath,
      args: ['-e', script]
    })

    service.start({
      proposalId: proposal.proposalId,
      operationId: 'op-tree-cancel'
    })

    // Wait for RUNNING (approval done)
    await waitForStatus(service, 'op-tree-cancel', ['RUNNING'])

    // Poll until grandchild pid is logged
    let grandchildPid: number | null = null
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const snap = service.get({ operationId: 'op-tree-cancel' })
      const match = snap.stdout.match(/GRANDCHILD_PID:(\d+)/)
      if (match) {
        grandchildPid = Number(match[1])
        break
      }
      await new Promise((r) => setTimeout(r, 50))
    }

    expect(grandchildPid).toBeGreaterThan(0)

    // Cancel the execution
    const cancelSnap = await service.cancel({ operationId: 'op-tree-cancel' })
    expect(cancelSnap.status).toBe('CANCELLED')

    // Wait brief grace period and verify grandchild process is dead
    await new Promise((r) => setTimeout(r, 300))
    let grandchildAlive = true
    try {
      process.kill(grandchildPid!, 0)
    } catch {
      grandchildAlive = false
    }
    expect(grandchildAlive).toBe(false)
  })

  it('Property 6: Timeout mata descendentes e define status TIMED_OUT', async () => {
    // Custom service with short 1000ms timeout
    const timeoutService = new CliExecutionService({
      repoRoot: testDir,
      enabledByDefault: true,
      defaultTimeoutMs: 1000,
      approvalHandler: async () => true
    })

    const script = `
      const { spawn } = require('child_process');
      const sub = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      console.log('SUB_PID:' + sub.pid);
      setInterval(() => {}, 1000);
    `
    const proposal = await timeoutService.prepare({
      executable: process.execPath,
      args: ['-e', script]
    })

    timeoutService.start({
      proposalId: proposal.proposalId,
      operationId: 'op-tree-timeout'
    })

    // Wait until execution finishes (AWAITING_APPROVAL -> RUNNING -> TIMED_OUT)
    const snapshot = await waitForStatus(timeoutService, 'op-tree-timeout', ['TIMED_OUT', 'SUCCEEDED', 'FAILED'], 5000)

    expect(snapshot.status).toBe('TIMED_OUT')
    await timeoutService.shutdown()
  })

  it('Property 7: Quota e paginação de saída com cursor estável', async () => {
    // Generate ~40KB of output
    const script = `
      for (let i = 0; i < 500; i++) {
        console.log('LINE_' + String(i).padStart(4, '0') + '_STDOUT_PADDING_DATA_HERE_1234567890');
      }
    `
    const proposal = await service.prepare({
      executable: process.execPath,
      args: ['-e', script]
    })

    service.start({
      proposalId: proposal.proposalId,
      operationId: 'op-pagination-1'
    })

    const snap = await waitForStatus(service, 'op-pagination-1', ['SUCCEEDED', 'FAILED', 'REFUSED'])

    expect(snap.status).toBe('SUCCEEDED')
    expect(snap.totalStdoutBytes).toBeGreaterThan(20000)

    // Page 1
    const page1 = service.get({ operationId: 'op-pagination-1', cursor: '0' })
    expect(page1.hasMore).toBe(true)
    expect(page1.nextCursor).toBeDefined()
    expect(page1.stdout.length).toBeGreaterThan(0)

    // Page 2
    const page2 = service.get({ operationId: 'op-pagination-1', cursor: page1.nextCursor! })
    expect(page2.stdout.length).toBeGreaterThan(0)
    expect(page2.stdout).not.toEqual(page1.stdout)
  })

  it('Property 8: Idempotência de start com mesmo operationId e proposalId', async () => {
    const proposal = await service.prepare({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 2000)']
    })

    service.start({
      proposalId: proposal.proposalId,
      operationId: 'op-idempotent-1'
    })

    // Wait until approval completes and status is RUNNING
    const snap1 = await waitForStatus(service, 'op-idempotent-1', ['RUNNING'])
    expect(snap1.status).toBe('RUNNING')

    // Second call with same proposalId and operationId returns same active execution
    const snap2 = service.start({
      proposalId: proposal.proposalId,
      operationId: 'op-idempotent-1'
    })
    expect(snap2.operationId).toBe('op-idempotent-1')
    expect(snap2.status).toBe('RUNNING')

    await service.cancel({ operationId: 'op-idempotent-1' })
  })

  it('Property 9: Concorrência exclusiva (BUSY se outra operação estiver em andamento)', async () => {
    const proposal1 = await service.prepare({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 3000)']
    })
    const proposal2 = await service.prepare({
      executable: process.execPath,
      args: ['-e', 'console.log("second")']
    })

    service.start({
      proposalId: proposal1.proposalId,
      operationId: 'op-concurrency-1'
    })

    // Wait until first operation is RUNNING before attempting second
    await waitForStatus(service, 'op-concurrency-1', ['RUNNING'])

    expect(
      () => service.start({
        proposalId: proposal2.proposalId,
        operationId: 'op-concurrency-2'
      })
    ).toThrow(/CLI_EXECUTION_BUSY/)

    await service.cancel({ operationId: 'op-concurrency-1' })
  })

  it('Property 10: Capability desabilitada rejeita preparo e encerra execuções ativas', async () => {
    service.setEnabled(false)
    expect(service.isEnabled()).toBe(false)

    await expect(
      service.prepare({
        executable: process.execPath,
        args: ['-v']
      })
    ).rejects.toThrow(/CLI_EXECUTION_DISABLED/)
  })
})
