export type SecurityCapability = 'FILESYSTEM_WRITE_SEPARATION' | 'NETWORK_EGRESS_RESTRICTION' | 'SECRET_ISOLATION' | 'PROCESS_PRIVILEGE_SEPARATION' | 'SYSTEM_RESOURCE_RESTRICTION'
export interface SecurityRequirement { capability: SecurityCapability; guarantee: string }
export interface MissingSecurityRequirement extends SecurityRequirement {
  availableMechanism: { kind: 'PROFILE_ISOLATION' | 'SECURITY_CONTAINMENT' | 'NONE'; name: string; basis: string }
  resolutions: Array<{ action: 'CONFIGURE_ENFORCEMENT' | 'INDEPENDENT_POLICY_REVIEW'; description: string; requiresIndependentApproval: true }>
}
export interface PreviewSelection { repositoryId: string; worktreeId: string; generation: string; profileId: string; fingerprint: string }
export interface PreviewProfileSummary { profileId: string; revision: number; fingerprint: string; approved: boolean; runtime: 'WEB_DEV_SERVER' | 'ELECTRON_DEV' }
export interface PreviewPreflight {
  selection: PreviewSelection
  profileRevision: number
  status: 'SUPPORTED' | 'MISSING' | 'INCOMPATIBLE' | 'UNKNOWN'
  diagnostics: Array<{ reasonCode: string; message: string; missingRequirements?: MissingSecurityRequirement[] }>
  snapshot?: { head: string | null; branch: string | null; indexRevision: string; worktreeRevision: string; dirty: boolean }
  dependencyBasis?: string
  readiness: 'NOT_OBSERVED'
  process: 'NOT_IMPLEMENTED'
}

export type PreviewObservationState = 'CURRENT' | 'SUSPECT' | 'INVALID' | 'UNVERIFIABLE'
export interface PreviewObservationEvent {
  origin: 'GIT' | 'SOURCE' | 'CORPUS'; event: string; path: string; epoch: number
  decision?: 'NO_CHANGE' | 'CHANGED' | 'COVERAGE_LOST'; reason?: string
}
export type PreviewObservationSink = (event: PreviewObservationEvent) => void
