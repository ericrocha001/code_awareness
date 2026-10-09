import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { promisify } from 'node:util'
import { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'
import { GitService } from '../core/git-service'
import type { RuntimeSourceOrigin } from './runtime-identity-types'

const execute = promisify(execFile)

export async function captureSourceOrigin(sourceRootPath: string): Promise<RuntimeSourceOrigin> {
  const evidence: RuntimeSourceOrigin = {
    status: 'UNAVAILABLE', sourceRootPath, worktree: null, capturedAt: new Date().toISOString()
  }
  try {
    const { stdout } = await execute('git', ['rev-parse', '--show-toplevel'], {
      cwd: sourceRootPath, timeout: 2000, maxBuffer: 65536, windowsHide: true, env: { ...process.env, LC_ALL: 'C' }
    })
    const rootPath = realpathSync(stdout.trim())
    const raw = await new GitService().listWorktreeRecords(rootPath)
    const fields = raw.split('\0\0').map(group => group.split('\0').filter(Boolean))
      .find(group => {
        const path = group.find(field => field.startsWith('worktree '))?.slice(9)
        try { return path && realpathSync(path) === rootPath } catch { return false }
      })
    if (!fields) return evidence
    const field = (key: string) => fields.find(value => value.startsWith(key + ' '))?.slice(key.length + 1)
    evidence.status = 'GIT_WORKTREE'
    evidence.worktree = {
      rootPath, branch: field('branch')?.replace(/^refs\/heads\//, '') ?? null,
      head: field('HEAD')?.replace(/^0+$/, '') || null,
      detached: fields.includes('detached'), worktreeId: null
    }
  } catch (error) {
    const failure = error as { code?: number; stderr?: string }
    if (failure.code === 128 && failure.stderr?.includes('not a git repository')) evidence.status = 'NON_GIT'
  }
  return evidence
}

export async function findCanonicalWorktreeId(
  rootPath: string,
  repositories: ReadonlyArray<{ repositoryId: string; rootPath: string }>
): Promise<string | null> {
  const git = new GitService()
  try {
    const common = realpathSync(await git.getCommonDirectory(rootPath))
    for (const repository of repositories) {
      try {
        if (realpathSync(await git.getCommonDirectory(repository.rootPath)) !== common) continue
        const registry = new GitWorktreeRegistry(repository.rootPath, git, {
          repositoryId: repository.repositoryId, isActive: () => true
        })
        const { worktrees } = await registry.discover()
        return worktrees.find(record => !record.missing && !record.prunable && realpathSync(record.path) === rootPath)?.worktreeId ?? null
      } catch { continue }
    }
  } catch { return null }
  return null
}
