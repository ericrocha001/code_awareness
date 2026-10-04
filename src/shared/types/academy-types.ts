export type AcademySkillStatus = 'ACTIVE' | 'ARCHIVED'
export type AcademySkillScope = 'GLOBAL' | 'PROJECT'
export type AcademyVersionOrigin = 'IMPORT' | 'FILESYSTEM' | 'UI' | 'MCP'
export type AcademyConflictStatus = 'OPEN' | 'RESOLVED'
export type AcademyDistributionTarget = 'FILESYSTEM_NATIVE' | 'CLAUDE_CODE'
export type AcademyDistributionStatus = 'CURRENT' | 'PENDING' | 'DRIFTED' | 'MISSING' | 'ERROR'
export type AcademyDistributionConvergence = 'CONVERGED' | 'DEGRADED'
export type AcademyOpenAiReleaseStatus = 'READY_TO_UPLOAD' | 'STALE' | 'UPLOADED_UNVERIFIED' | 'VERIFIED' | 'SUPERSEDED' | 'BLOCKED'
export type AcademyOpenAiDeletionSemantics = 'UNKNOWN' | 'PROVEN_REPLACE' | 'OVERLAY_NO_DELETE' | 'INCONCLUSIVE'
export type AcademyMarketplaceTakeoverStatus = 'TAKEOVER_PROVEN' | 'TAKEOVER_UNSUPPORTED' | 'INCONCLUSIVE'
export type AcademyMarketplaceMode = 'GIT_MANAGED' | 'SOURCE_AVAILABLE' | 'PENDING_EVIDENCE'
export type AcademyHostedPluginStatus = 'CURRENT' | 'HOSTED_UPDATE_AVAILABLE' | 'UNCONFIGURED'

export interface AcademyPackage {
  skillMd: string
  artifacts: Record<string, string>
}

export interface AcademySkillSummary {
  id: string
  name: string
  description: string
  status: AcademySkillStatus
  scope: AcademySkillScope
  currentVersion: number
  projectIds: string[]
  createdAt: string
  updatedAt: string
}

export interface AcademySkillVersion {
  skillId: string
  version: number
  package: AcademyPackage
  packageHash: string
  origin: AcademyVersionOrigin
  createdAt: string
}

export interface AcademySkillDetail extends AcademySkillSummary {
  current: AcademySkillVersion
}

export interface AcademyDestination {
  id: string
  path: string
  name: string
  enabled: boolean
  reconciliationStatus: 'PENDING' | 'SYNCED' | 'ERROR'
  lastError: string | null
  updatedAt: string
}

export interface AcademyConflict {
  id: string
  skillId: string
  skillName: string
  origin: AcademyVersionOrigin
  baseVersion: number | null
  currentVersion: number
  divergentPackage: AcademyPackage | null
  divergentHash: string
  projectId: string | null
  projectionPath: string | null
  status: AcademyConflictStatus
  createdAt: string
  resolvedAt: string | null
}

export interface AcademyImportItem {
  directory: string
  name: string | null
  result: 'IMPORTED' | 'UNCHANGED' | 'INVALID' | 'DUPLICATE' | 'CONFLICT'
  error?: string
  skillId?: string
}

export interface AcademyCreateInput {
  package: AcademyPackage
  scope: AcademySkillScope
  projectIds?: string[]
  origin: AcademyVersionOrigin
}

export interface AcademyUpdateInput {
  skillId: string
  expectedVersion: number
  package: AcademyPackage
  origin: AcademyVersionOrigin
  scope?: AcademySkillScope
  projectIds?: string[]
}

export interface AcademySnapshot {
  skills: AcademySkillSummary[]
  destinations: AcademyDestination[]
  conflicts: AcademyConflict[]
}

export interface AcademyDistributionState {
  skillId: string
  skillName: string
  destinationId: string
  destinationName: string
  target: AcademyDistributionTarget
  canonicalVersion: number
  canonicalHash: string
  distributedVersion: number | null
  distributedHash: string | null
  status: AcademyDistributionStatus
  errorCode: string | null
  errorMessage: string | null
  checkedAt: string
  exposureName: string | null
  linkMechanism: 'SYMLINK' | 'JUNCTION' | null
}

export interface AcademyDistributionTargetHealth {
  target: AcademyDistributionTarget
  convergence: AcademyDistributionConvergence
  current: number
  pending: number
  drifted: number
  missing: number
  error: number
  lastReconciledAt: string | null
}

export interface AcademyDistributionHealth {
  targets: AcademyDistributionTargetHealth[]
}

export interface AcademyOpenAiPluginProfile {
  name: 'academy-skills'
  displayName: string
  description: string
  author: Record<string, unknown>
  openAiInterface: Record<string, unknown>
  logoPath: string | null
  publishedVersion: string
  deletionSemantics: AcademyOpenAiDeletionSemantics
  deletionSemanticsEvidence: string | null
  createdAt: string
  updatedAt: string
}

export interface AcademyOpenAiSnapshotEntry {
  skillId: string
  name: string
  academyVersion: number
  packageHash: string
}

export interface AcademyOpenAiReleaseDelta {
  added: AcademyOpenAiSnapshotEntry[]
  updated: Array<{ before: AcademyOpenAiSnapshotEntry; after: AcademyOpenAiSnapshotEntry }>
  removed: AcademyOpenAiSnapshotEntry[]
  renamed: Array<{ before: AcademyOpenAiSnapshotEntry; after: AcademyOpenAiSnapshotEntry }>
  destructive: boolean
}

export interface AcademyPluginPackageRevision {
  id: string
  version: string
  contentFingerprint: string
  skillSnapshotHash: string
  profileFingerprint: string
  assetHash: string
  delta: AcademyOpenAiReleaseDelta
  createdAt: string
}

export interface AcademyMarketplaceState {
  takeoverStatus: AcademyMarketplaceTakeoverStatus
  mode: AcademyMarketplaceMode
  observedPluginId: string | null
  evidence: string
  updatedAt: string
}

export interface AcademyOpenAiUploadConfirmation {
  releaseId: string
  pluginVersion: string
  artifactHash: string
  confirmedAt: string
  method: 'MANUAL_UPLOAD'
}

export interface AcademyOpenAiRelease {
  id: string
  pluginVersion: string
  createdAt: string
  referenceReleaseId: string | null
  snapshot: AcademyOpenAiSnapshotEntry[]
  snapshotHash: string
  delta: AcademyOpenAiReleaseDelta
  manifest: Record<string, unknown> | null
  artifactPath: string | null
  artifactHash: string | null
  status: AcademyOpenAiReleaseStatus
  blockedReason: string | null
  baseline: boolean
  uploadConfirmation: AcademyOpenAiUploadConfirmation | null
  verificationEvidence: string | null
}

export interface AcademyOpenAiPublicationState {
  profile: AcademyOpenAiPluginProfile | null
  latestPrepared: AcademyOpenAiRelease | null
  latestUploaded: AcademyOpenAiRelease | null
  selectedRelease: AcademyOpenAiRelease | null
  publicSkillCount: number
  canonicalSnapshotHash: string | null
  drifted: boolean
  currentPackageRevision: AcademyPluginPackageRevision | null
  hostedStatus: AcademyHostedPluginStatus
}

export interface AcademyPackageDistributionState {
  packageRevision: AcademyPluginPackageRevision | null
  skillCount: number
  git: AcademyGitStatusProjection
  marketplace: AcademyMarketplaceState
  hosted: {
    status: AcademyHostedPluginStatus
    label: 'Hosted Personal'
    version: string | null
  }
}

export type AcademyGitSyncState =
  | 'UNCONFIGURED'
  | 'SYNCED'
  | 'DIRTY'
  | 'SYNCING'
  | 'PUSH_PENDING'
  | 'LOCAL_DRIFT'
  | 'REMOTE_DIVERGED'
  | 'ERROR'

export interface AcademyGitProfile {
  repositoryCatalogId: string
  githubRepositoryId: string
  branch: string
  lastSnapshotHash: string | null
  lastCommitSha: string | null
  lastPushedCommitSha: string | null
  syncState: AcademyGitSyncState
  lastError: string | null
  updatedAt: string
}

export interface AcademyGitStatusProjection {
  profile: AcademyGitProfile | null
  repository: {
    id: string
    name: string
    fullName: string
    visibility: 'PUBLIC' | 'PRIVATE' | 'INTERNAL'
    checkoutPath: string
    branch: string
  } | null
  syncState: AcademyGitSyncState
  lastSyncAt: string | null
  lastCommitSha: string | null
  lastError: string | null
}
