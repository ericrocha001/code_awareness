import { createHash, randomUUID } from 'node:crypto'
import { realpathSync, statSync, readFileSync, existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { CliMode, CliPolicy, CliTrustGrant, CliTrustScope } from '../../shared/types/cli-policy-types'
import { CLI_MODES, CLI_TRUST_SCOPES } from '../../shared/types/cli-policy-types'
import type { SettingsService } from '../core/settings-service'

function statIdentity(path: string): [string, string, string, string] {
  const canonical = realpathSync(path)
  const stat = statSync(canonical, { bigint: true })
  return [canonical, String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]
}

function resolveGitDirectories(physical: string): { admin: string; common: string; pointer: string } | null {
  const pointer = join(physical, '.git')
  if (!existsSync(pointer)) return null
  const pointerStat = statSync(pointer)
  if (pointerStat.size > 65536) throw new Error('CHECKOUT_IDENTITY_UNAVAILABLE')
  const admin = pointerStat.isDirectory() ? realpathSync(pointer) : (() => {
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(readFileSync(pointer, 'utf8'))
    if (!match) throw new Error('CHECKOUT_IDENTITY_UNAVAILABLE')
    return realpathSync(resolve(physical, match[1]))
  })()
  const commonPointer = join(admin, 'commondir')
  if (existsSync(commonPointer) && statSync(commonPointer).size > 65536) throw new Error('CHECKOUT_IDENTITY_UNAVAILABLE')
  const common = existsSync(commonPointer) ? realpathSync(resolve(admin, readFileSync(commonPointer, 'utf8').trim())) : admin
  return { admin, common, pointer }
}

export function cliCheckoutIdentity(repositoryId: string, root: string): string {
  const physical = realpathSync(root)
  const dirs = resolveGitDirectories(physical)
  const git = dirs ? [statIdentity(dirs.admin), statIdentity(dirs.common)] : null
  return createHash('sha256').update(JSON.stringify([repositoryId, statIdentity(physical), git])).digest('hex')
}

export function cliGitCommonIdentity(repositoryId: string, root: string, options?: { verifyWorktreeBackpointer?: boolean }): string {
  const physical = realpathSync(root)
  const dirs = resolveGitDirectories(physical)
  if (!dirs) throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
  if (options?.verifyWorktreeBackpointer) {
    if (dirs.admin === dirs.common) {
      if (realpathSync(dirs.pointer) !== join(physical, '.git') || !existsSync(join(dirs.common, 'HEAD'))) {
        throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
      }
    } else {
      const worktreesDir = realpathSync(dirname(dirs.admin))
      if (basename(worktreesDir) !== 'worktrees' || realpathSync(dirname(worktreesDir)) !== dirs.common) {
        throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
      }
      const gitdirBackpointer = join(dirs.admin, 'gitdir')
      if (!existsSync(gitdirBackpointer) || statSync(gitdirBackpointer).size > 65536) {
        throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
      }
      const resolvedPointer = realpathSync(resolve(dirs.admin, readFileSync(gitdirBackpointer, 'utf8').trim()))
      if (resolvedPointer !== realpathSync(dirs.pointer)) {
        throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
      }
    }
  }
  return createHash('sha256').update(JSON.stringify([repositoryId, statIdentity(dirs.common)])).digest('hex')
}

export interface CliLocalContext { repositoryId: string; path: string; revision: number }

export class CliTrustPolicy {
  private choiceRevision = 0
  constructor(private readonly settings: Pick<SettingsService, 'loadSettings' | 'setLocalCliTrust'>,
    private readonly context: () => CliLocalContext | null,
    private readonly confirm: (mode: CliMode, context: CliLocalContext, scope: CliTrustScope) => Promise<boolean>) {}

  getPolicy(expected?: { repositoryId: string | null; path: string }): CliPolicy {
    const supervised: CliPolicy = { mode: 'SUPERVISED', scope: 'ACTIVE_CHECKOUT_ONLY', revision: 'untrusted', rule: 'native-command-consent' }
    const context = this.context()
    if (!context) return supervised
    if (expected && expected.repositoryId !== context.repositoryId) return supervised
    const grant = this.settings.loadSettings().cliAutonomy?.[context.repositoryId]
    if (!grant || !CLI_MODES.includes(grant.mode) || typeof grant.revision !== 'string') return supervised
    const scope: CliTrustScope = grant.scope === undefined ? 'ACTIVE_CHECKOUT_ONLY' : grant.scope
    if (!CLI_TRUST_SCOPES.includes(scope)) return { ...supervised, revision: `invalid:${grant.revision}` }
    if (scope === 'REPOSITORY_WORKTREES' && (grant.mode !== 'AUTONOMOUS_TRUSTED' || typeof grant.commonIdentity !== 'string' || !grant.commonIdentity)) {
      return { ...supervised, revision: `invalid:${grant.revision}` }
    }
    try {
      if (cliCheckoutIdentity(context.repositoryId, context.path) !== grant.checkoutIdentity) {
        return { ...supervised, revision: `invalid:${grant.revision}` }
      }
      if (scope === 'REPOSITORY_WORKTREES' && cliGitCommonIdentity(context.repositoryId, context.path, { verifyWorktreeBackpointer: true }) !== grant.commonIdentity) {
        return { ...supervised, revision: `invalid:${grant.revision}` }
      }
      if (expected) {
        const expectedPhysical = realpathSync(expected.path)
        const contextPhysical = realpathSync(context.path)
        if (expectedPhysical !== contextPhysical) {
          if (grant.mode !== 'AUTONOMOUS_TRUSTED' || scope !== 'REPOSITORY_WORKTREES' || !grant.commonIdentity) {
            return supervised
          }
          if (cliGitCommonIdentity(context.repositoryId, expectedPhysical, { verifyWorktreeBackpointer: true }) !== grant.commonIdentity) {
            return { ...supervised, revision: `invalid:${grant.revision}` }
          }
        }
      }
    } catch { return expected ? { ...supervised, revision: 'checkout-unavailable' } : { ...supervised, revision: `invalid:${grant.revision}` } }
    const effectiveScope: CliTrustScope = grant.mode === 'AUTONOMOUS_TRUSTED' ? scope : 'ACTIVE_CHECKOUT_ONLY'
    return {
      mode: grant.mode,
      scope: effectiveScope,
      revision: grant.revision,
      rule: grant.mode === 'AUTONOMOUS_CONSULTATIVE'
        ? 'windows-system-metadata-v1'
        : grant.mode === 'AUTONOMOUS_TRUSTED'
          ? (effectiveScope === 'REPOSITORY_WORKTREES' ? 'local-repository-worktree-trust' : 'local-repository-trust')
          : supervised.rule
    }
  }

  async choose(mode: CliMode, scope?: CliTrustScope): Promise<boolean> {
    const choice = ++this.choiceRevision
    if (!CLI_MODES.includes(mode)) throw new Error('INVALID_CLI_MODE')
    const requestedScope: CliTrustScope = scope ?? 'ACTIVE_CHECKOUT_ONLY'
    if (!CLI_TRUST_SCOPES.includes(requestedScope)) throw new Error('INVALID_CLI_SCOPE')
    if (requestedScope === 'REPOSITORY_WORKTREES' && mode !== 'AUTONOMOUS_TRUSTED') throw new Error('INVALID_CLI_SCOPE')
    const effectiveScope: CliTrustScope = mode === 'SUPERVISED' ? 'ACTIVE_CHECKOUT_ONLY' : requestedScope
    const context = this.context()
    if (!context) throw new Error('CHECKOUT_IDENTITY_UNAVAILABLE')
    if (mode !== 'SUPERVISED' && this.settings.loadSettings().cliExecutionEnabled !== true) throw new Error('CLI_EXECUTION_DISABLED')
    const identity = cliCheckoutIdentity(context.repositoryId, context.path)
    const commonIdentity = effectiveScope === 'REPOSITORY_WORKTREES'
      ? cliGitCommonIdentity(context.repositoryId, context.path, { verifyWorktreeBackpointer: true })
      : (() => {
          try { return cliGitCommonIdentity(context.repositoryId, context.path) } catch { return undefined }
        })()
    const previous = JSON.stringify(this.settings.loadSettings().cliAutonomy?.[context.repositoryId])
    if (mode !== 'SUPERVISED' && !await this.confirm(mode, context, effectiveScope)) return false
    const current = this.context()
    if (choice !== this.choiceRevision || previous !== JSON.stringify(this.settings.loadSettings().cliAutonomy?.[context.repositoryId]) ||
      mode !== 'SUPERVISED' && this.settings.loadSettings().cliExecutionEnabled !== true) throw new Error('POLICY_CHANGED')
    if (!current || current.repositoryId !== context.repositoryId || current.revision !== context.revision ||
      cliCheckoutIdentity(current.repositoryId, current.path) !== identity ||
      (effectiveScope === 'REPOSITORY_WORKTREES' && cliGitCommonIdentity(current.repositoryId, current.path, { verifyWorktreeBackpointer: true }) !== commonIdentity)) {
      throw new Error('PROJECT_CONTEXT_CHANGED')
    }
    const grant: CliTrustGrant = {
      mode,
      scope: effectiveScope,
      checkoutIdentity: identity,
      ...(commonIdentity ? { commonIdentity } : {}),
      revision: randomUUID()
    }
    this.settings.setLocalCliTrust(context.repositoryId, grant)
    return true
  }
}
