export type ProvenanceClass = 'DECLARED' | 'DERIVED' | 'OBSERVED' | 'VERIFIED_CAUSAL' | 'UNKNOWN'
export function provenanceClass(evidenceKind: string, state: string): ProvenanceClass {
  if (state === 'UNKNOWN' || state === 'STALE') return 'UNKNOWN'
  if (['CONTINUUM_TYPED_RELATION', 'HANDOFF_DECLARED'].includes(evidenceKind)) return 'DECLARED'
  if (['CONTINUUM_REFERENCE', 'CONTINUUM_REVISION', 'EXECUTION_MEMBERSHIP'].includes(evidenceKind)) return 'DERIVED'
  return ['NATIVE_ARTIFACT_CAUSAL', 'NATIVE_GIT_CAUSAL'].includes(evidenceKind) && state === 'VERIFIED' ? 'VERIFIED_CAUSAL' : 'OBSERVED'
}
