import type { AcademyGitStatusProjection, AcademyGitSyncState, AcademyMarketplaceState, AcademyOpenAiReleaseStatus, AcademySnapshot } from './academy-types'

export interface AcademyLastKnownSyncSnapshot {
  repositoryId: string
  branch: string
  remoteHead: string | null
  confirmedAt: string | null
  result: AcademyGitSyncState
  autoPublish: boolean
  autoUpdate: boolean
  localHead: string | null
}

export interface AcademyRemoteCheckState {
  state: 'IDLE' | 'CHECKING' | 'OK' | 'FAILED'
  generation: number
  requestId: string | null
  error: string | null
  completedAt: string | null
}

export interface AcademyPersistedPublication {
  publishedVersion: string | null
  release: { id: string; version: string; status: AcademyOpenAiReleaseStatus; sourceCommitSha: string | null } | null
  marketplace: AcademyMarketplaceState
}

export interface AcademyBootstrapState {
  initializationId: string
  hydration: 'READY'
  provenance: 'ACADEMY_SQLITE'
  storeDurationMs: number
  snapshot: AcademySnapshot
  git: AcademyGitStatusProjection
  publication: AcademyPersistedPublication
}
