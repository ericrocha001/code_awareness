import { lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GitService } from '../../core/git-service'
import { sha256 } from '../publication/openai-plugin-model'
import { ACADEMY_AUTHORED_PATHS } from './academy-git-snapshot'

const MAX_FILE_BYTES = 8 * 1024 * 1024
const ABSENT = 'ABSENT'
const UNREADABLE = 'UNREADABLE'
const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

export type WorkspaceReviewCode = 'WORKSPACE_EXTERNAL_CHANGES_REVIEW_REQUIRED' | 'GIT_OPERATION_REVIEW_REQUIRED' | 'WORKSPACE_UNCOMMITTED_RECOVERY_REQUIRED'
export type WorkspaceDiagnosis =
  | { kind: 'CLEAN' }
  | { kind: 'RECOVERABLE'; paths: string[] }
  | { kind: 'REVIEW_REQUIRED'; code: WorkspaceReviewCode; paths: string[] }

export interface WorkspaceStatusEntry { index: string; worktree: string; paths: string[] }
export type RecoveryIntent = Record<string, string>

export function parseWorkspaceStatus(raw: string): WorkspaceStatusEntry[] {
  const fields = raw.split('\0')
  const entries: WorkspaceStatusEntry[] = []
  for (let position = 0; position < fields.length; position++) {
    const field = fields[position]
    if (!field) continue
    const index = field[0], worktree = field[1], paths = [field.slice(3)]
    if ('RC'.includes(index) || 'RC'.includes(worktree)) paths.push(fields[++position])
    entries.push({ index, worktree, paths })
  }
  return entries
}

const digest = (bytes: Buffer | null): string => bytes ? sha256(bytes) : ABSENT
const isManaged = (path: string): boolean => ACADEMY_AUTHORED_PATHS.some(root => path === root || path.startsWith(`${root}/`))
const intentFile = (root: string): string => join(root, '.git', 'academy-recovery-intent.json')

export function readRecoveryIntent(root: string): RecoveryIntent {
  try { return JSON.parse(readFileSync(intentFile(root), 'utf8')) } catch { return {} }
}

export async function writeRecoveryIntent(git: GitService, root: string, desired: Map<string, Buffer | null>): Promise<void> {
  const intent: RecoveryIntent = {}
  for (const entry of (await git.readManagedTree(root, 'HEAD', ACADEMY_AUTHORED_PATHS)).split('\0').filter(Boolean)) intent[entry.slice(entry.indexOf('\t') + 1)] = ABSENT
  for (const [path, bytes] of desired) intent[path] = digest(bytes)
  writeFileSync(intentFile(root), JSON.stringify(intent))
}

export function clearRecoveryIntent(root: string): void { rmSync(intentFile(root), { force: true }) }

function worktreeDigest(root: string, path: string): string {
  try {
    const target = join(root, path)
    if (!lstatSync(target).isFile()) return UNREADABLE
    const bytes = readFileSync(target)
    return bytes.length > MAX_FILE_BYTES ? UNREADABLE : digest(bytes)
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? ABSENT : UNREADABLE }
}

async function committedDigest(git: GitService, root: string, ref: string, path: string): Promise<string> {
  try { return digest(await git.readCommitFile(root, ref, path, MAX_FILE_BYTES)) } catch { return UNREADABLE }
}

export async function diagnoseWorkspace(git: GitService, root: string, input: {
  desired: Map<string, Buffer | null> | null
  intent: RecoveryIntent
  headMatchesSource: boolean
}): Promise<WorkspaceDiagnosis> {
  const entries = parseWorkspaceStatus(await git.getOperationsStatus(root))
  if (!entries.length) return { kind: 'CLEAN' }
  const paths = [...new Set(entries.flatMap(entry => entry.paths))].sort()
  if (await git.getGitOperation(root)) return { kind: 'REVIEW_REQUIRED', code: 'GIT_OPERATION_REVIEW_REQUIRED', paths }
  const review = (): WorkspaceDiagnosis => ({ kind: 'REVIEW_REQUIRED', code: 'WORKSPACE_EXTERNAL_CHANGES_REVIEW_REQUIRED', paths })
  if (entries.some(entry => UNMERGED.has(entry.index + entry.worktree)) || paths.some(path => !isManaged(path))) return review()
  const stagedTree = await git.writeIndexTree(root)
  for (const path of paths) {
    const allowed = new Set([await committedDigest(git, root, 'HEAD', path), input.intent[path]])
    if (input.desired) allowed.add(digest(input.desired.get(path) ?? null))
    if (!allowed.has(worktreeDigest(root, path)) || !allowed.has(await committedDigest(git, root, stagedTree, path))) return review()
  }
  return input.desired && input.headMatchesSource ? { kind: 'RECOVERABLE', paths } : { kind: 'REVIEW_REQUIRED', code: 'WORKSPACE_UNCOMMITTED_RECOVERY_REQUIRED', paths }
}
