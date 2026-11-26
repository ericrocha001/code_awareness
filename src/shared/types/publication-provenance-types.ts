import { createHash } from 'node:crypto'
import type { AuthenticatedSessionWitness, DeliveryAnchor } from './delivery-context-types'
export type DocumentaryMembershipIntent =
  | { planArtifactId: string; expectedPlanRevision: number }
  | { action: 'UNLINK'; reason: string }
export type DocumentaryMembershipKind = 'EXPLICIT_TARGET' | 'HANDOFF_IMPLEMENTS'
export interface DocumentaryMembership {
  repositoryId: string
  artifactId: string
  revision: number
  contentHash: string
  executionId: string
  planArtifactId: string
  planRevision: number
  planDigest: string
  bindingArtifactId: string
  bindingRevision: number
  bindingDigest: string
  evidenceRef: string
  digest: string
  intent: DocumentaryMembershipKind
  classification: 'VERIFIED'
}
export interface PublicationReceipt {
  schemaVersion: 1
  receiptId: string
  repositoryId: string
  artifactId: string
  revision: number
  contentHash: string
  requestDigest: string
  action: 'PUBLISH' | 'UPDATE'
  deliveryContext?: DeliveryAnchor
  documentaryMembership?: DocumentaryMembershipKind
  documentaryUnlinkReason?: string
  sessionWitness?: AuthenticatedSessionWitness
  digest: string
}
export interface PublicationRequest { rawMarkdown: string; name?: string; description?: string; kind?: string; artifactId?: string; expectedRevision?: number; membership?: DocumentaryMembershipIntent }
export interface PublicationAssociation {
  repositoryId: string; receiptId: string; sessionId: string; invocationId: string; worktreeId: string; generation: string; evidenceDigest: string
}
export interface PublicationAssociationResult { state: 'VERIFIED' | 'AMBIGUOUS'; conflictingInvocationIds: string[] }
export interface PublicationProvenancePort {
  readReceipt(receiptId: string): Promise<PublicationReceipt | null>
  associate(association: PublicationAssociation): Promise<PublicationAssociationResult>
  invalidate(invocationId: string, state: 'UNAVAILABLE' | 'PARTIAL' | 'AMBIGUOUS'): Promise<void>
}
export const publicationReceiptDigest = (receipt: Omit<PublicationReceipt, 'digest'>): string => createHash('sha256').update(JSON.stringify(receipt)).digest('hex')
export function publicationRequestDigest(action: PublicationReceipt['action'], input: PublicationRequest): string {
  return createHash('sha256').update(JSON.stringify([1, action, input.rawMarkdown, input.name ?? null, input.description ?? null, input.kind ?? null,
    action === 'UPDATE' ? input.artifactId : null, action === 'UPDATE' ? input.expectedRevision : null,
    ...(input.membership === undefined ? [] : ['action' in input.membership ? ['UNLINK', input.membership.reason] : [input.membership.planArtifactId, input.membership.expectedPlanRevision]])])).digest('hex')
}
