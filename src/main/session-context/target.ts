import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'

export interface SessionTargetSelection { worktreeId: string; generation: string }
export interface SessionTarget { root: string; fingerprint: string; validate: () => Promise<void> }
export interface LiveSessionTarget extends SessionTargetSelection { root: string; fingerprint: string }
export interface SessionTargetResolver {
  (selection: SessionTargetSelection): Promise<SessionTarget>
  discover?: () => Promise<LiveSessionTarget[]>
}

export function sourceFingerprint(root: string): string {
  const physical = realpathSync(root)
  const read = (file: string) => {
    if (statSync(file).size > 65536) throw new Error('WORKTREE_STALE')
    return readFileSync(file, 'utf8')
  }
  const pointer = join(physical, '.git')
  const pointerText = statSync(pointer).isDirectory() ? '' : read(pointer)
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(pointerText)
  if (pointerText && !match) throw new Error('WORKTREE_STALE')
  const admin = realpathSync(pointerText ? resolve(physical, match![1]) : pointer)
  const identity = (path: string) => {
    const stat = statSync(path, { bigint: true })
    return [String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]
  }
  return createHash('sha256').update(JSON.stringify([physical, identity(physical), pointerText, admin, identity(admin), read(join(admin, 'HEAD'))])).digest('hex')
}

export function sessionTargetResolver(registry: GitWorktreeRegistry, assertActive: () => void): SessionTargetResolver {
  const resolveTarget: SessionTargetResolver = async selection => {
    const inspect = async () => {
      assertActive()
      const record = await registry.revalidateSelection(selection.worktreeId)
      if (record.generation !== selection.generation || record.detached || !record.branch || !record.head || record.missing || record.prunable) throw new Error('WORKTREE_STALE')
      assertActive()
      return realpathSync(record.path)
    }
    const root = await inspect(), fingerprint = sourceFingerprint(root)
    const validate = async () => {
      if (await inspect() !== root || sourceFingerprint(root) !== fingerprint) throw new Error('WORKTREE_STALE')
    }
    return { root, fingerprint, validate }
  }
  resolveTarget.discover = async () => {
    assertActive()
    const { worktrees } = await registry.discover({ reuseValidatedDirectories: true })
    const targets: LiveSessionTarget[] = []
    for (const record of worktrees) {
      if (record.missing || record.prunable || record.detached || !record.branch || !record.head) continue
      const selection = { worktreeId: record.worktreeId, generation: record.generation }
      const root = realpathSync(record.path)
      targets.push({ ...selection, root, fingerprint: sourceFingerprint(root) })
    }
    assertActive()
    return targets
  }
  return resolveTarget
}
