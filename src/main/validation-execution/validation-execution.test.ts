import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'
import type { RecordProofInput, ValidationProof } from '../validation-ledger/validation-ledger-types'
import type { ValidationLedger } from '../validation-ledger/validation-ledger'
import { executeValidationTool } from './validation-execution-mcp'
import { ValidationExecution } from './validation-execution'

const roots: string[] = []
const origins: Promise<void>[] = []
const executions: ValidationExecution[] = []
afterEach(async () => {
  await Promise.all(executions.splice(0).map(execution => execution.shutdown()))
  await Promise.all(origins.splice(0))
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

function repository(script: string): string {
  const root = mkdtempSync(join(tmpdir(), 'validation-execution-'))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { typecheck: script } }), 'utf8')
  execFileSync('git', ['init'], { cwd: root, windowsHide: true })
  execFileSync('git', ['add', 'package.json'], { cwd: root, windowsHide: true })
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture'], { cwd: root, windowsHide: true })
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
  origins.push(identity.sourceOriginReady)
  const execution = new ValidationExecution(root, ledger, identity, catalog as any)
  executions.push(execution)
  return { root, proofs, ledger, identity, execution }
}

async function terminal(execution: ValidationExecution, runId: string) {
  await vi.waitFor(() => expect(execution.get(runId)?.status).not.toBe('RUNNING'), { timeout: 10_000, interval: 20 })
  return execution.get(runId)!
}

describe('ValidationExecution', () => {
  it('rejects changes in checkout A when the runtime source is linked worktree B', async () => {
    const f = setup('node -e "setTimeout(() => process.exit(0), 300)"')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.root, windowsHide: true })
    const runtimeRoot = f.root + '-runtime'
    git('worktree', 'add', '-b', 'runtime', runtimeRoot)
    roots.unshift(runtimeRoot)
    const identity = new RuntimeIdentityProvider({ rootDir: runtimeRoot })
    origins.push(identity.sourceOriginReady)
    const execution = new ValidationExecution(f.root, f.ledger, identity)
    executions.push(execution)
    const run = await execution.start({ profileId: 'typecheck', producer: 'TESTER' })
    writeFileSync(join(f.root, 'changed.test.ts'), 'export const changed = true')
    expect(await terminal(execution, run.runId)).toMatchObject({ status: 'ERROR', diagnostic: 'SOURCE_CHANGED_DURING_VALIDATION' })
    const stable = await execution.start({ profileId: 'typecheck', producer: 'TESTER', evidenceFor: ['checkout-A'] })
    writeFileSync(join(runtimeRoot, 'runtime-only.ts'), 'export const runtimeChanged = true')
    expect(await terminal(execution, stable.runId)).toMatchObject({ status: 'PASSED' })
    expect(f.proofs[1]).toMatchObject({ runtimeInstanceId: identity.getInstanceId(), evidenceFor: ['checkout-A'], commandProfile: { cwd: f.root, source: { cwd: f.root, version: 1 } } })
  }, 30000)

  it('reports a target in another checkout without executing and keeps active targets working', async () => {
    const f = setup('node -e "process.exit(0)"')
    const other = repository('node -e "process.exit(0)"')
    const target = 'pr-only.test.ts'
    writeFileSync(join(other, target), '')
    const marker = join(f.root, 'executed.txt')
    writeFileSync(join(f.root, '.gitignore'), 'executed.txt\n')
    const script = `node -e "require('fs').writeFileSync('executed.txt', 'yes')"`
    writeFileSync(join(f.root, 'package.json'), JSON.stringify({ scripts: { 'test:node': script } }))
    const rejected = await executeValidationTool(f.execution, 'start_validation', { profileId: 'test-node-targeted', targets: [target], producer: 'TESTER' })
    expect(rejected.isError).toBe(true)
    expect(JSON.parse(rejected.content[0].text)).toMatchObject({ code: 'TARGET_NOT_IN_ACTIVE_CHECKOUT', activeCheckout: f.root, target,
      worktreeRoute: { discover: 'discover_worktrees', start: 'start_worktree_validation', requires: expect.arrayContaining(['MANAGED_WORKTREE', 'EXPLICIT_AUTHORIZATION', 'INTEGRATE_LEASE']), externalWorktree: expect.stringContaining('WORKTREE_NOT_MANAGED') } })
    expect(f.proofs).toHaveLength(0)
    expect(existsSync(marker)).toBe(false)
    writeFileSync(join(f.root, target), '')
    const started = await executeValidationTool(f.execution, 'start_validation', { profileId: 'test-node-targeted', targets: [target], producer: 'TESTER' })
    const run = JSON.parse(started.content[0].text)
    expect(run).toMatchObject({ status: 'RUNNING', cwd: f.root, source: { cwd: f.root } })
    const done = await terminal(f.execution, run.runId)
    expect(done.status).toBe('PASSED')
    expect(existsSync(marker)).toBe(true)
  }, 30000)
  it('binds genuine proofs to checkout identity and rejects checkout drift independently of the primary fingerprint', async () => {
    const f = setup('node -e "setTimeout(() => process.exit(0), 100)"')
    let fingerprint = 'checkout-before'
    const binding = { repositoryId: 'repo', worktreeId: 'worktree', generation: 'generation', head: 'a'.repeat(40) }
    const execution = new ValidationExecution(f.root, f.ledger, f.identity, undefined, { binding, startFingerprint: fingerprint, fingerprint: async () => fingerprint })
    const run = await execution.start({ profileId: 'typecheck', producer: 'SYSTEM' })
    expect(await terminal(execution, run.runId)).toMatchObject({ status: 'PASSED' })
    expect(f.proofs[0]).toMatchObject({ sourceFingerprint: 'checkout-before', commandProfile: { cwd: f.root, checkout: { ...binding, issuer: 'VALIDATION_EXECUTION', runId: run.runId } } })
    expect(f.proofs[0].deduplicationKey).not.toBe(run.runId)
    const changed = await execution.start({ profileId: 'typecheck', producer: 'SYSTEM' })
    fingerprint = 'checkout-after'
    expect(await terminal(execution, changed.runId)).toMatchObject({ status: 'ERROR', diagnostic: 'SOURCE_CHANGED_DURING_VALIDATION' })
    expect(f.proofs).toHaveLength(2)
  }, 30000)
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
    const run = await baseline.execution.start({ profileId: 'typecheck', producer: 'TESTER' })
    let polls = 0
    while (baseline.execution.get(run.runId)?.status === 'RUNNING') {
      polls++
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(polls).toBeGreaterThan(10)
    expect(baseline.proofs).toHaveLength(1)
  }, 30000)
  it('runs asynchronously and records PASSED and FAILED proofs before publishing terminal state', async () => {
    const passed = setup('node -e "setTimeout(() => process.exit(0), 100)"')
    const initial = await passed.execution.start({ profileId: 'typecheck', producer: 'TESTER', evidenceFor: ['acceptance'] })
    expect(initial.status).toBe('RUNNING')
    const passResult = await terminal(passed.execution, initial.runId)
    expect(passResult).toMatchObject({ status: 'PASSED', exitCode: 0, proofId: 'proof-1' })
    expect(passed.proofs[0]).toMatchObject({ status: 'PASSED', producer: 'TESTER', deduplicationKey: initial.runId })

    const failed = setup('node -e "process.exit(2)"')
    const failedRun = await failed.execution.start({ profileId: 'typecheck', producer: 'TESTER' })
    const failResult = await terminal(failed.execution, failedRun.runId)
    expect(failResult).toMatchObject({ status: 'FAILED', exitCode: 2, proofId: 'proof-1' })
    expect(failed.proofs[0].status).toBe('FAILED')
  }, 30000)

  it('enforces one active run per repository and rejects arbitrary execution inputs', async () => {
    const { execution } = setup('node -e "setTimeout(() => process.exit(0), 300)"')
    const preparing = execution.start({ profileId: 'typecheck', producer: 'TESTER' })
    expect(execution.get(execution.getActiveRunId()!)?.status).toBe('RUNNING')
    await expect(execution.start({ profileId: 'typecheck', producer: 'TESTER' })).rejects.toThrow('VALIDATION_BUSY')
    const run = await preparing
    const rejected = await executeValidationTool(execution, 'start_validation', { profileId: 'typecheck', producer: 'TESTER', command: 'whoami', flags: ['--anything'] })
    expect(rejected).toMatchObject({ isError: true })
    await terminal(execution, run.runId)
  }, 30000)

  it('turns source changes during execution into ERROR and still records a proof', async () => {
    const fixture = setup('node -e "setTimeout(() => process.exit(0), 300)"')
    const run = await fixture.execution.start({ profileId: 'typecheck', producer: 'TESTER' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    writeFileSync(join(fixture.root, 'package.json'), JSON.stringify({ name: 'changed', version: '1.0.0', scripts: { typecheck: 'node -e "setTimeout(() => process.exit(0), 300)"' } }))
    const result = await terminal(fixture.execution, run.runId)
    expect(result).toMatchObject({ status: 'ERROR', diagnostic: 'SOURCE_CHANGED_DURING_VALIDATION', proofId: 'proof-1' })
    expect(fixture.proofs[0].status).toBe('ERROR')
  }, 30000)

  it('classifies spawn failure and shutdown interruption as ERROR proofs', async () => {
    const baseProfile = { id: 'broken', description: 'broken', runtime: 'NODE', lane: 'TYPECHECK', acceptsTargets: false, proofKind: 'TYPECHECK', scope: ['repository'], timeoutMs: 1000, script: 'typecheck' }
    const catalog = {
      list: () => [baseProfile],
      resolve: (root: string) => ({ profile: baseProfile, targets: [], command: { executable: 'definitely-not-an-executable', args: [], cwd: root, displayCommand: 'internal broken profile' } })
    }
    const broken = setup('node -e "process.exit(0)"', catalog)
    const run = await broken.execution.start({ profileId: 'broken', producer: 'TESTER' })
    expect(await terminal(broken.execution, run.runId)).toMatchObject({ status: 'ERROR', proofId: 'proof-1' })

    const interrupted = setup('node -e "setTimeout(() => process.exit(0), 5000)"')
    const active = await interrupted.execution.start({ profileId: 'typecheck', producer: 'TESTER' })
    await interrupted.execution.shutdown()
    expect(interrupted.execution.get(active.runId)).toMatchObject({ status: 'ERROR', diagnostic: 'PROCESS_INTERRUPTED_BY_SHUTDOWN', proofId: 'proof-1' })
  }, 30000)
})
