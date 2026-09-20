import { hashInstallationCredential } from "./installation-credential"
import { installationId, newInstallationId, RelayError, type InstallationId, type UserId } from "../../../src/shared/distribution/relay-protocol"
import type { AuthorizationProviderPort } from "../../../src/shared/distribution/authorization-ports"
import type { Installation, InstallationRegistry } from "./installation-router"
import type { ExternalIdentityResolverPort } from "./external-identity-resolver"

export const ENROLL_SCOPE = "code-awareness:enroll"

export interface PendingEnrollment {
  enrollmentId: string
  installationId: InstallationId
  credentialHash: string
  claimSecretHash: string
  createdAt: string
  expiresAt: string
  status: "PENDING" | "CLAIMED" | "EXPIRED"
  claimedByUserId?: UserId
}

export interface EnrollmentRegistry {
  savePending(pending: PendingEnrollment): Promise<void>
  getPending(enrollmentId: string): Promise<PendingEnrollment | null>
  claimAtomic(enrollmentId: string, claimSecretHash: string, canonicalUserId: UserId, nowIso: string): Promise<Installation>
}

export interface BeginEnrollmentInput {
  installationId: string
  credential: string
}

export interface BeginEnrollmentOutput {
  enrollmentId: string
  claimSecret: string
  expiresAt: string
  verificationUri: string
}

export interface ClaimEnrollmentInput {
  enrollmentId: string
  claimSecret: string
}

export interface EnrollmentStatusOutput {
  status: "PENDING" | "CLAIMED" | "EXPIRED"
}

export class EnrollmentService {
  constructor(
    private readonly enrollmentRegistry: EnrollmentRegistry,
    private readonly installationRegistry: InstallationRegistry,
    private readonly authorization: AuthorizationProviderPort,
    private readonly identityResolver: ExternalIdentityResolverPort,
    private readonly resource: string,
    private readonly ttlMs: number = 15 * 60 * 1000 // 15 min default
  ) {}

  async beginEnrollment(input: BeginEnrollmentInput, origin: string): Promise<BeginEnrollmentOutput> {
    if (!input || typeof input.installationId !== "string" || typeof input.credential !== "string") {
      throw new RelayError("INVALID_MESSAGE")
    }
    const instId = installationId(input.installationId)
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.credential)) {
      throw new RelayError("INVALID_CREDENTIAL")
    }

    const existing = await this.installationRegistry.get(instId)
    if (existing) {
      throw new RelayError("FORBIDDEN")
    }

    const credentialHash = await hashInstallationCredential(input.credential)
    const enrollmentId = newInstallationId()
    const claimSecret = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "")
    const claimSecretHash = await hashInstallationCredential(claimSecret)

    const now = new Date()
    const createdAt = now.toISOString()
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString()

    const pending: PendingEnrollment = {
      enrollmentId,
      installationId: instId,
      credentialHash,
      claimSecretHash,
      createdAt,
      expiresAt,
      status: "PENDING"
    }

    await this.enrollmentRegistry.savePending(pending)

    return {
      enrollmentId,
      claimSecret,
      expiresAt,
      verificationUri: `${origin}/enroll/${enrollmentId}`
    }
  }

  async claimEnrollment(token: string, input: ClaimEnrollmentInput): Promise<Installation> {
    if (!token || typeof token !== "string" || !input || typeof input.enrollmentId !== "string" || typeof input.claimSecret !== "string") {
      throw new RelayError("INVALID_MESSAGE")
    }

    const auth = await this.authorization.authorize(token, this.resource)
    if (!auth.scopes.includes(ENROLL_SCOPE)) {
      throw new RelayError("FORBIDDEN")
    }

    const claimSecretHash = await hashInstallationCredential(input.claimSecret)
    const nowIso = new Date().toISOString()
    const canonicalUserId = await this.identityResolver.resolveOrCreate({ issuer: auth.issuer, subject: auth.subject }, nowIso)

    return this.enrollmentRegistry.claimAtomic(input.enrollmentId, claimSecretHash, canonicalUserId, nowIso)
  }

  async getStatus(enrollmentId: string): Promise<EnrollmentStatusOutput> {
    if (!enrollmentId || typeof enrollmentId !== "string") {
      throw new RelayError("INVALID_MESSAGE")
    }
    const pending = await this.enrollmentRegistry.getPending(enrollmentId)
    if (!pending) {
      throw new RelayError("INVALID_MESSAGE")
    }

    if (pending.status === "PENDING" && new Date(pending.expiresAt).getTime() <= Date.now()) {
      return { status: "EXPIRED" }
    }

    return { status: pending.status }
  }
}
