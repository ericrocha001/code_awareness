import type { UserId } from '../../../src/shared/distribution/relay-protocol'

export interface VerifiedExternalIdentity {
  issuer: string
  subject: string
}

export interface ExternalIdentityResolverPort {
  resolve(identity: VerifiedExternalIdentity): Promise<UserId | null>
  resolveOrCreate(identity: VerifiedExternalIdentity, nowIso: string): Promise<UserId>
  link(identity: VerifiedExternalIdentity, canonicalUserId: UserId, nowIso: string): Promise<void>
}
