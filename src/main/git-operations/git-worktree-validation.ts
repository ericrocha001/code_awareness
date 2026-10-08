import { closeSync, existsSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GitService } from '../core/git-service'
import type { ValidationLedger } from '../validation-ledger/validation-ledger'
import type { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'
import { ValidationExecution } from '../validation-execution/validation-execution'
import { ValidationProfileCatalog } from '../validation-execution/validation-profile-catalog'
import { GitWorktreeRegistry, type WorktreeIdentity } from './git-worktree-registry'
import { GitWorktreeLifecycle } from './git-worktree-lifecycle'
import { ownershipDigest } from './git-worktree-ownership'

export class GitWorktreeValidation {
  private readonly executions = new Map<string, ValidationExecution>()
  private readonly registry: GitWorktreeRegistry
  constructor(private readonly root: string, private readonly git: GitService, private readonly identity: WorktreeIdentity,
    private readonly ledger: ValidationLedger, private readonly runtime: RuntimeIdentityProvider) {
    this.registry = new GitWorktreeRegistry(root, git, identity)
  }

  private async checkout(id: string) {
    await this.registry.discover()
    const record = await this.registry.select(id)
    const common = realpathSync(await this.git.getCommonDirectory(record.path))
    if (!new GitWorktreeLifecycle(common).get(record)) throw new Error('WORKTREE_NOT_MANAGED')
    return { record, common }
  }

  async fingerprint(id: string): Promise<string> {
    const { record } = await this.checkout(id)
    return ownershipDigest({ repositoryId: this.identity.repositoryId, worktreeId: id, generation: record.generation,
      head: record.head, index: await this.git.getIndexRevision(record.path), content: await this.git.getWorktreeRevision(record.path) })
  }

  async busy(id: string): Promise<boolean> {
    const { common } = await this.checkout(id)
    return existsSync(join(common, 'code-awareness-validation-locks', id + '.lock'))
  }

  async start(id: string, input: { profileId: string; targets?: string[]; evidenceFor?: string[] }) {
    if (this.executions.size >= 100) throw new Error('WORKTREE_VALIDATION_CAPACITY')
    const { record, common } = await this.checkout(id)
    if (!record.head) throw new Error('WORKTREE_BRANCH_REQUIRED')
    try { new ValidationProfileCatalog().resolve(record.path, input.profileId, input.targets) }
    catch { throw new Error('INVALID_ARGUMENT') }
    const directory = join(common, 'code-awareness-validation-locks')
    mkdirSync(directory, { recursive: true })
    const lock = join(directory, id + '.lock')
    let descriptor: number
    try { descriptor = openSync(lock, 'wx', 0o600) } catch { throw new Error('WORKTREE_VALIDATION_BUSY') }
    let execution: ValidationExecution | undefined
    try {
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, instanceId: this.runtime.getInstanceId(), worktreeId: id }))
      const startFingerprint = await this.fingerprint(id)
      execution = new ValidationExecution(record.path, this.ledger, this.runtime, undefined, {
        binding: { repositoryId: this.identity.repositoryId, worktreeId: id, generation: record.generation, head: record.head },
        startFingerprint, fingerprint: () => this.fingerprint(id)
      })
      const run = execution.start({ ...input, producer: 'SYSTEM' })
      this.executions.set(run.runId, execution)
      void this.releaseOnCompletion(execution, run.runId, descriptor, lock, id).catch(() => console.error('[GitWorktreeValidation] VALIDATION_LOCK_FINALIZATION_FAILED', run.runId))
      return { ...run, worktreeId: id, head: record.head, validation: 'PENDING' }
    } catch (error) {
      if (execution) await execution.shutdown()
      closeSync(descriptor); unlinkSync(lock)
      throw error
    }
  }

  private async releaseOnCompletion(execution: ValidationExecution, runId: string, descriptor: number, lock: string, worktreeId: string): Promise<void> {
    try { while (execution.get(runId)?.status === 'RUNNING') await execution.wait(runId, 15000) }
    finally {
      closeSync(descriptor)
      if (execution.get(runId)?.status === 'ERROR') {
        writeFileSync(lock, JSON.stringify({ pid: process.pid, instanceId: this.runtime.getInstanceId(), worktreeId, state: 'RECOVERY_PENDING' }))
      } else { try { unlinkSync(lock) } catch {} }
    }
  }

  async get(runId: string) {
    const execution = this.executions.get(runId)
    if (!execution) throw new Error('WORKTREE_VALIDATION_RUN_NOT_FOUND')
    const run = execution.get(runId)!
    const proof = run.proofId ? this.ledger.getProof(run.proofId) : null
    const checkout = proof?.commandProfile?.checkout
    let freshness: 'CURRENT' | 'SOURCE_STALE' | 'UNVERIFIABLE' = 'UNVERIFIABLE'
    if (checkout) {
      try { freshness = proof!.sourceFingerprint === await this.fingerprint(checkout.worktreeId) ? 'CURRENT' : 'SOURCE_STALE' }
      catch { freshness = 'SOURCE_STALE' }
    }
    return { ...run, checkout, freshness }
  }

  async verify(id: string, commit: string, proofIds: string[]): Promise<boolean> {
    if (!proofIds.length || await this.busy(id)) return false
    const { record } = await this.checkout(id)
    if (record.head !== commit) return false
    const fingerprint = await this.fingerprint(id)
    let behavioralProof = false
    for (const proofId of proofIds) {
      const proof = this.ledger.getProof(proofId)
      const checkout = proof?.commandProfile?.checkout
      if (!proof || proof.status !== 'PASSED' || proof.producer !== 'SYSTEM' || proof.runtimeInstanceId !== this.runtime.getInstanceId() ||
        proof.sourceFingerprint !== fingerprint || checkout?.issuer !== 'VALIDATION_EXECUTION' || checkout.repositoryId !== this.identity.repositoryId ||
        checkout.worktreeId !== id || checkout.generation !== record.generation || checkout.head !== commit || proof.commandProfile?.cwd !== record.path ||
        this.executions.get(checkout.runId)?.get(checkout.runId)?.proofId !== proofId || this.executions.get(checkout.runId)?.get(checkout.runId)?.status !== 'PASSED') return false
      behavioralProof ||= ['TARGETED_TEST', 'SUBSYSTEM_TEST', 'FULL_TEST_SUITE', 'E2E'].includes(proof.kind)
    }
    return behavioralProof
  }

  async shutdown(): Promise<void> { await Promise.all([...this.executions.values()].map(execution => execution.shutdown())) }
}
