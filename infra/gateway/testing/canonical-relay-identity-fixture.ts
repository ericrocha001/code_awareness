import { randomBytes } from 'node:crypto'
import { hashInstallationCredential } from '../domain/installation-credential'
import type { Installation, InstallationRegistry } from '../domain/installation-router'
import type { ExternalIdentityResolverPort, VerifiedExternalIdentity } from '../domain/external-identity-resolver'
import { newInstallationId, type InstallationId, type UserId } from '../../../src/shared/distribution/relay-protocol'

export interface CanonicalRelayIdentityFixtureOptions {
  identityResolver: ExternalIdentityResolverPort
  installationRegistry: InstallationRegistry
  externalIdentity?: VerifiedExternalIdentity
  canonicalUserId?: UserId
  installationId?: InstallationId
  credential?: string
  nowIso?: string
}

export interface CanonicalRelayIdentityFixture {
  externalIdentity: VerifiedExternalIdentity
  canonicalUserId: UserId
  installationId: InstallationId
  credential: string
  credentialHash: string
  nowIso: string
  installation: Installation
}

export async function provisionCanonicalRelayIdentity(
  options: CanonicalRelayIdentityFixtureOptions
): Promise<CanonicalRelayIdentityFixture> {
  const externalIdentity = options.externalIdentity ?? {
    issuer: 'https://test.cloudflareaccess.com',
    subject: 'relay-test-subject'
  }
  const canonicalUserId = options.canonicalUserId ?? 'relay-test-user' as UserId
  const installationId = options.installationId ?? newInstallationId()
  const credential = options.credential ?? randomBytes(32).toString('base64url')
  const nowIso = options.nowIso ?? new Date().toISOString()

  await options.identityResolver.link(externalIdentity, canonicalUserId, nowIso)
  const credentialHash = await hashInstallationCredential(credential)
  const installation: Installation = {
    id: installationId,
    ownerUserId: canonicalUserId,
    credentialHash,
    createdAt: nowIso,
    lastSeenAt: null,
    status: 'ACTIVE'
  }
  await options.installationRegistry.enroll(installation)

  return {
    externalIdentity,
    canonicalUserId,
    installationId,
    credential,
    credentialHash,
    nowIso,
    installation
  }
}
