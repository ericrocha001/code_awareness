import { RelayError, type InstallationId, type UserId } from "../../../src/shared/distribution/relay-protocol"
import type { Installation, InstallationRegistry } from "./installation-router"
import type { EnrollmentRegistry, PendingEnrollment } from "./enrollment-service"

export class MemoryInstallationRegistry implements InstallationRegistry, EnrollmentRegistry {
  private readonly rows = new Map<InstallationId, Installation>()
  private readonly pending = new Map<string, PendingEnrollment>()

  async get(id: InstallationId): Promise<Installation | null> {
    const row = this.rows.get(id)
    return row ? { ...row } : null
  }

  async listOwned(owner: UserId): Promise<Installation[]> {
    return [...this.rows.values()].filter((row) => row.ownerUserId === owner).map((row) => ({ ...row }))
  }

  async enroll(row: Installation): Promise<void> {
    if (this.rows.has(row.id)) throw new RelayError("FORBIDDEN")
    this.rows.set(row.id, {
      id: row.id,
      ownerUserId: row.ownerUserId,
      credentialHash: row.credentialHash,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      status: row.status
    })
  }

  async revoke(id: InstallationId, owner: UserId): Promise<void> {
    const row = this.owned(id, owner)
    row.status = "REVOKED"
  }

  async rotate(id: InstallationId, owner: UserId, credentialHash: string): Promise<void> {
    const row = this.owned(id, owner)
    if (row.status === "REVOKED") throw new RelayError("INSTALLATION_REVOKED")
    row.credentialHash = credentialHash
  }

  private owned(id: InstallationId, owner: UserId): Installation {
    const row = this.rows.get(id)
    if (!row || row.ownerUserId !== owner) throw new RelayError("FORBIDDEN")
    return row
  }

  async savePending(row: PendingEnrollment): Promise<void> {
    this.pending.set(row.enrollmentId, { ...row })
  }

  async getPending(enrollmentId: string): Promise<PendingEnrollment | null> {
    const p = this.pending.get(enrollmentId)
    return p ? { ...p } : null
  }

  async claimAtomic(enrollmentId: string, claimSecretHash: string, canonicalUserId: UserId, nowIso: string): Promise<Installation> {
    const p = this.pending.get(enrollmentId)
    if (!p) throw new RelayError("INVALID_MESSAGE")

    if (p.status === "CLAIMED") {
      if (p.claimedByUserId === canonicalUserId) {
        const inst = this.rows.get(p.installationId)
        if (inst) return { ...inst }
      }
      throw new RelayError("FORBIDDEN")
    }

    if (p.status === "EXPIRED" || new Date(p.expiresAt).getTime() <= new Date(nowIso).getTime()) {
      p.status = "EXPIRED"
      throw new RelayError("FORBIDDEN")
    }

    if (p.claimSecretHash !== claimSecretHash) {
      throw new RelayError("FORBIDDEN")
    }

    if (this.rows.has(p.installationId)) {
      throw new RelayError("FORBIDDEN")
    }

    const installation: Installation = {
      id: p.installationId,
      ownerUserId: canonicalUserId,
      credentialHash: p.credentialHash,
      createdAt: nowIso,
      lastSeenAt: null,
      status: "ACTIVE"
    }

    this.rows.set(installation.id, installation)
    p.status = "CLAIMED"
    p.claimedByUserId = canonicalUserId

    return { ...installation }
  }
}
