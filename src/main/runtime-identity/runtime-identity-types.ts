export type FreshnessState = 'MATCH' | 'SOURCE_CHANGED_SINCE_START' | 'UNVERIFIABLE'

export interface RuntimeIdentityInfo {
  instanceId: string
  startedAt: string
  appVersion: string
  mode: 'development' | 'production'
  protocolVersion: string
}

export interface SourceSnapshot {
  fingerprint: string
  fileCount: number
  capturedAt: string
}

export interface SourceDivergence {
  changedFileCount: number
  modifiedFiles: string[]
  addedFiles: string[]
  removedFiles: string[]
  truncated: boolean
  recommendedAction: 'RESTART_RUNTIME'
}

export interface RuntimeFreshnessResult {
  state: FreshnessState
  divergence?: SourceDivergence
}

export interface RuntimeIdentityPayload {
  runtime: RuntimeIdentityInfo
  startupSource: SourceSnapshot
  currentSource: SourceSnapshot
  freshness: RuntimeFreshnessResult
}

export interface RuntimeIdentitySummary {
  instanceId: string
  startedAt: string
  freshness: FreshnessState
  startupFingerprint: string
  currentFingerprint: string
  changedFileCount?: number
  recommendedAction?: 'RESTART_RUNTIME'
}
