import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson, normalizeMetadataValue, parseArtifactMarkdown } from './artifact-metadata'
import { ArtifactRevisionConflictError, type ArtifactStore } from './artifact-store'
import { editArtifactStatus, lifecyclePolicy, type LifecycleDependencies } from './artifact-lifecycle-policy'
import type { Artifact } from './continuum-types'
import type { ProofWithFreshness } from '../validation-ledger/validation-ledger-types'

export const lifecycleReasons = ['CRITERIA_ACCEPTED', 'CLOSURE_ACCEPTED', 'NORMATIVE_ACTIVATION', 'EXPLICIT_CANCELLATION', 'BLOCKAGE_CONFIRMED', 'IMPLEMENTATION_REVIEWED'] as const
export interface LifecycleRequest {
  action: 'ASSESS' | 'TRANSITION'
  artifactId: string
  expectedRevision: number
  toState: string
  reasonCode: typeof lifecycleReasons[number]
  evidenceRefs: string[]
  supportingArtifactId?: string
}
export interface LifecycleApproval {
  reviewDigest: string
  source: 'NATIVE_DESKTOP_CONFIRMATION' | 'AUTHENTICATED_AUTHORITY'
  principalId: string | null
  approvedAt: string
}
export interface LifecycleReview {
  repositoryId: string
  target: { artifactId: string; revision: number; contentHash: string; kind: string }
  supporting: { artifactId: string; revision: number; contentHash: string } | null
  toState: string
  reasonCode: LifecycleRequest['reasonCode']
  evidence: Array<{ proofId: string; digest: string; freshness: 'CURRENT' }>
  reviewDigest: string
}
export interface LifecycleReceipt {
  schemaVersion: 1
  transitionId: string
  requestDigest: string
  review: LifecycleReview
  approval: LifecycleApproval
  fromState: string | null
  revision: number
  contentHash: string
  digest: string
}
export function lifecycleDigest(value: unknown): string { return createHash('sha256').update(canonicalJson(normalizeMetadataValue(value))).digest('hex') }
export function lifecycleReceipt(artifact: Artifact): LifecycleReceipt | null {
  const value = artifact.provenance.lifecycle as unknown as LifecycleReceipt | undefined
  if (!value) return null
  try {
    const { digest, ...body } = value
    const { reviewDigest, ...review } = value.review
    if (value.schemaVersion !== 1 || lifecycleDigest(body) !== digest || lifecycleDigest(review) !== reviewDigest || value.approval.reviewDigest !== reviewDigest ||
      value.review.target.artifactId !== artifact.artifactId || value.revision !== artifact.revision || value.contentHash !== artifact.contentHash || value.review.toState !== artifact.metadata.status) return null
    return value
  } catch { return null }
}
const reasons: Record<string, LifecycleRequest['reasonCode']> = { VALIDATED: 'CRITERIA_ACCEPTED', COMPLETED: 'CLOSURE_ACCEPTED', ACTIVE: 'NORMATIVE_ACTIVATION', CANCELLED: 'EXPLICIT_CANCELLATION', BLOCKED: 'BLOCKAGE_CONFIRMED', IMPLEMENTED: 'IMPLEMENTATION_REVIEWED', NOT_IMPLEMENTED: 'IMPLEMENTATION_REVIEWED' }
const needsProof = new Set(['VALIDATED', 'COMPLETED', 'IMPLEMENTED'])

export async function transitionLifecycle(store: ArtifactStore, dependencies: LifecycleDependencies, request: LifecycleRequest, assertContext: () => void) {
  assertContext()
  const current = store.get(request.artifactId)
  if (!current) throw new Error('ARTIFACT_NOT_FOUND')
  const { action: _action, ...intent } = request
  const requestDigest = lifecycleDigest(intent)
  const priorReceipt = lifecycleReceipt(current)
  if (request.action === 'TRANSITION' && priorReceipt?.requestDigest === requestDigest) return { state: 'PERSISTED' as const, replayed: true, artifactId: current.artifactId, revision: current.revision, lifecycleReceipt: priorReceipt }
  if (current.revision !== request.expectedRevision) throw new ArtifactRevisionConflictError(current.artifactId, current.revision)
  if (request.action === 'ASSESS' && current.metadata.status === request.toState && current.provenance.lifecycle) {
    const evidence = await assessLifecycleEvidence(current, dependencies, store)
    assertContext()
    if (store.get(current.artifactId)?.revision !== current.revision) throw new Error('REVISION_CONFLICT')
    return { state: 'REVIEW_REQUIRED' as const, reason: 'HISTORICAL_APPROVAL_RECHECKED', artifactId: current.artifactId, revision: current.revision, evidence, lifecycleReceipt: priorReceipt }
  }
  const policy = lifecyclePolicy(current.metadata)
  const reviewRequired = (reason: string) => ({ state: 'REVIEW_REQUIRED' as const, reason, artifactId: current.artifactId, revision: current.revision })
  if (!policy || !(policy.transitions as readonly string[]).includes(request.toState) || reasons[request.toState] !== request.reasonCode) return reviewRequired('POLICY_OR_REASON_MISMATCH')
  let supporting: Artifact | null = null
  if (request.toState === 'COMPLETED') {
    const candidates = store.list({ relatedToArtifactId: current.artifactId, direction: 'inbound', relationKind: 'implements', kind: 'IMPLEMENTATION_HANDOFF', limit: 20 })
    const selected = request.supportingArtifactId ?? (candidates.artifacts.length === 1 && !candidates.nextCursor ? candidates.artifacts[0].artifactId : undefined)
    supporting = selected ? store.get(selected) : null
    if (!supporting || !supporting.metadata.relations?.some(r => r.kind === 'implements' && r.artifactId === current.artifactId) || supporting.metadata.kind !== 'IMPLEMENTATION_HANDOFF' || supporting.metadata.status !== 'VALIDATED' || !lifecycleReceipt(supporting)) return reviewRequired('VALIDATED_CLOSURE_REQUIRED')
    const acceptedTarget = lifecycleReceipt(supporting)!.review.supporting
    if (!acceptedTarget || acceptedTarget.artifactId !== current.artifactId || acceptedTarget.revision !== current.revision || acceptedTarget.contentHash !== current.contentHash) return reviewRequired('CLOSURE_TARGET_REVISION_STALE')
  } else if (request.toState === 'VALIDATED' && current.metadata.kind === 'IMPLEMENTATION_HANDOFF') {
    const targets = current.metadata.relations?.filter(r => r.kind === 'implements').map(r => store.get(r.artifactId)).filter((a): a is Artifact => !!a && lifecyclePolicy(a.metadata)?.key === 'WORK') ?? []
    supporting = request.supportingArtifactId ? targets.find(a => a.artifactId === request.supportingArtifactId) ?? null : targets.length === 1 ? targets[0] : null
    if (!supporting) return reviewRequired('UNAMBIGUOUS_IMPLEMENTATION_TARGET_REQUIRED')
  } else if (request.supportingArtifactId) return reviewRequired('UNEXPECTED_SUPPORTING_ARTIFACT')
  const inherited = supporting && request.toState === 'COMPLETED' ? lifecycleReceipt(supporting)!.review.evidence.map(p => p.proofId) : []
  let discovered: string[] = []
  if (!request.evidenceRefs.length && !inherited.length && needsProof.has(request.toState) && dependencies.proofsFor) {
    const candidates = (await Promise.all([current.artifactId, ...(supporting ? [supporting.artifactId] : [])].map(id => dependencies.proofsFor!(id)))).flat()
    assertContext()
    discovered = candidates.filter(p => p.status === 'PASSED' && p.freshness === 'CURRENT' && p.commandProfile?.source?.repositoryId === store.repositoryId && p.evidenceFor.some(id => id === current.artifactId || id === supporting?.artifactId)).slice(0, 10).map(p => p.proofId)
  }
  const proofIds = [...new Set([...request.evidenceRefs, ...inherited, ...discovered])].sort()
  if (needsProof.has(request.toState) && !proofIds.length) return reviewRequired('SCOPED_CURRENT_EVIDENCE_REQUIRED')
  const readProofs = async (): Promise<ProofWithFreshness[] | null> => {
    const proofs = await Promise.all(proofIds.map(id => dependencies.proof?.(id)))
    const targetIds = [current.artifactId, ...(supporting ? [supporting.artifactId] : [])]
    return proofs.every((p): p is ProofWithFreshness => !!p && p.status === 'PASSED' && p.freshness === 'CURRENT' &&
      p.commandProfile?.source?.repositoryId === store.repositoryId && p.evidenceFor.some(id => targetIds.includes(id))) ? proofs : null
  }
  const proofs = await readProofs()
  assertContext()
  if (!proofs) return reviewRequired('EVIDENCE_SCOPE_OR_FRESHNESS_UNVERIFIED')
  if (supporting && request.toState === 'COMPLETED' && lifecycleReceipt(supporting)!.review.evidence.some(ref => !proofs.some(p => p.proofId === ref.proofId && lifecycleDigest(p) === ref.digest))) return reviewRequired('CLOSURE_EVIDENCE_CHANGED')
  const snapshot = (artifact: Artifact) => ({ artifactId: artifact.artifactId, revision: artifact.revision, contentHash: artifact.contentHash })
  const reviewBody = { repositoryId: store.repositoryId, target: { ...snapshot(current), kind: current.metadata.kind }, supporting: supporting ? snapshot(supporting) : null, toState: request.toState, reasonCode: request.reasonCode,
    evidence: proofs.map(p => ({ proofId: p.proofId, digest: lifecycleDigest(p), freshness: 'CURRENT' as const })) }
  const review: LifecycleReview = { ...reviewBody, reviewDigest: lifecycleDigest(reviewBody) }
  if (request.action === 'ASSESS') return { ...reviewRequired('EXPLICIT_CRITERIA_APPROVAL_REQUIRED'), review }
  const approval = await dependencies.approve?.(structuredClone(review))
  assertContext()
  if (!approval || approval.reviewDigest !== review.reviewDigest || !['NATIVE_DESKTOP_CONFIRMATION', 'AUTHENTICATED_AUTHORITY'].includes(approval.source) ||
    (approval.source === 'AUTHENTICATED_AUTHORITY' && !approval.principalId) || (approval.source === 'NATIVE_DESKTOP_CONFIRMATION' && approval.principalId !== null) || !Number.isFinite(Date.parse(approval.approvedAt))) return reviewRequired('AUTHORITY_APPROVAL_REQUIRED')
  const freshProofs = await readProofs()
  assertContext()
  const reread = store.get(current.artifactId)!
  if (reread.revision !== current.revision) throw new ArtifactRevisionConflictError(current.artifactId, reread.revision)
  if (reread.contentHash !== current.contentHash || (supporting && lifecycleDigest(snapshot(store.get(supporting.artifactId)!)) !== lifecycleDigest(snapshot(supporting)))) return reviewRequired('ARTIFACT_CONTEXT_CHANGED')
  if (!freshProofs || lifecycleDigest(freshProofs) !== lifecycleDigest(proofs)) return reviewRequired('EVIDENCE_CHANGED_DURING_APPROVAL')
  const rawMarkdown = editArtifactStatus(current.rawMarkdown, request.toState)
  const receiptBody = { schemaVersion: 1 as const, transitionId: 'lifecycle-' + randomUUID(), requestDigest, review, approval, fromState: current.metadata.status ?? null,
    revision: current.revision + 1, contentHash: createHash('sha256').update(rawMarkdown).digest('hex') }
  const receipt: LifecycleReceipt = { ...receiptBody, digest: lifecycleDigest(receiptBody) }
  const published = store.updatePublished({ artifactId: current.artifactId, expectedRevision: current.revision, rawMarkdown, metadata: parseArtifactMarkdown(rawMarkdown, true).metadata,
    provenance: { lifecycle: normalizeMetadataValue(receipt) } }, requestDigest)
  if (!lifecycleReceipt(published.artifact)) throw new Error('LIFECYCLE_READBACK_INTEGRITY')
  return { state: 'PERSISTED' as const, replayed: false, artifactId: current.artifactId, revision: published.artifact.revision, lifecycleReceipt: receipt, publicationReceipt: published.publicationReceipt }
}

export async function assessLifecycleEvidence(artifact: Artifact, dependencies: LifecycleDependencies, store: ArtifactStore) {
  const receipt = lifecycleReceipt(artifact)
  if (!receipt) return { freshness: artifact.provenance.lifecycle ? 'SOURCE_STALE' : 'NOT_RECHECKED', evidenceRefs: [] as string[] }
  if (receipt.review.supporting) {
    const supporting = store.get(receipt.review.supporting.artifactId)
    if (!supporting || supporting.revision !== receipt.review.supporting.revision || supporting.contentHash !== receipt.review.supporting.contentHash) return { freshness: 'SOURCE_STALE', evidenceRefs: receipt.review.evidence.map(p => p.proofId) }
  }
  const proofs = await Promise.all(receipt.review.evidence.map(p => dependencies.proof?.(p.proofId)))
  return { evidenceRefs: receipt.review.evidence.map(p => p.proofId), freshness: proofs.every((p, i) => p?.status === 'PASSED' && p.freshness === 'CURRENT' && p.commandProfile?.source?.repositoryId === store.repositoryId && lifecycleDigest(p) === receipt.review.evidence[i].digest) ? 'CURRENT' : 'REVIEW_REQUIRED' }
}
