import type { GitDecoration } from './git-management-types'
import type { GitManagementContext } from './git-management-types'

export type AtlasHistoryCoverage = 'NOT_STARTED' | 'PARTIAL' | 'COMPLETE' | 'UNKNOWN'
export interface AtlasCatalogManifest {
  scopeKey: string
  revision: string
  topology: string
  worktreeGeneration: string
  tips: string[]
  refs: GitDecoration[]
  tags: Array<{ name: string; sha: string }>
  observedAt: string
  available: boolean
  sourceFingerprint?: string
}
export interface AtlasCollectionRound {
  id: string
  manifest: AtlasCatalogManifest
  status: AtlasHistoryCoverage
  checkpointVersion: 1
  ordering: 'PARENT_FRONTIER_V1'
  acquired: number
  reason: string | null
}
export interface AtlasCatalogDiagnostic {
  state: 'READY' | 'UNAVAILABLE' | 'SUSPENDED'
  reason: string | null
}
export interface AtlasCatalogState {
  manifest: AtlasCatalogManifest | null
  coverage: AtlasHistoryCoverage
  acquired: number
  diagnostic: AtlasCatalogDiagnostic
  reason: string | null
}
export interface AtlasCatalogRequest { context: GitManagementContext; snapshot: string }
export interface AtlasCatalogChange { context: GitManagementContext; state: AtlasCatalogState }
