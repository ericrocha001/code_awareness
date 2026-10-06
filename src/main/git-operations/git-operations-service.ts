import { createHash } from 'node:crypto'
import ignore from 'ignore'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { GitService } from '../core/git-service'
import type { GitRemoteTransport } from '../core/git-remote-transport'
import { GitOperationReceipts } from './git-operation-receipts'
import type { McpToolResult } from '../mcp/context-navigation-mcp-adapter'

export class GitOperationsError extends Error {
  constructor(readonly code: string) { super(code) }
}
const fail = (code: string): never => { throw new GitOperationsError(code) }
export interface GitChange {
  path: string
  stagedState: string | null
  unstagedState: string | null
  untracked: boolean
  deleted: boolean
  renamed: boolean
  conflicted: boolean
  previousPath?: string
}
export type ChangeFilter = 'ALL' | 'STAGED' | 'UNSTAGED' | 'UNTRACKED' | 'CONFLICTED'
export type BranchRequest =
  | { action: 'LIST' }
  | { action: 'CREATE'; branch: string; startPoint?: string; expectedHead: string | null }
  | { action: 'SWITCH' | 'DELETE'; branch: string }
  | { action: 'RENAME'; branch: string; newBranch: string }
export type MergeRequest = { action: 'ABORT' } | { action: 'MERGE'; source: string; expectedHead: string | null; mode?: 'FF_ONLY' | 'MERGE' }
export type SyncRequest = { action: 'FETCH'; remote?: string } | { action: 'PUSH' | 'PULL_FF_ONLY'; remote?: string; branch?: string; expectedHead: string | null }
export type ShelfRequest =
  | { action: 'LIST' }
  | { action: 'CREATE'; paths: string[]; expectedWorktreeRevision: string; label?: string }
  | { action: 'RESTORE'; shelfId: string; expectedHead: string | null; expectedWorktreeRevision: string }
  | { action: 'DROP'; shelfId: string }
export type ConflictSide = 'BASE' | 'OURS' | 'THEIRS' | 'WORKTREE'
export type ConflictResolution = 'OURS' | 'THEIRS' | 'CONTENT' | 'DELETE'
export type RevertRequest = { action?: 'START'; commit: string; expectedHead: string | null }
  | { action: 'CONTINUE'; expectedHead: string | null; expectedIndexRevision: string }
  | { action: 'ABORT'; expectedHead: string | null }
export type GitIgnoreRequest =
  | { action: 'PREVIEW_ADD'; rules: string[] }
  | { action: 'ADD'; rules: string[]; expectedWorktreeRevision: string; expectedPreviewId: string }

function isBinary(bytes: Buffer): boolean {
  if (bytes.includes(0)) return true
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return false } catch { return true }
}

export class GitOperationsService {
  async executeReceipted(operationId: string, name: string, args: Record<string, unknown>, mutate: () => Promise<McpToolResult>): Promise<McpToolResult> {
    return new GitOperationReceipts(this.repoRoot, this.git).execute(operationId, name, args, mutate)
  }
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private readonly repoRoot: string, private readonly git: GitService, private readonly transport: GitRemoteTransport) {}

  private async observeMutation<T>(observe: () => Promise<T>): Promise<T> {
    try { return await observe() }
    catch { throw new GitOperationsError('OPERATION_OUTCOME_UNKNOWN') }
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation).catch((error: unknown) => { throw this.normalizeError(error) })
    this.pending = result.catch(() => {})
    return result
  }

  private normalizeError(error: unknown): GitOperationsError {
    if (error instanceof GitOperationsError) return error
    const message = error instanceof Error ? error.message : ''
    for (const code of ['GIT_STATE_CHANGED', 'NOTHING_TO_COMMIT', 'SHELF_NOT_FOUND', 'SHELF_REQUIRES_HEAD', 'CONFLICT_STATE_CHANGED', 'CONFLICT_SIDE_UNAVAILABLE', 'UNSUPPORTED_GIT_PATH']) if (message === code) return new GitOperationsError(code)
    const text = message.toLowerCase()
    const codes: Array<[string[], string]> = [
      [['not a git repository'], 'NOT_GIT_REPOSITORY'],
      [['already exists'], 'BRANCH_ALREADY_EXISTS'],
      [['not found', 'invalid reference', 'unknown revision'], 'BRANCH_NOT_FOUND'],
      [['would be overwritten', 'local changes', 'not fully merged'], 'DIRTY_WORKTREE'],
      [['non-fast-forward', 'fetch first', '[rejected]', 'not possible to fast-forward'], 'NON_FAST_FORWARD'],
      [['authentication', 'could not read username', 'permission denied', '403', '401'], 'AUTHENTICATION_REQUIRED']
    ]
    return new GitOperationsError(codes.find(([parts]) => parts.some((part) => text.includes(part)))?.[1] ?? 'GIT_OPERATION_FAILED')
  }

  private paths(values: string[], max = 500): string[] {
    if (!Array.isArray(values) || !values.length || values.length > max) fail('INVALID_ARGUMENT')
    const root = realpathSync(this.repoRoot)
    return [...new Set(values.map((value) => {
      if (typeof value !== 'string' || !value || isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes('\0')) fail('PATH_OUTSIDE_REPOSITORY')
      const path = value.replace(/\\/g, '/')
      if (path.split('/').some((part) => part === '..' || part.replace(/[ .]+$/, '').toLowerCase() === '.git' || process.platform === 'win32' && part.includes(':')) || path === '.' || path.startsWith(':')) fail('PATH_OUTSIDE_REPOSITORY')
      const absolute = resolve(root, path)
      const normalized = relative(root, absolute).replace(/\\/g, '/')
      if (!normalized || normalized.startsWith('../') || isAbsolute(normalized)) fail('PATH_OUTSIDE_REPOSITORY')
      let ancestor = absolute
      while (!existsSync(ancestor) && ancestor !== root) ancestor = dirname(ancestor)
      const actual = relative(root, realpathSync(ancestor))
      if (actual === '..' || actual.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(actual)) fail('PATH_OUTSIDE_REPOSITORY')
      if (actual.split(/[\\/]/).some((part) => part.toLowerCase() === '.git')) fail('PATH_OUTSIDE_REPOSITORY')
      return normalized
    }))]
  }

  private async repository(): Promise<void> {
    if (!await this.git.isGitRepository(this.repoRoot)) fail('NOT_GIT_REPOSITORY')
  }

  private async checkHead(expected: string | null): Promise<void> {
    if (expected !== null && (typeof expected !== 'string' || !/^[a-f0-9]{40,64}$/.test(expected))) fail('INVALID_ARGUMENT')
    if (await this.git.getCurrentCommitHash(this.repoRoot) !== expected) fail('GIT_STATE_CHANGED')
  }

  private async ready(allowMergeCommit = false): Promise<void> {
    await this.repository()
    const operation = await this.git.getGitOperation(this.repoRoot)
    if (operation && !(allowMergeCommit && operation === 'MERGE')) fail('GIT_OPERATION_IN_PROGRESS')
  }

  private async branch(value: string): Promise<string> {
    if (typeof value !== 'string' || !value || value.startsWith('-') || value.startsWith('@{-')) fail('INVALID_REF')
    try { await this.git.validateBranch(this.repoRoot, value) } catch { fail('INVALID_REF') }
    return value
  }

  private async ref(value: string): Promise<string> {
    if (typeof value !== 'string' || !value || value.startsWith('-')) fail('INVALID_REF')
    try { return await this.git.resolveCommit(this.repoRoot, value) } catch { return fail('INVALID_REF') }
  }

  async getChanges(filter: ChangeFilter = 'ALL'): Promise<GitChange[]> {
    await this.repository()
    if (!['ALL', 'STAGED', 'UNSTAGED', 'UNTRACKED', 'CONFLICTED'].includes(filter)) fail('INVALID_ARGUMENT')
    const entries = (await this.git.getOperationsStatus(this.repoRoot)).split('\0')
    const changes: GitChange[] = []
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]
      if (!entry) continue
      const x = entry[0], y = entry[1]
      const untracked = x === '?' && y === '?'
      const conflicted = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(x + y)
      const renamed = x === 'R' || y === 'R' || x === 'C' || y === 'C'
      changes.push({ path: entry.slice(3), stagedState: x === ' ' || untracked ? null : x, unstagedState: y === ' ' || untracked ? null : y,
        untracked, deleted: x === 'D' || y === 'D', renamed, conflicted, ...(renamed ? { previousPath: entries[++index] } : {}) })
    }
    return changes.filter((change) => filter === 'ALL' || filter === 'STAGED' && !!change.stagedState || filter === 'UNSTAGED' && !!change.unstagedState || filter === 'UNTRACKED' && change.untracked || filter === 'CONFLICTED' && change.conflicted)
  }

  async getState() {
    const [changes, branch, head, upstream, operation, indexRevision] = await Promise.all([
      this.getChanges(), this.git.getCurrentBranch(this.repoRoot), this.git.getCurrentCommitHash(this.repoRoot),
      this.git.getUpstreamState(this.repoRoot), this.git.getGitOperation(this.repoRoot), this.git.getIndexRevision(this.repoRoot)
    ])
    return { repositoryState: 'GIT', branch, head,
      ...upstream, dirty: changes.length > 0,
      stagedCount: changes.filter((c) => c.stagedState).length, unstagedCount: changes.filter((c) => c.unstagedState).length,
      untrackedCount: changes.filter((c) => c.untracked).length, conflictCount: changes.filter((c) => c.conflicted).length,
      operation, indexRevision, worktreeRevision: await this.git.getWorktreeRevision(this.repoRoot) }
  }

  private normalizeIgnoreRules(values: string[]): string[] {
    if (!Array.isArray(values) || values.length < 1 || values.length > 100) fail('INVALID_ARGUMENT')
    return [...new Set(values.map((value) => {
      if (typeof value !== 'string') fail('INVALID_ARGUMENT')
      const rule = value.trim().replace(/\\/g, '/')
      if (!rule || rule.length > 500 || rule.includes('\0') || /[\r\n]/.test(rule) || rule.startsWith('!')) fail('INVALID_ARGUMENT')
      const pathLike = rule.replace(/^\/+/, '').replace(/^\.\//, '')
      if (!pathLike || /^[A-Za-z]:/.test(pathLike) || pathLike.split('/').some((part) => part === '..' || part.toLowerCase() === '.git')) fail('INVALID_ARGUMENT')
      return rule
    }))]
  }

  private hygieneDescriptor(path: string): { classification: string; group: string; suggestedRule?: string } {
    const normalized = path.replace(/\\/g, '/')
    const parts = normalized.split('/')
    if (normalized.startsWith('.claude/skills/')) return { classification: 'GENERATED_PROJECTION', group: '.claude/skills', suggestedRule: '.claude/skills/' }
    if (/^\.code-awareness\/[^/]+-runtime\//.test(normalized)) {
      const group = parts.slice(0, 2).join('/')
      return { classification: 'GENERATED_RUNTIME', group, suggestedRule: group + '/' }
    }
    if (normalized.startsWith('.code-awareness/continuum/rollback-baseline/')) return { classification: 'GENERATED_VALIDATION', group: '.code-awareness/continuum/rollback-baseline', suggestedRule: '.code-awareness/continuum/rollback-baseline/' }
    if (/^\.code-awareness\/continuum\/[^/]*validation[^/]*\//.test(normalized)) {
      const group = parts.slice(0, 3).join('/')
      return { classification: 'GENERATED_VALIDATION', group, suggestedRule: group + '/' }
    }
    if (normalized.endsWith('.log')) return { classification: 'LOG', group: '*.log', suggestedRule: '*.log' }
    return { classification: 'UNCLASSIFIED', group: parts.length > 1 ? parts.slice(0, 2).join('/') : normalized }
  }

  private hygieneGroups(paths: string[]) {
    const groups = new Map<string, { classification: string; group: string; count: number; suggestedRule?: string }>()
    for (const path of paths) {
      const descriptor = this.hygieneDescriptor(path)
      const key = descriptor.classification + ':' + descriptor.group
      const existing = groups.get(key)
      if (existing) existing.count++
      else groups.set(key, { ...descriptor, count: 1 })
    }
    return [...groups.values()].sort((a, b) => b.count - a.count || a.group.localeCompare(b.group))
  }

  async analyzeHygiene() {
    await this.repository()
    const changes = await this.getChanges()
    const untracked = changes.filter((change) => change.untracked).map((change) => change.path)
    const groups = this.hygieneGroups(untracked)
    return {
      dirtyCount: changes.length,
      trackedDirtyCount: changes.filter((change) => !change.untracked).length,
      untrackedCount: untracked.length,
      groups,
      recommendedRules: [...new Set(groups.map((group) => group.suggestedRule).filter((rule): rule is string => !!rule))]
    }
  }

  private async previewGitignore(rules: string[]) {
    await this.repository()
    const normalizedRules = this.normalizeIgnoreRules(rules)
    const beforeRevision = await this.git.getWorktreeRevision(this.repoRoot)
    const gitignorePath = join(this.repoRoot, '.gitignore')
    const content = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : ''
    const present = new Set(content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')))
    const alreadyPresent = normalizedRules.filter((rule) => present.has(rule))
    const candidateRules = normalizedRules.filter((rule) => !present.has(rule))
    const before = (await this.getChanges('UNTRACKED')).map((change) => change.path.replace(/\\/g, '/'))
    const matcher = ignore().add(candidateRules)
    const newlyIgnored = candidateRules.length ? before.filter((path) => matcher.ignores(path)) : []
    const ignoredSet = new Set(newlyIgnored)
    const after = before.filter((path) => !ignoredSet.has(path))
    const afterRevision = await this.git.getWorktreeRevision(this.repoRoot)
    if (beforeRevision !== afterRevision) fail('GIT_STATE_CHANGED')
    const previewId = createHash('sha256').update(JSON.stringify({ worktreeRevision: beforeRevision, candidateRules, newlyIgnored })).digest('hex')
    return {
      rules: normalizedRules,
      candidateRules,
      alreadyPresent,
      newlyIgnoredCount: newlyIgnored.length,
      remainingUntrackedCount: after.length,
      affectedGroups: this.hygieneGroups(newlyIgnored),
      worktreeRevision: beforeRevision,
      previewId
    }
  }

  async manageGitignore(request: GitIgnoreRequest) {
    if (request.action === 'PREVIEW_ADD') return this.previewGitignore(request.rules)
    return this.serialized(async () => {
      await this.ready()
      if (typeof request.expectedWorktreeRevision !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedWorktreeRevision) || typeof request.expectedPreviewId !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedPreviewId)) fail('INVALID_ARGUMENT')
      const preview = await this.previewGitignore(request.rules)
      if (preview.worktreeRevision !== request.expectedWorktreeRevision || preview.previewId !== request.expectedPreviewId) fail('GIT_STATE_CHANGED')
      if (!preview.candidateRules.length) return { result: 'NO_CHANGES', addedRules: [], ...preview }
      if (await this.git.getWorktreeRevision(this.repoRoot) !== request.expectedWorktreeRevision) fail('GIT_STATE_CHANGED')
      const path = join(this.repoRoot, '.gitignore')
      const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
      const newline = current.includes('\r\n') ? '\r\n' : '\n'
      const separator = current.length && !current.endsWith('\n') && !current.endsWith('\r') ? newline : ''
      writeFileSync(path, current + separator + preview.candidateRules.join(newline) + newline, 'utf8')
      return this.observeMutation(async () => {
        const state = await this.getState()
        return { result: 'UPDATED', addedRules: preview.candidateRules, newlyIgnoredCount: preview.newlyIgnoredCount, remainingUntrackedCount: state.untrackedCount, worktreeRevision: state.worktreeRevision }
      })
    })
  }

  async getDiff(request: { paths: string[]; mode: 'WORKTREE' | 'STAGED' | 'BETWEEN_REFS'; base?: string; head?: string; cursor?: string }) {
    await this.repository()
    const paths = this.paths(request.paths, 20)
    if (!['WORKTREE', 'STAGED', 'BETWEEN_REFS'].includes(request.mode)) fail('INVALID_ARGUMENT')
    const base = request.mode === 'BETWEEN_REFS' ? await this.ref(request.base!) : undefined
    const head = request.mode === 'BETWEEN_REFS' ? await this.ref(request.head!) : undefined
    const patch = await this.git.getOperationsDiff(this.repoRoot, paths, request.mode, base, head)
    const revision = createHash('sha256').update(JSON.stringify({ paths, mode: request.mode, base, head, patch })).digest('hex')
    let offset = 0
    if (request.cursor) {
      const [expected, position] = request.cursor.split(':')
      if (expected !== revision) fail('GIT_STATE_CHANGED')
      offset = Number(position)
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > patch.length) fail('INVALID_ARGUMENT')
    }
    const end = Math.min(offset + 24000, patch.length)
    return { patch: patch.slice(offset, end), binary: /Binary files .* differ/.test(patch), truncated: end < patch.length, nextCursor: end < patch.length ? `${revision}:${end}` : null, revision }
  }

  async getHistory(request: { ref?: string; limit?: number; path?: string }) {
    await this.repository()
    const limit = request.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_ARGUMENT')
    const ref = await this.ref(request.ref ?? 'HEAD')
    const path = request.path ? this.paths([request.path])[0] : undefined
    return (await this.git.getOperationsHistory(this.repoRoot, ref, limit, path)).trimEnd().split('\n').filter(Boolean).map((line) => {
      const [sha, parents, author, timestamp, subject] = line.split('\0')
      return { sha, parents: parents.split(' ').filter(Boolean), author, timestamp, subject }
    })
  }

  async stage(request: { mode: 'STAGE' | 'UNSTAGE'; paths: string[] }) {
    return this.serialized(async () => {
      await this.repository()
      const paths = this.paths(request.paths)
      if (request.mode === 'STAGE') await this.git.stagePaths(this.repoRoot, paths)
      else if (request.mode === 'UNSTAGE') await this.git.unstagePaths(this.repoRoot, paths)
      else fail('INVALID_ARGUMENT')
      const state = await this.getState()
      return { paths, stagedCount: state.stagedCount, indexRevision: state.indexRevision }
    })
  }

  async commit(request: { message: string; expectedHead: string | null; expectedIndexRevision: string }) {
    return this.serialized(async () => {
      await this.ready(true)
      await this.checkHead(request.expectedHead)
      if ((await this.getChanges('CONFLICTED')).length) fail('MERGE_CONFLICT')
      if (typeof request.message !== 'string' || !request.message.trim() || request.message.length > 10000 || request.message.includes('\0')) fail('INVALID_ARGUMENT')
      const sha = await this.git.commitInspectedIndex(this.repoRoot, request.message, request.expectedHead, request.expectedIndexRevision)
      return this.observeMutation(async () => ({ sha, parent: request.expectedHead, branch: await this.git.getCurrentBranch(this.repoRoot), message: request.message, paths: await this.git.getCommittedPaths(this.repoRoot, sha) }))
    })
  }

  async manageBranch(request: BranchRequest) {
    return this.serialized(async () => {
      await this.repository()
      if (request.action === 'LIST') return (await this.git.listBranches(this.repoRoot)).trimEnd().split('\n').filter(Boolean).map((line) => {
        const [branch, head, current] = line.split('\0'); return { branch, head, current: current === '*' }
      })
      await this.ready()
      const branch = await this.branch(request.branch)
      if (request.action === 'CREATE') {
        await this.checkHead(request.expectedHead)
        await this.git.createBranch(this.repoRoot, branch, await this.ref(request.startPoint ?? 'HEAD'))
      } else if (request.action === 'SWITCH') await this.git.switchBranch(this.repoRoot, branch)
      else if (request.action === 'DELETE') await this.git.deleteBranch(this.repoRoot, branch)
      else if (request.action === 'RENAME') await this.git.renameBranch(this.repoRoot, branch, await this.branch(request.newBranch))
      else fail('INVALID_ARGUMENT')
      return this.observeMutation(() => this.getState())
    })
  }

  async merge(request: MergeRequest) {
    return this.serialized(async () => {
      await this.repository()
      if (request.action === 'ABORT') {
        if (await this.git.getGitOperation(this.repoRoot) !== 'MERGE') fail('GIT_OPERATION_NOT_IN_PROGRESS')
        await this.git.abortMerge(this.repoRoot)
        return this.observeMutation(async () => ({ result: 'ABORTED', ...await this.getState() }))
      }
      await this.ready(); await this.checkHead(request.expectedHead)
      const source = await this.ref(request.source)
      const mode = request.mode ?? 'FF_ONLY'
      if (!['FF_ONLY', 'MERGE'].includes(mode)) fail('INVALID_ARGUMENT')
      if ((await this.getChanges()).length) fail('DIRTY_WORKTREE')
      try { await this.git.mergeBranch(this.repoRoot, source, mode) }
      catch (error) {
        const conflicts = await this.getChanges('CONFLICTED')
        if (conflicts.length) return { result: 'CONFLICTS', paths: conflicts.map((c) => c.path) }
        throw error
      }
      return this.observeMutation(async () => {
        const head = await this.git.getCurrentCommitHash(this.repoRoot)
        return { result: head === request.expectedHead ? 'ALREADY_UP_TO_DATE' : head === source ? 'FAST_FORWARDED' : 'MERGED', head }
      })
    })
  }

  async sync(request: SyncRequest) {
    return this.serialized(async () => {
      await this.ready()
      const remote = request.remote ?? 'origin'
      if (typeof remote !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) fail('REMOTE_NOT_FOUND')
      if (!await this.git.getRemoteUrl(this.repoRoot, remote)) fail('REMOTE_NOT_FOUND')
      if (request.action === 'FETCH') {
        if (this.transport.fetch) await this.transport.fetch(this.repoRoot, remote)
        else await this.git.fetchRemote(this.repoRoot, remote)
        return { remote, result: 'FETCHED' }
      }
      await this.checkHead(request.expectedHead)
      const branch = await this.branch(request.branch ?? await this.git.getCurrentBranch(this.repoRoot) ?? '')
      if (request.action === 'PUSH') {
        if (await this.ref(branch) !== request.expectedHead) fail('GIT_STATE_CHANGED')
        await this.transport.push(this.repoRoot, branch, remote, request.expectedHead ?? undefined)
        return { remote, branch, pushedHead: request.expectedHead }
      }
      if (request.action !== 'PULL_FF_ONLY') fail('INVALID_ARGUMENT')
      if (branch !== await this.git.getCurrentBranch(this.repoRoot)) fail('INVALID_REF')
      if ((await this.getChanges()).length) fail('DIRTY_WORKTREE')
      if (this.transport.pullFastForward) await this.transport.pullFastForward(this.repoRoot, remote, branch)
      else await this.git.pullFastForward(this.repoRoot, remote, branch)
      return this.observeMutation(async () => ({ remote, branch, head: await this.git.getCurrentCommitHash(this.repoRoot) }))
    })
  }

  private async observeCompletedShelf<T>(observe: () => Promise<T>) {
    try { return await observe() }
    catch (error) {
      return { worktreeRevision: null, observation: { status: 'UNAVAILABLE' as const, code: this.normalizeError(error).code } }
    }
  }

  async manageShelf(request: ShelfRequest) {
    return this.serialized(async () => {
      await this.repository()
      if (request.action === 'LIST') return (await this.git.listShelves(this.repoRoot)).map((shelf) => ({ shelfId: shelf.shelfId, label: shelf.label, date: shelf.date, baseHead: shelf.baseHead, pathCount: shelf.files.length }))
      if (request.action === 'DROP') {
        await this.git.dropShelf(this.repoRoot, request.shelfId)
        return { shelfId: request.shelfId, result: 'DROPPED' }
      }
      await this.ready()
      if ((await this.getChanges('CONFLICTED')).length) fail('GIT_OPERATION_IN_PROGRESS')
      if (await this.git.getWorktreeRevision(this.repoRoot) !== request.expectedWorktreeRevision) fail('GIT_STATE_CHANGED')
      if (request.action === 'RESTORE') {
        await this.checkHead(request.expectedHead)
        const shelf = await this.git.readShelf(this.repoRoot, request.shelfId)
        for (const file of shelf.files) this.paths([file.path])
        const result = await this.git.restoreShelf(this.repoRoot, shelf, request.expectedHead, request.expectedWorktreeRevision)
        return { shelfId: shelf.shelfId, result, ...await this.observeCompletedShelf(() => this.getState()) }
      }
      const selected = this.paths(request.paths)
      if (request.label !== undefined && (typeof request.label !== 'string' || request.label.length > 200 || request.label.includes('\0'))) fail('INVALID_ARGUMENT')
      const includes = (path: string) => selected.some((selectedPath) => path === selectedPath || path.startsWith(`${selectedPath}/`))
      const changes = (await this.getChanges()).filter((change) => includes(change.path) || !!change.previousPath && includes(change.previousPath))
      if (!changes.length) fail('NOTHING_TO_SHELVE')
      if (changes.some((change) => change.previousPath && (!includes(change.path) || !includes(change.previousPath)))) fail('INVALID_ARGUMENT')
      const paths = this.paths(changes.flatMap((change) => change.previousPath ? [change.path, change.previousPath] : [change.path]), 100000)
      const shelf = await this.git.createShelf(this.repoRoot, paths, changes.filter((change) => change.untracked).map((change) => change.path), request.expectedWorktreeRevision, request.label ?? '')
      return { shelfId: shelf.shelfId, pathCount: paths.length, baseHead: shelf.baseHead,
        ...await this.observeCompletedShelf(async () => ({ worktreeRevision: await this.git.getWorktreeRevision(this.repoRoot) })) }
    })
  }

  async getConflict(request: { path: string; side?: ConflictSide; cursor?: string }) {
    await this.repository()
    const path = this.paths([request.path])[0]
    const entries = await this.git.getConflictEntries(this.repoRoot, path)
    if (!entries.length) fail('CONFLICT_NOT_FOUND')
    const conflictRevision = await this.git.getConflictRevision(this.repoRoot, path)
    const sides: Array<{ side: ConflictSide; available: boolean; classification: 'TEXT' | 'BINARY' | null }> = []
    for (const side of ['BASE', 'OURS', 'THEIRS', 'WORKTREE'] as const) {
      const bytes = await this.git.readConflictSide(this.repoRoot, path, side, entries)
      sides.push({ side, available: bytes !== null, classification: bytes === null ? null : isBinary(bytes) ? 'BINARY' : 'TEXT' })
    }
    if (await this.git.getConflictRevision(this.repoRoot, path) !== conflictRevision) fail('CONFLICT_STATE_CHANGED')
    const status = (await this.getChanges('CONFLICTED')).find((change) => change.path === path)
    if (!request.side) return { path, kind: `${status?.stagedState ?? ''}${status?.unstagedState ?? ''}`, sides, conflictRevision }
    const side = sides.find((entry) => entry.side === request.side)
    if (!side) fail('INVALID_ARGUMENT')
    if (!side.available) fail('CONFLICT_SIDE_UNAVAILABLE')
    const bytes = await this.git.readConflictSide(this.repoRoot, path, request.side, entries)
    if (await this.git.getConflictRevision(this.repoRoot, path) !== conflictRevision) fail('CONFLICT_STATE_CHANGED')
    if (side.classification === 'BINARY') return { path, side: request.side, classification: 'BINARY', conflictRevision, content: null, truncated: false, nextCursor: null }
    const content = bytes!.toString('utf8')
    const cursorRevision = createHash('sha256').update(JSON.stringify({ path, side: request.side, conflictRevision })).digest('hex')
    let offset = 0
    if (request.cursor) {
      const [revision, position] = request.cursor.split(':')
      if (revision !== cursorRevision) fail('CONFLICT_STATE_CHANGED')
      offset = Number(position)
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.length) fail('INVALID_ARGUMENT')
    }
    let end = Math.min(offset + 24000, content.length)
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--
    return { path, side: request.side, classification: 'TEXT', conflictRevision, content: content.slice(offset, end), truncated: end < content.length, nextCursor: end < content.length ? `${cursorRevision}:${end}` : null }
  }

  async resolveConflict(request: { path: string; resolution: ConflictResolution; expectedHead: string | null; expectedConflictRevision: string; content?: string }) {
    return this.serialized(async () => {
      await this.repository()
      const path = this.paths([request.path])[0]
      await this.checkHead(request.expectedHead)
      const operation = await this.git.getGitOperation(this.repoRoot)
      if (operation && !['MERGE', 'REVERT'].includes(operation)) fail('GIT_OPERATION_IN_PROGRESS')
      const revision = await this.git.getConflictRevision(this.repoRoot, path)
      if (!revision) fail('CONFLICT_NOT_FOUND')
      if (revision !== request.expectedConflictRevision) fail('CONFLICT_STATE_CHANGED')
      if (!['OURS', 'THEIRS', 'CONTENT', 'DELETE'].includes(request.resolution)) fail('INVALID_ARGUMENT')
      if (request.resolution === 'CONTENT') {
        if (typeof request.content !== 'string' || Buffer.byteLength(request.content, 'utf8') > 1024 * 1024 || request.content.includes('\0')) fail('INVALID_ARGUMENT')
        if (Buffer.from(request.content, 'utf8').toString('utf8') !== request.content) fail('INVALID_ARGUMENT')
        const metadata = await this.getConflict({ path })
        if ('sides' in metadata && metadata.sides!.some((side) => side.classification === 'BINARY')) fail('BINARY_CONFLICT_CONTENT_UNSUPPORTED')
      } else if (request.content !== undefined) fail('INVALID_ARGUMENT')
      await this.git.resolveConflict(this.repoRoot, path, request.resolution, request.expectedHead, request.expectedConflictRevision, request.content)
      return this.observeMutation(async () => ({ path, resolution: request.resolution, remainingConflictCount: (await this.getChanges('CONFLICTED')).length, indexRevision: await this.git.getIndexRevision(this.repoRoot) }))
    })
  }

  async revert(request: RevertRequest) {
    return this.serialized(async () => {
      if (request.action === 'CONTINUE' || request.action === 'ABORT') {
        await this.repository(); await this.checkHead(request.expectedHead)
        if (await this.git.getGitOperation(this.repoRoot) !== 'REVERT') fail('GIT_OPERATION_NOT_IN_PROGRESS')
        if (request.action === 'ABORT') {
          await this.git.abortRevert(this.repoRoot)
          return this.observeMutation(async () => ({ result: 'ABORTED', head: await this.git.getCurrentCommitHash(this.repoRoot) }))
        }
        if ((await this.getChanges('CONFLICTED')).length) fail('MERGE_CONFLICT')
        if (await this.git.getIndexRevision(this.repoRoot) !== request.expectedIndexRevision) fail('GIT_STATE_CHANGED')
        await this.git.continueRevert(this.repoRoot, request.expectedHead, request.expectedIndexRevision)
        return this.observeMutation(async () => ({ result: 'REVERTED', head: await this.git.getCurrentCommitHash(this.repoRoot) }))
      }
      await this.ready(); await this.checkHead(request.expectedHead)
      if ((await this.getChanges()).length) fail('DIRTY_WORKTREE')
      if (typeof request.commit !== 'string' || !/^[a-f0-9]{40,64}$/.test(request.commit)) fail('INVALID_REF')
      const commit = await this.ref(request.commit)
      try { await this.git.revertCommit(this.repoRoot, commit) }
      catch (error) {
        const conflicts = await this.getChanges('CONFLICTED')
        if (conflicts.length) return { result: 'CONFLICTS', paths: conflicts.map((c) => c.path) }
        throw error
      }
      return this.observeMutation(async () => ({ result: 'REVERTED', head: await this.git.getCurrentCommitHash(this.repoRoot) }))
    })
  }
}
