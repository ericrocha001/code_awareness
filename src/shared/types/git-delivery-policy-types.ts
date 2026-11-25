export type GitDeliveryMode = 'SUPERVISED' | 'AUTONOMOUS'

export interface GitDeliveryTrustGrant {
  mode: GitDeliveryMode
  commonIdentity: string
  allowedRemotes?: string[]
  revision: string
}

export interface GitDeliveryPolicy {
  mode: GitDeliveryMode
  revision: string
  rule: string
  allowedRemotes: string[]
}

export const GIT_DELIVERY_MODES: readonly GitDeliveryMode[] = ['SUPERVISED', 'AUTONOMOUS']
