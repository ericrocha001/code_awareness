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
  nextEvidence: 'INSPECT_GIT_HOOKS' | 'INSPECT_CODEX_HOOKS' | 'INSPECT_ENTIRE_INTEGRATION' | 'INSPECT_PROVIDER_CONFIGURATION' | 'OBSERVE_SESSION_EVENTS' | 'INSPECT_CHECKPOINT_METADATA' | 'NONE'
  repairRequiresApproval: boolean
  agent?: string
  integrationState?: 'UNSUPPORTED' | 'READY_CONFIGURED' | 'HOOKS_MISSING'
  integrations?: { agent: string; surface: 'CLI' | 'AGENT'; hooks: 'READY' | 'HOOKS_MISSING'; state: string; coverage: string }[]
  hooks: { git: 'READY' | 'HOOK_MISSING' | 'HOOK_INCOMPATIBLE'; codex: 'READY' | 'HOOK_MISSING' | 'HOOK_INCOMPATIBLE' }
  capture: { state: 'OBSERVED' | 'UNOBSERVED'; providerSessionId?: string; agent?: string }
  checkpoint: { state: 'CHECKPOINT_VERIFIED' | 'CHECKPOINT_MISSING' | 'PENDING' | 'UNAVAILABLE' | 'NOT_APPLICABLE'; reason: string; checkpointId?: string; refRevision?: string; metadataDigest?: string; sessionIds?: string[]; sessionRefs?: { id: string; agent: string }[]; commitSha?: string }
}
