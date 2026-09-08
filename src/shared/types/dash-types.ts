/*
-T ---
*/

export type DashRepresentation = 'source' | 'compression'

export interface DashItem {
  path: string
  representation: DashRepresentation
}

export interface DashRequest {
  protocol: string
  output: {
    format: 'xml'
    name?: string
  }
  items: DashItem[]
}

export type DashFailureReason =
  | 'invalid_json'
  | 'unknown_protocol'
  | 'invalid_format'
  | 'empty_items'
  | 'invalid_representation'
  | 'invalid_path'
  | 'path_traversal'
  | 'absolute_path'
  | 'unknown_field'
  | 'duplicate_item'
  | 'not_found'
  | 'ambiguous'

export type DashResolutionStatus = 'resolved' | 'not_found' | 'ambiguous'

export interface DashResolutionFailure {
  index: number
  path: string
  reason: DashFailureReason
}

export interface DashResolutionReport {
  valid: boolean
  request: DashRequest | null
  failures: DashResolutionFailure[]
}

export interface DashPlannedItem {
  index: number
  path: string
  representation: DashRepresentation
  profile?: string
}

export interface DashPlanMetadata {
  requestedCount: number
  resolvedCount: number
  failedCount: number
}

export interface DashContextPlan {
  metadata: DashPlanMetadata
  plannedItems: DashPlannedItem[]
  failures: DashResolutionFailure[]
}

