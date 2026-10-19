import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'
import type { ValidationLedger } from '../validation-ledger/validation-ledger'
import type { ProofProducer, ProofStatus } from '../validation-ledger/validation-ledger-types'
import { ValidationProfileCatalog } from './validation-profile-catalog'
import type { ResolvedValidationCommand, ValidationProfile } from './validation-profile'
import { MCP_REQUEST_BUDGET_MS, VALIDATION_RETRY_AFTER_MS } from '../mcp/operational-guidance'
import { captureValidationSource, validationSourceFingerprint, type ValidationSource } from './validation-source'

export class ValidationBusyError extends Error {
  constructor(readonly activeRunId: string) { super(`VALIDATION_BUSY: ${activeRunId}`) }
}

export type ValidationRunStatus = 'RUNNING' | 'PASSED' | 'FAILED' | 'ERROR'
export interface ValidationCheckoutContext {
  binding: { repositoryId: string; worktreeId: string; generation: string; head: string }
  startFingerprint: string
  fingerprint(): Promise<string>
}

export interface ValidationRun {
  cwd: string
  source?: ValidationSource
  retryAfterMs?: number
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
  source?: ValidationSource
  completion?: Promise<void>
  proofDeduplicationKey: string
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
  private readonly waiters = new Map<string, Set<() => void>>()
  private readonly runs = new Map<string, ValidationRun>()
  private active: ActiveRun | null = null
  private startingRunId: string | null = null
  private stopped = false

  constructor(
    private readonly repoRoot: string,
    private readonly ledger: ValidationLedger,
    private readonly runtimeIdentity: RuntimeIdentityProvider,
    private readonly catalog = new ValidationProfileCatalog(),
    private readonly checkout?: ValidationCheckoutContext,
    private readonly repositoryId: string | null = null
  ) {}

  listProfiles(): ValidationProfile[] {
    return this.catalog.list()
  }

  async start(input: StartValidationInput): Promise<ValidationRun> {
    const activeRunId = this.getActiveRunId()
    if (activeRunId) throw new ValidationBusyError(activeRunId)
    if (this.stopped) throw new Error('VALIDATION_EXECUTION_STOPPED')
    const resolved = this.catalog.resolve(this.repoRoot, input.profileId, input.targets)
    const runId = `run-${randomUUID()}`
    const publicRun: ValidationRun = { runId, cwd: resolved.command.cwd, profileId: resolved.profile.id, status: 'RUNNING', retryAfterMs: VALIDATION_RETRY_AFTER_MS, startedAt: new Date().toISOString() }
    this.runs.set(runId, publicRun)
    this.startingRunId = runId
    let source: ValidationSource | undefined
    try {
      source = this.checkout ? undefined : await captureValidationSource(resolved.command.cwd, this.repositoryId)
      if (this.stopped) throw new Error('VALIDATION_EXECUTION_STOPPED')
      publicRun.source = source
    } catch (error) {
      Object.assign(publicRun, { status: 'ERROR', finishedAt: new Date().toISOString(), diagnostic: 'CHECKOUT_IDENTITY_UNAVAILABLE' })
      delete publicRun.retryAfterMs
      throw error
    } finally { this.startingRunId = null }
    const output = new BoundedOutput()
    const child = spawn(resolved.command.executable, resolved.command.args, {
      cwd: resolved.command.cwd,
      env: process.env,
      windowsHide: true,
      shell: false,
      stdio: 'pipe'
    })
    const active: ActiveRun = {
      source,
      proofDeduplicationKey: this.checkout ? `${runId}:${randomUUID()}` : runId,
      publicRun,
      profile: resolved.profile,
      targets: resolved.targets,
      command: resolved.command,
      producer: input.producer,
      evidenceFor: input.evidenceFor ?? [],
      startFingerprint: this.checkout?.startFingerprint ?? validationSourceFingerprint(source!),
      child,
      timeout: setTimeout(() => this.finish(active, 'ERROR', undefined, 'VALIDATION_TIMEOUT'), resolved.profile.timeoutMs),
      output
    }
    this.active = active
    child.stdout.on('data', (chunk) => output.append(chunk))
    child.stderr.on('data', (chunk) => output.append(chunk))
    child.once('error', (error) => void this.finish(active, 'ERROR', undefined, `SPAWN_FAILED: ${error.message}`))
    child.once('exit', (code, signal) => {
      if (this.active !== active) return
      if (signal) void this.finish(active, 'ERROR', code ?? undefined, `PROCESS_INTERRUPTED: ${signal}`)
      else void this.finish(active, code === 0 ? 'PASSED' : 'FAILED', code ?? undefined)
    })
    return this.get(runId)!
  }

  get(runId: string): ValidationRun | null {
    const run = this.runs.get(runId)
    return run ? { ...run, source: run.source ? { ...run.source } : undefined, failures: run.failures ? [...run.failures] : undefined } : null
  }

  getActiveRunId(): string | null { return this.active?.publicRun.runId ?? this.startingRunId }

  async wait(runId: string, waitMs: number, deadlineAtMs = Date.now() + MCP_REQUEST_BUDGET_MS): Promise<ValidationRun | null> {
    const run = this.get(runId)
    if (!run || run.status !== 'RUNNING' || !waitMs) return run
    const boundedWait = Math.max(0, Math.min(waitMs, 15_000, deadlineAtMs - Date.now() - 1000))
    if (!boundedWait) return run
    await new Promise<void>((resolve) => {
      const waiters = this.waiters.get(runId) ?? new Set<() => void>()
      this.waiters.set(runId, waiters)
      const done = () => {
        clearTimeout(timer); waiters.delete(done)
        if (!waiters.size) this.waiters.delete(runId)
        resolve()
      }
      const timer = setTimeout(done, boundedWait)
      waiters.add(done)
    })
    return this.get(runId)
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    const active = this.active
    if (!active) return
    active.child.kill()
    await this.finish(active, 'ERROR', undefined, 'PROCESS_INTERRUPTED_BY_SHUTDOWN')
  }

  private finish(active: ActiveRun, requestedStatus: ProofStatus, exitCode?: number, diagnostic?: string): Promise<void> {
    return active.completion ??= this.complete(active, requestedStatus, exitCode, diagnostic)
  }

  private async complete(active: ActiveRun, requestedStatus: ProofStatus, exitCode?: number, diagnostic?: string): Promise<void> {
    if (this.active !== active) return
    clearTimeout(active.timeout)
    if (requestedStatus === 'ERROR' && active.child.exitCode === null) active.child.kill()
    const finishedAt = new Date().toISOString()
    const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(active.publicRun.startedAt))
    let endFingerprint: string
    try { endFingerprint = this.checkout ? await this.checkout.fingerprint() : validationSourceFingerprint(await captureValidationSource(active.command.cwd, this.repositoryId)) }
    catch { endFingerprint = 'CHECKOUT_UNAVAILABLE' }
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
        sourceFingerprint: active.startFingerprint,
        runtimeInstanceId: this.runtimeIdentity.getInstanceId(),
        summary: finalDiagnostic ? `${summary}: ${finalDiagnostic}` : summary,
        commandProfile: { command: active.command.displayCommand, cwd: active.command.cwd, exitCode, ...(active.source ? { source: active.source } : {}), ...(this.checkout ? { checkout: { ...this.checkout.binding, issuer: 'VALIDATION_EXECUTION' as const, runId: active.publicRun.runId } } : {}) },
        evidenceFor: active.evidenceFor,
        deduplicationKey: active.proofDeduplicationKey
      })
      Object.assign(active.publicRun, { status, finishedAt, durationMs, ...(exitCode !== undefined ? { exitCode } : {}), summary, failures, ...(finalDiagnostic ? { diagnostic: finalDiagnostic } : {}), proofId: proof.proofId })
    } catch (error) {
      Object.assign(active.publicRun, { status: 'ERROR', finishedAt, durationMs, summary: 'Validation proof could not be recorded', failures, diagnostic: `LEDGER_WRITE_FAILED: ${error instanceof Error ? error.message : String(error)}` })
    } finally {
      delete active.publicRun.retryAfterMs
      this.active = null
      for (const done of [...this.waiters.get(active.publicRun.runId) ?? []]) done()
    }
  }
}
