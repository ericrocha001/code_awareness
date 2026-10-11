import type { ContinuumItem, ContinuumMetadataValue, ContinuumPeriod } from './continuum-ui-types'

export interface ContinuumGraphQuery {
  artifactIds?: string[]
  query?: string
  kind?: string
  status?: string
  metadata?: Record<string, ContinuumMetadataValue>
  periods?: Record<string, ContinuumPeriod>
  expand?: boolean
  direction?: 'inbound' | 'outbound' | 'both'
  relationKind?: string
  nodeLimit?: number
  edgeLimit?: number
  expectedRevision?: number
}
export interface ContinuumGraphNode extends ContinuumItem { revision: number; incomingDegree: number; outgoingDegree: number }
export interface ContinuumGraphEdge {
  sourceId: string
  targetId: string
  kind: string
  nature: 'DECLARED' | 'DERIVED'
  origin: 'metadata.relations' | 'explicit-artifact-reference'
  sourceRevision: number
  sourceHash: string
}
export interface ContinuumExecutionGroup { executionId: string; memberIds: string[]; totalMembers: number }
export interface ContinuumGraph {
  repositoryId: string
  revision: number
  freshness: 'CURRENT' | 'BACKFILL_PENDING'
  nodes: ContinuumGraphNode[]
  edges: ContinuumGraphEdge[]
  executionGroups: ContinuumExecutionGroup[]
  truncated: { nodes: boolean; edges: boolean }
}
export interface ContinuumGraphRequest extends ContinuumGraphQuery { repositoryId: string }
