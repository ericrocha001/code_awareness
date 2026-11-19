export type ExtensionOperationAction = 'BUILD' | 'RELOAD' | 'UPDATE'

export type ExtensionOperationState =
  | 'PENDING'
  | 'BUILDING'
  | 'STAGED'
  | 'WAITING_BROWSER'
  | 'WAITING_IDLE'
  | 'PROMOTING'
  | 'PROMOTED'
  | 'RELOADING'
  | 'REINJECTING'
  | 'VERIFIED'
  | 'PARTIAL'
  | 'NOT_ATTESTED'
  | 'EXPIRED'
  | 'FAILED'

export interface ManagedInstallationEnrollment {
  schemaVersion: 1
  enrollmentId: string
  installationId: string
  extensionId: string
  allowedOrigin: string
  installType: 'development'
  profileId: string
  profileLabel?: string
  unpackedPath: string
  hostInstallDir: string
  hostScriptPath: string
  sourceRepoPath: string
  nativeHostApplication: string
  enabled: boolean
  enrolledAt: string
  updatedAt: string
  revokedAt?: string | null
}

export interface EnrollManagedInstallationInput {
  installationId?: string
  extensionId: string
  installType?: 'development' | string
  profileId: string
  profileLabel?: string
  unpackedPath: string
  hostInstallDir: string
  hostScriptPath: string
  sourceRepoPath: string
  nativeHostApplication?: string
}

export interface FileDigestEntry {
  sha256: string
  bytes: number
}

export interface BuildArtifactMetadata {
  schemaVersion: 1
  buildId: string
  sourceHead: string
  inputsFingerprint: string
  manifestVersion: string
  builtAt: string
  extOutDir: string
  hostOutDir: string
  candidatePath: string
  nativeHostApplication: string
  extFiles: Record<string, FileDigestEntry>
  hostFiles: Record<string, FileDigestEntry>
  dirty?: boolean
  branch?: string | null
}

export interface ExtensionTabInjectionReport {
  tabId?: number
  urlPrefix: string
  status: 'REINJECTED' | 'FAILED' | 'UNAVAILABLE'
  buildId?: string
  reason?: string
}

export interface ExtensionRuntimeAttestation {
  installationId: string
  extensionId: string
  profileId: string
  bootId: string
  buildId: string
  manifestVersion: string
  installType: string
  hostBuildId?: string
  hostCompatible?: boolean
  hostApplication?: string
  reloadedOperationId?: string
  reloadedNonce?: string
  reloadedEpoch?: number
  tabStates?: ExtensionTabInjectionReport[]
  reportedAt: string
}

export interface ExtensionMaintenanceAuthorization {
  operationId: string
  installationId: string
  targetBuildId: string
  epoch: number
  nonce: string
  expiresAt: string
}

export interface ExtensionOperationRecord {
  operationId: string
  action: ExtensionOperationAction
  state: ExtensionOperationState
  installationId: string
  expectedSourceHead?: string
  allowDirtyWorktree?: boolean
  requestedTargetBuildId?: string
  targetBuildId?: string
  previousBootId?: string
  epoch?: number
  nonce?: string
  expiresAt?: string
  busyReason?: string
  errorCode?: string
  errorMessage?: string
  candidateMetadata?: BuildArtifactMetadata
  attestation?: ExtensionRuntimeAttestation
  tabStates?: ExtensionTabInjectionReport[]
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface StartExtensionOperationInput {
  action: ExtensionOperationAction
  operationId?: string
  expectedSourceHead?: string
  targetBuildId?: string
  allowDirtyWorktree?: boolean
}

export interface StartExtensionOperationResult {
  accepted: boolean
  code?: 'BUSY' | 'INVALID_ARGUMENT' | 'NOT_ENROLLED' | 'REVOKED' | 'DIRTY_SOURCE_WORKTREE' | 'SOURCE_HEAD_MISMATCH' | 'BUILD_NOT_FOUND' | 'FAILED'
  message?: string
  activeOperationId?: string
  operation?: ExtensionOperationRecord
}

export interface ExtensionManagerStatusSnapshot {
  enrolled: boolean
  managed: boolean
  enrollment: ManagedInstallationEnrollment | null
  activeOperation: ExtensionOperationRecord | null
  lastValidBuild: BuildArtifactMetadata | null
  lastAttestation: ExtensionRuntimeAttestation | null
  recentOperations: ExtensionOperationRecord[]
}

export interface MaintenanceCheckRequest {
  installationId: string
  extensionId: string
  profileId: string
  bootId: string
  buildId: string
  manifestVersion: string
  installType: string
  hostBuildId?: string
  hostApplication?: string
}

export interface MaintenanceCheckResponse {
  managed: boolean
  revoked?: boolean
  reason?: string
  pendingOperation?: ExtensionMaintenanceAuthorization | null
}

export interface MaintenanceClaimRequest {
  operationId: string
  installationId: string
  extensionId: string
  profileId: string
  bootId: string
  buildId: string
  targetBuildId: string
  nonce: string
  epoch: number
  readyToReload: boolean
  activeBusyReason?: string
  hostBuildId?: string
  hostApplication?: string
}

export interface MaintenanceClaimResponse {
  decision: 'RELOAD_NOW' | 'DEFER' | 'REJECT'
  reason?: string
  retryAfterMs?: number
  authorization?: ExtensionMaintenanceAuthorization
}

export interface MaintenanceReportRequest {
  phase: 'BOOT_ATTESTATION' | 'REINJECT_RESULT' | 'QUIESCENCE_BLOCKED'
  report: ExtensionRuntimeAttestation
}

export interface MaintenanceReportResponse {
  accepted: boolean
  verified?: boolean
  operation?: ExtensionOperationRecord | null
  reason?: string
}
