import type { AcademyPackage } from './academy-types'

export interface AcademyGitSourceSkill {
  path: string
  name: string
  package: AcademyPackage
  packageHash: string
}

export interface AcademyGitSourceSnapshot {
  identities?: import('../academy-identity.cjs').AcademyIdentityCatalog
  canonicalVersions?: Record<string, { skillId: string; version: number }>
  schema: 1
  repositoryId: string
  remoteUrl: string
  branch: string
  sourceCommitSha: string
  firstParentSha: string | null
  managedTreeHash: string
  skills: AcademyGitSourceSkill[]
  authoredFiles: Record<string, string>
  observedAt: string
}

export interface AcademyGitBuildSource {
  snapshot: AcademyGitSourceSnapshot
  remoteConfirmation: 'OBSERVED' | 'CACHED'
  confirmedAt: string
}

export type AcademyGitBuildRequest = { mode: 'LATEST'; force?: boolean } | { mode: 'REBUILD'; sourceCommitSha: string }

export interface AcademyGitBuildReceipt {
  buildKey?: string
  phases?: Record<string, number>
  id: string
  releaseId: string
  buildSchema: 1
  sourceRepositoryId: string
  branch: string
  sourceCommitSha: string
  managedTreeHash: string
  manifestFingerprint: string
  assetFingerprint: string
  entriesFingerprint: string
  pluginVersion: string
  zipSha256: string | null
  remoteConfirmation: 'OBSERVED' | 'CACHED'
  confirmedAt: string
}

export interface AcademyGitSkillSource {
  repositoryId: string
  path: string
  skillId: string
  legacyBaselineVersion: number
  sourceCommitSha: string
  available: boolean
}

export interface AcademyGitAuthority {
  repositoryId: string
  remoteUrl: string
  branch: string
  processedCommitSha: string
  baselineCommitSha: string
  cutoverAt: string
}
