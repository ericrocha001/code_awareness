import { isMap, isScalar, parseDocument } from 'yaml'
import { parseArtifactMarkdown } from './artifact-metadata'
import type { Artifact, ArtifactMetadata } from './continuum-types'
const policies = {
  WORK: { initialState: 'PENDING', transitions: ['COMPLETED', 'CANCELLED'] },
  ATTESTATION: { initialState: undefined, transitions: ['VALIDATED', 'BLOCKED'] },
  NORMATIVE: { initialState: undefined, transitions: ['ACTIVE'] },
  IMPLEMENTATION: { initialState: undefined, transitions: ['IMPLEMENTED', 'NOT_IMPLEMENTED'] }
} as const
const kinds: Record<string, keyof typeof policies> = { EXECUTABLE_PLAN: 'WORK', WORK_ITEM: 'WORK', IMPLEMENTATION_HANDOFF: 'ATTESTATION', VALIDATION_PROOF: 'ATTESTATION', ARCHITECTURAL_DECISION: 'NORMATIVE', FEATURE_IDEA: 'IMPLEMENTATION' }
export function lifecyclePolicy(metadata: ArtifactMetadata) {
  const key = metadata.lifecyclePolicy ?? kinds[metadata.kind]
  return typeof key === 'string' && Object.hasOwn(policies, key) ? { key, ...policies[key as keyof typeof policies] } : undefined
}
export function editArtifactStatus(raw: string, status: string): string {
  if (!/^[A-Z][A-Z_]{1,63}$/.test(status)) throw new Error('INVALID_LIFECYCLE_STATE')
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
  if (!match) throw new Error('LIFECYCLE_FRONTMATTER_REQUIRED')
  const yaml = match[1], document = parseDocument(yaml)
  if (document.errors.length || !isMap(document.contents)) throw new Error('LIFECYCLE_YAML_UNEDITABLE')
  const pair = document.contents.items.find(item => isScalar(item.key) && item.key.value === 'status')
  let updated: string
  if (pair) {
    const range = pair.value && typeof pair.value === 'object' && 'range' in pair.value ? pair.value.range : null
    if (!range) throw new Error('LIFECYCLE_YAML_UNEDITABLE')
    updated = yaml.slice(0, range[0]) + status + yaml.slice(range[1])
  } else if (document.contents.flow) {
    const end = document.contents.range![1] - 1
    updated = yaml.slice(0, end) + (document.contents.items.length ? ', ' : '') + 'status: ' + status + yaml.slice(end)
  } else updated = yaml + (raw.includes('\r\n') ? '\r\n' : '\n') + 'status: ' + status
  const start = match[0].indexOf(yaml), result = raw.slice(0, start) + updated + raw.slice(start + yaml.length)
  const before = parseArtifactMarkdown(raw, true), after = parseArtifactMarkdown(result, true)
  const { status: _before, ...prior } = before.metadata, { status: _after, ...next } = after.metadata
  if (before.body !== after.body || JSON.stringify(prior) !== JSON.stringify(next) || after.metadata.status !== status) throw new Error('LIFECYCLE_YAML_UNEDITABLE')
  return result
}
export interface LifecycleActivity { state: 'IN_PROGRESS' | 'UNKNOWN'; source: string; evidenceRef?: string; observedAt?: string }
export interface LifecycleDependencies {
  activity?(repositoryId: string, artifactId: string): LifecycleActivity
  proof?(proofId: string): Promise<import('../validation-ledger/validation-ledger-types').ProofWithFreshness | null>
  proofsFor?(artifactId: string): Promise<import('../validation-ledger/validation-ledger-types').ProofWithFreshness[]>
  approve?(review: import('./artifact-lifecycle').LifecycleReview): Promise<import('./artifact-lifecycle').LifecycleApproval | null>
}
export function lifecycleProjection(artifact: Artifact, receipt?: import('./artifact-lifecycle').LifecycleReceipt | null) {
  const policy = lifecyclePolicy(artifact.metadata)
  return { schemaVersion: 1, policy: policy?.key ?? null, effectiveState: artifact.metadata.status ?? null,
    basis: receipt ? 'AUTHORIZED_TRANSITION' : !policy ? 'NO_LIFECYCLE_POLICY' : artifact.metadata.status === policy.initialState && policy.initialState ? 'INITIAL_STATE' : artifact.metadata.status ? 'AUTHOR_DECLARED' : 'NO_EDITORIAL_STATE',
    assessment: receipt ? 'APPROVED_AT_REVISION' : policy && artifact.metadata.status && artifact.metadata.status !== policy.initialState ? 'REVIEW_REQUIRED' : 'NOT_ASSESSED',
    evidenceRefs: receipt?.review.evidence.map(p => p.proofId) ?? [], assessedAt: receipt?.approval.approvedAt ?? null,
    evidenceMode: receipt ? receipt.review.evidenceMode ?? 'AUTO_VERIFIED' : null,
    attestation: receipt?.review.attestation ?? null,
    transitionId: receipt?.transitionId ?? null, reasonCode: receipt?.review.reasonCode ?? null, approval: receipt?.approval ?? null,
    revision: artifact.revision, freshness: artifact.provenance.lifecycle && !receipt ? 'SOURCE_STALE' : 'NOT_RECHECKED' }
}
export type ReturnLifecycleProjection = ReturnType<typeof lifecycleProjection>
