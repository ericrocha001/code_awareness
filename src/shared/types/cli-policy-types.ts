export type CliMode = 'SUPERVISED' | 'AUTONOMOUS_CONSULTATIVE' | 'AUTONOMOUS_TRUSTED'

export interface CliTrustGrant {
  mode: CliMode
  checkoutIdentity: string
  revision: string
}

export interface CliPolicy {
  mode: CliMode
  revision: string
  rule: string
}

export const CLI_MODES: readonly CliMode[] = ['SUPERVISED', 'AUTONOMOUS_CONSULTATIVE', 'AUTONOMOUS_TRUSTED']
