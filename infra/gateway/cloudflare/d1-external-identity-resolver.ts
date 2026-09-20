import { RelayError, type UserId } from '../../../src/shared/distribution/relay-protocol'
import type { ExternalIdentityResolverPort, VerifiedExternalIdentity } from '../domain/external-identity-resolver'

export class D1ExternalIdentityResolver implements ExternalIdentityResolverPort {
  constructor(private readonly database: D1Database) {}

  async resolve(identity: VerifiedExternalIdentity): Promise<UserId | null> {
    const row = await this.database
      .prepare('SELECT user_id AS userId FROM external_identities WHERE issuer = ? AND subject = ?')
      .bind(identity.issuer, identity.subject)
      .first<{ userId: string }>()
    return (row?.userId as UserId) ?? null
  }

  async resolveOrCreate(identity: VerifiedExternalIdentity, nowIso: string): Promise<UserId> {
    const existing = await this.resolve(identity)
    if (existing) return existing

    const newUserId = crypto.randomUUID() as UserId

    await this.database.batch([
      this.database.prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').bind(newUserId, nowIso),
      this.database.prepare('INSERT OR IGNORE INTO external_identities (issuer, subject, user_id, created_at) VALUES (?, ?, ?, ?)').bind(identity.issuer, identity.subject, newUserId, nowIso)
    ])

    const resolved = await this.resolve(identity)
    if (!resolved) throw new RelayError('FORBIDDEN')
    return resolved
  }

  async link(identity: VerifiedExternalIdentity, canonicalUserId: UserId, nowIso: string): Promise<void> {
    const userRow = await this.database
      .prepare('SELECT id FROM users WHERE id = ?')
      .bind(canonicalUserId)
      .first<{ id: string }>()
    if (!userRow) throw new RelayError('FORBIDDEN')

    const existing = await this.resolve(identity)
    if (existing) {
      if (existing === canonicalUserId) return
      throw new RelayError('FORBIDDEN')
    }

    try {
      await this.database
        .prepare('INSERT INTO external_identities (issuer, subject, user_id, created_at) VALUES (?, ?, ?, ?)')
        .bind(identity.issuer, identity.subject, canonicalUserId, nowIso)
        .run()
    } catch {
      const recheck = await this.resolve(identity)
      if (recheck === canonicalUserId) return
      throw new RelayError('FORBIDDEN')
    }
  }
}
