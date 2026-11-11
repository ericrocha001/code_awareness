import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {
  CancelExecutorAttemptInput,
  ExecutorAvailabilityResult,
  ExecutorEvent,
  ExecutorPreparationResult,
  ExecutorRunObservation,
  ExecutorRunStatus,
  ExecutorSelection,
  ExecutorTerminationConfirmation,
  ObserveExecutorAttemptInput,
  PrepareExecutorAttemptInput,
  StartExecutorAttemptInput
} from '../../../../shared/types/buildx/execution-types'
import type { CliPolicy } from '../../../../shared/types/cli-policy-types'
import { normalizeExecutorSelection, type UnitExecutorPort } from '../../execution/executor-port'
import { sanitizeDiagnostics } from './cline-free-catalog'
import {
  CLINE_DEFAULT_TIMEOUT_MS,
  CLINE_MAX_TIMEOUT_MS,
  DEFAULT_CLINE_EXECUTOR_ID,
  DEFAULT_CLINE_PROVIDER_ID,
  type ClineApprovalRequestMessage,
  type ClineCatalogResultMessage,
  type ClinePrepareResultMessage,
  type ClineWorkerMessage,
  type ClineWorkerRequest
} from './cline-sdk-protocol'

export interface SpawnedClineWorker {
  readonly pid: number | undefined
  readonly stdout?: NodeJS.ReadableStream | null
  readonly stderr?: NodeJS.ReadableStream | null
  postMessage: (message: ClineWorkerRequest) => void
  on: {
    (event: 'message', listener: (message: ClineWorkerMessage) => void): void
    (event: 'exit', listener: (code: number) => void): void
    (event: 'error', listener: (type: string, location?: string, report?: string) => void): void
    (event: 'spawn', listener: () => void): void
  }
  kill: () => boolean
}

export interface ClineUtilityLauncher {
  isAvailable: () => boolean
  fork: (
    modulePath: string,
    args?: string[],
    options?: {
      cwd?: string
      env?: NodeJS.ProcessEnv
      serviceName?: string
      stdio?: Array<'pipe' | 'ignore' | 'inherit'>
    }
  ) => SpawnedClineWorker
}

export interface ClineWorktreeAuthorityResolution {
  readonly path: string
  readonly branch?: string
  readonly reference?: boolean
}

export interface ClineSdkApprovalRequest {
  readonly attemptId: string
  readonly repositoryId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly targetPath?: string
  readonly summary: string
}

export interface ClineSdkExecutorAdapterOptions {
  readonly executorId?: string
  readonly providerId?: string | null
  readonly modelId?: string | null
  readonly repositoryId?: string | null
  readonly workerPath?: string
  readonly runtimeStorageBaseDir?: string
  readonly timeoutMs?: number
  readonly cancelGraceMs?: number
  readonly apiBaseUrl?: string
  readonly settingsFilePath?: string
  readonly captureBilling?: boolean
  readonly maxIterations?: number
  readonly maxTokensPerTurn?: number
  readonly temperature?: number
  readonly getPolicy?: (worktree: {
    repositoryId: string
    worktreeId: string
    generation: string
    path: string
  }) => Promise<CliPolicy> | CliPolicy
  readonly resolveWorktree?: (selector: {
    repositoryId: string
    worktreeId: string
    generation: string
  }) => Promise<ClineWorktreeAuthorityResolution>
  readonly approvalHandler?: (request: ClineSdkApprovalRequest) => Promise<boolean>
  readonly launcher?: ClineUtilityLauncher
}

interface PreparedAttemptEntry {
  readonly preparedAttemptId: string
  readonly attemptId: string
  readonly repositoryId: string
  readonly worktreePath: string
  readonly promptText: string
  readonly modelId: string
  readonly allowAutoApprove: boolean
  readonly timeoutMs: number
}

interface ActiveAttemptRuntime {
  readonly attemptId: string
  readonly worktreePath: string
  readonly isolatedStorageRoot: string
  readonly startedAt: number
  worker: SpawnedClineWorker | null
  capturedPid: number | undefined
  exited: boolean
  exitCode: number | null
  treeConfirmedDead: boolean
  cleanupReceipt?: { sessionDeleted: boolean; coreDisposed: boolean; dirRemoved: boolean; reason?: string }
  observation: ExecutorRunObservation
  events: ExecutorEvent[]
  cancelPromise?: Promise<ExecutorRunObservation>
  exitPromise: Promise<number>
  resolveExit: (code: number) => void
}

function resolveElectronModule(): {
  app?: { isReady: () => boolean }
  utilityProcess?: {
    fork: (
      modulePath: string,
      args?: string[],
      options?: Record<string, unknown>
    ) => SpawnedClineWorker
  }
} | null {
  try {
    // Load Electron lazily so Node-lane tests never require browser runtime unless called.
    const electronMod = require('electron') as {
      app?: { isReady: () => boolean }
      utilityProcess?: {
        fork: (
          modulePath: string,
          args?: string[],
          options?: Record<string, unknown>
        ) => SpawnedClineWorker
      }
    }
    return electronMod && typeof electronMod === 'object' ? electronMod : null
  } catch {
    return null
  }
}

export function createElectronUtilityLauncher(): ClineUtilityLauncher {
  return {
    isAvailable: () => {
      const electronMod = resolveElectronModule()
      return Boolean(
        electronMod?.utilityProcess &&
          typeof electronMod.utilityProcess.fork === 'function' &&
          (!electronMod.app || electronMod.app.isReady())
      )
    },
    fork: (modulePath, args = [], options = {}) => {
      const electronMod = resolveElectronModule()
      if (!electronMod?.utilityProcess || typeof electronMod.utilityProcess.fork !== 'function') {
        throw new Error('ELECTRON_UTILITY_PROCESS_UNAVAILABLE')
      }
      if (electronMod.app && !electronMod.app.isReady()) {
        throw new Error('ELECTRON_APP_NOT_READY')
      }
      return electronMod.utilityProcess.fork(modulePath, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
        serviceName: options.serviceName ?? 'BuildX ClineSDK Worker'
      })
    }
  }
}

export function resolveDefaultClineWorkerPath(): string {
  const jsSibling = path.join(__dirname, 'cline-sdk-worker.js')
  if (fs.existsSync(jsSibling)) return jsSibling
  const builtMain = path.resolve(process.cwd(), 'out/main/cline-sdk-worker.js')
  if (fs.existsSync(builtMain)) return builtMain
  const cjsSibling = path.join(__dirname, 'cline-sdk-worker.cjs')
  if (fs.existsSync(cjsSibling)) return cjsSibling
  return jsSibling
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    const code = (error as { code?: string })?.code
    return code === 'EPERM'
  }
}

async function execFileSafe(
  command: string,
  args: string[],
  timeoutMs = 3000
): Promise<{ ok: boolean; stdout: string }> {
  return await new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: timeoutMs }, (err, stdout) => {
      resolve({ ok: !err, stdout: String(stdout ?? '') })
    })
  })
}

async function terminateProcessTree(pid: number | undefined, fallbackKill?: () => boolean): Promise<boolean> {
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    fallbackKill?.()
    return true
  }

  if (process.platform === 'win32') {
    await execFileSafe('taskkill', ['/PID', String(pid), '/T', '/F'], 4000)
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
    fallbackKill?.()
  }

  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 40))
  }
  return !isPidAlive(pid)
}

function resolveSdkModuleEntryPath(): string | undefined {
  try {
    const pkgDir = path.dirname(require.resolve('@cline/sdk/package.json'))
    const entry = path.join(pkgDir, 'dist', 'index.js')
    return fs.existsSync(entry) ? entry : undefined
  } catch {
    const direct = path.resolve(process.cwd(), 'node_modules/@cline/sdk/dist/index.js')
    return fs.existsSync(direct) ? direct : undefined
  }
}

function collectWorkerOutput(child: SpawnedClineWorker): () => string {
  let buffer = ''
  const append = (chunk: unknown) => {
    buffer += String(chunk)
    if (buffer.length > 4096) {
      buffer = buffer.slice(-4096)
    }
  }
  child.stderr?.on('data', append)
  child.stdout?.on('data', append)
  return () => sanitizeDiagnostics(buffer.trim())
}

function buildWorkerEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  isolatedStorageRoot?: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  const sdkEntry = resolveSdkModuleEntryPath()
  if (sdkEntry && !env.BUILDX_CLINE_SDK_ENTRY) {
    env.BUILDX_CLINE_SDK_ENTRY = sdkEntry
  }
  if (isolatedStorageRoot) {
    env.CLINE_SESSION_DATA_DIR = path.join(isolatedStorageRoot, 'sessions')
    env.CLINE_TEAM_DATA_DIR = path.join(isolatedStorageRoot, 'teams')
    env.CLINE_DB_DATA_DIR = path.join(isolatedStorageRoot, 'db')
  }
  return env
}

export async function probeFreeClineCatalogSelection(options?: {
  readonly requestedModelId?: string | null
  readonly workerPath?: string
  readonly launcher?: ClineUtilityLauncher
  readonly apiBaseUrl?: string
  readonly settingsFilePath?: string
  readonly requireAuth?: boolean
  readonly timeoutMs?: number
}): Promise<{
  readonly selectedModelId: string
  readonly availableFreeModelIds: readonly string[]
  readonly accountId?: string | null
}> {
  const launcher = options?.launcher ?? createElectronUtilityLauncher()
  const workerPath = options?.workerPath ?? resolveDefaultClineWorkerPath()

  if (!launcher.isAvailable()) {
    throw new Error('ELECTRON_UTILITY_PROCESS_UNAVAILABLE')
  }
  if (!fs.existsSync(workerPath)) {
    throw new Error(`CLINE_WORKER_NOT_FOUND: ${workerPath}`)
  }

  const requestId = randomUUID()
  const timeoutMs = options?.timeoutMs ?? 15_000
  const env = buildWorkerEnvironment(process.env)

  return await new Promise((resolve, reject) => {
    const child = launcher.fork(workerPath, [], {
      cwd: process.cwd(),
      env,
      serviceName: 'BuildX ClineSDK Catalog Probe'
    })
    const getWorkerOutput = collectWorkerOutput(child)

    let settled = false
    let capturedPid = child.pid
    const timer = setTimeout(() => {
      void terminateProcessTree(capturedPid, () => child.kill()).finally(() => {
        if (!settled) {
          settled = true
          reject(new Error('CLINE_CATALOG_PROBE_TIMEOUT'))
        }
      })
    }, timeoutMs)

    const finish = (err?: Error, value?: { selectedModelId: string; availableFreeModelIds: readonly string[]; accountId?: string | null }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(value!)
    }

    child.on('spawn', () => {
      capturedPid = child.pid ?? capturedPid
    })

    child.on('message', (msg: ClineWorkerMessage) => {
      capturedPid = child.pid ?? capturedPid
      if (msg.type === 'ready') {
        child.postMessage({
          type: 'probe_free_catalog',
          requestId,
          requestedModelId: options?.requestedModelId ?? null,
          ...(options?.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
          ...(options?.settingsFilePath ? { settingsFilePath: options.settingsFilePath } : {}),
          requireAuth: options?.requireAuth === true
        })
      } else if (msg.type === 'catalog_result' && msg.requestId === requestId) {
        if (!msg.ok || !msg.selectedModelId) {
          finish(new Error(msg.errorMessage ?? msg.errorCode ?? 'FREE_CATALOG_UNAVAILABLE'))
        } else {
          finish(undefined, {
            selectedModelId: msg.selectedModelId,
            availableFreeModelIds: msg.availableFreeModelIds ?? [msg.selectedModelId],
            accountId: msg.accountId ?? null
          })
        }
      }
    })

    child.on('error', (type, location) => {
      finish(new Error(`CLINE_WORKER_ERROR: ${type}${location ? ` (${location})` : ''}`))
    })

    child.on('exit', (code) => {
      if (!settled) {
        const output = getWorkerOutput()
        finish(
          new Error(
            `CLINE_WORKER_EXITED_BEFORE_RESULT: code=${code}${output ? `: ${output}` : ''}`
          )
        )
      }
    })
  })
}

export class ClineSdkExecutorAdapter implements UnitExecutorPort {
  readonly identity: ExecutorSelection
  private readonly options: ClineSdkExecutorAdapterOptions
  private readonly launcher: ClineUtilityLauncher
  private readonly workerPath: string
  private readonly runtimeStorageBaseDir: string
  private readonly preparedHandles = new Map<string, PreparedAttemptEntry>()
  private readonly activeAttempts = new Map<string, ActiveAttemptRuntime>()
  private readonly listeners = new Map<string, Set<(event: ExecutorEvent) => void>>()

  constructor(options?: ClineSdkExecutorAdapterOptions) {
    this.options = options ?? {}
    this.launcher = options?.launcher ?? createElectronUtilityLauncher()
    this.workerPath = options?.workerPath ?? resolveDefaultClineWorkerPath()
    this.runtimeStorageBaseDir =
      options?.runtimeStorageBaseDir ?? path.join(os.tmpdir(), 'code-awareness-cline-sdk-runtime')

    this.identity = Object.freeze(
      normalizeExecutorSelection({
        executorId: options?.executorId ?? DEFAULT_CLINE_EXECUTOR_ID,
        providerId: options?.providerId !== undefined ? options.providerId : DEFAULT_CLINE_PROVIDER_ID,
        modelId: options?.modelId ?? null
      })
    )
  }

  static async createForLiveFreeAttempt(
    options: Omit<ClineSdkExecutorAdapterOptions, 'modelId'> & {
      readonly requestedModelId?: string | null
      readonly requireAuth?: boolean
    }
  ): Promise<ClineSdkExecutorAdapter> {
    const resolved = await probeFreeClineCatalogSelection({
      requestedModelId: options.requestedModelId,
      workerPath: options.workerPath,
      launcher: options.launcher,
      apiBaseUrl: options.apiBaseUrl,
      settingsFilePath: options.settingsFilePath,
      requireAuth: options.requireAuth
    })
    return new ClineSdkExecutorAdapter({
      ...options,
      modelId: resolved.selectedModelId
    })
  }

  checkAvailability(repositoryId: string): ExecutorAvailabilityResult {
    if (this.options.repositoryId && this.options.repositoryId !== repositoryId) {
      return { available: false, reason: 'CLINE_REPOSITORY_MISMATCH' }
    }
    if (!this.launcher.isAvailable()) {
      return { available: false, reason: 'ELECTRON_UTILITY_PROCESS_UNAVAILABLE' }
    }
    if (!fs.existsSync(this.workerPath)) {
      return { available: false, reason: `CLINE_WORKER_NOT_FOUND: ${this.workerPath}` }
    }
    return { available: true }
  }

  async prepareAttempt(input: PrepareExecutorAttemptInput): Promise<ExecutorPreparationResult> {
    const avail = this.checkAvailability(input.repositoryId)
    if (!avail.available) {
      return {
        status: 'UNAVAILABLE',
        reason: avail.reason ?? 'CLINE_EXECUTOR_UNAVAILABLE'
      }
    }

    if (!this.identity.modelId) {
      return {
        status: 'REFUSED',
        reason: 'FREE_MODEL_ID_REQUIRED'
      }
    }

    let resolvedWorktree: ClineWorktreeAuthorityResolution
    try {
      if (this.options.resolveWorktree) {
        resolvedWorktree = await this.options.resolveWorktree({
          repositoryId: input.repositoryId,
          worktreeId: input.worktree.worktreeId,
          generation: input.worktree.generation
        })
      } else if (input.worktree.path) {
        resolvedWorktree = { path: input.worktree.path, branch: input.worktree.branch }
      } else {
        return {
          status: 'UNAVAILABLE',
          reason: 'WORKTREE_PATH_UNAVAILABLE'
        }
      }
    } catch (err) {
      return {
        status: 'UNAVAILABLE',
        reason: `WORKTREE_AUTHORITY_ERROR: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    if (resolvedWorktree.reference === true) {
      return {
        status: 'REFUSED',
        reason: 'REFERENCE_CHECKOUT_FORBIDDEN'
      }
    }

    if (
      !resolvedWorktree.path ||
      !fs.existsSync(resolvedWorktree.path) ||
      !fs.statSync(resolvedWorktree.path).isDirectory()
    ) {
      return {
        status: 'UNAVAILABLE',
        reason: 'WORKTREE_PATH_UNAVAILABLE'
      }
    }
    const physicalWorktreePath = fs.realpathSync(resolvedWorktree.path)

    let hostPolicy: CliPolicy | undefined
    if (this.options.getPolicy) {
      try {
        hostPolicy = await this.options.getPolicy({
          repositoryId: input.repositoryId,
          worktreeId: input.worktree.worktreeId,
          generation: input.worktree.generation,
          path: physicalWorktreePath
        })
      } catch (err) {
        return {
          status: 'UNAVAILABLE',
          reason: `HOST_POLICY_ERROR: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    }

    const hostYoloAuthorized =
      hostPolicy?.mode === 'AUTONOMOUS_TRUSTED' &&
      hostPolicy?.scope === 'REPOSITORY_WORKTREES'

    if (hostPolicy !== undefined && input.allowAlwaysApprove === true && !hostYoloAuthorized) {
      return {
        status: 'REFUSED',
        reason: 'POLICY_CHANGED'
      }
    }

    const allowAutoApprove = hostPolicy !== undefined ? hostYoloAuthorized : input.allowAlwaysApprove === true

    let promptText: string
    try {
      promptText = input.prompt.readPromptText
        ? input.prompt.readPromptText()
        : fs.readFileSync(input.prompt.promptFilePath, 'utf8')
    } catch (err) {
      return {
        status: 'UNAVAILABLE',
        reason: `PROMPT_READ_ERROR: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    if (!promptText.trim()) {
      return {
        status: 'UNAVAILABLE',
        reason: 'PROMPT_EMPTY'
      }
    }

    const preflight = await this.runWorkerPreparePreflight({
      attemptId: input.attemptId,
      repositoryId: input.repositoryId,
      worktreePath: physicalWorktreePath,
      requestedModelId: this.identity.modelId
    })

    if (!preflight.ok) {
      return {
        status: preflight.status,
        reason: preflight.reason ?? preflight.errorMessage ?? 'CLINE_PREPARE_FAILED'
      }
    }

    const timeoutMs = Math.max(
      1000,
      Math.min(
        input.timeoutMs ?? this.options.timeoutMs ?? CLINE_DEFAULT_TIMEOUT_MS,
        CLINE_MAX_TIMEOUT_MS
      )
    )
    const preparedAttemptId = `cline-prep-${randomUUID()}`

    this.preparedHandles.set(preparedAttemptId, {
      preparedAttemptId,
      attemptId: input.attemptId,
      repositoryId: input.repositoryId,
      worktreePath: physicalWorktreePath,
      promptText,
      modelId: this.identity.modelId,
      allowAutoApprove,
      timeoutMs
    })

    return {
      status: 'READY',
      handle: {
        preparedAttemptId,
        selection: this.identity,
        timeoutProfile: 'BUILDX_AGENTIC_UNIT',
        timeoutMs
      }
    }
  }

  async startAttempt(input: StartExecutorAttemptInput): Promise<ExecutorRunObservation> {
    const cleanAttemptId = input.attemptId.trim().toLowerCase()
    const existing = this.activeAttempts.get(cleanAttemptId)
    if (existing) {
      return existing.observation
    }

    const prepared = this.preparedHandles.get(input.handle.preparedAttemptId)
    if (!prepared || prepared.attemptId.trim().toLowerCase() !== cleanAttemptId) {
      return {
        attemptId: input.attemptId,
        status: 'UNAVAILABLE',
        phase: 'TERMINAL',
        selection: this.identity,
        reason: 'PREPARED_HANDLE_INVALID',
        termination: { confirmed: true, activeProcesses: 0, handlesClosed: true }
      }
    }
    this.preparedHandles.delete(input.handle.preparedAttemptId)

    const avail = this.checkAvailability(input.repositoryId)
    if (!avail.available) {
      return {
        attemptId: input.attemptId,
        status: 'UNAVAILABLE',
        phase: 'TERMINAL',
        selection: this.identity,
        reason: avail.reason ?? 'CLINE_EXECUTOR_UNAVAILABLE',
        termination: { confirmed: true, activeProcesses: 0, handlesClosed: true }
      }
    }

    const isolatedStorageRoot = path.join(this.runtimeStorageBaseDir, cleanAttemptId)
    fs.mkdirSync(isolatedStorageRoot, { recursive: true })

    let resolveExit!: (code: number) => void
    const exitPromise = new Promise<number>((resolve) => {
      resolveExit = resolve
    })

    const runtime: ActiveAttemptRuntime = {
      attemptId: input.attemptId,
      worktreePath: prepared.worktreePath,
      isolatedStorageRoot,
      startedAt: Date.now(),
      worker: null,
      capturedPid: undefined,
      exited: false,
      exitCode: null,
      treeConfirmedDead: false,
      events: [],
      exitPromise,
      resolveExit,
      observation: {
        attemptId: input.attemptId,
        status: 'RUNNING',
        phase: 'LAUNCHING',
        selection: this.identity,
        timeoutProfile: 'BUILDX_AGENTIC_UNIT',
        timeoutMs: prepared.timeoutMs
      }
    }
    this.activeAttempts.set(cleanAttemptId, runtime)

    const env = buildWorkerEnvironment(process.env, isolatedStorageRoot)
    const child = this.launcher.fork(this.workerPath, [], {
      cwd: prepared.worktreePath,
      env,
      serviceName: `BuildX ClineSDK ${cleanAttemptId.slice(0, 8)}`
    })
    runtime.worker = child
    runtime.capturedPid = child.pid

    let handshakeSettled = false
    let resolveHandshake!: (obs: ExecutorRunObservation) => void
    const handshakePromise = new Promise<ExecutorRunObservation>((resolve) => {
      resolveHandshake = resolve
    })

    const handshakeTimer = setTimeout(() => {
      if (!handshakeSettled) {
        handshakeSettled = true
        void this.forceTerminateRuntime(runtime, 'TIMED_OUT', 'CLINE_WORKER_HANDSHAKE_TIMEOUT').then(
          () => resolveHandshake(runtime.observation)
        )
      }
    }, 15_000)

    const settleHandshake = (obs: ExecutorRunObservation) => {
      if (handshakeSettled) return
      handshakeSettled = true
      clearTimeout(handshakeTimer)
      resolveHandshake(obs)
    }

    child.on('spawn', () => {
      runtime.capturedPid = child.pid ?? runtime.capturedPid
    })

    child.on('message', (msg: ClineWorkerMessage) => {
      runtime.capturedPid = child.pid ?? runtime.capturedPid

      if (msg.type === 'ready') {
        child.postMessage({
          type: 'start_attempt',
          requestId: randomUUID(),
          attemptId: input.attemptId,
          repositoryId: input.repositoryId,
          unitflowSessionId: input.sessionId,
          worktreePath: prepared.worktreePath,
          modelId: prepared.modelId,
          promptText: prepared.promptText,
          allowAutoApprove: prepared.allowAutoApprove,
          timeoutMs: prepared.timeoutMs,
          isolatedStorageRoot,
          ...(this.options.apiBaseUrl ? { apiBaseUrl: this.options.apiBaseUrl } : {}),
          ...(this.options.settingsFilePath ? { settingsFilePath: this.options.settingsFilePath } : {}),
          captureBilling: this.options.captureBilling !== false,
          ...(this.options.maxIterations !== undefined ? { maxIterations: this.options.maxIterations } : {}),
          ...(this.options.maxTokensPerTurn !== undefined ? { maxTokensPerTurn: this.options.maxTokensPerTurn } : {}),
          ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {})
        })
        return
      }

      if (msg.type === 'attempt_started' && msg.attemptId === input.attemptId) {
        runtime.capturedPid = msg.pid || runtime.capturedPid
        runtime.observation = {
          ...runtime.observation,
          status: 'RUNNING',
          phase: 'RUNNING'
        }
        settleHandshake(runtime.observation)
        return
      }

      if (msg.type === 'executor_event' && msg.event.attemptId === input.attemptId) {
        runtime.events.push(msg.event)
        if (msg.event.status === 'AWAITING_APPROVAL') {
          runtime.observation = {
            ...runtime.observation,
            status: 'AWAITING_APPROVAL',
            phase: 'AWAITING_APPROVAL'
          }
        } else if (runtime.observation.phase === 'AWAITING_APPROVAL' && msg.event.status === 'RUNNING') {
          runtime.observation = {
            ...runtime.observation,
            status: 'RUNNING',
            phase: 'RUNNING'
          }
        }
        this.emitToListeners(cleanAttemptId, msg.event)
        return
      }

      if (msg.type === 'approval_request' && msg.attemptId === input.attemptId) {
        void this.handleWorkerApprovalRequest(runtime, msg)
        return
      }

      if (msg.type === 'attempt_terminal' && msg.attemptId === input.attemptId) {
        runtime.cleanupReceipt = msg.cleanup
        runtime.observation = {
          attemptId: input.attemptId,
          status: msg.status,
          phase: 'TERMINAL',
          selection: this.identity,
          ...(msg.reason ? { reason: msg.reason } : {}),
          exitCode: null,
          durationMs: msg.durationMs,
          timeoutProfile: 'BUILDX_AGENTIC_UNIT',
          timeoutMs: prepared.timeoutMs,
          events: [...runtime.events],
          result: {
            summary: msg.summary ?? null,
            usage: msg.usage ?? { provenance: 'UNAVAILABLE' },
            billing: msg.billing ?? { classification: 'UNKNOWN', provenance: 'UNAVAILABLE' },
            externalSessionId: msg.clineSessionId,
            provenance: {
              executorId: this.identity.executorId,
              providerId: this.identity.providerId ?? null,
              modelId: this.identity.modelId ?? null,
              origin: 'CLINE_CORE_SDK'
            }
          },
          termination: {
            confirmed: false,
            reason: 'WAITING_FOR_WORKER_EXIT'
          }
        }
        settleHandshake(runtime.observation)
      }
    })

    child.on('error', (type, location) => {
      if (runtime.observation.phase !== 'TERMINAL') {
        runtime.observation = {
          ...runtime.observation,
          status: 'FAILED',
          reason: `CLINE_WORKER_FATAL_ERROR: ${type}${location ? ` (${location})` : ''}`
        }
      }
    })

    child.on('exit', (code) => {
      void this.onWorkerExited(runtime, code, settleHandshake)
    })

    return await handshakePromise
  }

  async observeAttempt(input: ObserveExecutorAttemptInput): Promise<ExecutorRunObservation> {
    const cleanAttemptId = input.attemptId.trim().toLowerCase()
    const runtime = this.activeAttempts.get(cleanAttemptId)
    if (!runtime) {
      return {
        attemptId: input.attemptId,
        status: 'UNKNOWN',
        phase: 'TERMINAL',
        selection: this.identity,
        reason: 'ATTEMPT_NOT_FOUND_IN_ADAPTER',
        termination: { confirmed: false, reason: 'ATTEMPT_NOT_FOUND_IN_ADAPTER' }
      }
    }

    if (runtime.cleanupReceipt && !runtime.exited) {
      await Promise.race([
        runtime.exitPromise,
        new Promise((resolve) => setTimeout(resolve, 2500))
      ])
    }

    if (runtime.exited && !runtime.treeConfirmedDead) {
      await this.finalizeTerminationCheck(runtime)
    }

    return runtime.observation
  }

  async cancelAttempt(input: CancelExecutorAttemptInput): Promise<ExecutorRunObservation> {
    const cleanAttemptId = input.attemptId.trim().toLowerCase()
    const runtime = this.activeAttempts.get(cleanAttemptId)
    if (!runtime) {
      return {
        attemptId: input.attemptId,
        status: 'UNKNOWN',
        phase: 'TERMINATION_UNCONFIRMED',
        selection: this.identity,
        reason: 'ATTEMPT_NOT_FOUND_IN_ADAPTER',
        termination: { confirmed: false, reason: 'ATTEMPT_NOT_FOUND_IN_ADAPTER' }
      }
    }

    if (runtime.exited && runtime.treeConfirmedDead) {
      return runtime.observation
    }

    if (runtime.cancelPromise) {
      return await runtime.cancelPromise
    }

    runtime.cancelPromise = this.performCancellation(runtime)
    return await runtime.cancelPromise
  }

  async confirmTermination(input: ObserveExecutorAttemptInput): Promise<ExecutorTerminationConfirmation> {
    const cleanAttemptId = input.attemptId.trim().toLowerCase()
    const runtime = this.activeAttempts.get(cleanAttemptId)
    if (runtime && !runtime.exited && (runtime.cleanupReceipt || runtime.observation.phase === 'TERMINAL')) {
      await Promise.race([
        runtime.exitPromise,
        new Promise((resolve) => setTimeout(resolve, 2500))
      ])
    }
    const obs = await this.observeAttempt(input)
    if (obs.termination) return obs.termination
    return {
      confirmed: false,
      reason: obs.reason ?? 'TERMINATION_UNCONFIRMED'
    }
  }

  subscribe(attemptId: string, listener: (event: ExecutorEvent) => void): () => void {
    const cleanId = attemptId.trim().toLowerCase()
    let set = this.listeners.get(cleanId)
    if (!set) {
      set = new Set()
      this.listeners.set(cleanId, set)
    }
    set.add(listener)
    return () => {
      const current = this.listeners.get(cleanId)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) {
        this.listeners.delete(cleanId)
      }
    }
  }

  private emitToListeners(cleanAttemptId: string, event: ExecutorEvent): void {
    const set = this.listeners.get(cleanAttemptId)
    if (!set || set.size === 0) return
    for (const listener of Array.from(set)) {
      try {
        listener(event)
      } catch {
        // Subscriber failures must never disrupt lifecycle tracking
      }
    }
  }

  private async handleWorkerApprovalRequest(
    runtime: ActiveAttemptRuntime,
    msg: ClineApprovalRequestMessage
  ): Promise<void> {
    let approved = false
    let reason = 'HOST_APPROVAL_DENIED'

    if (this.options.approvalHandler) {
      try {
        approved = await this.options.approvalHandler({
          attemptId: runtime.attemptId,
          repositoryId: this.options.repositoryId ?? '',
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          targetPath: msg.targetPath,
          summary: msg.summary
        })
        if (approved) reason = 'HOST_APPROVED'
      } catch (err) {
        approved = false
        reason = err instanceof Error ? err.message : 'HOST_APPROVAL_ERROR'
      }
    }

    try {
      runtime.worker?.postMessage({
        type: 'approval_response',
        attemptId: runtime.attemptId,
        toolCallId: msg.toolCallId,
        approved,
        reason
      })
    } catch {}
  }

  private async runWorkerPreparePreflight(input: {
    readonly attemptId: string
    readonly repositoryId: string
    readonly worktreePath: string
    readonly requestedModelId: string
  }): Promise<ClinePrepareResultMessage> {
    const requestId = randomUUID()
    const env = buildWorkerEnvironment(process.env)

    return await new Promise((resolve) => {
      let child: SpawnedClineWorker
      try {
        child = this.launcher.fork(this.workerPath, [], {
          cwd: input.worktreePath,
          env,
          serviceName: 'BuildX ClineSDK Preflight'
        })
      } catch (err) {
        resolve({
          type: 'prepare_result',
          requestId,
          ok: false,
          status: 'UNAVAILABLE',
          reason: err instanceof Error ? err.message : String(err)
        })
        return
      }

      const getWorkerOutput = collectWorkerOutput(child)

      let settled = false
      let capturedPid = child.pid
      const timer = setTimeout(() => {
        void terminateProcessTree(capturedPid, () => child.kill()).finally(() => {
          if (!settled) {
            settled = true
            resolve({
              type: 'prepare_result',
              requestId,
              ok: false,
              status: 'UNAVAILABLE',
              reason: 'CLINE_PREPARE_TIMEOUT'
            })
          }
        })
      }, 15_000)

      const finish = (result: ClinePrepareResultMessage) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }

      child.on('spawn', () => {
        capturedPid = child.pid ?? capturedPid
      })

      child.on('message', (msg: ClineWorkerMessage) => {
        capturedPid = child.pid ?? capturedPid
        if (msg.type === 'ready') {
          child.postMessage({
            type: 'prepare_attempt',
            requestId,
            attemptId: input.attemptId,
            repositoryId: input.repositoryId,
            worktreePath: input.worktreePath,
            requestedModelId: input.requestedModelId,
            ...(this.options.apiBaseUrl ? { apiBaseUrl: this.options.apiBaseUrl } : {}),
            ...(this.options.settingsFilePath ? { settingsFilePath: this.options.settingsFilePath } : {})
          })
        } else if (msg.type === 'prepare_result' && msg.requestId === requestId) {
          finish(msg)
        }
      })

      child.on('error', (type, location) => {
        finish({
          type: 'prepare_result',
          requestId,
          ok: false,
          status: 'UNAVAILABLE',
          reason: `CLINE_PREPARE_WORKER_ERROR: ${type}${location ? ` (${location})` : ''}`
        })
      })

      child.on('exit', (code) => {
        if (!settled) {
          const output = getWorkerOutput()
          finish({
            type: 'prepare_result',
            requestId,
            ok: false,
            status: 'UNAVAILABLE',
            reason: `CLINE_PREPARE_WORKER_EXITED: code=${code}${output ? `: ${output}` : ''}`
          })
        }
      })
    })
  }

  private async performCancellation(runtime: ActiveAttemptRuntime): Promise<ExecutorRunObservation> {
    if (runtime.observation.phase !== 'TERMINAL') {
      runtime.observation = {
        ...runtime.observation,
        phase: 'STOPPING'
      }
    }

    try {
      runtime.worker?.postMessage({
        type: 'cancel_attempt',
        attemptId: runtime.attemptId,
        reason: 'USER_CANCELLED'
      })
    } catch {}

    const graceMs = this.options.cancelGraceMs ?? 2000
    await Promise.race([
      runtime.exitPromise,
      new Promise((resolve) => setTimeout(resolve, graceMs))
    ])

    if (!runtime.exited) {
      await this.forceTerminateRuntime(runtime, 'CANCELLED', 'USER_CANCELLED')
    } else {
      await this.finalizeTerminationCheck(runtime)
    }

    return runtime.observation
  }

  private async forceTerminateRuntime(
    runtime: ActiveAttemptRuntime,
    status: ExecutorRunStatus,
    reason: string
  ): Promise<void> {
    const dead = await terminateProcessTree(runtime.capturedPid, () => runtime.worker?.kill() ?? false)
    if (!runtime.exited) {
      await Promise.race([
        runtime.exitPromise,
        new Promise((resolve) => setTimeout(resolve, 1000))
      ])
    }

    let dirRemoved = false
    try {
      fs.rmSync(runtime.isolatedStorageRoot, { recursive: true, force: true })
      dirRemoved = !fs.existsSync(runtime.isolatedStorageRoot)
    } catch {
      dirRemoved = !fs.existsSync(runtime.isolatedStorageRoot)
    }

    runtime.treeConfirmedDead = runtime.exited && dead
    const confirmed = runtime.treeConfirmedDead && dirRemoved

    runtime.observation = {
      ...runtime.observation,
      status,
      phase: confirmed ? 'TERMINAL' : 'TERMINATION_UNCONFIRMED',
      reason,
      durationMs: Date.now() - runtime.startedAt,
      termination: {
        confirmed,
        activeProcesses: confirmed ? 0 : 1,
        handlesClosed: confirmed,
        ...(!confirmed ? { reason: 'TERMINATION_UNCONFIRMED' } : {})
      }
    }
  }

  private async finalizeTerminationCheck(runtime: ActiveAttemptRuntime): Promise<void> {
    const pidDead = runtime.capturedPid ? !isPidAlive(runtime.capturedPid) : true
    let dirRemoved = !fs.existsSync(runtime.isolatedStorageRoot)
    if (!dirRemoved) {
      try {
        fs.rmSync(runtime.isolatedStorageRoot, { recursive: true, force: true })
        dirRemoved = !fs.existsSync(runtime.isolatedStorageRoot)
      } catch {
        dirRemoved = false
      }
    }

    runtime.treeConfirmedDead = runtime.exited && pidDead
    const confirmed = runtime.treeConfirmedDead && dirRemoved

    const existingResult = runtime.observation.result
    const hadTerminalMessage = Boolean(existingResult)

    let nextStatus = runtime.observation.status
    let nextReason = runtime.observation.reason
    if (!hadTerminalMessage) {
      nextStatus = runtime.exitCode === 0 ? 'INTERRUPTED' : 'FAILED'
      nextReason =
        nextReason ??
        `CLINE_WORKER_CRASHED_EXIT_${runtime.exitCode === null ? 'UNKNOWN' : runtime.exitCode}`
    }

    runtime.observation = {
      ...runtime.observation,
      status: nextStatus,
      phase: confirmed ? 'TERMINAL' : 'TERMINATION_UNCONFIRMED',
      ...(nextReason ? { reason: nextReason } : {}),
      durationMs: runtime.observation.durationMs ?? Date.now() - runtime.startedAt,
      events: [...runtime.events],
      ...(!hadTerminalMessage
        ? {
            result: {
              usage: { provenance: 'UNAVAILABLE' },
              billing: { classification: 'UNKNOWN', provenance: 'UNAVAILABLE' },
              provenance: {
                executorId: this.identity.executorId,
                providerId: this.identity.providerId ?? null,
                modelId: this.identity.modelId ?? null,
                origin: 'CLINE_CORE_SDK'
              }
            }
          }
        : {}),
      termination: {
        confirmed,
        activeProcesses: confirmed ? 0 : 1,
        handlesClosed: confirmed,
        ...(!confirmed ? { reason: 'TERMINATION_UNCONFIRMED' } : {})
      }
    }
  }

  private async onWorkerExited(
    runtime: ActiveAttemptRuntime,
    code: number,
    settleHandshake: (obs: ExecutorRunObservation) => void
  ): Promise<void> {
    runtime.exited = true
    runtime.exitCode = code
    runtime.resolveExit(code)
    await this.finalizeTerminationCheck(runtime)

    if (runtime.observation.phase === 'TERMINAL' && !runtime.events.some((e) => e.phase === 'TERMINAL')) {
      const crashEvent: ExecutorEvent = {
        kind: runtime.observation.status === 'CANCELLED' ? 'CANCELLED' : 'FAILED',
        attemptId: runtime.attemptId,
        timestamp: new Date().toISOString(),
        phase: 'TERMINAL',
        status: runtime.observation.status,
        ...(runtime.observation.reason ? { reason: runtime.observation.reason } : {}),
        provenance: this.identity
      }
      runtime.events.push(crashEvent)
      this.emitToListeners(runtime.attemptId.trim().toLowerCase(), crashEvent)
    }

    settleHandshake(runtime.observation)
  }
}
