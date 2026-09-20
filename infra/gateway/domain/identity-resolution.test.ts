import { describe, expect, it } from 'vitest'
import type { UserId } from '../../../src/shared/distribution/relay-protocol'
import { MemoryExternalIdentityResolver } from '../testing/local-gateway'

describe('Canonical Identity Resolution', () => {
  const auth0Issuer = 'https://code-awareness.us.auth0.com/'
  const cloudflareIssuer = 'https://code-awareness.cloudflareaccess.com'
  const canonicalUserId = 'canonical-user-uuid-1' as UserId

  it('resolves different external identities from two providers to the same canonical user', async () => {
    const resolver = new MemoryExternalIdentityResolver()
    const nowIso = new Date().toISOString()

    await resolver.link({ issuer: auth0Issuer, subject: 'google-oauth2|104362835673150614751' }, canonicalUserId, nowIso)
    await resolver.link({ issuer: cloudflareIssuer, subject: 'cf-user-uuid-999' }, canonicalUserId, nowIso)

    const resolvedAuth0 = await resolver.resolve({ issuer: auth0Issuer, subject: 'google-oauth2|104362835673150614751' })
    const resolvedCloudflare = await resolver.resolve({ issuer: cloudflareIssuer, subject: 'cf-user-uuid-999' })

    expect(resolvedAuth0).toBe(canonicalUserId)
    expect(resolvedCloudflare).toBe(canonicalUserId)
    expect(resolvedAuth0).toBe(resolvedCloudflare)
  })

  it('isolates identical subject strings under different issuers as distinct identities', async () => {
    const resolver = new MemoryExternalIdentityResolver()
    const nowIso = new Date().toISOString()
    const userA = 'user-canonical-a' as UserId
    const userB = 'user-canonical-b' as UserId

    await resolver.link({ issuer: auth0Issuer, subject: 'shared-subject-id' }, userA, nowIso)
    await resolver.link({ issuer: cloudflareIssuer, subject: 'shared-subject-id' }, userB, nowIso)

    const resolvedAuth0 = await resolver.resolve({ issuer: auth0Issuer, subject: 'shared-subject-id' })
    const resolvedCloudflare = await resolver.resolve({ issuer: cloudflareIssuer, subject: 'shared-subject-id' })

    expect(resolvedAuth0).toBe(userA)
    expect(resolvedCloudflare).toBe(userB)
    expect(resolvedAuth0).not.toBe(resolvedCloudflare)
  })

  it('returns null for an unlinked external identity without creating a user implicitly', async () => {
    const resolver = new MemoryExternalIdentityResolver()

    const resolved = await resolver.resolve({ issuer: cloudflareIssuer, subject: 'unknown-user' })
    expect(resolved).toBeNull()
  })

  it('allows idempotent re-linking of the same identity to the same canonical user', async () => {
    const resolver = new MemoryExternalIdentityResolver()
    const nowIso = new Date().toISOString()

    await resolver.link({ issuer: cloudflareIssuer, subject: 'cf-subject' }, canonicalUserId, nowIso)
    await expect(resolver.link({ issuer: cloudflareIssuer, subject: 'cf-subject' }, canonicalUserId, nowIso)).resolves.not.toThrow()

    const resolved = await resolver.resolve({ issuer: cloudflareIssuer, subject: 'cf-subject' })
    expect(resolved).toBe(canonicalUserId)
  })

  it('rejects re-linking an existing identity to a different canonical user', async () => {
    const resolver = new MemoryExternalIdentityResolver()
    const nowIso = new Date().toISOString()
    const anotherUser = 'canonical-user-uuid-2' as UserId

    await resolver.link({ issuer: cloudflareIssuer, subject: 'cf-subject' }, canonicalUserId, nowIso)
    await expect(resolver.link({ issuer: cloudflareIssuer, subject: 'cf-subject' }, anotherUser, nowIso)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('creates a new canonical user and links identity on resolveOrCreate if unlinked', async () => {
    const resolver = new MemoryExternalIdentityResolver()
    const nowIso = new Date().toISOString()

    const createdId = await resolver.resolveOrCreate({ issuer: auth0Issuer, subject: 'new-auth0-user' }, nowIso)
    expect(createdId).toBeDefined()

    const resolved = await resolver.resolve({ issuer: auth0Issuer, subject: 'new-auth0-user' })
    expect(resolved).toBe(createdId)

    const secondCall = await resolver.resolveOrCreate({ issuer: auth0Issuer, subject: 'new-auth0-user' }, nowIso)
    expect(secondCall).toBe(createdId)
  })
})
