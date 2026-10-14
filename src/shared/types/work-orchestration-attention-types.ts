export interface OperationalRecommendation {
  action: 'REVIEW_CONTRACT_COMPATIBILITY' | 'REVALIDATE_EVIDENCE'
  reason: 'DIRECT_CONTRACT_CONSUMER' | 'EVIDENCE_NOT_CURRENT'
  repositoryId: string
  alertId: string
  providerGeneration: string
  consumerGeneration: string
  providerRevision: string
  consumerRevision: string
  symbols: string[]
  symbolCount: number
}
export interface StructuralAlert {
  repositoryId?: string
  id: string
  category: 'POTENTIAL_STRUCTURAL_INTERFERENCE'
  state: 'CURRENT' | 'STALE'
  provider: string
  consumer: string
  providerGeneration: string
  consumerGeneration: string
  providerRevision: string
  consumerRevision: string
  base: string
  verifiedAt: string
  recommendation?: OperationalRecommendation
  evidence: Array<{ contractPath: string; consumerPath: string; symbol: string; contractLine: number; consumerLine: number; signature: string; previousSignature: string; binding: 'RESOLVED_DIRECT' }>
}
export interface OrchestrationAttention {
  repositoryId: string | null
  alerts: StructuralAlert[]
  coverage: 'PENDING' | 'PARTIAL' | 'UNAVAILABLE'
  paused: boolean
  known: number
  observed: number
  pending: Array<{ worktreeId: string; reason: string }>
  checkedAt: string | null
  cadenceMs: number
  inventoryCadenceMs: number
  cycleMs: number
  budget: { observations: number; pairs: number; timeMs: number; captures: number; alerts: number }
  stats: { observations: number; captures: number; extractions: number; bytes: number; confirmedPairs: number }
}
export interface OrchestrationAttentionChange {
  context: { projectId: string; revision: number }
  attention: OrchestrationAttention
}
