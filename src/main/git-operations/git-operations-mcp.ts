import type { McpToolDefinition, McpToolResult } from '../mcp/channel-mcp-adapter'
import { GitOperationsError, type GitOperationsService, type BranchRequest, type MergeRequest, type SyncRequest, type ShelfRequest, type RevertRequest, type GitIgnoreRequest } from './git-operations-service'
import { isReceiptedGitMutation } from './git-operation-receipts'
import { gitGuidance, operationalFailure } from '../mcp/operational-guidance'

const string = { type: 'string', minLength: 1 }
const expectedHead = { type: ['string', 'null'], pattern: '^[a-f0-9]{40,64}$' }
const revision = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const paths = (maxItems: number) => ({ type: 'array', items: string, minItems: 1, maxItems, uniqueItems: true })
const choice = (...values: string[]) => ({ type: 'string', enum: values })
const credential = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const snapshot = { type: 'object', properties: { branch: { type: ['string', 'null'] }, head: expectedHead, indexRevision: revision, worktreeRevision: revision, operation: { type: ['string', 'null'] } }, required: ['branch', 'head', 'indexRevision', 'worktreeRevision', 'operation'], additionalProperties: false }
const scope = { type: 'object', properties: { operations: { type: 'array', items: choice('STAGE', 'UNSTAGE', 'COMMIT', 'CREATE_BRANCH', 'CREATE_WORKTREE', 'PUSH', 'INTEGRATE', 'CLOSE'), minItems: 1, maxItems: 8 }, paths: { type: 'array', items: string, minItems: 0, maxItems: 500 }, branches: { type: 'array', items: string, minItems: 0, maxItems: 20 }, startPoints: { type: 'array', items: { type: 'string', pattern: '^[a-f0-9]{40,64}$' }, minItems: 0, maxItems: 20 } }, required: ['operations', 'paths', 'branches'], additionalProperties: false }
const scopedMutation = { worktreeId: revision, leaseId: string, leaseCredential: credential, operationId: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$' }, snapshot }
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): McpToolDefinition {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, securitySchemes: [{ type: 'oauth2', scopes: [] }] }
}
export const GIT_OPERATIONS_TOOLS = [
  tool('get_worktree_conflict', 'Read explicit conflict metadata or one bounded conflict side in a discovered worktree.', { worktreeId: revision, path: string, side: choice('BASE', 'OURS', 'THEIRS', 'WORKTREE'), cursor: string }, ['worktreeId', 'path']),
  tool('resolve_worktree_conflict', 'Resolve one explicitly scoped conflict in a managed integration checkout, against the observed conflict revision. Stages only that resolution under local ownership.', { ...scopedMutation, path: string, resolution: choice('OURS', 'THEIRS', 'CONTENT', 'DELETE'), expectedConflictRevision: revision, content: { type: 'string', maxLength: 1024 * 1024 } }, ['path', 'resolution', 'expectedConflictRevision', ...Object.keys(scopedMutation)]),
  tool('start_worktree_validation', 'Execute an existing fixed validation profile in a managed clean checkout under explicit local ownership. Proofs bind the actual checkout generation, HEAD, index and dirty contents; accepts no arbitrary command or cwd.', { ...scopedMutation, profileId: string, targets: paths(100), evidenceFor: paths(100) }, ['profileId', ...Object.keys(scopedMutation)]),
  tool('get_worktree_validation', 'Read the bounded result and genuine proofId of an authorized checkout validation run.', { runId: string }, ['runId']),
  tool('preview_worktree_integration', 'Bind a read-only integration preview to source and target snapshots, merge base and commits. Reports promotion blockers without changing refs.', { sourceWorktreeId: revision, targetBranch: string }, ['sourceWorktreeId', 'targetBranch']),
  tool('integrate_worktree', 'APPLY only in a managed integration checkout; conflicts remain isolated there. PROMOTE requires explicit target ownership and genuine validation proofs for the managed integration commit. Never force updates occupied branches.', { ...scopedMutation, action: choice('APPLY', 'PROMOTE'), previewId: string, integrationWorktreeId: revision, proofIds: paths(20) }, ['action', 'previewId', ...Object.keys(scopedMutation)]),
  tool('publish_worktree', 'Push the explicitly approved current branch and exact inspected HEAD without force. PUBLISHED does not mean integrated.', { ...scopedMutation, branch: string, remote: string }, ['branch', 'remote', ...Object.keys(scopedMutation)]),
  tool('manage_worktree', 'CREATE a managed worktree on a new explicit branch at an approved exact commit; no directory selector or project switch. CLOSE refuses external, dirty, locked, conflicted or unpreserved worktrees and never force-removes. Both actions require a local grant and operationId.', { ...scopedMutation, action: choice('CREATE', 'CLOSE'), branch: string, startPoint: { type: 'string', pattern: '^[a-f0-9]{40,64}$' }, preservedBranch: string }, ['action', ...Object.keys(scopedMutation)]),
  tool('handoff_worktree_for_git', 'REQUEST/RECOVER records a pending request for native desktop operator approval; cannot self-approve remotely. ACCEPT requires the private request credential. RELEASE explicitly returns ownership. Pause confirmation is cooperative, not an IDE writer lock. Keep credentials private.', { action: choice('REQUEST', 'RECOVER', 'ACCEPT', 'RELEASE'), worktreeId: revision, snapshot, scope, durationSeconds: { type: 'integer', minimum: 30, maximum: 300 }, requestId: string, requestCredential: credential, leaseId: string, leaseCredential: credential }, ['action']),
  tool('mutate_worktree', 'Perform STAGE/UNSTAGE explicit paths, COMMIT exactly the inspected index, or CREATE_BRANCH and checkout an exclusive branch after local approval and explicit ACCEPT. Requires scoped lease, fresh snapshot and caller-created operationId; recover with the same ID. No implicit push.', { action: choice('STAGE', 'UNSTAGE', 'COMMIT', 'CREATE_BRANCH'), worktreeId: revision, leaseId: string, leaseCredential: credential, operationId: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$' }, snapshot, paths: paths(500), message: { ...string, maxLength: 10000 }, branch: string }, ['action', 'worktreeId', 'leaseId', 'leaseCredential', 'operationId', 'snapshot']),
  tool('discover_worktrees', 'Discover up to 100 compact Git worktree records in the canonical repository. No source, patches or mutation permission. Discover before selecting an opaque worktreeId; drift rejects continuation.', { cursor: string }),
  tool('inspect_worktree', 'Inspect one discovered worktree without changing active project, index or HEAD. Git locked is not ownership.', { worktreeId: revision }, ['worktreeId']),
  tool('get_worktree_changes', 'Page changed path metadata only; no source or patches. Optional literal repository-relative pathPrefixes match a path or directory descendants; categories use OR. Filters apply before pagination. Cursor binds filters, pageSize and Git state; reuse identical arguments. Default/maximum pageSize 100.', { worktreeId: revision, cursor: string, pathPrefixes: paths(20), categories: { type: 'array', items: choice('STAGED', 'UNSTAGED', 'UNTRACKED', 'DELETED', 'CONFLICTED'), minItems: 1, maxItems: 5, uniqueItems: true }, pageSize: { type: 'integer', minimum: 1, maximum: 100 } }, ['worktreeId']),
  tool('get_worktree_diff', 'Read a bounded patch for explicit paths in one worktree. No directory expansion; stale evidence rejects continuation.', { worktreeId: revision, paths: paths(20), mode: choice('WORKTREE', 'STAGED', 'BETWEEN_REFS'), base: string, head: string, cursor: string }, ['worktreeId', 'paths', 'mode']),
  tool('read_worktree_file', 'Read one literal UTF-8 interval; maximum 400 lines, 24000 output bytes, 16 MiB input. expectedFileRevision is SHA-256 of this file bytes, returned as fileRevision (revisionKind FILE_BYTES_SHA256); inspect_worktree.worktreeRevision is NOT a file revision. expectedRevision is a deprecated compatible alias; simultaneous unequal values are rejected. Wrong hash returns GIT_STATE_CHANGED with revisionKind. Bounds errors return totalLines/validRange/maxLines, never partial source. Rejects escaping paths, Git metadata and binary files.', { worktreeId: revision, path: string, startLine: { type: 'integer', minimum: 1, maximum: 10000000 }, endLine: { type: 'integer', minimum: 1, maximum: 10000000 }, expectedRevision: revision, expectedFileRevision: revision }, ['worktreeId', 'path', 'startLine', 'endLine']),
  tool('get_git_state', 'Inspect compact Git state of the active project, including HEAD, staged index revision and worktree revision covering dirty contents. No file list or patches.', {}),
  tool('get_git_changes', 'Discover changed files of the active project without patches.', { filter: choice('ALL', 'STAGED', 'UNSTAGED', 'UNTRACKED', 'CONFLICTED') }),
  tool('get_git_diff', 'Read a bounded diff for explicit paths. Continue with nextCursor; changed evidence invalidates the cursor. Binary contents are omitted.', { paths: paths(20), mode: choice('WORKTREE', 'STAGED', 'BETWEEN_REFS'), base: string, head: string, cursor: string }, ['paths', 'mode']),
  tool('get_git_history', 'Read bounded commit metadata, optionally for one path, without patches.', { ref: string, limit: { type: 'integer', minimum: 1, maximum: 100 }, path: string }),
  tool('analyze_git_hygiene', 'Summarize dirty worktree signal by grouped untracked output, tracked dirt and suggested ignore rules without dumping every path.', {}),
  tool('manage_gitignore', 'Preview or append explicit .gitignore rules. PREVIEW_ADD is read-only and returns the exact effect plus previewId; ADD requires that previewId and expectedWorktreeRevision. Never deletes files or changes tracking.', { action: choice('PREVIEW_ADD', 'ADD'), rules: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 500 }, minItems: 1, maxItems: 100, uniqueItems: true }, expectedWorktreeRevision: revision, expectedPreviewId: revision }, ['action', 'rules']),
  tool('stage_git_changes', 'Transactionally stage or unstage explicit literal paths against the observed index and worktree revisions. Failure before publication preserves the index; unstage preserves worktree contents.', { mode: choice('STAGE', 'UNSTAGE'), paths: paths(500), expectedIndexRevision: revision, expectedWorktreeRevision: revision }, ['mode', 'paths', 'expectedIndexRevision', 'expectedWorktreeRevision']),
  tool('commit_git_changes', 'Commit exactly the inspected staged index. Requires expectedHead and expectedIndexRevision; never stages implicitly.', { message: { ...string, maxLength: 10000 }, expectedHead, expectedIndexRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['message', 'expectedHead', 'expectedIndexRevision']),
  tool('manage_git_branch', 'List, create, switch, rename or safely delete local branches. CREATE requires expectedHead; RENAME requires newBranch. SET_UPSTREAM requires branch, remote, remoteBranch and expectedHead; binds only the current branch to an existing remote-tracking branch without network I/O. No force operations.', { action: choice('LIST', 'CREATE', 'SWITCH', 'RENAME', 'DELETE', 'SET_UPSTREAM'), branch: string, newBranch: string, startPoint: string, remote: string, remoteBranch: string, expectedHead }, ['action']),
  tool('merge_git_branch', 'Merge with FF_ONLY by default or explicitly MERGE; return conflicts as state. MERGE requires source and expectedHead. ABORT requires an active merge.', { action: choice('MERGE', 'ABORT'), source: string, expectedHead, mode: choice('FF_ONLY', 'MERGE') }, ['action']),
  tool('sync_git_remote', 'Fetch, pull fast-forward only, or push without force. Defaults to origin/current branch. PUSH and PULL_FF_ONLY require expectedHead.', { action: choice('FETCH', 'PULL_FF_ONLY', 'PUSH'), remote: string, branch: string, expectedHead }, ['action']),
  tool('revert_git_commit', 'Start (default), continue or abort a revert. START requires commit SHA; CONTINUE requires expectedIndexRevision and zero conflicts. All actions require expectedHead.', { action: choice('START', 'CONTINUE', 'ABORT'), commit: { type: 'string', pattern: '^[a-f0-9]{40,64}$' }, expectedHead, expectedIndexRevision: revision }, ['expectedHead']),
  tool('manage_git_shelf', 'Explicitly preserve selected dirty paths in an owned shelf, list shelves, restore without deleting the copy, or explicitly drop it. CREATE requires paths and expectedWorktreeRevision. RESTORE requires shelfId, expectedHead and expectedWorktreeRevision. DROP requires shelfId. External stashes are never selected.', { action: choice('CREATE', 'LIST', 'RESTORE', 'DROP'), paths: paths(500), expectedWorktreeRevision: revision, expectedHead, shelfId: string, label: { type: 'string', maxLength: 200 } }, ['action']),
  tool('get_git_conflict', 'Inspect one conflicted path: metadata by default, or a bounded literal BASE/OURS/THEIRS/WORKTREE side with deterministic continuation. Binary bodies are omitted.', { path: string, side: choice('BASE', 'OURS', 'THEIRS', 'WORKTREE'), cursor: string }, ['path']),
  tool('resolve_git_conflict', 'Resolve only an existing conflicted path using OURS, THEIRS, CONTENT (complete literal text, up to 1 MiB) or DELETE. Requires observed HEAD and conflict revision; content is allowed only for CONTENT. Stages the resolution.', { path: string, resolution: choice('OURS', 'THEIRS', 'CONTENT', 'DELETE'), expectedHead, expectedConflictRevision: revision, content: { type: 'string', maxLength: 1024 * 1024 } }, ['path', 'resolution', 'expectedHead', 'expectedConflictRevision'])
]

for (const definition of GIT_OPERATIONS_TOOLS.filter((entry) => ['stage_git_changes', 'commit_git_changes', 'manage_git_branch', 'merge_git_branch', 'sync_git_remote', 'revert_git_commit', 'manage_git_shelf', 'manage_gitignore', 'resolve_git_conflict'].includes(entry.name))) {
  (definition.inputSchema.properties as Record<string, unknown>).operationId = { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$', maxLength: 128 }
  definition.description += ' Mutating actions require a caller-created operationId; reuse that same ID to recover a lost acknowledgement, never retry with a new ID blindly.'
  if (definition.name === 'stage_git_changes') (definition.inputSchema.required as string[]).push('operationId')
}

function validate(schema: Record<string, any>, value: unknown): boolean {
  if (Array.isArray(schema.type)) return schema.type.some((type: string) => validate({ ...schema, type }, value))
  if (schema.type === 'null') return value === null
  if (schema.type === 'string') return typeof value === 'string' && (!schema.minLength || value.length >= schema.minLength) && (!schema.maxLength || value.length <= schema.maxLength) && (!schema.enum || schema.enum.includes(value)) && (!schema.pattern || new RegExp(schema.pattern).test(value))
  if (schema.type === 'integer') return typeof value === 'number' && Number.isInteger(value) && value >= schema.minimum && value <= schema.maximum
  if (schema.type === 'array') return Array.isArray(value) && value.length >= schema.minItems && value.length <= schema.maxItems && new Set(value).size === value.length && value.every((item) => validate(schema.items, item))
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const object = value as Record<string, unknown>
    return schema.required.every((key: string) => Object.hasOwn(object, key)) && Object.entries(object).every(([key, item]) => schema.properties[key] && validate(schema.properties[key], item))
  }
  return false
}

export async function executeGitOperationsTool(service: GitOperationsService, name: string, args: unknown): Promise<McpToolResult> {
  const definition = GIT_OPERATIONS_TOOLS.find((entry) => entry.name === name)
  if (!definition || !validate(definition.inputSchema, args)) return { content: [{ type: 'text', text: '{"code":"INVALID_ARGUMENT"}' }], isError: true }
  const { operationId, ...values } = args as Record<string, unknown>
  if (['mutate_worktree', 'manage_worktree', 'integrate_worktree', 'publish_worktree', 'start_worktree_validation', 'resolve_worktree_conflict'].includes(name)) {
    const expectedFields: Record<string, string[]> = { STAGE: ['paths'], UNSTAGE: ['paths'], COMMIT: ['message'], CREATE_BRANCH: ['branch'] }
    if (name === 'manage_worktree') Object.assign(expectedFields, { CREATE: ['branch', 'startPoint'], CLOSE: ['preservedBranch'] })
    if (name === 'integrate_worktree') Object.assign(expectedFields, { APPLY: ['previewId'], PROMOTE: ['previewId', 'integrationWorktreeId', 'proofIds'] })
    const extra = name === 'resolve_worktree_conflict' ? ['path', 'resolution', 'expectedConflictRevision'] : name === 'start_worktree_validation' ? ['profileId'] : name === 'publish_worktree' ? ['branch', 'remote'] : expectedFields[String(values.action)]
    if (!extra || extra.some(key => !Object.prototype.hasOwnProperty.call(values, key)) || ['paths', 'message', 'branch', 'startPoint', 'preservedBranch', 'previewId', 'integrationWorktreeId', 'proofIds', 'remote'].some(key => Object.prototype.hasOwnProperty.call(values, key) && !extra.includes(key))) return { content: [{ type: 'text', text: '{"code":"INVALID_ARGUMENT"}' }], isError: true }
    try {
      if (name === 'resolve_worktree_conflict') {
        if (values.resolution === 'CONTENT' ? typeof values.content !== 'string' : Object.prototype.hasOwnProperty.call(values, 'content')) return { content: [{ type: 'text', text: '{"code":"INVALID_ARGUMENT"}' }], isError: true }
        return await service.resolveWorktreeConflict(args as Parameters<GitOperationsService['resolveWorktreeConflict']>[0])
      }
      if (name === 'start_worktree_validation') return await service.startWorktreeValidation(args as Parameters<GitOperationsService['startWorktreeValidation']>[0])
      if (name === 'mutate_worktree') return await service.mutateWorktree(args as Parameters<GitOperationsService['mutateWorktree']>[0])
      if (name === 'integrate_worktree') return await service.integrateWorktree(args as Parameters<GitOperationsService['integrateWorktree']>[0])
      if (name === 'publish_worktree') return await service.publishWorktree(args as Parameters<GitOperationsService['publishWorktree']>[0])
      return await service.manageWorktree(args as Parameters<GitOperationsService['manageWorktree']>[0])
    }
    catch (error) { return { content: [{ type: 'text', text: JSON.stringify({ code: error instanceof Error ? error.message : 'WORKTREE_OPERATION_FAILED' }) }], isError: true } }
  }
  if (!isReceiptedGitMutation(name, values)) {
    if (operationId !== undefined) return { content: [{ type: 'text', text: '{"code":"INVALID_ARGUMENT"}' }], isError: true }
    return dispatchGitOperationsTool(service, name, values)
  }
  if (typeof operationId !== 'string') return { content: [{ type: 'text', text: '{"code":"INVALID_ARGUMENT"}' }], isError: true }
  try { return await service.executeReceipted(operationId, name, values, () => dispatchGitOperationsTool(service, name, values)) }
  catch (caught) {
    const code = caught instanceof Error && ['RECEIPT_BUSY', 'RECEIPT_CAPACITY_EXCEEDED'].includes(caught.message) ? caught.message : 'RECEIPT_UNAVAILABLE'
    return operationalFailure({ code, operationId, retryability: 'SAME_OPERATION_ID', retryAfterMs: 2000, recommendedAction: 'RECOVER_SAME_OPERATION' })
  }
}

async function dispatchGitOperationsTool(service: GitOperationsService, name: string, args: unknown): Promise<McpToolResult> {
  try {
    const definition = GIT_OPERATIONS_TOOLS.find((entry) => entry.name === name)
    if (!definition || !validate({ ...definition.inputSchema, required: (definition.inputSchema.required as string[]).filter((key) => key !== 'operationId') }, args)) throw new GitOperationsError('INVALID_ARGUMENT')
    const values = args as Record<string, any>
    const actionFields: Record<string, Record<string, string[]>> = {
      handoff_worktree_for_git: { REQUEST: ['worktreeId', 'snapshot', 'scope', 'durationSeconds'], RECOVER: ['worktreeId', 'snapshot', 'scope', 'durationSeconds'], ACCEPT: ['requestId', 'requestCredential'], RELEASE: ['worktreeId', 'leaseId', 'leaseCredential'] },
      manage_git_branch: { LIST: [], CREATE: ['branch', 'expectedHead'], SWITCH: ['branch'], RENAME: ['branch', 'newBranch'], DELETE: ['branch'], SET_UPSTREAM: ['branch', 'remote', 'remoteBranch', 'expectedHead'] },
      merge_git_branch: { MERGE: ['source', 'expectedHead'], ABORT: [] },
      sync_git_remote: { FETCH: [], PUSH: ['expectedHead'], PULL_FF_ONLY: ['expectedHead'] },
      manage_git_shelf: { LIST: [], CREATE: ['paths', 'expectedWorktreeRevision'], RESTORE: ['shelfId', 'expectedHead', 'expectedWorktreeRevision'], DROP: ['shelfId'] },
      manage_gitignore: { PREVIEW_ADD: [], ADD: ['expectedWorktreeRevision', 'expectedPreviewId'] },
      revert_git_commit: { START: ['commit'], CONTINUE: ['expectedIndexRevision'], ABORT: [] }
    }
    const required = actionFields[name]?.[values.action ?? (name === 'revert_git_commit' ? 'START' : '')] ?? []
    if (required.some((field) => !Object.hasOwn(values, field))) throw new GitOperationsError('INVALID_ARGUMENT')
    const allowedFields: Record<string, Record<string, string[]>> = {
      handoff_worktree_for_git: { REQUEST: ['action', 'worktreeId', 'snapshot', 'scope', 'durationSeconds'], RECOVER: ['action', 'worktreeId', 'snapshot', 'scope', 'durationSeconds'], ACCEPT: ['action', 'requestId', 'requestCredential'], RELEASE: ['action', 'worktreeId', 'leaseId', 'leaseCredential'] },
      manage_git_branch: { SET_UPSTREAM: ['action', 'branch', 'remote', 'remoteBranch', 'expectedHead'] },
      manage_git_shelf: { LIST: ['action'], CREATE: ['action', 'paths', 'expectedWorktreeRevision', 'label'], RESTORE: ['action', 'shelfId', 'expectedHead', 'expectedWorktreeRevision'], DROP: ['action', 'shelfId'] },
      manage_gitignore: { PREVIEW_ADD: ['action', 'rules'], ADD: ['action', 'rules', 'expectedWorktreeRevision', 'expectedPreviewId'] },
      revert_git_commit: { START: ['action', 'commit', 'expectedHead'], CONTINUE: ['action', 'expectedHead', 'expectedIndexRevision'], ABORT: ['action', 'expectedHead'] }
    }
    const allowed = allowedFields[name]?.[values.action ?? 'START']
    if (allowed && Object.keys(values).some((field) => !allowed.includes(field))) throw new GitOperationsError('INVALID_ARGUMENT')
    if (name === 'get_git_diff' && values.mode === 'BETWEEN_REFS' && (!values.base || !values.head)) throw new GitOperationsError('INVALID_ARGUMENT')
    if (name === 'get_git_conflict' && values.cursor && !values.side) throw new GitOperationsError('INVALID_ARGUMENT')
    if (name === 'resolve_git_conflict' && (values.resolution === 'CONTENT' ? typeof values.content !== 'string' : Object.hasOwn(values, 'content'))) throw new GitOperationsError('INVALID_ARGUMENT')
    let result: unknown
    switch (name) {
      case 'get_worktree_conflict': result = await service.getWorktreeConflict(values as Parameters<GitOperationsService['getWorktreeConflict']>[0]); break
      case 'get_worktree_validation': result = await service.getWorktreeValidation(values.runId); break
      case 'preview_worktree_integration': result = await service.previewWorktreeIntegration(values as Parameters<GitOperationsService['previewWorktreeIntegration']>[0]); break
      case 'handoff_worktree_for_git': result = await service.handoffWorktree(values as Parameters<GitOperationsService['handoffWorktree']>[0]); break
      case 'discover_worktrees': result = await service.discoverWorktrees(values); break
      case 'inspect_worktree': result = await service.inspectWorktree(values.worktreeId); break
      case 'get_worktree_changes': result = await service.getWorktreeChanges(values as Parameters<GitOperationsService['getWorktreeChanges']>[0]); break
      case 'get_worktree_diff': result = await service.getWorktreeDiff(values as Parameters<GitOperationsService['getWorktreeDiff']>[0]); break
      case 'read_worktree_file': result = await service.readWorktreeFile(values as Parameters<GitOperationsService['readWorktreeFile']>[0]); break
      case 'get_git_state': result = await service.getState(); break
      case 'get_git_changes': result = await service.getChanges(values.filter); break
      case 'get_git_diff': result = await service.getDiff(values as Parameters<GitOperationsService['getDiff']>[0]); break
      case 'get_git_history': result = await service.getHistory(values); break
      case 'analyze_git_hygiene': result = await service.analyzeHygiene(); break
      case 'manage_gitignore': result = await service.manageGitignore(values as GitIgnoreRequest); break
      case 'stage_git_changes': result = await service.stage(values as Parameters<GitOperationsService['stage']>[0]); break
      case 'commit_git_changes': result = await service.commit(values as Parameters<GitOperationsService['commit']>[0]); break
      case 'manage_git_branch': result = await service.manageBranch(values as BranchRequest); break
      case 'merge_git_branch': result = await service.merge(values as MergeRequest); break
      case 'sync_git_remote': result = await service.sync(values as SyncRequest); break
      case 'revert_git_commit': result = await service.revert(values as RevertRequest); break
      case 'manage_git_shelf': result = await service.manageShelf(values as ShelfRequest); break
      case 'get_git_conflict': result = await service.getConflict(values as Parameters<GitOperationsService['getConflict']>[0]); break
      case 'resolve_git_conflict': result = await service.resolveConflict(values as Parameters<GitOperationsService['resolveConflict']>[0]); break
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  } catch (error) {
    const code = error instanceof GitOperationsError ? error.code : 'GIT_OPERATION_FAILED'
    const details = error instanceof GitOperationsError ? error.details : undefined
    if (['GIT_STATE_CHANGED', 'CONFLICT_STATE_CHANGED'].includes(code)) return operationalFailure({ ...gitGuidance(code), ...details })
    return { content: [{ type: 'text', text: JSON.stringify({ code, ...details }) }], isError: true }
  }
}
