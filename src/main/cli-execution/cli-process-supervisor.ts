import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import type { CliCommandDescriptor, CliExecutionStatus } from './cli-execution-types'
import { CliOutputBuffer } from './cli-output-buffer'
import { getOrBuildCliJobOwnerBinary } from './windows/cli-job-owner-locator'

export interface SupervisorExecutionResult {
  status: CliExecutionStatus
  exitCode?: number | null
  durationMs: number
  diagnostic?: string
}

export interface SupervisorLaunchOptions {
  timeoutMs?: number
  maxOutputBytes?: number
  requireNativeJobOwner?: boolean
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

export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
}

export async function verifyProcessDead(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      await new Promise((r) => setTimeout(r, 50))
    } catch (e: any) {
      if (e.code === 'ESRCH') return true
    }
  }
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

export class CliProcessSupervisor {
  private activeChild: ChildProcess | null = null
  private activeJobOwner: ChildProcess | null = null
  private activeTimeout: NodeJS.Timeout | null = null
  private completionPromise: Promise<SupervisorExecutionResult> | null = null
  private finalizeFn: ((status: CliExecutionStatus, exitCode?: number | null, diagnostic?: string) => void) | null = null
  private outputBuffer: CliOutputBuffer | null = null
  private startedAt = 0
  private executionStatus: CliExecutionStatus = 'RUNNING'
  private exitDiagnostic?: string

  constructor(private readonly defaultTimeoutMs = 60_000) {}

  get isRunning(): boolean {
    return this.activeChild !== null && this.executionStatus === 'RUNNING'
  }

  get status(): CliExecutionStatus {
    return this.executionStatus
  }

  get output(): CliOutputBuffer | null {
    return this.outputBuffer
  }

  launch(
    command: CliCommandDescriptor,
    options: SupervisorLaunchOptions = {}
  ): Promise<SupervisorExecutionResult> {
    if (this.isRunning) {
      throw new Error('SUPERVISOR_BUSY')
    }

    const timeoutMs = Math.min(options.timeoutMs ?? this.defaultTimeoutMs, 120_000)
    const outputBuffer = new CliOutputBuffer(options.maxOutputBytes)
    this.outputBuffer = outputBuffer
    this.startedAt = Date.now()
    this.executionStatus = 'RUNNING'
    this.exitDiagnostic = undefined

    let childExecutable = command.executable
    let childArgs = command.args

    // Handle .cmd / .bat invocation on Windows safely
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command.executable)) {
      childExecutable = process.env.COMSPEC || process.env.ComSpec || 'cmd.exe'
      childArgs = ['/d', '/s', '/c', command.executable, ...command.args]
    }

    let child: ChildProcess
    try {
      child = spawn(childExecutable, childArgs, {
        cwd: command.cwd,
        env: buildSafeEnvironment(),
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      this.executionStatus = 'FAILED'
      const diagnostic = `SPAWN_FAILED: ${err instanceof Error ? err.message : String(err)}`
      this.exitDiagnostic = diagnostic
      return Promise.resolve({
        status: 'FAILED',
        durationMs: Date.now() - this.startedAt,
        diagnostic
      })
    }

    this.activeChild = child

    // Attach Windows Job Object supervisor if on Windows
    if (process.platform === 'win32' && child.pid) {
      const jobOwnerExe = getOrBuildCliJobOwnerBinary()
      if (jobOwnerExe) {
        try {
          const owner = spawn(jobOwnerExe, [String(child.pid)], {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'ignore']
          })
          this.activeJobOwner = owner
        } catch {
          // If native ownership fails and was strictly required
          if (options.requireNativeJobOwner) {
            killProcessTree(child.pid)
            this.activeChild = null
            this.executionStatus = 'FAILED'
            return Promise.resolve({
              status: 'FAILED',
              durationMs: 0,
              diagnostic: 'NATIVE_OWNERSHIP_FAILED'
            })
          }
        }
      } else if (options.requireNativeJobOwner) {
        killProcessTree(child.pid)
        this.activeChild = null
        this.executionStatus = 'FAILED'
        return Promise.resolve({
          status: 'FAILED',
          durationMs: 0,
          diagnostic: 'NATIVE_OWNERSHIP_UNAVAILABLE'
        })
      }
    }

    this.completionPromise = new Promise<SupervisorExecutionResult>((resolve) => {
      let settled = false
      const finalize = async (
        status: CliExecutionStatus,
        exitCode?: number | null,
        diagnostic?: string
      ) => {
        if (settled) return
        settled = true
        if (this.activeTimeout) {
          clearTimeout(this.activeTimeout)
          this.activeTimeout = null
        }
        if (this.activeJobOwner) {
          try {
            this.activeJobOwner.stdin?.write('terminate\n')
            this.activeJobOwner.kill()
          } catch {}
          this.activeJobOwner = null
        }
        this.executionStatus = status
        this.exitDiagnostic = diagnostic
        this.activeChild = null
        this.finalizeFn = null
        resolve({
          status,
          exitCode: exitCode ?? null,
          durationMs: Date.now() - this.startedAt,
          diagnostic
        })
      }

      this.finalizeFn = finalize

      this.activeTimeout = setTimeout(async () => {
        if (child.pid) {
          if (this.activeJobOwner) {
            try {
              this.activeJobOwner.stdin?.write('terminate\n')
            } catch {}
          }
          killProcessTree(child.pid)
          const isDead = await verifyProcessDead(child.pid)
          const diag = isDead ? 'PROCESS_TIMED_OUT' : 'FAILED_TERMINATION: Process tree could not be verified dead'
          void finalize('TIMED_OUT', null, diag)
        } else {
          void finalize('TIMED_OUT', null, 'PROCESS_TIMED_OUT')
        }
      }, timeoutMs)

      child.stdout?.on('data', (chunk) => outputBuffer.appendStdout(chunk))
      child.stderr?.on('data', (chunk) => outputBuffer.appendStderr(chunk))

      child.once('error', (err) => {
        void finalize('FAILED', null, `PROCESS_ERROR: ${err.message}`)
      })

      child.once('exit', (code, signal) => {
        if (signal) {
          void finalize('INTERRUPTED', code, `PROCESS_INTERRUPTED: ${signal}`)
        } else if (code === 0) {
          void finalize('SUCCEEDED', 0)
        } else {
          void finalize('FAILED', code, `PROCESS_EXIT_FAILED: code ${code}`)
        }
      })
    })

    return this.completionPromise
  }

  async cancel(): Promise<SupervisorExecutionResult> {
    if (!this.isRunning || !this.activeChild) {
      return {
        status: this.executionStatus,
        durationMs: this.startedAt ? Date.now() - this.startedAt : 0,
        diagnostic: this.exitDiagnostic
      }
    }

    const child = this.activeChild
    const finalize = this.finalizeFn

    if (this.activeTimeout) {
      clearTimeout(this.activeTimeout)
      this.activeTimeout = null
    }

    let isDead = true
    if (child.pid) {
      if (this.activeJobOwner) {
        try {
          this.activeJobOwner.stdin?.write('terminate\n')
        } catch {}
      }
      killProcessTree(child.pid)
      isDead = await verifyProcessDead(child.pid)
    }

    const diag = isDead
      ? 'PROCESS_CANCELLED_BY_SUPERVISOR'
      : 'FAILED_TERMINATION: Process tree could not be verified dead'

    if (finalize) {
      void finalize('CANCELLED', null, diag)
    }

    return this.completionPromise!
  }

  async shutdown(): Promise<void> {
    await this.cancel()
  }
}
