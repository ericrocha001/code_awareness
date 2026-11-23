import type Database from 'better-sqlite3'
import { digest, sanitize } from './privacy'
import { classifyStructuredOutput, extractTextValue } from './native-source-events'
import type { EventInput } from './types'

export type SkillObservationClass =
  | 'AVAILABLE_DISTRIBUTED'
  | 'DISCOVERED_MANIFEST_FETCHED'
  | 'CONTENT_DELIVERED'
  | 'ATTEMPT_FAILED_OR_REFUSED'

export type SkillScope = 'GLOBAL' | 'PROJECT' | 'UNKNOWN'
export type SkillVersionStatus = 'EXACT' | 'VERSION_UNKNOWN'
export type SkillSourceSurface = 'academy_mcp_skills' | 'academy_mcp_tool' | 'native_source_event'
export type SkillOperationStatus = 'SUCCESS' | 'FAILURE' | 'REFUSAL'
export type SkillBindingState = 'BOUND_BY_WITNESS' | 'UNBOUND'
export type SkillTimestampKind = 'SOURCE_TIMESTAMP' | 'CAPTURE_TIME' | 'INFERRED'
export type SkillCoverageState = 'SUPPORTED' | 'PARTIAL' | 'UNAVAILABLE'

export const SKILL_INTELLIGENCE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS skill_events(
    eventId TEXT PRIMARY KEY,
    sessionId TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    executionId TEXT,
    nativeSessionId TEXT,
    provider TEXT,
    worktreeId TEXT,
    generation TEXT,
    observationClass TEXT NOT NULL,
    skillId TEXT,
    skillName TEXT,
    skillScope TEXT NOT NULL,
    destinationId TEXT,
    version INTEGER,
    versionStatus TEXT NOT NULL,
    packageHash TEXT,
    resourceUri TEXT,
    resourcePath TEXT,
    resourceDigest TEXT,
    sourceSurface TEXT NOT NULL,
    sourceContract TEXT NOT NULL,
    originalEventId TEXT,
    operation TEXT NOT NULL,
    operationStatus TEXT NOT NULL,
    errorCode TEXT,
    sessionBindingState TEXT NOT NULL,
    bindingAuthority TEXT,
    captureOrder INTEGER NOT NULL DEFAULT 0,
    sourceTimestamp TEXT,
    observedAt TEXT NOT NULL,
    timestampKind TEXT NOT NULL,
    gapsJson TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS skill_events_session_idx ON skill_events(sessionId, captureOrder, eventId);
  CREATE INDEX IF NOT EXISTS skill_events_execution_idx ON skill_events(executionId, captureOrder, eventId);
  CREATE INDEX IF NOT EXISTS skill_events_native_idx ON skill_events(nativeSessionId, captureOrder, eventId);
  CREATE INDEX IF NOT EXISTS skill_events_skill_idx ON skill_events(skillId, version, captureOrder);
  CREATE TABLE IF NOT EXISTS skill_source_coverage(
    id TEXT PRIMARY KEY,
    sourceSurface TEXT NOT NULL,
    scopeKey TEXT NOT NULL,
    coverageState TEXT NOT NULL,
    reason TEXT,
    updatedAt TEXT NOT NULL
  );
`

export interface SkillEventInput {
  sessionId?: string | null
  executionId?: string | null
  nativeSessionId?: string | null
  provider?: string | null
  worktreeId?: string | null
  generation?: string | null
  observationClass: SkillObservationClass
  skillId?: string | null
  skillName?: string | null
  skillScope: SkillScope
  destinationId?: string | null
  version?: number | null
  versionStatus: SkillVersionStatus
  packageHash?: string | null
  resourceUri?: string | null
  resourcePath?: string | null
  resourceDigest?: string | null
  sourceSurface: SkillSourceSurface
  sourceContract: string
  originalEventId?: string | null
  operation: string
  operationStatus: SkillOperationStatus
  errorCode?: string | null
  sessionBindingState: SkillBindingState
  bindingAuthority?: string | null
  captureOrder?: number
  sourceTimestamp?: string | null
  observedAt?: string
  timestampKind?: SkillTimestampKind
  gaps?: string[]
  revision?: number
}

export interface SkillEventRecord {
  eventId: string
  sessionId: string | null
  executionId: string | null
  nativeSessionId: string | null
  provider: string | null
  worktreeId: string | null
  generation: string | null
  observationClass: SkillObservationClass
  skillId: string | null
  skillName: string | null
  skillScope: SkillScope
  destinationId: string | null
  version: number | null
  versionStatus: SkillVersionStatus
  packageHash: string | null
  resourceUri: string | null
  resourcePath: string | null
  resourceDigest: string | null
  sourceSurface: SkillSourceSurface
  sourceContract: string
  originalEventId: string | null
  operation: string
  operationStatus: SkillOperationStatus
  errorCode: string | null
  sessionBindingState: SkillBindingState
  bindingAuthority: string | null
  captureOrder: number
  sourceTimestamp: string | null
  observedAt: string
  timestampKind: SkillTimestampKind
  gaps: string[]
  revision: number
}

export interface SkillSourceCoverageRecord {
  sourceSurface: string
  scopeKey: string
  coverageState: SkillCoverageState
  reason: string | null
  updatedAt: string
}

export interface SkillEventQuery {
  sessionId?: string
  executionId?: string
  nativeSessionId?: string
  skillId?: string
  includeUnbound?: boolean
  offset?: number
  limit?: number
}

export interface SkillEventQueryResult {
  events: SkillEventRecord[]
  total: number
  offset: number
  hasMore: boolean
  unboundCount: number
  coverage: SkillSourceCoverageRecord[]
  revision: number
}

const MAX_QUERY_LIMIT = 50

function computeSkillEventId(input: SkillEventInput, revision: number): string {
  const invocationKey = input.originalEventId ?? `${input.operation}:${input.captureOrder ?? 0}:${input.sourceTimestamp ?? ''}`
  const resourceKey = input.resourceUri ?? input.resourcePath ?? input.skillId ?? 'catalog'
  return `skill_evt_${digest(JSON.stringify([
    input.sourceSurface,
    invocationKey,
    resourceKey,
    revision,
    input.operationStatus
  ]))}`
}

function rowToRecord(row: Record<string, unknown>): SkillEventRecord {
  let gaps: string[] = []
  try {
    const parsed = JSON.parse(String(row.gapsJson ?? '[]'))
    if (Array.isArray(parsed)) gaps = parsed.filter((g): g is string => typeof g === 'string')
  } catch {}
  return {
    eventId: String(row.eventId),
    sessionId: typeof row.sessionId === 'string' ? row.sessionId : null,
    executionId: typeof row.executionId === 'string' ? row.executionId : null,
    nativeSessionId: typeof row.nativeSessionId === 'string' ? row.nativeSessionId : null,
    provider: typeof row.provider === 'string' ? row.provider : null,
    worktreeId: typeof row.worktreeId === 'string' ? row.worktreeId : null,
    generation: typeof row.generation === 'string' ? row.generation : null,
    observationClass: row.observationClass as SkillObservationClass,
    skillId: typeof row.skillId === 'string' ? row.skillId : null,
    skillName: typeof row.skillName === 'string' ? row.skillName : null,
    skillScope: (row.skillScope as SkillScope) ?? 'UNKNOWN',
    destinationId: typeof row.destinationId === 'string' ? row.destinationId : null,
    version: typeof row.version === 'number' ? row.version : null,
    versionStatus: (row.versionStatus as SkillVersionStatus) ?? 'VERSION_UNKNOWN',
    packageHash: typeof row.packageHash === 'string' ? row.packageHash : null,
    resourceUri: typeof row.resourceUri === 'string' ? row.resourceUri : null,
    resourcePath: typeof row.resourcePath === 'string' ? row.resourcePath : null,
    resourceDigest: typeof row.resourceDigest === 'string' ? row.resourceDigest : null,
    sourceSurface: row.sourceSurface as SkillSourceSurface,
    sourceContract: String(row.sourceContract),
    originalEventId: typeof row.originalEventId === 'string' ? row.originalEventId : null,
    operation: String(row.operation),
    operationStatus: row.operationStatus as SkillOperationStatus,
    errorCode: typeof row.errorCode === 'string' ? row.errorCode : null,
    sessionBindingState: row.sessionBindingState as SkillBindingState,
    bindingAuthority: typeof row.bindingAuthority === 'string' ? row.bindingAuthority : null,
    captureOrder: typeof row.captureOrder === 'number' ? row.captureOrder : 0,
    sourceTimestamp: typeof row.sourceTimestamp === 'string' ? row.sourceTimestamp : null,
    observedAt: String(row.observedAt),
    timestampKind: (row.timestampKind as SkillTimestampKind) ?? 'CAPTURE_TIME',
    gaps,
    revision: typeof row.revision === 'number' ? row.revision : 1
  }
}

function parseJsonSafe(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export class SkillIntelligenceStore {
  constructor(private readonly db: Database.Database) {}

  recordSkillEvent(input: SkillEventInput): { eventId: string; inserted: boolean; revision: number } {
    const revision = input.revision && input.revision >= 1 ? input.revision : 1
    const eventId = computeSkillEventId(input, revision)
    const bound = input.sessionBindingState === 'BOUND_BY_WITNESS'
    const sessionId = bound && input.sessionId ? input.sessionId : null
    const executionId = bound && input.executionId ? input.executionId : null
    const nativeSessionId = bound && input.nativeSessionId ? input.nativeSessionId : null
    const gaps = new Set<string>(input.gaps ?? [])
    if (!bound) gaps.add('SESSION_BINDING_UNAVAILABLE')
    if (input.versionStatus === 'VERSION_UNKNOWN') gaps.add('VERSION_UNKNOWN')

    const observedAt = input.observedAt ?? new Date().toISOString()
    const timestampKind: SkillTimestampKind = input.timestampKind ?? (input.sourceTimestamp ? 'SOURCE_TIMESTAMP' : 'CAPTURE_TIME')
    const info = this.db.prepare(`
      INSERT OR IGNORE INTO skill_events(
        eventId, sessionId, executionId, nativeSessionId, provider, worktreeId, generation,
        observationClass, skillId, skillName, skillScope, destinationId, version, versionStatus,
        packageHash, resourceUri, resourcePath, resourceDigest, sourceSurface, sourceContract,
        originalEventId, operation, operationStatus, errorCode, sessionBindingState, bindingAuthority,
        captureOrder, sourceTimestamp, observedAt, timestampKind, gapsJson, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      sessionId,
      executionId,
      nativeSessionId,
      input.provider ?? null,
      bound ? (input.worktreeId ?? null) : null,
      bound ? (input.generation ?? null) : null,
      input.observationClass,
      input.skillId ? sanitize(input.skillId) : null,
      input.skillName ? sanitize(input.skillName) : null,
      input.skillScope,
      input.destinationId ?? null,
      typeof input.version === 'number' && Number.isSafeInteger(input.version) && input.version >= 1 ? input.version : null,
      input.versionStatus,
      input.packageHash ?? null,
      input.resourceUri ? sanitize(input.resourceUri) : null,
      input.resourcePath ? sanitize(input.resourcePath) : null,
      input.resourceDigest ?? null,
      input.sourceSurface,
      input.sourceContract,
      input.originalEventId ?? null,
      input.operation,
      input.operationStatus,
      input.errorCode ?? null,
      bound ? 'BOUND_BY_WITNESS' : 'UNBOUND',
      bound ? (input.bindingAuthority ?? 'witness') : null,
      input.captureOrder ?? 0,
      input.sourceTimestamp ?? null,
      observedAt,
      timestampKind,
      JSON.stringify([...gaps]),
      revision
    )

    return { eventId, inserted: info.changes > 0, revision }
  }

  recordSourceCoverage(
    sourceSurface: SkillSourceSurface | string,
    scopeKey: string,
    coverageState: SkillCoverageState,
    reason?: string
  ): void {
    const id = digest(JSON.stringify([sourceSurface, scopeKey]))
    this.db.prepare(`
      INSERT INTO skill_source_coverage(id, sourceSurface, scopeKey, coverageState, reason, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        coverageState = excluded.coverageState,
        reason = excluded.reason,
        updatedAt = excluded.updatedAt
    `).run(id, sourceSurface, scopeKey, coverageState, reason ?? null, new Date().toISOString())
  }

  extractFromNativeEvents(
    sessionId: string,
    events: Array<EventInput & { callId?: string; content?: unknown; eventId?: string; ordinal?: number }>,
    context?: { executionId?: string; nativeSessionId?: string; provider?: string; worktreeId?: string; generation?: string }
  ): number {
    const callsById = new Map<string, EventInput & { callId?: string; content?: unknown; eventId?: string; ordinal?: number }>()
    for (const ev of events) {
      if (ev.type === 'TOOL_CALL' && ev.callId) {
        callsById.set(ev.callId, ev)
      }
    }

    let recorded = 0
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]
      if (ev.type !== 'TOOL_CALL' && ev.type !== 'TOOL_RESULT') continue
      const toolName = ev.tool ?? (ev.callId ? callsById.get(ev.callId)?.tool : undefined)
      if (!toolName) continue

      const isSkillTool =
        toolName === 'get_academy_skill' ||
        toolName === 'get_academy_skill_history' ||
        toolName === 'list_academy_skills' ||
        toolName === 'skills/get' ||
        toolName === 'skills/list' ||
        toolName === 'resources/read'

      if (!isSkillTool) continue

      // Pair TOOL_CALL with its TOOL_RESULT when possible; skip standalone TOOL_CALL if a TOOL_RESULT exists for the same callId
      if (ev.type === 'TOOL_CALL' && ev.callId && events.some(other => other.type === 'TOOL_RESULT' && other.callId === ev.callId)) {
        continue
      }

      const callEv = ev.type === 'TOOL_RESULT' && ev.callId ? callsById.get(ev.callId) : ev
      const callArgs = callEv ? parseJsonSafe(extractTextValue(callEv.content)) : undefined
      const resultObj = ev.type === 'TOOL_RESULT' ? parseJsonSafe(extractTextValue(ev.content)) : undefined
      const uri = typeof callArgs?.uri === 'string' ? callArgs.uri : (typeof resultObj?.uri === 'string' ? resultObj.uri : undefined)

      // For resources/read, only qualify explicit skill:// URIs
      if (toolName === 'resources/read' && (!uri || !uri.startsWith('skill://'))) {
        continue
      }

      const rawOutput = ev.type === 'TOOL_RESULT' ? extractTextValue(ev.content) : ''
      const statusInfo = ev.type === 'TOOL_RESULT'
        ? classifyStructuredOutput(rawOutput)
        : { isError: false, status: 'SUCCESS' as const }

      const skillId =
        typeof callArgs?.skillId === 'string' ? callArgs.skillId :
        typeof resultObj?.id === 'string' ? resultObj.id :
        typeof resultObj?.skillId === 'string' ? resultObj.skillId :
        undefined

      const versionRaw = resultObj?.currentVersion ?? resultObj?.version ?? callArgs?.version
      const version = typeof versionRaw === 'number' && Number.isSafeInteger(versionRaw) && versionRaw >= 1 ? versionRaw : null
      const packageHash =
        typeof resultObj?.packageHash === 'string' ? resultObj.packageHash :
        (resultObj?.current && typeof resultObj.current === 'object' && typeof (resultObj.current as Record<string, unknown>).packageHash === 'string'
          ? String((resultObj.current as Record<string, unknown>).packageHash)
          : null)

      const scopeRaw = resultObj?.scope
      const skillScope: SkillScope = scopeRaw === 'GLOBAL' || scopeRaw === 'PROJECT'
        ? scopeRaw
        : uri?.startsWith('skill://global/')
          ? 'GLOBAL'
          : uri?.startsWith('skill://project/')
            ? 'PROJECT'
            : 'UNKNOWN'

      let observationClass: SkillObservationClass
      if (statusInfo.isError) {
        observationClass = 'ATTEMPT_FAILED_OR_REFUSED'
      } else if (toolName === 'list_academy_skills' || toolName === 'skills/list' || toolName === 'skills/get') {
        observationClass = 'DISCOVERED_MANIFEST_FETCHED'
      } else {
        observationClass = 'CONTENT_DELIVERED'
      }

      const operationStatus: SkillOperationStatus =
        statusInfo.status === 'REFUSAL' ? 'REFUSAL' : statusInfo.isError ? 'FAILURE' : 'SUCCESS'

      this.recordSkillEvent({
        sessionId,
        executionId: context?.executionId ?? null,
        nativeSessionId: context?.nativeSessionId ?? null,
        provider: context?.provider ?? null,
        worktreeId: context?.worktreeId ?? null,
        generation: context?.generation ?? null,
        observationClass,
        skillId: skillId ?? null,
        skillScope,
        version,
        versionStatus: version !== null ? 'EXACT' : 'VERSION_UNKNOWN',
        packageHash,
        resourceUri: uri ?? null,
        sourceSurface: 'native_source_event',
        sourceContract: 'native-source-events/v1',
        originalEventId: ev.eventId ?? ev.callId ?? `native:${i}`,
        operation: toolName,
        operationStatus,
        errorCode: statusInfo.errorKind ?? null,
        sessionBindingState: 'BOUND_BY_WITNESS',
        bindingAuthority: 'native_session_ingest',
        captureOrder: ev.ordinal ?? i + 1,
        sourceTimestamp: ev.timestamp ?? null,
        timestampKind: ev.timestamp ? 'SOURCE_TIMESTAMP' : 'CAPTURE_TIME'
      })
      recorded++
    }

    if (recorded > 0) {
      this.recordSourceCoverage('native_source_event', sessionId, 'SUPPORTED')
    }
    return recorded
  }

  querySkillEvents(filter: SkillEventQuery = {}): SkillEventQueryResult {
    const hasTable = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='skill_events'").get()
    if (!hasTable) {
      return { events: [], total: 0, offset: Math.max(0, filter.offset ?? 0), hasMore: false, unboundCount: 0, coverage: [], revision: 1 }
    }
    const offset = Math.max(0, filter.offset ?? 0)
    const limit = Math.min(MAX_QUERY_LIMIT, Math.max(1, filter.limit ?? 15))
    const where: string[] = []
    const params: Array<string | number> = []

    const hasTarget = Boolean(filter.sessionId || filter.executionId || filter.nativeSessionId)
    if (hasTarget) {
      where.push("sessionBindingState = 'BOUND_BY_WITNESS'")
      const targetClauses: string[] = []
      if (filter.sessionId) {
        targetClauses.push('sessionId = ?')
        params.push(filter.sessionId)
      }
      if (filter.executionId) {
        targetClauses.push('executionId = ?')
        params.push(filter.executionId)
      }
      if (filter.nativeSessionId) {
        targetClauses.push('nativeSessionId = ?')
        params.push(filter.nativeSessionId)
      }
      where.push(`(${targetClauses.join(' OR ')})`)
    } else if (!filter.includeUnbound) {
      where.push("sessionBindingState = 'BOUND_BY_WITNESS'")
    }

    if (filter.skillId) {
      where.push('skillId = ?')
      params.push(filter.skillId)
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS n FROM skill_events ${whereSql}`).get(...params) as { n: number }
    const rows = this.db.prepare(
      `SELECT * FROM skill_events ${whereSql} ORDER BY captureOrder ASC, observedAt ASC, eventId ASC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Array<Record<string, unknown>>

    const unboundRow = this.db.prepare(
      `SELECT COUNT(*) AS n FROM skill_events WHERE sessionBindingState = 'UNBOUND'${filter.skillId ? ' AND skillId = ?' : ''}`
    ).get(...(filter.skillId ? [filter.skillId] : [])) as { n: number }

    const coverageRows = this.db.prepare(
      `SELECT sourceSurface, scopeKey, coverageState, reason, updatedAt FROM skill_source_coverage ORDER BY updatedAt DESC LIMIT 20`
    ).all() as SkillSourceCoverageRecord[]

    const events = rows.map(rowToRecord)
    const scopeRevRows = this.db.prepare(
      `SELECT eventId, revision FROM skill_events ${whereSql} ORDER BY captureOrder ASC, observedAt ASC, eventId ASC`
    ).all(...params) as Array<{ eventId: string; revision: number }>
    const revSeed = scopeRevRows.map(e => `${e.eventId}:${e.revision}`).join('|')
    const revision = parseInt(digest(`${totalRow.n}:${unboundRow.n}:${revSeed}`).slice(0, 12), 16) || 1

    return {
      events,
      total: totalRow.n,
      offset,
      hasMore: offset + events.length < totalRow.n,
      unboundCount: unboundRow.n,
      coverage: coverageRows,
      revision
    }
  }

  summarizeSession(sessionId: string, options?: { skillId?: string; offset?: number; limit?: number }): SkillEventQueryResult {
    return this.querySkillEvents({
      sessionId,
      skillId: options?.skillId,
      offset: options?.offset,
      limit: options?.limit
    })
  }
}
