import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'
import type { RecordProofInput, ValidationProof } from '../validation-ledger/validation-ledger-types'
import type { ValidationLedger } from '../validation-ledger/validation-ledger'
import { executeValidationTool } from './validation-execution-mcp'
import { ValidationExecution } from './validation-execution'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function repository(script: string): string {
  const root = mkdtempSync(join(tmpdir(), 'validation-execution-'))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { typecheck: script } }), 'utf8')
  return root
}

function setup(script: string, catalog?: unknown) {
  const root = repository(script)
  const proofs: ValidationProof[] = []
  const ledger = {
    recordProof(input: RecordProofInput) {
      const proof = { ...input, proofId: `proof-${proofs.length + 1}`, recordedAt: new Date().toISOString(), sourceFingerprint: input.sourceFingerprint ?? null, runtimeInstanceId: input.runtimeInstanceId ?? null, metrics: input.metrics ?? null, commandProfile: input.commandProfile ?? null, evidenceFor: input.evidenceFor ?? [], deduplicationKey: input.deduplicationKey ?? null } as ValidationProof
      proofs.push(proof)
      return proof
    }
  } as unknown as ValidationLedger
  const identity = new RuntimeIdentityProvider({ rootDir: root, includedDirectories: [], includedRootFiles: ['package.json'], mode: 'development' })
  return { root, proofs, execution: new ValidationExecution(root, ledger, identity, catalog as any) }
}

async function terminal(execution: ValidationExecution, runId: string) {
  await vi.waitFor(() => expect(execution.get(runId)?.status).not.toBe('RUNNING'), { timeout: 10_000, interval: 20 })
  return execution.get(runId)!
}

describe('ValidationExecution', () => {
  it('follows the active run and bounds waiting by the request deadline', async () => {
    const { execution, proofs } = setup('node -e "setTimeout(() => process.exit(0), 300)"')
    const started = JSON.parse((await executeValidationTool(execution, 'start_validation', { profileId: 'typecheck', producer: 'TESTER' })).content[0].text)
    expect(started).toMatchObject({ status: 'RUNNING', retryAfterMs: 2000 })
    const busy = JSON.parse((await executeValidationTool(execution, 'start_validation', { profileId: 'typecheck', producer: 'TESTER' })).content[0].text)
    expect(busy).toMatchObject({ activeRunId: started.runId, recommendedAction: 'FOLLOW_ACTIVE_RUN' })
    const before = Date.now()
    const running = JSON.parse((await executeValidationTool(execution, 'get_validation_run', { runId: started.runId, waitMs: 15000 }, before + 1050)).content[0].text)
    expect(running).toMatchObject({ status: 'RUNNING', retryAfterMs: 2000 })
    expect(Date.now() - before).toBeLessThan(250)
    const done = JSON.parse((await executeValidationTool(execution, 'get_validation_run', { runId: started.runId, waitMs: 5000 })).content[0].text)
    expect(done).toMatchObject({ status: 'PASSED', proofId: 'proof-1' })
    expect(done.retryAfterMs).toBeUndefined()
    expect(proofs).toHaveLength(1)
    const baseline = setup('node -e "setTimeout(() => process.exit(0), 300)"')
    const run = baseline.execution.start({ profileId: 'typecheck', producer: 'TESTER' })
    let polls = 0
    while (baseline.execution.get(run.runId)?.status === 'RUNNING') {
      polls++
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(polls).toBeGreaterThan(10)
    expect(baseline.proofs).toHaveLength(1)
  })
  it('runs asynchronously and records PASSED and FAILED proofs before publishing terminal state', async () => {
    const passed = setup('node -e "setTimeout(() => process.exit(0), 100)"')
    const initial = passed.execution.start({ profileId: 'typecheck', producer: 'TESTER', evidenceFor: ['acceptance'] })
    expect(initial.status).toBe('RUNNING')
    const passResult = await terminal(passed.execution, initial.runId)
    expect(passResult).toMatchObject({ status: 'PASSED', exitCode: 0, proofId: 'proof-1' })
    expect(passed.proofs[0]).toMatchObject({ status: 'PASSED', producer: 'TESTER', deduplicationKey: initial.runId })

    const failed = setup('node -e "process.exit(2)"')
    const failedRun = failed.execution.start({ profileId: 'typecheck', producer: 'TESTER' })
    const failResult = await terminal(failed.execution, failedRun.runId)
    expect(failResult).toMatchObject({ status: 'FAILED', exitCode: 2, proofId: 'proof-1' })
    expect(failed.proofs[0].status).toBe('FAILED')
  })

  it('enforces one active run per repository and rejects arbitrary execution inputs', async () => {
    const { execution } = setup('node -e "setTimeout(() => process.exit(0), 300)"')
    const run = execution.start({ profileId: 'typecheck', producer: 'TESTER' })
    expect(() => execution.start({ profileId: 'typecheck', producer: 'TESTER' })).toThrow('VALIDATION_BUSY')
    const rejected = await executeValidationTool(execution, 'start_validation', { profileId: 'typecheck', producer: 'TESTER', command: 'whoami', flags: ['--anything'] })
    expect(rejected).toMatchObject({ isError: true })
    await terminal(execution, run.runId)
  })

  it('turns source changes during execution into ERROR and still records a proof', async () => {
    const fixture = setup('node -e "setTimeout(() => process.exit(0), 300)"')
    const run = fixture.execution.start({ profileId: 'typecheck', producer: 'TESTER' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    writeFileSync(join(fixture.root, 'package.json'), JSON.stringify({ name: 'changed', version: '1.0.0', scripts: { typecheck: 'node -e "setTimeout(() => process.exit(0), 300)"' } }))
    const result = await terminal(fixture.execution, run.runId)
    expect(result).toMatchObject({ status: 'ERROR', diagnostic: 'SOURCE_CHANGED_DURING_VALIDATION', proofId: 'proof-1' })
    expect(fixture.proofs[0].status).toBe('ERROR')
  })

  it('classifies spawn failure and shutdown interruption as ERROR proofs', async () => {
    const baseProfile = { id: 'broken', description: 'broken', runtime: 'NODE', lane: 'TYPECHECK', acceptsTargets: false, proofKind: 'TYPECHECK', scope: ['repository'], timeoutMs: 1000, script: 'typecheck' }
    const catalog = {
      list: () => [baseProfile],
      resolve: (root: string) => ({ profile: baseProfile, targets: [], command: { executable: 'definitely-not-an-executable', args: [], cwd: root, displayCommand: 'internal broken profile' } })
    }
    const broken = setup('node -e "process.exit(0)"', catalog)
    const run = broken.execution.start({ profileId: 'broken', producer: 'TESTER' })
    expect(await terminal(broken.execution, run.runId)).toMatchObject({ status: 'ERROR', proofId: 'proof-1' })

    const interrupted = setup('node -e "setTimeout(() => process.exit(0), 5000)"')
    const active = interrupted.execution.start({ profileId: 'typecheck', producer: 'TESTER' })
    await interrupted.execution.shutdown()
    expect(interrupted.execution.get(active.runId)).toMatchObject({ status: 'ERROR', diagnostic: 'PROCESS_INTERRUPTED_BY_SHUTDOWN', proofId: 'proof-1' })
  })
})
