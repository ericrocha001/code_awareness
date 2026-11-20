import type { SessionStore } from './store'
import type { NativeCrossSessionHit } from './native-session-references'
import type { NativeHookEnvelope } from './native-hooks'
import { digest } from './privacy'
import { nativeDigest } from './native-hooks'

export interface EvidenceSearchQuery {
  repositoryId?: string
  worktreeId?: string
  generation?: string
  sessionId?: string
  nativeSession?: {
    provider: 'codex-native' | 'antigravity-native'
    id: string
    worktreeId?: string
    generation?: string
  }
  sourceSessionId?: string
  artifactId?: string
  executionId?: string
  commitSha?: string
  pullRequest?: number
  agent?: string
  source?: 'ALL' | 'NATIVE_HOOK' | 'NATIVE_SOURCE' | 'IMPORTED'
  types?: string[]
  tool?: string
  status?: string
  isError?: boolean
  errorKind?: string
  turnId?: string
  invocationId?: string
  file?: string
  operation?: string
  after?: string
  before?: string
  query?: string
  mode?: 'ALL_TERMS' | 'PHRASE'
  limit: number
  cursor?: string
}

export interface EvidenceHit {
  sessionId: string
  source: 'NATIVE_SOURCE' | 'NATIVE_HOOK' | 'IMPORTED'
  origin: {
    provider: string
    worktreeId?: string
    generation?: string
    sourceSessionId?: string
  }
  eventId: string
  type: string
  timestamp?: string
  tool?: string
  turnId?: string
  invocationId?: string
  status?: string
  errorKind?: string
  deepen: {
    tool: 'read_agent_session_event' | 'list_agent_session_events' | 'inspect_agent_session'
    arguments: Record<string, unknown>
  }
}

export interface EvidenceSearchEnvelope {
  repositoryId: string
  scope: Record<string, unknown>
  coverage: {
    nativeHook: { state: string }
    nativeSource: { state: string }
    entire: { state: string }
    fileCoverage?: { state: string; reason?: string }
  }
  hits: EvidenceHit[]
  nextCursor?: string
}

export function executeSearchEvidence(
  store: SessionStore,
  query: EvidenceSearchQuery,
  accountHash?: string,
  _budget?: number
): EvidenceSearchEnvelope {
  if (query.repositoryId && query.repositoryId !== store.repositoryId) {
    throw new Error('INVALID_ARGUMENT')
  }

  const scopeKey = {
    repo: store.repositoryId,
    worktreeId: query.worktreeId,
    generation: query.generation,
    sessionId: query.sessionId,
    artifactId: query.artifactId,
    executionId: query.executionId,
    commitSha: query.commitSha,
    pullRequest: query.pullRequest,
    agent: query.agent,
    source: query.source,
    types: query.types,
    tool: query.tool,
    status: query.status,
    isError: query.isError,
    errorKind: query.errorKind,
    turnId: query.turnId,
    invocationId: query.invocationId,
    file: query.file,
    operation: query.operation,
    after: query.after,
    before: query.before,
    query: query.query,
    mode: query.mode,
    limit: query.limit
  }
  const offset = store.offset(query.cursor, scopeKey)

  const scope: Record<string, unknown> = {
    ...(query.worktreeId ? { worktreeId: query.worktreeId, generation: query.generation } : {}),
    ...(query.artifactId ? { artifactId: query.artifactId } : {}),
    ...(query.executionId ? { executionId: query.executionId } : {}),
    ...(query.commitSha ? { commitSha: query.commitSha } : {}),
    ...(query.pullRequest ? { pullRequest: query.pullRequest } : {}),
    ...(query.agent ? { agent: query.agent } : {}),
    ...(query.source && query.source !== 'ALL' ? { source: query.source } : {}),
    ...(query.types ? { types: query.types } : {}),
    ...(query.tool ? { tool: query.tool } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.isError ? { isError: query.isError } : {}),
    ...(query.errorKind ? { errorKind: query.errorKind } : {}),
    ...(query.turnId ? { turnId: query.turnId } : {}),
    ...(query.invocationId ? { invocationId: query.invocationId } : {}),
    ...(query.query ? { query: query.query, mode: query.mode ?? 'ALL_TERMS' } : {})
  }

  const coverage: EvidenceSearchEnvelope['coverage'] = {
    nativeHook: { state: store.registry.source('NATIVE_HOOK')?.status ?? 'UNOBSERVED' },
    nativeSource: { state: 'READY' },
    entire: { state: query.query ? 'NOT_INDEXED_FOR_SOURCE' : 'READY' }
  }

  if (query.file) {
    coverage.fileCoverage = { state: 'NOT_OBSERVED', reason: 'FILE_FILTER_NOT_INDEXED_FOR_SOURCE' }
    return {
      repositoryId: store.repositoryId,
      scope,
      coverage,
      hits: []
    }
  }

  // Target session resolution for relations
  let scopedSessionIds: string[] | undefined
  if (query.artifactId || query.executionId || query.commitSha || query.pullRequest) {
    const filter = {
      artifactId: query.artifactId,
      executionId: query.executionId,
      commitSha: query.commitSha,
      pullRequest: query.pullRequest,
      worktreeId: query.worktreeId,
      generation: query.generation,
      agent: query.agent
    }
    const nativeSessions = store.registry.queryNativeSessions(filter, accountHash)
    scopedSessionIds = nativeSessions.rows.map(r => r.providerSessionId)
    if (!scopedSessionIds.length) {
      return {
        repositoryId: store.repositoryId,
        scope,
        coverage,
        hits: []
      }
    }
  }

  const hits: EvidenceHit[] = []
  let hasMore = false

  // 1. Native literal source search
  const allowNativeSource = query.source !== 'NATIVE_HOOK' && query.source !== 'IMPORTED'
  if (allowNativeSource) {
    let ftsRowids: number[] | undefined
    if (query.query) {
      ftsRowids = store.references.native.searchFtsRowids(query.query, query.mode ?? 'ALL_TERMS')
    }

    const nativeFilter = {
      repositoryId: store.repositoryId,
      worktreeId: query.worktreeId,
      generation: query.generation,
      provider: query.agent === 'codex' ? ('codex' as const) : query.agent === 'antigravity' ? ('antigravity' as const) : undefined,
      types: query.types,
      tool: query.tool,
      status: query.status,
      isError: query.isError,
      errorKind: query.errorKind,
      turnId: query.turnId,
      after: query.after,
      before: query.before,
      offset,
      limit: query.limit,
      rowids: ftsRowids
    }

    if (!query.query || (ftsRowids && ftsRowids.length > 0)) {
      const nativeResult = store.references.native.searchCrossSessionEvents(nativeFilter)
      hasMore = nativeResult.more
      for (const hit of nativeResult.hits) {
        if (scopedSessionIds && !scopedSessionIds.includes(hit.sourceSessionId)) continue
        const liveFingerprint = digest(hit.fileIdentity)
        const expectedRevision = parseInt(digest(JSON.stringify([0, hit.normalizer, hit.revision, liveFingerprint])).slice(0, 13), 16) || 1
        hits.push({
          sessionId: hit.sourceSessionId,
          source: 'NATIVE_SOURCE',
          origin: {
            provider: hit.provider,
            worktreeId: hit.worktreeId,
            generation: hit.generation,
            sourceSessionId: hit.sourceSessionId
          },
          eventId: hit.eventId,
          type: hit.type,
          ...(hit.timestamp ? { timestamp: hit.timestamp } : {}),
          ...(hit.tool ? { tool: hit.tool } : {}),
          ...(hit.turnId ? { turnId: hit.turnId } : {}),
          ...(hit.status ? { status: hit.status } : {}),
          ...(hit.errorKind ? { errorKind: hit.errorKind } : {}),
          deepen: {
            tool: 'read_agent_session_event',
            arguments: {
              repositoryId: store.repositoryId,
              nativeSession: {
                provider: hit.provider === 'codex' ? 'codex-native' : 'antigravity-native',
                id: nativeDigest(JSON.stringify([store.repositoryId, hit.provider, hit.sourceSessionId])),
                worktreeId: hit.worktreeId,
                generation: hit.generation
              },
              sourceSessionId: hit.sourceSessionId,
              expectedRevision,
              eventId: hit.eventId,
              ...(query.query ? { query: query.query } : {})
            }
          }
        })
      }
    }
  }

  // 2. Native hook observations search (only when no query is requested)
  const allowNativeHook = !query.query && query.source !== 'NATIVE_SOURCE' && query.source !== 'IMPORTED'
  if (allowNativeHook && hits.length < query.limit) {
    const hookFilter = {
      repositoryId: store.repositoryId,
      worktreeId: query.worktreeId,
      generation: query.generation,
      sessionIds: scopedSessionIds,
      tool: query.tool,
      invocationId: query.invocationId,
      turnId: query.turnId,
      isError: query.isError,
      after: query.after,
      before: query.before,
      offset,
      limit: query.limit - hits.length
    }
    const hookResult = store.registry.searchHookObservations(hookFilter, accountHash)
    if (hookResult.more) hasMore = true
    for (const ev of hookResult.events) {
      const provider = ev.source === 'CODEX_NATIVE_HOOK' ? 'codex' : 'antigravity'
      hits.push({
        sessionId: ev.sessionId,
        source: 'NATIVE_HOOK',
        origin: {
          provider,
          worktreeId: ev.worktreeId,
          generation: ev.generation
        },
        eventId: ev.eventId,
        type: ev.event,
        timestamp: ev.observedAt,
        ...(ev.tool ? { tool: ev.tool } : {}),
        ...(ev.turnId ? { turnId: ev.turnId } : {}),
        ...(ev.invocationId ? { invocationId: ev.invocationId } : {}),
        ...(query.isError ? { status: 'FAILURE', errorKind: 'HOOK_ERROR' } : {}),
        deepen: {
          tool: 'list_agent_session_events',
          arguments: {
            repositoryId: store.repositoryId,
            nativeSession: {
              provider: provider === 'codex' ? 'codex-native' : 'antigravity-native',
              id: ev.sessionId,
              worktreeId: ev.worktreeId,
              generation: ev.generation
            },
            eventId: ev.eventId
          }
        }
      })
    }
  }

  const pagedHits = hits.slice(0, query.limit)
  const nextCursor = hasMore ? store.cursor(scopeKey, offset + query.limit) : undefined

  return {
    repositoryId: store.repositoryId,
    scope,
    coverage,
    hits: pagedHits,
    ...(nextCursor ? { nextCursor } : {})
  }
}
