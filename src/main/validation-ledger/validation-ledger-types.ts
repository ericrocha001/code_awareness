export type ProofKind =
  | 'TARGETED_TEST'
  | 'SUBSYSTEM_TEST'
  | 'FULL_TEST_SUITE'
  | 'TYPECHECK'
  | 'BUILD'
  | 'E2E'
  | 'MANUAL_ACCEPTANCE'

export type ProofProducer = 'IMPLEMENTER' | 'ARCHITECT' | 'USER' | 'SYSTEM' | 'TESTER'

export type ProofStatus = 'PASSED' | 'FAILED' | 'ERROR'

export type ProofFreshness =
  | 'CURRENT'
  | 'SOURCE_STALE'
  | 'RUNTIME_HISTORICAL'
  | 'UNVERIFIABLE'

export interface ProofMetrics {
  testFilesPassed?: number
  testFilesFailed?: number
  testsPassed?: number
  testsFailed?: number
  testsSkipped?: number
  durationMs?: number
  [key: string]: number | undefined
}

export interface CommandProfile {
  command: string
  args?: string[]
  cwd?: string
  exitCode?: number
}

export interface ValidationProof {
  proofId: string
  kind: ProofKind
  producer: ProofProducer
  status: ProofStatus
  startedAt: string
  finishedAt: string
  durationMs: number
  scope: string[]
  sourceFingerprint: string | null
  runtimeInstanceId: string | null
  summary: string
  metrics: ProofMetrics | null
  commandProfile: CommandProfile | null
  evidenceFor: string[]
  deduplicationKey: string | null
  recordedAt: string
}

export interface ValidationRequirement {
  requirementId: string
  description: string
  kind: ProofKind
  scope: string[]
  criticality: 'REQUIRED' | 'RECOMMENDED' | 'INFORMATIONAL'
}

export interface RecordProofInput {
  kind: ProofKind
  producer: ProofProducer
  status: ProofStatus
  startedAt: string
  finishedAt: string
  durationMs: number
  scope: string[]
  sourceFingerprint?: string | null
  runtimeInstanceId?: string | null
  summary: string
  metrics?: ProofMetrics | null
  commandProfile?: CommandProfile | null
  evidenceFor?: string[]
  deduplicationKey?: string | null
}

export interface ListProofsFilter {
  status?: ProofStatus
  kind?: ProofKind
  producer?: ProofProducer
  requirementId?: string
  freshness?: ProofFreshness
  limit?: number
}

export interface ProofWithFreshness extends ValidationProof {
  freshness: ProofFreshness
}
