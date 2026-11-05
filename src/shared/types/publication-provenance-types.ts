import { createHash } from 'node:crypto'
export interface PublicationReceipt {
  schemaVersion: 1
  receiptId: string
  repositoryId: string
  artifactId: string
  revision: number
  contentHash: string
  requestDigest: string
  action: 'PUBLISH' | 'UPDATE'
  digest: string
}
export interface PublicationRequest { rawMarkdown: string; name?: string; description?: string; kind?: string; artifactId?: string; expectedRevision?: number }
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
    action === 'UPDATE' ? input.artifactId : null, action === 'UPDATE' ? input.expectedRevision : null])).digest('hex')
}
