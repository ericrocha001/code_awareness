import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  ClineAccountUsageTransaction,
  ClineCore as ClineCoreClass,
  CoreSessionEvent,
  SessionUsageSummary,
  ToolApprovalRequest,
  ToolApprovalResult
} from '@cline/sdk' with { 'resolution-mode': 'import' }
import type {
  ExecutorBillingRecord,
  ExecutorEvent,
  ExecutorEventKind,
  ExecutorRunStatus,
  ExecutorSelection,
  ExecutorUsageRecord
} from '../../../../shared/types/buildx/execution-types'
import {
  CLINE_OFFICIAL_API_BASE_URL,
  DEFAULT_CLINE_EXECUTOR_ID,
  DEFAULT_CLINE_PROVIDER_ID,
  type ClineApprovalRequestMessage,
  type ClineStartAttemptRequest,
  type ClineWorkerCleanupReceipt,
  type ClineWorkerMessage,
  type ClineWorkerRequest
} from './cline-sdk-protocol'
import {
  classifyClineBillingTwoDimensional,
  classifyClineErrorReason,
  createFreeLockedFetch,
  resolveFreeClineCatalogSelection,
  sanitizeDiagnostics
} from './cline-free-catalog'
import {
  buildBuildxClineToolPolicies,
  createConfinedToolExecutors,
  extractTargetPathFromToolInput,
  resolveConfinedWorktreePath
} from './cline-worktree-confinement'

type ClineSdkModule = typeof import('@cline/sdk', { with: { 'resolution-mode': 'import' } })

interface WorkerParentChannel {
  postMessage: (message: ClineWorkerMessage) => void
  onMessage: (listener: (message: ClineWorkerRequest) => void) => void
}

function createParentChannel(): WorkerParentChannel {
  const parentPort = (process as unknown as {
    parentPort?: {
      postMessage: (message: unknown) => void
      on: (event: 'message', listener: (ev: { data?: unknown }) => void) => void
    }
  }).parentPort

  if (parentPort && typeof parentPort.postMessage === 'function') {
    return {
      postMessage: (message) => parentPort.postMessage(message),
      onMessage: (listener) => {
        parentPort.on('message', (event) => {
          const payload =
            event && typeof event === 'object' && 'data' in event ? event.data : event
          if (payload && typeof payload === 'object') {
            listener(payload as ClineWorkerRequest)
          }
        })
      }
    }
  }

  if (typeof process.send === 'function') {
    return {
      postMessage: (message) => process.send?.(message),
      onMessage: (listener) => {
        process.on('message', (message) => {
          if (message && typeof message === 'object') {
            listener(message as ClineWorkerRequest)
          }
        })
      }
    }
  }

  throw new Error('WORKER_IPC_UNAVAILABLE: missing Electron parentPort or IPC channel')
}

async function loadClineSdk(): Promise<ClineSdkModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string
  ) => Promise<ClineSdkModule>

  const overrideEntry = process.env.BUILDX_CLINE_SDK_ENTRY?.trim()
  if (overrideEntry && fs.existsSync(overrideEntry)) {
    return dynamicImport(pathToFileURL(overrideEntry).href)
  }

  try {
    return await dynamicImport('@cline/sdk')
  } catch (err) {
    const fallbackCandidate = path.resolve(process.cwd(), 'node_modules/@cline/sdk/dist/index.js')
    if (fs.existsSync(fallbackCandidate)) {
      return dynamicImport(pathToFileURL(fallbackCandidate).href)
    }
    throw err
  }
}

async function resolveOfficialOAuthCredentials(
  sdk: ClineSdkModule,
  settingsFilePath?: string
): Promise<
  | { ok: true; apiKey: string; accountId: string | null }
  | { ok: false; reason: string }
> {
  if (!sdk.isOAuthProvider(DEFAULT_CLINE_PROVIDER_ID)) {
    return { ok: false, reason: 'CLINE_OAUTH_UNSUPPORTED' }
  }

  const settingsManager = new sdk.ProviderSettingsManager(
    settingsFilePath ? { filePath: settingsFilePath } : {}
  )
  const oauthManager = new sdk.RuntimeOAuthTokenManager({
    providerSettingsManager: settingsManager
  })

  try {
    const resolved = await oauthManager.resolveProviderApiKey({
      providerId: DEFAULT_CLINE_PROVIDER_ID
    })
    if (!resolved?.apiKey?.trim()) {
      return {
        ok: false,
        reason: 'CLINE_AUTHENTICATION_FAILED: official Cline OAuth credentials are missing or unauthenticated'
      }
    }
    return {
      ok: true,
      apiKey: resolved.apiKey.trim(),
      accountId: resolved.accountId ?? null
    }
  } catch (error) {
    return {
      ok: false,
      reason: classifyClineErrorReason(sdk, error)
    }
  }
}

function buildConfinedSystemPrompt(worktreeRoot: string): string {
  return [
    'You are executing a bounded BuildX implementation unit inside an authorized Git worktree.',
    `Authorized worktree root: ${worktreeRoot}`,
    'Constraints:',
    '- Only read, search, and edit files strictly inside the authorized worktree root.',
    '- Shell execution, external paths, .git internals modification, web fetch, and subagent spawning are forbidden.',
    '- Complete the unit edit concisely and verify your edited file content before finishing.'
  ].join('\n')
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch(() => {
        clearTimeout(timer)
        resolve(undefined)
      })
  })
}

async function captureAccountBillingSnapshot(
  sdk: ClineSdkModule,
  options: {
    readonly apiBaseUrl: string
    readonly settingsFilePath?: string
    readonly accountId?: string | null
    readonly fetchImpl?: typeof fetch
  }
): Promise<{
  readonly balance: number | null
  readonly transactions: ClineAccountUsageTransaction[]
  readonly verified: boolean
}> {
  try {
    const settingsManager = new sdk.ProviderSettingsManager(
      options.settingsFilePath ? { filePath: options.settingsFilePath } : {}
    )
    const oauthManager = new sdk.RuntimeOAuthTokenManager({
      providerSettingsManager: settingsManager
    })
    const account = new sdk.ClineAccountService({
      apiBaseUrl: options.apiBaseUrl,
      getAuthToken: async () => {
        const res = await oauthManager.resolveProviderApiKey({
          providerId: DEFAULT_CLINE_PROVIDER_ID
        })
        return res?.apiKey
      },
      getCurrentUserId: () => options.accountId ?? null,
      getHeaders: () => sdk.buildClineClientHeaders(),
      requestTimeoutMs: 5000,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
    })

    const [balanceResult, transactionsResult] = await Promise.all([
      account.fetchBalance(options.accountId ?? undefined).catch(() => null),
      account.fetchUsageTransactions(options.accountId ?? undefined).catch(() => null)
    ])

    return {
      balance: typeof balanceResult?.balance === 'number' ? balanceResult.balance : null,
      transactions: Array.isArray(transactionsResult) ? transactionsResult : [],
      verified: typeof balanceResult?.balance === 'number'
    }
  } catch {
    return {
      balance: null,
      transactions: [],
      verified: false
    }
  }
}

function summarizeText(text: string | undefined): string | null {
  if (!text) return null
  const clean = sanitizeDiagnostics(text.trim())
  if (!clean) return null
  return clean.length > 2048 ? `${clean.slice(0, 2045)}...` : clean
}

function buildUsageRecord(summary: SessionUsageSummary | undefined): ExecutorUsageRecord {
  const usage = summary?.aggregateUsage ?? summary?.usage
  if (!usage) {
    return { provenance: 'UNAVAILABLE' }
  }
  const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0
  const outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0
  const cacheReadTokens = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0
  const cacheWriteTokens = typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens,
    provenance: 'EXECUTOR_REPORTED'
  }
}

export async function runWorkerProcess(): Promise<void> {
  const channel = createParentChannel()

  const pendingApprovals = new Map<
    string,
    { resolve: (result: ToolApprovalResult) => void; timer: NodeJS.Timeout }
  >()
  let activeAbortController: AbortController | null = null
  let activeCline: ClineCoreClass | null = null
  let activeSessionId: string | null = null
  let cancelRequestedReason: string | null = null
  let timedOut = false
  let runningAttempt = false

  const rejectAllPendingApprovals = (reason: string) => {
    for (const entry of pendingApprovals.values()) {
      clearTimeout(entry.timer)
      entry.resolve({ approved: false, reason })
    }
    pendingApprovals.clear()
  }

  const handleRequest = async (req: ClineWorkerRequest): Promise<void> => {
    if (req.type === 'approval_response') {
      const pending = pendingApprovals.get(req.toolCallId)
      if (pending) {
        clearTimeout(pending.timer)
        pendingApprovals.delete(req.toolCallId)
        pending.resolve({
          approved: req.approved,
          ...(req.reason ? { reason: req.reason } : {})
        })
      }
      return
    }

    if (req.type === 'cancel_attempt') {
      cancelRequestedReason = req.reason ?? 'USER_CANCELLED'
      rejectAllPendingApprovals(cancelRequestedReason)
      activeAbortController?.abort(new Error(cancelRequestedReason))
      if (activeCline && activeSessionId) {
        await withTimeout(activeCline.abort(activeSessionId, new Error(cancelRequestedReason)), 1500)
        await withTimeout(activeCline.stop(activeSessionId), 1500)
      }
      return
    }

    if (req.type === 'probe_free_catalog') {
      try {
        const sdk = await loadClineSdk()
        const auth = req.requireAuth
          ? await resolveOfficialOAuthCredentials(sdk, req.settingsFilePath)
          : null
        if (auth && !auth.ok) {
          channel.postMessage({
            type: 'catalog_result',
            requestId: req.requestId,
            ok: false,
            errorCode: 'CLINE_AUTHENTICATION_FAILED',
            errorMessage: auth.reason
          })
          return
        }

        const selection = await resolveFreeClineCatalogSelection(sdk, {
          requestedModelId: req.requestedModelId,
          apiBaseUrl: req.apiBaseUrl ?? CLINE_OFFICIAL_API_BASE_URL
        })

        if (!selection.ok) {
          channel.postMessage({
            type: 'catalog_result',
            requestId: req.requestId,
            ok: false,
            errorCode: selection.status,
            errorMessage: selection.reason
          })
          return
        }

        channel.postMessage({
          type: 'catalog_result',
          requestId: req.requestId,
          ok: true,
          selectedModelId: selection.selectedModelId,
          availableFreeModelIds: selection.availableFreeModelIds,
          accountId: auth?.ok ? auth.accountId : null
        })
      } catch (error) {
        channel.postMessage({
          type: 'catalog_result',
          requestId: req.requestId,
          ok: false,
          errorCode: 'FREE_CATALOG_UNAVAILABLE',
          errorMessage: sanitizeDiagnostics(error instanceof Error ? error.message : String(error))
        })
      } finally {
        setTimeout(() => process.exit(0), 20).unref()
      }
      return
    }

    if (req.type === 'prepare_attempt') {
      try {
        const sdk = await loadClineSdk()
        if (!fs.existsSync(req.worktreePath) || !fs.statSync(req.worktreePath).isDirectory()) {
          channel.postMessage({
            type: 'prepare_result',
            requestId: req.requestId,
            ok: false,
            status: 'UNAVAILABLE',
            reason: 'WORKTREE_PATH_UNAVAILABLE',
            errorMessage: `Worktree directory unavailable: ${req.worktreePath}`
          })
          return
        }

        const auth = await resolveOfficialOAuthCredentials(sdk, req.settingsFilePath)
        if (!auth.ok) {
          channel.postMessage({
            type: 'prepare_result',
            requestId: req.requestId,
            ok: false,
            status: 'UNAVAILABLE',
            reason: auth.reason,
            errorMessage: auth.reason
          })
          return
        }

        const freeSelection = await resolveFreeClineCatalogSelection(sdk, {
          requestedModelId: req.requestedModelId,
          apiBaseUrl: req.apiBaseUrl ?? CLINE_OFFICIAL_API_BASE_URL
        })

        if (!freeSelection.ok) {
          channel.postMessage({
            type: 'prepare_result',
            requestId: req.requestId,
            ok: false,
            status: freeSelection.status,
            reason: freeSelection.reason,
            errorMessage: freeSelection.reason
          })
          return
        }

        channel.postMessage({
          type: 'prepare_result',
          requestId: req.requestId,
          ok: true,
          status: 'READY',
          modelId: freeSelection.selectedModelId,
          accountId: auth.accountId
        })
      } catch (error) {
        const message = sanitizeDiagnostics(error instanceof Error ? error.message : String(error))
        channel.postMessage({
          type: 'prepare_result',
          requestId: req.requestId,
          ok: false,
          status: 'UNAVAILABLE',
          reason: message,
          errorMessage: message
        })
      } finally {
        setTimeout(() => process.exit(0), 20).unref()
      }
      return
    }

    if (req.type === 'start_attempt') {
      if (runningAttempt) return
      runningAttempt = true
      await executeStartAttempt(req)
    }
  }

  const executeStartAttempt = async (req: ClineStartAttemptRequest): Promise<void> => {
    const startedAt = Date.now()
    const apiBaseUrl = req.apiBaseUrl ?? CLINE_OFFICIAL_API_BASE_URL
    const clineSessionId = `buildx-${req.attemptId}`
    activeSessionId = clineSessionId

    process.env.CLINE_SESSION_DATA_DIR = path.join(req.isolatedStorageRoot, 'sessions')
    process.env.CLINE_TEAM_DATA_DIR = path.join(req.isolatedStorageRoot, 'teams')
    process.env.CLINE_DB_DATA_DIR = path.join(req.isolatedStorageRoot, 'db')
    fs.mkdirSync(process.env.CLINE_SESSION_DATA_DIR, { recursive: true })
    fs.mkdirSync(process.env.CLINE_TEAM_DATA_DIR, { recursive: true })
    fs.mkdirSync(process.env.CLINE_DB_DATA_DIR, { recursive: true })

    let sdk: ClineSdkModule
    try {
      sdk = await loadClineSdk()
    } catch (error) {
      const reason = sanitizeDiagnostics(error instanceof Error ? error.message : String(error))
      await fsp.rm(req.isolatedStorageRoot, { recursive: true, force: true }).catch(() => {})
      channel.postMessage({
        type: 'attempt_terminal',
        attemptId: req.attemptId,
        clineSessionId,
        status: 'UNAVAILABLE',
        reason,
        durationMs: Date.now() - startedAt,
        cleanup: {
          sessionDeleted: false,
          coreDisposed: false,
          dirRemoved: !fs.existsSync(req.isolatedStorageRoot),
          reason
        }
      })
      setTimeout(() => process.exit(0), 20).unref()
      return
    }

    const worktreeRealRoot = fs.realpathSync(path.resolve(req.worktreePath))
    const selectionProvenance: Pick<ExecutorSelection, 'executorId' | 'providerId' | 'modelId'> = {
      executorId: DEFAULT_CLINE_EXECUTOR_ID,
      providerId: DEFAULT_CLINE_PROVIDER_ID,
      modelId: req.modelId
    }

    const emitEvent = (
      kind: ExecutorEventKind,
      fields?: Partial<Pick<ExecutorEvent, 'phase' | 'status' | 'message' | 'reason'>>
    ) => {
      channel.postMessage({
        type: 'executor_event',
        event: {
          kind,
          attemptId: req.attemptId,
          timestamp: new Date().toISOString(),
          ...fields,
          provenance: selectionProvenance
        }
      })
    }

    const failBeforeStart = async (status: ExecutorRunStatus, reason: string) => {
      await fsp.rm(req.isolatedStorageRoot, { recursive: true, force: true }).catch(() => {})
      channel.postMessage({
        type: 'attempt_terminal',
        attemptId: req.attemptId,
        clineSessionId,
        status,
        reason,
        durationMs: Date.now() - startedAt,
        cleanup: {
          sessionDeleted: false,
          coreDisposed: false,
          dirRemoved: !fs.existsSync(req.isolatedStorageRoot)
        }
      })
      setTimeout(() => process.exit(0), 20).unref()
    }

    const auth = await resolveOfficialOAuthCredentials(sdk, req.settingsFilePath)
    if (!auth.ok) {
      await failBeforeStart('FAILED', auth.reason)
      return
    }

    const freeCheck = await resolveFreeClineCatalogSelection(sdk, {
      requestedModelId: req.modelId,
      apiBaseUrl
    })
    if (!freeCheck.ok) {
      await failBeforeStart(freeCheck.status === 'REFUSED' ? 'REFUSED' : 'FAILED', freeCheck.reason)
      return
    }

    const billingBefore =
      req.captureBilling !== false
        ? await captureAccountBillingSnapshot(sdk, {
            apiBaseUrl,
            settingsFilePath: req.settingsFilePath,
            accountId: auth.accountId
          })
        : { balance: null, transactions: [], verified: false }
    const txIdsBefore = new Set(billingBefore.transactions.map((tx) => tx.id))

    let lastHttpStatus: number | undefined
    activeAbortController = new AbortController()
    const abortSignal = activeAbortController.signal

    const freeLockedFetch = createFreeLockedFetch({
      lockedModelId: freeCheck.selectedModelId,
      allowedBaseUrl: apiBaseUrl,
      baseFetch: async (input, init) =>
        globalThis.fetch(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, abortSignal])
            : abortSignal
        }),
      onHttpStatus: (status) => {
        lastHttpStatus = status
      }
    })

    const toolPolicies = buildBuildxClineToolPolicies(req.allowAutoApprove)
    const confinedExecutors = createConfinedToolExecutors({
      worktreeRoot: worktreeRealRoot,
      createEditorExecutor: sdk.createEditorExecutor
    })

    const requestToolApproval = async (request: ToolApprovalRequest): Promise<ToolApprovalResult> => {
      if (cancelRequestedReason || timedOut) {
        return { approved: false, reason: cancelRequestedReason ?? 'TIMED_OUT' }
      }

      if (
        request.toolName === 'run_commands' ||
        request.toolName === 'fetch_web_content' ||
        request.toolName === 'apply_patch' ||
        request.toolName === 'skills' ||
        request.toolName === 'ask_question'
      ) {
        return { approved: false, reason: `TOOL_FORBIDDEN_BY_BUILDX_POLICY: ${request.toolName}` }
      }

      const targetPath = extractTargetPathFromToolInput(request.toolName, request.input)
      if (targetPath !== undefined) {
        try {
          resolveConfinedWorktreePath(worktreeRealRoot, targetPath, {
            allowRoot: request.toolName === 'search_codebase',
            mustExist: request.toolName === 'read_files'
          })
        } catch (err) {
          return {
            approved: false,
            reason: err instanceof Error ? err.message : 'PATH_OUTSIDE_BOUND_WORKTREE'
          }
        }
      }

      if (request.toolName === 'read_files' || request.toolName === 'search_codebase' || request.toolName === 'submit_and_exit') {
        return { approved: true }
      }

      if (req.allowAutoApprove) {
        return { approved: true }
      }

      emitEvent('APPROVAL_REQUESTED', {
        phase: 'AWAITING_APPROVAL',
        status: 'AWAITING_APPROVAL',
        message: `Approval required for tool "${request.toolName}"`
      })

      const approvalMsg: ClineApprovalRequestMessage = {
        type: 'approval_request',
        attemptId: req.attemptId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        ...(targetPath ? { targetPath } : {}),
        summary: `Authorize ${request.toolName}${targetPath ? ` on ${targetPath}` : ''}`
      }
      channel.postMessage(approvalMsg)

      return await new Promise<ToolApprovalResult>((resolve) => {
        const timer = setTimeout(() => {
          pendingApprovals.delete(request.toolCallId)
          resolve({ approved: false, reason: 'APPROVAL_TIMEOUT' })
        }, Math.min(req.timeoutMs, 60_000))
        pendingApprovals.set(request.toolCallId, { resolve, timer })
      })
    }

    let cline: ClineCoreClass | null = null
    let unsubscribeEvents: (() => void) | null = null
    let sessionDeleted = false
    let coreDisposed = false
    let dirRemoved = false
    let finalSummary: string | null = null
    let usageSummary: SessionUsageSummary | undefined
    let runError: unknown
    let runResultStatus: string | undefined
    let runFinishReason: string | undefined
    let approvalRejectedReason: string | undefined

    const settingsManager = new sdk.ProviderSettingsManager(
      req.settingsFilePath ? { filePath: req.settingsFilePath } : {}
    )
    const oauthManager = new sdk.RuntimeOAuthTokenManager({
      providerSettingsManager: settingsManager
    })

    const watchdogTimer = setTimeout(() => {
      timedOut = true
      cancelRequestedReason = 'TIMED_OUT'
      rejectAllPendingApprovals('TIMED_OUT')
      activeAbortController?.abort(new Error('TIMED_OUT'))
      if (cline && activeSessionId) {
        void withTimeout(cline.abort(activeSessionId, new Error('TIMED_OUT')), 1500)
        void withTimeout(cline.stop(activeSessionId), 1500)
      }
    }, Math.max(1000, req.timeoutMs))

    try {
      const oauthResolution = await oauthManager.resolveProviderApiKey({
        providerId: DEFAULT_CLINE_PROVIDER_ID
      })
      if (!oauthResolution?.apiKey?.trim()) {
        throw new Error('CLINE_AUTHENTICATION_FAILED: unable to resolve Cline OAuth token')
      }

      cline = await sdk.ClineCore.create({
        backendMode: 'local',
        fetch: freeLockedFetch,
        toolPolicies,
        capabilities: {
          toolExecutors: confinedExecutors,
          requestToolApproval
        }
      })
      activeCline = cline

      unsubscribeEvents = cline.subscribe(
        (event: CoreSessionEvent) => {
          if (event.type === 'status') {
            if (event.payload.status === 'running') {
              emitEvent('PROGRESS', { phase: 'RUNNING', status: 'RUNNING' })
            } else if (event.payload.status === 'failed' || event.payload.status === 'aborted') {
              runResultStatus = event.payload.status
            }
          } else if (event.type === 'agent_event') {
            const inner = event.payload.event
            if (inner.type === 'content_start' && inner.contentType === 'tool') {
              emitEvent('TOOL_ACTIVITY', {
                phase: 'RUNNING',
                status: 'RUNNING',
                message: `tool_started:${inner.toolName ?? 'tool'}`
              })
            } else if (inner.type === 'content_end' && inner.contentType === 'tool') {
              const errOut =
                typeof inner.error === 'string'
                  ? inner.error
                  : inner.output && typeof inner.output === 'object'
                    ? JSON.stringify(inner.output)
                    : ''
              if (
                errOut &&
                (errOut.includes('Rejected by') ||
                  errOut.includes('USER_REJECTED') ||
                  errOut.includes('PATH_OUTSIDE_BOUND_WORKTREE') ||
                  errOut.includes('TOOL_FORBIDDEN_BY_BUILDX_POLICY'))
              ) {
                approvalRejectedReason = errOut
              }
              emitEvent('TOOL_ACTIVITY', {
                phase: 'RUNNING',
                status: 'RUNNING',
                message: `tool_finished:${inner.toolName ?? 'tool'}`
              })
            } else if (inner.type === 'done') {
              finalSummary = summarizeText(inner.text) ?? finalSummary
              if (inner.reason !== 'completed') {
                runFinishReason = inner.reason
              }
            } else if (inner.type === 'error') {
              runError = inner.error
            }
          }
        },
        { sessionId: clineSessionId }
      )

      channel.postMessage({
        type: 'attempt_started',
        attemptId: req.attemptId,
        clineSessionId,
        lockedModelId: freeCheck.selectedModelId,
        pid: process.pid
      })

      emitEvent('STARTED', {
        phase: 'RUNNING',
        status: 'RUNNING',
        message: `ClineCore started with locked free model ${freeCheck.selectedModelId}`
      })

      const cleanBaseUrl =
        apiBaseUrl === CLINE_OFFICIAL_API_BASE_URL
          ? undefined
          : `${apiBaseUrl.replace(/\/+$/, '')}/api/v1`

      const startResult = await cline.start({
        source: sdk.SessionSource.CORE,
        mode: 'act',
        interactive: false,
        prompt: req.promptText,
        plugins: { '*': { enabled: false } },
        toolPolicies,
        config: {
          sessionId: clineSessionId,
          providerId: DEFAULT_CLINE_PROVIDER_ID,
          modelId: freeCheck.selectedModelId,
          apiKey: oauthResolution.apiKey.trim(),
          ...(cleanBaseUrl ? { baseUrl: cleanBaseUrl } : {}),
          cwd: worktreeRealRoot,
          workspaceRoot: worktreeRealRoot,
          systemPrompt: buildConfinedSystemPrompt(worktreeRealRoot),
          enableTools: true,
          enableSpawnAgent: false,
          enableAgentTeams: false,
          disableMcpSettingsTools: true,
          mcpApps: false,
          yolo: req.allowAutoApprove,
          maxIterations: req.maxIterations ?? 8,
          ...(req.maxTokensPerTurn !== undefined ? { maxTokensPerTurn: req.maxTokensPerTurn } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          checkpoint: { enabled: false },
          compaction: { enabled: false }
        }
      })

      runFinishReason = startResult.result?.finishReason ?? runFinishReason
      finalSummary = summarizeText(startResult.result?.text) ?? finalSummary
      if (runFinishReason && runFinishReason !== 'completed' && !runError) {
        runError = new Error(startResult.result?.text || `CLINE_FINISH_${runFinishReason.toUpperCase()}`)
      }
      usageSummary = await cline.getAccumulatedUsage(clineSessionId).catch(() => undefined)
    } catch (error) {
      runError = error
    } finally {
      clearTimeout(watchdogTimer)
      rejectAllPendingApprovals('ATTEMPT_ENDED')
      try {
        unsubscribeEvents?.()
      } catch {}

      if (cline) {
        if (!usageSummary) {
          usageSummary = await withTimeout(cline.getAccumulatedUsage(clineSessionId), 1000)
        }
        await withTimeout(cline.stop(clineSessionId), 2000)
        const del = await withTimeout(cline.delete(clineSessionId), 2000)
        sessionDeleted = del === true
        await withTimeout(cline.dispose('attempt_terminal'), 2000)
        coreDisposed = true
        activeCline = null
      }

      try {
        await fsp.rm(req.isolatedStorageRoot, { recursive: true, force: true })
        dirRemoved = !fs.existsSync(req.isolatedStorageRoot)
      } catch {
        dirRemoved = !fs.existsSync(req.isolatedStorageRoot)
      }
    }

    const billingAfter =
      req.captureBilling !== false
        ? await captureAccountBillingSnapshot(sdk, {
            apiBaseUrl,
            settingsFilePath: req.settingsFilePath,
            accountId: auth.accountId
          })
        : { balance: null, transactions: [], verified: false }

    const matchedTransaction = billingAfter.transactions.find((tx) => !txIdsBefore.has(tx.id)) ?? null
    const sdkUsage = buildUsageRecord(usageSummary)
    const reportedTotalCost =
      usageSummary?.aggregateUsage?.totalCost ?? usageSummary?.usage?.totalCost ?? null
    const billing: ExecutorBillingRecord = classifyClineBillingTwoDimensional({
      reportedTotalCost,
      balanceBefore: billingBefore.balance,
      balanceAfter: billingAfter.balance,
      transaction: matchedTransaction,
      billingApiVerified: billingBefore.verified && billingAfter.verified
    })

    let status: ExecutorRunStatus
    let reason: string | undefined

    if (timedOut) {
      status = 'TIMED_OUT'
      reason = 'TIMED_OUT'
    } else if (cancelRequestedReason) {
      status = 'CANCELLED'
      reason = cancelRequestedReason
    } else if (
      runError ||
      runResultStatus === 'failed' ||
      runResultStatus === 'aborted' ||
      (runFinishReason && runFinishReason !== 'completed')
    ) {
      const classified = classifyClineErrorReason(sdk, runError ?? runFinishReason ?? runResultStatus, lastHttpStatus)
      reason = classified
      status =
        classified.includes('FREE_MODEL_LOCK_MISMATCH') ||
        classified.includes('FREE_MODEL_NOT_ELIGIBLE') ||
        classified.includes('UNAUTHORIZED_ENDPOINT_ORIGIN')
          ? 'REFUSED'
          : 'FAILED'
    } else if (approvalRejectedReason && !req.allowAutoApprove) {
      status = 'REFUSED'
      reason = approvalRejectedReason
    } else if (billing.classification === 'CHARGED') {
      status = 'FAILED'
      reason = 'UNEXPECTED_ACCOUNT_CHARGE'
    } else {
      status = 'SUCCEEDED'
    }

    const cleanup: ClineWorkerCleanupReceipt = {
      sessionDeleted,
      coreDisposed,
      dirRemoved
    }

    const terminalEventKind: ExecutorEventKind =
      status === 'SUCCEEDED'
        ? 'COMPLETED'
        : status === 'CANCELLED'
          ? 'CANCELLED'
          : status === 'TIMED_OUT'
            ? 'TIMED_OUT'
            : status === 'REFUSED'
              ? 'REFUSED'
              : 'FAILED'

    emitEvent(terminalEventKind, {
      phase: 'TERMINAL',
      status,
      ...(reason ? { reason } : {}),
      ...(finalSummary ? { message: finalSummary } : {})
    })

    channel.postMessage({
      type: 'attempt_terminal',
      attemptId: req.attemptId,
      clineSessionId,
      status,
      ...(reason ? { reason } : {}),
      durationMs: Date.now() - startedAt,
      ...(finalSummary ? { summary: finalSummary } : {}),
      usage: sdkUsage,
      billing,
      cleanup
    })

    setTimeout(() => process.exit(0), 25).unref()
  }

  channel.onMessage((msg) => {
    void handleRequest(msg).catch((err) => {
      const text = sanitizeDiagnostics(err instanceof Error ? err.message : String(err))
      if (activeSessionId && msg && 'attemptId' in msg && typeof msg.attemptId === 'string') {
        channel.postMessage({
          type: 'attempt_terminal',
          attemptId: msg.attemptId,
          clineSessionId: activeSessionId,
          status: 'FAILED',
          reason: text,
          durationMs: 0,
          cleanup: {
            sessionDeleted: false,
            coreDisposed: false,
            dirRemoved: false,
            reason: text
          }
        })
      }
      setTimeout(() => process.exit(1), 25).unref()
    })
  })

  channel.postMessage({ type: 'ready' })
}

if (typeof require === 'function' && typeof module === 'object' && require.main === module) {
  void runWorkerProcess()
} else if (
  (process as unknown as { parentPort?: unknown }).parentPort ||
  typeof process.send === 'function'
) {
  void runWorkerProcess()
}
