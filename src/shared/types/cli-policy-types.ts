export type CliMode = 'SUPERVISED' | 'AUTONOMOUS_CONSULTATIVE' | 'AUTONOMOUS_TRUSTED'
export type CliTrustScope = 'ACTIVE_CHECKOUT_ONLY' | 'REPOSITORY_WORKTREES'

export interface CliTrustGrant {
  mode: CliMode
  scope?: CliTrustScope
  checkoutIdentity: string
  commonIdentity?: string
  revision: string
}

export interface CliPolicy {
  mode: CliMode
  scope?: CliTrustScope
  revision: string
  rule: string
}

export const CLI_MODES: readonly CliMode[] = ['SUPERVISED', 'AUTONOMOUS_CONSULTATIVE', 'AUTONOMOUS_TRUSTED']
export const CLI_TRUST_SCOPES: readonly CliTrustScope[] = ['ACTIVE_CHECKOUT_ONLY', 'REPOSITORY_WORKTREES']
