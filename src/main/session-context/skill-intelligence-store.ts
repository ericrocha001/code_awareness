import type Database from 'better-sqlite3'
import { extractTextValue } from './native-source-events'
import { digest, sanitize } from './privacy'
import {
  extractSkillCallMetadata,
  qualifySkillToolObservation,
  resolveCanonicalSkillTool
} from './skill-intelligence-extractor'
import type { EventInput } from './types'

export type SkillObservationClass =
  | 'AVAILABLE_DISTRIBUTED'
  | 'DISCOVERED_MANIFEST_FETCHED'
  | 'CONTENT_DELIVERED'
  | 'ATTEMPT_FAILED_OR_REFUSED'
  | 'INDETERMINATE'

export type SkillDeliveryGranularity = 'FULL_PACKAGE' | 'FRAGMENT' | 'RESOURCE' | 'MANIFEST' | 'NONE'
export type SkillScope = 'GLOBAL' | 'PROJECT' | 'UNKNOWN'
export type SkillVersionStatus = 'EXACT' | 'VERSION_UNKNOWN'
export type SkillSourceSurface = 'academy_mcp_skills' | 'academy_mcp_tool' | 'native_source_event'
export type SkillOperationStatus = 'SUCCESS' | 'FAILURE' | 'REFUSAL' | 'UNKNOWN'
export type SkillBindingState = 'BOUND_BY_WITNESS' | 'UNBOUND'
export type SkillTimestampKind = 'SOURCE_TIMESTAMP' | 'CAPTURE_TIME' | 'INFERRED'
export type SkillCoverageState = 'SUPPORTED' | 'PARTIAL' | 'UNAVAILABLE'

export const SKILL_INTELLIGENCE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS skill_events(
    eventId TEXT PRIMARY KEY,
    sessionId TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    executionId TEXT,
    nativeSessionId TEXT,
    repositoryId TEXT,
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
    resourceSelector TEXT,
    resourceRangeJson TEXT,
    resourceDigest TEXT,
    deliveryGranularity TEXT,
    sourceSurface TEXT NOT NULL,
    sourceContract TEXT NOT NULL,
    sourceNamespace TEXT,
    sourceRevision INTEGER,
    callEventId TEXT,
    resultEventId TEXT,
    originalEventId TEXT,
    turnId TEXT,
    operation TEXT NOT NULL,
    operationStatus TEXT NOT NULL,
    errorCode TEXT,
    sessionBindingState TEXT NOT NULL,
    bindingAuthority TEXT,
    captureOrder INTEGER NOT NULL DEFAULT 0,
    sourceTimestamp TEXT,
    observedAt TEXT NOT NULL,
    timestampKind TEXT NOT NULL,
    extractorVersion TEXT,
    gapsJson TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS skill_events_session_idx ON skill_events(sessionId, captureOrder, eventId);
  CREATE INDEX IF NOT EXISTS skill_events_execution_idx ON skill_events(executionId, captureOrder, eventId);
  CREATE INDEX IF NOT EXISTS skill_events_native_idx ON skill_events(nativeSessionId, captureOrder, eventId);
  CREATE INDEX IF NOT EXISTS skill_events_skill_idx ON skill_events(skillId, version, captureOrder);
  CREATE INDEX IF NOT EXISTS skill_events_skill_hash_idx ON skill_events(skillId, packageHash, captureOrder);
  CREATE INDEX IF NOT EXISTS skill_events_source_rev_idx ON skill_events(sourceNamespace, sourceRevision);
  CREATE TABLE IF NOT EXISTS skill_source_coverage(
    id TEXT PRIMARY KEY,
    sourceSurface TEXT NOT NULL,
    scopeKey TEXT NOT NULL,
    coverageState TEXT NOT NULL,
    reason TEXT,
    updatedAt TEXT NOT NULL
  );
`

const SKILL_EVENTS_ADDITIVE_COLUMNS: ReadonlyArray<[string, string]> = [
  ['repositoryId', 'TEXT'],
  ['sourceRevision', 'INTEGER'],
  ['sourceNamespace', 'TEXT'],
  ['callEventId', 'TEXT'],
  ['resultEventId', 'TEXT'],
  ['turnId', 'TEXT'],
  ['resourceSelector', 'TEXT'],
  ['resourceRangeJson', 'TEXT'],
  ['deliveryGranularity', 'TEXT'],
  ['extractorVersion', 'TEXT']
]

export function ensureSkillIntelligenceSchema(db: Database.Database): void {
  db.exec(SKILL_INTELLIGENCE_SCHEMA)
  const existing = new Set(
    (db.prepare('PRAGMA table_info(skill_events)').all() as Array<{ name: string }>).map(c => c.name)
  )
  for (const [col, type] of SKILL_EVENTS_ADDITIVE_COLUMNS) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE skill_events ADD COLUMN ${col} ${type}`)
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS skill_events_skill_hash_idx ON skill_events(skillId, packageHash, captureOrder)')
  db.exec('CREATE INDEX IF NOT EXISTS skill_events_source_rev_idx ON skill_events(sourceNamespace, sourceRevision)')
}

export interface SkillEventInput {
  sessionId?: string | null
  executionId?: string | null
  nativeSessionId?: string | null
  repositoryId?: string | null
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
  resourceSelector?: string | null
  resourceRange?: Record<string, unknown> | null
  resourceDigest?: string | null
  deliveryGranularity?: SkillDeliveryGranularity | null
  sourceSurface: SkillSourceSurface
  sourceContract: string
  sourceNamespace?: string | null
  sourceRevision?: number | null
  callEventId?: string | null
  resultEventId?: string | null
  originalEventId?: string | null
  turnId?: string | null
  operation: string
  operationStatus: SkillOperationStatus
  errorCode?: string | null
  sessionBindingState: SkillBindingState
  bindingAuthority?: string | null
  captureOrder?: number
  sourceTimestamp?: string | null
  observedAt?: string
  timestampKind?: SkillTimestampKind
  extractorVersion?: string | null
  gaps?: string[]
  revision?: number
}

export interface SkillEventRecord {
  eventId: string
  sessionId: string | null
  executionId: string | null
  nativeSessionId: string | null
  repositoryId: string | null
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
  resourceSelector: string | null
  resourceRange: Record<string, unknown> | null
  resourceDigest: string | null
  deliveryGranularity: SkillDeliveryGranularity | null
  sourceSurface: SkillSourceSurface
  sourceContract: string
  sourceNamespace: string | null
  sourceRevision: number | null
  callEventId: string | null
  resultEventId: string | null
  originalEventId: string | null
  turnId: string | null
  operation: string
  operationStatus: SkillOperationStatus
  errorCode: string | null
  sessionBindingState: SkillBindingState
  bindingAuthority: string | null
  captureOrder: number
  sourceTimestamp: string | null
  observedAt: string
  timestampKind: SkillTimestampKind
  extractorVersion: string | null
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
  repositoryId?: string
  skillId?: string
  version?: number
  packageHash?: string
  sourceNamespace?: string
  sourceRevision?: number
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
  const namespaceKey = input.sourceNamespace ?? input.nativeSessionId ?? input.sessionId ?? ''
  const invocationKey =
    input.callEventId || input.resultEventId
      ? `${input.callEventId ?? ''}:${input.resultEventId ?? ''}`
      : (input.originalEventId ?? `${input.operation}:${input.captureOrder ?? 0}:${input.sourceTimestamp ?? ''}`)
  const resourceKey = input.resourceUri ?? input.resourcePath ?? input.resourceSelector ?? input.skillId ?? 'catalog'
  return `skill_evt_${digest(JSON.stringify([
    input.sourceSurface,
    namespaceKey,
    input.sourceRevision ?? null,
    invocationKey,
    resourceKey,
    input.resourceSelector ?? null,
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
  let resourceRange: Record<string, unknown> | null = null
  if (typeof row.resourceRangeJson === 'string' && row.resourceRangeJson.length > 0) {
    try {
      const parsedRange = JSON.parse(row.resourceRangeJson)
      if (parsedRange && typeof parsedRange === 'object' && !Array.isArray(parsedRange)) {
        resourceRange = parsedRange as Record<string, unknown>
      }
    } catch {}
  }
  return {
    eventId: String(row.eventId),
    sessionId: typeof row.sessionId === 'string' ? row.sessionId : null,
    executionId: typeof row.executionId === 'string' ? row.executionId : null,
    nativeSessionId: typeof row.nativeSessionId === 'string' ? row.nativeSessionId : null,
    repositoryId: typeof row.repositoryId === 'string' ? row.repositoryId : null,
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
    resourceSelector: typeof row.resourceSelector === 'string' ? row.resourceSelector : null,
    resourceRange,
    resourceDigest: typeof row.resourceDigest === 'string' ? row.resourceDigest : null,
    deliveryGranularity: typeof row.deliveryGranularity === 'string' ? (row.deliveryGranularity as SkillDeliveryGranularity) : null,
    sourceSurface: row.sourceSurface as SkillSourceSurface,
    sourceContract: String(row.sourceContract),
    sourceNamespace: typeof row.sourceNamespace === 'string' ? row.sourceNamespace : null,
    sourceRevision: typeof row.sourceRevision === 'number' ? row.sourceRevision : null,
    callEventId: typeof row.callEventId === 'string' ? row.callEventId : null,
    resultEventId: typeof row.resultEventId === 'string' ? row.resultEventId : null,
    originalEventId: typeof row.originalEventId === 'string' ? row.originalEventId : null,
    turnId: typeof row.turnId === 'string' ? row.turnId : null,
    operation: String(row.operation),
    operationStatus: row.operationStatus as SkillOperationStatus,
    errorCode: typeof row.errorCode === 'string' ? row.errorCode : null,
    sessionBindingState: row.sessionBindingState as SkillBindingState,
    bindingAuthority: typeof row.bindingAuthority === 'string' ? row.bindingAuthority : null,
    captureOrder: typeof row.captureOrder === 'number' ? row.captureOrder : 0,
    sourceTimestamp: typeof row.sourceTimestamp === 'string' ? row.sourceTimestamp : null,
    observedAt: String(row.observedAt),
    timestampKind: (row.timestampKind as SkillTimestampKind) ?? 'CAPTURE_TIME',
    extractorVersion: typeof row.extractorVersion === 'string' ? row.extractorVersion : null,
    gaps,
    revision: typeof row.revision === 'number' ? row.revision : 1
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
    const resourceRangeJson = input.resourceRange ? JSON.stringify(input.resourceRange) : null
    const info = this.db.prepare(`
      INSERT OR IGNORE INTO skill_events(
        eventId, sessionId, executionId, nativeSessionId, repositoryId, provider, worktreeId, generation,
        observationClass, skillId, skillName, skillScope, destinationId, version, versionStatus,
        packageHash, resourceUri, resourcePath, resourceSelector, resourceRangeJson, resourceDigest,
        deliveryGranularity, sourceSurface, sourceContract, sourceNamespace, sourceRevision,
        callEventId, resultEventId, originalEventId, turnId, operation, operationStatus, errorCode,
        sessionBindingState, bindingAuthority, captureOrder, sourceTimestamp, observedAt, timestampKind,
        extractorVersion, gapsJson, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      sessionId,
      executionId,
      nativeSessionId,
      input.repositoryId ?? null,
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
      input.resourceSelector ? sanitize(input.resourceSelector) : null,
      resourceRangeJson,
      input.resourceDigest ?? null,
      input.deliveryGranularity ?? null,
      input.sourceSurface,
      input.sourceContract,
      input.sourceNamespace ?? null,
      typeof input.sourceRevision === 'number' && Number.isSafeInteger(input.sourceRevision) ? input.sourceRevision : null,
      input.callEventId ?? null,
      input.resultEventId ?? null,
      input.originalEventId ?? null,
      input.turnId ?? null,
      input.operation,
      input.operationStatus,
      input.errorCode ?? null,
      bound ? 'BOUND_BY_WITNESS' : 'UNBOUND',
      bound ? (input.bindingAuthority ?? 'witness') : null,
      input.captureOrder ?? 0,
      input.sourceTimestamp ?? null,
      observedAt,
      timestampKind,
      input.extractorVersion ?? null,
      JSON.stringify([...gaps]),
      revision
    )

    return { eventId, inserted: info.changes > 0, revision }
  }

  deleteSourceObservations(sourceNamespace: string, keepRevision?: number): number {
    const hasTable = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='skill_events'").get()
    if (!hasTable) return 0
    if (keepRevision !== undefined) {
      return this.db.prepare(
        'DELETE FROM skill_events WHERE sourceNamespace = ? AND sourceRevision IS NOT NULL AND sourceRevision <> ?'
      ).run(sourceNamespace, keepRevision).changes
    }
    return this.db.prepare('DELETE FROM skill_events WHERE sourceNamespace = ?').run(sourceNamespace).changes
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
    events: Array<Partial<EventInput> & { type: EventInput['type']; callId?: string; content?: unknown; eventId?: string; ordinal?: number; turnId?: string }>,
    context?: { executionId?: string; nativeSessionId?: string; repositoryId?: string; provider?: string; worktreeId?: string; generation?: string }
  ): number {
    const callsById = new Map<string, Partial<EventInput> & { type: EventInput['type']; callId?: string; content?: unknown; eventId?: string; ordinal?: number; turnId?: string }>()
    const resultsByCallId = new Set<string>()
    for (const ev of events) {
      if (ev.type === 'TOOL_CALL' && ev.callId) {
        callsById.set(ev.callId, ev)
      } else if (ev.type === 'TOOL_RESULT' && ev.callId) {
        resultsByCallId.add(ev.callId)
      }
    }

    let recorded = 0
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]
      if (ev.type !== 'TOOL_CALL' && ev.type !== 'TOOL_RESULT') continue
      const callEv = ev.type === 'TOOL_RESULT' && ev.callId ? callsById.get(ev.callId) : ev
      const rawTool = ev.tool ?? callEv?.tool
      const canonicalTool = resolveCanonicalSkillTool(rawTool)
      if (!canonicalTool) continue

      // Pair TOOL_CALL with its TOOL_RESULT by exact callId; skip standalone TOOL_CALL if a paired TOOL_RESULT exists
      if (ev.type === 'TOOL_CALL' && ev.callId && resultsByCallId.has(ev.callId)) {
        continue
      }
      // TOOL_RESULT without a matching TOOL_CALL in the same session cannot confirm request-side context unless tool was on result itself
      const hasResult = ev.type === 'TOOL_RESULT'
      const callArgs = callEv ? extractSkillCallMetadata(canonicalTool, extractTextValue(callEv.content)) : {}
      const rawOutput = hasResult ? extractTextValue(ev.content) : ''
      const qualified = qualifySkillToolObservation({
        canonicalTool,
        callArgs,
        rawOutput,
        hasResult,
        sessionId,
        executionId: context?.executionId ?? null,
        nativeSessionId: context?.nativeSessionId ?? null,
        repositoryId: context?.repositoryId ?? null,
        provider: context?.provider ?? null,
        worktreeId: context?.worktreeId ?? null,
        generation: context?.generation ?? null,
        sourceSurface: 'native_source_event',
        sourceContract: 'native-source-events/v2',
        sourceNamespace: sessionId,
        callEventId: callEv?.eventId ?? callEv?.callId ?? null,
        resultEventId: hasResult ? (ev.eventId ?? ev.callId ?? null) : null,
        originalEventId: ev.eventId ?? ev.callId ?? `native:${i}`,
        turnId: ev.turnId ?? callEv?.turnId ?? null,
        sessionBindingState: 'BOUND_BY_WITNESS',
        bindingAuthority: 'native_session_ingest',
        captureOrder: ev.ordinal ?? i + 1,
        sourceTimestamp: ev.timestamp ?? null
      })
      if (!qualified) continue
      this.recordSkillEvent(qualified)
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

    if (filter.repositoryId) {
      where.push('(repositoryId IS NULL OR repositoryId = ?)')
      params.push(filter.repositoryId)
    }
    if (filter.skillId) {
      where.push('skillId = ?')
      params.push(filter.skillId)
    }
    if (filter.version !== undefined) {
      where.push('version = ?')
      params.push(filter.version)
    }
    if (filter.packageHash) {
      where.push('packageHash = ?')
      params.push(filter.packageHash)
    }
    if (filter.sourceNamespace) {
      where.push('sourceNamespace = ?')
      params.push(filter.sourceNamespace)
    }
    if (filter.sourceRevision !== undefined) {
      where.push('sourceRevision = ?')
      params.push(filter.sourceRevision)
    }

    // Never expose staged/unpromoted native_source_event observations
    const hasNativeSources = Boolean(
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_reference_sources'").get()
    )
    if (hasNativeSources) {
      where.push(
        `(sourceNamespace IS NULL OR sourceRevision IS NULL OR EXISTS (SELECT 1 FROM native_reference_sources nrs WHERE nrs.nativeKey = skill_events.sourceNamespace AND nrs.revision = skill_events.sourceRevision))`
      )
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS n FROM skill_events ${whereSql}`).get(...params) as { n: number }
    const rows = this.db.prepare(
      `SELECT * FROM skill_events ${whereSql} ORDER BY captureOrder ASC, observedAt ASC, eventId ASC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Array<Record<string, unknown>>

    const unboundWhere: string[] = ["sessionBindingState = 'UNBOUND'"]
    const unboundParams: Array<string | number> = []
    if (filter.skillId) {
      unboundWhere.push('skillId = ?')
      unboundParams.push(filter.skillId)
    }
    if (filter.version !== undefined) {
      unboundWhere.push('version = ?')
      unboundParams.push(filter.version)
    }
    if (filter.packageHash) {
      unboundWhere.push('packageHash = ?')
      unboundParams.push(filter.packageHash)
    }
    const unboundRow = this.db.prepare(
      `SELECT COUNT(*) AS n FROM skill_events WHERE ${unboundWhere.join(' AND ')}`
    ).get(...unboundParams) as { n: number }

    const scopeKeys = [
      filter.sessionId,
      filter.executionId,
      filter.nativeSessionId,
      filter.sourceNamespace,
      filter.repositoryId,
      filter.skillId
    ].filter((v): v is string => typeof v === 'string' && v.length > 0)
    const coverageRows = scopeKeys.length > 0
      ? (this.db.prepare(
          `SELECT sourceSurface, scopeKey, coverageState, reason, updatedAt FROM skill_source_coverage WHERE scopeKey IN (${scopeKeys.map(() => '?').join(',')}) ORDER BY updatedAt DESC`
        ).all(...scopeKeys) as SkillSourceCoverageRecord[])
      : (this.db.prepare(
          `SELECT sourceSurface, scopeKey, coverageState, reason, updatedAt FROM skill_source_coverage ORDER BY updatedAt DESC LIMIT 20`
        ).all() as SkillSourceCoverageRecord[])

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
