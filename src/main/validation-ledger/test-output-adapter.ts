import { lstat, open, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { GitService } from '../core/git-service'
import { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'
import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'
import { operation, type LocalChannelAdapter } from '../local-agent-channel/local-channel-types'
import { captureValidationSource, validationSourceFingerprint } from '../validation-execution/validation-source'
import type { ValidationLedger } from './validation-ledger'
import type { RecordProofInput } from './validation-ledger-types'
import { receiptDigest } from '../../shared/validation/test-output-receipt.cjs'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const selection = z.object({ repositoryId: z.string().min(1), worktreeId: hash, generation: hash })
const association = z.object({ kind: z.enum(['TARGETED_TEST', 'SUBSYSTEM_TEST', 'E2E', 'TYPECHECK', 'BUILD']),
  scope: z.array(z.string().min(1).max(500)).min(1).max(30), evidenceFor: z.array(z.string().min(1).max(200)).max(30) }).strict()
const source = z.object({ version: z.literal(1), repositoryId: z.string().nullable(), repositoryDirectory: z.string(), cwd: z.string(),
  worktreeId: hash, generation: hash, head: z.string().regex(/^[a-f0-9]{40,64}$/), branch: z.string().nullable(), indexRevision: hash, worktreeRevision: hash }).strict()
const counts = z.object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(),
  todo: z.number().int().nonnegative(), total: z.number().int().positive(), executed: z.number().int().positive() }).strict()
const schema = z.object({ version: z.literal(1), id: z.string().uuid(), digest: hash, cwd: z.string(), startedAt: z.string().datetime(),
  command: z.array(z.string().max(2048)).min(1).max(100),
  finishedAt: z.string().datetime(), durationMs: z.number().int().nonnegative(), exitCode: z.number().int().nullable(), signal: z.string().nullable().optional(),
  state: z.string(), processState: z.string(), validation: z.object({ state: z.string(), runs: z.array(counts).max(100).optional() }).passthrough(),
  ledger: z.object({ association, identity: selection.nullable(), before: source.nullable(), after: source.nullable() }).strict() }).passthrough()

async function readReceipt(root: string, id: string): Promise<z.infer<typeof schema>> {
  let directory = root
  for (const segment of ['.code-awareness', 'test-output', id]) {
    directory = join(directory, segment)
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(await realpath(directory)) !== resolve(directory)) throw new Error('INVALID_RECEIPT_PATH')
  }
  const file = join(directory, 'receipt.json'), stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 || resolve(await realpath(file)) !== resolve(file)) throw new Error('INVALID_RECEIPT_PATH')
  const handle = await open(file, 'r')
  try {
    const actual = await handle.stat()
    if (actual.ino !== stat.ino || actual.size !== stat.size) throw new Error('RECEIPT_CHANGED')
    const bytes = Buffer.alloc(stat.size + 1)
    let size = 0
    while (size < bytes.length) { const read = await handle.read(bytes, size, bytes.length - size, size); if (!read.bytesRead) break; size += read.bytesRead }
    const after = await handle.stat()
    if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('RECEIPT_CHANGED')
    const raw = JSON.parse(bytes.subarray(0, size).toString('utf8'))
    if (receiptDigest(raw) !== raw.digest) throw new Error('RECEIPT_INTEGRITY_ERROR')
    const parsed = schema.safeParse(raw)
    if (!parsed.success) throw new Error('INVALID_RECEIPT')
    return parsed.data
  } finally { await handle.close() }
}

export class TestOutputLocalAdapter implements LocalChannelAdapter {
  readonly domain = 'validation'
  readonly operations: LocalChannelAdapter['operations']
  constructor(session: RepositoryContinuumSession, ledger: ValidationLedger) {
    const select = async (request: z.infer<typeof selection>, connected: () => boolean) => {
      const active = session.getActiveSession()
      if (!active || active.repositoryId !== request.repositoryId) throw new Error('REPOSITORY_MISMATCH')
      const assertCurrent = () => { if (session.getActiveSession() !== active || !connected()) throw new Error('PROJECT_CONTEXT_CHANGED') }
      const registry = new GitWorktreeRegistry(active.repositoryPath, new GitService(), { repositoryId: active.repositoryId, isActive: () => session.getActiveSession() === active && connected() })
      await registry.discover()
      const tree = await registry.revalidateSelection(request.worktreeId)
      if (tree.generation !== request.generation) throw new Error('WORKTREE_STALE')
      assertCurrent()
      return { tree, assertCurrent }
    }
    this.operations = {
      snapshot: operation(input => selection.strict().parse(input), async (request, context) => {
        const { tree, assertCurrent } = await select(request, context.connected)
        const snapshot = await captureValidationSource(tree.path, request.repositoryId)
        assertCurrent()
        return snapshot
      }),
      register: operation(input => selection.extend({ receiptId: z.string().uuid(), association: association.optional() }).strict().parse(input), async (request, context) => {
        const { tree, assertCurrent } = await select(request, context.connected)
        const receipt = await readReceipt(await realpath(tree.path), request.receiptId)
        if (receipt.id !== request.receiptId || resolve(receipt.cwd) !== resolve(await realpath(tree.path))) throw new Error('RECEIPT_IDENTITY_MISMATCH')
        if (receipt.ledger.identity && JSON.stringify(receipt.ledger.identity) !== JSON.stringify({ repositoryId: request.repositoryId, worktreeId: request.worktreeId, generation: request.generation })) throw new Error('RECEIPT_IDENTITY_MISMATCH')
        for (const snapshot of [receipt.ledger.before, receipt.ledger.after]) {
          if (snapshot && (snapshot.repositoryId !== request.repositoryId || snapshot.worktreeId !== tree.worktreeId || snapshot.generation !== tree.generation || resolve(snapshot.cwd) !== resolve(tree.path))) throw new Error('RECEIPT_IDENTITY_MISMATCH')
        }
        const declared = request.association ?? receipt.ledger.association
        if (request.association && receipt.ledger.association.evidenceFor.length && JSON.stringify(request.association) !== JSON.stringify(receipt.ledger.association)) throw new Error('RECEIPT_ASSOCIATION_CONFLICT')
        const before = receipt.ledger.before, after = receipt.ledger.after
        const changed = before && after && validationSourceFingerprint(before) !== validationSourceFingerprint(after)
        const tests = ['TARGETED_TEST', 'SUBSYSTEM_TEST', 'E2E'].includes(declared.kind)
        const runs = receipt.validation.runs
        const sufficient = receipt.validation.state === 'SUFFICIENT' && !!runs?.length && runs.every(c => c.failed === 0 && c.passed > 0 && c.executed === c.passed + c.failed && c.total === c.passed + c.failed + c.skipped + c.todo)
        const command = receipt.command.map(value => value.replaceAll('\\', '/'))
        const observable = tests || (declared.kind === 'TYPECHECK'
          ? command.some(value => /(?:^|\/)(?:typecheck-gate\.cjs|tsc(?:\.js)?)$/.test(value)) || command.includes('run') && command.includes('typecheck')
          : command.includes('build') && (command.includes('run') || command.some(value => /(?:^|\/)electron-vite(?:\.js)?$/.test(value))))
        const success = receipt.processState === 'PASS' && receipt.state === 'PASS' && receipt.exitCode === 0 && !receipt.signal && observable && (!tests || sufficient)
        const incompleteSource = !!before !== !!after
        const status = changed || incompleteSource ? 'ERROR' : success ? 'PASSED' : receipt.processState === 'FAIL' ? 'FAILED' : 'ERROR'
        const input: RecordProofInput = { kind: declared.kind, producer: 'IMPLEMENTER', status,
          startedAt: receipt.startedAt, finishedAt: receipt.finishedAt, durationMs: receipt.durationMs, scope: declared.scope, evidenceFor: declared.evidenceFor,
          sourceFingerprint: before ? validationSourceFingerprint(before) : null,
          summary: `Test Output: ${status}; EXECUTOR_REPORTED; ${changed ? 'SOURCE_CHANGED_DURING_RUN' : before && after ? 'SOURCE_REPORTED' : 'SOURCE_UNAVAILABLE'}`,
          metrics: { durationMs: receipt.durationMs, ...(sufficient ? { testsPassed: runs!.reduce((n, c) => n + c.passed, 0) } : {}) },
          deduplicationKey: `test-output:${request.repositoryId}:${tree.worktreeId}:${tree.generation}:${receipt.id}`,
          commandProfile: { command: 'test-output', cwd: receipt.cwd, exitCode: receipt.exitCode ?? undefined, ...(before ? { source: before } : {}),
            receipt: { id: receipt.id, digest: receipt.digest, trust: 'EXECUTOR_REPORTED', association: request.association ? 'POST_RUN_DECLARED' : 'RUN_CONFIGURED' } } }
        assertCurrent()
        const proof = ledger.recordReceiptProof(input)
        const confirmed = ledger.getProof(proof.proofId)
        if (!confirmed || confirmed.commandProfile?.receipt?.digest !== receipt.digest) throw new Error('PROOF_READBACK_FAILED')
        return { receiptId: receipt.id, proofId: proof.proofId, state: 'PERSISTED', status: proof.status, trust: 'EXECUTOR_REPORTED', freshness: 'UNVERIFIABLE', evidenceFor: proof.evidenceFor }
      })
    }
  }
}
