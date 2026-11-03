import { z } from 'zod'
import type { Artifact } from '../continuum/continuum-types'
import type { ContinuumService } from '../continuum/continuum-service'
import type { ValidationLedger } from '../validation-ledger/validation-ledger'
import type { SessionContextPort } from './mcp'
import { parseSessionRefresh } from './mcp'
import type { SessionTargetSelection } from './target'

const linksSchema = z.array(z.object({ sessionId: z.string().uuid() }).strict()).max(10)
const details = (artifact: Artifact) => {
  const nested = artifact.metadata.metadata
  return nested && typeof nested === 'object' && !Array.isArray(nested) ? { ...nested, ...artifact.metadata } : artifact.metadata
}
export function authorizeHandoffAssociation(service: ContinuumService | null, ledger: ValidationLedger, request: ReturnType<typeof parseSessionRefresh>): { sourceRevision: number; sourceHash: string } {
  const link = request.association
  if (!link || !request.sessionId) throw new Error('INVALID_ARGUMENT')
  const source = service?.get(link.sourceArtifactId)
  if (!source || source.metadata.kind !== 'IMPLEMENTATION_HANDOFF') throw new Error('ASSOCIATION_SOURCE_UNAVAILABLE')
  if ((link.sourceRevision !== undefined && link.sourceRevision !== source.revision) || (link.sourceHash !== undefined && link.sourceHash !== source.contentHash)) throw new Error('ASSOCIATION_SOURCE_STALE')
  const metadata = details(source)
  const declared = linksSchema.safeParse(metadata.sessionLinks ?? [])
  if (!declared.success || !declared.data.some(row => row.sessionId === request.sessionId)) throw new Error('ASSOCIATION_NOT_DECLARED')
  if (link.artifactId && (!service?.get(link.artifactId) || !source.metadata.relations?.some(relation => relation.artifactId === link.artifactId && relation.kind === 'implements'))) throw new Error('ASSOCIATION_NOT_DECLARED')
  for (const key of ['executionId', 'commitSha', 'pullRequest'] as const) {
    if (link[key] !== undefined && metadata[key] !== link[key]) throw new Error('ASSOCIATION_NOT_DECLARED')
  }
  const declaredProofs = z.array(z.string()).safeParse(metadata.proofIds ?? [])
  if (!declaredProofs.success) throw new Error('PROOF_ASSOCIATION_UNAVAILABLE')
  for (const proofId of link.proofIds) {
    const proof = ledger.getProof(proofId)
    if (!declaredProofs.data.includes(proofId) || !proof || !proof.evidenceFor.some(id => id === source.artifactId || id === link.artifactId)) throw new Error('PROOF_ASSOCIATION_UNAVAILABLE')
  }
  return { sourceRevision: source.revision, sourceHash: source.contentHash }
}
export async function handoffSessionCoverage(port: SessionContextPort | undefined, artifact: Artifact, target: SessionTargetSelection): Promise<object> {
  if (!port) return { code: 'SESSION_CONTEXT_UNAVAILABLE', coverage: 'UNAVAILABLE' }
  void port.call('reconcile_checkpoint_registry', { artifactId: artifact.artifactId })
  const metadata = details(artifact), declared = linksSchema.safeParse(metadata.sessionLinks ?? [])
  if (!declared.success) return { code: 'INVALID_SESSION_LINKS', coverage: 'PARTIAL' }
  if (!declared.data.length) return { code: 'RECONCILIATION_REQUESTED', coverage: 'PENDING', transcriptImported: false }
  const artifactIds = artifact.metadata.relations?.filter(relation => relation.kind === 'implements').map(relation => relation.artifactId) ?? []
  if (declared.data.length * Math.max(1, artifactIds.length) > 10) return { code: 'SESSION_LINK_LIMIT', coverage: 'PARTIAL' }
  const proofIds = z.array(z.string()).max(10).safeParse(metadata.proofIds ?? [])
  if (!proofIds.success) return { code: 'INVALID_PROOF_LINKS', coverage: 'PARTIAL' }
  const receipts: object[] = []
  for (const link of declared.data) {
    for (const artifactId of artifactIds.length ? artifactIds : [undefined]) {
      const catalog = await port.call('list_agent_sessions', { limit: 1 })
      const first = catalog.content[0]
      if (first.type !== 'text' || catalog.isError) return { code: 'SESSION_CONTEXT_UNAVAILABLE', coverage: 'PARTIAL' }
      const revision = JSON.parse(first.text).revision
      const association = { sourceArtifactId: artifact.artifactId, artifactId, expectedCatalogRevision: revision, proofIds: proofIds.data,
        executionId: metadata.executionId, commitSha: metadata.commitSha, pullRequest: metadata.pullRequest }
      const result = await port.call('refresh_agent_sessions', { ...target, sessionId: link.sessionId, association })
      const block = result.content[0]
      receipts.push(block.type === 'text' ? JSON.parse(block.text) : { code: 'SESSION_CONTEXT_UNAVAILABLE' })
    }
  }
  return { coverage: receipts.every(row => 'state' in row && row.state === 'PERSISTED') ? 'LINKED' : 'PARTIAL', evidence: 'HANDOFF_DECLARED', transcriptImported: false, receipts }
}
