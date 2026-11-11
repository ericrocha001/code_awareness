import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {
  EconomicCandidateSignal,
  EconomicSelectionPolicy
} from '../../../shared/types/buildx/execution-types'
import {
  ECONOMIC_TIE_BREAK_RULE,
  evaluateEconomicCandidates,
  selectEconomicExecutor,
  validateEconomicSelectionPolicy
} from './economic-selection'
import type { EconomicCandidateProvider } from './executor-port'
import {
  ClineSdkExecutorAdapter,
  type ClineUtilityLauncher,
  type ClineWorkerMessage,
  type ClineWorkerRequest,
  type SpawnedClineWorker,
  resolveFreeClineCatalogSelection
} from '../adapters/cline'
import { GrokExecutorAdapter } from '../adapters/grok'
import type { CliExecutionPort } from './grok-cli-bridge'

class MockClineUtilityWorker extends EventEmitter implements SpawnedClineWorker {
  readonly sent: ClineWorkerRequest[] = []
  killed = false

  constructor(readonly pid: number | undefined = undefined) {
    super()
  }

  postMessage(message: ClineWorkerRequest): void {
    this.sent.push(message)
  }

  kill(): boolean {
    this.killed = true
    setImmediate(() => this.emit('exit', 1))
    return true
  }

  emitReady(): void {
    this.emit('spawn')
    this.emit('message', { type: 'ready' } satisfies ClineWorkerMessage)
  }

  emitMessage(msg: ClineWorkerMessage): void {
    this.emit('message', msg)
  }
}

describe('Executor-12 U1 — Seleção econômica isolada (sem spawn)', () => {
  let tempRoot: string
  let dummyWorkerFile: string
  let worktreeDir: string

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'buildx-exec12-u1-'))
    dummyWorkerFile = path.join(tempRoot, 'cline-sdk-worker.js')
    fs.writeFileSync(dummyWorkerFile, '// dummy worker\n', 'utf8')
    worktreeDir = path.join(tempRoot, 'wt')
    fs.mkdirSync(worktreeDir, { recursive: true })
  })

  afterEach(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {}
  })

  function createClineProbeAdapter(options: {
    readonly onProbe: (req: Extract<ClineWorkerRequest, { type: 'probe_free_catalog' }>, worker: MockClineUtilityWorker) => void
  }) {
    let probeForks = 0
    let prepareAttemptMsgs = 0
    let startAttemptMsgs = 0

    const launcher: ClineUtilityLauncher = {
      isAvailable: () => true,
      fork: () => {
        const worker = new MockClineUtilityWorker()
        const origPost = worker.postMessage.bind(worker)
        worker.postMessage = (req: ClineWorkerRequest) => {
          origPost(req)
          if (req.type === 'probe_free_catalog') {
            probeForks++
            options.onProbe(req, worker)
          } else if (req.type === 'prepare_attempt') {
            prepareAttemptMsgs++
          } else if (req.type === 'start_attempt') {
            startAttemptMsgs++
          }
        }
        setImmediate(() => worker.emitReady())
        return worker
      }
    }

    const adapter = new ClineSdkExecutorAdapter({
      repositoryId: 'repo-1',
      workerPath: dummyWorkerFile,
      runtimeStorageBaseDir: path.join(tempRoot, 'cline-runtime'),
      launcher
    })

    return {
      adapter,
      getCounts: () => ({ probeForks, prepareAttemptMsgs, startAttemptMsgs })
    }
  }

  function createFakeGrokAdapter(options?: { readonly enabled?: boolean; readonly repoId?: string | null }) {
    let prepareCalls = 0
    let startCalls = 0
    let policyCalls = 0
    const enabled = options?.enabled ?? true
    const cliRepoId = options?.repoId !== undefined ? options.repoId : 'repo-1'

    const cliPort: CliExecutionPort = {
      isEnabled: () => enabled,
      getRepositoryId: () => cliRepoId,
      getPolicyForWorktree: async () => {
        policyCalls++
        return {
          mode: 'SUPERVISED',
          scope: 'ACTIVE_CHECKOUT_ONLY',
          revision: 'rev-1',
          rule: 'native-command-consent'
        }
      },
      prepare: async () => {
        prepareCalls++
        throw new Error('CLI prepare MUST NOT be called during U1 economic probe')
      },
      start: async () => {
        startCalls++
        throw new Error('CLI start MUST NOT be called during U1 economic probe')
      }
    }

    const adapter = new GrokExecutorAdapter(cliPort)
    return {
      adapter,
      getCounts: () => ({ prepareCalls, startCalls, policyCalls })
    }
  }

  it('valida política economicSelection estritamente e rejeita políticas inválidas ou limites fictícios', () => {
    expect(validateEconomicSelectionPolicy({ mode: 'VERIFIED_ZERO_FIRST' })).toEqual({
      mode: 'VERIFIED_ZERO_FIRST',
      allowUnknownCostFallback: false,
      allowedExecutorIds: null,
      privacy: 'HOST_POLICY'
    })

    expect(
      validateEconomicSelectionPolicy({
        mode: 'VERIFIED_ZERO_FIRST',
        allowUnknownCostFallback: true,
        allowedExecutorIds: ['grok-cli', 'cline-sdk', 'grok-cli'],
        privacy: 'NO_EXTERNAL_CODE'
      })
    ).toEqual({
      mode: 'VERIFIED_ZERO_FIRST',
      allowUnknownCostFallback: true,
      allowedExecutorIds: ['grok-cli', 'cline-sdk'],
      privacy: 'NO_EXTERNAL_CODE'
    })

    const invalidInputs: unknown[] = [
      null,
      [],
      'VERIFIED_ZERO_FIRST',
      {},
      { mode: 'CHEAPEST' },
      { mode: 'VERIFIED_ZERO_FIRST', allowUnknownCostFallback: 'yes' },
      { mode: 'VERIFIED_ZERO_FIRST', privacy: 'LOCAL_ONLY' },
      { mode: 'VERIFIED_ZERO_FIRST', allowedExecutorIds: [] },
      { mode: 'VERIFIED_ZERO_FIRST', allowedExecutorIds: ['paid-anthropic'] },
      { mode: 'VERIFIED_ZERO_FIRST', maxPriceUsd: 0.01 },
      { mode: 'VERIFIED_ZERO_FIRST', customPromptText: 'override' }
    ]

    for (const invalid of invalidInputs) {
      expect(() => validateEconomicSelectionPolicy(invalid)).toThrow(/INVALID_ARGUMENT/)
    }
  })

  it('sonda Cline FREE vivo/zero/tools sem spawn ou vazamento de credenciais e prioriza VERIFIED_ZERO sobre Grok UNKNOWN mesmo com fallback ligado', async () => {
    const cline = createClineProbeAdapter({
      onProbe: (req, worker) => {
        expect(req.requireAuth).toBe(true)
        worker.emitMessage({
          type: 'catalog_result',
          requestId: req.requestId,
          ok: true,
          selectedModelId: 'cline-free/nemotron-zero',
          availableFreeModelIds: ['cline-free/nemotron-zero', 'cline-free/solar-zero'],
          accountId: 'workos:secret-account-id-must-not-leak'
        })
        worker.emit('exit', 0)
      }
    })
    const grok = createFakeGrokAdapter({ enabled: true })

    // Pass Grok FIRST intentionally: preference must still deterministically choose VERIFIED_ZERO Cline
    const decision = await selectEconomicExecutor({
      repositoryId: 'repo-1',
      policy: {
        mode: 'VERIFIED_ZERO_FIRST',
        allowUnknownCostFallback: true
      },
      providers: [grok.adapter, cline.adapter],
      nowIso: '2026-11-11T16:30:00.000Z'
    })

    expect(decision.status).toBe('SELECTED')
    expect(decision.selection).toEqual({
      executorId: 'cline-sdk',
      providerId: 'cline',
      modelId: 'cline-free/nemotron-zero'
    })
    expect(decision.costTier).toBe('VERIFIED_ZERO')
    expect(decision.quotaStatus).toBe('UNKNOWN')
    expect(decision.reason).toBe('SELECTED_VERIFIED_ZERO_COST')
    expect(decision.verifiedZeroModelsCount).toBe(2)
    expect(decision.candidateCount).toBe(2)
    expect(decision.rejections).toEqual([])
    expect(JSON.stringify(decision)).not.toContain('workos:')
    expect(JSON.stringify(decision)).not.toContain('secret-account-id')
    expect(cline.getCounts()).toEqual({ probeForks: 1, prepareAttemptMsgs: 0, startAttemptMsgs: 0 })
    expect(grok.getCounts()).toEqual({ prepareCalls: 0, startCalls: 0, policyCalls: 0 })
  })

  it('recusa catálogo offline, modelo pago ou sem tools, e auth indisponível sem recorrer a fallback desconhecido quando desabilitado', async () => {
    const grok = createFakeGrokAdapter({ enabled: true })

    // 1. Offline catalog fallback rejected via resolveFreeClineCatalogSelection
    const fakeSdkOffline = {
      fetchClineRecommendedModels: async ({ fetchImpl }: any) => {
        await fetchImpl('https://api.cline.bot/api/v1/ai/cline/recommended-models').catch(() => {})
        return {
          recommended: [],
          free: [{ id: 'offline/fallback-only', name: 'Offline Fallback', description: '', tags: [] }],
          clinePass: [],
          clineCloud: []
        }
      },
      getLiveModelsCatalog: async () => ({
        cline: {
          'offline/fallback-only': {
            id: 'offline/fallback-only',
            capabilities: ['tools'],
            pricing: { input: 0, output: 0 }
          }
        }
      })
    }
    const offlineCatalogResult = await resolveFreeClineCatalogSelection(fakeSdkOffline as any, {
      fetchImpl: async () => new Response('down', { status: 503 })
    })
    expect(offlineCatalogResult.ok).toBe(false)
    expect(offlineCatalogResult.ok === false && offlineCatalogResult.reason).toContain('FREE_CATALOG_UNAVAILABLE')

    const clineOffline = createClineProbeAdapter({
      onProbe: (req, worker) => {
        worker.emitMessage({
          type: 'catalog_result',
          requestId: req.requestId,
          ok: false,
          errorCode: 'UNAVAILABLE',
          errorMessage: 'FREE_CATALOG_UNAVAILABLE: rejected non-live fallback recommended-models feed'
        })
        worker.emit('exit', 0)
      }
    })

    const decisionOfflineNoFallback = await selectEconomicExecutor({
      repositoryId: 'repo-1',
      policy: { mode: 'VERIFIED_ZERO_FIRST', allowUnknownCostFallback: false },
      providers: [clineOffline.adapter, grok.adapter],
      nowIso: '2026-11-11T16:31:00.000Z'
    })
    expect(decisionOfflineNoFallback.status).toBe('UNAVAILABLE')
    expect(decisionOfflineNoFallback.selection).toBeNull()
    expect(decisionOfflineNoFallback.costTier).toBeNull()
    expect(decisionOfflineNoFallback.rejections).toHaveLength(2)
    expect(decisionOfflineNoFallback.rejections[0]).toMatchObject({
      executorId: 'cline-sdk',
      costTier: 'UNKNOWN'
    })
    expect(decisionOfflineNoFallback.rejections[0].reason).toContain('FREE_CATALOG_UNAVAILABLE')
    expect(decisionOfflineNoFallback.rejections[1]).toMatchObject({
      executorId: 'grok-cli',
      costTier: 'UNKNOWN',
      reason: 'UNKNOWN_COST_FALLBACK_DISABLED'
    })
    expect(grok.getCounts()).toEqual({ prepareCalls: 0, startCalls: 0, policyCalls: 0 })
    expect(clineOffline.getCounts().startAttemptMsgs).toBe(0)

    // 2. Paid model or missing tools capability
    const paidRes = await resolveFreeClineCatalogSelection(
      {
        fetchClineRecommendedModels: async ({ fetchImpl }: any) => {
          await fetchImpl('https://api.cline.bot/api/v1/ai/cline/recommended-models')
          return {
            recommended: [],
            free: [{ id: 'paid/pro-model', name: 'Paid', description: '', tags: [] }],
            clinePass: [],
            clineCloud: []
          }
        },
        getLiveModelsCatalog: async () => ({ cline: {} })
      } as any,
      {
        fetchImpl: async () =>
          new Response(JSON.stringify({ free: [{ id: 'paid/pro-model' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }),
        liveCatalogOverride: {
          cline: {
            'paid/pro-model': {
              id: 'paid/pro-model',
              capabilities: ['tools'],
              pricing: { input: 2.5, output: 10 }
            }
          }
        }
      }
    )
    expect(paidRes.ok).toBe(false)

    // 2b. Zero-priced model lacking 'tools' capability must be rejected
    const noToolsRes = await resolveFreeClineCatalogSelection(
      {
        fetchClineRecommendedModels: async ({ fetchImpl }: any) => {
          await fetchImpl('https://api.cline.bot/api/v1/ai/cline/recommended-models')
          return {
            recommended: [],
            free: [{ id: 'free/no-tools', name: 'NoTools', description: '', tags: [] }],
            clinePass: [],
            clineCloud: []
          }
        },
        getLiveModelsCatalog: async () => ({ cline: {} })
      } as any,
      {
        fetchImpl: async () =>
          new Response(JSON.stringify({ free: [{ id: 'free/no-tools' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }),
        liveCatalogOverride: {
          cline: {
            'free/no-tools': {
              id: 'free/no-tools',
              capabilities: ['reasoning'],
              pricing: { input: 0, output: 0 }
            }
          }
        }
      }
    )
    expect(noToolsRes.ok).toBe(false)
    expect(noToolsRes.ok === false && noToolsRes.reason).toContain('tool-capable')

    const clinePaid = createClineProbeAdapter({
      onProbe: (req, worker) => {
        worker.emitMessage({
          type: 'catalog_result',
          requestId: req.requestId,
          ok: false,
          errorCode: 'REFUSED',
          errorMessage: 'FREE_MODEL_NOT_ELIGIBLE: model "paid/pro-model" is not zero-priced'
        })
        worker.emit('exit', 0)
      }
    })
    const paidSignal = await clinePaid.adapter.probeEconomicCandidate({
      repositoryId: 'repo-1',
      requestedModelId: 'paid/pro-model',
      nowIso: '2026-11-11T16:31:30.000Z'
    })
    expect(paidSignal.eligible).toBe(false)
    expect(paidSignal.costTier).toBe('CHARGED')
    expect(paidSignal.reason).toContain('not zero-priced')

    // Even if an upstream signal wrongly marks a CHARGED candidate eligible=true, selector still forbids it
    const forcedPaidDecision = evaluateEconomicCandidates(
      { mode: 'VERIFIED_ZERO_FIRST', allowUnknownCostFallback: false },
      [{ ...paidSignal, eligible: true, costTier: 'CHARGED' }],
      { nowIso: '2026-11-11T16:31:40.000Z' }
    )
    expect(forcedPaidDecision.status).toBe('UNAVAILABLE')
    expect(forcedPaidDecision.reason).toContain('CHARGED_MODEL_FORBIDDEN')

    // 3. Auth unavailable with secret strings sanitized cleanly
    const clineAuthFail = createClineProbeAdapter({
      onProbe: (req, worker) => {
        worker.emitMessage({
          type: 'catalog_result',
          requestId: req.requestId,
          ok: false,
          errorCode: 'CLINE_AUTHENTICATION_FAILED',
          errorMessage:
            'Missing OAuth for workos:secret-live-token Bearer my-secret-jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig sk-livesecret123456789'
        })
        worker.emit('exit', 0)
      }
    })
    const decisionAuthFail = await selectEconomicExecutor({
      repositoryId: 'repo-1',
      policy: { mode: 'VERIFIED_ZERO_FIRST', allowUnknownCostFallback: false },
      providers: [clineAuthFail.adapter],
      nowIso: '2026-11-11T16:32:00.000Z'
    })
    expect(decisionAuthFail.status).toBe('UNAVAILABLE')
    expect(decisionAuthFail.rejections[0].reason).toContain('CLINE_AUTHENTICATION_FAILED')
    expect(JSON.stringify(decisionAuthFail)).not.toContain('secret-live-token')
    expect(JSON.stringify(decisionAuthFail)).not.toContain('my-secret-jwt')
    expect(JSON.stringify(decisionAuthFail)).not.toContain('eyJhbGci')
    expect(JSON.stringify(decisionAuthFail)).not.toContain('sk-livesecret')
  })

  it('habilita fallback Grok UNKNOWN somente quando allowUnknownCostFallback === true', async () => {
    const clineAuthFail = createClineProbeAdapter({
      onProbe: (req, worker) => {
        worker.emitMessage({
          type: 'catalog_result',
          requestId: req.requestId,
          ok: false,
          errorCode: 'CLINE_AUTHENTICATION_FAILED',
          errorMessage: 'OAuth credentials not configured'
        })
        worker.emit('exit', 0)
      }
    })
    const grok = createFakeGrokAdapter({ enabled: true })

    const blockedFallback = await selectEconomicExecutor({
      repositoryId: 'repo-1',
      policy: {
        mode: 'VERIFIED_ZERO_FIRST',
        allowedExecutorIds: ['grok-cli']
      },
      providers: [clineAuthFail.adapter, grok.adapter]
    })
    expect(blockedFallback.status).toBe('UNAVAILABLE')
    expect(blockedFallback.reason).toContain('EXECUTOR_NOT_ALLOWED')
    // Allowed executor filter skipped probing Cline completely
    expect(clineAuthFail.getCounts().probeForks).toBe(0)

    const grokOnlyNoFallback = await selectEconomicExecutor({
      repositoryId: 'repo-1',
      policy: {
        mode: 'VERIFIED_ZERO_FIRST',
        allowUnknownCostFallback: false,
        allowedExecutorIds: ['grok-cli']
      },
      providers: [grok.adapter]
    })
    expect(grokOnlyNoFallback.status).toBe('UNAVAILABLE')
    expect(grokOnlyNoFallback.reason).toBe('UNKNOWN_COST_FALLBACK_DISABLED')

    const enabledFallback = await selectEconomicExecutor({
      repositoryId: 'repo-1',
      policy: {
        mode: 'VERIFIED_ZERO_FIRST',
        allowUnknownCostFallback: true
      },
      providers: [clineAuthFail.adapter, grok.adapter]
    })
    expect(enabledFallback.status).toBe('SELECTED')
    expect(enabledFallback.selection).toEqual({
      executorId: 'grok-cli',
      providerId: 'xai',
      modelId: null
    })
    expect(enabledFallback.costTier).toBe('UNKNOWN')
    expect(enabledFallback.quotaStatus).toBe('UNKNOWN')
    expect(enabledFallback.reason).toBe('SELECTED_UNKNOWN_COST_FALLBACK')
    expect(enabledFallback.rejections.some((r) => r.executorId === 'cline-sdk')).toBe(true)
    expect(grok.getCounts()).toEqual({ prepareCalls: 0, startCalls: 0, policyCalls: 0 })
  })

  it('recusa ambos os provedores remotos sob privacy NO_EXTERNAL_CODE sem invocar sondagens ou efeitos colaterais', async () => {
    let customProbeCalls = 0
    const spyClineProvider: EconomicCandidateProvider = {
      economicDescriptor: { executorId: 'cline-sdk', providerId: 'cline', requiresExternalTransfer: true },
      probeEconomicCandidate: () => {
        customProbeCalls++
        throw new Error('MUST NOT PROBE CLINE UNDER NO_EXTERNAL_CODE')
      }
    }
    const spyGrokProvider: EconomicCandidateProvider = {
      economicDescriptor: { executorId: 'grok-cli', providerId: 'xai', requiresExternalTransfer: true },
      probeEconomicCandidate: () => {
        customProbeCalls++
        throw new Error('MUST NOT PROBE GROK UNDER NO_EXTERNAL_CODE')
      }
    }

    const decision = await selectEconomicExecutor({
      repositoryId: 'repo-1',
      policy: {
        mode: 'VERIFIED_ZERO_FIRST',
        allowUnknownCostFallback: true,
        privacy: 'NO_EXTERNAL_CODE'
      },
      providers: [spyClineProvider, spyGrokProvider]
    })

    expect(decision.status).toBe('UNAVAILABLE')
    expect(decision.selection).toBeNull()
    expect(decision.reason).toBe('PRIVACY_NO_EXTERNAL_CODE_FORBIDDEN')
    expect(decision.rejections).toHaveLength(2)
    expect(customProbeCalls).toBe(0)
  })

  it('garante empate determinístico independente da ordem dos candidatos', () => {
    const policy: EconomicSelectionPolicy = { mode: 'VERIFIED_ZERO_FIRST' }
    const candA: EconomicCandidateSignal = {
      selection: { executorId: 'cline-sdk', providerId: 'cline', modelId: 'cline-free/alpha' },
      eligible: true,
      hostAuthorized: true,
      toolCapable: true,
      privacyCompatible: true,
      requiresExternalTransfer: true,
      costTier: 'VERIFIED_ZERO',
      quotaStatus: 'UNKNOWN',
      reason: 'CLINE_FREE_LIVE_ZERO_PRICED_VERIFIED',
      source: 'CLINE_LIVE_FREE_CATALOG',
      probedAt: '2026-11-11T16:33:00.000Z'
    }
    const candB: EconomicCandidateSignal = {
      ...candA,
      selection: { executorId: 'cline-sdk', providerId: 'cline', modelId: 'cline-free/zebra' }
    }

    const resAB = evaluateEconomicCandidates(policy, [candA, candB], { nowIso: '2026-11-11T16:33:00.000Z' })
    const resBA = evaluateEconomicCandidates(policy, [candB, candA], { nowIso: '2026-11-11T16:33:00.000Z' })

    expect(resAB.status).toBe('SELECTED')
    expect(resBA.status).toBe('SELECTED')
    expect(resAB.selection).toEqual({
      executorId: 'cline-sdk',
      providerId: 'cline',
      modelId: 'cline-free/alpha'
    })
    expect(resBA.selection).toEqual(resAB.selection)
    expect(resAB.tieBreakRule).toBe(ECONOMIC_TIE_BREAK_RULE)
  })

  it('valida autoridade de Worktree/repositório sem gerar spawn e lida com CLI desabilitado sem efeitos', async () => {
    let probeForks = 0
    const refCline = new ClineSdkExecutorAdapter({
      repositoryId: 'repo-1',
      workerPath: dummyWorkerFile,
      runtimeStorageBaseDir: path.join(tempRoot, 'cline-runtime'),
      launcher: {
        isAvailable: () => true,
        fork: () => {
          probeForks++
          return new MockClineUtilityWorker()
        }
      },
      resolveWorktree: async () => ({ path: worktreeDir, branch: 'feat/u1', reference: true })
    })
    const disabledGrok = createFakeGrokAdapter({ enabled: false })

    const decision = await selectEconomicExecutor({
      repositoryId: 'repo-1',
      policy: { mode: 'VERIFIED_ZERO_FIRST', allowUnknownCostFallback: true },
      providers: [refCline, disabledGrok.adapter],
      worktree: { worktreeId: 'wt-ref', generation: 'gen-ref', branch: 'feat/u1', path: worktreeDir }
    })

    expect(decision.status).toBe('UNAVAILABLE')
    expect(decision.selection).toBeNull()
    expect(probeForks).toBe(0)
    expect(decision.rejections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ executorId: 'cline-sdk', reason: 'REFERENCE_CHECKOUT_FORBIDDEN' }),
        expect.objectContaining({ executorId: 'grok-cli', reason: 'CLI_UNAVAILABLE' })
      ])
    )
    expect(disabledGrok.getCounts()).toEqual({ prepareCalls: 0, startCalls: 0, policyCalls: 0 })
  })
})
