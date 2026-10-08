import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { GitService } from '../core/git-service'
import type { ValidationLedger } from '../validation-ledger/validation-ledger'
import type { RecordProofInput, ValidationProof } from '../validation-ledger/validation-ledger-types'
import { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'
import { GitWorktreeRegistry } from './git-worktree-registry'
import { GitWorktreeLifecycle } from './git-worktree-lifecycle'
import { GitWorktreeOwnership, type WorktreeObservation } from './git-worktree-ownership'
import { GitWorktreeValidation } from './git-worktree-validation'

it('keeps interrupted checkout validation blocked until explicit local reconciliation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'validation-ownership-'))
  const common = join(root, 'common'), admin = join(common, 'admin'), workspace = join(root, 'managed workspace')
  mkdirSync(admin, { recursive: true }); mkdirSync(workspace)
  const source = join(workspace, 'source.txt')
  writeFileSync(source, 'before')
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node run.cjs' } }))
  writeFileSync(join(workspace, 'run.cjs'), 'setTimeout(() => process.exit(0), 300)')
  const head = 'a'.repeat(40), index = 'b'.repeat(64)
  const revision = () => createHash('sha256').update(readFileSync(source)).digest('hex')
  const git = { getCommonDirectory: async () => common, getWorktreeDirectory: async () => admin,
    listWorktreeRecords: async () => `worktree ${workspace}\0HEAD ${head}\0branch refs/heads/integration\0\0`,
    getIndexRevision: async () => index, getWorktreeRevision: async () => revision() } as unknown as GitService
  const identity = { repositoryId: 'repository', isActive: () => true }
  const record = (await new GitWorktreeRegistry(root, git, identity).discover()).worktrees[0]
  new GitWorktreeLifecycle(common).save({ ...record, repositoryId: identity.repositoryId, startPoint: head, createdAt: new Date().toISOString() })
  const proofs = new Map<string, ValidationProof>()
  const ledger = { recordProof: (input: RecordProofInput) => {
    const proof = { ...input, proofId: 'proof-real-process', recordedAt: new Date().toISOString() } as ValidationProof
    proofs.set(proof.proofId, proof); return proof
  }, getProof: (id: string) => proofs.get(id) ?? null } as unknown as ValidationLedger
  const validation = new GitWorktreeValidation(root, git, identity, ledger, new RuntimeIdentityProvider({ rootDir: root, includedDirectories: [], includedRootFiles: [] }))
  try {
    const run = await validation.start(record.worktreeId, { profileId: 'typecheck' })
    expect(await validation.busy(record.worktreeId)).toBe(true)
    writeFileSync(source, 'concurrent write')
    await vi.waitFor(async () => expect((await validation.get(run.runId)).status).toBe('ERROR'), { timeout: 15000, interval: 50 })
    expect(await validation.get(run.runId)).toMatchObject({ diagnostic: 'SOURCE_CHANGED_DURING_VALIDATION' })
    const marker = join(common, 'code-awareness-validation-locks', record.worktreeId + '.lock')
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ state: 'RECOVERY_PENDING', worktreeId: record.worktreeId })
    expect(await validation.verify(record.worktreeId, head, ['proof-real-process'])).toBe(false)
    await expect(validation.start(record.worktreeId, { profileId: 'typecheck' })).rejects.toThrow('WORKTREE_VALIDATION_BUSY')
    const observation: WorktreeObservation = { repositoryId: identity.repositoryId, commonDirectory: common, administrativeDirectory: admin,
      worktreeId: record.worktreeId, generation: record.generation, path: workspace, contentRevision: revision(),
      snapshot: { branch: 'integration', head, indexRevision: index, worktreeRevision: revision(), operation: null } }
    const denied = new GitWorktreeOwnership(async () => observation, async () => false)
    const scope = { operations: ['INTEGRATE' as const], paths: [], branches: ['integration'], startPoints: [head] }
    const refusal = await denied.request(record.worktreeId, observation.snapshot, scope, 300, true)
    await vi.waitFor(async () => expect((await denied.accept(refusal.requestId, refusal.requestCredential)).state).toBe('DENIED'))
    expect(await validation.busy(record.worktreeId)).toBe(true)
    const operatorApproved = new GitWorktreeOwnership(async () => observation, async () => true)
    const recovery = await operatorApproved.request(record.worktreeId, observation.snapshot, scope, 300, true)
    await vi.waitFor(async () => expect((await operatorApproved.accept(recovery.requestId, recovery.requestCredential)).state).toBe('KNOWN_GRANTED'))
    expect(await validation.busy(record.worktreeId)).toBe(false)
  } finally { await validation.shutdown(); rmSync(root, { recursive: true, force: true }) }
}, 30000)
