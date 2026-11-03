import type { AcademyOpenAiSnapshotEntry } from './academy-types'

export interface AcademyGitSnapshotHeader {
  repositoryId: string
  branch: string
  sourceCommitSha: string
  managedTreeHash: string
  observedAt: string
  manifest: Record<string, any> | null
  snapshot: AcademyOpenAiSnapshotEntry[]
  entryCount: number
}

export interface AcademyBuildProjection {
  schema: 1
  normalizationSchema: 1
  sourceRepositoryId: string
  sourceCommitSha: string
  managedTreeHash: string
  manifest: Record<string, any>
  pluginVersion: string
  manifestFingerprint: string
  assetFingerprint: string
  entriesFingerprint: string
  snapshot: AcademyOpenAiSnapshotEntry[]
  entryCount: number
}

export interface AcademyVersionPreflight {
  outcome: 'REUSE_SAME_SOURCE' | 'NEW_RELEASE_ALLOWED' | 'VERSION_ALREADY_USED_FOR_OTHER_CONTENT' | 'VERSION_NOT_PROGRESSIVE' | 'GIT_SOURCE_NOT_VERIFIED' | 'DESTRUCTIVE_DELTA_BLOCKED' | 'CONTENT_CHECK_REQUIRED'
  manifestVersion: string | null
  highestKnownVersion: string | null
  suggestedVersion: string | null
  registeredVersion: string | null
  sourceCommitSha: string | null
  message: string
}

export interface AcademyManifestPreview {
  repositoryId: string
  branch: string
  sourceCommitSha: string
  workspaceCommitSha: string
  manifestHash: string
  previousVersion: string
  newVersion: string
  before: string
  after: string
  token: string
}

export interface AcademyPublicationOperation {
  requestId: string
  phase: 'VERIFYING_SOURCE' | 'PREFLIGHT' | 'PREPARING_PACKAGE' | 'READY' | 'ERROR'
  sourceCommitSha?: string
  error?: string
  phases: Record<string, number>
}
