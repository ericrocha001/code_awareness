export type RepoDiscoveryLayer = 1 | 2

export const REPO_DISCOVERY_PROTOCOL_VERSION = 'repo-discovery/v1'
export const REPO_MAP_FORMAT_VERSION = 'RM2'

export interface RepoDiscoveryTimings {
  readinessMs: number
  projectionMs: number
  serializationMs: number
  outputTokenizationMs: number
  totalMs: number
}

export interface RepoDiscoveryRequest {
  protocol: typeof REPO_DISCOVERY_PROTOCOL_VERSION
  operation: 'discovery'
  layer: RepoDiscoveryLayer
}

export interface RepoDiscoveryResult {
  protocol: typeof REPO_DISCOVERY_PROTOCOL_VERSION
  layer: RepoDiscoveryLayer
  content: string
  tokenCount: number
  mapTokenCount: number
  tokenizerId: string
  tokenizerEncoding: string
  fileCount: number
  generationMs: number
  timings: RepoDiscoveryTimings
}
