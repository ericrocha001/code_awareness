import type { GitWorktreeReadSnapshot } from '../core/git-service'
import type { GitChange } from './git-operations-service'

export interface WorktreeStructureRequest {
  worktreeId: string
  paths: string[]
  baseCommit?: string
  cursor?: string
}

export interface CapturedText {
  content: string
  hash: string
  bytes: number
}

export interface WorktreeStructureCapture {
  repositoryId: string
  worktreeId: string
  generation: string
  canonicalHead: string | null
  baseCommit: string | null
  baseSelection: 'EXPLICIT' | 'MERGE_BASE' | 'UNAVAILABLE'
  snapshot: GitWorktreeReadSnapshot
  state: { dirty: boolean; staged: boolean; untracked: boolean; conflicted: boolean }
  fingerprint: string
  files: Array<{ path: string; previousPath?: string; renamedTo?: string; committedStatus: string | null; change?: GitChange; base: CapturedText | null; current: CapturedText | null }>
}

export interface WorktreeStructureReadPort {
  captureWorktreeStructure<T>(request: WorktreeStructureRequest, project: (capture: WorktreeStructureCapture) => Promise<T>): Promise<T>
}
