import { createHash } from 'node:crypto'
import type { GitService } from '../core/git-service'
import type { McpToolResult } from '../mcp/channel-mcp-adapter'
import { operationalFailure } from '../mcp/operational-guidance'

export interface GitOperationReceipt {
  operationId: string
  operation: string
  argumentFingerprint: string
  status: 'PREPARED' | 'COMPLETED' | 'FAILED'
  createdAt: string
  completedAt?: string
  result?: McpToolResult
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}

export function isReceiptedGitMutation(name: string, args: Record<string, unknown>): boolean {
  if (['commit_git_changes', 'merge_git_branch', 'revert_git_commit', 'resolve_git_conflict'].includes(name)) return true
  if (['manage_git_branch', 'manage_git_shelf'].includes(name)) return args.action !== 'LIST'
  if (name === 'manage_gitignore') return args.action === 'ADD'
  return name === 'sync_git_remote' && args.action !== 'FETCH'
}

export class GitOperationReceipts {
  constructor(private readonly root: string, private readonly git: GitService) {}

  async execute(operationId: string, operation: string, args: Record<string, unknown>, mutate: () => Promise<McpToolResult>): Promise<McpToolResult> {
    const fingerprint = createHash('sha256').update(JSON.stringify(canonical({ operation, args }))).digest('hex')
    const recover = (receipt: GitOperationReceipt): McpToolResult => {
      if (receipt.argumentFingerprint !== fingerprint) return operationalFailure({ code: 'IDEMPOTENCY_CONFLICT', operationId, retryability: 'NOT_SAFE', recommendedAction: 'USE_NEW_OPERATION_ID' })
      if (receipt.status === 'PREPARED') return operationalFailure({ code: 'OPERATION_OUTCOME_UNKNOWN', operationId, retryability: 'NOT_SAFE', recommendedAction: 'RECONCILE_OPERATION' })
      const stored = receipt.result!
      const value = JSON.parse(stored.content[0].text)
      return { ...stored, content: [{ type: 'text', text: JSON.stringify({ ...value, operationId, replayed: true }) }] }
    }
    const existing = await this.git.readOperationReceipt(this.root, operationId)
    if (existing) return recover(existing.receipt)
    const receipt: GitOperationReceipt = { operationId, operation, argumentFingerprint: fingerprint, status: 'PREPARED', createdAt: new Date().toISOString() }
    const prepared = await this.git.prepareOperationReceipt(this.root, receipt)
    if (!prepared.created) return recover(prepared.receipt)
    const result = await mutate()
    const value = JSON.parse(result.content[0].text)
    const safeFailures = new Set(['INVALID_ARGUMENT', 'INVALID_REF', 'PATH_OUTSIDE_REPOSITORY', 'NOT_GIT_REPOSITORY', 'GIT_STATE_CHANGED', 'CONFLICT_STATE_CHANGED', 'CONFLICT_NOT_FOUND', 'SHELF_NOT_FOUND', 'SHELF_REQUIRES_HEAD', 'NOTHING_TO_SHELVE', 'NOTHING_TO_COMMIT', 'GIT_OPERATION_IN_PROGRESS', 'GIT_OPERATION_NOT_IN_PROGRESS', 'BINARY_CONFLICT_CONTENT_UNSUPPORTED', 'CONFLICT_SIDE_UNAVAILABLE', 'BRANCH_ALREADY_EXISTS', 'BRANCH_NOT_FOUND', 'REMOTE_NOT_FOUND'])
    if (result.isError && !safeFailures.has(value.code)) return operationalFailure({ code: 'OPERATION_OUTCOME_UNKNOWN', operationId, retryability: 'NOT_SAFE', recommendedAction: 'RECONCILE_OPERATION' })
    const completed = { ...receipt, status: result.isError ? 'FAILED' as const : 'COMPLETED' as const, result, completedAt: new Date().toISOString() }
    try { await this.git.completeOperationReceipt(this.root, completed, prepared.sha) }
    catch { return operationalFailure({ code: 'OPERATION_OUTCOME_UNKNOWN', operationId, retryability: 'NOT_SAFE', recommendedAction: 'RECONCILE_OPERATION' }) }
    return { ...result, content: [{ type: 'text', text: JSON.stringify({ ...value, operationId, replayed: false }) }] }
  }
}
