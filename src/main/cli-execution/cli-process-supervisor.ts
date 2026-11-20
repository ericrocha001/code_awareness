import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import type { CliCommandDescriptor, CliExecutionStatus } from './cli-execution-types'
import { CliOutputBuffer } from './cli-output-buffer'
import {
  CLI_OWNER_CLEANUP_CONFIRMED_EXIT_CODE,
  CLI_OWNER_PRE_CREATE_CONFIRMED_EXIT_CODE,
  hasVerifiedOwnerCleanupContract,
  locateCliJobOwner
} from './windows/cli-job-owner-locator'

export type SupervisorTerminationConfirmationKind = 'PRE_CREATE_CONFIRMED' | 'CLEANUP_CONFIRMED'

export interface SupervisorTerminationReconciliation {
  status: CliExecutionStatus
  phase: 'TERMINAL'
  confirmationKind: SupervisorTerminationConfirmationKind
  initialCause: string
  diagnostic: string
  durationMs: number
  treeObservation: { activeProcesses: 0; handlesClosed: true }
}

export interface SupervisorExecutionResult {
  treeObservation?: { activeProcesses: 0; handlesClosed: true }
  status: CliExecutionStatus
  exitCode?: number | null
  durationMs: number
  diagnostic?: string
}
export interface SupervisorLaunchOptions {
  timeoutMs?: number
  maxTimeoutMs?: number
  maxOutputBytes?: number
  maxTotalOutputBytes?: number
  ownerPath?: string
  env?: Record<string, string>
  handshakeTimeoutMs?: number
  drainTimeoutMs?: number
  authorizeResume?: () => Promise<boolean>
  onRunning?: () => void
  onTerminationConfirmed?: (reconciliation: SupervisorTerminationReconciliation) => void
}
const SAFE_ENV_VARS = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'COMSPEC',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'NODE_ENV'
]

const ALLOWED_PROPAGATED_ENV = new Set(['CODE_AWARENESS_DELIVERY_CONTEXT', 'CODE_AWARENESS_WORKTREE_ID', 'CODE_AWARENESS_SESSION_WITNESS'])

export function buildSafeEnvironment(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of SAFE_ENV_VARS) {
    const foundKey = Object.keys(process.env).find((k) => k.toUpperCase() === key.toUpperCase())
    if (foundKey && process.env[foundKey] !== undefined) {
      env[key] = process.env[foundKey]
    }
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (ALLOWED_PROPAGATED_ENV.has(key) && typeof value === 'string') env[key] = value
    }
  }
  return env
}


export class CliProcessSupervisor {
  private owner: ChildProcess | null = null
  private control: Socket | null = null
  private completion: Promise<SupervisorExecutionResult> | null = null
  private stopReason: 'CANCELLED' | 'TIMED_OUT' | null = null
  private busy = false
  private awaitingOwnerConfirmation = false
  private activeLaunchId: string | null = null
  private currentPipeName: string | null = null
  private lastResult: SupervisorExecutionResult | null = null
  private startedAt = 0
  private buffer: CliOutputBuffer | null = null
  private currentStatus: CliExecutionStatus = 'AWAITING_APPROVAL'
  private diagnostic?: string
  phase: 'IDLE' | 'LAUNCHING' | 'OWNED' | 'RUNNING' | 'STOPPING' | 'TERMINAL' | 'TERMINATION_UNCONFIRMED' = 'IDLE'
  constructor(private readonly defaultTimeoutMs = 60000) {}
  get isRunning() { return this.busy }
  get isAwaitingTerminationConfirmation() {
    return this.busy && this.phase === 'TERMINATION_UNCONFIRMED' && this.awaitingOwnerConfirmation
  }
  get activePipeName() { return this.currentPipeName }
  get failureDiagnostic() { return this.diagnostic }
  get status() { return this.currentStatus }
  get output() { return this.buffer }

  launch(command: CliCommandDescriptor, options: SupervisorLaunchOptions = {}): Promise<SupervisorExecutionResult> {
    if (this.busy) throw new Error('SUPERVISOR_BUSY')
    if (process.platform !== 'win32') throw new Error('WINDOWS_OWNERSHIP_REQUIRED')
    const executable = options.ownerPath ?? locateCliJobOwner(process.cwd(), undefined)
    const exitContractVerified = hasVerifiedOwnerCleanupContract(executable)
    const handshakeMs = typeof options.handshakeTimeoutMs === 'number' && Number.isFinite(options.handshakeTimeoutMs) && options.handshakeTimeoutMs > 0
      ? Math.floor(options.handshakeTimeoutMs)
      : 5000
    const drainMs = typeof options.drainTimeoutMs === 'number' && Number.isFinite(options.drainTimeoutMs) && options.drainTimeoutMs > 0
      ? Math.floor(options.drainTimeoutMs)
      : 1500
    const launchId = randomUUID()
    this.activeLaunchId = launchId
    this.busy = true
    this.control = null
    this.stopReason = null
    this.awaitingOwnerConfirmation = false
    this.lastResult = null
    this.phase = 'LAUNCHING'
    this.currentStatus = 'AWAITING_APPROVAL'
    this.diagnostic = undefined
    this.startedAt = Date.now()
    this.buffer = new CliOutputBuffer(options.maxOutputBytes, undefined, options.maxTotalOutputBytes)
    const pipeName = 'CodeAwareness.Cli.' + randomUUID()
    this.currentPipeName = pipeName
    const server = createServer()
    let stage = 'CONNECTING', incoming = '', terminal = false, settled = false
    let poll: NodeJS.Timeout | undefined
    let ownerClosed = false, targetCreated = false, observedRunning = false
    let controlLost = false, handshakeTimedOut = false, cooperativeDrain = false, reconciled = false
    let initialFailureCode: string | undefined
    let terminalExit: number | undefined
    let watchdog: NodeJS.Timeout | undefined
    let timeout: NodeJS.Timeout | undefined
    const stopTimers = () => {
      if (poll) { clearTimeout(poll); poll = undefined }
      if (watchdog) { clearTimeout(watchdog); watchdog = undefined }
      if (timeout) { clearTimeout(timeout); timeout = undefined }
    }
    this.completion = new Promise(resolve => {
      const finish = (result: SupervisorExecutionResult, confirmed: boolean) => {
        if (settled || this.activeLaunchId !== launchId) return
        settled = true; stopTimers(); server.close()
        this.currentStatus = result.status; this.diagnostic = result.diagnostic
        this.busy = !confirmed
        this.phase = confirmed ? 'TERMINAL' : 'TERMINATION_UNCONFIRMED'
        this.lastResult = result
        if (confirmed) {
          this.awaitingOwnerConfirmation = false
          this.control?.end()
          this.owner = null
          this.currentPipeName = null
          this.activeLaunchId = null
        } else {
          this.awaitingOwnerConfirmation = !ownerClosed && exitContractVerified && this.owner !== null
        }
        resolve(result)
      }
      const failure = (code: string) => {
        if (settled || this.activeLaunchId !== launchId) return
        initialFailureCode ??= code
        this.control?.destroy()
        const confirmed = !targetCreated && ownerClosed
        const diagnostic = confirmed
          ? code
          : (code.startsWith('TERMINATION_UNCONFIRMED') ? code : 'TERMINATION_UNCONFIRMED:' + code)
        finish({ status: 'FAILED', durationMs: Date.now() - this.startedAt, diagnostic }, confirmed)
      }
      const send = (value: string) => {
        if (!settled && !terminal && this.control && !this.control.destroyed && this.control.writable) {
          this.control.write(value + '\n')
        }
      }
      const armWatchdog = (ms = handshakeMs) => {
        if (watchdog) clearTimeout(watchdog)
        if (settled || terminal || ownerClosed) return
        watchdog = setTimeout(() => onWatchdogExpired(), ms)
      }
      const onWatchdogExpired = () => {
        if (settled || ownerClosed || this.activeLaunchId !== launchId) return
        if (controlLost) {
          failure(initialFailureCode ?? 'CONTROL_LOST')
          return
        }
        handshakeTimedOut = true
        initialFailureCode ??= 'NATIVE_HANDSHAKE_TIMEOUT'
        if (!cooperativeDrain && ['AUTHORIZING', 'RESUMING', 'RUNNING', 'POLLING'].includes(stage) &&
            this.control && !this.control.destroyed && this.control.writable) {
          cooperativeDrain = true
          this.phase = 'STOPPING'
          if (poll) { clearTimeout(poll); poll = undefined }
          send('terminate')
          armWatchdog(drainMs)
          return
        }
        failure('NATIVE_HANDSHAKE_TIMEOUT')
      }
      const message = async (value: any) => {
        if (settled) return
        if (value.version !== 1) throw new Error('NATIVE_VERSION_MISMATCH')
        if (value.phase === 'READY' && stage === 'CONNECTING') {
          stage = 'CREATING'; targetCreated = true
          send(JSON.stringify({ executable: command.executable, args: command.args, cwd: command.cwd, commandLine: command.windowsCommandLine }))
        } else if (value.phase === 'OWNED' && stage === 'CREATING' && value.assignedAtCreation === true && value.suspended === true && value.activeProcesses === 1) {
          stage = 'AUTHORIZING'; this.phase = 'OWNED'; observedRunning = true
          armWatchdog()
          if (this.stopReason || handshakeTimedOut || cooperativeDrain) {
            stage = 'RESUMING'
            cooperativeDrain = true
            send('terminate')
            armWatchdog(drainMs)
            return
          }
          const allowed = options.authorizeResume ? await options.authorizeResume().catch(() => false) : true
          if (settled || handshakeTimedOut || cooperativeDrain) return
          stage = 'RESUMING'
          send(allowed && !this.stopReason ? 'resume' : 'terminate')
          if (!allowed) this.stopReason ??= 'CANCELLED'
        } else if (value.phase === 'RUNNING' && stage === 'RESUMING') {
          stage = 'RUNNING'; this.phase = 'RUNNING'; this.currentStatus = 'RUNNING'; observedRunning = true; options.onRunning?.()
        } else if (value.phase === 'OBSERVATION' && ['RUNNING', 'RESUMING', 'POLLING'].includes(stage) && Number.isInteger(value.activeProcesses) && value.activeProcesses >= 0) {
          stage = 'POLLING'
          poll = setTimeout(() => send(this.stopReason || handshakeTimedOut || cooperativeDrain ? 'terminate' : 'inspect'), 20)
        } else if (value.phase === 'TERMINAL' && value.activeProcesses === 0 && value.handlesClosed === true && Number.isInteger(value.exitCode)) {
          terminal = true; terminalExit = value.exitCode
          if (typeof value.diagnostic === 'string' && /^[A-Z_]+$/.test(value.diagnostic)) this.diagnostic = value.diagnostic
          this.control?.end()
        } else if (value.phase === 'ERROR' && typeof value.code === 'string') {
          // A pre-create error is confirmed only after helper exit. A possible create remains quarantined.
          this.diagnostic = /^[A-Z_]+$/.test(value.code) ? value.code : 'NATIVE_FAILURE'
        } else throw new Error('NATIVE_PROTOCOL_ERROR')
        armWatchdog(this.stopReason || cooperativeDrain ? drainMs : handshakeMs)
      }
      server.on('connection', socket => {
        if (this.control) { socket.destroy(); return }
        this.control = socket
        socket.setEncoding('utf8')
        socket.on('data', chunk => {
          incoming += chunk
          if (incoming.length > 65536) { failure('NATIVE_RESPONSE_LIMIT'); return }
          let index: number
          while ((index = incoming.indexOf('\n')) >= 0) {
            const line = incoming.slice(0, index); incoming = incoming.slice(index + 1)
            try { void message(JSON.parse(line)).catch(() => failure('NATIVE_PROTOCOL_ERROR')) }
            catch { failure('NATIVE_PROTOCOL_ERROR') }
          }
        })
        socket.on('error', () => {
          controlLost = true
          if (!terminal) failure('CONTROL_LOST')
        })
        socket.on('close', () => {
          if (!terminal && !ownerClosed) {
            controlLost = true
            armWatchdog(drainMs)
          }
        })
      })
      server.on('error', () => failure('CONTROL_UNAVAILABLE'))
      server.listen('\\\\.\\pipe\\' + pipeName, () => {
        try {
          const spawned = spawn(executable, [pipeName], { shell: false, windowsHide: true,
            env: buildSafeEnvironment(options.env), stdio: ['ignore', 'pipe', 'pipe'] })
          this.owner = spawned
          spawned.stdout?.on('data', chunk => this.buffer?.appendStdout(chunk))
          spawned.stderr?.on('data', chunk => this.buffer?.appendStderr(chunk))
          spawned.on('error', () => {
            if (this.activeLaunchId !== launchId) return
            ownerClosed = true; failure('NATIVE_OWNER_UNAVAILABLE')
          })
          spawned.on('close', (code, signal) => {
            if (this.activeLaunchId !== launchId) return
            ownerClosed = true
            const confirmedExitKind: SupervisorTerminationConfirmationKind | null =
              exitContractVerified && signal === null && !spawned.killed
                ? (code === CLI_OWNER_PRE_CREATE_CONFIRMED_EXIT_CODE && !observedRunning
                    ? 'PRE_CREATE_CONFIRMED'
                    : code === CLI_OWNER_CLEANUP_CONFIRMED_EXIT_CODE
                      ? 'CLEANUP_CONFIRMED'
                      : null)
                : null

            if (settled) {
              this.awaitingOwnerConfirmation = false
              if (confirmedExitKind === null || this.phase !== 'TERMINATION_UNCONFIRMED' || reconciled) {
                return
              }
              reconciled = true
              const initialCause = (initialFailureCode ?? this.diagnostic ?? 'OWNER_LOST').replace(/^TERMINATION_UNCONFIRMED:/, '')
              const diagnostic = `${initialCause}:RECOVERED_${confirmedExitKind}`
              const treeObservation = { activeProcesses: 0 as const, handlesClosed: true as const }
              const durationMs = Date.now() - this.startedAt
              this.owner = null
              this.currentPipeName = null
              this.activeLaunchId = null
              this.busy = false
              this.phase = 'TERMINAL'
              this.currentStatus = 'FAILED'
              this.diagnostic = diagnostic
              this.lastResult = { status: 'FAILED', durationMs, diagnostic, treeObservation }
              options.onTerminationConfirmed?.({
                status: 'FAILED',
                phase: 'TERMINAL',
                confirmationKind: confirmedExitKind,
                initialCause,
                diagnostic,
                durationMs,
                treeObservation
              })
              return
            }

            if (terminal && !handshakeTimedOut && (!exitContractVerified || confirmedExitKind !== null)) {
              finish({
                status: this.stopReason ?? (terminalExit === 0 ? 'SUCCEEDED' : 'FAILED'),
                exitCode: terminalExit,
                durationMs: Date.now() - this.startedAt,
                diagnostic: this.diagnostic,
                treeObservation: { activeProcesses: 0, handlesClosed: true }
              }, true)
              return
            }

            if (confirmedExitKind !== null) {
              const cause = (initialFailureCode ?? this.diagnostic ?? (spawned.killed ? 'OWNER_LOST' : controlLost ? 'CONTROL_LOST' : 'OWNER_LOST')).replace(/^TERMINATION_UNCONFIRMED:/, '')
              const diagnostic = `${cause}:RECOVERED_${confirmedExitKind}`
              finish({
                status: 'FAILED',
                durationMs: Date.now() - this.startedAt,
                diagnostic,
                treeObservation: { activeProcesses: 0, handlesClosed: true }
              }, true)
              return
            }

            failure(initialFailureCode ?? this.diagnostic ?? (spawned.killed ? 'OWNER_LOST' : controlLost ? 'CONTROL_LOST' : 'OWNER_LOST'))
          })
          armWatchdog()
          const hardCapMs = typeof options.maxTimeoutMs === 'number' && Number.isFinite(options.maxTimeoutMs) && options.maxTimeoutMs > 0
            ? Math.min(Math.floor(options.maxTimeoutMs), 900000)
            : 120000
          const requestedMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
            ? Math.floor(options.timeoutMs)
            : this.defaultTimeoutMs
          timeout = setTimeout(() => {
            if (settled || cooperativeDrain) return
            this.stopReason = 'TIMED_OUT'
            this.phase = 'STOPPING'
            if (['AUTHORIZING', 'RESUMING', 'RUNNING', 'POLLING'].includes(stage)) {
              cooperativeDrain = true
              if (poll) { clearTimeout(poll); poll = undefined }
              send('terminate')
              armWatchdog(drainMs)
            }
          }, Math.max(1, Math.min(requestedMs, hardCapMs)))
        } catch { ownerClosed = true; failure('NATIVE_OWNER_UNAVAILABLE') }
      })
    })
    return this.completion
  }
  async cancel(): Promise<SupervisorExecutionResult> {
    if (!this.busy || !this.completion) {
      return this.lastResult ?? { status: this.currentStatus, durationMs: Date.now() - this.startedAt, diagnostic: this.diagnostic }
    }
    if (this.phase === 'TERMINATION_UNCONFIRMED') return this.completion
    this.stopReason = 'CANCELLED'; this.phase = 'STOPPING'
    // Before OWNED, the handshake sends terminate instead of authorizing ResumeThread.
    if (this.currentStatus === 'RUNNING') this.control?.write('terminate\n')
    return this.completion
  }
  async shutdown() { await this.cancel() }
}
