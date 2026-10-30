export const EVENT_TYPES = ['INPUT', 'AGENT_UPDATE', 'TOOL_CALL', 'TOOL_RESULT', 'ERROR', 'CHANGE', 'VALIDATION', 'COMMIT', 'OTHER'] as const
export type EventType = typeof EVENT_TYPES[number]
export type Coverage = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE'
export type SessionState = 'ACTIVE' | 'ENDED' | 'UNKNOWN' | 'PARTIAL'
export interface SessionInput {
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
  sourceDigest: string; sourceBytes: number
}
export interface EventRow {
  id: string; ordinal: number; type: EventType; timestamp: string | null; tool: string | null
  success: number | null; summary: string; files: string; sourcePosition: number
  digest: string; bytes: number; omission: string | null; sanitized: number
}
export const LIMITS = Object.freeze({ sessions: 500, event: 32 * 1024, session: 8 * 1024 * 1024, repository: 512 * 1024 * 1024, events: 20_000, import: 32 * 1024 * 1024 })
