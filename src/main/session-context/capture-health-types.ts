export interface CaptureHealthObservation {
  version: 1
  repositoryId: string
  worktreeId: string
  generation: string
  cycleId: string
  head: string
  configurationDigest: string
  policyDigest: string
  sourceFingerprint: string
  observedAt: string
  state: 'READY_CONFIGURED' | 'CAPTURE_OBSERVED' | 'UNAVAILABLE'
  reason: string
  nextEvidence: 'INSPECT_GIT_HOOKS' | 'INSPECT_CODEX_HOOKS' | 'INSPECT_PROVIDER_CONFIGURATION' | 'OBSERVE_SESSION_EVENTS' | 'INSPECT_CHECKPOINT_METADATA' | 'NONE'
  repairRequiresApproval: boolean
  hooks: { git: 'READY' | 'HOOK_MISSING' | 'HOOK_INCOMPATIBLE'; codex: 'READY' | 'HOOK_MISSING' | 'HOOK_INCOMPATIBLE' }
  capture: { state: 'OBSERVED' | 'UNOBSERVED'; providerSessionId?: string }
  checkpoint: { state: 'CHECKPOINT_VERIFIED' | 'CHECKPOINT_MISSING' | 'PENDING' | 'UNAVAILABLE' | 'NOT_APPLICABLE'; reason: string; checkpointId?: string; refRevision?: string; metadataDigest?: string; sessionIds?: string[]; commitSha?: string }
}
