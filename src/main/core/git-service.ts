/*
-T ---
*/

import { spawn } from 'child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { DiffFileStatus } from '../../shared/types'
import { FileListingPort } from './file-listing-port'


const GIT_TIMEOUT_MS = 10_000

// Pastas internas que devem ser ignoradas em todas as listagens de arquivos
const INTERNAL_FOLDERS = [
  'code_awareness',
  'codefetch',
  '.sprintdiff',
  'code_checkpoints'
]

function isInternalPath(path: string): boolean {
  return INTERNAL_FOLDERS.some(folder =>
    path === folder || path.startsWith(`${folder}/`)
  )
}

export interface DiffHunk {
  oldStart: number
  oldCount: number
  start: number // primeira linha modificada no novo arquivo (1-indexed)
  count: number // quantidade de linhas afetadas
}

const GIT_STATUS_CODE_MAP: Record<string, DiffFileStatus['changeType']> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  '?': 'added'
}

export interface GitConflictEntry { mode: string; sha: string; stage: number; path: string }
interface ShelfFile { path: string; raw: string | null; canonical: string | null; mode: string; untracked: boolean }
export interface GitShelf {
  owner: 'code-awareness/git-shelf/v1'
  shelfId: string
  label: string
  date: string
  baseHead: string
  stash: string
  files: ShelfFile[]
}
type GitProcessOptions = { timeoutMs?: number; env?: NodeJS.ProcessEnv; allowExitOne?: boolean; input?: Buffer | string }

export class GitService implements FileListingPort {
  private workingBytes(dirPath: string, path: string): Buffer | null {
    try {
      const fullPath = join(dirPath, path)
      const stat = lstatSync(fullPath)
      if (stat.isSymbolicLink()) return Buffer.from(readlinkSync(fullPath))
      if (!stat.isFile()) throw new Error('UNSUPPORTED_GIT_PATH')
      return readFileSync(fullPath)
    } catch (error: any) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  async getWorktreeRevision(dirPath: string): Promise<string> {
    const head = await this.getCurrentCommitHash(dirPath)
    const index = await this.getIndexRevision(dirPath)
    const status = await this.getOperationsStatus(dirPath)
    const hash = createHash('sha256').update(JSON.stringify({ head, index, status }))
    const entries = status.split('\0')
    const paths = new Set<string>()
    for (let i = 0; i < entries.length; i++) {
      if (!entries[i]) continue
      paths.add(entries[i].slice(3))
      if (/[RC]/.test(entries[i].slice(0, 2))) paths.add(entries[++i])
    }
    for (const path of [...paths].sort()) {
      const bytes = this.workingBytes(dirPath, path)
      const stat = bytes === null ? null : lstatSync(join(dirPath, path))
      const mode = stat?.isSymbolicLink() ? 'SYMLINK' : stat ? stat.mode & 0o111 : null
      hash.update(JSON.stringify({ path, mode, content: bytes === null ? null : createHash('sha256').update(bytes).digest('hex') }))
    }
    if (head !== await this.getCurrentCommitHash(dirPath) || index !== await this.getIndexRevision(dirPath) || status !== await this.getOperationsStatus(dirPath)) throw new Error('GIT_STATE_CHANGED')
    return hash.digest('hex')
  }

  async getConflictEntries(dirPath: string, path: string, env?: NodeJS.ProcessEnv): Promise<GitConflictEntry[]> {
    const result = await this.runGit(['--literal-pathspecs', 'ls-files', '--unmerged', '-z', '--', path], dirPath, { env })
    return result.split('\0').filter(Boolean).map((entry) => {
      const tab = entry.indexOf('\t')
      const [mode, sha, stage] = entry.slice(0, tab).split(' ')
      return { mode, sha, stage: Number(stage), path: entry.slice(tab + 1) }
    })
  }

  async readConflictSide(dirPath: string, path: string, side: 'BASE' | 'OURS' | 'THEIRS' | 'WORKTREE', entries?: GitConflictEntry[]): Promise<Buffer | null> {
    if (side === 'WORKTREE') return this.workingBytes(dirPath, path)
    const entry = (entries ?? await this.getConflictEntries(dirPath, path)).find((entry) => entry.stage === { BASE: 1, OURS: 2, THEIRS: 3 }[side])
    return entry ? this.runGitBytes(['cat-file', 'blob', entry.sha], dirPath) : null
  }

  async getConflictRevision(dirPath: string, path: string, env?: NodeJS.ProcessEnv): Promise<string | null> {
    const entries = await this.getConflictEntries(dirPath, path, env)
    if (!entries.length) return null
    const bytes = this.workingBytes(dirPath, path)
    return createHash('sha256').update(JSON.stringify({ entries, content: bytes === null ? null : createHash('sha256').update(bytes).digest('hex') })).digest('hex')
  }

  private async withLockedIndex<T>(dirPath: string, operation: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const indexPath = (await this.runGit(['rev-parse', '--path-format=absolute', '--git-path', 'index'], dirPath)).trim()
    let lock: number | undefined
    try { lock = openSync(`${indexPath}.lock`, 'wx') } catch { throw new Error('GIT_STATE_CHANGED') }
    let temporary: string | undefined
    try {
      temporary = mkdtempSync(join(tmpdir(), 'git-operations-index-'))
      const temporaryIndex = join(temporary, 'index')
      const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex }
      if (existsSync(indexPath)) copyFileSync(indexPath, temporaryIndex)
      else await this.runGit(['read-tree', '--empty'], dirPath, { env })
      const result = await operation(env)
      copyFileSync(temporaryIndex, `${indexPath}.lock`)
      closeSync(lock); lock = undefined
      renameSync(`${indexPath}.lock`, indexPath)
      return result
    } finally {
      if (lock !== undefined) closeSync(lock)
      rmSync(`${indexPath}.lock`, { force: true })
      if (temporary) rmSync(temporary, { recursive: true, force: true })
    }
  }

  async resolveConflict(dirPath: string, path: string, resolution: 'OURS' | 'THEIRS' | 'CONTENT' | 'DELETE', expectedHead: string | null, expectedRevision: string, content?: string): Promise<void> {
    await this.withLockedIndex(dirPath, async (env) => {
      if (await this.getCurrentCommitHash(dirPath) !== expectedHead) throw new Error('GIT_STATE_CHANGED')
      if (await this.getConflictRevision(dirPath, path, env) !== expectedRevision) throw new Error('CONFLICT_STATE_CHANGED')
      if (resolution === 'OURS' || resolution === 'THEIRS') {
        const stage = resolution === 'OURS' ? 2 : 3
        if (!(await this.getConflictEntries(dirPath, path, env)).some((entry) => entry.stage === stage)) throw new Error('CONFLICT_SIDE_UNAVAILABLE')
        await this.runGit(['--literal-pathspecs', 'checkout-index', '--force', `--stage=${stage}`, '--', path], dirPath, { env })
      } else if (resolution === 'DELETE') {
        if (existsSync(join(dirPath, path))) unlinkSync(join(dirPath, path))
      } else {
        const fullPath = join(dirPath, path)
        if (existsSync(fullPath) && lstatSync(fullPath).isSymbolicLink()) unlinkSync(fullPath)
        mkdirSync(dirname(fullPath), { recursive: true })
        writeFileSync(fullPath, content!, 'utf8')
      }
      await this.runGit(['--literal-pathspecs', 'add', '-A', '--', path], dirPath, { env })
    })
  }

  private shelfRef(shelfId: string): string {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(shelfId)) throw new Error('SHELF_NOT_FOUND')
    return `refs/code-awareness/shelves/${shelfId}`
  }

  async readShelf(dirPath: string, shelfId: string): Promise<GitShelf> {
    const ref = this.shelfRef(shelfId)
    try {
      const shelf = JSON.parse(await this.runGit(['show', `${ref}:manifest`], dirPath)) as GitShelf
      if (shelf.owner !== 'code-awareness/git-shelf/v1' || shelf.shelfId !== shelfId) throw new Error('SHELF_NOT_FOUND')
      return shelf
    } catch { throw new Error('SHELF_NOT_FOUND') }
  }

  async listShelves(dirPath: string): Promise<GitShelf[]> {
    const refs = (await this.runGit(['for-each-ref', '--format=%(refname)', 'refs/code-awareness/shelves/'], dirPath)).trim().split('\n').filter(Boolean)
    const shelves: GitShelf[] = []
    for (const ref of refs) {
      try { shelves.push(await this.readShelf(dirPath, ref.split('/').pop()!)) } catch {}
    }
    return shelves.sort((a, b) => b.date.localeCompare(a.date) || a.shelfId.localeCompare(b.shelfId))
  }

  async createShelf(dirPath: string, paths: string[], untrackedPaths: string[], revision: string, label: string): Promise<GitShelf> {
    return this.withLockedIndex(dirPath, async (env) => {
      if (await this.getWorktreeRevision(dirPath) !== revision) throw new Error('GIT_STATE_CHANGED')
      const baseHead = await this.getCurrentCommitHash(dirPath)
      if (!baseHead) throw new Error('SHELF_REQUIRES_HEAD')
      const untracked = new Set(untrackedPaths)
      const original = await this.runGit(['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...paths], dirPath)
      const baseEntries = await this.runGit(['--literal-pathspecs', 'ls-tree', '-r', '-z', baseHead, '--', ...paths], dirPath)
      const modes = new Map<string, string>()
      for (const record of [...baseEntries.split('\0'), ...original.split('\0')].filter(Boolean)) modes.set(record.slice(record.indexOf('\t') + 1), record.slice(0, 6))
      let fileMode = false
      try { fileMode = (await this.runGit(['config', '--bool', '--get', 'core.filemode'], dirPath)).trim() === 'true' } catch {}
      const files: ShelfFile[] = []
      for (const path of paths) {
        const bytes = this.workingBytes(dirPath, path)
        const stat = bytes === null ? null : lstatSync(join(dirPath, path))
        const mode = stat?.isSymbolicLink() ? '120000' : !fileMode && modes.has(path) ? modes.get(path)! : stat && fileMode && stat.mode & 0o111 ? '100755' : '100644'
        const raw = bytes === null ? null : (await this.runGit(['hash-object', '-w', '--stdin', '--no-filters'], dirPath, { input: bytes })).trim()
        const canonical = bytes === null ? null : (await this.runGit(['hash-object', '-w', '--stdin', ...(mode === '120000' ? ['--no-filters'] : [`--path=${path}`])], dirPath, { input: bytes })).trim()
        files.push({ path, raw, canonical, mode, untracked: untracked.has(path) })
      }
      const tree = async (name: string, entries: string, empty = false) => {
        const treeEnv = { ...env, GIT_INDEX_FILE: `${env.GIT_INDEX_FILE}-${name}` }
        await this.runGit(['read-tree', empty ? '--empty' : baseHead], dirPath, { env: treeEnv })
        await this.runGit(['--literal-pathspecs', 'update-index', '--force-remove', '--', ...paths], dirPath, { env: treeEnv })
        if (entries) await this.runGit(['update-index', '-z', '--index-info'], dirPath, { env: treeEnv, input: entries })
        return (await this.runGit(['write-tree'], dirPath, { env: treeEnv })).trim()
      }
      const entry = (file: ShelfFile) => file.canonical ? `${file.mode} ${file.canonical}\t${file.path}\0` : ''
      const stagedTree = await tree('staged', original)
      const worktreeTree = await tree('worktree', files.filter((file) => !file.untracked).map(entry).join(''))
      const identity = ['-c', 'user.name=Code Awareness', '-c', 'user.email=code-awareness@local']
      const indexCommit = (await this.runGit([...identity, 'commit-tree', stagedTree, '-p', baseHead, '-m', 'Code Awareness shelf index'], dirPath)).trim()
      const parents = ['-p', baseHead, '-p', indexCommit]
      if (files.some((file) => file.untracked)) {
        const untrackedTree = await tree('untracked', files.filter((file) => file.untracked).map(entry).join(''), true)
        parents.push('-p', (await this.runGit([...identity, 'commit-tree', untrackedTree, '-m', 'Code Awareness shelf untracked'], dirPath)).trim())
      }
      const stash = (await this.runGit([...identity, 'commit-tree', worktreeTree, ...parents, '-m', 'Code Awareness shelf'], dirPath)).trim()
      const shelf: GitShelf = { owner: 'code-awareness/git-shelf/v1', shelfId: randomUUID(), label, date: new Date().toISOString(), baseHead, stash, files }
      const manifest = (await this.runGit(['hash-object', '-w', '--stdin'], dirPath, { input: JSON.stringify(shelf) })).trim()
      const rawEntries = files.filter((file) => file.raw).map((file, i) => `100644 blob ${file.raw}\traw-${i}\0`).join('')
      const manifestTree = (await this.runGit(['mktree', '-z'], dirPath, { input: `100644 blob ${manifest}\tmanifest\0${rawEntries}` })).trim()
      const shelfCommit = (await this.runGit([...identity, 'commit-tree', manifestTree, '-p', stash, '-m', 'Code Awareness owned shelf'], dirPath)).trim()
      if (await this.getWorktreeRevision(dirPath) !== revision) throw new Error('GIT_STATE_CHANGED')
      for (const file of files) {
        const bytes = this.workingBytes(dirPath, file.path)
        const raw = bytes === null ? null : (await this.runGit(['hash-object', '--stdin', '--no-filters'], dirPath, { input: bytes })).trim()
        if (raw !== file.raw) throw new Error('GIT_STATE_CHANGED')
      }
      await this.runGit(['update-ref', this.shelfRef(shelf.shelfId), shelfCommit, '0'.repeat(baseHead.length)], dirPath)
      const tracked = paths.filter((path) => !untracked.has(path))
      if (tracked.length) await this.runGit(['--literal-pathspecs', 'restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked], dirPath, { env })
      for (const path of untrackedPaths) unlinkSync(join(dirPath, path))
      return shelf
    })
  }

  async restoreShelf(dirPath: string, shelf: GitShelf, expectedHead: string | null, expectedRevision: string): Promise<'RESTORED' | 'CONFLICTS'> {
    return this.withLockedIndex(dirPath, async (env) => {
      if (await this.getCurrentCommitHash(dirPath) !== expectedHead || await this.getWorktreeRevision(dirPath) !== expectedRevision) throw new Error('GIT_STATE_CHANGED')
      const originalIndex = readFileSync(env.GIT_INDEX_FILE!)
      await this.runGit(['read-tree', 'HEAD'], dirPath, { env })
      let result: 'RESTORED' | 'CONFLICTS' = 'RESTORED'
      try { await this.runGit(['stash', 'apply', '--index', shelf.stash], dirPath, { env }) }
      catch (error: any) {
        const conflicts = await this.runGit(['ls-files', '--unmerged', '-z'], dirPath, { env })
        if (conflicts) result = 'CONFLICTS'
        else {
          if (!/conflicts in index|patch failed|does not apply/i.test(error.message)) throw error
          await this.runGit(['read-tree', 'HEAD'], dirPath, { env })
          try { await this.runGit(['stash', 'apply', shelf.stash], dirPath, { env }) }
          catch (fallback) {
            if (await this.runGit(['ls-files', '--unmerged', '-z'], dirPath, { env })) result = 'CONFLICTS'
            else throw fallback
          }
        }
      }
      const paths = shelf.files.map((file) => file.path)
      const selectedIndex = await this.runGit(['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...paths], dirPath, { env })
      writeFileSync(env.GIT_INDEX_FILE!, originalIndex)
      await this.runGit(['--literal-pathspecs', 'update-index', '--force-remove', '--', ...paths], dirPath, { env })
      if (selectedIndex) await this.runGit(['update-index', '-z', '--index-info'], dirPath, { env, input: selectedIndex })
      if (result === 'CONFLICTS') return result
      for (const file of shelf.files) {
        const bytes = this.workingBytes(dirPath, file.path)
        if (!bytes || !file.raw || file.mode === '120000') continue
        const canonical = (await this.runGit(['hash-object', '--stdin', `--path=${file.path}`], dirPath, { input: bytes })).trim()
        if (canonical === file.canonical) writeFileSync(join(dirPath, file.path), await this.runGitBytes(['cat-file', 'blob', file.raw], dirPath))
      }
      return result
    })
  }

  async dropShelf(dirPath: string, shelfId: string): Promise<void> {
    await this.readShelf(dirPath, shelfId)
    const ref = this.shelfRef(shelfId)
    const sha = (await this.runGit(['rev-parse', '--verify', ref], dirPath)).trim()
    await this.runGit(['update-ref', '-d', ref, sha], dirPath)
  }

  async continueRevert(dirPath: string, expectedHead: string | null, expectedIndexRevision: string): Promise<void> {
    await this.withLockedIndex(dirPath, async (env) => {
      if (await this.getCurrentCommitHash(dirPath) !== expectedHead || await this.getIndexRevision(dirPath) !== expectedIndexRevision) throw new Error('GIT_STATE_CHANGED')
      await this.runGit(['-c', 'core.editor=true', 'revert', '--continue'], dirPath, { env })
    })
  }

  async abortRevert(dirPath: string): Promise<void> {
    await this.runGit(['revert', '--abort'], dirPath)
  }

  async commitInspectedIndex(dirPath: string, message: string, expectedHead: string | null, expectedIndexRevision: string): Promise<string> {
    const indexPath = (await this.runGit(['rev-parse', '--path-format=absolute', '--git-path', 'index'], dirPath)).trim()
    let lock: number
    try { lock = openSync(`${indexPath}.lock`, 'wx') } catch { throw new Error('GIT_STATE_CHANGED') }
    let temporary: string | undefined
    try {
      if (await this.getCurrentCommitHash(dirPath) !== expectedHead || await this.getIndexRevision(dirPath) !== expectedIndexRevision) throw new Error('GIT_STATE_CHANGED')
      if (!await this.hasStagedChanges(dirPath)) throw new Error('NOTHING_TO_COMMIT')
      temporary = mkdtempSync(join(tmpdir(), 'git-inspected-index-'))
      copyFileSync(indexPath, join(temporary, 'index'))
      const tree = (await this.runGit(['write-tree'], dirPath, { env: { ...process.env, GIT_INDEX_FILE: join(temporary, 'index') } })).trim()
      const args: string[] = []
      try { await this.runGit(['var', 'GIT_AUTHOR_IDENT'], dirPath) }
      catch { args.push('-c', 'user.name=Code Awareness', '-c', 'user.email=code-awareness@local') }
      args.push('commit-tree', tree, ...(expectedHead ? ['-p', expectedHead] : []), '-m', message)
      const mergeHeadPath = (await this.runGit(['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'], dirPath)).trim()
      if (existsSync(mergeHeadPath)) for (const parent of readFileSync(mergeHeadPath, 'utf8').trim().split('\n')) args.push('-p', parent)
      const sha = (await this.runGit(args, dirPath)).trim()
      try { await this.runGit(['update-ref', '-m', message.split('\n')[0], 'HEAD', sha, expectedHead ?? '0'.repeat(40)], dirPath) }
      catch { throw new Error('GIT_STATE_CHANGED') }
      if (existsSync(mergeHeadPath)) {
        for (const file of ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE']) rmSync(join(mergeHeadPath, '..', file), { force: true })
      }
      return sha
    } finally {
      closeSync(lock); rmSync(`${indexPath}.lock`, { force: true })
      if (temporary) rmSync(temporary, { recursive: true, force: true })
    }
  }
  async getOperationsStatus(dirPath: string): Promise<string> {
    return this.runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], dirPath)
  }

  async getIndexRevision(dirPath: string): Promise<string> {
    return createHash('sha256').update(await this.runGit(['ls-files', '--stage', '-z'], dirPath)).digest('hex')
  }

  async getGitOperation(dirPath: string): Promise<string | null> {
    const gitDir = (await this.runGit(['rev-parse', '--absolute-git-dir'], dirPath)).trim()
    for (const [file, operation] of [['rebase-merge', 'REBASE'], ['rebase-apply', 'REBASE'], ['MERGE_HEAD', 'MERGE'], ['CHERRY_PICK_HEAD', 'CHERRY_PICK'], ['REVERT_HEAD', 'REVERT']] as const) {
      if (existsSync(join(gitDir, file))) return operation
    }
    return null
  }

  async getUpstreamState(dirPath: string): Promise<{ upstream: string | null; ahead: number; behind: number }> {
    try {
      const upstream = (await this.runGit(['rev-parse', '--abbrev-ref', '@{upstream}'], dirPath)).trim()
      const counts = (await this.runGit(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], dirPath)).trim().split(/\s+/).map(Number)
      return { upstream, ahead: counts[0], behind: counts[1] }
    } catch { return { upstream: null, ahead: 0, behind: 0 } }
  }

  async validateBranch(dirPath: string, branch: string): Promise<void> {
    await this.runGit(['check-ref-format', '--branch', branch], dirPath)
  }

  async resolveCommit(dirPath: string, ref: string): Promise<string> {
    return (await this.runGit(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], dirPath)).trim()
  }

  async getOperationsDiff(dirPath: string, paths: string[], mode: 'WORKTREE' | 'STAGED' | 'BETWEEN_REFS', base?: string, head?: string): Promise<string> {
    const args = ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color']
    if (mode === 'STAGED') args.push('--cached')
    if (mode === 'BETWEEN_REFS') args.push(base!, head!)
    let patch = await this.runGit([...args, '--', ...paths], dirPath)
    if (mode === 'WORKTREE') {
      const untracked = new Set((await this.runGit(['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z', '--', ...paths], dirPath)).split('\0').filter(Boolean))
      for (const path of untracked) patch += await this.runGit(['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--', '/dev/null', path], dirPath, { allowExitOne: true })
    }
    return patch
  }

  async getOperationsHistory(dirPath: string, ref: string, limit: number, path?: string): Promise<string> {
    return this.runGit(['--literal-pathspecs', 'log', `--max-count=${limit}`, '--format=%H%x00%P%x00%an%x00%aI%x00%s', ref, '--', ...(path ? [path] : [])], dirPath)
  }

  async getCommittedPaths(dirPath: string, sha: string): Promise<string[]> {
    return (await this.runGit(['diff-tree', '--root', '--first-parent', '--no-commit-id', '--name-only', '-r', '-z', sha], dirPath)).split('\0').filter(Boolean)
  }

  async unstagePaths(dirPath: string, paths: string[]): Promise<void> {
    if (await this.hasCommits(dirPath)) await this.runGit(['--literal-pathspecs', 'restore', '--staged', '--', ...paths], dirPath)
    else await this.runGit(['--literal-pathspecs', 'rm', '--cached', '--ignore-unmatch', '--', ...paths], dirPath)
  }

  async listBranches(dirPath: string): Promise<string> {
    return this.runGit(['for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(HEAD)', 'refs/heads/'], dirPath)
  }

  async createBranch(dirPath: string, branch: string, startPoint: string): Promise<void> {
    await this.runGit(['branch', branch, startPoint], dirPath)
  }

  async switchBranch(dirPath: string, branch: string): Promise<void> {
    await this.runGit(['switch', '--no-guess', branch], dirPath)
  }

  async renameBranch(dirPath: string, branch: string, newBranch: string): Promise<void> {
    await this.runGit(['branch', '-m', branch, newBranch], dirPath)
  }

  async deleteBranch(dirPath: string, branch: string): Promise<void> {
    await this.runGit(['branch', '-d', branch], dirPath)
  }

  async mergeBranch(dirPath: string, source: string, mode: 'FF_ONLY' | 'MERGE'): Promise<void> {
    await this.runGit(['merge', mode === 'FF_ONLY' ? '--ff-only' : '--no-edit', source], dirPath)
  }

  async abortMerge(dirPath: string): Promise<void> {
    await this.runGit(['merge', '--abort'], dirPath)
  }

  async revertCommit(dirPath: string, commit: string): Promise<void> {
    await this.runGit(['revert', '--no-edit', commit], dirPath)
  }

  async fetchRemote(dirPath: string, remote: string, token?: string): Promise<void> {
    const execute = (env?: NodeJS.ProcessEnv) => this.runGit(['fetch', '--', remote], dirPath, { timeoutMs: 120_000, env })
    if (token) await this.withEphemeralCredential(token, execute)
    else await execute({ ...process.env, GIT_TERMINAL_PROMPT: '0' })
  }

  async pullFastForward(dirPath: string, remote: string, branch: string, token?: string): Promise<void> {
    const execute = (env?: NodeJS.ProcessEnv) => this.runGit(['pull', '--ff-only', '--', remote, branch], dirPath, { timeoutMs: 120_000, env })
    if (token) await this.withEphemeralCredential(token, execute)
    else await execute({ ...process.env, GIT_TERMINAL_PROMPT: '0' })
  }

  async isGitRepository(dirPath: string): Promise<boolean> {
    return existsSync(join(dirPath, '.git'))
  }

  private async runGit(args: string[], cwd: string, options?: GitProcessOptions): Promise<string> {
    return (await this.runGitBytes(args, cwd, options)).toString('utf8')
  }

  private runGitBytes(args: string[], cwd: string, options?: GitProcessOptions): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const stdout: Buffer[] = []
      let stderr = ''
      const proc = spawn('git', args, { cwd, shell: false, env: options?.env })
      proc.stderr.setEncoding('utf8')

      // Timeout de proteção contra processos Git travados
      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error('Git process timed out'))
      }, options?.timeoutMs ?? GIT_TIMEOUT_MS)

      proc.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk) })
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      proc.stdin.on('error', () => {})
      proc.stdin.end(options?.input)
      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0 || options?.allowExitOne && code === 1) resolve(Buffer.concat(stdout))
        else reject(new Error(stderr.trim() || `git exited with code ${code}`))
      })
      proc.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  async getRemoteUrl(dirPath: string, remote = 'origin'): Promise<string | null> {
    try {
      const value = await this.runGit(['remote', 'get-url', remote], dirPath)
      return value.trim() || null
    } catch { return null }
  }

  async addRemote(dirPath: string, remote: string, url: string): Promise<void> {
    await this.runGit(['remote', 'add', remote, url], dirPath)
  }

  async getCurrentBranch(dirPath: string): Promise<string | null> {
    try {
      const value = await this.runGit(['branch', '--show-current'], dirPath)
      return value.trim() || null
    } catch { return null }
  }

  async hasCommits(dirPath: string): Promise<boolean> {
    return (await this.getCurrentCommitHash(dirPath)) !== null
  }

  async cloneAuthenticated(remoteUrl: string, parentPath: string, directoryName: string, token: string): Promise<string> {
    const destination = join(parentPath, directoryName)
    if (!existsSync(parentPath) || existsSync(destination)) throw new Error('LOCAL_PATH_CONFLICT')
    try {
      await this.withEphemeralCredential(token, (env) =>
        this.runGit(['clone', '--', remoteUrl, directoryName], parentPath, { timeoutMs: 120_000, env })
      )
    } catch (error) {
      rmSync(destination, { recursive: true, force: true })
      throw error
    }
    return destination
  }

  async pushAuthenticated(dirPath: string, remote: string, branch: string, token: string, expectedHead?: string): Promise<void> {
    await this.withEphemeralCredential(token, (env) =>
      this.runGit(['push', ...(expectedHead ? [] : ['--set-upstream']), '--', remote, expectedHead ? `${expectedHead}:refs/heads/${branch}` : branch], dirPath, { timeoutMs: 120_000, env })
    )
  }

  async pushUrlAuthenticated(dirPath: string, remoteUrl: string, branch: string, token: string): Promise<void> {
    await this.withEphemeralCredential(token, (env) =>
      this.runGit(['push', '--', remoteUrl, `${branch}:refs/heads/${branch}`], dirPath, { timeoutMs: 120_000, env })
    )
  }

  async push(dirPath: string, remote: string, branch: string, expectedHead?: string): Promise<void> {
    await this.runGit(['push', '--', remote, expectedHead ? `${expectedHead}:refs/heads/${branch}` : branch], dirPath, { timeoutMs: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  }

  async stagePaths(dirPath: string, relativePaths: string[]): Promise<void> {
    if (relativePaths.length === 0) return
    await this.runGit(['--literal-pathspecs', '-c', 'core.quotePath=false', 'add', '-A', '--', ...relativePaths], dirPath)
  }

  async hasWorkingTreeChanges(dirPath: string, subPath?: string): Promise<boolean> {
    const args = ['-c', 'core.quotePath=false', 'status', '--porcelain']
    if (subPath) args.push('--', subPath)
    try {
      const stdout = await this.runGit(args, dirPath)
      return stdout.trim().length > 0
    } catch {
      return false
    }
  }

  async hasStagedChanges(dirPath: string): Promise<boolean> {
    try {
      const stdout = await this.runGit(['diff', '--cached', '--name-only'], dirPath)
      return stdout.trim().length > 0
    } catch {
      return false
    }
  }

  async commit(dirPath: string, message: string, author?: { name: string; email: string }): Promise<string | null> {
    const hasStaged = await this.hasStagedChanges(dirPath)
    if (!hasStaged) return null

    let hasIdentity = false
    try {
      const ident = await this.runGit(['var', 'GIT_AUTHOR_IDENT'], dirPath)
      if (ident.trim().length > 0) hasIdentity = true
    } catch {
      hasIdentity = false
    }

    const args: string[] = ['-c', 'core.quotePath=false']
    if (!hasIdentity) {
      const name = author?.name ?? 'Code Awareness'
      const email = author?.email ?? 'code-awareness@local'
      args.push('-c', `user.name=${name}`, '-c', `user.email=${email}`)
    }
    args.push('commit', '-m', message)
    await this.runGit(args, dirPath)
    return await this.getCurrentCommitHash(dirPath)
  }

  async isRemoteDiverged(dirPath: string, remote: string, branch: string, token: string): Promise<boolean> {
    try {
      await this.withEphemeralCredential(token, (env) =>
        this.runGit(['push', '--dry-run', remote, branch], dirPath, { timeoutMs: 30_000, env })
      )
      return false
    } catch (error: any) {
      const msg = String(error?.message ?? '').toLowerCase()
      if (
        msg.includes('non-fast-forward') ||
        msg.includes('fetch first') ||
        msg.includes('[rejected]') ||
        msg.includes('behind')
      ) {
        return true
      }
      throw error
    }
  }


  private async withEphemeralCredential<T>(token: string, operation: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const directory = mkdtempSync(join(tmpdir(), 'code-awareness-git-'))
    const helper = join(directory, process.platform === 'win32' ? 'askpass.cmd' : 'askpass.sh')
    const content = process.platform === 'win32'
      ? '@echo off\r\necho %~1 | findstr /I "Username" >nul\r\nif %errorlevel%==0 (echo x-access-token) else (echo %CODE_AWARENESS_GIT_TOKEN%)\r\n'
      : '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "x-access-token" ;; *) printf "%s\\n" "$CODE_AWARENESS_GIT_TOKEN" ;; esac\n'
    try {
      writeFileSync(helper, content, { mode: 0o700, flag: 'wx' })
      return await operation({
        ...process.env,
        GIT_ASKPASS: helper,
        GIT_TERMINAL_PROMPT: '0',
        CODE_AWARENESS_GIT_TOKEN: token
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  async getModifiedFiles(dirPath: string): Promise<DiffFileStatus[]> {
    try {
      // Executa os dois comandos em paralelo para performance
      const [statusOutput, untrackedOutput] = await Promise.all([
        this.runGit(['-c', 'core.quotePath=false', 'status', '--porcelain'], dirPath),
        // ls-files lista cada arquivo untracked individualmente (nunca agrupa diretórios)
        // --exclude-standard respeita o .gitignore do projeto
        this.runGit(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard'], dirPath)
      ])

      // Arquivos M/A/D do git status (modified, staged, deleted)
      const statusFiles = this.parseGitStatus(statusOutput)

      // Caminhos já cobertos pelo git status (evita duplicatas)
      const statusPaths = new Set(statusFiles.map(f => f.relativePath))

      // Arquivos untracked individuais vindos do ls-files
      const untrackedFiles: DiffFileStatus[] = untrackedOutput
        .split('\n')
        .map(line => line.trim())
        // Ignora linhas vazias ou caminhos que terminam em '/' (defesa em profundidade)
        .filter(p => p.length > 0 && !p.endsWith('/'))
        // Usa a função compartilhada para ignorar pastas internas
        .filter(p => !isInternalPath(p))
        // Ignora arquivos já presentes no git status (ex: staged untracked via 'A')
        .filter(p => !statusPaths.has(p))
        .map(relativePath => {
          const fullPath = join(dirPath, relativePath)
          if (!existsSync(fullPath)) {
            console.debug(`[GitService] Arquivo deletado ignorado (untracked): ${relativePath}`)
            return null
          }
          return {
            relativePath,
            name: relativePath.split('/').pop() ?? relativePath,
            changeType: 'added' as DiffFileStatus['changeType'],
            mtime: 0,
            size: 0
          }
        })
        .filter((f): f is DiffFileStatus => f !== null)

      // Merge e enriquecimento com mtime/size via statSync
      const allFiles = [...statusFiles, ...untrackedFiles]
      return allFiles
        .map(f => {
          const fullPath = join(dirPath, f.relativePath)
          if (!existsSync(fullPath)) {
            // Arquivos deletados reportados pelo Git são expostos com metadados
            // zerados (mtime/size) para o diff semântico representar a deleção.
            // Demais casos (corrida transitória) continuam descartados.
            if (f.changeType === 'deleted') {
              return { ...f, mtime: 0, size: 0 }
            }
            console.debug(`[GitService] Arquivo deletado ignorado: ${f.relativePath}`)
            return null
          }
          try {
            const st = statSync(fullPath)
            return { ...f, mtime: st.mtimeMs, size: st.size }
          } catch {
            // Fallback: se não conseguir ler o mtime (permissão, etc.),
            // usa Date.now() para tratar como recente na ordenação por recência
            console.warn(`[GitService] Falha ao ler mtime de ${f.relativePath}, usando fallback`)
            return { ...f, mtime: Date.now(), size: 0 }
          }
        })
        .filter((f): f is DiffFileStatus => f !== null)
        .sort((a, b) => b.mtime - a.mtime)
    } catch {
      return []
    }
  }

  async getAllFiles(dirPath: string): Promise<DiffFileStatus[]> {
    try {
      // Executa os dois comandos Git em paralelo (tracked + untracked)
      const [trackedOutput, untrackedOutput] = await Promise.all([
        this.runGit(['-c', 'core.quotePath=false', 'ls-files'], dirPath),
        this.runGit(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard'], dirPath)
      ])

      // Filtra e normaliza os arquivos tracked
      const trackedPaths = trackedOutput
        .split('\n')
        .map(line => line.trim())
        .filter(p => p.length > 0 && !p.endsWith('/'))
        .filter(p => !isInternalPath(p))

      const pathSet = new Set(trackedPaths)

      // Filtra e normaliza os arquivos untracked, evitando duplicatas com os tracked
      const untrackedPaths = untrackedOutput
        .split('\n')
        .map(line => line.trim())
        .filter(p => p.length > 0 && !p.endsWith('/'))
        .filter(p => !isInternalPath(p))
        .filter(p => !pathSet.has(p))

      // Une as duas listas e mapeia os status para o formato DiffFileStatus
      // Filtra arquivos que não existem mais no filesystem (deletados mas ainda no índice git)
      const allPaths = [...trackedPaths, ...untrackedPaths]
      const files: DiffFileStatus[] = []
      for (const relativePath of allPaths) {
        const fullPath = join(dirPath, relativePath)
        if (!existsSync(fullPath)) {
          // Arquivo deletado do disco mas ainda presente no índice git — exclui da listagem
          console.debug(`[GitService] Arquivo deletado ignorado: ${relativePath}`)
          continue
        }
        let mtime = 0
        let size = 0
        try {
          const st = statSync(fullPath)
          mtime = st.mtimeMs
          size = st.size
        } catch {
          // Fallback: se não conseguir ler o mtime, usa Date.now() para tratar como recente
          console.warn(`[GitService] Falha ao ler mtime de ${relativePath}, usando fallback`)
          mtime = Date.now()
        }
        files.push({
          relativePath,
          name: relativePath.split('/').pop() ?? relativePath,
          changeType: 'tracked',
          mtime,
          size
        })
      }

      // Ordena por mtime descendente para priorizar arquivos alterados recentemente
      return files.sort((a, b) => b.mtime - a.mtime)
    } catch {
      return []
    }
  }

  async listAllFiles(repoPath: string): Promise<Array<{ relativePath: string }>> {
    const files = await this.getAllFiles(repoPath)
    return files.map(f => ({ relativePath: f.relativePath }))
  }

  async getModifiedHunks(dirPath: string, relativePath: string): Promise<DiffHunk[]> {
    try {
      const stdout = await this.runGit(['diff', 'HEAD', '-U0', '--', relativePath], dirPath)
      return this.parseHunks(stdout)
    } catch {
      return []
    }
  }

  async getFileAtHead(dirPath: string, relativePath: string): Promise<string | null> {
    try {
      const stdout = await this.runGit(['show', `HEAD:${relativePath}`], dirPath)
      return stdout
    } catch {
      return null
    }
  }

  private parseHunks(diffOutput: string): DiffHunk[] {
    const pattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm
    const hunks: DiffHunk[] = []

    for (const match of diffOutput.matchAll(pattern)) {
      const oldStart = parseInt(match[1])
      const oldCount = match[2] !== undefined ? parseInt(match[2]) : 1
      const start = parseInt(match[3])
      const count = match[4] !== undefined ? parseInt(match[4]) : 1
      hunks.push({ oldStart, oldCount, start, count })
    }

    return hunks
  }

  /**
   * Obtém o hash do commit HEAD atual do repositório.
   *
   * @param dirPath Caminho absoluto para a raiz do repositório.
   * @returns Hash completo do HEAD atual ou null se não for possível obter.
   */
  async getCurrentCommitHash(dirPath: string): Promise<string | null> {
    try {
      const stdout = await this.runGit(['rev-parse', 'HEAD'], dirPath)
      return stdout.trim() || null
    } catch {
      // Repositório sem commits ou erro ao executar git rev-parse
      return null
    }
  }

  /**
   * Verifica em batch se os paths dados são ignorados pelo Git (`.gitignore` + nested).
   * Usa `git check-ignore --stdin -z` para evitar um processo por path.
   *
   * Retorna um Set com os paths que são ignorados.
   * Paths fora do repositório ou erros de processo resultam em Set vazio (fail-open: trata como não-ignorado).
   */
  async checkIgnoreBatch(repoPath: string, relativePaths: string[]): Promise<Set<string>> {
    if (relativePaths.length === 0) return new Set()
    // Input separado por NUL para lidar com espaços e caracteres especiais
    const input = relativePaths.join('\0') + '\0'
    const ignored = new Set<string>()
    return new Promise((resolve) => {
      let stdout = ''
      // exit code 1 = nenhum ignorado; exit code 0 = algum ignorado — ambos são sucesso operacional
      const proc = spawn('git', ['check-ignore', '--stdin', '-z'], { cwd: repoPath, shell: false })
      const timer = setTimeout(() => {
        proc.kill()
        resolve(ignored) // timeout → fail-open
      }, GIT_TIMEOUT_MS)
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.stdin.write(input)
      proc.stdin.end()
      proc.on('close', () => {
        clearTimeout(timer)
        // Saída também é separada por NUL
        for (const p of stdout.split('\0')) {
          const trimmed = p.trim()
          if (trimmed) ignored.add(trimmed)
        }
        resolve(ignored)
      })
      proc.on('error', () => {
        clearTimeout(timer)
        resolve(ignored) // erro de spawn → fail-open
      })
    })
  }

  private parseGitStatus(output: string): DiffFileStatus[] {
    return output
      .split('\n')
      .map(line => {
        if (line.trim().length === 0) return null
        
        let relativePath = line.substring(3).trim()
        
        // Handle git renames (e.g., 'old_path -> new_path')
        if (relativePath.includes(' -> ')) {
          relativePath = relativePath.split(' -> ').pop()!.trim()
        }
        
        // Remove surrounding quotes if git porcelain added them
        if (relativePath.startsWith('"') && relativePath.endsWith('"')) {
          relativePath = relativePath.substring(1, relativePath.length - 1)
        }
        
        if (!relativePath || relativePath.endsWith('/')) return null
        const name = relativePath.split('/').pop() ?? relativePath
        if (!name) return null
        
        if (isInternalPath(relativePath)) return null
        
        const code = line.substring(0, 2).trim()
        const changeType = GIT_STATUS_CODE_MAP[code[0]] ?? 'modified'
        return { relativePath, name, changeType, mtime: 0, size: 0 }
      })
      .filter((item): item is DiffFileStatus => item !== null)
  }
}
