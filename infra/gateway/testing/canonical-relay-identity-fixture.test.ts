import { describe, expect, it } from 'vitest'
import { RelayError, type InstallationId, type UserId } from '../../../src/shared/distribution/relay-protocol'
import { verifyInstallationCredential } from '../domain/installation-credential'
import { MemoryInstallationRegistry } from '../domain/memory-installation-registry'
import { MemoryExternalIdentityResolver } from './local-gateway'
import { provisionCanonicalRelayIdentity } from './canonical-relay-identity-fixture'

const issuer = 'https://fixture.cloudflareaccess.com'
const identity = (subject: string) => ({ issuer, subject })
const userId = (value: string) => value as UserId
const installationId = (value: string) => value as InstallationId

describe('canonical relay identity fixture', () => {
  it('links the external identity and enrolls an authenticating installation owned by the canonical user', async () => {
    const resolver = new MemoryExternalIdentityResolver()
    const registry = new MemoryInstallationRegistry()
    const explicit = {
      externalIdentity: identity('subject-a'),
      canonicalUserId: userId('canonical-a'),
      installationId: installationId('11111111-1111-4111-8111-111111111111'),
      credential: 'a'.repeat(43),
      nowIso: '2026-09-24T10:00:00.000Z'
    }

    const fixture = await provisionCanonicalRelayIdentity({
      identityResolver: resolver,
      installationRegistry: registry,
      ...explicit
    })

    expect(fixture).toMatchObject(explicit)
    expect(await resolver.resolve(explicit.externalIdentity)).toBe(explicit.canonicalUserId)
    expect(await registry.get(explicit.installationId)).toEqual(fixture.installation)
    expect(fixture.installation.ownerUserId).toBe(explicit.canonicalUserId)
    expect(await verifyInstallationCredential(explicit.credential, fixture.credentialHash)).toBe(true)
  })

  it('does not link another identity or create ownership implicitly', async () => {
    const resolver = new MemoryExternalIdentityResolver()
    const registry = new MemoryInstallationRegistry()
    const fixture = await provisionCanonicalRelayIdentity({
      identityResolver: resolver,
      installationRegistry: registry,
      externalIdentity: identity('subject-a'),
      canonicalUserId: userId('canonical-a')
    })

    expect(await resolver.resolve(identity('subject-b'))).toBeNull()
    expect(await registry.listOwned(userId('canonical-b'))).toEqual([])
    expect(await registry.listOwned(fixture.canonicalUserId)).toEqual([fixture.installation])
  })

  it('allows two installations for the same linked canonical user', async () => {
    const resolver = new MemoryExternalIdentityResolver()
    const registry = new MemoryInstallationRegistry()
    const shared = {
      identityResolver: resolver,
      installationRegistry: registry,
      externalIdentity: identity('subject-a'),
      canonicalUserId: userId('canonical-a')
    }
    const first = await provisionCanonicalRelayIdentity({
      ...shared,
      installationId: installationId('11111111-1111-4111-8111-111111111111'),
      credential: 'a'.repeat(43)
    })
    const second = await provisionCanonicalRelayIdentity({
      ...shared,
      installationId: installationId('22222222-2222-4222-8222-222222222222'),
      credential: 'b'.repeat(43)
    })

    expect(await registry.listOwned(shared.canonicalUserId)).toEqual([first.installation, second.installation])
  })

  it('preserves resolver and registry conflicts on repeated provisioning', async () => {
    const resolver = new MemoryExternalIdentityResolver()
    const registry = new MemoryInstallationRegistry()
    const options = {
      identityResolver: resolver,
      installationRegistry: registry,
      externalIdentity: identity('subject-a'),
      canonicalUserId: userId('canonical-a'),
      installationId: installationId('11111111-1111-4111-8111-111111111111'),
      credential: 'a'.repeat(43)
    }
    await provisionCanonicalRelayIdentity(options)

    await expect(provisionCanonicalRelayIdentity(options)).rejects.toMatchObject<Partial<RelayError>>({ code: 'FORBIDDEN' })
    await expect(provisionCanonicalRelayIdentity({
      ...options,
      canonicalUserId: userId('canonical-b'),
      installationId: installationId('22222222-2222-4222-8222-222222222222')
    })).rejects.toMatchObject<Partial<RelayError>>({ code: 'FORBIDDEN' })
  })
})
