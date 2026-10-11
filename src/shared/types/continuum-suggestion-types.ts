export interface ContinuumSuggestionQuery {
  artifactId: string
  limit?: number
  expectedSourceRevision?: number
  expectedGraphRevision?: number
}
export type ContinuumSuggestionReason =
  | { signal: 'shared-terms'; terms: string[] }
  | { signal: 'shared-neighbor'; artifactIds: string[] }
  | { signal: 'shared-metadata'; key: string; value: string | number | boolean }
  | { signal: 'shared-execution'; executionId: string }
  | { signal: 'same-kind'; kind: string }
export interface ContinuumSuggestion {
  targetArtifactId: string
  name: string
  kind: string
  targetRevision: number
  origin: 'SUGGESTED'
  proposedKind: 'related-to'
  score: number
  reasons: ContinuumSuggestionReason[]
}
export interface ContinuumSuggestions {
  repositoryId: string
  sourceArtifactId: string
  sourceRevision: number
  graphRevision: number
  projectionVersion: number
  referenceIndexVersion: number
  freshness: 'CURRENT' | 'BACKFILL_PENDING'
  ranking: 'RELATIVE_EVIDENCE'
  limits: { candidateLimit: number; candidatesExamined: number; topN: number }
  truncated: boolean
  suggestions: ContinuumSuggestion[]
}
export interface ContinuumSuggestionRequest extends ContinuumSuggestionQuery { repositoryId: string }
