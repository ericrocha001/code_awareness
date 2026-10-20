import type { GitHistoryPage, GitManagementContext } from './git-management-types'

export type GitAtlasWindow = 7 | 15 | 30 | 60 | 90 | 'ALL'
export interface GitAtlasScope {
  kind: 'CHECKOUT' | 'ALL_REFS'
  anchor: 'AUTO' | 'PRESENT'
  baseRef?: string
  focusRef?: string
}
export interface GitAtlasRequest {
  context: GitManagementContext
  window: GitAtlasWindow
  cursor?: string
  limit?: number
  refresh?: boolean
  scope?: GitAtlasScope
}
export interface GitAtlasPage extends GitHistoryPage {
  worktreeGeneration?: string
  scope?: GitAtlasScope
  referenceCoverage?: 'SELECTED' | 'ALL_REFS'
  anchorAt?: string
  anchorKind?: 'PRESENT' | 'CHECKOUT'
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
  scope?: GitAtlasScope
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
  scope?: GitAtlasScope
}
