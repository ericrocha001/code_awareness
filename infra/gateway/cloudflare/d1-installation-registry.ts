import { RelayError, type InstallationId, type UserId } from '../../../src/shared/distribution/relay-protocol'
import type { Installation, InstallationRegistry } from '../domain/installation-router'
import type { EnrollmentRegistry, PendingEnrollment } from '../domain/enrollment-service'
 
const columns = 'id, owner_user_id AS ownerUserId, credential_hash AS credentialHash, created_at AS createdAt, last_seen_at AS lastSeenAt, status'
 
export class D1InstallationRegistry implements InstallationRegistry, EnrollmentRegistry {
  constructor(private readonly database: D1Database) {}
 
  get(id: InstallationId): Promise<Installation | null> {
    return this.database.prepare(`SELECT ${columns} FROM installations WHERE id = ?`).bind(id).first<Installation>()
  }
 
  async listOwned(owner: UserId): Promise<Installation[]> {
    return (await this.database.prepare(`SELECT ${columns} FROM installations WHERE owner_user_id = ?`).bind(owner).all<Installation>()).results
  }
 
  async enroll(row: Installation): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(row.credentialHash)) throw new RelayError('INVALID_CREDENTIAL')
    await this.database.batch([
      this.database.prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').bind(row.ownerUserId, row.createdAt),
      this.database.prepare('INSERT INTO installations (id, owner_user_id, credential_hash, created_at, last_seen_at, status) VALUES (?, ?, ?, ?, ?, ?)').bind(row.id, row.ownerUserId, row.credentialHash, row.createdAt, row.lastSeenAt, row.status)
    ])
  }
 
  async revoke(id: InstallationId, owner: UserId): Promise<void> {
    const result = await this.database.prepare("UPDATE installations SET status = 'REVOKED' WHERE id = ? AND owner_user_id = ?").bind(id, owner).run()
    if (result.meta.changes !== 1) throw new RelayError('FORBIDDEN')
  }
 
  async rotate(id: InstallationId, owner: UserId, hash: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new RelayError('INVALID_CREDENTIAL')
    const result = await this.database.prepare("UPDATE installations SET credential_hash = ? WHERE id = ? AND owner_user_id = ? AND status = 'ACTIVE'").bind(hash, id, owner).run()
    if (result.meta.changes !== 1) throw new RelayError('FORBIDDEN')
  }
 
  async savePending(pending: PendingEnrollment): Promise<void> {
    await this.database.prepare('INSERT INTO pending_enrollments (enrollment_id, installation_id, credential_hash, claim_secret_hash, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
      pending.enrollmentId,
      pending.installationId,
      pending.credentialHash,
      pending.claimSecretHash,
      pending.createdAt,
      pending.expiresAt,
      pending.status
    ).run()
  }
 
  async getPending(enrollmentId: string): Promise<PendingEnrollment | null> {
    const row = await this.database.prepare('SELECT enrollment_id AS enrollmentId, installation_id AS installationId, credential_hash AS credentialHash, claim_secret_hash AS claimSecretHash, created_at AS createdAt, expires_at AS expiresAt, status, claimed_by_user_id AS claimedByUserId FROM pending_enrollments WHERE enrollment_id = ?').bind(enrollmentId).first<PendingEnrollment>()
    return row ?? null
  }
 
  async claimAtomic(enrollmentId: string, claimSecretHash: string, canonicalUserId: UserId, nowIso: string): Promise<Installation> {
    const pending = await this.getPending(enrollmentId)
    if (!pending) throw new RelayError('INVALID_MESSAGE')
 
    if (pending.status === 'CLAIMED') {
      if (pending.claimedByUserId === canonicalUserId) {
        const existing = await this.get(pending.installationId)
        if (existing) return existing
      }
      throw new RelayError('FORBIDDEN')
    }
 
    if (pending.status === 'EXPIRED' || new Date(pending.expiresAt).getTime() <= new Date(nowIso).getTime()) {
      await this.database.prepare("UPDATE pending_enrollments SET status = 'EXPIRED' WHERE enrollment_id = ?").bind(enrollmentId).run()
      throw new RelayError('FORBIDDEN')
    }
 
    if (pending.claimSecretHash !== claimSecretHash) {
      throw new RelayError('FORBIDDEN')
    }
 
    const claimUpdate = await this.database.prepare("UPDATE pending_enrollments SET status = 'CLAIMED', claimed_by_user_id = ? WHERE enrollment_id = ? AND status = 'PENDING' AND expires_at > ?").bind(canonicalUserId, enrollmentId, nowIso).run()
    if (claimUpdate.meta.changes !== 1) {
      const refreshed = await this.getPending(enrollmentId)
      if (refreshed?.status === 'CLAIMED' && refreshed?.claimedByUserId === canonicalUserId) {
        const existing = await this.get(pending.installationId)
        if (existing) return existing
      }
      throw new RelayError('FORBIDDEN')
    }
 
    try {
      await this.database.batch([
        this.database.prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').bind(canonicalUserId, nowIso),
        this.database.prepare('INSERT INTO installations (id, owner_user_id, credential_hash, created_at, last_seen_at, status) VALUES (?, ?, ?, ?, ?, ?)').bind(pending.installationId, canonicalUserId, pending.credentialHash, nowIso, null, 'ACTIVE')
      ])
    } catch {
      throw new RelayError('FORBIDDEN')
    }
 
    return {
      id: pending.installationId,
      ownerUserId: canonicalUserId,
      credentialHash: pending.credentialHash,
      createdAt: nowIso,
      lastSeenAt: null,
      status: 'ACTIVE'
    }
  }
}
