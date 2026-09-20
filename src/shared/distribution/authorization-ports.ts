import type { InstallationId, UserId } from './relay-protocol'

export interface AuthenticatedPrincipal { id: UserId }
export interface AuthenticatedUser extends AuthenticatedPrincipal { scopes: readonly string[] }

export interface ExternallyVerifiedAuthorization {
  issuer: string
  subject: string
  scopes: readonly string[]
}

export interface AuthorizationProviderPort {
  authorize(accessToken: string, resource: string): Promise<ExternallyVerifiedAuthorization>
}

export type EnrollmentState =
  | { status: 'UNENROLLED' | 'REVOKED' }
  | { status: 'PENDING'; verificationUri: string; expiresAt: string }
  | { status: 'ENROLLED'; installationId: InstallationId }

export interface InstallationEnrollmentPort {
  enroll(): Promise<EnrollmentState>
  revoke(): Promise<void>
  rotateCredential(): Promise<void>
  getEnrollmentState(): Promise<EnrollmentState>
}
