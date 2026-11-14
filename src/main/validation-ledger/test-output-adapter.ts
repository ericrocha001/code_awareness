import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { GitService } from '../core/git-service'
import { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'
import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'
import { operation, type LocalChannelAdapter } from '../local-agent-channel/local-channel-types'
import { captureValidationSource, validationSourceFingerprint } from '../validation-execution/validation-source'
import type { ValidationLedger } from './validation-ledger'
import type { RecordProofInput, ValidationProof } from './validation-ledger-types'
import { receiptDigest } from '../../shared/validation/test-output-receipt.cjs'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const selection = z.object({ repositoryId: z.string().min(1), worktreeId: hash, generation: hash })
const checkout = z.string().min(1).max(32767).refine(value => isAbsolute(value) && !value.includes('\0'))
const target = selection.extend({ cwd: checkout.optional() }).strict()
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
    const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
    const scope = (connected: () => boolean) => {
      const active = session.getActiveSession()
      if (!active) throw new Error('WORKTREE_UNAVAILABLE')
      const current = () => session.getActiveSession() === active && connected()
      const assertCurrent = () => { if (!current()) throw new Error('PROJECT_CONTEXT_CHANGED') }
      const git = new GitService()
      const registry = new GitWorktreeRegistry(active.repositoryPath, git, { repositoryId: active.repositoryId, isActive: current })
      return { active, assertCurrent, git, registry }
    }
    const resolveTree = async (cwd: string, current: ReturnType<typeof scope>) => {
      const absolute = resolve(cwd)
      let root: string
      try {
        if (!samePath(await realpath(absolute), absolute)) throw new Error('WORKTREE_UNLINKED')
        root = resolve(await current.git.getWorktreeRoot(absolute))
      } catch (error) {
        current.assertCurrent()
        if (error instanceof Error && error.message === 'WORKTREE_UNLINKED') throw error
        throw new Error('WORKTREE_UNAVAILABLE')
      }
      current.assertCurrent()
      if (!samePath(await realpath(root), root)) throw new Error('WORKTREE_UNLINKED')
      return current.registry.resolveCheckout(root)
    }
    const select = async (request: z.infer<typeof target>, connected: () => boolean) => {
      const current = scope(connected)
      if (current.active.repositoryId !== request.repositoryId) throw new Error('PROJECT_CONTEXT_CHANGED')
      try {
        let tree
        if (request.cwd) tree = await resolveTree(request.cwd, current)
        else {
          await current.registry.discover()
          tree = await current.registry.revalidateSelection(request.worktreeId)
        }
        if (tree.generation !== request.generation || tree.worktreeId !== request.worktreeId) throw new Error('WORKTREE_STALE')
        current.assertCurrent()
        return { ...current, tree }
      } catch (error) {
        current.assertCurrent()
        if (error instanceof Error && ['WORKTREE_UNLINKED', 'WORKTREE_NOT_DISCOVERED', 'WORKTREE_UNAVAILABLE'].includes(error.message)) throw new Error('WORKTREE_STALE')
        throw error
      }
    }
    const receiptRequest = target.extend({ receiptId: z.string().uuid(), digest: hash.optional(), association: association.optional() }).strict()
    const prepareReceipt = async (request: z.infer<typeof receiptRequest>, connected: () => boolean) => {
      const { tree, assertCurrent } = await select(request, connected)
      const receipt = await readReceipt(await realpath(tree.path), request.receiptId)
      if (request.digest && request.digest !== receipt.digest) throw new Error('RECEIPT_CHANGED')
      if (receipt.id !== request.receiptId || !samePath(resolve(receipt.cwd), resolve(await realpath(tree.path)))) throw new Error('RECEIPT_IDENTITY_MISMATCH')
      if (receipt.ledger.identity && (receipt.ledger.identity.repositoryId !== request.repositoryId || receipt.ledger.identity.worktreeId !== tree.worktreeId || receipt.ledger.identity.generation !== tree.generation)) throw new Error('RECEIPT_IDENTITY_MISMATCH')
      for (const snapshot of [receipt.ledger.before, receipt.ledger.after]) {
        if (snapshot && (snapshot.repositoryId !== request.repositoryId || snapshot.worktreeId !== tree.worktreeId || snapshot.generation !== tree.generation || !samePath(resolve(snapshot.cwd), resolve(tree.path)))) throw new Error('RECEIPT_IDENTITY_MISMATCH')
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
      await select(request, connected)
      assertCurrent()
      return { input, assertCurrent }
    }
    const persisted = (receiptId: string, proof: ValidationProof) =>
      ({ receiptId, proofId: proof.proofId, state: 'PERSISTED', status: proof.status, trust: 'EXECUTOR_REPORTED', freshness: 'UNVERIFIABLE', evidenceFor: proof.evidenceFor })
    this.operations = {
      resolve: operation(input => z.object({ cwd: checkout }).strict().parse(input), async (request, context) => {
        const current = scope(context.connected)
        try {
          const tree = await resolveTree(request.cwd, current)
          current.assertCurrent()
          return { repositoryId: current.active.repositoryId, worktreeId: tree.worktreeId, generation: tree.generation }
        } catch (error) { current.assertCurrent(); throw error }
      }),
      snapshot: operation(input => target.parse(input), async (request, context) => {
        context.markSnapshotPhase?.('select')
        const { tree, git, registry, assertCurrent } = await select(request, context.connected)
        try {
          const snapshot = await captureValidationSource(tree.path, request.repositoryId, { git, registry, record: tree, mark: context.markSnapshotPhase })
          if (snapshot.generation !== request.generation || snapshot.worktreeId !== request.worktreeId) throw new Error('WORKTREE_STALE')
          context.markSnapshotPhase?.('response')
          return snapshot
        } finally {
          assertCurrent()
        }
      }),
      register: operation(input => receiptRequest.parse(input), async (request, context) => {
        const { input, assertCurrent } = await prepareReceipt(request, context.connected)
        assertCurrent()
        const proof = ledger.recordReceiptProof(input)
        const confirmed = ledger.getProof(proof.proofId)
        if (!confirmed || confirmed.commandProfile?.receipt?.digest !== input.commandProfile?.receipt?.digest) throw new Error('PROOF_READBACK_FAILED')
        return persisted(request.receiptId, confirmed)
      }),
      lookup: operation(input => receiptRequest.extend({ digest: hash }).parse(input), async (request, context) => {
        try {
          const { input, assertCurrent } = await prepareReceipt(request, context.connected)
          assertCurrent()
          const proof = ledger.lookupReceiptProof(input)
          return proof ? persisted(request.receiptId, proof) : { state: 'NOT_FOUND' }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : '')
          if (code === 'RECEIPT_IDENTITY_CONFLICT' || code === 'RECEIPT_ASSOCIATION_CONFLICT') return { state: 'AMBIGUOUS', code }
          if (['WORKTREE_STALE', 'PROJECT_CONTEXT_CHANGED', 'RECEIPT_CHANGED', 'RECEIPT_IDENTITY_MISMATCH', 'RECEIPT_INTEGRITY_ERROR', 'INVALID_RECEIPT_PATH', 'ENOENT'].includes(code)) return { state: 'SOURCE_CHANGED', code: code === 'ENOENT' ? 'RECEIPT_UNAVAILABLE' : code }
          return { state: 'UNAVAILABLE' }
        }
      })
    }
  }
}
