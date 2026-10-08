import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorktreeRecord } from './git-worktree-registry'

export interface ManagedWorktree extends WorktreeRecord {
  repositoryId: string
  startPoint: string
  createdAt: string
  closedAt?: string
}

export class GitWorktreeLifecycle {
  constructor(private readonly common: string) {}

  destination(): string {
    const directory = join(this.common, 'code-awareness-workspaces')
    mkdirSync(directory, { recursive: true })
    return join(directory, randomUUID())
  }

  private file(worktreeId: string): string {
    if (!/^[a-f0-9]{64}$/.test(worktreeId)) throw new Error('INVALID_ARGUMENT')
    const directory = join(this.common, 'code-awareness-managed-worktrees')
    mkdirSync(directory, { recursive: true })
    return join(directory, worktreeId + '.json')
  }

  get(record: WorktreeRecord): ManagedWorktree | null {
    const file = this.file(record.worktreeId)
    if (!existsSync(file)) return null
    const managed = JSON.parse(readFileSync(file, 'utf8')) as ManagedWorktree
    if (managed.worktreeId !== record.worktreeId || managed.generation !== record.generation || managed.path !== record.path || managed.closedAt) throw new Error('WORKTREE_MANAGED_RECORD_STALE')
    return managed
  }

  closed(worktreeId: string): ManagedWorktree | null {
    const file = this.file(worktreeId)
    if (!existsSync(file)) return null
    const record = JSON.parse(readFileSync(file, 'utf8')) as ManagedWorktree
    return record.worktreeId === worktreeId && record.closedAt ? record : null
  }

  save(record: ManagedWorktree): void {
    const file = this.file(record.worktreeId)
    const temporary = file + '.' + randomUUID() + '.tmp'
    writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
  }
}
