import type { GitDecoration } from './git-management-types'

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
