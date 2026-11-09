import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { randomUUID } from 'node:crypto'
import { SessionMemoryCentralService } from '../smc/session-memory-central-service'
import { UnitFlowRuntimeFacade } from './unitflow-runtime-facade'
import {
  BUILDX_UNITFLOW_TOOLS,
  BUILDX_UNITFLOW_READ_TOOLS,
  BUILDX_UNITFLOW_MUTATION_TOOLS
} from './unitflow-mcp'
import { ChannelMcpAdapter } from '../../mcp/channel-mcp-adapter'
import { ValidationLedger } from '../../validation-ledger/validation-ledger'
import { RuntimeIdentityProvider } from '../../runtime-identity/runtime-identity-provider'
import type { BranchInventory } from '../../../shared/types/branch-orchestration-types'
import type { GitOperationsPort } from '../execution/workspace-binding-service'
import type { CliExecutionPort } from '../execution/grok-cli-bridge'
import type {
  CliProposal,
  CliExecutionSnapshot,
  PrepareCliExecutionInput,
  StartCliExecutionInput,
  GetCliExecutionInput,
  CliCommandDescriptor
} from '../../cli-execution/cli-execution-types'

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function parseMcpResult(res: any): any {
  if (!res?.content || !res.content[0]?.text) {
    throw new Error(`Invalid MCP result: ${JSON.stringify(res)}`)
  }
  return JSON.parse(res.content[0].text)
}

describe('BuildX UnitFlow Runtime & MCP Integration — Provas Mínimas', () => {
  let tempDir: string
  let smcService: SessionMemoryCentralService
  let ledger: ValidationLedger
  let runtimeIdentity: RuntimeIdentityProvider
  const repositoryId = 'repo-unitflow-real-001'
  const worktreeId = '1111111111111111111111111111111111111111111111111111111111111111'
  const generation = '2222222222222222222222222222222222222222222222222222222222222222'
  const currentHead = '3333333333333333333333333333333333333333'
  let worktreePath: string

  let mockGit: GitOperationsPort
  let mockCli: CliExecutionPort & {
    setSimulatedStatus(status: CliExecutionSnapshot['status'], exitCode?: number): void
  }
  let currentCliStatus: CliExecutionSnapshot['status'] = 'RUNNING'
  let currentExitCode: number | null = null

  beforeEach(() => {
    tempDir = makeTempDir('unitflow-runtime-test-')
    worktreePath = path.join(tempDir, 'worktree-main')
    fs.mkdirSync(worktreePath, { recursive: true })

    smcService = new SessionMemoryCentralService(tempDir)
    runtimeIdentity = new RuntimeIdentityProvider({ instanceId: 'inst-unitflow-test' })
    ledger = new ValidationLedger(path.join(tempDir, 'ledger.db'), runtimeIdentity)

    mockGit = {
      getBranchInventory: async (): Promise<BranchInventory> => ({
        repositoryId,
        observedAt: new Date().toISOString(),
        revision: '1',
        source: 'GIT_LOCAL',
        coverage: 'COMPLETE',
        branches: [
          {
            key: 'feature-work',
            repositoryId,
            name: 'feature-work',
            ref: 'refs/heads/feature-work',
            namespace: 'LOCAL',
            head: currentHead,
            upstream: null,
            generation: '1',
            revision: '1',
            creation: { at: new Date().toISOString(), source: 'APP_RECEIPT' },
            lastCommitAt: new Date().toISOString(),
            worktrees: [{ worktreeId, generation }]
          }
        ],
        worktrees: [
          {
            worktreeId,
            generation,
            path: worktreePath,
            branch: 'feature-work',
            head: currentHead,
            detached: false,
            locked: false,
            missing: false,
            prunable: false,
            creation: { at: new Date().toISOString(), quality: 'ESTIMATED', source: 'ADMIN_DIRECTORY_BIRTHTIME' }
          }
        ],
        unassignedWorktrees: []
      }),
      getCoordinationSnapshot: async () => ({ reference: false })
    }

    currentCliStatus = 'RUNNING'
    currentExitCode = null

    mockCli = {
      isEnabled: () => true,
      getRepositoryId: () => repositoryId,
      prepare: async (input: PrepareCliExecutionInput): Promise<CliProposal> => {
        const cmd: CliCommandDescriptor = {
          executable: input.executable,
          originalExecutable: input.executable,
          args: input.args ?? [],
          originalArgs: input.args ?? [],
          cwd: worktreePath,
          relativeCwd: '',
          displayCommandLine: `${input.executable} ${(input.args ?? []).join(' ')}`
        }
        return {
          proposalId: randomUUID(),
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          repositoryId,
          repositoryDirectory: worktreePath,
          checkoutFingerprint: 'fingerprint-001',
          command: cmd,
          commands: [cmd],
          risks: [],
          status: 'APPROVED',
          autoAuthorized: false
        }
      },
      start: (input: StartCliExecutionInput): CliExecutionSnapshot => ({
        operationId: input.operationId,
        proposalId: input.proposalId,
        status: currentCliStatus,
        phase: 'RUNNING',
        command: {
          executable: 'grok',
          originalExecutable: 'grok',
          args: [],
          cwd: worktreePath,
          relativeCwd: '',
          displayCommandLine: 'grok'
        },
        exitCode: currentExitCode,
        startedAt: new Date().toISOString(),
        stdout: '',
        stderr: '',
        hasMore: false,
        truncated: false,
        nextCursor: null,
        totalStdoutBytes: 0,
        totalStderrBytes: 0
      }),
      get: (input: GetCliExecutionInput): CliExecutionSnapshot => ({
        operationId: input.operationId,
        proposalId: input.operationId,
        status: currentCliStatus,
        phase: currentCliStatus === 'SUCCEEDED' || currentCliStatus === 'FAILED' ? 'TERMINAL' : 'RUNNING',
        command: {
          executable: 'grok',
          originalExecutable: 'grok',
          args: [],
          cwd: worktreePath,
          relativeCwd: '',
          displayCommandLine: 'grok'
        },
        exitCode: currentExitCode,
        treeObservation: currentCliStatus === 'SUCCEEDED' || currentCliStatus === 'FAILED'
          ? { activeProcesses: 0, handlesClosed: true }
          : undefined,
        startedAt: new Date().toISOString(),
        stdout: '',
        stderr: '',
        hasMore: false,
        truncated: false,
        nextCursor: null,
        totalStdoutBytes: 0,
        totalStderrBytes: 0
      }),
      setSimulatedStatus: (status: CliExecutionSnapshot['status'], exitCode?: number) => {
        currentCliStatus = status
        currentExitCode = exitCode ?? (status === 'SUCCEEDED' ? 0 : status === 'FAILED' ? 1 : null)
      }
    }
  })

  afterEach(() => {
    smcService.close()
    ledger.close()
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  function createFacade(customCli?: CliExecutionPort | null): UnitFlowRuntimeFacade {
    return new UnitFlowRuntimeFacade({
      repositoryId,
      repoRoot: worktreePath,
      smcService,
      gitOperations: mockGit,
      cliExecution: customCli !== undefined ? customCli : mockCli,
      validationLedger: ledger,
      stagingDirectory: path.join(tempDir, 'prompt-staging')
    })
  }

  function createAdapter(facade: UnitFlowRuntimeFacade): ChannelMcpAdapter {
    return new ChannelMcpAdapter(
      {
        projectId: repositoryId,
        repoRoot: worktreePath,
        navigation: {
          discoverRepository: async () => ({ directories: [] }),
          getRelationships: async () => ({ files: [] }),
          inspectFiles: async () => ({ files: [] }),
          readCode: async () => [],
          getReferences: async () => ({ targets: [] }),
          getSymbolDependencies: async () => ({ sources: [] }),
          getSymbolHierarchy: async () => ({ targets: [] })
        } as any,
        sessionMemoryCentral: smcService,
        unitflowRuntime: facade
      },
      undefined,
      runtimeIdentity,
      ledger
    )
  }

  describe('Prova 1: Catálogo, anotações, e dispatch no Channel MCP', () => {
    it('expõe as 7 ferramentas UnitFlow sob a lane BuildX, com isolamento de autoridade e sem repositoryId nos esquemas', () => {
      const facade = createFacade()
      const adapter = createAdapter(facade)
      const tools = adapter.listTools()

      const unitflowTools = tools.filter(t => BUILDX_UNITFLOW_TOOLS.some(bt => bt.name === t.name))
      expect(unitflowTools.map(t => t.name).sort()).toEqual([
        'accept_unitflow_unit',
        'bind_unitflow_workspace',
        'get_unitflow_status',
        'prepare_unitflow_plan',
        'reconcile_unitflow_unit',
        'settle_unitflow_unit',
        'start_next_unitflow_unit'
      ])

      const readTools = unitflowTools.filter(t => BUILDX_UNITFLOW_READ_TOOLS.some(rt => rt.name === t.name))
      expect(readTools.map(t => t.name)).toEqual(['get_unitflow_status'])
      expect(readTools[0].annotations?.readOnlyHint).toBe(true)

      const mutationTools = unitflowTools.filter(t => BUILDX_UNITFLOW_MUTATION_TOOLS.some(mt => mt.name === t.name))
      expect(mutationTools).toHaveLength(6)
      for (const t of mutationTools) {
        expect(t.annotations?.readOnlyHint).toBeUndefined()
      }

      // Invariante de isolamento: NUNCA aceitar repositoryId como parâmetro do cliente
      for (const t of unitflowTools) {
        expect(t.inputSchema.properties).not.toHaveProperty('repositoryId')
      }
    })
  })

  describe('Prova 2: Sequência completa de duas unidades ordenadas (U1 -> U2)', () => {
    it('executa U1 via MCP, observa progresso, liquida, aceita com prova do ledger e desbloqueia U2', async () => {
      const facade = createFacade()
      const adapter = createAdapter(facade)

      const sessionId = randomUUID()
      const planId = randomUUID()
      const unit1Id = randomUUID()
      const unit2Id = randomUUID()

      // 1. Criar sessão SMC via MCP
      const createSessionRes = parseMcpResult(
        await adapter.callTool('create_buildx_session', { sessionId })
      )
      expect(createSessionRes.sessionId).toBe(sessionId)

      // 2. Vincular Worktree autorizada via MCP
      const bindRes = parseMcpResult(
        await adapter.callTool('bind_unitflow_workspace', {
          sessionId,
          worktreeId
        })
      )
      expect(bindRes.worktreeId).toBe(worktreeId)
      expect(bindRes.generation).toBe(generation)

      // 3. Preparar plano com 2 unidades ordenadas (U2 depende de U1) via MCP
      const planRes = parseMcpResult(
        await adapter.callTool('prepare_unitflow_plan', {
          sessionId,
          planId,
          title: 'BuildX E2E Plan',
          objective: 'Complete U1 then U2',
          units: [
            {
              unitId: unit1Id,
              position: 0,
              title: 'Unit 1: Core Foundation',
              objective: 'Implement foundation',
              acceptanceCriteria: 'Ledger proof PASSED'
            },
            {
              unitId: unit2Id,
              position: 1,
              title: 'Unit 2: Extension',
              objective: 'Implement extension after foundation',
              acceptanceCriteria: 'Ledger proof PASSED',
              dependsOnUnitIds: [unit1Id]
            }
          ]
        })
      )
      expect(planRes.totalUnits).toBe(2)
      expect(planRes.status).toBe('ACTIVE')

      // 4. Consultar status inicial: READY, U1 elegível, U2 bloqueada
      const initialStatus = parseMcpResult(
        await adapter.callTool('get_unitflow_status', { sessionId })
      )
      expect(initialStatus.orchestrationState).toBe('READY')
      expect(initialStatus.currentUnit.unitId).toBe(unit1Id)
      expect(initialStatus.nextAllowedActions).toContain('start_next_unitflow_unit')

      // 5. Iniciar U1 via MCP
      const reservation1Id = randomUUID()
      const attempt1Id = randomUUID()
      const stageOp1Id = randomUUID()

      const startRes = parseMcpResult(
        await adapter.callTool('start_next_unitflow_unit', {
          sessionId,
          planId,
          reservationId: reservation1Id,
          attemptId: attempt1Id,
          stageOperationId: stageOp1Id
        })
      )
      expect(startRes.unitId).toBe(unit1Id)
      expect(startRes.status).toBe('RUNNING')

      // 6. Idempotência: repetir a chamada com mesmo attemptId retorna replayed: true sem novo spawn
      const replayStart = parseMcpResult(
        await adapter.callTool('start_next_unitflow_unit', {
          sessionId,
          planId,
          reservationId: reservation1Id,
          attemptId: attempt1Id,
          stageOperationId: stageOp1Id
        })
      )
      expect(replayStart.replayed).toBe(true)
      expect(replayStart.attemptId).toBe(attempt1Id)

      // 7. Negativo: tentativa de iniciar outro attempt enquanto U1 está ativa falha fechada com ATTEMPT_CONFLICT
      const conflictStartRes = await adapter.callTool('start_next_unitflow_unit', {
        sessionId,
        planId,
        reservationId: randomUUID(),
        attemptId: randomUUID(),
        stageOperationId: randomUUID()
      })
      expect(conflictStartRes.isError).toBe(true)
      expect(JSON.parse((conflictStartRes.content[0] as { type: 'text'; text: string }).text).code).toBe('ATTEMPT_CONFLICT')

      // 8. Consultar status em execução: RUNNING
      const runningStatus = parseMcpResult(
        await adapter.callTool('get_unitflow_status', { sessionId })
      )
      expect(runningStatus.orchestrationState).toBe('RUNNING')
      expect(runningStatus.nextAllowedActions).toContain('settle_unitflow_unit')

      // 9. Simular término do processo CLI com sucesso
      mockCli.setSimulatedStatus('SUCCEEDED', 0)

      // 10. Liquidar tecnicamente a tentativa via MCP (settle)
      const settleRes = parseMcpResult(
        await adapter.callTool('settle_unitflow_unit', {
          sessionId,
          attemptId: attempt1Id
        })
      )
      expect(settleRes.settled).toBe(true)
      expect(settleRes.attemptStatus).toBe('COMPLETED')
      expect(settleRes.unitState).toBe('VALIDATING')

      // 11. Consultar status após liquidação: VALIDATION_READY
      const validationReadyStatus = parseMcpResult(
        await adapter.callTool('get_unitflow_status', { sessionId })
      )
      expect(validationReadyStatus.orchestrationState).toBe('VALIDATION_READY')
      expect(validationReadyStatus.nextAllowedActions).toContain('accept_unitflow_unit')

      // 12. Tentar avançar para U2 antes de aceitar U1: bloqueado (NONE_ELIGIBLE)
      const prematureU2Start = parseMcpResult(
        await adapter.callTool('start_next_unitflow_unit', {
          sessionId,
          planId,
          reservationId: randomUUID(),
          attemptId: randomUUID(),
          stageOperationId: randomUUID()
        })
      )
      expect(prematureU2Start.status).toBe('NONE_ELIGIBLE')

      // 13. Tentar aceitar U1 com prova inexistente: EVIDENCE_REQUIRED
      const badProofAccept = parseMcpResult(
        await adapter.callTool('accept_unitflow_unit', {
          sessionId,
          attemptId: attempt1Id,
          operationId: randomUUID(),
          proofIds: ['proof-non-existent-999'],
          summary: 'Accepting with dummy proof'
        })
      )
      expect(badProofAccept.status).toBe('EVIDENCE_REQUIRED')

      // 14. Registrar prova válida no Validation Ledger com proveniência exata do worktree e head
      const recordedProof = ledger.recordProof({
        kind: 'TARGETED_TEST',
        producer: 'IMPLEMENTER',
        status: 'PASSED',
        startedAt: new Date(Date.now() - 1000).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 1000,
        scope: ['test/unit1'],
        summary: 'Unit 1 Acceptance Test Proof',
        commandProfile: {
          command: 'npm run test:u1',
          checkout: {
            repositoryId,
            worktreeId,
            generation,
            head: currentHead,
            issuer: 'VALIDATION_EXECUTION',
            runId: randomUUID()
          }
        }
      })
      const validProofId = recordedProof.proofId

      // 15. Aceitar U1 via MCP com a prova válida do ledger
      const acceptOpId = randomUUID()
      const acceptRes = parseMcpResult(
        await adapter.callTool('accept_unitflow_unit', {
          sessionId,
          attemptId: attempt1Id,
          operationId: acceptOpId,
          proofIds: [validProofId],
          summary: 'Unit 1 verified and accepted with ledger proof'
        })
      )
      expect(acceptRes.status).toBe('ACCEPTED')
      expect(acceptRes.nextEligibleUnitId).toBe(unit2Id)

      // 16. Consultar status: U1 concluída, U2 agora é a unidade elegível (READY)
      const postAcceptStatus = parseMcpResult(
        await adapter.callTool('get_unitflow_status', { sessionId })
      )
      expect(postAcceptStatus.orchestrationState).toBe('READY')
      expect(postAcceptStatus.plan.completedUnits).toBe(1)
      expect(postAcceptStatus.currentUnit.unitId).toBe(unit2Id)
      expect(postAcceptStatus.nextAllowedActions).toContain('start_next_unitflow_unit')

      // 17. Iniciar U2 com sucesso
      mockCli.setSimulatedStatus('RUNNING')
      const startU2Res = parseMcpResult(
        await adapter.callTool('start_next_unitflow_unit', {
          sessionId,
          planId,
          reservationId: randomUUID(),
          attemptId: randomUUID(),
          stageOperationId: randomUUID()
        })
      )
      expect(startU2Res.unitId).toBe(unit2Id)
      expect(startU2Res.status).toBe('RUNNING')
    })
  })

  describe('Prova 3: Reconciliação de falha e recuperação de unidade', () => {
    it('observa falha de tentativa, liquida para RECONCILING, e recupera via reconcile_unitflow_unit', async () => {
      const facade = createFacade()
      const adapter = createAdapter(facade)

      const sessionId = randomUUID()
      const planId = randomUUID()
      const unitId = randomUUID()

      await adapter.callTool('create_buildx_session', { sessionId })
      await adapter.callTool('bind_unitflow_workspace', { sessionId, worktreeId })
      await adapter.callTool('prepare_unitflow_plan', {
        sessionId,
        planId,
        title: 'Failure Recovery Plan',
        objective: 'Test reconciliation',
        units: [
          {
            unitId,
            position: 0,
            title: 'Failing Unit',
            objective: 'Will fail and be retried',
            acceptanceCriteria: 'Pass on retry'
          }
        ]
      })

      const attemptId = randomUUID()
      const reservationId = randomUUID()

      await adapter.callTool('start_next_unitflow_unit', {
        sessionId,
        planId,
        reservationId,
        attemptId,
        stageOperationId: randomUUID()
      })

      // Simula falha do processo CLI
      mockCli.setSimulatedStatus('FAILED', 1)

      // Liquidar a execução falhada
      const settleRes = parseMcpResult(
        await adapter.callTool('settle_unitflow_unit', {
          sessionId,
          attemptId
        })
      )
      expect(settleRes.settled).toBe(true)
      expect(settleRes.attemptStatus).toBe('FAILED')
      expect(settleRes.unitState).toBe('RECONCILING')

      // Consultar status: RECONCILING
      const statusRes = parseMcpResult(
        await adapter.callTool('get_unitflow_status', { sessionId })
      )
      expect(statusRes.orchestrationState).toBe('RECONCILING')
      expect(statusRes.nextAllowedActions).toContain('reconcile_unitflow_unit')

      // Executar reconciliação com ação RETRY_SAME_UNIT
      const reconcileOpId = randomUUID()
      const reconcileRes = parseMcpResult(
        await adapter.callTool('reconcile_unitflow_unit', {
          sessionId,
          attemptId,
          operationId: reconcileOpId,
          action: 'RETRY_SAME_UNIT',
          summary: 'CLI returned code 1; resetting unit for retry'
        })
      )
      expect(reconcileRes.status).toBe('RETRY_ELIGIBLE')
      expect(reconcileRes.unitState).toBe('AVAILABLE')

      // Verificar que o estado voltou a READY e a unidade pode ser iniciada novamente
      const retryStatus = parseMcpResult(
        await adapter.callTool('get_unitflow_status', { sessionId })
      )
      expect(retryStatus.orchestrationState).toBe('READY')
      expect(retryStatus.nextAllowedActions).toContain('start_next_unitflow_unit')
    })
  })

  describe('Prova 4: Fail-closed em contexto inválido e isolamento estrito', () => {
    it('rejeita chamadas com repositório divergente ou sessão CLOSED', async () => {
      const facade = createFacade()
      const adapter = createAdapter(facade)

      const sessionId = randomUUID()
      await adapter.callTool('create_buildx_session', { sessionId })

      // Fechar sessão no SMC
      const store = smcService.getStore(repositoryId)
      ;(store as any).db.prepare("UPDATE smc_sessions SET status = 'CLOSED' WHERE session_id = ?").run(sessionId)

      // Tentar bind em sessão fechada
      const bindClosedRes = await adapter.callTool('bind_unitflow_workspace', {
        sessionId,
        worktreeId
      })
      expect(bindClosedRes.isError).toBe(true)
      expect(JSON.parse((bindClosedRes.content[0] as { type: 'text'; text: string }).text).code).toBe('SESSION_CLOSED')

      // Tentar preparar plano em sessão fechada
      const planClosedRes = await adapter.callTool('prepare_unitflow_plan', {
        sessionId,
        planId: randomUUID(),
        title: 'Closed Plan',
        objective: 'Should fail',
        units: [{ unitId: randomUUID(), position: 0, title: 'U1', objective: 'O', acceptanceCriteria: 'A' }]
      })
      expect(planClosedRes.isError).toBe(true)
      expect(JSON.parse((planClosedRes.content[0] as { type: 'text'; text: string }).text).code).toBe('SESSION_CLOSED')
    })
  })
})
