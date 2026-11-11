import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionMemoryCentralService } from '../smc/session-memory-central-service'
import { UnitFlowService } from '../unitflow/unitflow-service'
import { UnitFlowReservationService } from '../unitflow/unitflow-reservation-service'
import { WorkspaceBindingService, type GitOperationsPort } from './workspace-binding-service'
import { ExecutionAttemptService } from './execution-attempt-service'
import { UnitPromptStageService } from './unit-prompt-stage-service'
import { UnitExecutionService } from './unit-execution-service'
import type { UnitExecutorPort } from './executor-port'
import type {
  ExecutorEvent,
  ExecutorRunObservation,
  ExecutorSelection,
  ExecutorTerminationConfirmation
} from '../../../shared/types/buildx/execution-types'
import { ExecutionAttemptIdConflictError } from './execution-errors'

function createFakeSdkAdapter(
  identity: ExecutorSelection,
  behavior?: {
    startStatus?: ExecutorRunObservation['status']
    startError?: Error
    terminationConfirmed?: boolean
    cancelStatus?: ExecutorRunObservation['status']
    cancelTerminationConfirmed?: boolean
  }
): UnitExecutorPort & {
  prepareCalls: number
  startCalls: number
  observeCalls: number
  cancelCalls: number
  emitEvent: (attemptId: string, event: ExecutorEvent) => void
  setObservation: (obs: Partial<ExecutorRunObservation>) => void
} {
  let currentObservation: ExecutorRunObservation = {
    attemptId: '',
    status: behavior?.startStatus ?? 'RUNNING',
    phase: behavior?.startStatus === 'SUCCEEDED' ? 'TERMINAL' : 'RUNNING',
    selection: identity,
    ...(behavior?.startStatus === 'SUCCEEDED'
      ? { termination: { confirmed: behavior?.terminationConfirmed ?? true } }
      : {})
  }
  const listeners = new Map<string, Set<(event: ExecutorEvent) => void>>()

  const adapter: UnitExecutorPort & {
    prepareCalls: number
    startCalls: number
    observeCalls: number
    cancelCalls: number
    emitEvent: (attemptId: string, event: ExecutorEvent) => void
    setObservation: (obs: Partial<ExecutorRunObservation>) => void
  } = {
    identity,
    prepareCalls: 0,
    startCalls: 0,
    observeCalls: 0,
    cancelCalls: 0,
    checkAvailability: async () => ({ available: true }),
    prepareAttempt: async (input) => {
      adapter.prepareCalls++
      expect(input.prompt.readPromptText?.()).toContain('# Implementation Task')
      return {
        status: 'READY',
        handle: {
          preparedAttemptId: `sdk-handle-${input.attemptId}`,
          selection: identity
        }
      }
    },
    startAttempt: async (input) => {
      adapter.startCalls++
      if (behavior?.startError) throw behavior.startError
      currentObservation = {
        ...currentObservation,
        attemptId: input.attemptId
      }
      return currentObservation
    },
    observeAttempt: async (input) => {
      adapter.observeCalls++
      return {
        ...currentObservation,
        attemptId: input.attemptId
      }
    },
    cancelAttempt: async (input) => {
      adapter.cancelCalls++
      const confirmed = behavior?.cancelTerminationConfirmed ?? true
      currentObservation = {
        attemptId: input.attemptId,
        status: behavior?.cancelStatus ?? 'CANCELLED',
        phase: confirmed ? 'TERMINAL' : 'TERMINATION_UNCONFIRMED',
        selection: identity,
        termination: {
          confirmed,
          ...(!confirmed ? { reason: 'TREE_STILL_ALIVE' } : {})
        },
        reason: confirmed ? 'USER_CANCELLED' : 'TREE_STILL_ALIVE'
      }
      return currentObservation
    },
    confirmTermination: async (): Promise<ExecutorTerminationConfirmation> => ({
      confirmed: currentObservation.termination?.confirmed ?? false,
      ...(currentObservation.termination?.reason ? { reason: currentObservation.termination.reason } : {})
    }),
    subscribe: (attemptId, listener) => {
      const key = attemptId.toLowerCase()
      let set = listeners.get(key)
      if (!set) {
        set = new Set()
        listeners.set(key, set)
      }
      set.add(listener)
      return () => { set?.delete(listener) }
    },
    emitEvent: (attemptId, event) => {
      for (const fn of listeners.get(attemptId.toLowerCase()) ?? []) {
        fn(event)
      }
    },
    setObservation: (obs) => {
      currentObservation = { ...currentObservation, ...obs }
    }
  }

  return adapter
}

describe('UnitExecutionService — Porta Agnóstica, Persistência de Seleção e Conflitos (U1)', () => {
  const repoId = 'repo-u1-port'
  const wtId = 'wt-u1-01'
  const gen = 'gen-u1-1'
  const branch = 'feat/u1-port'
  const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

  let baseDir: string
  let stageDir: string
  let wtDir: string
  let smc: SessionMemoryCentralService
  let gitPort: GitOperationsPort
  let wsService: WorkspaceBindingService
  let stageService: UnitPromptStageService

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'u1-exec-smc-'))
    stageDir = mkdtempSync(join(tmpdir(), 'u1-exec-stage-'))
    wtDir = mkdtempSync(join(tmpdir(), 'u1-exec-wt-'))
    smc = new SessionMemoryCentralService(baseDir)
    gitPort = {
      getBranchInventory: async () => ({
        repositoryId: repoId,
        observedAt: new Date().toISOString(),
        revision: '1',
        source: 'GIT_LOCAL',
        coverage: 'COMPLETE',
        branches: [
          {
            key: branch,
            repositoryId: repoId,
            name: branch,
            ref: `refs/heads/${branch}`,
            namespace: 'LOCAL',
            head,
            upstream: null,
            generation: gen,
            revision: '1',
            creation: { at: new Date().toISOString(), source: 'APP_RECEIPT' },
            lastCommitAt: new Date().toISOString(),
            worktrees: [{ worktreeId: wtId, generation: gen }]
          }
        ],
        worktrees: [
          {
            worktreeId: wtId,
            generation: gen,
            path: wtDir,
            branch,
            head,
            detached: false,
            locked: false,
            missing: false,
            prunable: false
          }
        ],
        unassignedWorktrees: []
      }),
      getCoordinationSnapshot: async () => ({ reference: false })
    }
    wsService = new WorkspaceBindingService(smc, gitPort)
    stageService = new UnitPromptStageService(smc, wsService, { stagingDirectory: stageDir })
  })

  afterEach(() => {
    try { smc.close() } catch {}
    try { rmSync(baseDir, { recursive: true, force: true }) } catch {}
    try { rmSync(stageDir, { recursive: true, force: true }) } catch {}
    try { rmSync(wtDir, { recursive: true, force: true }) } catch {}
  })

  async function createAttemptFixture(
    suffix: string,
    selection?: ExecutorSelection
  ) {
    const sessionId = `10000000-0000-4000-8000-0000000000${suffix}`
    const planId = `20000000-0000-4000-8000-0000000000${suffix}`
    const unitId = `30000000-0000-4000-8000-0000000000${suffix}`
    const reservationId = `40000000-0000-4000-8000-0000000000${suffix}`
    const attemptId = `50000000-0000-4000-8000-0000000000${suffix}`
    const stageOperationId = `60000000-0000-4000-8000-0000000000${suffix}`

    smc.createSession(repoId, { sessionId })
    await wsService.bindWorkspace(repoId, sessionId, wtId)
    const unitFlow = new UnitFlowService(smc)
    unitFlow.registerPlan(repoId, sessionId, { planId, title: `Plan ${suffix}` })
    unitFlow.definePlanUnits(repoId, sessionId, planId, [
      { unitId, title: `Unit ${suffix}`, objective: 'Execute unit', acceptanceCriteria: 'Done' }
    ])
    const resSvc = new UnitFlowReservationService(smc, gitPort)
    const res = await resSvc.reserveNextEligibleUnit(repoId, sessionId, planId, { reservationId })
    if (res.kind !== 'RESERVED') throw new Error('Expected RESERVED')

    const attemptSvc = new ExecutionAttemptService(smc, wsService)
    await attemptSvc.prepareExecutionAttempt(repoId, sessionId, reservationId, {
      attemptId,
      ...(selection ? { executorSelection: selection } : {})
    })

    const stageRes = await stageService.stageUnitPrompt(repoId, sessionId, attemptId, { stageOperationId })
    if (!stageRes.success) throw new Error('Stage failed')

    return { sessionId, planId, unitId, reservationId, attemptId, stageOperationId }
  }

  it('persiste seleção na SMC antes do spawn (sobrevive crash no start e reopen do Store)', async () => {
    const f = await createAttemptFixture('01')
    const sdkIdentity: ExecutorSelection = {
      executorId: 'cline-sdk',
      providerId: 'cline',
      modelId: 'cline-free/solar-mini4'
    }
    const crashingSdk = createFakeSdkAdapter(sdkIdentity, {
      startError: new Error('WORKER_CRASH_ON_SPAWN')
    })
    const svc = new UnitExecutionService(smc, wsService, stageService, crashingSdk)

    const result = await svc.startUnitExecution(repoId, f.sessionId, f.attemptId, {
      stageOperationId: f.stageOperationId
    })

    expect(result.status).toBe('UNKNOWN')
    expect(result.reason).toContain('WORKER_CRASH_ON_SPAWN')
    expect(crashingSdk.startCalls).toBe(1)

    smc.close()
    const reopened = new SessionMemoryCentralService(baseDir)
    const persisted = reopened.getExecutionAttempt(repoId, f.attemptId)
    expect(persisted?.status).toBe('STARTING')
    expect(persisted?.executorSelection).toEqual(sdkIdentity)
    expect(reopened.getAttemptExecutorSelection(repoId, f.attemptId)).toEqual(sdkIdentity)
    reopened.close()
  })

  it('rejeita seleção conflituosa na mesma tentativa (prepare, start, observe, settle, cancel) sem duplicar spawn', async () => {
    const grokSel: ExecutorSelection = { executorId: 'grok-cli', providerId: 'xai', modelId: null }
    const clineSel: ExecutorSelection = { executorId: 'cline-sdk', providerId: 'cline', modelId: 'cline-free/solar-mini4' }
    const clineOtherModel: ExecutorSelection = { executorId: 'cline-sdk', providerId: 'cline', modelId: 'cline-free/other-model' }

    const f = await createAttemptFixture('02', grokSel)

    // 1. Replay of prepareExecutionAttempt with divergent selection fails
    const attemptSvc = new ExecutionAttemptService(smc, wsService)
    await expect(
      attemptSvc.prepareExecutionAttempt(repoId, f.sessionId, f.reservationId, {
        attemptId: f.attemptId,
        executorSelection: clineSel
      })
    ).rejects.toThrow(ExecutionAttemptIdConflictError)

    // 2. Start with conflicting requested selection or conflicting adapter fails BEFORE spawn
    const clineAdapter = createFakeSdkAdapter(clineSel)
    const conflictingSvc = new UnitExecutionService(smc, wsService, stageService, clineAdapter)
    const conflictStart = await conflictingSvc.startUnitExecution(repoId, f.sessionId, f.attemptId, {
      stageOperationId: f.stageOperationId
    })
    expect(conflictStart.status).toBe('UNAVAILABLE')
    expect(conflictStart.reason).toContain('EXECUTOR_SELECTION_CONFLICT')
    expect(clineAdapter.prepareCalls).toBe(0)
    expect(clineAdapter.startCalls).toBe(0)

    // 3. Start with matching adapter succeeds once; replay does not duplicate spawn
    const grokFake = createFakeSdkAdapter(grokSel, { startStatus: 'RUNNING' })
    const grokSvc = new UnitExecutionService(smc, wsService, stageService, grokFake)

    const s1 = await grokSvc.startUnitExecution(repoId, f.sessionId, f.attemptId, {
      stageOperationId: f.stageOperationId,
      executorSelection: grokSel
    })
    expect(s1.status).toBe('RUNNING')
    expect(grokFake.startCalls).toBe(1)

    const s2 = await grokSvc.startUnitExecution(repoId, f.sessionId, f.attemptId, {
      stageOperationId: f.stageOperationId,
      executorSelection: grokSel
    })
    expect(s2.status).toBe('RUNNING')
    expect(grokFake.startCalls).toBe(1)
    expect(grokFake.observeCalls).toBe(1)

    // 4. Conflicting observe, settle, and cancel on active attempt fail closed
    const otherModelAdapter = createFakeSdkAdapter(clineOtherModel)
    const otherSvc = new UnitExecutionService(smc, wsService, stageService, otherModelAdapter)

    const obsConflict = await otherSvc.observeUnitExecution(repoId, f.sessionId, f.attemptId)
    expect(obsConflict.status).toBe('UNAVAILABLE')
    expect(obsConflict.reason).toContain('EXECUTOR_SELECTION_CONFLICT')
    expect(otherModelAdapter.observeCalls).toBe(0)

    const settleConflict = await otherSvc.settleUnitExecution(repoId, f.sessionId, f.attemptId)
    expect(settleConflict.status).toBe('UNKNOWN')
    expect(settleConflict.reason).toContain('EXECUTOR_SELECTION_CONFLICT')
    expect(otherModelAdapter.observeCalls).toBe(0)

    const cancelConflict = await otherSvc.cancelUnitExecution(repoId, f.sessionId, f.attemptId)
    expect(cancelConflict.status).toBe('UNAVAILABLE')
    expect(cancelConflict.reason).toContain('EXECUTOR_SELECTION_CONFLICT')
    expect(otherModelAdapter.cancelCalls).toBe(0)
  })

  it('corrida concorrente entre dois executores distintos na mesma tentativa executa no máximo um spawn', async () => {
    const f = await createAttemptFixture('03')
    const grokSel: ExecutorSelection = { executorId: 'grok-cli', providerId: 'xai', modelId: null }
    const clineSel: ExecutorSelection = { executorId: 'cline-sdk', providerId: 'cline', modelId: 'cline-free/solar-mini4' }

    const grokFake = createFakeSdkAdapter(grokSel, { startStatus: 'RUNNING' })
    const clineFake = createFakeSdkAdapter(clineSel, { startStatus: 'RUNNING' })

    const grokSvc = new UnitExecutionService(smc, wsService, stageService, grokFake)
    const clineSvc = new UnitExecutionService(smc, wsService, stageService, clineFake)

    const [r1, r2] = await Promise.all([
      grokSvc.startUnitExecution(repoId, f.sessionId, f.attemptId, { stageOperationId: f.stageOperationId }),
      clineSvc.startUnitExecution(repoId, f.sessionId, f.attemptId, { stageOperationId: f.stageOperationId })
    ])

    expect(grokFake.startCalls + clineFake.startCalls).toBe(1)
    const statuses = [r1.status, r2.status]
    expect(statuses).toContain('RUNNING')
    expect(statuses).toContain('UNAVAILABLE')
  })

  it('executa ciclo completo com adaptador SDK fake (eventos, uso, cobrança zero, settle sem exitCode)', async () => {
    const sdkSel: ExecutorSelection = {
      executorId: 'cline-sdk',
      providerId: 'cline',
      modelId: 'cline-free/solar-mini4'
    }
    const f = await createAttemptFixture('04', sdkSel)
    const sdkFake = createFakeSdkAdapter(sdkSel, { startStatus: 'RUNNING' })
    const svc = new UnitExecutionService(smc, wsService, stageService, sdkFake)

    const receivedEvents: ExecutorEvent[] = []
    const unsub = await svc.subscribeAttemptEvents(repoId, f.sessionId, f.attemptId, (ev) => {
      receivedEvents.push(ev)
    })
    expect(unsub).not.toBeNull()

    const startRes = await svc.startUnitExecution(repoId, f.sessionId, f.attemptId, {
      stageOperationId: f.stageOperationId
    })
    expect(startRes.status).toBe('RUNNING')
    expect(startRes.executorId).toBe('cline-sdk')
    expect(startRes.modelId).toBe('cline-free/solar-mini4')

    sdkFake.emitEvent(f.attemptId, {
      kind: 'TOOL_ACTIVITY',
      attemptId: f.attemptId,
      timestamp: new Date().toISOString(),
      message: 'Edited target file',
      provenance: sdkSel
    })
    expect(receivedEvents).toHaveLength(1)
    expect(receivedEvents[0].kind).toBe('TOOL_ACTIVITY')
    unsub?.()

    sdkFake.setObservation({
      status: 'SUCCEEDED',
      phase: 'TERMINAL',
      exitCode: undefined,
      termination: { confirmed: true },
      result: {
        summary: 'OK',
        usage: { inputTokens: 73, outputTokens: 2, totalTokens: 75, provenance: 'EXECUTOR_REPORTED' },
        billing: {
          upstreamCostUsd: 0.00081,
          creditsUsed: 0,
          balanceDelta: 0,
          currency: 'USD',
          classification: 'ZERO_COST_CONFIRMED',
          provenance: 'EXECUTOR_REPORTED'
        },
        provenance: {
          executorId: sdkSel.executorId,
          providerId: sdkSel.providerId,
          modelId: sdkSel.modelId,
          origin: 'CLINE_CORE_SDK'
        }
      }
    })

    const settleRes = await svc.settleUnitExecution(repoId, f.sessionId, f.attemptId)
    expect(settleRes.status).toBe('VALIDATION_READY')
    expect(settleRes.attemptStatus).toBe('COMPLETED')
    expect(settleRes.unitFlowStatus).toBe('VALIDATING')
    expect(settleRes.executorId).toBe('cline-sdk')
    expect(settleRes.modelId).toBe('cline-free/solar-mini4')
    expect(settleRes.usage?.totalTokens).toBe(75)
    expect(settleRes.billing?.classification).toBe('ZERO_COST_CONFIRMED')
    expect(stageService.isStageRetained(f.stageOperationId)).toBe(false)
  })

  it('cancelUnitExecution com término não confirmado mantém retenção e retorna UNKNOWN', async () => {
    const sdkSel: ExecutorSelection = {
      executorId: 'cline-sdk',
      providerId: 'cline',
      modelId: 'cline-free/solar-mini4'
    }

    const fUnconfirmed = await createAttemptFixture('05', sdkSel)
    const unconfirmedAdapter = createFakeSdkAdapter(sdkSel, {
      startStatus: 'RUNNING',
      cancelTerminationConfirmed: false
    })
    const svc1 = new UnitExecutionService(smc, wsService, stageService, unconfirmedAdapter)
    await svc1.startUnitExecution(repoId, fUnconfirmed.sessionId, fUnconfirmed.attemptId, {
      stageOperationId: fUnconfirmed.stageOperationId
    })

    const cancelUnconfirmed = await svc1.cancelUnitExecution(repoId, fUnconfirmed.sessionId, fUnconfirmed.attemptId)
    expect(cancelUnconfirmed.status).toBe('UNKNOWN')
    expect(cancelUnconfirmed.reason).toBe('TREE_STILL_ALIVE')
    expect(stageService.isStageRetained(fUnconfirmed.stageOperationId)).toBe(true)
  })

  it('cancelUnitExecution com término confirmado libera retenção e permite settle para RECONCILING', async () => {
    const sdkSel: ExecutorSelection = {
      executorId: 'cline-sdk',
      providerId: 'cline',
      modelId: 'cline-free/solar-mini4'
    }

    const fConfirmed = await createAttemptFixture('06', sdkSel)
    const confirmedAdapter = createFakeSdkAdapter(sdkSel, {
      startStatus: 'RUNNING',
      cancelTerminationConfirmed: true
    })
    const svc2 = new UnitExecutionService(smc, wsService, stageService, confirmedAdapter)
    await svc2.startUnitExecution(repoId, fConfirmed.sessionId, fConfirmed.attemptId, {
      stageOperationId: fConfirmed.stageOperationId
    })

    const cancelConfirmed = await svc2.cancelUnitExecution(repoId, fConfirmed.sessionId, fConfirmed.attemptId)
    expect(cancelConfirmed.status).toBe('TERMINAL_OBSERVED')
    expect(stageService.isStageRetained(fConfirmed.stageOperationId)).toBe(false)

    const settled = await svc2.settleUnitExecution(repoId, fConfirmed.sessionId, fConfirmed.attemptId)
    expect(settled.status).toBe('RECONCILING')
    expect(settled.attemptStatus).toBe('CANCELLED')
    expect(settled.unitFlowStatus).toBe('RECONCILING')
  })
})
