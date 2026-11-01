export const EVENT_TYPES = ['INPUT', 'AGENT_UPDATE', 'TOOL_CALL', 'TOOL_RESULT', 'ERROR', 'CHANGE', 'VALIDATION', 'COMMIT', 'OTHER'] as const
export type EventType = typeof EVENT_TYPES[number]
export type Coverage = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE'
export type SessionState = 'ACTIVE' | 'ENDED' | 'UNKNOWN' | 'PARTIAL'
export const COVERAGE_REASON_CODES = ['INVALID_RECORD', 'UNKNOWN_RECORD', 'LINE_LIMIT', 'IMPORT_LIMIT', 'EVENT_LIMIT', 'STREAM_LIMIT', 'PAYLOAD_LIMIT', 'PAYLOAD_UNAVAILABLE', 'PAYLOAD_REDACTED', 'TRANSCRIPT_NOT_IMPORTED', 'SOURCE_COVERAGE_INCOMPLETE', 'LEGACY_COVERAGE_UNEXPLAINED', 'STREAM_UNAVAILABLE', 'SOURCE_IDENTITY_CONFLICT', 'SOURCE_IDENTITY_UNAVAILABLE', 'INVALID_SESSION_METADATA', 'SOURCE_PATH_UNAVAILABLE', 'FOREIGN_SOURCE', 'SESSION_LIMIT'] as const
export type CoverageReason = typeof COVERAGE_REASON_CODES[number]
export type CoverageReasons = Partial<Record<CoverageReason, number>>
export type ImportState = 'UNKNOWN' | 'METADATA_ONLY' | 'TRANSCRIPT_IMPORTED'
export interface SourceObservation {
  identity: 'VERIFIED' | 'UNKNOWN'
  streamTime: {
    first?: string
    last?: string
    timestampedRecords: number
    missingTimestamps: number
    invalidTimestamps: number
    windowRelation: 'WITHIN_PROVIDER_WINDOW' | 'OUTSIDE_PROVIDER_WINDOW' | 'UNAVAILABLE'
  }
}
export interface SessionInput {
  sourceObservation?: SourceObservation
  importState?: ImportState
  coverageReasons?: CoverageReasons
  providerSessionId: string
  providerVersion: string
  agent: 'codex'
  startedAt?: string
  endedAt?: string
  state: SessionState
  coverage: Coverage
  sourceDigest: string
  sourceBytes: number
}
export interface EventInput {
  type: EventType
  timestamp?: string
  tool?: string
  success?: boolean
  text?: string
  files?: string[]
  sourcePosition: number
  providerEventId?: string
  omission?: 'LIMIT_REACHED' | 'REDACTED' | 'UNAVAILABLE'
}
export interface SessionRow {
  id: string; providerSessionId: string; providerVersion: string; agent: string
  startedAt: string | null; endedAt: string | null; lastObserved: string
  state: SessionState; coverage: Coverage; revision: number; eventCount: number; payloadBytes: number
  sourceDigest: string; sourceBytes: number; sourceObservation: string; importState: ImportState; coverageReasons: string
}
export interface EventRow {
  id: string; ordinal: number; type: EventType; timestamp: string | null; tool: string | null
  success: number | null; summary: string; files: string; sourcePosition: number
  digest: string; bytes: number; omission: string | null; sanitized: number
}
export const LIMITS = Object.freeze({ sessions: 500, event: 32 * 1024, session: 8 * 1024 * 1024, repository: 512 * 1024 * 1024, events: 20_000, import: 32 * 1024 * 1024 })
