import { RepositoryFileEditing, type FileMutationIntent, type TextChange } from '../repository-file-ingress/repository-file-editing'
import type { GitOperationsService } from './../git-operations/git-operations-service'
import type { WorktreeSnapshot } from './../git-operations/git-worktree-ownership'
import type { McpToolResult } from '../mcp/mcp-types'
import { operationalFailure } from '../mcp/operational-guidance'
import { focalDiff, type FocalDiff } from './focal-diff'

const HEX64 = /^[a-f0-9]{64}$/
const HEAD_HEX = /^[a-f0-9]{40,64}$/
const OPERATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const TEXT_LIMIT = 1024 * 1024

interface ParsedEditRequest {
  worktreeId: string
  generation: string
  leaseId?: string
  leaseCredential?: string
  operationId: string
  snapshot: WorktreeSnapshot
  intent: FileMutationIntent
  changes: TextChange[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(object: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(object)
  return actual.length === keys.length && keys.every(key => Object.hasOwn(object, key))
}

function parseEditRequest(args: unknown): { ok: true; value: ParsedEditRequest } | { ok: false; code: 'INVALID_ARGUMENT' | 'REQUEST_TOO_LARGE' } {
  if (!isPlainObject(args)) return { ok: false, code: 'INVALID_ARGUMENT' }
  const requiredKeys = ['worktreeId', 'generation', 'operationId', 'snapshot', 'intent', 'changes']
  const allowedKeys = [...requiredKeys, 'leaseId', 'leaseCredential']
  if (requiredKeys.some(key => !Object.hasOwn(args, key)) || Object.keys(args).some(key => !allowedKeys.includes(key))) {
    return { ok: false, code: 'INVALID_ARGUMENT' }
  }
  const { worktreeId, generation, leaseId, leaseCredential, operationId, snapshot, intent, changes } = args
  const hasLeaseId = leaseId !== undefined
  const hasLeaseCredential = leaseCredential !== undefined
  if (hasLeaseId !== hasLeaseCredential) {
    return { ok: false, code: 'INVALID_ARGUMENT' }
  }
  if (
    typeof worktreeId !== 'string' || !HEX64.test(worktreeId) ||
    typeof generation !== 'string' || !HEX64.test(generation) ||
    (hasLeaseId && (typeof leaseId !== 'string' || !leaseId.length)) ||
    (hasLeaseCredential && (typeof leaseCredential !== 'string' || !HEX64.test(leaseCredential))) ||
    typeof operationId !== 'string' || !OPERATION_ID.test(operationId)
  ) {
    return { ok: false, code: 'INVALID_ARGUMENT' }
  }

  if (!isPlainObject(snapshot) || !hasExactKeys(snapshot, ['branch', 'head', 'indexRevision', 'worktreeRevision', 'operation'])) {
    return { ok: false, code: 'INVALID_ARGUMENT' }
  }
  if (
    (snapshot.branch !== null && typeof snapshot.branch !== 'string') ||
    (snapshot.head !== null && (typeof snapshot.head !== 'string' || !HEAD_HEX.test(snapshot.head))) ||
    typeof snapshot.indexRevision !== 'string' || !HEX64.test(snapshot.indexRevision) ||
    typeof snapshot.worktreeRevision !== 'string' || !HEX64.test(snapshot.worktreeRevision) ||
    (snapshot.operation !== null && typeof snapshot.operation !== 'string')
  ) {
    return { ok: false, code: 'INVALID_ARGUMENT' }
  }

  if (!isPlainObject(intent) || !hasExactKeys(intent, ['description']) || typeof intent.description !== 'string' || !intent.description.trim() || intent.description.length > 1000) {
    return { ok: false, code: 'INVALID_ARGUMENT' }
  }

  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 16) {
    return { ok: false, code: 'INVALID_ARGUMENT' }
  }

  const parsedChanges: TextChange[] = []
  let aggregateBytes = 0
  for (const item of changes) {
    if (!isPlainObject(item) || (item.operation !== 'EDIT' && item.operation !== 'CREATE')) {
      return { ok: false, code: 'INVALID_ARGUMENT' }
    }
    if (item.operation === 'EDIT') {
      if (!hasExactKeys(item, ['operation', 'path', 'expectedSha256', 'replacements'])) {
        return { ok: false, code: 'INVALID_ARGUMENT' }
      }
      if (typeof item.path !== 'string' || !item.path.length || typeof item.expectedSha256 !== 'string' || !HEX64.test(item.expectedSha256)) {
        return { ok: false, code: 'INVALID_ARGUMENT' }
      }
      if (!Array.isArray(item.replacements) || item.replacements.length < 1 || item.replacements.length > 32) {
        return { ok: false, code: 'INVALID_ARGUMENT' }
      }
      const replacements: Array<{ oldText: string; newText: string }> = []
      for (const patch of item.replacements) {
        if (!isPlainObject(patch) || !hasExactKeys(patch, ['oldText', 'newText']) || typeof patch.oldText !== 'string' || !patch.oldText.length || typeof patch.newText !== 'string') {
          return { ok: false, code: 'INVALID_ARGUMENT' }
        }
        aggregateBytes += Buffer.byteLength(patch.oldText, 'utf8') + Buffer.byteLength(patch.newText, 'utf8')
        if (aggregateBytes > TEXT_LIMIT) return { ok: false, code: 'REQUEST_TOO_LARGE' }
        replacements.push({ oldText: patch.oldText, newText: patch.newText })
      }
      parsedChanges.push({ operation: 'EDIT', path: item.path, expectedSha256: item.expectedSha256, replacements })
    } else {
      if (!hasExactKeys(item, ['operation', 'path', 'text']) || typeof item.path !== 'string' || !item.path.length || typeof item.text !== 'string') {
        return { ok: false, code: 'INVALID_ARGUMENT' }
      }
      aggregateBytes += Buffer.byteLength(item.text, 'utf8')
      if (aggregateBytes > TEXT_LIMIT) return { ok: false, code: 'REQUEST_TOO_LARGE' }
      parsedChanges.push({ operation: 'CREATE', path: item.path, text: item.text })
    }
  }

  return {
    ok: true,
    value: {
      worktreeId,
      generation,
      ...(hasLeaseId ? { leaseId: leaseId as string, leaseCredential: leaseCredential as string } : {}),
      operationId,
      snapshot: {
        branch: snapshot.branch as string | null,
        head: snapshot.head as string | null,
        indexRevision: snapshot.indexRevision,
        worktreeRevision: snapshot.worktreeRevision,
        operation: snapshot.operation as string | null
      },
      intent: { description: intent.description },
      changes: parsedChanges
    }
  }
}

export async function editWorktreeText(
  service: GitOperationsService,
  args: unknown,
  options?: {
    sessionWitness?: import('../../shared/types/delivery-context-types').AuthenticatedSessionWitness
    authority?: {
      repositoryId: string
      transport: string
      worktreeId?: string
      deliveryContext?: import('../../shared/types/delivery-context-types').DeliveryContextRequest
      isActive: () => boolean
    }
  }
): Promise<McpToolResult> {
  const parsed = parseEditRequest(args)
  if (!parsed.ok) {
    return { content: [{ type: 'text', text: JSON.stringify({ code: parsed.code }) }], isError: true }
  }
  const req = parsed.value
  const fingerprintArgs = {
    worktreeId: req.worktreeId,
    generation: req.generation,
    ...(req.leaseId !== undefined ? { leaseId: req.leaseId } : {}),
    snapshot: req.snapshot,
    intent: req.intent,
    changes: req.changes
  }

  let pendingDiff: FocalDiff | undefined
  try {
    const result = await service.executeWorktreeEdit(
      {
        worktreeId: req.worktreeId,
        generation: req.generation,
        ...(req.leaseId !== undefined ? { leaseId: req.leaseId, leaseCredential: req.leaseCredential } : {}),
        operationId: req.operationId,
        snapshot: req.snapshot,
        paths: req.changes.map(item => item.path)
      },
      fingerprintArgs,
      async ctx => {
        const editor = new RepositoryFileEditing(ctx.root, { isActive: ctx.isActive })
        const batch = await editor.applyTextBatch(req.changes, req.intent, () => ctx.beforePublish())
        let state = batch.state
        let code = batch.code
        let finalCheckFailed = false
        if (batch.state !== 'REJECTED' && batch.state !== 'NO_CHANGE') {
          try {
            await ctx.finalCheck()
          } catch {
            finalCheckFailed = true
            if (state === 'APPLIED') {
              state = 'PARTIAL'
              code = 'EDIT_PARTIAL'
            }
          }
        }
        if (batch.previews.length) pendingDiff = focalDiff(batch.previews)
        let snapshotAfter: WorktreeSnapshot | undefined
        try { snapshotAfter = await ctx.observeSnapshot() } catch {}
        const value: Record<string, unknown> = {
          state,
          ...(code ? { code } : {}),
          worktreeId: req.worktreeId,
          generation: req.generation,
          repositoryId: ctx.repositoryId,
          ...(snapshotAfter ? { snapshot: snapshotAfter } : {}),
          ...(finalCheckFailed ? { finalCheck: 'GIT_STATE_CHANGED' } : {}),
          files: batch.files
        }
        const isError = state === 'REJECTED' || state === 'PARTIAL' || state === 'UNKNOWN'
        return { value, ...(isError ? { isError: true as const } : {}), preserveGrant: state === 'REJECTED' }
      },
      options
    )

    const outValue: Record<string, unknown> = { ...result.value }
    const hasChangedFiles = Array.isArray(outValue.files) && outValue.files.some((file: { changed?: boolean }) => file.changed)
    if (outValue.replayed === true) {
      if (hasChangedFiles) outValue.diff = { omitted: 'REPLAY' }
    } else if (pendingDiff) {
      outValue.diff = pendingDiff
    }
    return { content: [{ type: 'text', text: JSON.stringify(outValue) }], ...(result.isError ? { isError: true } : {}) }
  } catch (error) {
    const code = error instanceof Error ? error.message : 'WORKTREE_OPERATION_FAILED'
    if (['RECEIPT_BUSY', 'RECEIPT_CAPACITY_EXCEEDED'].includes(code)) {
      return operationalFailure({
        code,
        operationId: req.operationId,
        retryability: 'SAME_OPERATION_ID',
        retryAfterMs: 2000,
        recommendedAction: 'RECOVER_SAME_OPERATION'
      })
    }
    return { content: [{ type: 'text', text: JSON.stringify({ code }) }], isError: true }
  }
}
