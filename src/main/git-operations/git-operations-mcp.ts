import type { McpToolDefinition, McpToolResult } from '../mcp/context-navigation-mcp-adapter'
import { GitOperationsError, type GitOperationsService, type BranchRequest, type MergeRequest, type SyncRequest, type ShelfRequest, type RevertRequest } from './git-operations-service'

const string = { type: 'string', minLength: 1 }
const expectedHead = { type: ['string', 'null'], pattern: '^[a-f0-9]{40,64}$' }
const revision = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const paths = (maxItems: number) => ({ type: 'array', items: string, minItems: 1, maxItems, uniqueItems: true })
const choice = (...values: string[]) => ({ type: 'string', enum: values })
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): McpToolDefinition {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, securitySchemes: [{ type: 'oauth2', scopes: [] }] }
}
export const GIT_OPERATIONS_TOOLS = [
  tool('get_git_state', 'Inspect compact Git state of the active project, including HEAD, staged index revision and worktree revision covering dirty contents. No file list or patches.', {}),
  tool('get_git_changes', 'Discover changed files of the active project without patches.', { filter: choice('ALL', 'STAGED', 'UNSTAGED', 'UNTRACKED', 'CONFLICTED') }),
  tool('get_git_diff', 'Read a bounded diff for explicit paths. Continue with nextCursor; changed evidence invalidates the cursor. Binary contents are omitted.', { paths: paths(20), mode: choice('WORKTREE', 'STAGED', 'BETWEEN_REFS'), base: string, head: string, cursor: string }, ['paths', 'mode']),
  tool('get_git_history', 'Read bounded commit metadata, optionally for one path, without patches.', { ref: string, limit: { type: 'integer', minimum: 1, maximum: 100 }, path: string }),
  tool('stage_git_changes', 'Stage or unstage explicit literal paths in the active project. Unstage preserves worktree contents.', { mode: choice('STAGE', 'UNSTAGE'), paths: paths(500) }, ['mode', 'paths']),
  tool('commit_git_changes', 'Commit exactly the inspected staged index. Requires expectedHead and expectedIndexRevision; never stages implicitly.', { message: { ...string, maxLength: 10000 }, expectedHead, expectedIndexRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['message', 'expectedHead', 'expectedIndexRevision']),
  tool('manage_git_branch', 'List, create, switch, rename or safely delete local branches. CREATE requires expectedHead; RENAME requires newBranch. No force operations.', { action: choice('LIST', 'CREATE', 'SWITCH', 'RENAME', 'DELETE'), branch: string, newBranch: string, startPoint: string, expectedHead }, ['action']),
  tool('merge_git_branch', 'Merge with FF_ONLY by default or explicitly MERGE; return conflicts as state. MERGE requires source and expectedHead. ABORT requires an active merge.', { action: choice('MERGE', 'ABORT'), source: string, expectedHead, mode: choice('FF_ONLY', 'MERGE') }, ['action']),
  tool('sync_git_remote', 'Fetch, pull fast-forward only, or push without force. Defaults to origin/current branch. PUSH and PULL_FF_ONLY require expectedHead.', { action: choice('FETCH', 'PULL_FF_ONLY', 'PUSH'), remote: string, branch: string, expectedHead }, ['action']),
  tool('revert_git_commit', 'Start (default), continue or abort a revert. START requires commit SHA; CONTINUE requires expectedIndexRevision and zero conflicts. All actions require expectedHead.', { action: choice('START', 'CONTINUE', 'ABORT'), commit: { type: 'string', pattern: '^[a-f0-9]{40,64}$' }, expectedHead, expectedIndexRevision: revision }, ['expectedHead']),
  tool('manage_git_shelf', 'Explicitly preserve selected dirty paths in an owned shelf, list shelves, restore without deleting the copy, or explicitly drop it. CREATE requires paths and expectedWorktreeRevision. RESTORE requires shelfId, expectedHead and expectedWorktreeRevision. DROP requires shelfId. External stashes are never selected.', { action: choice('CREATE', 'LIST', 'RESTORE', 'DROP'), paths: paths(500), expectedWorktreeRevision: revision, expectedHead, shelfId: string, label: { type: 'string', maxLength: 200 } }, ['action']),
  tool('get_git_conflict', 'Inspect one conflicted path: metadata by default, or a bounded literal BASE/OURS/THEIRS/WORKTREE side with deterministic continuation. Binary bodies are omitted.', { path: string, side: choice('BASE', 'OURS', 'THEIRS', 'WORKTREE'), cursor: string }, ['path']),
  tool('resolve_git_conflict', 'Resolve only an existing conflicted path using OURS, THEIRS, CONTENT (complete literal text, up to 1 MiB) or DELETE. Requires observed HEAD and conflict revision; content is allowed only for CONTENT. Stages the resolution.', { path: string, resolution: choice('OURS', 'THEIRS', 'CONTENT', 'DELETE'), expectedHead, expectedConflictRevision: revision, content: { type: 'string', maxLength: 1024 * 1024 } }, ['path', 'resolution', 'expectedHead', 'expectedConflictRevision'])
]

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
  try {
    const definition = GIT_OPERATIONS_TOOLS.find((entry) => entry.name === name)
    if (!definition || !validate(definition.inputSchema, args)) throw new GitOperationsError('INVALID_ARGUMENT')
    const values = args as Record<string, any>
    const actionFields: Record<string, Record<string, string[]>> = {
      manage_git_branch: { LIST: [], CREATE: ['branch', 'expectedHead'], SWITCH: ['branch'], RENAME: ['branch', 'newBranch'], DELETE: ['branch'] },
      merge_git_branch: { MERGE: ['source', 'expectedHead'], ABORT: [] },
      sync_git_remote: { FETCH: [], PUSH: ['expectedHead'], PULL_FF_ONLY: ['expectedHead'] },
      manage_git_shelf: { LIST: [], CREATE: ['paths', 'expectedWorktreeRevision'], RESTORE: ['shelfId', 'expectedHead', 'expectedWorktreeRevision'], DROP: ['shelfId'] },
      revert_git_commit: { START: ['commit'], CONTINUE: ['expectedIndexRevision'], ABORT: [] }
    }
    const required = actionFields[name]?.[values.action ?? (name === 'revert_git_commit' ? 'START' : '')] ?? []
    if (required.some((field) => !Object.hasOwn(values, field))) throw new GitOperationsError('INVALID_ARGUMENT')
    const allowedFields: Record<string, Record<string, string[]>> = {
      manage_git_shelf: { LIST: ['action'], CREATE: ['action', 'paths', 'expectedWorktreeRevision', 'label'], RESTORE: ['action', 'shelfId', 'expectedHead', 'expectedWorktreeRevision'], DROP: ['action', 'shelfId'] },
      revert_git_commit: { START: ['action', 'commit', 'expectedHead'], CONTINUE: ['action', 'expectedHead', 'expectedIndexRevision'], ABORT: ['action', 'expectedHead'] }
    }
    const allowed = allowedFields[name]?.[values.action ?? 'START']
    if (allowed && Object.keys(values).some((field) => !allowed.includes(field))) throw new GitOperationsError('INVALID_ARGUMENT')
    if (name === 'get_git_diff' && values.mode === 'BETWEEN_REFS' && (!values.base || !values.head)) throw new GitOperationsError('INVALID_ARGUMENT')
    if (name === 'get_git_conflict' && values.cursor && !values.side) throw new GitOperationsError('INVALID_ARGUMENT')
    if (name === 'resolve_git_conflict' && (values.resolution === 'CONTENT' ? typeof values.content !== 'string' : Object.hasOwn(values, 'content'))) throw new GitOperationsError('INVALID_ARGUMENT')
    let result: unknown
    switch (name) {
      case 'get_git_state': result = await service.getState(); break
      case 'get_git_changes': result = await service.getChanges(values.filter); break
      case 'get_git_diff': result = await service.getDiff(values as Parameters<GitOperationsService['getDiff']>[0]); break
      case 'get_git_history': result = await service.getHistory(values); break
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
    return { content: [{ type: 'text', text: JSON.stringify({ code: error instanceof GitOperationsError ? error.code : 'GIT_OPERATION_FAILED' }) }], isError: true }
  }
}
