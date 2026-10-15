import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorktreeRecord } from './git-worktree-registry'
import type { RemovalPreview, RemovalReceipt } from '../../shared/types/worktree-removal-types'

export interface AutomaticRemovalPolicy {
  repositoryId: string
  enabled: boolean
  revision: string
  enrollments: Array<{ preview: RemovalPreview; workspaceRevision: string; policyRevision: string; operatorReleaseConfirmedAt: string; lastResult?: { state: string; code?: string; observedAt: string } }>
}

export interface StoredRemoval {
  administrativeDirectory: string
  preview: RemovalPreview
  revision: string
  state: 'PREPARED' | 'CANCELLED' | 'EXECUTING' | 'CLOSED' | 'UNKNOWN' | 'BLOCKED'
  operationId?: string
  consentDigest?: string
  receipt?: RemovalReceipt
}

export interface ManagedWorktree extends WorktreeRecord {
  repositoryId: string
  startPoint: string
  createdAt: string
  closedAt?: string
}

export class GitWorktreeLifecycle {
  constructor(private readonly common: string) {}

  removalPolicy(repositoryId: string): AutomaticRemovalPolicy {
    const file = join(this.common, 'code-awareness-worktree-removal-policy.json')
    if (!existsSync(file)) return { repositoryId, enabled: false, revision: 'DEFAULT_OFF', enrollments: [] }
    const policy = JSON.parse(readFileSync(file, 'utf8')) as AutomaticRemovalPolicy
    if (policy.repositoryId !== repositoryId) throw new Error('WORKTREE_IDENTITY_MISMATCH')
    return policy
  }

  saveRemovalPolicy(policy: AutomaticRemovalPolicy): void {
    const file = join(this.common, 'code-awareness-worktree-removal-policy.json'), temporary = file + '.' + randomUUID() + '.tmp'
    writeFileSync(temporary, JSON.stringify(policy), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
  }

  private removalFile(id: string, create = false): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('INVALID_ARGUMENT')
    const directory = join(this.common, 'code-awareness-worktree-removals')
    if (create) mkdirSync(directory, { recursive: true })
    return join(directory, id + '.json')
  }

  removal(id: string): StoredRemoval {
    return JSON.parse(readFileSync(this.removalFile(id), 'utf8')) as StoredRemoval
  }

  pendingRemoval(repositoryId: string, worktreeId: string, generation: string): StoredRemoval | undefined {
    const directory = join(this.common, 'code-awareness-worktree-removals')
    if (!existsSync(directory)) return
    const files = readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))
    if (files.length > 10000) throw new Error('REMOVAL_RECEIPT_CAPACITY')
    return files.map(name => this.removal(name.slice(0, -5))).filter(record => record.preview.repositoryId === repositoryId &&
      record.preview.worktreeId === worktreeId && record.preview.generation === generation && record.operationId && ['EXECUTING', 'UNKNOWN'].includes(record.state))
      .sort((a, b) => b.preview.observedAt.localeCompare(a.preview.observedAt))[0]
  }

  saveRemoval(removal: StoredRemoval): void {
    const file = this.removalFile(removal.preview.preparationId, true)
    const temporary = file + '.' + randomUUID() + '.tmp'
    writeFileSync(temporary, JSON.stringify(removal), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
  }

  destination(): string {
    const directory = join(this.common, 'code-awareness-workspaces')
    mkdirSync(directory, { recursive: true })
    return join(directory, randomUUID())
  }

  private file(worktreeId: string, create = false): string {
    if (!/^[a-f0-9]{64}$/.test(worktreeId)) throw new Error('INVALID_ARGUMENT')
    const directory = join(this.common, 'code-awareness-managed-worktrees')
    if (create) mkdirSync(directory, { recursive: true })
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
    const file = this.file(record.worktreeId, true)
    const temporary = file + '.' + randomUUID() + '.tmp'
    writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
  }
}
