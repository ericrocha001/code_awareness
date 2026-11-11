import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExecutorEvent } from '../../../../shared/types/buildx/execution-types'
import {
  ClineSdkExecutorAdapter,
  type ClineUtilityLauncher,
  type ClineWorkerMessage,
  type ClineWorkerRequest,
  type SpawnedClineWorker,
  classifyClineBillingTwoDimensional,
  classifyClineErrorReason,
  createConfinedToolExecutors,
  createFreeLockedFetch,
  isZeroPricingModelInfo,
  resolveConfinedWorktreePath,
  resolveFreeClineCatalogSelection
} from './index'

class MockUtilityWorker extends EventEmitter implements SpawnedClineWorker {
  readonly sent: ClineWorkerRequest[] = []
  killed = false
  constructor(readonly pid: number | undefined = 424242) {
    super()
  }
  postMessage(message: ClineWorkerRequest): void {
    this.sent.push(message)
  }
  kill(): boolean {
    this.killed = true
    return true
  }
  emitReady(): void {
    this.emit('message', { type: 'ready' } satisfies ClineWorkerMessage)
  }
  emitWorkerMessage(msg: ClineWorkerMessage): void {
    this.emit('message', msg)
  }
}

describe('ClineSdkExecutorAdapter — Portas, FREE Fail-Closed, Confinamento & Lifecycle (Gates 1–3)', () => {
  let tempRoot: string
  let worktreeDir: string
  let outsideDir: string
  let runtimeDir: string
  let dummyWorkerFile: string

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-u2-unit-'))
    worktreeDir = path.join(tempRoot, 'worktree')
    outsideDir = path.join(tempRoot, 'outside')
    runtimeDir = path.join(tempRoot, 'cline-runtime')
    dummyWorkerFile = path.join(tempRoot, 'dummy-worker.js')
    fs.mkdirSync(worktreeDir, { recursive: true })
    fs.mkdirSync(path.join(worktreeDir, '.git'), { recursive: true })
    fs.mkdirSync(outsideDir, { recursive: true })
    fs.writeFileSync(path.join(worktreeDir, 'target.txt'), 'hello\nworld\n', 'utf8')
    fs.writeFileSync(path.join(worktreeDir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'top-secret\n', 'utf8')
    fs.writeFileSync(dummyWorkerFile, '// worker placeholder', 'utf8')
  })

  afterEach(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {}
  })

  it('Gate 1: falha fechado se utilityProcess estiver indisponível (sem fallback Node externo)', async () => {
    const adapter = new ClineSdkExecutorAdapter({
      modelId: 'free/demo-model',
      workerPath: dummyWorkerFile,
      launcher: {
        isAvailable: () => false,
        fork: () => {
          throw new Error('SHOULD_NOT_FORK')
        }
      }
    })

    expect(adapter.checkAvailability('repo-1')).toEqual({
      available: false,
      reason: 'ELECTRON_UTILITY_PROCESS_UNAVAILABLE'
    })

    const prep = await adapter.prepareAttempt({
      repositoryId: 'repo-1',
      sessionId: '11111111-1111-4111-8111-111111111111',
      planId: '22222222-2222-4222-8222-222222222222',
      unitId: '33333333-3333-4333-8333-333333333333',
      attemptId: '44444444-4444-4444-8444-444444444444',
      worktree: { worktreeId: 'wt-1', generation: 'gen-1', branch: 'feat/u2', path: worktreeDir },
      prompt: {
        stageOperationId: 'stage-1',
        promptFilePath: path.join(tempRoot, 'prompt.tmp'),
        readPromptText: () => 'Edit target.txt'
      }
    })
    expect(prep.status).toBe('UNAVAILABLE')
    expect(prep.reason).toBe('ELECTRON_UTILITY_PROCESS_UNAVAILABLE')
  })

  it('Gate 1 & 2: executa ciclo completo tipado, normaliza eventos e exige aprovação supervisionada quando não-YOLO', async () => {
    const forkedWorkers: MockUtilityWorker[] = []
    let approvalsAsked = 0
    let approveDecision = true

    const launcher: ClineUtilityLauncher = {
      isAvailable: () => true,
      fork: () => {
        const w = new MockUtilityWorker(undefined)
        forkedWorkers.push(w)
        setImmediate(() => {
          w.emitReady()
        })
        const origPost = w.postMessage.bind(w)
        w.postMessage = (req: ClineWorkerRequest) => {
          origPost(req)
          if (req.type === 'prepare_attempt') {
            expect(req.requestedModelId).toBe('free/dynamic-zero')
            expect(req.worktreePath).toBe(fs.realpathSync(worktreeDir))
            w.emitWorkerMessage({
              type: 'prepare_result',
              requestId: req.requestId,
              ok: true,
              status: 'READY',
              modelId: req.requestedModelId,
              accountId: 'usr-test-1'
            })
            w.emit('exit', 0)
          } else if (req.type === 'start_attempt') {
            expect(req.allowAutoApprove).toBe(false)
            w.emitWorkerMessage({
              type: 'attempt_started',
              attemptId: req.attemptId,
              clineSessionId: `buildx-${req.attemptId}`,
              lockedModelId: req.modelId,
              pid: 987654
            })
            w.emitWorkerMessage({
              type: 'executor_event',
              event: {
                kind: 'STARTED',
                attemptId: req.attemptId,
                timestamp: new Date().toISOString(),
                phase: 'RUNNING',
                status: 'RUNNING',
                provenance: {
                  executorId: 'cline-sdk',
                  providerId: 'cline',
                  modelId: req.modelId
                }
              }
            })
            w.emitWorkerMessage({
              type: 'approval_request',
              attemptId: req.attemptId,
              toolCallId: 'tc-1',
              toolName: 'editor',
              targetPath: 'target.txt',
              summary: 'Authorize editor on target.txt'
            })
          } else if (req.type === 'approval_response') {
            const startReq = forkedWorkers[1].sent.find((m) => m.type === 'start_attempt') as
              | Extract<ClineWorkerRequest, { type: 'start_attempt' }>
              | undefined
            const attemptId = startReq!.attemptId
            w.emitWorkerMessage({
              type: 'executor_event',
              event: {
                kind: 'COMPLETED',
                attemptId,
                timestamp: new Date().toISOString(),
                phase: 'TERMINAL',
                status: 'SUCCEEDED',
                provenance: {
                  executorId: 'cline-sdk',
                  providerId: 'cline',
                  modelId: 'free/dynamic-zero'
                }
              }
            })
            w.emitWorkerMessage({
              type: 'attempt_terminal',
              attemptId,
              clineSessionId: `buildx-${attemptId}`,
              status: 'SUCCEEDED',
              durationMs: 125,
              summary: 'Edited target.txt safely',
              usage: {
                inputTokens: 40,
                outputTokens: 12,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 52,
                provenance: 'EXECUTOR_REPORTED'
              },
              billing: {
                upstreamCostUsd: 810,
                creditsUsed: 0,
                balanceDelta: 0,
                currency: 'USD',
                classification: 'ZERO_COST_CONFIRMED',
                provenance: 'PROVIDER_BILLING_API'
              },
              cleanup: { sessionDeleted: true, coreDisposed: true, dirRemoved: true }
            })
            fs.rmSync(startReq!.isolatedStorageRoot, { recursive: true, force: true })
            w.emit('exit', 0)
          }
        }
        return w
      }
    }

    const adapter = new ClineSdkExecutorAdapter({
      repositoryId: 'repo-1',
      modelId: 'free/dynamic-zero',
      workerPath: dummyWorkerFile,
      runtimeStorageBaseDir: runtimeDir,
      launcher,
      getPolicy: () => ({
        mode: 'SUPERVISED',
        scope: 'ACTIVE_CHECKOUT_ONLY',
        revision: 'sup-1',
        rule: 'native-command-consent'
      }),
      approvalHandler: async () => {
        approvalsAsked++
        return approveDecision
      }
    })

    // Cannot request allowAlwaysApprove under SUPERVISED host policy
    const policyMismatch = await adapter.prepareAttempt({
      repositoryId: 'repo-1',
      sessionId: '11111111-1111-4111-8111-111111111111',
      planId: '22222222-2222-4222-8222-222222222222',
      unitId: '33333333-3333-4333-8333-333333333333',
      attemptId: '44444444-4444-4444-8444-444444444444',
      allowAlwaysApprove: true,
      worktree: { worktreeId: 'wt-1', generation: 'gen-1', branch: 'feat/u2', path: worktreeDir },
      prompt: {
        stageOperationId: 'stage-1',
        promptFilePath: path.join(tempRoot, 'prompt.tmp'),
        readPromptText: () => 'Edit target.txt'
      }
    })
    expect(policyMismatch.status).toBe('REFUSED')
    expect(policyMismatch.reason).toBe('POLICY_CHANGED')

    // Valid supervised prepare -> start -> approval -> terminal
    const prep = await adapter.prepareAttempt({
      repositoryId: 'repo-1',
      sessionId: '11111111-1111-4111-8111-111111111111',
      planId: '22222222-2222-4222-8222-222222222222',
      unitId: '33333333-3333-4333-8333-333333333333',
      attemptId: '55555555-5555-4555-8555-555555555555',
      worktree: { worktreeId: 'wt-1', generation: 'gen-1', branch: 'feat/u2', path: worktreeDir },
      prompt: {
        stageOperationId: 'stage-1',
        promptFilePath: path.join(tempRoot, 'prompt.tmp'),
        readPromptText: () => 'Edit target.txt'
      }
    })
    expect(prep.status).toBe('READY')

    const seenEvents: ExecutorEvent[] = []
    adapter.subscribe('55555555-5555-4555-8555-555555555555', (ev) => seenEvents.push(ev))

    const started = await adapter.startAttempt({
      repositoryId: 'repo-1',
      sessionId: '11111111-1111-4111-8111-111111111111',
      attemptId: '55555555-5555-4555-8555-555555555555',
      handle: prep.handle!
    })
    expect(started.status).toBe('RUNNING')

    // Duplicate startAttempt for same attemptId does not fork another worker
    const countBeforeReplay = forkedWorkers.length
    await adapter.startAttempt({
      repositoryId: 'repo-1',
      sessionId: '11111111-1111-4111-8111-111111111111',
      attemptId: '55555555-5555-4555-8555-555555555555',
      handle: prep.handle!
    })
    expect(forkedWorkers.length).toBe(countBeforeReplay)

    await new Promise((r) => setTimeout(r, 30))
    const finalObs = await adapter.observeAttempt({
      repositoryId: 'repo-1',
      sessionId: '11111111-1111-4111-8111-111111111111',
      attemptId: '55555555-5555-4555-8555-555555555555'
    })
    expect(approvalsAsked).toBe(1)
    expect(finalObs.status).toBe('SUCCEEDED')
    expect(finalObs.phase).toBe('TERMINAL')
    expect(finalObs.termination?.confirmed).toBe(true)
    expect(finalObs.result?.billing?.classification).toBe('ZERO_COST_CONFIRMED')
    expect(finalObs.result?.billing?.upstreamCostUsd).toBe(810)
    expect(finalObs.result?.provenance.origin).toBe('CLINE_CORE_SDK')
    expect(seenEvents.map((e) => e.kind)).toContain('COMPLETED')
    expect(JSON.stringify(finalObs)).not.toContain('accessToken')
  })

  it('Gate 2: seleção dinâmica FREE-only fail-closed recusa fallback offline, modelo pago ou promo removida e trava fetch', async () => {
    const fakeSdkOk = {
      fetchClineRecommendedModels: async ({ fetchImpl, catalogLoader }: any) => {
        const res = await fetchImpl('https://api.cline.bot/api/v1/ai/cline/recommended-models')
        const json = await res.json()
        await catalogLoader()
        return json
      },
      getLiveModelsCatalog: async () => ({
        cline: {
          'promo/first-free': { id: 'promo/first-free', pricing: { input: 0, output: 0 }, capabilities: ['tools'] },
          'paid/opus': { id: 'paid/opus', pricing: { input: 15, output: 75 }, capabilities: ['tools'] },
          'promo/missing-pricing': { id: 'promo/missing-pricing', capabilities: ['tools'] }
        }
      })
    }

    const okFetch = (async () =>
      new Response(
        JSON.stringify({
          recommended: [],
          free: [{ id: 'promo/first-free', name: 'First Free', description: '', tags: [] }],
          clinePass: []
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as unknown as typeof fetch

    const dynamicSelected = await resolveFreeClineCatalogSelection(fakeSdkOk as any, {
      fetchImpl: okFetch
    })
    expect(dynamicSelected).toEqual({
      ok: true,
      selectedModelId: 'promo/first-free',
      availableFreeModelIds: ['promo/first-free']
    })

    // Paid model refused even if named explicitly
    const paidRefused = await resolveFreeClineCatalogSelection(fakeSdkOk as any, {
      requestedModelId: 'paid/opus',
      fetchImpl: okFetch
    })
    expect(paidRefused.ok).toBe(false)
    if (!paidRefused.ok) {
      expect(paidRefused.status).toBe('REFUSED')
      expect(paidRefused.reason).toContain('not zero-priced')
    }

    // Removed promo model refused
    const removedRefused = await resolveFreeClineCatalogSelection(fakeSdkOk as any, {
      requestedModelId: 'promo/removed-yesterday',
      fetchImpl: okFetch
    })
    expect(removedRefused.ok).toBe(false)
    if (!removedRefused.ok) {
      expect(removedRefused.status).toBe('REFUSED')
      expect(removedRefused.reason).toContain('absent from live free catalog')
    }

    // Silent bundled fallback rejected when live recommended feed HTTP fails
    const silentFallbackSdk = {
      fetchClineRecommendedModels: async ({ fetchImpl }: any) => {
        try {
          await fetchImpl('https://api.cline.bot/api/v1/ai/cline/recommended-models')
        } catch {}
        return {
          recommended: [],
          free: [{ id: 'promo/first-free', name: 'Cached Fallback', description: '', tags: [] }],
          clinePass: []
        }
      },
      getLiveModelsCatalog: async () => ({
        cline: { 'promo/first-free': { id: 'promo/first-free', pricing: { input: 0, output: 0 } } }
      })
    }
    const offlineFallback = await resolveFreeClineCatalogSelection(silentFallbackSdk as any, {
      fetchImpl: (async () => {
        throw new Error('ENETDOWN')
      }) as unknown as typeof fetch
    })
    expect(offlineFallback.ok).toBe(false)
    if (!offlineFallback.ok) {
      expect(offlineFallback.status).toBe('UNAVAILABLE')
      expect(offlineFallback.reason).toContain('live recommended-models feed could not be verified')
    }

    expect(isZeroPricingModelInfo({ id: 'x', pricing: { input: 0, output: 0.001 } })).toBe(false)

    // Fetch lock blocks model switch and unauthorized origins before hitting network
    let networkCalls = 0
    const lockedFetch = createFreeLockedFetch({
      lockedModelId: 'promo/first-free',
      baseFetch: async () => {
        networkCalls++
        return new Response('{}', { status: 200 })
      }
    })

    await lockedFetch('https://api.cline.bot/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'promo/first-free', messages: [] })
    })
    expect(networkCalls).toBe(1)

    await expect(
      lockedFetch('https://api.cline.bot/api/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'paid/opus', messages: [] })
      })
    ).rejects.toThrow('FREE_MODEL_LOCK_MISMATCH')
    expect(networkCalls).toBe(1)

    await expect(
      lockedFetch('https://proxy.evil.local/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'promo/first-free' })
      })
    ).rejects.toThrow('UNAUTHORIZED_ENDPOINT_ORIGIN')
    expect(networkCalls).toBe(1)
  })

  it('Gate 2: confinamento estrito bloqueia escape por "..", absoluto, symlink, .git e ferramentas shell/web', async () => {
    expect(() => resolveConfinedWorktreePath(worktreeDir, '../outside/secret.txt')).toThrow(
      'PATH_OUTSIDE_BOUND_WORKTREE'
    )
    expect(() =>
      resolveConfinedWorktreePath(worktreeDir, path.join(outsideDir, 'secret.txt'))
    ).toThrow('PATH_OUTSIDE_BOUND_WORKTREE')
    expect(() => resolveConfinedWorktreePath(worktreeDir, '.git/HEAD')).toThrow(
      'PATH_OUTSIDE_BOUND_WORKTREE'
    )
    expect(() => resolveConfinedWorktreePath(worktreeDir, 'cline://cache/1')).toThrow(
      'PATH_OUTSIDE_BOUND_WORKTREE'
    )

    const validPath = resolveConfinedWorktreePath(worktreeDir, 'target.txt', { mustExist: true })
    expect(validPath).toBe(fs.realpathSync(path.join(worktreeDir, 'target.txt')))

    const symlinkTarget = path.join(worktreeDir, 'escape-link')
    let symlinkCreated = false
    try {
      fs.symlinkSync(outsideDir, symlinkTarget, process.platform === 'win32' ? 'junction' : 'dir')
      symlinkCreated = true
    } catch {}
    if (symlinkCreated) {
      expect(() =>
        resolveConfinedWorktreePath(worktreeDir, 'escape-link/secret.txt')
      ).toThrow('PATH_OUTSIDE_BOUND_WORKTREE')
    }

    const executors = createConfinedToolExecutors({
      worktreeRoot: worktreeDir,
      createEditorExecutor: (() => async () => 'edited') as any
    })
    await expect(executors.bash!('whoami', worktreeDir, { agentId: 'a', iteration: 1 })).rejects.toThrow(
      'TOOL_FORBIDDEN_BY_BUILDX_POLICY'
    )
    await expect(
      executors.webFetch!('https://example.com', 'test', { agentId: 'a', iteration: 1 })
    ).rejects.toThrow('TOOL_FORBIDDEN_BY_BUILDX_POLICY')
    await expect(
      executors.readFile!({ path: '../outside/secret.txt' }, { agentId: 'a', iteration: 1 })
    ).rejects.toThrow('PATH_OUTSIDE_BOUND_WORKTREE')
    const safeRead = await executors.readFile!({ path: 'target.txt' }, { agentId: 'a', iteration: 1 })
    expect(safeRead).toContain('1: hello')
  })

  it('Gate 3: classifica cobrança em duas dimensões, erro de cota/auth sem expor token e crash de worker', async () => {
    // Two-dimensional billing classification
    expect(
      classifyClineBillingTwoDimensional({
        reportedTotalCost: 0.002,
        balanceBefore: -100,
        balanceAfter: -100,
        transaction: { costUsd: 810, creditsUsed: 0 },
        billingApiVerified: true
      })
    ).toEqual({
      upstreamCostUsd: 810,
      creditsUsed: 0,
      balanceDelta: 0,
      currency: 'USD',
      classification: 'ZERO_COST_CONFIRMED',
      provenance: 'PROVIDER_BILLING_API'
    })

    expect(
      classifyClineBillingTwoDimensional({
        reportedTotalCost: 0,
        billingApiVerified: false
      })
    ).toEqual({
      upstreamCostUsd: 0,
      currency: 'USD',
      classification: 'UNKNOWN',
      provenance: 'EXECUTOR_REPORTED'
    })

    expect(
      classifyClineBillingTwoDimensional({
        balanceBefore: 500,
        balanceAfter: 450,
        transaction: { costUsd: 50, creditsUsed: 50 },
        billingApiVerified: true
      }).classification
    ).toBe('CHARGED')

    const quotaReason = classifyClineErrorReason({}, new Error('Free model limit reached (429)'), 429)
    expect(quotaReason).toContain('CLINE_FREE_QUOTA_OR_RATE_LIMIT')

    const authReason = classifyClineErrorReason(
      {},
      new Error('401 Unauthorized Bearer workos:secretToken_123'),
      401
    )
    expect(authReason).toContain('CLINE_AUTHENTICATION_FAILED')
    expect(authReason).not.toContain('secretToken_123')

    // Worker unexpected crash cleans isolated storage and reports FAILED + confirmed termination
    let crashedWorker!: MockUtilityWorker
    const crashLauncher: ClineUtilityLauncher = {
      isAvailable: () => true,
      fork: () => {
        const w = new MockUtilityWorker(undefined)
        crashedWorker = w
        const origPost = w.postMessage.bind(w)
        w.postMessage = (req: ClineWorkerRequest) => {
          origPost(req)
          if (req.type === 'prepare_attempt') {
            w.emitWorkerMessage({
              type: 'prepare_result',
              requestId: req.requestId,
              ok: true,
              status: 'READY',
              modelId: req.requestedModelId
            })
            w.emit('exit', 0)
          } else if (req.type === 'start_attempt') {
            w.emitWorkerMessage({
              type: 'attempt_started',
              attemptId: req.attemptId,
              clineSessionId: `buildx-${req.attemptId}`,
              lockedModelId: req.modelId,
              pid: 555666
            })
          }
        }
        setImmediate(() => w.emitReady())
        return w
      }
    }

    const adapter = new ClineSdkExecutorAdapter({
      repositoryId: 'repo-1',
      modelId: 'free/demo-model',
      workerPath: dummyWorkerFile,
      runtimeStorageBaseDir: runtimeDir,
      launcher: crashLauncher
    })

    const attemptId = '66666666-6666-4666-8666-666666666666'
    const prep = await adapter.prepareAttempt({
      repositoryId: 'repo-1',
      sessionId: '11111111-1111-4111-8111-111111111111',
      planId: '22222222-2222-4222-8222-222222222222',
      unitId: '33333333-3333-4333-8333-333333333333',
      attemptId,
      worktree: { worktreeId: 'wt-1', generation: 'gen-1', branch: 'feat/u2', path: worktreeDir },
      prompt: {
        stageOperationId: 'stage-1',
        promptFilePath: path.join(tempRoot, 'prompt.tmp'),
        readPromptText: () => 'Edit target.txt'
      }
    })
    expect(prep.status).toBe('READY')

    await adapter.startAttempt({
      repositoryId: 'repo-1',
      sessionId: '11111111-1111-4111-8111-111111111111',
      attemptId,
      handle: prep.handle!
    })
    expect(fs.existsSync(path.join(runtimeDir, attemptId))).toBe(true)

    crashedWorker.emit('exit', 139)
    await new Promise((r) => setTimeout(r, 25))

    const crashedObs = await adapter.observeAttempt({
      repositoryId: 'repo-1',
      sessionId: '11111111-1111-4111-8111-111111111111',
      attemptId
    })
    expect(crashedObs.status).toBe('FAILED')
    expect(crashedObs.phase).toBe('TERMINAL')
    expect(crashedObs.reason).toBe('CLINE_WORKER_CRASHED_EXIT_139')
    expect(crashedObs.termination?.confirmed).toBe(true)
    expect(fs.existsSync(path.join(runtimeDir, attemptId))).toBe(false)
  })
})
