import type Database from 'better-sqlite3'
import type { FieldGranularity, FieldObservability, SourceSurface } from './model-intelligence-inventory'
import { digest, sanitize } from './privacy'

export type UsageScope =
  | 'session_total'
  | 'session_cumulative'
  | 'call_delta'
  | 'checkpoint_window'
  | 'subagent_total'

export type MetadataCoverageStatus = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE'

export const MODEL_INTELLIGENCE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS session_model_metadata(
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    scopeId TEXT NOT NULL,
    ordinal INTEGER NOT NULL DEFAULT 0,
    sourceSurface TEXT NOT NULL,
    sourceVersion TEXT NOT NULL,
    observability TEXT NOT NULL,
    provider TEXT,
    client TEXT,
    model TEXT,
    effort TEXT,
    contextWindow INTEGER,
    parentSessionId TEXT,
    turnCount INTEGER,
    pendingTurnCount INTEGER,
    coverageStatus TEXT NOT NULL,
    unavailableReason TEXT,
    unknownFieldPaths TEXT NOT NULL DEFAULT '[]',
    observedAt TEXT NOT NULL,
    UNIQUE(sessionId, scope, scopeId, sourceSurface, ordinal)
  );
  CREATE INDEX IF NOT EXISTS session_model_scope ON session_model_metadata(sessionId, scope, ordinal, id);
  CREATE TABLE IF NOT EXISTS session_usage_facts(
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    usageScope TEXT NOT NULL,
    scopeId TEXT NOT NULL,
    ordinal INTEGER NOT NULL DEFAULT 0,
    sourceSurface TEXT NOT NULL,
    sourceVersion TEXT NOT NULL,
    observability TEXT NOT NULL,
    model TEXT,
    effort TEXT,
    inputTokens INTEGER,
    outputTokens INTEGER,
    cacheReadTokens INTEGER,
    cacheWriteTokens INTEGER,
    reasoningOutputTokens INTEGER,
    totalTokens INTEGER,
    apiCalls INTEGER,
    parentSessionId TEXT,
    coverageStatus TEXT NOT NULL,
    unavailableReason TEXT,
    observedAt TEXT NOT NULL,
    UNIQUE(sessionId, usageScope, scopeId, sourceSurface, ordinal)
  );
  CREATE INDEX IF NOT EXISTS session_usage_scope ON session_usage_facts(sessionId, usageScope, ordinal, id);
`

export interface ModelMetadataInput {
  scope: FieldGranularity
  scopeId: string
  ordinal?: number
  sourceSurface: SourceSurface
  sourceVersion: string
  observability: FieldObservability
  provider?: string
  client?: string
  model?: string
  effort?: string
  contextWindow?: number
  parentSessionId?: string
  turnCount?: number
  pendingTurnCount?: number
  coverageStatus: MetadataCoverageStatus
  unavailableReason?: string
  unknownFieldPaths?: readonly string[]
}

export interface UsageFactInput {
  usageScope: UsageScope
  scopeId: string
  ordinal?: number
  sourceSurface: SourceSurface
  sourceVersion: string
  observability: FieldObservability
  model?: string
  effort?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningOutputTokens?: number
  totalTokens?: number
  apiCalls?: number
  parentSessionId?: string
  coverageStatus: MetadataCoverageStatus
  unavailableReason?: string
}

export interface SessionModelMetadataRow {
  id: string
  sessionId: string
  scope: FieldGranularity
  scopeId: string
  ordinal: number
  sourceSurface: SourceSurface
  sourceVersion: string
  observability: FieldObservability
  provider: string | null
  client: string | null
  model: string | null
  effort: string | null
  contextWindow: number | null
  parentSessionId: string | null
  turnCount: number | null
  pendingTurnCount: number | null
  coverageStatus: MetadataCoverageStatus
  unavailableReason: string | null
  unknownFieldPaths: string
  observedAt: string
}

export interface SessionUsageFactRow {
  id: string
  sessionId: string
  usageScope: UsageScope
  scopeId: string
  ordinal: number
  sourceSurface: SourceSurface
  sourceVersion: string
  observability: FieldObservability
  model: string | null
  effort: string | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  reasoningOutputTokens: number | null
  totalTokens: number | null
  apiCalls: number | null
  parentSessionId: string | null
  coverageStatus: MetadataCoverageStatus
  unavailableReason: string | null
  observedAt: string
}

export interface AggregatedTokenUsageSummary {
  scope: 'session_total' | 'session_cumulative' | 'call_delta_sum' | 'unavailable'
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoningOutput?: number
  total?: number
  apiCalls?: number
}

export interface SessionModelSummary {
  models: string[]
  efforts: string[]
  providers: string[]
  clients: string[]
  observabilities: FieldObservability[]
  primaryUsage: AggregatedTokenUsageSummary
  checkpointUsage: Array<{
    scopeId: string
    model?: string
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    total?: number
  }>
  subagentUsage: Array<{
    parentSessionId?: string
    scopeId: string
    model?: string
    input?: number
    output?: number
    total?: number
  }>
  coverageStatus: MetadataCoverageStatus
  unavailableReasons: string[]
  unknownFieldPaths: string[]
}

function cleanLabel(value: string | undefined, max = 160): string | null {
  if (typeof value !== 'string') return null
  const clean = sanitize(value).trim().slice(0, max)
  return clean.length > 0 ? clean : null
}

function cleanInt(value: number | undefined): number | null {
  if (value === undefined || value === null) return null
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function sumNullable(values: Array<number | null>): number | undefined {
  let seen = false
  let sum = 0
  for (const v of values) {
    if (v !== null && v !== undefined) {
      seen = true
      sum += v
    }
  }
  return seen ? sum : undefined
}

function usageSummaryFromRow(
  scope: AggregatedTokenUsageSummary['scope'],
  row: SessionUsageFactRow
): AggregatedTokenUsageSummary {
  return {
    scope,
    ...(row.inputTokens !== null ? { input: row.inputTokens } : {}),
    ...(row.outputTokens !== null ? { output: row.outputTokens } : {}),
    ...(row.cacheReadTokens !== null ? { cacheRead: row.cacheReadTokens } : {}),
    ...(row.cacheWriteTokens !== null ? { cacheWrite: row.cacheWriteTokens } : {}),
    ...(row.reasoningOutputTokens !== null ? { reasoningOutput: row.reasoningOutputTokens } : {}),
    ...(row.totalTokens !== null ? { total: row.totalTokens } : {}),
    ...(row.apiCalls !== null ? { apiCalls: row.apiCalls } : {})
  }
}

export class ModelIntelligenceStore {
  constructor(private readonly db: Database.Database) {}

  recordFacts(
    sessionId: string,
    facts: { modelFacts?: readonly ModelMetadataInput[]; usageFacts?: readonly UsageFactInput[] },
    assertCurrent: () => void = () => {}
  ): { written: boolean; modelRowsChanged: number; usageRowsChanged: number } {
    const modelFacts = facts.modelFacts ?? []
    const usageFacts = facts.usageFacts ?? []
    if (!modelFacts.length && !usageFacts.length) {
      return { written: false, modelRowsChanged: 0, usageRowsChanged: 0 }
    }
    return this.db.transaction(() => {
      assertCurrent()
      const now = new Date().toISOString()
      let modelRowsChanged = 0
      let usageRowsChanged = 0

      for (const item of modelFacts) {
        const ordinal = item.ordinal ?? 0
        const id = digest(JSON.stringify([sessionId, item.scope, item.scopeId, item.sourceSurface, ordinal]))
        const provider = cleanLabel(item.provider, 80)
        const client = cleanLabel(item.client, 80)
        const model = cleanLabel(item.model, 160)
        const effort = cleanLabel(item.effort, 64)
        const contextWindow = cleanInt(item.contextWindow)
        const parentSessionId = cleanLabel(item.parentSessionId, 200)
        const turnCount = cleanInt(item.turnCount)
        const pendingTurnCount = cleanInt(item.pendingTurnCount)
        const unavailableReason = cleanLabel(item.unavailableReason, 120)
        const unknownFieldPaths = JSON.stringify(
          [...new Set((item.unknownFieldPaths ?? []).map(p => sanitize(p).slice(0, 160)).filter(Boolean))].sort()
        )
        const existing = this.db
          .prepare('SELECT * FROM session_model_metadata WHERE id = ?')
          .get(id) as SessionModelMetadataRow | undefined

        if (
          existing &&
          existing.sourceVersion === item.sourceVersion &&
          existing.observability === item.observability &&
          existing.provider === provider &&
          existing.client === client &&
          existing.model === model &&
          existing.effort === effort &&
          existing.contextWindow === contextWindow &&
          existing.parentSessionId === parentSessionId &&
          existing.turnCount === turnCount &&
          existing.pendingTurnCount === pendingTurnCount &&
          existing.coverageStatus === item.coverageStatus &&
          existing.unavailableReason === unavailableReason &&
          existing.unknownFieldPaths === unknownFieldPaths
        ) {
          continue
        }

        this.db
          .prepare(
            `INSERT INTO session_model_metadata(
              id, sessionId, scope, scopeId, ordinal, sourceSurface, sourceVersion, observability,
              provider, client, model, effort, contextWindow, parentSessionId, turnCount, pendingTurnCount,
              coverageStatus, unavailableReason, unknownFieldPaths, observedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              sourceVersion=excluded.sourceVersion,
              observability=excluded.observability,
              provider=excluded.provider,
              client=excluded.client,
              model=excluded.model,
              effort=excluded.effort,
              contextWindow=excluded.contextWindow,
              parentSessionId=excluded.parentSessionId,
              turnCount=excluded.turnCount,
              pendingTurnCount=excluded.pendingTurnCount,
              coverageStatus=excluded.coverageStatus,
              unavailableReason=excluded.unavailableReason,
              unknownFieldPaths=excluded.unknownFieldPaths,
              observedAt=excluded.observedAt`
          )
          .run(
            id,
            sessionId,
            item.scope,
            sanitize(item.scopeId).slice(0, 200),
            ordinal,
            item.sourceSurface,
            sanitize(item.sourceVersion).slice(0, 64),
            item.observability,
            provider,
            client,
            model,
            effort,
            contextWindow,
            parentSessionId,
            turnCount,
            pendingTurnCount,
            item.coverageStatus,
            unavailableReason,
            unknownFieldPaths,
            now
          )
        modelRowsChanged++
      }

      for (const item of usageFacts) {
        const ordinal = item.ordinal ?? 0
        const id = digest(JSON.stringify([sessionId, item.usageScope, item.scopeId, item.sourceSurface, ordinal]))
        const model = cleanLabel(item.model, 160)
        const effort = cleanLabel(item.effort, 64)
        const inputTokens = cleanInt(item.inputTokens)
        const outputTokens = cleanInt(item.outputTokens)
        const cacheReadTokens = cleanInt(item.cacheReadTokens)
        const cacheWriteTokens = cleanInt(item.cacheWriteTokens)
        const reasoningOutputTokens = cleanInt(item.reasoningOutputTokens)
        const totalTokens = cleanInt(item.totalTokens)
        const apiCalls = cleanInt(item.apiCalls)
        const parentSessionId = cleanLabel(item.parentSessionId, 200)
        const unavailableReason = cleanLabel(item.unavailableReason, 120)
        const existing = this.db
          .prepare('SELECT * FROM session_usage_facts WHERE id = ?')
          .get(id) as SessionUsageFactRow | undefined

        if (
          existing &&
          existing.sourceVersion === item.sourceVersion &&
          existing.observability === item.observability &&
          existing.model === model &&
          existing.effort === effort &&
          existing.inputTokens === inputTokens &&
          existing.outputTokens === outputTokens &&
          existing.cacheReadTokens === cacheReadTokens &&
          existing.cacheWriteTokens === cacheWriteTokens &&
          existing.reasoningOutputTokens === reasoningOutputTokens &&
          existing.totalTokens === totalTokens &&
          existing.apiCalls === apiCalls &&
          existing.parentSessionId === parentSessionId &&
          existing.coverageStatus === item.coverageStatus &&
          existing.unavailableReason === unavailableReason
        ) {
          continue
        }

        this.db
          .prepare(
            `INSERT INTO session_usage_facts(
              id, sessionId, usageScope, scopeId, ordinal, sourceSurface, sourceVersion, observability,
              model, effort, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningOutputTokens,
              totalTokens, apiCalls, parentSessionId, coverageStatus, unavailableReason, observedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              sourceVersion=excluded.sourceVersion,
              observability=excluded.observability,
              model=excluded.model,
              effort=excluded.effort,
              inputTokens=excluded.inputTokens,
              outputTokens=excluded.outputTokens,
              cacheReadTokens=excluded.cacheReadTokens,
              cacheWriteTokens=excluded.cacheWriteTokens,
              reasoningOutputTokens=excluded.reasoningOutputTokens,
              totalTokens=excluded.totalTokens,
              apiCalls=excluded.apiCalls,
              parentSessionId=excluded.parentSessionId,
              coverageStatus=excluded.coverageStatus,
              unavailableReason=excluded.unavailableReason,
              observedAt=excluded.observedAt`
          )
          .run(
            id,
            sessionId,
            item.usageScope,
            sanitize(item.scopeId).slice(0, 200),
            ordinal,
            item.sourceSurface,
            sanitize(item.sourceVersion).slice(0, 64),
            item.observability,
            model,
            effort,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            reasoningOutputTokens,
            totalTokens,
            apiCalls,
            parentSessionId,
            item.coverageStatus,
            unavailableReason,
            now
          )
        usageRowsChanged++
      }

      assertCurrent()
      return {
        written: modelRowsChanged > 0 || usageRowsChanged > 0,
        modelRowsChanged,
        usageRowsChanged
      }
    }).immediate()
  }

  listModelFacts(
    sessionId: string,
    options: { scope?: FieldGranularity; offset?: number; limit?: number } = {}
  ): SessionModelMetadataRow[] {
    const offset = Math.max(0, options.offset ?? 0)
    const limit = Math.max(1, Math.min(200, options.limit ?? 50))
    if (options.scope) {
      return this.db
        .prepare(
          'SELECT * FROM session_model_metadata WHERE sessionId = ? AND scope = ? ORDER BY ordinal ASC, id ASC LIMIT ? OFFSET ?'
        )
        .all(sessionId, options.scope, limit, offset) as SessionModelMetadataRow[]
    }
    return this.db
      .prepare(
        'SELECT * FROM session_model_metadata WHERE sessionId = ? ORDER BY ordinal ASC, id ASC LIMIT ? OFFSET ?'
      )
      .all(sessionId, limit, offset) as SessionModelMetadataRow[]
  }

  listUsageFacts(
    sessionId: string,
    options: { usageScope?: UsageScope; offset?: number; limit?: number } = {}
  ): SessionUsageFactRow[] {
    const offset = Math.max(0, options.offset ?? 0)
    const limit = Math.max(1, Math.min(200, options.limit ?? 50))
    if (options.usageScope) {
      return this.db
        .prepare(
          'SELECT * FROM session_usage_facts WHERE sessionId = ? AND usageScope = ? ORDER BY ordinal ASC, id ASC LIMIT ? OFFSET ?'
        )
        .all(sessionId, options.usageScope, limit, offset) as SessionUsageFactRow[]
    }
    return this.db
      .prepare(
        'SELECT * FROM session_usage_facts WHERE sessionId = ? ORDER BY ordinal ASC, id ASC LIMIT ? OFFSET ?'
      )
      .all(sessionId, limit, offset) as SessionUsageFactRow[]
  }

  summarizeSession(sessionId: string): SessionModelSummary {
    const modelRows = this.listModelFacts(sessionId, { limit: 200 })
    const usageRows = this.listUsageFacts(sessionId, { limit: 200 })

    const models = [...new Set([...modelRows.map(r => r.model), ...usageRows.map(r => r.model)].filter((v): v is string => !!v))]
    const efforts = [...new Set([...modelRows.map(r => r.effort), ...usageRows.map(r => r.effort)].filter((v): v is string => !!v))]
    const providers = [...new Set(modelRows.map(r => r.provider).filter((v): v is string => !!v))]
    const clients = [...new Set(modelRows.map(r => r.client).filter((v): v is string => !!v))]
    const observabilities = [...new Set([...modelRows.map(r => r.observability), ...usageRows.map(r => r.observability)])]

    const sessionTotals = usageRows.filter(r => r.usageScope === 'session_total')
    const sessionCumulatives = usageRows.filter(r => r.usageScope === 'session_cumulative')
    const callDeltas = usageRows.filter(r => r.usageScope === 'call_delta')

    let primaryUsage: AggregatedTokenUsageSummary = { scope: 'unavailable' }
    if (sessionTotals.length > 0) {
      primaryUsage = usageSummaryFromRow('session_total', sessionTotals[sessionTotals.length - 1]!)
    } else if (sessionCumulatives.length > 0) {
      primaryUsage = usageSummaryFromRow('session_cumulative', sessionCumulatives[sessionCumulatives.length - 1]!)
    } else if (callDeltas.length > 0) {
      const input = sumNullable(callDeltas.map(r => r.inputTokens))
      const output = sumNullable(callDeltas.map(r => r.outputTokens))
      const cacheRead = sumNullable(callDeltas.map(r => r.cacheReadTokens))
      const cacheWrite = sumNullable(callDeltas.map(r => r.cacheWriteTokens))
      const reasoningOutput = sumNullable(callDeltas.map(r => r.reasoningOutputTokens))
      const total = sumNullable(callDeltas.map(r => r.totalTokens))
      primaryUsage = {
        scope: 'call_delta_sum',
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(cacheRead !== undefined ? { cacheRead } : {}),
        ...(cacheWrite !== undefined ? { cacheWrite } : {}),
        ...(reasoningOutput !== undefined ? { reasoningOutput } : {}),
        ...(total !== undefined ? { total } : {}),
        apiCalls: callDeltas.length
      }
    }

    const checkpointUsage = usageRows
      .filter(r => r.usageScope === 'checkpoint_window')
      .map(r => ({
        scopeId: r.scopeId,
        ...(r.model ? { model: r.model } : {}),
        ...(r.inputTokens !== null ? { input: r.inputTokens } : {}),
        ...(r.outputTokens !== null ? { output: r.outputTokens } : {}),
        ...(r.cacheReadTokens !== null ? { cacheRead: r.cacheReadTokens } : {}),
        ...(r.cacheWriteTokens !== null ? { cacheWrite: r.cacheWriteTokens } : {}),
        ...(r.totalTokens !== null ? { total: r.totalTokens } : {})
      }))

    const subagentUsage = usageRows
      .filter(r => r.usageScope === 'subagent_total')
      .map(r => ({
        ...(r.parentSessionId ? { parentSessionId: r.parentSessionId } : {}),
        scopeId: r.scopeId,
        ...(r.model ? { model: r.model } : {}),
        ...(r.inputTokens !== null ? { input: r.inputTokens } : {}),
        ...(r.outputTokens !== null ? { output: r.outputTokens } : {}),
        ...(r.totalTokens !== null ? { total: r.totalTokens } : {})
      }))

    const statuses = [...modelRows.map(r => r.coverageStatus), ...usageRows.map(r => r.coverageStatus)]
    const coverageStatus: MetadataCoverageStatus = statuses.length === 0
      ? 'UNAVAILABLE'
      : statuses.includes('COMPLETE') && !statuses.includes('PARTIAL') && !statuses.includes('UNAVAILABLE')
        ? 'COMPLETE'
        : statuses.some(s => s === 'COMPLETE' || s === 'PARTIAL')
          ? 'PARTIAL'
          : 'UNAVAILABLE'

    const unavailableReasons = [
      ...new Set(
        [...modelRows.map(r => r.unavailableReason), ...usageRows.map(r => r.unavailableReason)].filter(
          (v): v is string => !!v
        )
      )
    ]

    const unknownFieldPaths = [
      ...new Set(
        modelRows.flatMap(r => {
          try {
            const parsed = JSON.parse(r.unknownFieldPaths) as unknown
            return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
          } catch {
            return []
          }
        })
      )
    ].sort()

    return {
      models,
      efforts,
      providers,
      clients,
      observabilities,
      primaryUsage,
      checkpointUsage,
      subagentUsage,
      coverageStatus,
      unavailableReasons,
      unknownFieldPaths
    }
  }
}
