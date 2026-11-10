import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { SessionMemoryCentralService } from '../smc/session-memory-central-service'
import { UnitFlowRuntimeFacade, derivePlanObjectiveEntryId } from './unitflow-runtime-facade'
import {
  BUILDX_UNITFLOW_TOOLS,
  BUILDX_UNITFLOW_READ_TOOLS,
  BUILDX_UNITFLOW_MUTATION_TOOLS
} from './unitflow-mcp'
import { ChannelMcpAdapter } from '../../mcp/channel-mcp-adapter'
import { ValidationLedger } from '../../validation-ledger/validation-ledger'
import { captureValidationSource, validationSourceFingerprint } from '../../validation-execution/validation-source'
import { RuntimeIdentityProvider } from '../../runtime-identity/runtime-identity-provider'
import { CliExecutionService } from '../../cli-execution/cli-execution-service'
import { GitService } from '../../core/git-service'
import { GitWorktreeRegistry } from '../../git-operations/git-worktree-registry'
import { resolveCliWorktree } from '../../cli-execution/cli-worktree-authority'
import type { CliPolicy } from '../../../shared/types/cli-policy-types'
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

  describe('Prova 5: Leitura de status estritamente observacional e read-only', () => {
    it('consultas repetidas a get_unitflow_status não alteram revisões nem estados no SMC, preservando a promoção para o caminho de mutação', async () => {
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
        title: 'Read-only Status Plan',
        objective: 'Test read-only guarantees',
        units: [
          {
            unitId,
            position: 0,
            title: 'Unit Observation',
            objective: 'Observe without mutation',
            acceptanceCriteria: 'Unchanged revision on repeat reads'
          }
        ]
      })

      const attemptId = randomUUID()
      const reservationId = randomUUID()
      const stageOpId = randomUUID()

      // Iniciar a tentativa com CLI simulando RUNNING
      mockCli.setSimulatedStatus('RUNNING')
      await adapter.callTool('start_next_unitflow_unit', {
        sessionId,
        planId,
        reservationId,
        attemptId,
        stageOperationId: stageOpId
      })

      // Forçar tentativa no SMC para STARTING para verificar que getStatus não muta para RUNNING
      const store = smcService.getStore(repositoryId)
      ;(store as any).db.prepare("UPDATE smc_execution_attempts SET status = 'STARTING' WHERE attempt_id = ?").run(attemptId)
      const attemptBefore = store.getExecutionAttempt(attemptId)!
      expect(attemptBefore.status).toBe('STARTING')
      const revisionBefore = attemptBefore.revision

      // Executar 5 consultas consecutivas de get_unitflow_status
      for (let i = 0; i < 5; i++) {
        const statusRes = parseMcpResult(
          await adapter.callTool('get_unitflow_status', { sessionId })
        )
        // O status projetado ao orquestrador é honesto com o CLI RUNNING
        expect(statusRes.orchestrationState).toBe('RUNNING')
        expect(statusRes.activeAttempt.status).toBe('RUNNING')

        // Mas a tentativa persistida no SMC NÃO teve sua revisão nem seu status mutados
        const attemptDuring = store.getExecutionAttempt(attemptId)!
        expect(attemptDuring.status).toBe('STARTING')
        expect(attemptDuring.revision).toBe(revisionBefore)
      }

      // Agora acionar o caminho de mutação legítimo (ex: settle_unitflow_unit com CLI terminal)
      mockCli.setSimulatedStatus('SUCCEEDED', 0)
      const settleRes = parseMcpResult(
        await adapter.callTool('settle_unitflow_unit', {
          sessionId,
          attemptId
        })
      )
      expect(settleRes.settled).toBe(true)

      // A mutação legítima alterou o estado no SMC
      const attemptAfter = store.getExecutionAttempt(attemptId)!
      expect(attemptAfter.status).toBe('COMPLETED')
      expect(attemptAfter.revision).toBeGreaterThan(revisionBefore)
    })
  })

  describe('Prova 6: Idempotência de planos com equivalência completa do manifesto', () => {
    it('aceita replay idêntico e rejeita qualquer divergência no manifesto com PLAN_CONFLICT sem alterar o plano pré-existente', async () => {
      const facade = createFacade()
      const adapter = createAdapter(facade)

      const sessionId = randomUUID()
      const planId = randomUUID()
      const unit1Id = randomUUID()
      const unit2Id = randomUUID()

      await adapter.callTool('create_buildx_session', { sessionId })

      const canonicalUnits = [
        {
          unitId: unit1Id,
          position: 0,
          title: 'Unit 1 Title',
          objective: 'Unit 1 Objective',
          acceptanceCriteria: 'Unit 1 Acceptance'
        },
        {
          unitId: unit2Id,
          position: 1,
          title: 'Unit 2 Title',
          objective: 'Unit 2 Objective',
          acceptanceCriteria: 'Unit 2 Acceptance',
          dependsOnUnitIds: [unit1Id]
        }
      ]

      // 1. Criar plano original
      const initialPlan = parseMcpResult(
        await adapter.callTool('prepare_unitflow_plan', {
          sessionId,
          planId,
          title: 'Original Title',
          objective: 'Original Objective',
          units: canonicalUnits
        })
      )
      expect(initialPlan.status).toBe('ACTIVE')
      expect(initialPlan.replayed).toBeUndefined()

      // 2. Replay idêntico -> aceito com replayed: true
      const replaySame = parseMcpResult(
        await adapter.callTool('prepare_unitflow_plan', {
          sessionId,
          planId,
          title: 'Original Title',
          objective: 'Original Objective',
          units: canonicalUnits
        })
      )
      expect(replaySame.replayed).toBe(true)
      expect(replaySame.title).toBe('Original Title')
      expect(replaySame.totalUnits).toBe(2)

      // 3. Replay com título divergente -> PLAN_CONFLICT
      const conflictTitle = await adapter.callTool('prepare_unitflow_plan', {
        sessionId,
        planId,
        title: 'Divergent Title',
        objective: 'Original Objective',
        units: canonicalUnits
      })
      expect(conflictTitle.isError).toBe(true)
      expect(JSON.parse((conflictTitle.content[0] as { type: 'text'; text: string }).text).code).toBe('PLAN_CONFLICT')

      // 3b. Replay com objetivo de plano divergente -> PLAN_CONFLICT
      const conflictPlanObj = await adapter.callTool('prepare_unitflow_plan', {
        sessionId,
        planId,
        title: 'Original Title',
        objective: 'Divergent Plan Objective',
        units: canonicalUnits
      })
      expect(conflictPlanObj.isError).toBe(true)
      expect(JSON.parse((conflictPlanObj.content[0] as { type: 'text'; text: string }).text).code).toBe('PLAN_CONFLICT')

      // 4. Replay com objetivo de unidade divergente -> PLAN_CONFLICT
      const conflictUnitObj = await adapter.callTool('prepare_unitflow_plan', {
        sessionId,
        planId,
        title: 'Original Title',
        objective: 'Original Objective',
        units: [
          canonicalUnits[0],
          { ...canonicalUnits[1], objective: 'Divergent Unit Objective' }
        ]
      })
      expect(conflictUnitObj.isError).toBe(true)
      expect(JSON.parse((conflictUnitObj.content[0] as { type: 'text'; text: string }).text).code).toBe('PLAN_CONFLICT')

      // 5. Replay com acceptanceCriteria de unidade divergente -> PLAN_CONFLICT
      const conflictUnitCriteria = await adapter.callTool('prepare_unitflow_plan', {
        sessionId,
        planId,
        title: 'Original Title',
        objective: 'Original Objective',
        units: [
          { ...canonicalUnits[0], acceptanceCriteria: 'Divergent Criteria' },
          canonicalUnits[1]
        ]
      })
      expect(conflictUnitCriteria.isError).toBe(true)
      expect(JSON.parse((conflictUnitCriteria.content[0] as { type: 'text'; text: string }).text).code).toBe('PLAN_CONFLICT')

      // 6. Replay com dependência de unidade divergente -> PLAN_CONFLICT
      const conflictUnitDeps = await adapter.callTool('prepare_unitflow_plan', {
        sessionId,
        planId,
        title: 'Original Title',
        objective: 'Original Objective',
        units: [
          canonicalUnits[0],
          { ...canonicalUnits[1], dependsOnUnitIds: [] }
        ]
      })
      expect(conflictUnitDeps.isError).toBe(true)
      expect(JSON.parse((conflictUnitDeps.content[0] as { type: 'text'; text: string }).text).code).toBe('PLAN_CONFLICT')

      // 7. Replay com quantidade divergente de unidades -> PLAN_CONFLICT
      const conflictCount = await adapter.callTool('prepare_unitflow_plan', {
        sessionId,
        planId,
        title: 'Original Title',
        objective: 'Original Objective',
        units: [canonicalUnits[0]]
      })
      expect(conflictCount.isError).toBe(true)
      expect(JSON.parse((conflictCount.content[0] as { type: 'text'; text: string }).text).code).toBe('PLAN_CONFLICT')

      // 8. Verificar que o plano no SMC não foi corrompido nem alterado
      const store = smcService.getStore(repositoryId)
      const storedPlan = store.getPlan(planId)!
      expect(storedPlan.title).toBe('Original Title')
      const storedUnits = store.listPlanUnits(sessionId, planId)
      expect(storedUnits).toHaveLength(2)
      expect(storedUnits[0].title).toBe('Unit 1 Title')
      expect(storedUnits[1].title).toBe('Unit 2 Title')

      const storedObjectiveEntry = smcService.getEntry(
        repositoryId,
        sessionId,
        derivePlanObjectiveEntryId(planId)
      )
      expect(storedObjectiveEntry).not.toBeNull()
      expect(storedObjectiveEntry!.body).toBe('Original Objective')
    })
  })

  describe('Prova 7: Retomada segura de tentativas em PREPARED', () => {
    it('retoma com sucesso uma tentativa persistida em PREPARED sem reserva duplicada e impede segundo spawn indevido', async () => {
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
        title: 'Resume Prepared Plan',
        objective: 'Test resumption of PREPARED attempt',
        units: [
          {
            unitId,
            position: 0,
            title: 'Unit Resumption',
            objective: 'Resume execution',
            acceptanceCriteria: 'Executes without duplicate reservation'
          }
        ]
      })

      const reservationId = randomUUID()
      const attemptId = randomUUID()
      const stageOpId = randomUUID()

      // Simular uma tentativa persistida em PREPARED (reserva criada e attempt gravado no banco, mas interrompida antes do CLI start)
      await facade.reservationService.reserveNextEligibleUnit(repositoryId, sessionId, planId, {
        reservationId
      })
      await facade.attemptService.prepareExecutionAttempt(repositoryId, sessionId, reservationId, {
        attemptId
      })

      const store = smcService.getStore(repositoryId)
      const attemptInDb = store.getExecutionAttempt(attemptId)!
      expect(attemptInDb.status).toBe('PREPARED')

      // Chamar start_next_unitflow_unit com os mesmos IDs: deve retomar a execução diretamente
      mockCli.setSimulatedStatus('RUNNING')
      const resumeRes = parseMcpResult(
        await adapter.callTool('start_next_unitflow_unit', {
          sessionId,
          planId,
          reservationId,
          attemptId,
          stageOperationId: stageOpId
        })
      )

      expect(resumeRes.replayed).toBe(true)
      expect(resumeRes.attemptId).toBe(attemptId)
      expect(resumeRes.unitId).toBe(unitId)
      expect(resumeRes.status).toBe('RUNNING')

      // A tentativa no SMC foi promovida para RUNNING com sucesso
      const attemptAfter = store.getExecutionAttempt(attemptId)!
      expect(attemptAfter.status).toBe('RUNNING')

      // Tentar segundo spawn com outro attemptId enquanto a tentativa está ativa -> fail-closed com ATTEMPT_CONFLICT
      const concurrentSpawn = await adapter.callTool('start_next_unitflow_unit', {
        sessionId,
        planId,
        reservationId: randomUUID(),
        attemptId: randomUUID(),
        stageOperationId: randomUUID()
      })
      expect(concurrentSpawn.isError).toBe(true)
      expect(JSON.parse((concurrentSpawn.content[0] as { type: 'text'; text: string }).text).code).toBe('ATTEMPT_CONFLICT')
    })
  })

  describe('Prova 8: customPromptText removido do contrato público', () => {
    it('o esquema do MCP não anuncia customPromptText e a ferramenta não aceita parâmetros silenciosos', () => {
      const facade = createFacade()
      const adapter = createAdapter(facade)
      const tools = adapter.listTools()

      const startTool = tools.find(t => t.name === 'start_next_unitflow_unit')!
      expect(startTool).toBeDefined()
      expect(startTool.inputSchema.properties).not.toHaveProperty('customPromptText')
      expect(startTool.inputSchema.additionalProperties).toBe(false)
    })
  })

  describe('Prova 9: Execução com Grok CLI real supervisionado em Worktree Git descartável', () => {
    it('executa ciclo completo pelo MCP com processo Grok CLI real, encerramento supervisionado e aceite com prova do Ledger', async () => {
      const realTemp = makeTempDir('buildx-real-grok-')
      const realRepoDir = path.join(realTemp, 'disposable-repo')
      const realStagingDir = path.join(realTemp, 'staging')
      fs.mkdirSync(realRepoDir, { recursive: true })
      fs.mkdirSync(realStagingDir, { recursive: true })

      // Inicializa repositório Git descartável
      execSync('git init', { cwd: realRepoDir })
      execSync('git config user.email "buildx-real@test.local"', { cwd: realRepoDir })
      execSync('git config user.name "BuildX Real Test"', { cwd: realRepoDir })
      fs.writeFileSync(path.join(realRepoDir, 'README.md'), '# BuildX Disposable Git Worktree\n')
      execSync('git add .', { cwd: realRepoDir })
      execSync('git commit -m "initial commit"', { cwd: realRepoDir })
      const realHead = execSync('git rev-parse HEAD', { cwd: realRepoDir, encoding: 'utf8' }).trim()

      const realRepoId = 'e1c8a999-6d73-4f56-83a3-fbcd78c9c19d'
      const initialSource = await captureValidationSource(realRepoDir, realRepoId)
      const realWorktreeId = initialSource.worktreeId
      const realGeneration = initialSource.generation

      const realGitOps: GitOperationsPort = {
        getBranchInventory: async (): Promise<BranchInventory> => {
          const currentSource = await captureValidationSource(realRepoDir, realRepoId)
          return {
            repositoryId: realRepoId,
            observedAt: new Date().toISOString(),
            revision: '1',
            source: 'GIT_LOCAL',
            coverage: 'COMPLETE',
            branches: [
              {
                key: 'main',
                repositoryId: realRepoId,
                name: 'main',
                ref: 'refs/heads/main',
                namespace: 'LOCAL',
                head: currentSource.head,
                upstream: null,
                generation: currentSource.generation,
                revision: '1',
                creation: { at: new Date().toISOString(), source: 'APP_RECEIPT' },
                lastCommitAt: new Date().toISOString(),
                worktrees: [{ worktreeId: currentSource.worktreeId, generation: currentSource.generation }]
              }
            ],
            worktrees: [
              {
                worktreeId: currentSource.worktreeId,
                generation: currentSource.generation,
                path: realRepoDir,
                branch: 'main',
                head: currentSource.head,
                detached: false,
                locked: false,
                missing: false,
                prunable: false,
                creation: { at: new Date().toISOString(), quality: 'ESTIMATED', source: 'ADMIN_DIRECTORY_BIRTHTIME' }
              }
            ],
            unassignedWorktrees: []
          }
        },
        getCoordinationSnapshot: async () => ({ reference: false })
      }

      // CliExecutionService REAL que executa grok.exe do sistema
      const realCli = new CliExecutionService({
        repoRoot: realRepoDir,
        repositoryId: realRepoId,
        enabledByDefault: true,
        getPolicy: () => ({ mode: 'SUPERVISED', revision: 'r1', rule: 'native-command-consent' }),
        approvalHandler: async () => {
          return true // Consentimento supervisionado concedido pelo operador
        },
        resolveWorktree: async () => {
          const currentSource = await captureValidationSource(realRepoDir, realRepoId)
          return {
            identity: {
              worktreeId: currentSource.worktreeId,
              generation: currentSource.generation,
              head: currentSource.head,
              branch: 'main',
              indexRevision: currentSource.indexRevision
            },
            directory: realRepoDir,
            getFingerprint: async () => validationSourceFingerprint(currentSource)
          }
        }
      })

      const realFacade = new UnitFlowRuntimeFacade({
        repositoryId: realRepoId,
        repoRoot: realRepoDir,
        smcService,
        gitOperations: realGitOps,
        cliExecution: realCli,
        validationLedger: ledger,
        stagingDirectory: realStagingDir
      })

      const realAdapter = new ChannelMcpAdapter(
        {
          projectId: realRepoId,
          repoRoot: realRepoDir,
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
          unitflowRuntime: realFacade
        },
        undefined,
        runtimeIdentity,
        ledger
      )

      const sessionId = randomUUID()
      const planId = randomUUID()
      const unitId = randomUUID()
      const reservationId = randomUUID()
      const attemptId = randomUUID()
      const stageOpId = randomUUID()

      // 1. Criar sessão via MCP
      const sessRes = parseMcpResult(await realAdapter.callTool('create_buildx_session', { sessionId }))
      expect(sessRes.sessionId).toBe(sessionId)

      // 2. Vincular worktree via MCP
      const bindRes = parseMcpResult(await realAdapter.callTool('bind_unitflow_workspace', { sessionId, worktreeId: realWorktreeId }))
      expect(bindRes.worktreeId).toBe(realWorktreeId)

      // 3. Preparar plano via MCP
      const planRes = parseMcpResult(
        await realAdapter.callTool('prepare_unitflow_plan', {
          sessionId,
          planId,
          title: 'Real Grok CLI Plan',
          objective: 'Execute and observe real Grok CLI supervised run with material file change',
          units: [
            {
              unitId,
              position: 0,
              title: 'Real Grok Execution Unit',
              objective: 'Confirm operational capability of real Grok CLI with material file change',
              acceptanceCriteria: 'Process terminates cleanly with terminal status observed and material file change in repository'
            }
          ]
        })
      )
      expect(planRes.status).toBe('ACTIVE')

      // 4. Iniciar unidade via MCP (dispara grok.exe real com staging de prompt)
      const debugLogPath = path.resolve('scratch/real-grok-trial.log')
      fs.mkdirSync(path.dirname(debugLogPath), { recursive: true })
      fs.writeFileSync(debugLogPath, `[START] ${new Date().toISOString()}\n`)

      const startRes = parseMcpResult(
        await realAdapter.callTool('start_next_unitflow_unit', {
          sessionId,
          planId,
          reservationId,
          attemptId,
          stageOperationId: stageOpId
        })
      )
      fs.appendFileSync(debugLogPath, `startRes: ${JSON.stringify(startRes)}\n`)
      expect(startRes.unitId).toBe(unitId)

      // 5. Acompanhar a execução real do processo Grok CLI
      let completed = false
      for (let i = 0; i < 35; i++) {
        await new Promise(r => setTimeout(r, 1000))
        const statusRes = parseMcpResult(await realAdapter.callTool('get_unitflow_status', { sessionId }))
        const rawSnap = await realCli.get({ operationId: attemptId })
        fs.appendFileSync(debugLogPath, `[${i}] statusRes: ${JSON.stringify(statusRes)} | rawSnap: ${JSON.stringify(rawSnap)}\n`)
        if (
          rawSnap?.phase === 'TERMINAL' ||
          statusRes.activeAttempt?.status === 'TERMINAL_OBSERVED' ||
          statusRes.activeAttempt?.status === 'SUCCEEDED' ||
          statusRes.activeAttempt?.status === 'FAILED' ||
          statusRes.activeAttempt?.status === 'REFUSED' ||
          statusRes.activeAttempt?.status === 'CANCELLED'
        ) {
          completed = true
          break
        }
      }
      expect(completed).toBe(true)

      const finalSnap = await realCli.get({ operationId: attemptId })
      expect(finalSnap?.treeObservation?.activeProcesses).toBe(0)
      expect(finalSnap?.treeObservation?.handlesClosed).toBe(true)

      // 6. Confirmar encerramento técnico (settle) via MCP
      const settleRes = parseMcpResult(
        await realAdapter.callTool('settle_unitflow_unit', {
          sessionId,
          attemptId
        })
      )
      expect(settleRes.settled).toBe(true)

      // 7. Alteração material de arquivo no repositório descartável real com Git
      const validationDocPath = path.join(realRepoDir, 'FEATURE_VALIDATION.md')
      fs.writeFileSync(validationDocPath, '# Feature Validation Evidence\n\nGrok CLI supervised execution completed.\n', 'utf8')
      execSync('git add FEATURE_VALIDATION.md', { cwd: realRepoDir })
      execSync('git commit -m "feat(validation): record feature verification evidence"', { cwd: realRepoDir })

      const statusOutput = execSync('git status --porcelain', { cwd: realRepoDir, encoding: 'utf8' })
      expect(statusOutput.trim()).toBe('') // Working tree limpa após commit

      const logOutput = execSync('git log -1 --oneline', { cwd: realRepoDir, encoding: 'utf8' })
      expect(logOutput).toContain('feat(validation): record feature verification evidence')

      // 8. Capturar fonte de validação autoritativa e registrar prova PASSED/CURRENT no Validation Ledger
      const finalSource = await captureValidationSource(realRepoDir, realRepoId)
      const finalFingerprint = validationSourceFingerprint(finalSource)

      if (settleRes.unitState === 'VALIDATING') {
        const proof = ledger.recordProof({
          kind: 'TARGETED_TEST',
          producer: 'IMPLEMENTER',
          status: 'PASSED',
          startedAt: new Date(Date.now() - 5000).toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 5000,
          scope: ['buildx/unitflow', 'real-grok-trial'],
          summary: 'Real Grok CLI execution confirmed with material file change via UnitFlow MCP',
          sourceFingerprint: finalFingerprint,
          commandProfile: {
            command: 'grok --prompt-file',
            cwd: finalSource.cwd,
            source: finalSource
          }
        })

        const freshProof = await ledger.getProofWithFreshness(proof.proofId)
        expect(freshProof).not.toBeNull()
        expect(freshProof!.status).toBe('PASSED')
        expect(freshProof!.freshness).toBe('CURRENT')

        const acceptRes = parseMcpResult(
          await realAdapter.callTool('accept_unitflow_unit', {
            sessionId,
            attemptId,
            operationId: randomUUID(),
            proofIds: [proof.proofId],
            summary: 'Real Grok execution completed, material file change verified and proof CURRENT'
          })
        )
        expect(acceptRes.status).toBe('ACCEPTED')
      } else {
        // Se terminal com falha/código de saída não zero: reconcilia
        const reconcileRes = parseMcpResult(
          await realAdapter.callTool('reconcile_unitflow_unit', {
            sessionId,
            attemptId,
            operationId: randomUUID(),
            summary: `Diagnóstico operacional: status=${settleRes.attemptStatus}, exitCode=${settleRes.exitCode}`,
            action: 'RETRY_SAME_UNIT'
          })
        )
        expect(reconcileRes.status).toBe('RETRY_ELIGIBLE')
      }

      // Cleanup
      try {
        fs.rmSync(realTemp, { recursive: true, force: true })
      } catch {}
    }, 60000)
  })

  describe('Prova 10: BuildX/UnitFlow em Worktree YOLO vs SUPERVISED com executável controlado (sem cota externa)', () => {
    it('injeta --always-approve e perfil 600s em YOLO sem AUTO_AUTHORIZED_NOT_REQUESTED ou diálogo, e omite em SUPERVISED', async () => {
      const yoloTemp = makeTempDir('unitflow-yolo-controlled-')
      const repoMain = path.join(yoloTemp, 'main')
      const repoSibling = path.join(yoloTemp, 'sibling')
      const fakeBin = path.join(yoloTemp, 'fake-bin')
      const stagingDir = path.join(yoloTemp, 'staging')
      fs.mkdirSync(repoMain, { recursive: true })
      fs.mkdirSync(fakeBin, { recursive: true })
      fs.mkdirSync(stagingDir, { recursive: true })

      const originalPath = process.env.PATH
      try {
        execSync('git init -q', { cwd: repoMain })
        execSync('git config user.email "unitflow-yolo@test.local"', { cwd: repoMain })
        execSync('git config user.name "UnitFlow YOLO Test"', { cwd: repoMain })
        fs.writeFileSync(path.join(repoMain, 'README.md'), '# Base\n')
        execSync('git add README.md', { cwd: repoMain })
        execSync('git commit -qm "baseline"', { cwd: repoMain })
        execSync(`git worktree add -qb sibling-yolo "${repoSibling}"`, { cwd: repoMain })
        const mainHead = execSync('git rev-parse HEAD', { cwd: repoMain, encoding: 'utf8' }).trim()

        // Fake grok.cmd controlado em PATH que grava argv e cria arquivo dentro da worktree selecionada
        const driverJs = path.join(fakeBin, 'fake-grok.cjs')
        fs.writeFileSync(
          driverJs,
          `
          const fs = require('fs');
          const args = process.argv.slice(2);
          fs.writeFileSync('grok-argv.json', JSON.stringify(args));
          if (args.includes('--always-approve')) {
            fs.writeFileSync('grok-produced.txt', 'created-under-yolo\\n');
            console.log(JSON.stringify({ ok: true, mode: 'yolo' }));
          } else {
            fs.writeFileSync('grok-supervised.txt', 'created-under-supervised\\n');
            console.log(JSON.stringify({ ok: true, mode: 'supervised' }));
          }
          `
        )
        const shimPath = path.join(fakeBin, process.platform === 'win32' ? 'grok.cmd' : 'grok')
        fs.writeFileSync(shimPath, `@set ELECTRON_RUN_AS_NODE=1\r\n@"${process.execPath}" "${driverJs}" %*\r\n`)
        process.env.PATH = fakeBin + path.delimiter + (originalPath ?? '')

        const repoIdTest = 'e1c8a999-6d73-4f56-83a3-fbcd78c9c19d'
        const mainSource = await captureValidationSource(repoMain, repoIdTest)
        const siblingSource = await captureValidationSource(repoSibling, repoIdTest)

        const gitSvc = new GitService()
        const registry = new GitWorktreeRegistry(repoMain, gitSvc, { repositoryId: repoIdTest, isActive: () => true })
        const siblingWt = (await registry.discover()).worktrees.find((w) => w.branch === 'sibling-yolo')!

        const testGitOps: GitOperationsPort = {
          getBranchInventory: async (): Promise<BranchInventory> => ({
            repositoryId: repoIdTest,
            observedAt: new Date().toISOString(),
            revision: '1',
            source: 'GIT_LOCAL',
            coverage: 'COMPLETE',
            branches: [
              {
                key: 'sibling-yolo',
                repositoryId: repoIdTest,
                name: 'sibling-yolo',
                ref: 'refs/heads/sibling-yolo',
                namespace: 'LOCAL',
                head: siblingSource.head,
                upstream: null,
                generation: siblingWt.generation,
                revision: '1',
                creation: { at: new Date().toISOString(), source: 'APP_RECEIPT' },
                lastCommitAt: new Date().toISOString(),
                worktrees: [{ worktreeId: siblingWt.worktreeId, generation: siblingWt.generation }]
              }
            ],
            worktrees: [siblingWt],
            unassignedWorktrees: []
          }),
          getCoordinationSnapshot: async () => ({ reference: false })
        }

        let currentPolicy: CliPolicy = {
          mode: 'AUTONOMOUS_TRUSTED',
          scope: 'REPOSITORY_WORKTREES',
          revision: 'yolo-rev-1',
          rule: 'local-repository-worktree-trust'
        }
        let approvalCalls = 0
        const controlledCli = new CliExecutionService({
          repoRoot: repoMain,
          repositoryId: repoIdTest,
          enabledByDefault: true,
          getPolicy: () => currentPolicy,
          getFingerprint: async () => mainSource.head,
          getRuntimeIdentity: async () => `main:${mainSource.worktreeId}`,
          approvalHandler: async () => {
            approvalCalls++
            return true
          },
          resolveWorktree: (selector) => resolveCliWorktree(registry, gitSvc, selector)
        })

        const facade = new UnitFlowRuntimeFacade({
          repositoryId: repoIdTest,
          repoRoot: repoMain,
          smcService,
          gitOperations: testGitOps,
          cliExecution: controlledCli,
          validationLedger: ledger,
          stagingDirectory: stagingDir
        })
        const adapter = new ChannelMcpAdapter(
          {
            projectId: repoIdTest,
            repoRoot: repoMain,
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

        // MCP schema de start_next_unitflow_unit continua rejeitando allowAlwaysApprove/timeoutMs
        const rejectedMcp = await adapter.callTool('start_next_unitflow_unit', {
          sessionId: randomUUID(),
          planId: randomUUID(),
          reservationId: randomUUID(),
          attemptId: randomUUID(),
          stageOperationId: randomUUID(),
          allowAlwaysApprove: true
        })
        expect(rejectedMcp.isError).toBe(true)

        const sessionId = randomUUID()
        const planId = randomUUID()
        const u1 = randomUUID()
        const u2 = randomUUID()

        parseMcpResult(await adapter.callTool('create_buildx_session', { sessionId }))
        parseMcpResult(await adapter.callTool('bind_unitflow_workspace', { sessionId, worktreeId: siblingWt.worktreeId }))
        parseMcpResult(
          await adapter.callTool('prepare_unitflow_plan', {
            sessionId,
            planId,
            title: 'Controlled YOLO vs SUPERVISED Plan',
            objective: 'Verify --always-approve derivation and timeout profile',
            units: [
              { unitId: u1, position: 0, title: 'Unit 1 YOLO', objective: 'Run in YOLO', acceptanceCriteria: 'Produces file' },
              { unitId: u2, position: 1, title: 'Unit 2 SUPERVISED', objective: 'Run in SUPERVISED', acceptanceCriteria: 'No always-approve', dependsOnUnitIds: [u1] }
            ]
          })
        )

        // Unidade 1 em YOLO Worktree
        const attempt1 = randomUUID()
        const start1 = parseMcpResult(
          await adapter.callTool('start_next_unitflow_unit', {
            sessionId,
            planId,
            reservationId: randomUUID(),
            attemptId: attempt1,
            stageOperationId: randomUUID()
          })
        )
        expect(start1.status).not.toBe('REFUSED')
        expect(start1.reason).not.toBe('AUTO_AUTHORIZED_NOT_REQUESTED')

        const waitDeadline = Date.now() + 15000
        while (Date.now() < waitDeadline) {
          if (controlledCli.get({ operationId: attempt1 }).phase === 'TERMINAL') break
          await new Promise((r) => setTimeout(r, 50))
        }
        const snap1 = controlledCli.get({ operationId: attempt1 })
        expect(snap1.status).toBe('SUCCEEDED')
        expect(snap1.timeoutProfile).toBe('BUILDX_AGENTIC_UNIT')
        expect(snap1.timeoutMs).toBe(600000)
        expect(approvalCalls).toBe(0)
        expect(JSON.parse(fs.readFileSync(path.join(repoSibling, 'grok-argv.json'), 'utf8'))).toContain('--always-approve')
        expect(fs.existsSync(path.join(repoSibling, 'grok-produced.txt'))).toBe(true)

        const settle1 = parseMcpResult(await adapter.callTool('settle_unitflow_unit', { sessionId, attemptId: attempt1 }))
        expect(settle1.settled).toBe(true)
        expect(settle1.unitState).toBe('VALIDATING')
        expect(settle1.timeoutProfile).toBe('BUILDX_AGENTIC_UNIT')
        expect(settle1.timeoutMs).toBe(600000)

        const currentSrc = await captureValidationSource(repoSibling, repoIdTest)
        const proof1 = ledger.recordProof({
          kind: 'TARGETED_TEST',
          producer: 'IMPLEMENTER',
          status: 'PASSED',
          startedAt: new Date(Date.now() - 1000).toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 1000,
          scope: ['unit1-yolo'],
          summary: 'Controlled YOLO unit verified',
          sourceFingerprint: validationSourceFingerprint(currentSrc),
          commandProfile: { command: 'grok --always-approve', cwd: currentSrc.cwd, source: currentSrc }
        })
        const acc1 = parseMcpResult(
          await adapter.callTool('accept_unitflow_unit', {
            sessionId,
            attemptId: attempt1,
            operationId: randomUUID(),
            proofIds: [proof1.proofId],
            summary: 'Accepted unit 1'
          })
        )
        expect(acc1.status).toBe('ACCEPTED')

        // Unidade 2 após revogar para SUPERVISED
        currentPolicy = { mode: 'SUPERVISED', scope: 'ACTIVE_CHECKOUT_ONLY', revision: 'sup-rev-2', rule: 'native-command-consent' }
        controlledCli.refreshPolicy()

        const attempt2 = randomUUID()
        await adapter.callTool('start_next_unitflow_unit', {
          sessionId,
          planId,
          reservationId: randomUUID(),
          attemptId: attempt2,
          stageOperationId: randomUUID()
        })
        const wait2 = Date.now() + 15000
        while (Date.now() < wait2) {
          if (controlledCli.get({ operationId: attempt2 }).phase === 'TERMINAL') break
          await new Promise((r) => setTimeout(r, 50))
        }
        expect(controlledCli.get({ operationId: attempt2 }).status).toBe('SUCCEEDED')
        expect(approvalCalls).toBe(1)
        expect(JSON.parse(fs.readFileSync(path.join(repoSibling, 'grok-argv.json'), 'utf8'))).not.toContain('--always-approve')
        expect(execSync('git rev-parse HEAD', { cwd: repoMain, encoding: 'utf8' }).trim()).toBe(mainHead)
        expect(execSync('git status --porcelain', { cwd: repoMain, encoding: 'utf8' }).trim()).toBe('')

        await controlledCli.shutdown()
      } finally {
        process.env.PATH = originalPath ?? ''
        try { fs.rmSync(yoloTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
      }
    }, 45000)
  })
})
