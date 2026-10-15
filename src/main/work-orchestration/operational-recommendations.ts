import type { OperationalRecommendation, StructuralAlert } from '../../shared/types/work-orchestration-attention-types'

export interface RecommendationContext {
  repositoryId: string | null
  available: boolean
  participants: ReadonlyMap<string, { generation: string; revision: string }>
}

export function recommendOperation(alert: StructuralAlert, context: RecommendationContext): OperationalRecommendation | undefined {
  if (!context.repositoryId || alert.repositoryId !== context.repositoryId || !alert.id || !alert.provider || !alert.consumer || alert.provider === alert.consumer ||
    !alert.providerGeneration || !alert.consumerGeneration || !alert.providerRevision || !alert.consumerRevision) return undefined
  const evidence = Array.isArray(alert.evidence) ? alert.evidence : []
  const direct = alert.category === 'POTENTIAL_STRUCTURAL_INTERFERENCE' && !!alert.base && !!alert.verifiedAt && evidence.length > 0 && evidence.every(e =>
    e && e.binding === 'RESOLVED_DIRECT' && typeof e.symbol === 'string' && !!e.symbol && typeof e.contractPath === 'string' && !!e.contractPath && typeof e.consumerPath === 'string' && !!e.consumerPath && typeof e.signature === 'string' && !!e.signature && typeof e.previousSignature === 'string' && !!e.previousSignature &&
    Number.isInteger(e.contractLine) && e.contractLine > 0 && Number.isInteger(e.consumerLine) && e.consumerLine > 0)
  const provider = context.participants.get(alert.provider), consumer = context.participants.get(alert.consumer)
  const current = alert.state === 'CURRENT' && context.available && direct && provider?.generation === alert.providerGeneration &&
    consumer?.generation === alert.consumerGeneration && provider.revision === alert.providerRevision && consumer.revision === alert.consumerRevision
  const symbols = [...new Set(evidence.filter(e => e && e.binding === 'RESOLVED_DIRECT' && typeof e.symbol === 'string').map(e => e.symbol))]
  return { action: current ? 'REVIEW_CONTRACT_COMPATIBILITY' : 'REVALIDATE_EVIDENCE', reason: current ? 'DIRECT_CONTRACT_CONSUMER' : 'EVIDENCE_NOT_CURRENT',
    repositoryId: context.repositoryId, alertId: alert.id, providerGeneration: alert.providerGeneration, consumerGeneration: alert.consumerGeneration,
    providerRevision: alert.providerRevision, consumerRevision: alert.consumerRevision, symbols: symbols.slice(0, 2), symbolCount: symbols.length }
}
