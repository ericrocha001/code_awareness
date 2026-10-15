import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { GitService } from '../core/git-service'
import type { WorktreeCreationEstimate } from '../../shared/types/worktree-creation-types'
import { estimateWorktreeCreation } from './worktree-creation'

export interface WorktreeIdentity {
  repositoryId: string
  isActive: () => boolean
}

export interface WorktreeRecord {
  worktreeId: string
  generation: string
  path: string
  head: string | null
  branch: string | null
  detached: boolean
  locked: boolean
  prunable: boolean
  missing: boolean
  creation?: WorktreeCreationEstimate
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function fail(code: string): never { throw new Error(code) }

export class GitWorktreeRegistry {
  private common: string | undefined
  private readonly observed = new Map<string, { common: string; admin: string; physical: string; record: WorktreeRecord }>()

  constructor(private readonly root: string, private readonly git: GitService, private readonly identity: WorktreeIdentity) {}

  private async commonDirectory(): Promise<string> {
    if (!this.identity.isActive()) fail('WORKTREE_REPOSITORY_CHANGED')
    const common = realpathSync(await this.git.getCommonDirectory(this.root))
    if (this.common && this.common !== common) fail('WORKTREE_REPOSITORY_CHANGED')
    this.common = common
    return common
  }

  async discover(options?: { reuseValidatedDirectories: true }): Promise<{ repositoryId: string; worktrees: WorktreeRecord[] }> {
    const common = await this.commonDirectory()
    const raw = await this.git.listWorktreeRecords(this.root)
    const groups = raw.split('\0\0').filter(Boolean)
    const worktrees: WorktreeRecord[] = []
    for (let offset = 0; offset < groups.length; offset += 8) {
      const batch = await Promise.all(groups.slice(offset, offset + 8).map(group => this.readRecord(group, common, options?.reuseValidatedDirectories)))
      worktrees.push(...batch)
    }
    if (!this.identity.isActive()) fail('WORKTREE_REPOSITORY_CHANGED')
    return { repositoryId: this.identity.repositoryId, worktrees }
  }

  private validatedDirectories(physical: string, path: string, common: string): { common: string; admin: string } | null {
    if (process.env.GIT_DIR || process.env.GIT_COMMON_DIR || process.env.GIT_WORK_TREE) return null
    const prior = [...this.observed.values()].reverse().find(value => value.physical === physical && value.record.path === resolve(path) && value.common === common)
    if (!prior) return null
    try {
      const pointer = join(physical, '.git')
      let admin: string
      if (statSync(pointer).isDirectory()) admin = realpathSync(pointer)
      else {
        if (statSync(pointer).size > 65536) return null
        const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(readFileSync(pointer, 'utf8'))
        if (!match) return null
        admin = realpathSync(resolve(physical, match[1]))
      }
      if (admin !== prior.admin) return null
      const commonPointer = join(admin, 'commondir')
      let actualCommon = admin
      if (existsSync(commonPointer)) {
        if (statSync(commonPointer).size > 65536) return null
        const value = readFileSync(commonPointer, 'utf8').replace(/\r?\n$/, '')
        if (!value || /[\r\n]/.test(value)) return null
        actualCommon = realpathSync(resolve(admin, value))
      }
      return actualCommon === common ? { common, admin } : null
    } catch { return null }
  }

  private async readRecord(group: string, common: string, reuseValidatedDirectories = false): Promise<WorktreeRecord> {
    const fields = group.split('\0').filter(Boolean)
    const field = (key: string) => fields.find(value => value.startsWith(key + ' '))?.slice(key.length + 1)
    const path = field('worktree')
    if (!path) fail('WORKTREE_REGISTRY_INVALID')
    const missing = !existsSync(path)
    let admin = '', physical = '', generation = ''
    let creation: WorktreeCreationEstimate = { at: null, quality: 'UNKNOWN', source: null }
    if (!missing) {
      physical = realpathSync(path)
      const { common: worktreeCommon, admin: worktreeAdmin } = reuseValidatedDirectories && this.validatedDirectories(physical, path, common) || await this.git.getRepositoryDirectories(physical)
      if (realpathSync(worktreeCommon) !== common) fail('WORKTREE_IDENTITY_MISMATCH')
      admin = realpathSync(worktreeAdmin)
      const stats = statSync(admin, { bigint: true })
      const rootStats = statSync(physical, { bigint: true })
      generation = digest([admin, String(stats.dev), String(stats.ino), String(stats.birthtimeNs), physical, String(rootStats.ino), String(rootStats.birthtimeNs)])
      const adminBirth = Number(stats.birthtimeNs) / 1e6, checkoutBirth = Number(rootStats.birthtimeNs) / 1e6
      creation = estimateWorktreeCreation(adminBirth, checkoutBirth, admin !== common, Date.now())
    } else generation = digest([common, path, 'MISSING'])
    const worktreeId = digest([this.identity.repositoryId, common, generation, path])
    const record: WorktreeRecord = { worktreeId, generation, path: resolve(path), head: field('HEAD') ?? null,
      branch: field('branch')?.replace(/^refs\/heads\//, '') ?? null, detached: fields.includes('detached'),
      locked: fields.some(value => value === 'locked' || value.startsWith('locked ')),
      prunable: fields.some(value => value === 'prunable' || value.startsWith('prunable ')), missing, creation: this.observed.get(worktreeId)?.record.creation ?? creation }
    this.observed.set(worktreeId, { common, admin, physical, record })
    return record
  }

  async revalidateSelection(worktreeId: string): Promise<WorktreeRecord> {
    const prior = this.observed.get(worktreeId)
    if (!prior) fail('WORKTREE_NOT_DISCOVERED')
    const common = await this.commonDirectory()
    const groups = (await this.git.listWorktreeRecords(this.root)).split('\0\0').filter(Boolean)
    const group = groups.find(value => {
      const path = value.split('\0').find(field => field.startsWith('worktree '))?.slice(9)
      return path !== undefined && resolve(path) === prior.record.path
    })
    if (!group) fail('WORKTREE_STALE')
    const current = await this.readRecord(group, common)
    if (!this.identity.isActive()) fail('WORKTREE_REPOSITORY_CHANGED')
    if (current.worktreeId !== worktreeId || current.missing || current.prunable) fail('WORKTREE_STALE')
    const next = this.observed.get(worktreeId)!
    if (prior.common !== next.common || prior.admin !== next.admin || prior.physical !== next.physical) fail('WORKTREE_IDENTITY_MISMATCH')
    return current
  }

  async select(worktreeId: string): Promise<WorktreeRecord> {
    const prior = this.observed.get(worktreeId)
    if (!prior) fail('WORKTREE_NOT_DISCOVERED')
    const current = (await this.discover()).worktrees.find(value => value.worktreeId === worktreeId)
    if (!current || current.missing || current.prunable) fail('WORKTREE_STALE')
    const next = this.observed.get(worktreeId)!
    if (prior.common !== next.common || prior.admin !== next.admin || prior.physical !== next.physical) fail('WORKTREE_IDENTITY_MISMATCH')
    return current
  }

  isReference(worktreeId: string): boolean {
    const observed = this.observed.get(worktreeId)
    return !!observed?.admin && observed.admin === observed.common
  }
}
