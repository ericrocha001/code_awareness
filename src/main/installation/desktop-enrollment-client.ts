import type { EnrollmentState, InstallationEnrollmentPort } from "../../shared/distribution/authorization-ports"
import { InstallationIdentityService } from "./installation-identity-service"

export class DesktopEnrollmentClient implements InstallationEnrollmentPort {
  constructor(
    private readonly gatewayUrl: string,
    private readonly identity: InstallationIdentityService
  ) {}

  async enroll(): Promise<EnrollmentState> {
    const installationId = this.identity.getId()
    let credential = this.identity.getCredential()
    if (!credential) {
      this.identity.rotateCredential()
      credential = this.identity.getCredential()
    }
    if (!credential) {
      throw new Error("INSTALLATION_CREDENTIAL_UNAVAILABLE")
    }

    const res = await fetch(`${this.gatewayUrl}/enroll/begin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installationId, credential })
    })

    if (!res.ok) {
      if (res.status === 403) return { status: "REVOKED" }
      throw new Error(`ENROLLMENT_FAILED: ${res.status}`)
    }

    const data = await res.json() as { enrollmentId: string; verificationUri: string; expiresAt: string }
    return {
      status: "PENDING",
      verificationUri: data.verificationUri,
      expiresAt: data.expiresAt
    }
  }

  async getEnrollmentState(): Promise<EnrollmentState> {
    const id = this.identity.getId()
    return { status: "ENROLLED", installationId: id }
  }

  async revoke(): Promise<void> {
    this.identity.clearCredential()
  }

  async rotateCredential(): Promise<void> {
    this.identity.rotateCredential()
  }
}
