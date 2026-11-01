import { createHash, randomUUID } from 'node:crypto'
import { realpathSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { CliMode, CliPolicy } from '../../shared/types/cli-policy-types'
import { CLI_MODES } from '../../shared/types/cli-policy-types'
import type { SettingsService } from '../core/settings-service'

export function cliCheckoutIdentity(repositoryId: string, root: string): string {
  const physical = realpathSync(root)
  const identity = (path: string) => { const stat = statSync(path, { bigint: true }); return [realpathSync(path), String(stat.dev), String(stat.ino), String(stat.birthtimeNs)] }
  const pointer = join(physical, '.git')
  let git: unknown = null
  if (existsSync(pointer)) {
    if (statSync(pointer).size > 65536) throw new Error('CHECKOUT_IDENTITY_UNAVAILABLE')
    const admin = statSync(pointer).isDirectory() ? realpathSync(pointer) : (() => {
      const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(readFileSync(pointer, 'utf8'))
      if (!match) throw new Error('CHECKOUT_IDENTITY_UNAVAILABLE')
      return realpathSync(resolve(physical, match[1]))
    })()
    const commonPointer = join(admin, 'commondir')
    if (existsSync(commonPointer) && statSync(commonPointer).size > 65536) throw new Error('CHECKOUT_IDENTITY_UNAVAILABLE')
    const common = existsSync(commonPointer) ? realpathSync(resolve(admin, readFileSync(commonPointer, 'utf8').trim())) : admin
    git = [identity(admin), identity(common)]
  }
  return createHash('sha256').update(JSON.stringify([repositoryId, identity(physical), git])).digest('hex')
}

export interface CliLocalContext { repositoryId: string; path: string; revision: number }

export class CliTrustPolicy {
  private choiceRevision = 0
  constructor(private readonly settings: Pick<SettingsService, 'loadSettings' | 'setLocalCliTrust'>,
    private readonly context: () => CliLocalContext | null,
    private readonly confirm: (mode: CliMode, context: CliLocalContext) => Promise<boolean>) {}

  getPolicy(expected?: { repositoryId: string | null; path: string }): CliPolicy {
    const supervised: CliPolicy = { mode: 'SUPERVISED', revision: 'untrusted', rule: 'native-command-consent' }
    const context = this.context()
    if (!context) return supervised
    try {
      if (expected && (expected.repositoryId !== context.repositoryId || realpathSync(expected.path) !== realpathSync(context.path))) return supervised
    } catch { return { ...supervised, revision: 'checkout-unavailable' } }
    const grant = this.settings.loadSettings().cliAutonomy?.[context.repositoryId]
    if (!grant || !CLI_MODES.includes(grant.mode) || typeof grant.revision !== 'string') return supervised
    try {
      if (cliCheckoutIdentity(context.repositoryId, context.path) !== grant.checkoutIdentity) return { ...supervised, revision: `invalid:${grant.revision}` }
    } catch { return { ...supervised, revision: `invalid:${grant.revision}` } }
    return { mode: grant.mode, revision: grant.revision, rule: grant.mode === 'AUTONOMOUS_CONSULTATIVE' ? 'windows-system-metadata-v1' : grant.mode === 'AUTONOMOUS_TRUSTED' ? 'local-repository-trust' : supervised.rule }
  }

  async choose(mode: CliMode): Promise<boolean> {
    const choice = ++this.choiceRevision
    if (!CLI_MODES.includes(mode)) throw new Error('INVALID_CLI_MODE')
    const context = this.context()
    if (!context) throw new Error('CHECKOUT_IDENTITY_UNAVAILABLE')
    if (mode !== 'SUPERVISED' && this.settings.loadSettings().cliExecutionEnabled !== true) throw new Error('CLI_EXECUTION_DISABLED')
    const identity = cliCheckoutIdentity(context.repositoryId, context.path)
    const previous = JSON.stringify(this.settings.loadSettings().cliAutonomy?.[context.repositoryId])
    if (mode !== 'SUPERVISED' && !await this.confirm(mode, context)) return false
    const current = this.context()
    if (choice !== this.choiceRevision || previous !== JSON.stringify(this.settings.loadSettings().cliAutonomy?.[context.repositoryId]) ||
      mode !== 'SUPERVISED' && this.settings.loadSettings().cliExecutionEnabled !== true) throw new Error('POLICY_CHANGED')
    if (!current || current.repositoryId !== context.repositoryId || current.revision !== context.revision ||
      cliCheckoutIdentity(current.repositoryId, current.path) !== identity) throw new Error('PROJECT_CONTEXT_CHANGED')
    this.settings.setLocalCliTrust(context.repositoryId, { mode, checkoutIdentity: identity, revision: randomUUID() })
    return true
  }
}
