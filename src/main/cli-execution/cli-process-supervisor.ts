import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import type { CliCommandDescriptor, CliExecutionStatus } from './cli-execution-types'
import { CliOutputBuffer } from './cli-output-buffer'
import { locateCliJobOwner } from './windows/cli-job-owner-locator'

export interface SupervisorExecutionResult {
  treeObservation?: { activeProcesses: 0; handlesClosed: true }
  status: CliExecutionStatus
  exitCode?: number | null
  durationMs: number
  diagnostic?: string
}
export interface SupervisorLaunchOptions {
  timeoutMs?: number
  maxOutputBytes?: number
  maxTotalOutputBytes?: number
  ownerPath?: string
  authorizeResume?: () => Promise<boolean>
  onRunning?: () => void
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

export function buildSafeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of SAFE_ENV_VARS) {
    const foundKey = Object.keys(process.env).find((k) => k.toUpperCase() === key.toUpperCase())
    if (foundKey && process.env[foundKey] !== undefined) {
      env[key] = process.env[foundKey]
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
  private startedAt = 0
  private buffer: CliOutputBuffer | null = null
  private currentStatus: CliExecutionStatus = 'AWAITING_APPROVAL'
  private diagnostic?: string
  phase: 'IDLE' | 'LAUNCHING' | 'OWNED' | 'RUNNING' | 'STOPPING' | 'TERMINAL' | 'TERMINATION_UNCONFIRMED' = 'IDLE'
  constructor(private readonly defaultTimeoutMs = 60000) {}
  get isRunning() { return this.busy }
  get status() { return this.currentStatus }
  get output() { return this.buffer }

  launch(command: CliCommandDescriptor, options: SupervisorLaunchOptions = {}): Promise<SupervisorExecutionResult> {
    if (this.busy) throw new Error('SUPERVISOR_BUSY')
    if (process.platform !== 'win32') throw new Error('WINDOWS_OWNERSHIP_REQUIRED')
    const executable = options.ownerPath ?? locateCliJobOwner(process.cwd(), undefined)
    this.busy = true
    this.control = null
    this.stopReason = null
    this.phase = 'LAUNCHING'
    this.currentStatus = 'AWAITING_APPROVAL'
    this.diagnostic = undefined
    this.startedAt = Date.now()
    this.buffer = new CliOutputBuffer(options.maxOutputBytes, undefined, options.maxTotalOutputBytes)
    const pipeName = 'CodeAwareness.Cli.' + randomUUID()
    const server = createServer()
    let stage = 'CONNECTING', incoming = '', terminal = false, settled = false
    let poll: NodeJS.Timeout | undefined
    let ownerClosed = false, targetCreated = false
    let terminalExit: number | undefined
    let watchdog: NodeJS.Timeout | undefined
    let timeout: NodeJS.Timeout | undefined
    const stopTimers = () => { if (poll) clearTimeout(poll); if (watchdog) clearTimeout(watchdog); if (timeout) clearTimeout(timeout) }
    this.completion = new Promise(resolve => {
      const finish = (result: SupervisorExecutionResult, confirmed: boolean) => {
        if (settled) return
        settled = true; stopTimers(); server.close()
        this.currentStatus = result.status; this.diagnostic = result.diagnostic
        this.busy = !confirmed
        this.phase = confirmed ? 'TERMINAL' : 'TERMINATION_UNCONFIRMED'
        if (confirmed) { this.control?.end(); this.owner = null }
        resolve(result)
      }
      const failure = (code: string) => {
        if (settled) return
        this.control?.destroy()
        // Losing control closes the owner's pipe; KillOnClose still applies. Only an explicit
        // empty-job receipt can release a slot after a process might have been created.
        finish({ status: 'FAILED', durationMs: Date.now() - this.startedAt,
          diagnostic: targetCreated ? 'TERMINATION_UNCONFIRMED:' + code : code }, !targetCreated && ownerClosed)
      }
      const send = (value: string) => { if (!settled && this.control?.writable) this.control.write(value + '\n') }
      const armWatchdog = () => {
        if (watchdog) clearTimeout(watchdog)
        watchdog = setTimeout(() => failure('NATIVE_HANDSHAKE_TIMEOUT'), 5000)
      }
      const message = async (value: any) => {
        if (settled) return
        if (value.version !== 1) throw new Error('NATIVE_VERSION_MISMATCH')
        if (value.phase === 'READY' && stage === 'CONNECTING') {
          stage = 'CREATING'; targetCreated = true
          send(JSON.stringify({ executable: command.executable, args: command.args, cwd: command.cwd, commandLine: command.windowsCommandLine }))
        } else if (value.phase === 'OWNED' && stage === 'CREATING' && value.assignedAtCreation === true && value.suspended === true && value.activeProcesses === 1) {
          stage = 'AUTHORIZING'; this.phase = 'OWNED'
          const allowed = options.authorizeResume ? await options.authorizeResume().catch(() => false) : true
          if (settled) return
          stage = 'RESUMING'
          send(allowed && !this.stopReason ? 'resume' : 'terminate')
          if (!allowed) this.stopReason = 'CANCELLED'
        } else if (value.phase === 'RUNNING' && stage === 'RESUMING') {
          stage = 'RUNNING'; this.phase = 'RUNNING'; this.currentStatus = 'RUNNING'; options.onRunning?.()
        } else if (value.phase === 'OBSERVATION' && ['RUNNING', 'RESUMING', 'POLLING'].includes(stage) && Number.isInteger(value.activeProcesses) && value.activeProcesses >= 0) {
          stage = 'POLLING'
          poll = setTimeout(() => send(this.stopReason ? 'terminate' : 'inspect'), 20)
        } else if (value.phase === 'TERMINAL' && value.activeProcesses === 0 && value.handlesClosed === true && Number.isInteger(value.exitCode)) {
          terminal = true; terminalExit = value.exitCode
          if (typeof value.diagnostic === 'string' && /^[A-Z_]+$/.test(value.diagnostic)) this.diagnostic = value.diagnostic
          this.control?.end()
        } else if (value.phase === 'ERROR' && typeof value.code === 'string') {
          // A pre-create error is confirmed only after helper exit. A possible create remains quarantined.
          this.diagnostic = /^[A-Z_]+$/.test(value.code) ? value.code : 'NATIVE_FAILURE'
        } else throw new Error('NATIVE_PROTOCOL_ERROR')
        armWatchdog()
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
        socket.on('error', () => failure('CONTROL_LOST'))
        socket.on('close', () => { if (!terminal && !ownerClosed) armWatchdog() })
      })
      server.on('error', () => failure('CONTROL_UNAVAILABLE'))
      server.listen('\\\\.\\pipe\\' + pipeName, () => {
        try {
          this.owner = spawn(executable, [pipeName], { shell: false, windowsHide: true,
            env: buildSafeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] })
          this.owner.stdout?.on('data', chunk => this.buffer?.appendStdout(chunk))
          this.owner.stderr?.on('data', chunk => this.buffer?.appendStderr(chunk))
          this.owner.on('error', () => { ownerClosed = true; failure('NATIVE_OWNER_UNAVAILABLE') })
          this.owner.on('close', () => {
            ownerClosed = true
            if (terminal) finish({ status: this.stopReason ?? (terminalExit === 0 ? 'SUCCEEDED' : 'FAILED'), exitCode: terminalExit,
              durationMs: Date.now() - this.startedAt, diagnostic: this.diagnostic, treeObservation: { activeProcesses: 0, handlesClosed: true } }, true)
            else failure(this.diagnostic ?? 'OWNER_LOST')
          })
          armWatchdog()
          timeout = setTimeout(() => { this.stopReason = 'TIMED_OUT'; this.phase = 'STOPPING'; send('terminate') }, Math.min(options.timeoutMs ?? this.defaultTimeoutMs, 120000))
        } catch { ownerClosed = true; failure('NATIVE_OWNER_UNAVAILABLE') }
      })
    })
    return this.completion
  }
  async cancel(): Promise<SupervisorExecutionResult> {
    if (!this.busy || !this.completion) return { status: this.currentStatus, durationMs: Date.now() - this.startedAt, diagnostic: this.diagnostic }
    if (this.phase === 'TERMINATION_UNCONFIRMED') return this.completion
    this.stopReason = 'CANCELLED'; this.phase = 'STOPPING'
    // Before OWNED, the handshake sends terminate instead of authorizing ResumeThread.
    if (this.currentStatus === 'RUNNING') this.control?.write('terminate\n')
    return this.completion
  }
  async shutdown() { await this.cancel() }
}
