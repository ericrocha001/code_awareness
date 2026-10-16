import type { GitHistoryPage, GitManagementContext } from './git-management-types'

export type GitAtlasWindow = 30 | 60 | 90 | 'ALL'
export interface GitAtlasRequest {
  context: GitManagementContext
  window: GitAtlasWindow
  cursor?: string
  limit?: number
  refresh?: boolean
}
export interface GitAtlasPage extends GitHistoryPage {
  queriedAt: string
  since: string | null
  primaryRef: string | null
  detachedHeads: { sha: string; name: string }[]
  detachedCoverage: 'COMPLETE' | 'PARTIAL'
  tags: { sha: string; name: string }[]
  coverage: 'COMPLETE_WINDOW' | 'PARTIAL'
  boundary: string[]
}
export interface GitAtlasCompareRequest {
  context: GitManagementContext
  snapshot: string
  left: string
  right: string
}
export interface GitAtlasComparison {
  snapshot: string
  left: { ref: string; sha: string }
  right: { ref: string; sha: string }
  mergeBases: string[]
  leftOnly: number
  rightOnly: number
  exclusive: { left: string[]; right: string[]; complete: boolean }
}
export interface GitAtlasQuery {
  window: GitAtlasWindow
  cursor?: string
  limit?: number
  contextKey?: string
  refresh?: boolean
}
