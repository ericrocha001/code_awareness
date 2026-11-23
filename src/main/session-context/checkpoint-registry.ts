import type Database from 'better-sqlite3'
import { digest, utf8Prefix } from './privacy'
import { sessionIdentity, sessionSelector } from './session-identity'
import { nativeSessionEntityId, parseNativeEnvelope, type NativeHookEnvelope } from './native-hooks'
import { provenanceClass, type ProvenanceClass } from './provenance-evidence'

export type EntityKind = 'COMMIT' | 'CHECKPOINT' | 'SESSION' | 'PR' | 'ARTIFACT' | 'PROOF' | 'WORKTREE' | 'EXECUTION'
export interface RegistryEntity { kind: EntityKind; id: string }
export interface SessionWitness {
  kind: string; relation: string; revision: string; strength: ProvenanceClass; state: string
}
export interface WorktreeRef { worktreeId: string; generation: string }
export interface NativeSessionFilter {
  worktreeId?: string; generation?: string; agent?: string; after?: string; before?: string
  artifactId?: string; executionId?: string; commitSha?: string; pullRequest?: number
}
export interface NativeObservationSelector { provider: 'codex-native' | 'antigravity-native'; id: string; worktreeId?: string; generation?: string }
export interface NativeObservationFilter {
  eventId?: string
  hookEvents?: readonly string[]
  types?: readonly string[]
  turnId?: string
  invocationId?: string
  tool?: string
  status?: string
  errorKind?: string
  operation?: string
  isError?: boolean
  after?: string
  before?: string
}
export interface NativeSessionPageOptions {
  offset?: number
  limit?: number
}
export interface RegistrySessionRecord {
  provider: string; providerSessionId: string; agent: string
  origin: 'NATIVE_HOOK' | 'CHECKPOINT_REGISTRY'
  aliasState: 'NOT_RECONCILED' | 'RECONCILED' | 'ALIAS_CONFLICT'
  sessionId?: string
  lastObserved?: string
  worktrees: WorktreeRef[]
  witness?: SessionWitness
  evidence?: object
  deepen: { tool: string; arguments: object }
}
export interface RegistryEdge {
  from: RegistryEntity; relation: string; to: RegistryEntity
  evidenceKind: string; evidenceRef: string; digest: string; freshness: string
}
export interface ArtifactLabelSnapshot {
  id: string; title?: string; description?: string; artifactKind?: string; status?: string; revision: number; contentHash: string
  freshness: 'CURRENT_REVISION_AT_PROJECTION' | 'EXACT_REVISION' | 'SOURCE_STALE'
}
export interface RegistryBatch {
  repositoryId: string; source: string; revision: string; status: string
  cursor?: string; edges: RegistryEdge[]; entities?: RegistryEntity[]
  artifactLabels?: { id: string; snapshot: ArtifactLabelSnapshot | null }[]
}
export type RegistryReader = (request: { selector?: RegistryEntity; neighbors?: RegistryEntity[]; artifactTargets?: RegistryEntity[]; cursors: Record<string, string> }) => Promise<RegistryBatch[]>
type ObservedEdge = RegistryEdge & { sourceSystem: string; sourceRevision: string; observedAt: string; state: string }
type NativeAuditEdge = { id: string; source: string; sourceRevision: string; fromId: string; toId: string; payload: string; integrity: string }
export const REGISTRY_SCHEMA = `
 CREATE TABLE IF NOT EXISTS registry_entities(id TEXT PRIMARY KEY, kind TEXT NOT NULL, externalId TEXT NOT NULL, localSessionId TEXT, artifactLabel TEXT, artifactDescription TEXT, UNIQUE(kind,externalId));
 CREATE TABLE IF NOT EXISTS registry_edges(id TEXT PRIMARY KEY, source TEXT NOT NULL, sourceRevision TEXT NOT NULL,
   fromId TEXT NOT NULL REFERENCES registry_entities(id), toId TEXT NOT NULL REFERENCES registry_entities(id),
   payload TEXT NOT NULL, integrity TEXT NOT NULL, observedAt TEXT NOT NULL, state TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS registry_from ON registry_edges(fromId,state);
 CREATE INDEX IF NOT EXISTS registry_to ON registry_edges(toId,state);
 CREATE INDEX IF NOT EXISTS registry_scope_scan ON registry_edges(toId,state,fromId);
 CREATE INDEX IF NOT EXISTS registry_source ON registry_edges(source,sourceRevision);
 CREATE INDEX IF NOT EXISTS registry_native_sessions ON registry_entities(externalId,id,localSessionId) WHERE kind='SESSION' AND (externalId LIKE 'codex-native:%' OR externalId LIKE 'antigravity-native:%');
 CREATE INDEX IF NOT EXISTS registry_native_hook_session_edges ON registry_edges(toId,source,observedAt) WHERE state='OBSERVED' AND source LIKE 'NATIVE_HOOK:%';
 CREATE TABLE IF NOT EXISTS registry_sources(source TEXT PRIMARY KEY, revision TEXT NOT NULL, cursor TEXT, status TEXT NOT NULL, observedAt TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS checkpoint_registry(checkpointId TEXT NOT NULL, refRevision TEXT NOT NULL, state TEXT NOT NULL, digest TEXT NOT NULL, sessionIds TEXT NOT NULL, integrity TEXT NOT NULL,
   observedAt TEXT NOT NULL, PRIMARY KEY(checkpointId,refRevision));
`
const kinds: EntityKind[] = ['COMMIT', 'CHECKPOINT', 'SESSION', 'PR', 'ARTIFACT', 'PROOF', 'WORKTREE', 'EXECUTION']
export class CheckpointRegistry {
  private readonly supportsArtifactLabels: boolean
  constructor(private readonly db: Database.Database, readonly repositoryId: string) {
    this.supportsArtifactLabels = (db.pragma('table_info(registry_entities)') as { name: string }[]).some(column => column.name === 'artifactLabel')
  }
  pendingReconciliation(kind: 'PR' | 'COMMIT', limit = 5): RegistryEntity[] {
    const prefix = kind === 'PR' ? 'GITHUB:PR:' : 'GIT:'
    return (this.db.prepare(`SELECT e.externalId FROM registry_entities e LEFT JOIN registry_sources s ON s.source=?||e.externalId
      LEFT JOIN registry_sources c ON c.source='GITHUB_CATALOG:PR:'||e.externalId
      WHERE e.kind=? AND (s.source IS NULL ${kind === 'PR' ? "OR s.status='PARTIAL' OR (c.source IS NOT NULL AND c.revision<>coalesce(CASE WHEN json_valid(s.cursor) THEN json_extract(s.cursor,'$.catalogRevision') END,''))" : ''})
      ORDER BY CASE WHEN s.source IS NULL THEN 0 ELSE 1 END,e.externalId LIMIT ?`).all(prefix, kind, limit) as { externalId: string }[])
      .map(row => ({ kind, id: row.externalId }))
  }
  reconciliationPullRequests(after: string, limit = 3): RegistryEntity[] {
    return (this.db.prepare("SELECT externalId FROM registry_entities WHERE kind='PR' AND externalId>? ORDER BY externalId LIMIT ?").all(after, limit) as { externalId: string }[])
      .map(row => ({ kind: 'PR', id: row.externalId }))
  }
  pendingArtifactLabels(limit = 10): RegistryEntity[] {
    if (!this.supportsArtifactLabels) return []
    const rows = this.db.prepare(`SELECT e.externalId FROM registry_entities e
      LEFT JOIN registry_sources s ON s.source=(CASE WHEN instr(e.externalId, ':')>0 THEN 'CONTINUUM:' ELSE 'CONTINUUM_CURRENT:' END)||e.externalId
      WHERE e.kind='ARTIFACT' AND e.artifactLabel IS NULL AND coalesce(s.revision,'')<>'ARTIFACT_NOT_FOUND'
        AND (EXISTS (SELECT 1 FROM registry_edges r WHERE r.fromId=e.id AND r.state='OBSERVED')
          OR EXISTS (SELECT 1 FROM registry_edges r WHERE r.toId=e.id AND r.state='OBSERVED'))
      ORDER BY e.externalId LIMIT ?`).all(limit) as { externalId: string }[]
    return rows.map(row => ({ kind: 'ARTIFACT', id: row.externalId }))
  }
  reconciliationBacklog() {
    const sources = this.coverageSources()
    const github = this.source('GITHUB')?.status
    const unavailable = sources.filter(source => ['CONTINUUM', 'LEDGER', 'DELIVERY_GIT', 'DELIVERY_PR', 'DELIVERY_CONTINUUM'].includes(source.source) && source.status === 'UNAVAILABLE').map(source => source.source)
    const local = sources.some(source => ['CONTINUUM', 'LEDGER', 'DELIVERY_GIT', 'DELIVERY_PR', 'DELIVERY_CONTINUUM'].includes(source.source) && source.status === 'PARTIAL') || this.pendingReconciliation('COMMIT', 1).length > 0
    let discovery: { phase?: string; reasonCode?: string; lastAttemptAt?: string; lastAdvanceAt?: string; page?: number } = {}
    try { discovery = JSON.parse(this.source('GITHUB_DISCOVERY')?.cursor ?? '{}') } catch {}
    const discoveryPending = discovery.phase === 'FULL' || discovery.phase === 'PREFIX'
    const remote = discoveryPending || this.pendingReconciliation('PR', 1).length > 0 || this.source('GITHUB_REFRESH')?.status === 'PARTIAL'
    const blocked = remote && ['NETWORK_NOT_AUTHORIZED', 'UNAVAILABLE'].includes(github ?? 'UNAVAILABLE')
    const nativePartialScan = !!this.db.prepare("SELECT 1 FROM registry_sources WHERE (source LIKE 'NATIVE_ARTIFACT_SCAN:%' OR source LIKE 'NATIVE_GIT_SCAN:%') AND status='PARTIAL' LIMIT 1").get()
    const labels = this.pendingArtifactLabels(1).length > 0
    const sourceDetails = (['DELIVERY_GIT', 'DELIVERY_PR', 'DELIVERY_CONTINUUM', 'NATIVE_HOOK'] as const).flatMap(name => {
      const row = this.source(name)
      if (!row) return []
      let diag: { reasonCode?: string; stage?: string } = {}
      try { diag = JSON.parse(this.source(name + ':DIAGNOSTIC')?.cursor ?? '{}') } catch {}
      const drainState = ['UNAVAILABLE', 'CONFLICT'].includes(row.status) ? 'FAILED' as const : row.status === 'PARTIAL' ? 'PENDING' as const : 'DRAINED' as const
      return [{
        source: name,
        status: row.status,
        drainState,
        revision: row.revision,
        cursor: row.cursor ?? '',
        pending: row.status === 'PARTIAL',
        ...(typeof diag.reasonCode === 'string' ? { reasonCode: diag.reasonCode } : {}),
        ...(typeof diag.stage === 'string' ? { stage: diag.stage } : {}),
        nextStep: drainState === 'PENDING' ? 'ADVANCE_CURSOR' : drainState === 'FAILED' ? 'CHECK_SOURCE' : 'NONE'
      }]
    })
    return { pending: local || remote || labels || nativePartialScan || unavailable.length > 0, drainable: local || remote && !blocked || labels && !unavailable.includes('CONTINUUM') || nativePartialScan, blockedSources: [...unavailable, ...(blocked ? ['GITHUB'] : [])],
      sources: sources.filter(source => source.status === 'PARTIAL').map(source => source.source),
      details: [...(this.source('GITHUB_DISCOVERY') ? [{ source: 'GITHUB_DISCOVERY', scope: 'UPDATED_PR_CATALOG',
        ...(typeof discovery.reasonCode === 'string' && /^[A-Z_]{1,80}$/.test(discovery.reasonCode) ? { reasonCode: discovery.reasonCode } : {}),
        ...(discovery.lastAttemptAt ? { lastAttemptAt: discovery.lastAttemptAt } : {}), ...(discovery.lastAdvanceAt ? { lastAdvanceAt: discovery.lastAdvanceAt } : {}),
        pending: discoveryPending }] : []), ...sourceDetails] }
  }
  nativeCaptureWindows(worktreeId: string, generation: string) {
    const scope = this.key({ kind: 'WORKTREE', id: worktreeId + ':' + generation })
    const boundaries = this.db.prepare(`SELECT e.payload,e.integrity FROM registry_edges e WHERE e.toId=? AND e.state='OBSERVED'
      AND json_extract(e.payload,'$.evidenceKind')='NATIVE_CAPTURE_BOUNDARY' ORDER BY e.observedAt DESC,e.id LIMIT 4`).all(scope) as { payload: string; integrity: string }[]
    return boundaries.map(row => {
      if (digest(row.payload) !== row.integrity) throw new Error('REGISTRY_INTEGRITY_FAILED')
      const boundary = JSON.parse(row.payload) as RegistryEdge
      const capture = JSON.parse(boundary.evidenceRef) as NonNullable<NativeHookEnvelope['capture']>
      const window = this.key(boundary.from)
      const events = this.db.prepare(`SELECT count(*) AS accepted FROM registry_edges WHERE toId=? AND state='OBSERVED'
        AND json_extract(payload,'$.evidenceKind')='NATIVE_CAPTURE_MEMBERSHIP'`).get(window) as { accepted: number }
      const counts = this.db.prepare(`WITH pairs AS (
        SELECT e.fromId,count(DISTINCT json_extract(e.payload,'$.relation')) AS halves FROM registry_edges e
        WHERE e.toId=? AND e.state='OBSERVED' AND json_extract(e.payload,'$.evidenceKind')='NATIVE_CAPTURE_WINDOW' GROUP BY e.fromId
      ), causal_edges AS (
        SELECT e.state FROM pairs p JOIN registry_entities i ON i.id=p.fromId
        JOIN registry_edges e ON e.source IN ('NATIVE_ARTIFACT:'||substr(i.externalId,19),'NATIVE_GIT:'||substr(i.externalId,19))
        WHERE json_extract(e.payload,'$.evidenceKind') IN ('NATIVE_GIT_CAUSAL','NATIVE_ARTIFACT_CAUSAL')
      ), outcomes AS (
        SELECT p.halves,CASE WHEN a.status='COMPLETE' OR g.status='COMPLETE' THEN 'verified'
          WHEN a.cursor LIKE '%AMBIGUOUS%' OR g.cursor LIKE '%AMBIGUOUS%' THEN 'ambiguous'
          WHEN a.source IS NOT NULL OR g.source IS NOT NULL OR p.halves<>2 THEN 'partial' ELSE 'pending' END AS outcome
        FROM pairs p JOIN registry_entities i ON i.id=p.fromId
        LEFT JOIN registry_sources a ON a.source='NATIVE_ARTIFACT:'||substr(i.externalId,19)
        LEFT JOIN registry_sources g ON g.source='NATIVE_GIT:'||substr(i.externalId,19)
      ) SELECT count(*) AS invocations,coalesce(sum(halves=2),0) AS pairs,
        coalesce(sum(outcome='verified'),0) AS verified,coalesce(sum(outcome='partial'),0) AS partial,
        coalesce(sum(outcome='ambiguous'),0) AS ambiguous,coalesce(sum(outcome='pending'),0) AS pending,
        (SELECT count(*) FROM causal_edges WHERE state='OBSERVED') AS currentEdges,
        (SELECT count(*) FROM causal_edges WHERE state IN ('CONFLICT','SUPERSEDED','STALE')) AS withdrawnEdges FROM outcomes`).get(window) as Record<string, number>
      const metrics = JSON.parse(this.source('NATIVE_WINDOW_METRICS:' + capture.epoch)?.cursor ?? 'null') as Record<string, number> | null
      return { ...capture, accepted: events.accepted, ingress: metrics?.ingress ?? null, deduplicated: metrics?.deduplicated ?? null,
        rejected: metrics?.rejected ?? null, expired: metrics?.expired ?? null, pairs: counts.pairs, incompletePairs: counts.invocations - counts.pairs,
        correlations: { verified: counts.verified, partial: counts.partial, ambiguous: counts.ambiguous, pending: counts.pending },
        causalEdges: { current: counts.currentEdges, withdrawn: counts.withdrawnEdges }, denominator: null, coverage: 'COVERAGE_UNKNOWN' }
    })
  }
  nativeHookEvidence(worktreeId: string, generation: string, sessionId?: string, source?: NativeHookEnvelope['source']): NativeHookEnvelope[] {
    const scope = this.key({ kind: 'WORKTREE', id: worktreeId + ':' + generation })
    const rows = this.db.prepare(`SELECT DISTINCT s.cursor FROM registry_edges e JOIN registry_sources s ON e.source=s.source
      WHERE e.toId=? AND e.state='OBSERVED' AND e.source LIKE 'NATIVE_HOOK:%'
      AND (? IS NULL OR CASE WHEN json_valid(s.cursor) THEN json_extract(s.cursor,'$.sessionId') ELSE NULL END=?)
      AND (? IS NULL OR CASE WHEN json_valid(s.cursor) THEN json_extract(s.cursor,'$.source') ELSE NULL END=?)
      ORDER BY s.observedAt DESC LIMIT 8`).all(scope, sessionId ?? null, sessionId ?? null, source ?? null, source ?? null) as { cursor: string | null }[]
    return rows.flatMap(row => {
      try {
        const event = parseNativeEnvelope(row.cursor ?? '')
        return event.repositoryId === this.repositoryId && event.worktreeId === worktreeId && event.generation === generation ? [event] : []
      } catch { return [] }
    })
  }
  nativeCorrelationCandidates(kind: 'ARTIFACT' | 'GIT', worktreeId: string, generation: string, after = '', limit = 32): string[] {
    const scope = this.key({ kind: 'WORKTREE', id: worktreeId + ':' + generation })
    const rows = this.db.prepare(`SELECT DISTINCT e.fromId FROM registry_edges e
      WHERE e.toId=? AND e.state='OBSERVED' AND e.fromId>? AND json_extract(e.payload,'$.evidenceKind')=?
      ORDER BY e.fromId LIMIT ?`).all(scope, after, 'NATIVE_' + kind + '_SCOPE', limit) as { fromId: string }[]
    return rows.map(row => row.fromId)
  }
  invocationFromKey(key: string): string {
    const prefix = 'EXECUTION:' + this.repositoryId + ':native-invocation:'
    if (!key.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(key.slice(prefix.length))) throw new Error('INVALID_NATIVE_CORRELATION')
    return key.slice(prefix.length)
  }
  directEvidence(entity: RegistryEntity, evidenceKind: string): RegistryEdge[] {
    const key = this.key(entity)
    const rows = this.db.prepare("SELECT payload,integrity FROM registry_edges WHERE (fromId=? OR toId=?) AND state='OBSERVED' AND json_extract(payload,'$.evidenceKind')=? ORDER BY id LIMIT 65").all(key, key, evidenceKind) as { payload: string; integrity: string }[]
    if (rows.length > 64) throw new Error('REGISTRY_EVIDENCE_LIMIT')
    return rows.map(row => {
      if (digest(row.payload) !== row.integrity) throw new Error('REGISTRY_INTEGRITY_FAILED')
      return JSON.parse(row.payload) as RegistryEdge
    }).filter(edge => edge.evidenceKind === evidenceKind)
  }
  nativeSessions(offset: number, limit: number, accountHash?: string) {
    const rows = this.db.prepare("SELECT externalId FROM registry_entities WHERE kind='SESSION' AND (externalId LIKE 'codex-native:%' OR externalId LIKE 'antigravity-native:%') ORDER BY externalId LIMIT ? OFFSET ?").all(limit, offset) as { externalId: string }[]
    return rows.filter(row => this.visible({ kind: 'SESSION', id: row.externalId }, accountHash)).map(row => this.nativeSession(row.externalId))
  }

  private nativeObservationSelection(selector: NativeObservationSelector, accountHash?: string) {
    const entity = { kind: 'SESSION' as const, id: selector.provider + ':' + selector.id }
    const key = this.key(entity)
    if (!this.visible(entity, accountHash) || !this.db.prepare('SELECT 1 FROM registry_entities WHERE id=?').get(key)) throw new Error('SESSION_UNAVAILABLE')
    const providerSource = selector.provider === 'codex-native' ? 'CODEX_NATIVE_HOOK' : 'ANTIGRAVITY_NATIVE_HOOK'
    const params: string[] = [key]
    let scoped = ''
    if (selector.worktreeId) {
      scoped = ` AND EXISTS (SELECT 1 FROM registry_edges w WHERE w.fromId=e.fromId AND w.toId=? AND w.source=e.source AND w.state='OBSERVED')`
      params.push(this.key({ kind: 'WORKTREE', id: selector.worktreeId + ':' + selector.generation }))
    }
    const cte = `WITH obs AS (SELECT s.source AS source, CASE WHEN json_valid(s.cursor) THEN s.cursor ELSE '{}' END AS cursor, MAX(e.observedAt) AS edgeAt
      FROM registry_edges e JOIN registry_sources s ON e.source=s.source
      WHERE e.toId=? AND e.state='OBSERVED' AND s.status='COMPLETE' AND s.source LIKE 'NATIVE_HOOK:%'${scoped} GROUP BY s.source)`
    return { cte, params, providerSource }
  }

  nativeObservationScope(selector: NativeObservationSelector, accountHash?: string) {
    const { cte, params, providerSource } = this.nativeObservationSelection(selector, accountHash)
    const aggregate = this.db.prepare(`${cte} SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN json_extract(cursor,'$.repositoryId')=? AND json_extract(cursor,'$.sessionId')=? AND json_extract(cursor,'$.source')=?
        AND source='NATIVE_HOOK:'||json_extract(cursor,'$.eventId')
        AND (? IS NULL OR (json_extract(cursor,'$.worktreeId')=? AND json_extract(cursor,'$.generation')=?)) THEN 0 ELSE 1 END),0) AS invalid,
      MIN(json_extract(cursor,'$.observedAt')) AS firstObservedAt, MAX(json_extract(cursor,'$.observedAt')) AS lastObservedAt,
      MIN(source) AS minSource, MAX(source) AS maxSource, MAX(edgeAt) AS maxEdgeAt,
      COUNT(DISTINCT json_extract(cursor,'$.worktreeId')||':'||json_extract(cursor,'$.generation')) AS originCount FROM obs`)
      .get(...params, this.repositoryId, selector.id, providerSource, selector.worktreeId ?? null, selector.worktreeId ?? null, selector.generation ?? null) as {
        total: number; invalid: number; firstObservedAt: string | null; lastObservedAt: string | null; minSource: string | null; maxSource: string | null; maxEdgeAt: string | null; originCount: number }
    if (aggregate.invalid) throw new Error('REGISTRY_INTEGRITY_FAILED')
    const origins = (this.db.prepare(`${cte} SELECT DISTINCT json_extract(cursor,'$.worktreeId') AS worktreeId, json_extract(cursor,'$.generation') AS generation FROM obs ORDER BY 1,2 LIMIT 12`)
      .all(...params) as WorktreeRef[])
    const locators = (this.db.prepare(`${cte} SELECT DISTINCT json_extract(cursor,'$.appTranscriptDigest') AS digest FROM obs WHERE json_extract(cursor,'$.appTranscriptDigest') IS NOT NULL ORDER BY 1 LIMIT 2`)
      .all(...params) as { digest: string }[]).map(row => row.digest)
    const hookEvents = this.db.prepare(`${cte} SELECT json_extract(cursor,'$.event') AS type, COUNT(*) AS count FROM obs GROUP BY type ORDER BY MIN(json_extract(cursor,'$.observedAt')), type`)
      .all(...params) as { type: string; count: number }[]
    const turnCount = (this.db.prepare(`${cte} SELECT COUNT(DISTINCT json_extract(cursor,'$.turnId')) AS n FROM obs`).get(...params) as { n: number }).n
    return { total: aggregate.total, origins, originCount: aggregate.originCount, locators, hookEvents, turnCount, firstObservedAt: aggregate.firstObservedAt, lastObservedAt: aggregate.lastObservedAt,
      revision: digest(JSON.stringify([aggregate.total, aggregate.firstObservedAt, aggregate.lastObservedAt, aggregate.minSource, aggregate.maxSource, aggregate.maxEdgeAt, aggregate.originCount, 'OBS_V2'])) }
  }

  nativeObservationPage(selector: NativeObservationSelector, filter: NativeObservationFilter, offset: number, limit: number, accountHash?: string): { events: NativeHookEnvelope[]; more: boolean; filteredTotal?: number } {
    const { cte, params, providerSource } = this.nativeObservationSelection(selector, accountHash)
    if (filter.types?.length || filter.status || filter.errorKind || filter.operation || filter.isError === false) {
      return { events: [], more: false, filteredTotal: 0 }
    }
    const where: string[] = [], values: (string | number)[] = []
    if (filter.eventId) { where.push(`json_extract(cursor,'$.eventId')=?`); values.push(filter.eventId) }
    if (filter.hookEvents?.length) { where.push(`json_extract(cursor,'$.event') IN (${filter.hookEvents.map(() => '?').join(',')})`); values.push(...filter.hookEvents) }
    if (filter.turnId) { where.push(`json_extract(cursor,'$.turnId')=?`); values.push(filter.turnId) }
    if (filter.invocationId) { where.push(`json_extract(cursor,'$.invocationId')=?`); values.push(filter.invocationId) }
    if (filter.tool) { where.push(`json_extract(cursor,'$.tool')=?`); values.push(filter.tool) }
    if (filter.isError) { where.push(`(json_extract(cursor,'$.event')='ERROR' OR json_extract(cursor,'$.error') IS NOT NULL)`) }
    for (const [key, op] of [['after', '>='], ['before', '<=']] as const) {
      if (!filter[key]) continue
      const ms = Date.parse(filter[key]!)
      if (!Number.isFinite(ms)) return { events: [], more: false, filteredTotal: 0 }
      where.push(`json_extract(cursor,'$.observedAt') ${op} ?`); values.push(new Date(ms).toISOString())
    }
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : ''
    const rows = this.db.prepare(`${cte} SELECT source, cursor FROM obs${clause} ORDER BY json_extract(cursor,'$.observedAt'), json_extract(cursor,'$.eventId') LIMIT ? OFFSET ?`)
      .all(...params, ...values, limit + 1, offset) as { source: string; cursor: string }[]
    const events = rows.slice(0, limit).map(row => {
      const event = parseNativeEnvelope(row.cursor)
      if (event.repositoryId !== this.repositoryId || event.sessionId !== selector.id || event.source !== providerSource || row.source !== 'NATIVE_HOOK:' + event.eventId ||
        selector.worktreeId && (event.worktreeId !== selector.worktreeId || event.generation !== selector.generation)) throw new Error('REGISTRY_INTEGRITY_FAILED')
      return event
    })
    const filteredTotal = !rows.length && offset > 0
      ? (this.db.prepare(`${cte} SELECT COUNT(*) AS n FROM obs${clause}`).get(...params, ...values) as { n: number }).n : undefined
    return { events, more: rows.length > limit, ...(filteredTotal !== undefined ? { filteredTotal } : {}) }
  }

  nativeObservationInvocations(selector: NativeObservationSelector, offset: number, limit: number, accountHash?: string) {
    const { cte, params } = this.nativeObservationSelection(selector, accountHash)
    const rows = this.db.prepare(`${cte} SELECT json_extract(cursor,'$.invocationId') AS id, MIN(json_extract(cursor,'$.observedAt')) AS firstObserved,
      MAX(json_extract(cursor,'$.observedAt')) AS lastObserved, COUNT(*) AS eventCount FROM obs WHERE json_extract(cursor,'$.invocationId') IS NOT NULL
      GROUP BY id ORDER BY firstObserved, id LIMIT ? OFFSET ?`).all(...params, limit + 1, offset) as { id: string; firstObserved: string; lastObserved: string; eventCount: number }[]
    return { invocations: rows.slice(0, limit), more: rows.length > limit }
  }

  nativeObservationTools(selector: NativeObservationSelector, offset: number, limit: number, accountHash?: string) {
    const { cte, params } = this.nativeObservationSelection(selector, accountHash)
    const rows = this.db.prepare(`${cte} SELECT json_extract(cursor,'$.tool') AS tool, COUNT(*) AS count
      FROM obs WHERE json_extract(cursor,'$.tool') IS NOT NULL
      GROUP BY tool ORDER BY count DESC, tool ASC LIMIT ? OFFSET ?`).all(...params, limit + 1, offset) as { tool: string; count: number }[]
    return { tools: rows.slice(0, limit), more: rows.length > limit }
  }

  searchHookObservations(filter: {
    repositoryId: string
    worktreeId?: string
    generation?: string
    provider?: 'codex-native' | 'antigravity-native'
    agent?: string
    sessionIds?: string[]
    hookEvents?: readonly string[]
    tool?: string
    invocationId?: string
    turnId?: string
    after?: string
    before?: string
    offset: number
    limit: number
  }, accountHash?: string): { events: Array<{ event: NativeHookEnvelope; nextOffset: number }>; more: boolean; examined: number } {
    if (filter.sessionIds !== undefined && filter.sessionIds.length === 0) {
      return { events: [], more: false, examined: 0 }
    }
    if (filter.agent && filter.agent !== 'codex' && filter.agent !== 'antigravity') {
      return { events: [], more: false, examined: 0 }
    }
    const where = [
      "s.status='COMPLETE'",
      "s.source LIKE 'NATIVE_HOOK:%'",
      "e.state='OBSERVED'",
      "json_valid(s.cursor)",
      "s.source = 'NATIVE_HOOK:' || json_extract(s.cursor,'$.eventId')",
      "json_extract(s.cursor,'$.repositoryId')=?"
    ]
    const params: (string | number)[] = [filter.repositoryId]
    if (filter.provider) {
      where.push("json_extract(s.cursor,'$.source')=?")
      params.push(filter.provider === 'codex-native' ? 'CODEX_NATIVE_HOOK' : 'ANTIGRAVITY_NATIVE_HOOK')
    }
    if (filter.agent) {
      where.push("json_extract(s.cursor,'$.source')=?")
      params.push(filter.agent === 'codex' ? 'CODEX_NATIVE_HOOK' : 'ANTIGRAVITY_NATIVE_HOOK')
    }
    if (filter.worktreeId && filter.generation) {
      where.push("json_extract(s.cursor,'$.worktreeId')=? AND json_extract(s.cursor,'$.generation')=?")
      params.push(filter.worktreeId, filter.generation)
    }
    if (filter.sessionIds?.length) {
      where.push(`json_extract(s.cursor,'$.sessionId') IN (${filter.sessionIds.map(() => '?').join(',')})`)
      params.push(...filter.sessionIds)
    }
    if (filter.hookEvents?.length) {
      where.push(`json_extract(s.cursor,'$.event') IN (${filter.hookEvents.map(() => '?').join(',')})`)
      params.push(...filter.hookEvents)
    }
    if (filter.tool) {
      where.push("json_extract(s.cursor,'$.tool')=?")
      params.push(filter.tool)
    }
    if (filter.invocationId) {
      where.push("json_extract(s.cursor,'$.invocationId')=?")
      params.push(filter.invocationId)
    }
    if (filter.turnId) {
      where.push("json_extract(s.cursor,'$.turnId')=?")
      params.push(filter.turnId)
    }
    if (filter.after) {
      const ms = Date.parse(filter.after)
      if (!Number.isFinite(ms)) throw new Error('INVALID_ARGUMENT')
      where.push("strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(s.cursor,'$.observedAt')) >= ?")
      params.push(new Date(ms).toISOString())
    }
    if (filter.before) {
      const ms = Date.parse(filter.before)
      if (!Number.isFinite(ms)) throw new Error('INVALID_ARGUMENT')
      where.push("strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(s.cursor,'$.observedAt')) <= ?")
      params.push(new Date(ms).toISOString())
    }
    const sql = `
      SELECT s.source, s.cursor
      FROM registry_edges e
      JOIN registry_sources s ON e.source = s.source
      WHERE ${where.join(' AND ')}
      GROUP BY s.source
      ORDER BY strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(s.cursor,'$.observedAt')) ASC, json_extract(s.cursor,'$.sessionId') ASC, json_extract(s.cursor,'$.eventId') ASC
      LIMIT ? OFFSET ?
    `
    const rows = this.db.prepare(sql).all(...params, filter.limit + 1, filter.offset) as Array<{ source: string; cursor: string }>
    const more = rows.length > filter.limit
    const candidateRows = rows.slice(0, filter.limit)
    const events: Array<{ event: NativeHookEnvelope; nextOffset: number }> = []
    for (let i = 0; i < candidateRows.length; i++) {
      const r = candidateRows[i]!
      const event = parseNativeEnvelope(r.cursor)
      if (event.repositoryId !== this.repositoryId || r.source !== 'NATIVE_HOOK:' + event.eventId) {
        throw new Error('REGISTRY_INTEGRITY_FAILED')
      }
      if (!this.visible({ kind: 'SESSION', id: nativeSessionEntityId(event, event.sessionId) }, accountHash)) continue
      events.push({ event, nextOffset: filter.offset + i + 1 })
    }
    return { events, more, examined: candidateRows.length }
  }

  nativeObservationTurns(selector: NativeObservationSelector, offset: number, limit: number, accountHash?: string) {
    const { cte, params } = this.nativeObservationSelection(selector, accountHash)
    const rows = this.db.prepare(`${cte} SELECT json_extract(cursor,'$.turnId') AS id, MIN(json_extract(cursor,'$.observedAt')) AS firstObserved,
      MAX(json_extract(cursor,'$.observedAt')) AS lastObserved, COUNT(*) AS eventCount FROM obs WHERE json_extract(cursor,'$.turnId') IS NOT NULL
      GROUP BY id ORDER BY firstObserved, id LIMIT ? OFFSET ?`).all(...params, limit + 1, offset) as { id: string; firstObserved: string; lastObserved: string; eventCount: number }[]
    return { turns: rows.slice(0, limit), more: rows.length > limit }
  }

  nativeObservationOrigins(selector: NativeObservationSelector, offset: number, limit: number, accountHash?: string) {
    const { cte, params } = this.nativeObservationSelection(selector, accountHash)
    const rows = this.db.prepare(`${cte} SELECT DISTINCT json_extract(cursor,'$.worktreeId') AS worktreeId, json_extract(cursor,'$.generation') AS generation
      FROM obs ORDER BY 1,2 LIMIT ? OFFSET ?`).all(...params, limit + 1, offset) as WorktreeRef[]
    return { origins: rows.slice(0, limit), more: rows.length > limit }
  }

  nativeDeliverySessions(selector: RegistryEntity, accountHash?: string) {
    if (selector.kind !== 'PR' && selector.kind !== 'COMMIT') throw new Error('INVALID_ARGUMENT')
    const target = this.key(selector)
    const prSource = 'GITHUB:PR:' + selector.id
    const membership = selector.kind === 'PR'
      ? this.db.prepare(`SELECT e.* FROM registry_edges e
          JOIN registry_sources page ON page.source=e.source AND page.revision=e.sourceRevision AND page.status='COMPLETE'
          JOIN registry_sources pr ON pr.source=? AND pr.revision=e.sourceRevision AND pr.status IN ('COMPLETE','PARTIAL')
          WHERE e.toId=? AND e.state='OBSERVED' AND e.source LIKE ? AND json_extract(e.payload,'$.evidenceKind')='GITHUB_COMMIT_LIST'
          ORDER BY e.id LIMIT 201`).all(prSource, target, prSource + ':%') as NativeAuditEdge[]
      : []
    const commits = new Map<string, NativeAuditEdge | null>()
    if (selector.kind === 'COMMIT') commits.set(target, null)
    for (const row of membership.slice(0, 200)) {
      const edge = this.nativeAuditEdge(row)
      const page = row.source.slice(prSource.length + 1)
      if (edge.from.kind !== 'COMMIT' || !/^[a-f0-9]{40}$/.test(edge.from.id) || edge.to.kind !== 'PR' || edge.relation !== 'member-of' || edge.freshness !== 'OBSERVED_SNAPSHOT' ||
          !/^[1-9][0-9]*$/.test(page) || edge.evidenceRef !== `PR:${selector.id}:${row.sourceRevision}:${page}`) continue
      commits.set(row.fromId, row)
    }
    const reasons = new Set<string>()
    if (selector.kind === 'PR' && this.source(prSource)?.status !== 'COMPLETE') reasons.add('GITHUB_PR_COVERAGE_PARTIAL')
    if (membership.length > 200) reasons.add('GRAPH_LIMIT_REACHED')
    const candidates = commits.size ? this.db.prepare(`SELECT committed.* FROM registry_edges committed
      JOIN registry_sources source ON source.source=committed.source AND source.revision=committed.sourceRevision AND source.status='COMPLETE'
      WHERE committed.toId IN (SELECT value FROM json_each(?)) AND committed.state='OBSERVED'
        AND committed.source LIKE 'NATIVE_GIT:%' AND json_extract(committed.payload,'$.evidenceKind')='NATIVE_GIT_CAUSAL'
      ORDER BY committed.id LIMIT 201`).all(JSON.stringify([...commits.keys()])) as NativeAuditEdge[] : []
    if (candidates.length > 200) reasons.add('GRAPH_LIMIT_REACHED')
    const sessions = new Map<string, ReturnType<CheckpointRegistry['nativeSession']> & { evidence: object }>()
    for (const committed of candidates.slice(0, 200)) {
      const commit = this.nativeAuditEdge(committed)
      const invocationId = committed.source.slice('NATIVE_GIT:'.length)
      if (!/^[a-f0-9]{64}$/.test(invocationId) || commit.from.kind !== 'EXECUTION' || commit.from.id !== 'native-invocation:' + invocationId ||
          commit.to.kind !== 'COMMIT' || !/^[a-f0-9]{40}$/.test(commit.to.id) || commit.relation !== 'committed' || commit.digest !== committed.sourceRevision ||
          commit.freshness !== 'OBSERVED_SNAPSHOT' || !/^[a-f0-9]{40,64}$/.test(commit.evidenceRef)) continue
      const witnesses = this.db.prepare(`SELECT * FROM registry_edges WHERE toId=? AND source=? AND sourceRevision=? AND state='OBSERVED'
        ORDER BY id LIMIT 2`).all(committed.fromId, committed.source, committed.sourceRevision) as NativeAuditEdge[]
      if (witnesses.length !== 1) continue
      const invoked = this.nativeAuditEdge(witnesses[0])
      if (invoked.relation !== 'invoked' || invoked.evidenceKind !== 'NATIVE_GIT_CAUSAL' || invoked.digest !== commit.digest ||
          invoked.evidenceRef !== commit.evidenceRef || invoked.freshness !== commit.freshness ||
          invoked.from.kind !== 'SESSION' || !/^(?:codex-native|antigravity-native):[a-f0-9]{64}$/.test(invoked.from.id) || !this.visible(invoked.from, accountHash)) continue
      const member = commits.get(committed.toId)
      if (!sessions.has(invoked.from.id)) sessions.set(invoked.from.id, {
        ...this.nativeSession(invoked.from.id), evidence: {
          native: { kind: 'NATIVE_GIT_CAUSAL', state: 'VERIFIED_CAUSAL', revision: committed.sourceRevision, commitSha: commit.to.id },
          ...(member ? { membership: { kind: 'GITHUB_COMMIT_LIST', state: 'VERIFIED', revision: member.sourceRevision } } : {})
        }
      })
    }
    for (const source of this.coverageSources()) {
      if (['NATIVE_HOOK', 'ENTIRE_REFS', ...(selector.kind === 'PR' ? ['GITHUB', 'GITHUB_DISCOVERY'] : [])].includes(source.source) &&
          ['PARTIAL', 'UNAVAILABLE', 'UNSUPPORTED', 'NETWORK_NOT_AUTHORIZED'].includes(source.status)) reasons.add(source.source + '_' + source.status)
    }
    const rows = [...sessions.values()].sort((a, b) => a.providerSessionId.localeCompare(b.providerSessionId))
    return { rows, reasons: [...reasons].sort(), revision: digest(JSON.stringify([rows, [...reasons].sort(), candidates.map(row => row.id), membership.map(row => row.id)])) }
  }

  private nativeAuditEdge(row: NativeAuditEdge): RegistryEdge {
    if (digest(row.payload) !== row.integrity) throw new Error('REGISTRY_INTEGRITY_FAILED')
    const edge = JSON.parse(row.payload) as RegistryEdge
    if (this.key(edge.from) !== row.fromId || this.key(edge.to) !== row.toId) throw new Error('REGISTRY_INTEGRITY_FAILED')
    return edge
  }

  hasWorktreeHistory(worktreeId: string, generation: string): boolean {
    const scope = worktreeId + ':' + generation
    const key = this.key({ kind: 'WORKTREE', id: scope })
    if (this.db.prepare('SELECT 1 FROM registry_entities WHERE id=? LIMIT 1').get(key)) return true
    if (this.db.prepare('SELECT 1 FROM capture_health WHERE worktreeId=? AND generation=? LIMIT 1').get(worktreeId, generation)) return true
    if (this.db.prepare("SELECT 1 FROM session_associations WHERE json_extract(payload,'$.worktreeId')=? AND json_extract(payload,'$.generation')=? LIMIT 1").get(worktreeId, generation)) return true
    return !!this.db.prepare('SELECT 1 FROM registry_sources WHERE source IN (?,?,?) LIMIT 1').get('CAPTURE:' + scope, 'NATIVE_CAPTURE:' + scope, 'NATIVE_CAPTURE:antigravity:' + scope)
  }

  sessionWorktrees(provider: 'codex-native' | 'antigravity-native', id: string): WorktreeRef[] {
    return this.worktreesAndObservedAt(`${provider}:${id}`).worktrees
  }

  private worktreesAndObservedAt(externalId: string, priorityWorktree?: WorktreeRef): { worktrees: WorktreeRef[]; lastObserved?: string; agent?: string } {
    const key = this.key({ kind: 'SESSION', id: externalId })
    const worktrees = new Map<string, WorktreeRef>()
    let eventObservedAt: string | undefined
    let ingestionObservedAt: string | undefined
    let agent: string | undefined
    const noteTime = (cur: string | undefined, value?: string | null) =>
      value && (!cur || Date.parse(value) > Date.parse(cur)) ? value : cur
    const hookRows = this.db.prepare(`SELECT s.cursor, s.observedAt FROM registry_edges e JOIN registry_sources s ON e.source=s.source
      WHERE e.toId=? AND e.state='OBSERVED' AND e.source LIKE 'NATIVE_HOOK:%' ORDER BY s.observedAt DESC, e.id LIMIT 64`).all(key) as { cursor: string | null; observedAt: string }[]
    for (const row of hookRows) {
      ingestionObservedAt = noteTime(ingestionObservedAt, row.observedAt)
      try {
        const event = parseNativeEnvelope(row.cursor ?? '')
        if (event.repositoryId !== this.repositoryId) continue
        eventObservedAt = noteTime(eventObservedAt, event.observedAt)
        const id = event.worktreeId + ':' + event.generation
        if (!worktrees.has(id) && worktrees.size < 12) worktrees.set(id, { worktreeId: event.worktreeId, generation: event.generation })
        if (!agent) agent = event.source === 'ANTIGRAVITY_NATIVE_HOOK' ? 'antigravity' : 'codex'
      } catch {}
    }
    const edgeRows = this.db.prepare(`SELECT w.externalId, MAX(matches.observedAt) AS observedAt FROM (
      SELECT e.toId AS wid, e.observedAt FROM registry_edges e
      WHERE e.fromId=? AND e.state='OBSERVED'
      UNION ALL
      SELECT e.fromId AS wid, e.observedAt FROM registry_edges e
      WHERE e.toId=? AND e.state='OBSERVED'
      UNION ALL
      SELECT e.toId AS wid, e.observedAt FROM registry_edges r
      JOIN registry_edges e ON e.fromId=r.fromId AND e.state='OBSERVED'
      WHERE r.toId=? AND r.state='OBSERVED'
        AND json_extract(e.payload,'$.relation') IN ('observed-in','scoped-to','window-start')
      UNION ALL
      SELECT e.toId AS wid, e.observedAt FROM registry_edges r
      JOIN registry_edges e ON e.fromId=r.fromId AND e.state='OBSERVED'
      WHERE r.fromId=? AND r.state='OBSERVED'
        AND json_extract(e.payload,'$.relation') IN ('observed-in','scoped-to')
    ) matches
    JOIN registry_entities w ON w.id=matches.wid AND w.kind='WORKTREE'
    GROUP BY w.externalId ORDER BY MAX(matches.observedAt) DESC LIMIT 12`).all(key, key, key, key) as { externalId: string; observedAt: string }[]
    for (const row of edgeRows) {
      ingestionObservedAt = noteTime(ingestionObservedAt, row.observedAt)
      const [worktreeId, generation] = row.externalId.split(':')
      if (worktreeId && generation && !worktrees.has(row.externalId) && worktrees.size < 12) {
        worktrees.set(row.externalId, { worktreeId, generation })
      }
    }
    if (priorityWorktree) {
      const priorityId = priorityWorktree.worktreeId + ':' + priorityWorktree.generation
      if (!worktrees.has(priorityId)) {
        const list = [...worktrees.entries()]
        if (list.length >= 12) list.pop()
        worktrees.clear()
        worktrees.set(priorityId, { worktreeId: priorityWorktree.worktreeId, generation: priorityWorktree.generation })
        for (const [k, v] of list) worktrees.set(k, v)
      }
    }
    if (!eventObservedAt && !ingestionObservedAt) {
      const latest = this.db.prepare(`SELECT MAX(ts) AS observedAt FROM (
        SELECT MAX(observedAt) AS ts FROM registry_edges WHERE fromId=? AND state='OBSERVED'
        UNION ALL
        SELECT MAX(observedAt) AS ts FROM registry_edges WHERE toId=? AND state='OBSERVED'
      )`).get(key, key) as { observedAt: string | null } | undefined
      ingestionObservedAt = noteTime(ingestionObservedAt, latest?.observedAt)
    }
    const lastObserved = eventObservedAt ?? ingestionObservedAt
    return { worktrees: [...worktrees.values()], lastObserved, agent }
  }

  private aliasStateFor(externalId: string, localSessionId: string | null): 'NOT_RECONCILED' | 'RECONCILED' | 'ALIAS_CONFLICT' {
    if (!localSessionId) return 'NOT_RECONCILED'
    const row = this.db.prepare('SELECT provider, providerSessionId, agent FROM sessions WHERE id=?').get(localSessionId) as { provider: string; providerSessionId: string; agent: string } | undefined
    if (!row) return 'ALIAS_CONFLICT'
    const sel = sessionSelector(externalId)
    const expectedAgent = sel.agent ?? (sel.provider === 'antigravity-native' ? 'antigravity' : 'codex')
    const sameIdentity = row.provider === sel.provider && row.providerSessionId === sel.id && row.agent === expectedAgent
    const otherRefs = this.db.prepare("SELECT COUNT(*) AS n FROM registry_entities WHERE kind='SESSION' AND localSessionId=? AND externalId<>?").get(localSessionId, externalId) as { n: number }
    return sameIdentity && otherRefs.n === 0 ? 'RECONCILED' : 'ALIAS_CONFLICT'
  }

  private nativeSessionRecord(externalId: string, witness?: SessionWitness, evidence?: object, priorityWorktree?: WorktreeRef): RegistrySessionRecord {
    const { provider, id, agent: parsedAgent } = sessionSelector(externalId)
    const meta = this.worktreesAndObservedAt(externalId, priorityWorktree)
    const agent = parsedAgent ?? meta.agent ?? (provider === 'antigravity-native' ? 'antigravity' : 'codex')
    const entityRow = this.db.prepare('SELECT localSessionId FROM registry_entities WHERE id=?').get(this.key({ kind: 'SESSION', id: externalId })) as { localSessionId: string | null } | undefined
    const localSessionId = entityRow?.localSessionId ?? null
    const aliasState = this.aliasStateFor(externalId, localSessionId)
    const isNative = provider === 'codex-native' || provider === 'antigravity-native'
    const provenOrigin = priorityWorktree ?? (meta.worktrees.length === 1 ? meta.worktrees[0] : undefined)
    const deepen = isNative
      ? { tool: 'inspect_agent_session', arguments: { repositoryId: this.repositoryId, nativeSession: { provider, id, ...(provenOrigin ? { worktreeId: provenOrigin.worktreeId, generation: provenOrigin.generation } : {}) } } }
      : { tool: 'inspect_agent_session', arguments: { ...(localSessionId ? { sessionId: localSessionId } : { repositoryId: this.repositoryId }) } }
    return {
      provider, providerSessionId: id, agent,
      origin: isNative ? 'NATIVE_HOOK' : 'CHECKPOINT_REGISTRY',
      aliasState,
      ...(localSessionId && aliasState === 'RECONCILED' ? { sessionId: localSessionId } : {}),
      ...(meta.lastObserved ? { lastObserved: meta.lastObserved } : {}),
      worktrees: meta.worktrees,
      ...(witness ? { witness } : {}),
      ...(evidence ? { evidence } : {}),
      deepen
    }
  }

  private witnessForPath(edgesById: Map<string, { evidenceKind: string; relation: string; sourceRevision: string; confidenceClass: ProvenanceClass; state: string }>, edgeIds: string[]): SessionWitness | undefined {
    const pathEdges = edgeIds.map(id => edgesById.get(id)).filter((e): e is NonNullable<typeof e> => !!e)
    if (!pathEdges.length) return undefined
    const strengthOrder: ProvenanceClass[] = ['UNKNOWN', 'DERIVED', 'DECLARED', 'OBSERVED', 'VERIFIED_CAUSAL']
    const stateOrder = ['UNKNOWN', 'STALE', 'DECLARED', 'OBSERVED', 'VERIFIED']
    let strength: ProvenanceClass = 'VERIFIED_CAUSAL'
    let state = 'VERIFIED'
    for (const edge of pathEdges) {
      if (strengthOrder.indexOf(edge.confidenceClass) < strengthOrder.indexOf(strength)) strength = edge.confidenceClass
      const sIdx = stateOrder.indexOf(edge.state)
      if (sIdx !== -1 && sIdx < stateOrder.indexOf(state)) state = edge.state
    }
    const primary = pathEdges.find(e => e.evidenceKind !== 'CONTINUUM_REVISION' && !['invoked', 'observed-in', 'scoped-to'].includes(e.relation))
      ?? pathEdges.find(e => e.evidenceKind !== 'CONTINUUM_REVISION')
      ?? pathEdges[0]
    return { kind: primary.evidenceKind, relation: primary.relation, revision: primary.sourceRevision, strength, state }
  }

  private matchesSessionFilter(record: RegistrySessionRecord, filter: NativeSessionFilter): boolean {
    if (filter.agent && record.agent !== filter.agent) return false
    if (filter.worktreeId && filter.generation) {
      if (!record.worktrees.some(w => w.worktreeId === filter.worktreeId && w.generation === filter.generation)) return false
    }
    if (filter.after) {
      if (!record.lastObserved || Date.parse(record.lastObserved) < Date.parse(filter.after)) return false
    }
    if (filter.before) {
      if (!record.lastObserved || Date.parse(record.lastObserved) > Date.parse(filter.before)) return false
    }
    return true
  }

  linkedSessions(selector: RegistryEntity, filter: NativeSessionFilter = {}, accountHash?: string) {
    const graph = this.contextGraph(selector, accountHash, 4, false)
    const edgesById = new Map(graph.edges.map(edge => [edge.id, edge]))
    const pathByTarget = new Map(graph.paths.map(path => [path.target, path.edges]))
    const dedup = new Map<string, RegistrySessionRecord>()
    for (const node of graph.nodes) {
      if (node.type !== 'SESSION' || !node.provider) continue
      const externalId = sessionIdentity(node.provider, node.id, node.agent)
      if (!this.visible({ kind: 'SESSION', id: externalId }, accountHash)) continue
      const witness = this.witnessForPath(edgesById, pathByTarget.get(node.key) ?? [])
      const record = this.nativeSessionRecord(externalId, witness)
      if (!this.matchesSessionFilter(record, filter)) continue
      const key = `${record.provider}\0${record.agent}\0${record.providerSessionId}`
      if (!dedup.has(key)) dedup.set(key, record)
    }
    const rows = [...dedup.values()].sort((a, b) => (b.lastObserved ?? '').localeCompare(a.lastObserved ?? '') || a.providerSessionId.localeCompare(b.providerSessionId))
    return { rows, bounded: graph.bounded, revision: digest(JSON.stringify([selector, rows.map(r => [r.provider, r.providerSessionId, r.agent, r.witness])])) }
  }

  private nativeAgentSql(agent?: string): { clause: string; empty: boolean } {
    if (!agent) return { clause: "(s.externalId LIKE 'codex-native:%' OR s.externalId LIKE 'antigravity-native:%')", empty: false }
    if (agent === 'codex') return { clause: "s.externalId LIKE 'codex-native:%'", empty: false }
    if (agent === 'antigravity') return { clause: "s.externalId LIKE 'antigravity-native:%'", empty: false }
    return { clause: '0=1', empty: true }
  }

  private nativeCandidateQuery(filter: NativeSessionFilter, needLastObserved: boolean): { sql: string; params: (string | number)[]; empty: boolean } {
    const agent = this.nativeAgentSql(filter.agent)
    if (agent.empty) return { sql: '', params: [], empty: true }
    const afterMs = filter.after ? Date.parse(filter.after) : undefined
    const beforeMs = filter.before ? Date.parse(filter.before) : undefined
    if ((afterMs !== undefined && !Number.isFinite(afterMs)) || (beforeMs !== undefined && !Number.isFinite(beforeMs))) {
      return { sql: '', params: [], empty: true }
    }
    const afterIso = afterMs !== undefined ? new Date(afterMs).toISOString() : undefined
    const beforeIso = beforeMs !== undefined ? new Date(beforeMs).toISOString() : undefined
    const params: (string | number)[] = []
    let cte = ''
    let from = 'registry_entities s'
    if (filter.worktreeId && filter.generation) {
      const wKey = this.key({ kind: 'WORKTREE', id: `${filter.worktreeId}:${filter.generation}` })
      cte = `WITH candidate_ids(sid) AS (
        SELECT e.toId FROM registry_edges e WHERE e.fromId=? AND e.state='OBSERVED'
        UNION
        SELECT e.fromId FROM registry_edges e WHERE e.toId=? AND e.state='OBSERVED'
        UNION
        SELECT r.toId FROM registry_edges e
        JOIN registry_edges r ON r.fromId=e.fromId AND r.state='OBSERVED'
        WHERE e.toId=? AND e.state='OBSERVED' AND json_extract(e.payload,'$.relation') IN ('observed-in','scoped-to','window-start')
        UNION
        SELECT r.fromId FROM registry_edges e
        JOIN registry_edges r ON r.fromId=e.fromId AND r.state='OBSERVED'
        WHERE e.toId=? AND e.state='OBSERVED' AND json_extract(e.payload,'$.relation') IN ('observed-in','scoped-to')
      ) `
      from = 'candidate_ids c JOIN registry_entities s ON s.id=c.sid'
      params.push(wKey, wKey, wKey, wKey)
    }
    const baseWhere = `s.kind='SESSION' AND ${agent.clause}`
    if (!needLastObserved && !afterIso && !beforeIso) {
      return { sql: `${cte}SELECT s.externalId FROM ${from} WHERE ${baseWhere}`, params, empty: false }
    }
    const lastObservedExpr = `COALESCE(
      (SELECT MAX(strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(sr.cursor,'$.observedAt')))
       FROM registry_edges e JOIN registry_sources sr ON sr.source=e.source
       WHERE e.toId=s.id AND e.state='OBSERVED' AND e.source LIKE 'NATIVE_HOOK:%'
         AND json_valid(sr.cursor) AND json_extract(sr.cursor,'$.repositoryId')=? AND json_extract(sr.cursor,'$.schema')=1),
      (SELECT MAX(strftime('%Y-%m-%dT%H:%M:%fZ', sr.observedAt))
       FROM registry_edges e JOIN registry_sources sr ON sr.source=e.source
       WHERE e.toId=s.id AND e.state='OBSERVED' AND e.source LIKE 'NATIVE_HOOK:%'),
      (SELECT MAX(ts) FROM (
        SELECT MAX(strftime('%Y-%m-%dT%H:%M:%fZ', e.observedAt)) AS ts FROM registry_edges e WHERE e.fromId=s.id AND e.state='OBSERVED'
        UNION ALL
        SELECT MAX(strftime('%Y-%m-%dT%H:%M:%fZ', e.observedAt)) AS ts FROM registry_edges e WHERE e.toId=s.id AND e.state='OBSERVED'
      ))
    )`
    params.push(this.repositoryId)
    const timeFilters: string[] = []
    if (afterIso) { timeFilters.push('lastObservedSort IS NOT NULL AND lastObservedSort >= ?'); params.push(afterIso) }
    if (beforeIso) { timeFilters.push('lastObservedSort IS NOT NULL AND lastObservedSort <= ?'); params.push(beforeIso) }
    const inner = `${cte}SELECT s.externalId, ${lastObservedExpr} AS lastObservedSort FROM ${from} WHERE ${baseWhere}`
    const outerWhere = timeFilters.length ? ` WHERE ${timeFilters.join(' AND ')}` : ''
    return { sql: `SELECT externalId, lastObservedSort FROM (${inner})${outerWhere}`, params, empty: false }
  }

  nativeSessionsRevision(filter: Pick<NativeSessionFilter, 'worktreeId' | 'generation'> = {}): string {
    const hookRev = this.source('NATIVE_HOOK')?.revision ?? 'empty'
    const importedRev = this.source('IMPORTED_SESSIONS')?.revision ?? 'empty'
    const identityRow = this.db.prepare('SELECT revision FROM identity').get() as { revision: number } | undefined
    const sessionRow = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(revision),0) AS revSum FROM sessions').get() as { n: number; revSum: number }
    const entityRow = this.db.prepare("SELECT COUNT(*) AS n, COUNT(localSessionId) AS aliased, COALESCE(MAX(localSessionId),'') AS maxAlias FROM registry_entities WHERE kind='SESSION' AND (externalId LIKE 'codex-native:%' OR externalId LIKE 'antigravity-native:%')").get() as { n: number; aliased: number; maxAlias: string }
    const sourceRow = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(observedAt),'') AS maxAt, COALESCE(SUM(CASE WHEN status='COMPLETE' THEN 1 ELSE 0 END),0) AS completeCount FROM registry_sources").get() as { n: number; maxAt: string; completeCount: number }
    let worktreeEdges: { n: number; maxAt: string } | undefined
    if (filter.worktreeId && filter.generation) {
      const wKey = this.key({ kind: 'WORKTREE', id: `${filter.worktreeId}:${filter.generation}` })
      worktreeEdges = this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(observedAt),'') AS maxAt FROM (
        SELECT observedAt FROM registry_edges WHERE toId=? AND state='OBSERVED'
        UNION ALL
        SELECT observedAt FROM registry_edges WHERE fromId=? AND state='OBSERVED'
      )`).get(wKey, wKey) as { n: number; maxAt: string }
    }
    return digest(JSON.stringify([
      hookRev, importedRev, identityRow?.revision ?? 0,
      sessionRow.n, sessionRow.revSum,
      entityRow.n, entityRow.aliased, entityRow.maxAlias,
      sourceRow.n, sourceRow.maxAt, sourceRow.completeCount,
      worktreeEdges ? [worktreeEdges.n, worktreeEdges.maxAt] : null
    ]))
  }

  hasNativeSession(filter: Pick<NativeSessionFilter, 'worktreeId' | 'generation' | 'agent' | 'after' | 'before'>, accountHash?: string): boolean {
    const query = this.nativeCandidateQuery(filter, false)
    if (query.empty) return false
    const rows = this.db.prepare(`${query.sql} LIMIT 1`).all(...query.params) as { externalId: string }[]
    if (rows.length === 0) return false
    if (this.visible({ kind: 'SESSION', id: rows[0].externalId }, accountHash)) return true
    const fallback = this.db.prepare(query.sql).all(...query.params) as { externalId: string }[]
    return fallback.some(row => this.visible({ kind: 'SESSION', id: row.externalId }, accountHash))
  }

  queryNativeSessions(
    filter: NativeSessionFilter,
    accountHash?: string,
    pageOrResolve?: NativeSessionPageOptions | ((revision: string) => NativeSessionPageOptions)
  ) {
    const reasons = new Set<string>()
    for (const source of this.coverageSources()) {
      if (['NATIVE_HOOK', 'ENTIRE_REFS'].includes(source.source) && ['PARTIAL', 'UNAVAILABLE', 'UNSUPPORTED', 'NETWORK_NOT_AUTHORIZED'].includes(source.status)) {
        reasons.add(source.source + '_' + source.status)
      }
    }
    const resolveSlice = (revision: string) => typeof pageOrResolve === 'function' ? pageOrResolve(revision) : pageOrResolve
    const sliceRows = <T>(rows: T[], page?: NativeSessionPageOptions): T[] => {
      if (!page) return rows
      const offset = page.offset ?? 0
      return page.limit !== undefined ? rows.slice(offset, offset + page.limit) : rows.slice(offset)
    }
    const priorityWorktree = filter.worktreeId && filter.generation ? { worktreeId: filter.worktreeId, generation: filter.generation } : undefined
    if (filter.commitSha || filter.pullRequest) {
      const delivery = this.nativeDeliverySessions(filter.commitSha ? { kind: 'COMMIT', id: filter.commitSha } : { kind: 'PR', id: String(filter.pullRequest) }, accountHash)
      const all = delivery.rows.map(row => {
        const evidence = (row as { evidence?: { native?: { kind?: string; revision?: string; state?: string } } }).evidence
        const witness: SessionWitness | undefined = evidence?.native?.revision ? {
          kind: evidence.native.kind ?? 'NATIVE_GIT_CAUSAL', relation: 'committed', revision: evidence.native.revision, strength: 'VERIFIED_CAUSAL', state: 'VERIFIED'
        } : undefined
        return this.nativeSessionRecord(`${row.provider}:${row.providerSessionId}`, witness, evidence, priorityWorktree)
      }).filter(record => this.matchesSessionFilter(record, filter))
      const combinedReasons = [...new Set([...delivery.reasons])].sort()
      const revision = digest(JSON.stringify([delivery.revision, filter.worktreeId ?? null, filter.generation ?? null, filter.agent ?? null, filter.after ?? null, filter.before ?? null]))
      const page = resolveSlice(revision)
      return { rows: sliceRows(all, page), reasons: combinedReasons, revision, coverage: !all.length || combinedReasons.length ? 'PARTIAL' : 'OBSERVED_INDEX', isDelivery: true }
    }
    if (filter.artifactId || filter.executionId) {
      const selector: RegistryEntity = filter.artifactId ? { kind: 'ARTIFACT', id: filter.artifactId } : { kind: 'EXECUTION', id: filter.executionId! }
      const linked = this.linkedSessions(selector, filter, accountHash)
      const nativeOnly = linked.rows.filter(r => r.origin === 'NATIVE_HOOK')
      if (linked.bounded) reasons.add('GRAPH_LIMIT_REACHED')
      const sortedReasons = [...reasons].sort()
      const revision = digest(JSON.stringify([linked.revision, sortedReasons]))
      const page = resolveSlice(revision)
      return { rows: sliceRows(nativeOnly, page), reasons: sortedReasons, revision, coverage: !nativeOnly.length || sortedReasons.length ? 'PARTIAL' : 'OBSERVED_INDEX', isDelivery: false }
    }
    const revision = this.nativeSessionsRevision(filter)
    const page = resolveSlice(revision)
    const candidate = this.nativeCandidateQuery(filter, true)
    if (candidate.empty) {
      return { rows: [], reasons: [...reasons].sort(), revision, coverage: reasons.size ? 'PARTIAL' : 'OBSERVED_INDEX', isDelivery: false }
    }
    const orderClause = "ORDER BY COALESCE(lastObservedSort,'') DESC, substr(externalId, instr(externalId, ':') + 1) ASC"
    const offset = page?.offset ?? 0
    const limit = page?.limit
    const selected = (limit !== undefined
      ? this.db.prepare(`${candidate.sql} ${orderClause} LIMIT ? OFFSET ?`).all(...candidate.params, limit, offset)
      : offset > 0
        ? this.db.prepare(`${candidate.sql} ${orderClause} LIMIT -1 OFFSET ?`).all(...candidate.params, offset)
        : this.db.prepare(`${candidate.sql} ${orderClause}`).all(...candidate.params)
    ) as { externalId: string; lastObservedSort: string | null }[]
    const rows: RegistrySessionRecord[] = []
    for (const row of selected) {
      if (!this.visible({ kind: 'SESSION', id: row.externalId }, accountHash)) continue
      rows.push(this.nativeSessionRecord(row.externalId, undefined, undefined, priorityWorktree))
    }
    return { rows, reasons: [...reasons].sort(), revision, coverage: reasons.size ? 'PARTIAL' : 'OBSERVED_INDEX', isDelivery: false }
  }

  private nativeSession(externalId: string) {
    const { provider, id } = sessionSelector(externalId)
    const agent = provider === 'antigravity-native' ? 'antigravity' : 'codex'
    return { provider, providerSessionId: id, agent, origin: 'NATIVE_HOOK', aliasState: 'NOT_RECONCILED',
      deepen: { tool: 'inspect_agent_session', arguments: { repositoryId: this.repositoryId, nativeSession: { provider, id } } } }
  }
  readSnapshot<T>(read: () => T): T { return this.db.transaction(read).deferred() }
  key(entity: RegistryEntity): string {
    if (!kinds.includes(entity.kind) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,399}$/.test(entity.id)) throw new Error('INVALID_REGISTRY_ENTITY')
    return `${entity.kind}:${this.repositoryId}:${entity.id}`
  }
  sources(): { source: string; revision: string; cursor?: string; status: string; observedAt: string }[] {
    return this.db.prepare('SELECT * FROM registry_sources ORDER BY observedAt DESC,source LIMIT 20').all() as ReturnType<CheckpointRegistry['sources']>
  }
  coverageSources(): ReturnType<CheckpointRegistry['sources']> {
    return this.db.prepare("SELECT * FROM registry_sources WHERE source IN ('CONTINUUM','LEDGER','GITHUB','GITHUB_DISCOVERY','DELIVERY_GIT','DELIVERY_PR','DELIVERY_CONTINUUM','NATIVE_HOOK','IMPORTED_SESSIONS','ENTIRE_COMMITS','ENTIRE_REFS','LEGACY') ORDER BY source").all() as ReturnType<CheckpointRegistry['sources']>
  }
  source(source: string): ReturnType<CheckpointRegistry['sources']>[number] | undefined { return this.db.prepare('SELECT * FROM registry_sources WHERE source=?').get(source) as ReturnType<CheckpointRegistry['source']> }
  cursors(): Record<string, string> { return Object.fromEntries((this.db.prepare("SELECT source,cursor FROM registry_sources WHERE cursor IS NOT NULL ORDER BY CASE WHEN source IN ('CONTINUUM','LEDGER','DELIVERY_GIT','DELIVERY_PR','DELIVERY_CONTINUUM','GITHUB_DISCOVERY','GITHUB_REFRESH','ENTIRE_REFS') THEN 0 ELSE 1 END,observedAt DESC LIMIT 100").all() as { source: string; cursor: string }[]).map(s => [s.source, s.cursor])) }
  applyAll(batches: RegistryBatch[], assertCurrent: () => void): void {
    this.db.transaction(() => {
      const discovery = batches.find(batch => batch.source === 'GITHUB_DISCOVERY')
      const repeated = !!discovery && batches.some(batch => {
        if (!/^GITHUB_CATALOG:PR:[0-9]+$/.test(batch.source)) return false
        try {
          const incoming = JSON.parse(batch.cursor ?? '{}'), prior = JSON.parse(this.source(batch.source)?.cursor ?? '{}')
          return typeof incoming.scanPass === 'string' && incoming.scanPass === prior.scanPass
        } catch { return false }
      })
      for (let batch of batches) {
        if (batch === discovery && repeated) {
          const cursor = JSON.parse(batch.cursor ?? '{}')
          Object.assign(cursor, { phase: 'FULL', page: 1, rolling: digest('GITHUB_UPDATED_DESC_V1'), reasonCode: 'CATALOG_PAGE_OVERLAP', pass: digest(String(cursor.pass) + 'RESTART') })
          const previous = JSON.parse(this.source('GITHUB_DISCOVERY')?.cursor ?? '{}')
          if (previous.highWatermarkUpdatedAt) cursor.highWatermarkUpdatedAt = previous.highWatermarkUpdatedAt
          else delete cursor.highWatermarkUpdatedAt
          delete cursor.previousPass; delete cursor.high
          batch = { ...batch, revision: digest(JSON.stringify(cursor)), cursor: JSON.stringify(cursor), status: 'PARTIAL' }
        }
        this.apply(batch, this.source(batch.source)?.revision, assertCurrent)
      }
      assertCurrent()
    }).immediate()
  }
  apply(batch: RegistryBatch, expectedRevision: string | undefined, assertCurrent: () => void = () => {}): void {
    if (batch.repositoryId !== this.repositoryId) throw new Error('REPOSITORY_MISMATCH')
    if (!/^[A-Za-z0-9:._-]{1,500}$/.test(batch.source) || batch.revision.length > 500 || batch.edges.length > 200 || (batch.entities?.length ?? 0) > 100 || (batch.artifactLabels?.length ?? 0) > 20 || (batch.cursor?.length ?? 0) > 4096) throw new Error('REGISTRY_BATCH_LIMIT')
    this.db.transaction(() => {
      assertCurrent()
      const old = this.db.prepare('SELECT revision FROM registry_sources WHERE source=?').get(batch.source) as { revision: string } | undefined
      if (old?.revision !== expectedRevision) throw new Error('REVISION_CONFLICT')
      const observedAt = new Date().toISOString()
      const entity = (value: RegistryEntity) => {
        const id = this.key(value)
        this.db.prepare('INSERT OR IGNORE INTO registry_entities(id,kind,externalId) VALUES(?,?,?)').run(id, value.kind, value.id)
        return id
      }
      for (const value of batch.entities ?? []) entity(value)
      for (const { id, snapshot } of batch.artifactLabels ?? []) {
        if (!snapshot) {
          this.db.prepare('UPDATE registry_entities SET artifactLabel=NULL, artifactDescription=NULL WHERE id=?').run(this.key({ kind: 'ARTIFACT', id }))
          continue
        }
        const key = entity({ kind: 'ARTIFACT', id })
        const { description, id: artifactId, ...label } = snapshot
        const exact = artifactId + ':' + label.revision
        if ((id !== artifactId && id !== exact) || !Number.isSafeInteger(label.revision) || label.revision < 1 || !/^[a-f0-9]{64}$/.test(label.contentHash)) throw new Error('INVALID_ARTIFACT_LABEL')
        const text = description === undefined ? null : utf8Prefix(description, 384)
        const fields = { ...label, title: label.title === undefined ? undefined : utf8Prefix(label.title, 120),
          artifactKind: label.artifactKind === undefined ? undefined : utf8Prefix(label.artifactKind, 80), status: label.status === undefined ? undefined : utf8Prefix(label.status, 40),
          descriptionTruncated: description !== undefined && text !== description }
        if (id === artifactId) {
          const prior = this.source('CONTINUUM_CURRENT:' + id)?.revision.split(':')[0]
          if (prior && /^[1-9][0-9]*$/.test(prior) && prior !== String(label.revision)) {
            this.db.prepare("UPDATE registry_entities SET artifactLabel=json_set(artifactLabel,'$.freshness','SOURCE_STALE') WHERE id=? AND artifactLabel IS NOT NULL")
              .run(this.key({ kind: 'ARTIFACT', id: artifactId + ':' + prior }))
          }
        }
        this.db.prepare('UPDATE registry_entities SET artifactLabel=?,artifactDescription=? WHERE id=?').run(JSON.stringify(fields), text, key)
      }
      for (const edge of batch.edges) {
        if (!/^[A-Za-z0-9:_-]{1,100}$/.test(edge.relation) || !/^[A-Z_]{1,80}$/.test(edge.evidenceKind) || edge.evidenceRef.length > 500 || !/^[a-f0-9]{64}$/.test(edge.digest) || !/^[A-Z_]{1,80}$/.test(edge.freshness)) throw new Error('INVALID_REGISTRY_EVIDENCE')
        const from = entity(edge.from), to = entity(edge.to)
        const payload = JSON.stringify(edge), integrity = digest(payload)
        const id = digest(JSON.stringify([this.repositoryId, batch.source, batch.revision, integrity]))
        const existing = this.db.prepare('SELECT payload,integrity FROM registry_edges WHERE id=?').get(id) as { payload: string; integrity: string } | undefined
        if (existing && (existing.payload !== payload || existing.integrity !== integrity)) throw new Error('REGISTRY_INTEGRITY_FAILED')
        this.db.prepare('INSERT OR IGNORE INTO registry_edges VALUES(?,?,?,?,?,?,?,?,?)').run(id, batch.source, batch.revision, from, to, payload, integrity, observedAt, 'OBSERVED')
        this.db.prepare("UPDATE registry_edges SET state='OBSERVED' WHERE id=?").run(id)
      }
      if (batch.status === 'COMPLETE') {
        this.db.prepare('UPDATE registry_edges SET state=? WHERE source=? AND sourceRevision<>? AND state=?').run('SUPERSEDED', batch.source, batch.revision, 'OBSERVED')
      }
      if (batch.status === 'CHECKPOINT_NOT_OBSERVED') this.db.prepare('UPDATE registry_edges SET state=? WHERE source=? AND state=?').run('STALE', batch.source, 'OBSERVED')
      if (/^GITHUB:PR:[0-9]+$/.test(batch.source) && batch.status === 'CONFLICT') this.db.prepare("UPDATE registry_edges SET state='CONFLICT' WHERE source LIKE ? AND state='OBSERVED'").run(batch.source + ':%')
      if (batch.status === 'CONFLICT') this.db.prepare('UPDATE registry_edges SET state=? WHERE source=? AND state=?').run('CONFLICT', batch.source, 'OBSERVED')
      if (batch.status === 'REPLACED') this.db.prepare('UPDATE registry_edges SET state=? WHERE source=? AND state=?').run('SUPERSEDED', batch.source, 'OBSERVED')
      if (/^GITHUB:PR:[0-9]+$/.test(batch.source) && ['PARTIAL', 'COMPLETE'].includes(batch.status)) this.db.prepare("UPDATE registry_edges SET state='STALE' WHERE source LIKE ? AND sourceRevision<>? AND state='OBSERVED'").run(batch.source + ':%', batch.revision)
      this.db.prepare(`INSERT INTO registry_sources VALUES(?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor,status=(CASE WHEN excluded.status='SELECTED_SCOPE' AND status IN ('PARTIAL','UNAVAILABLE') THEN status ELSE excluded.status END),observedAt=excluded.observedAt`).run(batch.source, batch.revision, batch.cursor ?? null, batch.status, observedAt)
      assertCurrent()
    }).immediate()
  }
  checkpoint(id: string, revision: string, state: string, hash: string, sessionIds: string[], sessionRefs?: { id: string; agent: string }[]): void {
    this.key({ kind: 'CHECKPOINT', id })
    const payload = JSON.stringify(sessionRefs ? { sessionIds, sessionRefs } : sessionIds), integrity = digest(JSON.stringify([id, revision, state, hash, payload]))
    this.db.prepare('INSERT OR IGNORE INTO checkpoint_registry VALUES(?,?,?,?,?,?,?)').run(id, revision, state, hash, payload, integrity, new Date().toISOString())
  }
  cachedCheckpoint(id: string, revision: string): { state: 'VERIFIED'; reason: string; checkpointId: string; refRevision: string; metadataDigest: string; sessionIds: string[]; sessionRefs?: { id: string; agent: string }[] } | undefined {
    const row = this.db.prepare("SELECT * FROM checkpoint_registry WHERE checkpointId=? AND refRevision=? AND state='VERIFIED'").get(id, revision) as { digest: string; sessionIds: string; integrity: string } | undefined
    if (!row) return
    if (digest(JSON.stringify([id, revision, 'VERIFIED', row.digest, row.sessionIds])) !== row.integrity) throw new Error('REGISTRY_INTEGRITY_FAILED')
    const payload = JSON.parse(row.sessionIds), sessionIds = Array.isArray(payload) ? payload : payload.sessionIds
    if (!Array.isArray(sessionIds) || sessionIds.length > 20 || sessionIds.some(s => typeof s !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(s))) throw new Error('REGISTRY_INTEGRITY_FAILED')
    if (payload.sessionRefs && (!Array.isArray(payload.sessionRefs) || payload.sessionRefs.length > 20 || payload.sessionRefs.some((item: { id: unknown; agent: unknown }) => typeof item.id !== 'string' || !sessionIds.includes(item.id) || typeof item.agent !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(item.agent)))) throw new Error('REGISTRY_INTEGRITY_FAILED')
    return { state: 'VERIFIED', reason: 'VERIFIED', checkpointId: id, refRevision: revision, metadataDigest: row.digest, sessionIds, ...(payload.sessionRefs ? { sessionRefs: payload.sessionRefs } : {}) }
  }
  importedSession(provider: string, providerId: string, sessionId: string, agent?: string): void {
    const entity: RegistryEntity = this.sessionIdentity(sessionId) ?? { kind: 'SESSION', id: sessionIdentity(provider, providerId, agent) }
    this.db.prepare('INSERT INTO registry_entities(id,kind,externalId,localSessionId) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET localSessionId=excluded.localSessionId').run(this.key(entity), entity.kind, entity.id, sessionId)
  }
  evictedSession(id: string): boolean { return !!this.db.prepare("SELECT 1 FROM registry_entities WHERE kind='SESSION' AND localSessionId=? LIMIT 1").get(id) }
  sessionIdentity(id: string): RegistryEntity | undefined {
    const row = this.db.prepare("SELECT externalId FROM registry_entities WHERE kind='SESSION' AND localSessionId=? LIMIT 1").get(id) as { externalId: string } | undefined
    return row ? { kind: 'SESSION', id: row.externalId } : undefined
  }
  visible(entity: RegistryEntity, accountHash?: string): boolean {
    if (entity.kind !== 'SESSION' || !entity.id.startsWith('codex:')) return true
    if (!accountHash) {
      const archived = this.db.prepare("SELECT a.payload,a.integrity FROM sessions s JOIN session_associations a ON a.sessionId=s.id WHERE s.provider='codex' AND s.providerSessionId=? AND s.importState='METADATA_ONLY' AND s.eventCount=0 AND s.payloadBytes=0 AND json_extract(a.payload,'$.origin')='CODEX_APP_SERVER' AND json_extract(a.payload,'$.archived')=1 LIMIT 1").get(entity.id.slice(6)) as { payload: string; integrity: string } | undefined
      if (!archived) return false
      if (digest(archived.payload) !== archived.integrity || JSON.parse(archived.payload).repositoryId !== this.repositoryId) throw new Error('ASSOCIATION_INTEGRITY_ERROR')
      return true
    }
    const row = this.db.prepare("SELECT payload,integrity FROM session_associations WHERE provider='codex' AND providerSessionId=? AND json_extract(payload,'$.providerAccountHash')=? LIMIT 1").get(entity.id.slice(6), accountHash) as { payload: string; integrity: string } | undefined
    if (row && (digest(row.payload) !== row.integrity || JSON.parse(row.payload).repositoryId !== this.repositoryId)) throw new Error('ASSOCIATION_INTEGRITY_ERROR')
    return !!row
  }
  artifactLabel(id: string, allowed: boolean) {
    if (!allowed) return { metadataCoverage: 'GATE_REQUIRED' as const }
    if (this.source('CONTINUUM')?.status === 'UNAVAILABLE') return { metadataCoverage: 'SOURCE_UNAVAILABLE' as const }
    return this.readArtifactLabel(this.key({ kind: 'ARTIFACT', id }))
  }
  private readArtifactLabel(key: string) {
    if (!this.supportsArtifactLabels) return { metadataCoverage: 'NOT_INDEXED' as const }
    const row = this.db.prepare('SELECT artifactLabel FROM registry_entities WHERE id=?').get(key) as { artifactLabel: string | null } | undefined
    const label = row?.artifactLabel ? JSON.parse(row.artifactLabel) as Omit<ArtifactLabelSnapshot, 'id' | 'description'> : undefined
    const metadataCoverage = label?.title || label?.artifactKind || label?.status ? 'PROJECTED' : 'NOT_INDEXED'
    return { metadataCoverage, ...(label ? { title: label.title, artifactKind: label.artifactKind, status: label.status,
      artifactRevision: label.revision, metadataFreshness: label.freshness } : {}) }
  }
  artifactDescription(key: string): { description: string; descriptionTruncated: boolean } | undefined {
    if (!this.supportsArtifactLabels) return
    const row = this.db.prepare("SELECT artifactDescription AS description, json_extract(artifactLabel,'$.descriptionTruncated') AS truncated FROM registry_entities WHERE id=? AND kind='ARTIFACT' AND artifactLabel IS NOT NULL").get(key) as { description: string | null; truncated: number } | undefined
    if (row && row.description !== null) return { description: row.description, descriptionTruncated: !!row.truncated }
  }
  contextGraph(selector: RegistryEntity, accountHash?: string, depthLimit = 4, allowArtifactMetadata = false) {
    type Node = { key: string; type: EntityKind; id: string; revision?: number; generation?: string; provider?: string; agent?: string; payloadState?: string; title?: string; artifactKind?: string; status?: string; description?: string; descriptionTruncated?: boolean; metadataCoverage?: string; metadataFreshness?: ArtifactLabelSnapshot['freshness']; artifactRevision?: number; selector?: object; deepen?: { tool: string; arguments: object } }
    type Edge = { id: string; from: string; to: string; relation: string; evidenceKind: string; source: string; state: string; freshness: string; observedAt: string; sourceRevision: string; revision: string; evidenceRef: string; digest: string; confidenceClass: ProvenanceClass; coverage: string; revisionScope: string }
    const nodes = new Map<string, Node>(), edges = new Map<string, Edge>(), paths: { target: string; edges: string[] }[] = []
    const continuumUnavailable = this.source('CONTINUUM')?.status === 'UNAVAILABLE'
    let bounded = false
    const authority = new Map<string, boolean>()
    const nativeAuthority = (source: string, receiptId: string) => {
      if (authority.has(source)) return authority.get(source)!
      const rows = this.db.prepare("SELECT payload,integrity FROM registry_edges WHERE source=? AND state='OBSERVED' LIMIT 4").all(source) as { payload: string; integrity: string }[]
      let valid = true
      for (const row of rows) {
        if (digest(row.payload) !== row.integrity) throw new Error('REGISTRY_INTEGRITY_FAILED')
        const edge = JSON.parse(row.payload) as RegistryEdge
        if (edge.to.kind !== 'ARTIFACT' || !/:\d+$/.test(edge.to.id)) continue
        const snapshot = this.source('CONTINUUM:' + edge.to.id)
        if (snapshot) {
          const proof = JSON.parse(snapshot.cursor ?? '{}')
          valid &&= proof.nativeState === 'VERIFIED' && proof.receiptId === receiptId
        }
      }
      authority.set(source, valid); return valid
    }
    const add = (entity: RegistryEntity) => {
      const key = this.key(entity)
      if (nodes.has(key)) return key
      const node: Node = { key, type: entity.kind, id: entity.id }
      if (entity.kind === 'SESSION') {
        const row = this.db.prepare('SELECT localSessionId FROM registry_entities WHERE id=?').get(key) as { localSessionId: string | null } | undefined
        Object.assign(node, sessionSelector(entity.id))
        node.payloadState = !row?.localSessionId ? 'NOT_IMPORTED' : this.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(row.localSessionId) ? 'IMPORTED' : 'SESSION_EVICTED'
        if (row?.localSessionId) node.deepen = { tool: 'inspect_agent_session', arguments: { sessionId: row.localSessionId } }
        else if (node.provider === 'codex-native' || node.provider === 'antigravity-native') {
          node.deepen = { tool: 'inspect_agent_session', arguments: { repositoryId: this.repositoryId, nativeSession: { provider: node.provider, id: node.id } } }
        }
      } else if (entity.kind === 'ARTIFACT') {
        const version = /^(artifact-[a-f0-9-]{36}):([1-9][0-9]*)$/.exec(entity.id)
        if (version) { node.id = version[1]; node.revision = Number(version[2]) }
        if (allowArtifactMetadata) {
          if (continuumUnavailable) node.metadataCoverage = 'SOURCE_UNAVAILABLE'
          else Object.assign(node, this.readArtifactLabel(key))
        } else node.metadataCoverage = 'GATE_REQUIRED'
        if (!version) node.deepen = { tool: 'get_artifact', arguments: { artifactId: node.id } }
      }
      else if (entity.kind === 'WORKTREE') { const scope = /^([a-f0-9]{64}):([a-f0-9]{64})$/.exec(entity.id); if (scope) { node.id = scope[1]; node.generation = scope[2] } }
      else if (entity.kind === 'PROOF') node.deepen = { tool: 'get_validation_proof', arguments: { proofId: entity.id } }
      else if (entity.kind === 'CHECKPOINT') node.deepen = { tool: 'inspect_entire_checkpoint', arguments: { checkpointId: entity.id } }
      node.selector = { type: node.type, id: node.id, ...(node.generation ? { generation: node.generation } : {}), ...(node.revision ? { revision: node.revision } : {}), ...(node.provider ? { provider: node.provider } : {}), ...(node.agent ? { agent: node.agent } : {}) }
      nodes.set(key, node); return key
    }
    if (!this.visible(selector, accountHash) || !this.db.prepare('SELECT 1 FROM registry_entities WHERE id=?').get(this.key(selector))) return { nodes: [], edges: [], paths, bounded }
    const initial = add(selector), visited = new Set([initial]), pending = [{ entity: selector, path: [] as string[] }]
    for (let depth = 0; depth < depthLimit && pending.length; depth++) {
      const level = pending.splice(0)
      for (const item of level) {
        const key = this.key(item.entity)
        const rows = this.db.prepare("SELECT * FROM registry_edges WHERE fromId=? OR toId=? ORDER BY CASE WHEN state='OBSERVED' THEN 0 ELSE 1 END,id LIMIT 65").all(key, key) as { id: string; payload: string; integrity: string; fromId: string; toId: string; source: string; sourceRevision: string; state: string; observedAt: string }[]
        if (rows.length > 64) bounded = true
        for (const row of rows.slice(0, 64)) {
          if (edges.size >= 96) { bounded = true; break }
          const value = JSON.parse(row.payload) as RegistryEdge
          if (digest(row.payload) !== row.integrity || this.key(value.from) !== row.fromId || this.key(value.to) !== row.toId) throw new Error('REGISTRY_INTEGRITY_FAILED')
          if (!this.visible(value.from, accountHash) || !this.visible(value.to, accountHash)) continue
          const selectedVersion = selector.kind === 'ARTIFACT' ? /^(.*):([1-9][0-9]*)$/.exec(selector.id) : null
          if (selectedVersion && value.relation === 'revision' && value.from.kind === 'ARTIFACT' && value.from.id === selectedVersion[1] && value.to.id !== selector.id) continue
          if (depthLimit > 1 && value.from.kind === 'ARTIFACT' && value.to.kind === 'ARTIFACT' && !['implements', 'resolved-by', 'revision', 'references', 'depends-on', 'validates', 'derived-from', 'builds-on'].includes(value.relation)) continue
          if (!['CONTINUUM_REVISIONED_RELATION', 'GITHUB_PR_MERGE', 'OPERATION_EXECUTION_CONTEXT', 'EXECUTION_CONTEXT_OBSERVED', 'DELEGATED_SESSION_LINEAGE', 'BRANCH_CONTEXT_ONLY', 'CHECKPOINT_VERIFIED', 'CHECKPOINT_SESSION_METADATA', 'GITHUB_COMMIT_LIST', 'CONTINUUM_TYPED_RELATION', 'CONTINUUM_REFERENCE', 'CONTINUUM_REVISION', 'EXECUTION_MEMBERSHIP', 'LEDGER_EVIDENCE_FOR', 'HANDOFF_DECLARED', 'WORKTREE_VERIFIED', 'PROVIDER_OBSERVED', 'NATIVE_HOOK_OBSERVED', 'NATIVE_GIT_CAUSAL', 'NATIVE_GIT_SCOPE', 'NATIVE_GIT_REQUEST', 'NATIVE_ARTIFACT_CAUSAL', 'NATIVE_ARTIFACT_SCOPE', 'NATIVE_ARTIFACT_REQUEST'].includes(value.evidenceKind)) continue
          const from = add(value.from), to = add(value.to)
          const invalidAuthority = value.evidenceKind === 'NATIVE_ARTIFACT_CAUSAL' && !nativeAuthority(row.source, value.evidenceRef)
          const projectionStale = continuumUnavailable && row.source.startsWith('CONTINUUM')
          const state = row.state === 'CONFLICT' || invalidAuthority ? 'UNKNOWN' : projectionStale || row.state !== 'OBSERVED' || value.freshness === 'SOURCE_STALE' ? 'STALE' : ['HANDOFF_DECLARED', 'CONTINUUM_TYPED_RELATION', 'CONTINUUM_REVISIONED_RELATION'].includes(value.evidenceKind) ? 'DECLARED' : ['OPERATION_EXECUTION_CONTEXT','EXECUTION_CONTEXT_OBSERVED','DELEGATED_SESSION_LINEAGE','BRANCH_CONTEXT_ONLY','NATIVE_HOOK_OBSERVED','NATIVE_GIT_REQUEST','NATIVE_GIT_SCOPE','NATIVE_ARTIFACT_REQUEST','NATIVE_ARTIFACT_SCOPE'].includes(value.evidenceKind) ? 'OBSERVED' : 'VERIFIED'
          const source = this.source(row.source)
          edges.set(row.id, { id: row.id, from, to, relation: value.relation, evidenceKind: value.evidenceKind, source: row.source.split(':')[0], state, freshness: invalidAuthority || projectionStale ? 'SOURCE_STALE' : value.freshness, observedAt: row.observedAt, sourceRevision: row.sourceRevision, revision: row.sourceRevision, evidenceRef: value.evidenceRef, digest: value.digest,
            confidenceClass: provenanceClass(value.evidenceKind, state), coverage: state === 'UNKNOWN' || state === 'STALE' || source?.status === 'PARTIAL' ? 'PARTIAL' : 'OBSERVED_INDEX', revisionScope: value.evidenceKind === 'LEDGER_EVIDENCE_FOR' ? 'ARTIFACT_IDENTITY_ONLY' : 'EXACT_SOURCE' })
          const next = from === key ? value.to : value.from, target = this.key(next)
          if (!visited.has(target)) {
            visited.add(target); const path = [...item.path, row.id]; paths.push({ target, edges: path })
            if (row.state === 'OBSERVED' && !invalidAuthority && value.freshness !== 'SOURCE_STALE') pending.push({ entity: next, path })
          }
        }
      }
    }
    if (pending.length && depthLimit > 1) bounded = true
    return { nodes: [...nodes.values()], edges: [...edges.values()], paths, bounded }
  }
  map(selector: RegistryEntity, maxEdges = 24) {
    const start = this.key(selector), found = new Map<string, ObservedEdge>(), visited = new Set([start]), frontier = [start]
    let truncated = false
    for (let depth = 0; depth < 6 && frontier.length; depth++) {
      const level = frontier.splice(0)
      for (const node of level) {
        const rows = this.db.prepare('SELECT * FROM registry_edges WHERE fromId=? OR toId=? ORDER BY state,observedAt DESC,id LIMIT ?').all(node, node, maxEdges + 1) as { id: string; payload: string; integrity: string; fromId: string; toId: string; source: string; sourceRevision: string; state: string; observedAt: string }[]
        for (const row of rows) {
          const evidence = JSON.parse(row.payload) as RegistryEdge
          if (digest(row.payload) !== row.integrity || this.key(evidence.from) !== row.fromId || this.key(evidence.to) !== row.toId || !['OBSERVED', 'SUPERSEDED', 'STALE', 'CONFLICT'].includes(row.state)) throw new Error('REGISTRY_INTEGRITY_FAILED')
          if (found.has(row.id)) continue
          if (found.size === maxEdges) { truncated = true; continue }
          found.set(row.id, { ...JSON.parse(row.payload), sourceSystem: row.source, sourceRevision: row.sourceRevision, observedAt: row.observedAt, state: row.state })
          if (row.state !== 'OBSERVED') continue
          for (const id of [row.fromId, row.toId]) if (!visited.has(id)) { visited.add(id); frontier.push(id) }
        }
      }
    }
    return { repositoryId: this.repositoryId, selector, coverage: truncated || frontier.length ? 'PARTIAL' : 'OBSERVED_SNAPSHOT',
      reason: found.size ? 'RELATIONS_OBSERVED' : selector.kind === 'COMMIT' ? 'CHECKPOINT_NOT_OBSERVED' : 'NO_RELATION_OBSERVED',
      edges: [...found.values()], sessions: [...new Set([...found.values()].flatMap(edge => [edge.from, edge.to]).filter(entity => entity.kind === 'SESSION').map(entity => entity.id))].map(id => {
        const entity = this.db.prepare('SELECT localSessionId FROM registry_entities WHERE id=?').get(this.key({ kind: 'SESSION', id })) as { localSessionId: string | null }
        return { providerIdentity: id, ...(entity?.localSessionId ? { sessionId: entity.localSessionId } : {}), payloadState: !entity?.localSessionId ? 'NOT_IMPORTED' : this.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(entity.localSessionId) ? 'IMPORTED' : 'SESSION_EVICTED' }
      }), sources: this.sources(), authorship: 'NOT_INFERRED' }
  }
  legacy(assertCurrent: () => void): void {
    const imported = this.source('IMPORTED_SESSIONS'), sessionAfter = Number(imported?.cursor ?? 0)
    const sessions = this.db.prepare('SELECT rowid AS position,id,provider,providerSessionId,agent FROM sessions WHERE rowid>? ORDER BY rowid LIMIT 20').all(sessionAfter) as { position: number; id: string; provider: string; providerSessionId: string; agent: string }[]
    if (sessions.length) this.db.transaction(() => {
      assertCurrent()
      for (const session of sessions) this.importedSession(session.provider, session.providerSessionId, session.id, session.agent)
      const cursor = String(sessions.at(-1)!.position)
      this.apply({ repositoryId: this.repositoryId, source: 'IMPORTED_SESSIONS', revision: cursor, cursor, status: 'PARTIAL', edges: [] }, imported?.revision, assertCurrent)
    }).immediate()
    const previous = this.source('LEGACY'), after = Number(previous?.cursor ?? 0)
    const rows = this.db.prepare('SELECT rowid AS position,payload,integrity FROM session_associations WHERE rowid>? ORDER BY rowid LIMIT 20').all(after) as { position: number; payload: string; integrity: string }[]
    if (!rows.length) return
    const edges: RegistryEdge[] = []
    for (const row of rows) {
      if (digest(row.payload) !== row.integrity) throw new Error('ASSOCIATION_INTEGRITY_FAILED')
      const a = JSON.parse(row.payload)
      const from: RegistryEntity = this.sessionIdentity(a.sessionId) ?? { kind: 'SESSION', id: `${a.provider}:${a.providerSessionId}` }
      const target: [EntityKind, unknown][] = [['ARTIFACT', a.sourceArtifactId], ['ARTIFACT', a.artifactId], ['COMMIT', a.commitSha], ['PR', a.pullRequest], ['CHECKPOINT', a.checkpointId], ['EXECUTION', a.executionId]]
      for (const [kind, id] of target) if (id) edges.push({ from, relation: 'legacy-association', to: { kind, id: String(id) }, evidenceKind: a.evidence, evidenceRef: a.sourceArtifactId ?? a.checkpointId ?? 'legacy-origin', digest: row.integrity, freshness: 'HISTORICAL' })
    }
    const cursor = String(rows.at(-1)!.position)
    this.apply({ repositoryId: this.repositoryId, source: 'LEGACY', revision: cursor, cursor, status: 'PARTIAL', edges }, previous?.revision, assertCurrent)
  }
}
