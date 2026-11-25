import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { GitDeliveryMode, GitDeliveryPolicy, GitDeliveryTrustGrant } from '../../shared/types/git-delivery-policy-types'
import { GIT_DELIVERY_MODES } from '../../shared/types/git-delivery-policy-types'
import { cliGitCommonIdentity } from '../cli-execution/cli-trust-policy'
import type { SettingsService } from '../core/settings-service'

export interface GitDeliveryLocalContext {
  repositoryId: string
  path: string
  revision: number
}

const DEFAULT_ALLOWED_REMOTES = ['origin']

export class GitDeliveryTrustPolicy {
  private choiceRevision = 0

  constructor(
    private readonly settings: Pick<SettingsService, 'loadSettings' | 'setLocalGitDeliveryTrust'>,
    private readonly context: () => GitDeliveryLocalContext | null,
    private readonly confirm?: (context: GitDeliveryLocalContext) => Promise<boolean>
  ) {}

  getPolicy(expected?: { repositoryId: string | null; path: string }): GitDeliveryPolicy {
    const supervised: GitDeliveryPolicy = {
      mode: 'SUPERVISED',
      revision: 'untrusted',
      rule: 'native-operation-consent',
      allowedRemotes: []
    }
    const context = this.context()
    if (!context) return supervised
    if (expected && expected.repositoryId !== context.repositoryId) return supervised

    let currentCommon: string
    try {
      currentCommon = cliGitCommonIdentity(context.repositoryId, context.path, { verifyWorktreeBackpointer: true })
      if (expected) {
        const expectedPhysical = realpathSync(expected.path)
        if (cliGitCommonIdentity(context.repositoryId, expectedPhysical, { verifyWorktreeBackpointer: true }) !== currentCommon) {
          return { ...supervised, revision: 'checkout-unavailable' }
        }
      }
    } catch {
      return expected ? { ...supervised, revision: 'checkout-unavailable' } : { ...supervised, revision: 'untrusted' }
    }

    const grant = this.settings.loadSettings().gitDeliveryAutonomy?.[context.repositoryId]
    if (!grant) {
      return {
        mode: 'AUTONOMOUS',
        revision: 'default',
        rule: 'local-repository-git-delivery-default',
        allowedRemotes: [...DEFAULT_ALLOWED_REMOTES]
      }
    }
    if (!GIT_DELIVERY_MODES.includes(grant.mode) || typeof grant.revision !== 'string' || !grant.revision) {
      return { ...supervised, revision: `invalid:${String(grant.revision ?? '')}` }
    }
    if (typeof grant.commonIdentity !== 'string' || grant.commonIdentity !== currentCommon) {
      return { ...supervised, revision: `invalid:${grant.revision}` }
    }
    if (grant.mode === 'SUPERVISED') {
      return { ...supervised, revision: grant.revision }
    }
    const allowedRemotes = Array.isArray(grant.allowedRemotes) && grant.allowedRemotes.length
      ? grant.allowedRemotes.filter((remote): remote is string => typeof remote === 'string' && remote.length > 0)
      : [...DEFAULT_ALLOWED_REMOTES]
    return {
      mode: 'AUTONOMOUS',
      revision: grant.revision,
      rule: 'local-repository-git-delivery-trust',
      allowedRemotes: allowedRemotes.length ? allowedRemotes : [...DEFAULT_ALLOWED_REMOTES]
    }
  }

  async choose(mode: GitDeliveryMode): Promise<boolean> {
    const choice = ++this.choiceRevision
    if (!GIT_DELIVERY_MODES.includes(mode)) throw new Error('INVALID_GIT_DELIVERY_MODE')
    const context = this.context()
    if (!context) throw new Error('WORKTREE_IDENTITY_UNAVAILABLE')
    const commonIdentity = cliGitCommonIdentity(context.repositoryId, context.path, { verifyWorktreeBackpointer: true })
    const previous = JSON.stringify(this.settings.loadSettings().gitDeliveryAutonomy?.[context.repositoryId])
    if (mode === 'AUTONOMOUS' && this.confirm && !await this.confirm(context)) return false
    const current = this.context()
    if (choice !== this.choiceRevision || previous !== JSON.stringify(this.settings.loadSettings().gitDeliveryAutonomy?.[context.repositoryId])) {
      throw new Error('POLICY_CHANGED')
    }
    if (!current || current.repositoryId !== context.repositoryId || current.revision !== context.revision ||
      cliGitCommonIdentity(current.repositoryId, current.path, { verifyWorktreeBackpointer: true }) !== commonIdentity) {
      throw new Error('PROJECT_CONTEXT_CHANGED')
    }
    const grant: GitDeliveryTrustGrant = {
      mode,
      commonIdentity,
      ...(mode === 'AUTONOMOUS' ? { allowedRemotes: [...DEFAULT_ALLOWED_REMOTES] } : {}),
      revision: randomUUID()
    }
    this.settings.setLocalGitDeliveryTrust(context.repositoryId, grant)
    return true
  }
}
