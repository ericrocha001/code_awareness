import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { textContent } from '../mcp/mcp-test-content'
import { CliExecutionService } from './cli-execution-service'
import { CLI_EXECUTION_TOOLS, executeCliTool } from './cli-execution-mcp'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import type { ContextNavigationPort } from '../core/context/context-navigation-port'
import { bindProjectNavigation } from '../core/context/project-context-navigation'

function createFakeNavigation(): ContextNavigationPort {
  return {
    discoverRepository: vi.fn(async () => ({ directories: [] })),
    getRelationships: vi.fn(async () => ({ files: [] })),
    inspectFiles: vi.fn(async () => ({ files: [] })),
    readCode: vi.fn(async () => []),
    getReferences: vi.fn(async () => ({ targets: [] })),
    getSymbolDependencies: vi.fn(async () => ({ sources: [] })),
    getSymbolHierarchy: vi.fn(async () => ({ targets: [] }))
  }
}


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

describe('U2 — Local Authorization & MCP Integration', () => {
  let testDir: string
  let service: CliExecutionService
  let fingerprintValue: string
  let autoApprove: boolean

  beforeEach(() => {
    testDir = join(tmpdir(), `ca-cli-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
    fingerprintValue = 'initial-fingerprint-123'
    autoApprove = true

    service = new CliExecutionService({
      repoRoot: testDir,
      repositoryId: 'repo-test',
      enabledByDefault: true,
      getFingerprint: async () => fingerprintValue,
      approvalHandler: async () => autoApprove
    })
  })

  afterEach(async () => {
    await service.shutdown()
    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {}
  })

  it('Property 1: Tool ownership, annotations e listTools no ChannelMcpAdapter', () => {
    const nav = bindProjectNavigation(createFakeNavigation(), testDir)

    // Adapter without cliExecution
    const adapterWithout = new ChannelMcpAdapter({
      projectId: 'proj-1',
      repoRoot: testDir,
      navigation: nav
    })
    const toolsWithout = adapterWithout.listTools()
    expect(toolsWithout.some((t) => t.name.startsWith('prepare_cli_execution'))).toBe(false)

    // Adapter with cliExecution
    const adapterWith = new ChannelMcpAdapter({
      projectId: 'proj-1',
      repoRoot: testDir,
      navigation: nav,
      cliExecution: service
    })
    const toolsWith = adapterWith.listTools()

    const prepareTool = toolsWith.find((t) => t.name === 'prepare_cli_execution')
    const startTool = toolsWith.find((t) => t.name === 'start_cli_execution')
    const getTool = toolsWith.find((t) => t.name === 'get_cli_execution')
    const cancelTool = toolsWith.find((t) => t.name === 'cancel_cli_execution')

    expect(prepareTool).toBeDefined()
    expect(startTool).toBeDefined()
    expect(getTool).toBeDefined()
    expect(cancelTool).toBeDefined()

    // Verify annotations
    expect(prepareTool?.annotations?.readOnlyHint).toBe(true)
    expect(startTool?.annotations?.readOnlyHint).toBe(false)
    expect(startTool?.annotations?.openWorldHint).toBe(true)
    expect(startTool?.annotations?.destructiveHint).toBe(true)
    expect(startTool?.annotations?.idempotentHint).toBe(true)
    expect(getTool?.annotations?.readOnlyHint).toBe(true)
    expect(cancelTool?.annotations?.readOnlyHint).toBe(false)
  })

  it('Property 2: Preflight sem execução de processos (prepare_cli_execution)', async () => {
    const res = await executeCliTool(service, 'prepare_cli_execution', {
      executable: process.execPath,
      args: ['-v']
    })

    expect(res.isError).toBeUndefined()
    const content = JSON.parse(textContent(res.content[0]))
    expect(content.proposalId).toBeDefined()
    expect(content.status).toBe('PENDING')
    expect(service.getActiveOperationId()).toBeNull()
  })

  it('Property 3: Tentar start sem habilitação local (off-by-default)', async () => {
    service.setEnabled(false)

    const res = await executeCliTool(service, 'prepare_cli_execution', {
      executable: process.execPath,
      args: ['-v']
    })

    expect(res.isError).toBe(true)
    const err = JSON.parse(textContent(res.content[0]))
    expect(err.code).toBe('CLI_EXECUTION_DISABLED')
  })

  it('Property 4: Recusa na aprovação nativa resulta em status REFUSED', async () => {
    autoApprove = false // Human clicks Reject

    const prep = await service.prepare({
      executable: process.execPath,
      args: ['-v']
    })

    await executeCliTool(service, 'start_cli_execution', {
      proposalId: prep.proposalId,
      operationId: 'op-refused-1'
    })

    // start returns AWAITING_APPROVAL; poll until approval settles
    const snap = await waitForStatus(service, 'op-refused-1', ['REFUSED', 'SUCCEEDED', 'FAILED'])
    expect(snap.status).toBe('REFUSED')
    expect(snap.diagnostic).toBe('NATIVE_APPROVAL_REFUSED')
  })

  it('Property 5: Replay idempotente de start com mesmo operationId + proposalId', async () => {
    const prep = await service.prepare({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 2000)']
    })

    await executeCliTool(service, 'start_cli_execution', {
      proposalId: prep.proposalId,
      operationId: 'op-replay-1'
    })
    // Wait until approval done and process is RUNNING
    const snap1 = await waitForStatus(service, 'op-replay-1', ['RUNNING'])
    expect(snap1.status).toBe('RUNNING')

    // Second call with identical arguments
    const res2 = await executeCliTool(service, 'start_cli_execution', {
      proposalId: prep.proposalId,
      operationId: 'op-replay-1'
    })
    // Replay with same args returns existing RUNNING execution
    const snap2 = service.get({ operationId: 'op-replay-1' })
    expect(snap2.operationId).toBe('op-replay-1')
    expect(snap2.status).toBe('RUNNING')

    await service.cancel({ operationId: 'op-replay-1' })
  })

  it('Property 6: Conflito de operationId com proposalId diferente', async () => {
    const prep1 = await service.prepare({
      executable: process.execPath,
      args: ['-e', 'console.log("1")']
    })
    const prep2 = await service.prepare({
      executable: process.execPath,
      args: ['-e', 'console.log("2")']
    })

    await service.start({
      proposalId: prep1.proposalId,
      operationId: 'op-conflict-1'
    })

    const resConflict = await executeCliTool(service, 'start_cli_execution', {
      proposalId: prep2.proposalId,
      operationId: 'op-conflict-1'
    })
    expect(resConflict.isError).toBe(true)
    const err = JSON.parse(textContent(resConflict.content[0]))
    expect(err.code).toBe('OPERATION_ID_CONFLICT')

    await service.cancel({ operationId: 'op-conflict-1' })
  })

  it('Property 7: Troca de estado/projeto no checkout invalida proposta preparada', async () => {
    const prep = await service.prepare({
      executable: process.execPath,
      args: ['-v']
    })

    // Simulate checkout fingerprint change (git branch switch or new commit)
    fingerprintValue = 'mutated-fingerprint-456'

    await executeCliTool(service, 'start_cli_execution', {
      proposalId: prep.proposalId,
      operationId: 'op-checkout-changed'
    })

    // CHECKOUT_CHANGED is detected after fingerprint revalidation post-approval
    const snap = await waitForStatus(service, 'op-checkout-changed', ['REFUSED', 'FAILED'])
    expect(snap.status).toBe('REFUSED')
    expect(snap.diagnostic).toBe('CHECKOUT_CHANGED')
  })

  it('Property 8: Fluxo E2E através do ChannelMcpAdapter (callTool)', async () => {
    const nav = bindProjectNavigation(createFakeNavigation(), testDir)
    const adapter = new ChannelMcpAdapter({
      projectId: 'proj-1',
      repoRoot: testDir,
      navigation: nav,
      cliExecution: service
    })

    // 1. prepare
    const prepRes = await adapter.callTool('prepare_cli_execution', {
      executable: process.execPath,
      args: ['-e', 'console.log("MCP_E2E_OK"); process.exit(0)']
    })
    expect(prepRes.isError).toBeUndefined()
    const prep = JSON.parse(textContent(prepRes.content[0]))
    expect(prep.proposalId).toBeDefined()

    // 2. start
    const startRes = await adapter.callTool('start_cli_execution', {
      proposalId: prep.proposalId,
      operationId: 'op-mcp-e2e'
    })
    expect(startRes.isError).toBeUndefined()
    const startSnap = JSON.parse(textContent(startRes.content[0]))
    // start_cli_execution returns immediately with AWAITING_APPROVAL; poll for RUNNING
    const startSnap2 = await waitForStatus(service, 'op-mcp-e2e', ['RUNNING', 'SUCCEEDED'])
    expect(startSnap2.status).toBe('RUNNING')

    // 3. get_cli_execution
    let getSnap: any
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const getRes = await adapter.callTool('get_cli_execution', {
        operationId: 'op-mcp-e2e'
      })
      getSnap = JSON.parse(textContent(getRes.content[0]))
      if (getSnap.status === 'SUCCEEDED') break
      await new Promise((r) => setTimeout(r, 50))
    }

    expect(getSnap.status).toBe('SUCCEEDED')
    expect(getSnap.stdout).toContain('MCP_E2E_OK')
    expect(getSnap.exitCode).toBe(0)

    // 4. cancel_cli_execution (idempotent after finish)
    const cancelRes = await adapter.callTool('cancel_cli_execution', {
      operationId: 'op-mcp-e2e'
    })
    const cancelSnap = JSON.parse(textContent(cancelRes.content[0]))
    expect(cancelSnap.status).toBe('SUCCEEDED')
  })
})
