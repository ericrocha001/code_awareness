export type ProvenanceStatus = 'checkpoint' | 'commit' | 'uncommitted' | 'unavailable'
export type LinkStrength = 'TRAILER_VERIFIED' | 'RECORDED_LINK_UNVERIFIED' | 'UNKNOWN'
export type PromptScope = 'SESSION' | 'CHECKPOINT' | 'UNKNOWN'
export type PromptField = 'STORED_PROMPT' | 'INTENT'
export type CheckpointLinkOrigin = 'TRAILER_VERIFIED' | 'EXPLICIT_SELECTION'

export interface CodeProvenanceSegment {
  startLine: number
  endLine: number
  lineCount: number
  status: ProvenanceStatus
  commit?: string | null
  author?: string
  authorTime?: string
  summary?: string
  checkpointId?: string | null
}

export interface CodeProvenanceCandidate {
  sessionIndex: number
  providerSessionId?: string
  agent?: string
  model?: string
  createdAt?: string
  fileMatch?: boolean
  sessionFallback: boolean
  promptAvailable: boolean
  intentAvailable: boolean
  promptScope: PromptScope
  linkOrigin: CheckpointLinkOrigin
}

export interface InspectCodeProvenanceMapResult {
  source: 'GIT_BLAME_PROVENANCE'
  file: string
  range: { startLine: number; endLine: number }
  segments: CodeProvenanceSegment[]
  coverage: 'COMPLETE' | 'PARTIAL'
  associationCoverage: 'TRAILER_ONLY'
}

export interface InspectCodeProvenanceDetailResult {
  source: 'GIT_BLAME_PROVENANCE'
  file: string
  range: { startLine: number; endLine: number }
  linkStrength: LinkStrength
  commit?: string | null
  checkpointId?: string | null
  candidates: CodeProvenanceCandidate[]
  coverage: 'COMPLETE' | 'PARTIAL'
}

export interface InspectCheckpointMetadataResult {
  source: 'ENTIRE_CHECKPOINT_LOCAL'
  checkpointId: string
  commit?: string
  linkSource: CheckpointLinkOrigin
  cliVersion?: string
  branch?: string
  createdAt?: string
  sessionsCount: number
  filesTouched: string[]
  tokenUsage?: Record<string, number>
  redaction?: Record<string, unknown>
  coverage: 'COMPLETE' | 'PARTIAL'
}

export interface InspectCheckpointDisambiguateResult {
  source: 'ENTIRE_CHECKPOINT_LOCAL'
  checkpointId: string
  commit?: string
  sessions: Array<CodeProvenanceCandidate & { promptPreview?: string; isPreview?: boolean }>
  coverage: 'COMPLETE' | 'PARTIAL'
}

export interface InspectCheckpointReadFieldResult {
  source: 'STORED_PROMPT' | 'INTENT_FALLBACK' | 'REVIEW_PROMPT' | 'UNKNOWN'
  promptScope: PromptScope
  checkpointId: string
  sessionIndex: number
  field: PromptField
  promptIndex: number
  promptCount: number
  content: string
  range: { startByte: number; endByte: number }
  totalBytes: number
  complete: boolean
  truncated: boolean
  nextCursor?: string
  sanitized: boolean
  provenance: 'OBSERVED_FROM_CHECKPOINT_REF'
  untrusted: true
}
