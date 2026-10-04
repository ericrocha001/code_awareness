import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'
import type { ValidationLedger } from '../validation-ledger/validation-ledger'
import type { ProofProducer, ProofStatus } from '../validation-ledger/validation-ledger-types'
import { ValidationProfileCatalog } from './validation-profile-catalog'
import type { ResolvedValidationCommand, ValidationProfile } from './validation-profile'

export type ValidationRunStatus = 'RUNNING' | 'PASSED' | 'FAILED' | 'ERROR'

export interface ValidationRun {
  runId: string
  profileId: string
  status: ValidationRunStatus
  startedAt: string
  finishedAt?: string
  durationMs?: number
  exitCode?: number
  summary?: string
  failures?: string[]
  diagnostic?: string
  proofId?: string
}

export interface StartValidationInput {
  profileId: string
  targets?: string[]
  producer: ProofProducer
  evidenceFor?: string[]
}

interface ActiveRun {
  publicRun: ValidationRun
  profile: ValidationProfile
  targets: string[]
  command: ResolvedValidationCommand
  producer: ProofProducer
  evidenceFor: string[]
  startFingerprint: string
  child: ChildProcessWithoutNullStreams
  timeout: NodeJS.Timeout
  output: BoundedOutput
}

class BoundedOutput {
  private value = ''
  constructor(private readonly maxChars = 32_768) {}
  append(chunk: Buffer | string): void {
    this.value += chunk.toString()
    if (this.value.length > this.maxChars) this.value = this.value.slice(-this.maxChars)
  }
  lines(limit = 12): string[] {
    return this.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-limit)
  }
}

export class ValidationExecution {
  private readonly runs = new Map<string, ValidationRun>()
  private active: ActiveRun | null = null

  constructor(
    private readonly repoRoot: string,
    private readonly ledger: ValidationLedger,
    private readonly runtimeIdentity: RuntimeIdentityProvider,
    private readonly catalog = new ValidationProfileCatalog()
  ) {}

  listProfiles(): ValidationProfile[] {
    return this.catalog.list()
  }

  start(input: StartValidationInput): ValidationRun {
    if (this.active) throw new Error(`VALIDATION_BUSY: ${this.active.publicRun.runId}`)
    const resolved = this.catalog.resolve(this.repoRoot, input.profileId, input.targets)
    const runId = `run-${randomUUID()}`
    const publicRun: ValidationRun = { runId, profileId: resolved.profile.id, status: 'RUNNING', startedAt: new Date().toISOString() }
    const output = new BoundedOutput()
    const child = spawn(resolved.command.executable, resolved.command.args, {
      cwd: resolved.command.cwd,
      env: process.env,
      windowsHide: true,
      shell: false,
      stdio: 'pipe'
    })
    const active: ActiveRun = {
      publicRun,
      profile: resolved.profile,
      targets: resolved.targets,
      command: resolved.command,
      producer: input.producer,
      evidenceFor: input.evidenceFor ?? [],
      startFingerprint: this.runtimeIdentity.evaluateFreshness().currentSnapshot.fingerprint,
      child,
      timeout: setTimeout(() => this.finish(active, 'ERROR', undefined, 'VALIDATION_TIMEOUT'), resolved.profile.timeoutMs),
      output
    }
    this.active = active
    this.runs.set(runId, publicRun)
    child.stdout.on('data', (chunk) => output.append(chunk))
    child.stderr.on('data', (chunk) => output.append(chunk))
    child.once('error', (error) => void this.finish(active, 'ERROR', undefined, `SPAWN_FAILED: ${error.message}`))
    child.once('exit', (code, signal) => {
      if (this.active !== active) return
      if (signal) void this.finish(active, 'ERROR', code ?? undefined, `PROCESS_INTERRUPTED: ${signal}`)
      else void this.finish(active, code === 0 ? 'PASSED' : 'FAILED', code ?? undefined)
    })
    return { ...publicRun }
  }

  get(runId: string): ValidationRun | null {
    const run = this.runs.get(runId)
    return run ? { ...run, failures: run.failures ? [...run.failures] : undefined } : null
  }

  async shutdown(): Promise<void> {
    const active = this.active
    if (!active) return
    active.child.kill()
    await this.finish(active, 'ERROR', undefined, 'PROCESS_INTERRUPTED_BY_SHUTDOWN')
  }

  private async finish(active: ActiveRun, requestedStatus: ProofStatus, exitCode?: number, diagnostic?: string): Promise<void> {
    if (this.active !== active) return
    clearTimeout(active.timeout)
    if (requestedStatus === 'ERROR' && active.child.exitCode === null) active.child.kill()
    const finishedAt = new Date().toISOString()
    const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(active.publicRun.startedAt))
    const endFingerprint = this.runtimeIdentity.evaluateFreshness().currentSnapshot.fingerprint
    const sourceChanged = endFingerprint !== active.startFingerprint
    const status: ProofStatus = sourceChanged ? 'ERROR' : requestedStatus
    const finalDiagnostic = sourceChanged ? 'SOURCE_CHANGED_DURING_VALIDATION' : diagnostic
    const failures = status === 'PASSED' ? [] : active.output.lines()
    const summary = status === 'PASSED'
      ? `${active.profile.id} completed successfully`
      : status === 'FAILED'
        ? `${active.profile.id} completed with software failures`
        : `${active.profile.id} could not produce a reliable validation result`

    try {
      const proof = this.ledger.recordProof({
        kind: active.profile.proofKind,
        producer: active.producer,
        status,
        startedAt: active.publicRun.startedAt,
        finishedAt,
        durationMs,
        scope: active.targets.length ? active.targets : active.profile.scope,
        sourceFingerprint: endFingerprint,
        runtimeInstanceId: this.runtimeIdentity.getInstanceId(),
        summary: finalDiagnostic ? `${summary}: ${finalDiagnostic}` : summary,
        commandProfile: { command: active.command.displayCommand, cwd: active.command.cwd, exitCode },
        evidenceFor: active.evidenceFor,
        deduplicationKey: active.publicRun.runId
      })
      Object.assign(active.publicRun, { status, finishedAt, durationMs, ...(exitCode !== undefined ? { exitCode } : {}), summary, failures, ...(finalDiagnostic ? { diagnostic: finalDiagnostic } : {}), proofId: proof.proofId })
    } catch (error) {
      Object.assign(active.publicRun, { status: 'ERROR', finishedAt, durationMs, summary: 'Validation proof could not be recorded', failures, diagnostic: `LEDGER_WRITE_FAILED: ${error instanceof Error ? error.message : String(error)}` })
    } finally {
      this.active = null
    }
  }
}
