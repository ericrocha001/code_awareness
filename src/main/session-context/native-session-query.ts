import { z } from 'zod'
import { digest } from './privacy'
import type { SessionStore } from './store'
import type { NativeHookEvent } from './native-hooks'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const nativeSessionSelector = z.object({
  provider: z.enum(['codex-native', 'antigravity-native']),
  id: hash,
  worktreeId: hash.optional(),
  generation: hash.optional()
}).strict().refine(value => !!value.worktreeId === !!value.generation)

export type NativeSessionSelector = z.infer<typeof nativeSessionSelector>

export interface NativeSessionQuery {
  nativeSession: NativeSessionSelector
  expectedRevision?: number
  cursor?: string
  limit: number
  hookEvents?: NativeHookEvent[]
  file?: string
  turnId?: string
  query?: string
  mapView?: 'SEGMENTS' | 'TURNS' | 'ORIGINS'
  after?: string
  before?: string
}

export function nativeSessionProjection(store: SessionStore, request: NativeSessionQuery, mode: 'MAP' | 'EVENTS', accountHash?: string) {
  return store.registry.readSnapshot(() => {
    const { nativeSession, expectedRevision, cursor, limit, hookEvents, after, before, file, turnId, query, mapView } = request
    const registry = store.registry
    const observation = registry.nativeObservationScope(nativeSession, accountHash)
    if (nativeSession.worktreeId && !observation.total) throw new Error('ORIGIN_UNVERIFIED')
    const singleOrigin = observation.originCount === 1
    const scopedSelector: NativeSessionSelector = nativeSession.worktreeId || !singleOrigin
      ? nativeSession
      : { ...nativeSession, ...observation.origins[0] }
    const revision = parseInt(digest(JSON.stringify([scopedSelector, observation.revision])).slice(0, 13), 16) || 1
    if (expectedRevision !== undefined && expectedRevision !== revision) throw new Error('REVISION_CONFLICT')
    if (query) throw new Error('SOURCE_UNAVAILABLE')
    const scope = { v: 2, mode, repo: store.repositoryId, nativeSession: scopedSelector, revision, accountHash, limit, hookEvents, after, before, file, turnId, mapView }
    const offset = store.offset(cursor, scope)
    const unitEvidence = nativeSession.provider === 'codex-native' ? 'PROVIDER_TURN_ID_OBSERVED' : 'PROVIDER_INVOCATION_ID_OBSERVED'
    const base = {
      repositoryId: store.repositoryId, nativeSession: scopedSelector, revision, source: 'NATIVE_HOOK', transcriptImported: false,
      identityEvidence: 'NATIVE_HASH_OBSERVED', contentAvailability: 'SOURCE_UNAVAILABLE',
      causalEvidence: 'NOT_INFERRED', coverage: 'PARTIAL', sourceCoverage: 'OBSERVED_EVENTS_ONLY',
      origin: singleOrigin ? 'OBSERVED_WORKTREE' : 'ORIGIN_UNVERIFIED',
      untrusted: true, claimsVerified: false
    }
    if (mode === 'MAP') {
      if (mapView === 'ORIGINS') {
        if (offset > observation.originCount) throw new Error('CURSOR_STALE')
        const page = registry.nativeObservationOrigins(nativeSession, offset, limit, accountHash)
        return { ...base, originCount: observation.originCount,
          origins: page.origins.map(o => ({ ...o, deepen: { tool: 'inspect_agent_session', arguments: { repositoryId: store.repositoryId, nativeSession: { provider: nativeSession.provider, id: nativeSession.id, ...o } } } })),
          ...(page.more ? { nextCursor: store.cursor(scope, offset + limit) } : {}) }
      }
      if (mapView === 'TURNS') {
        if (!singleOrigin) return { ...base, turnCoverage: 'UNKNOWN', turns: [] }
        const page = registry.nativeObservationTurns(nativeSession, offset, limit, accountHash)
        if (offset > observation.turnCount) throw new Error('CURSOR_STALE')
        return { ...base, turnCoverage: observation.turnCount ? 'PARTIAL' : 'UNKNOWN',
          turns: page.turns.map(turn => ({ ...turn, boundaryEvidence: unitEvidence, coverage: 'PARTIAL' })),
          ...(page.more ? { nextCursor: store.cursor(scope, offset + limit) } : {}) }
      }
      if (cursor) throw new Error('INVALID_ARGUMENT')
      const mapTurns = singleOrigin ? registry.nativeObservationTurns(nativeSession, 0, 5, accountHash).turns : []
      return { ...base, worktrees: observation.origins, omittedWorktrees: Math.max(0, observation.originCount - observation.origins.length), observedEventCount: observation.total,
        turnCoverage: singleOrigin && observation.turnCount ? 'PARTIAL' : 'UNKNOWN', omittedTurns: singleOrigin ? Math.max(0, observation.turnCount - 5) : 0,
        turns: mapTurns.map(turn => ({ ...turn, boundaryEvidence: unitEvidence, coverage: 'PARTIAL' })),
        fileCoverage: { state: 'NOT_OBSERVED' },
        ...(singleOrigin ? {
          turnView: { tool: 'inspect_agent_session', arguments: { repositoryId: store.repositoryId, nativeSession: scopedSelector, expectedRevision: revision, mapView: 'TURNS' } },
          events: { tool: 'list_agent_session_events', arguments: { repositoryId: store.repositoryId, nativeSession: scopedSelector, expectedRevision: revision } }
        } : {
          originSelection: { tool: 'inspect_agent_session', arguments: { repositoryId: store.repositoryId, nativeSession, expectedRevision: revision, mapView: 'ORIGINS' } }
        }),
        hookEvents: observation.hookEvents,
        context: { tool: 'discover_execution_context', arguments: { repositoryId: store.repositoryId, selector: { type: 'SESSION', provider: nativeSession.provider, id: nativeSession.id } } } }
    }
    if (!nativeSession.worktreeId && !singleOrigin) throw new Error('ORIGIN_UNVERIFIED')
    const page = file ? { events: [], more: false, filteredTotal: 0 } : registry.nativeObservationPage(nativeSession, { hookEvents, turnId, after, before }, offset, limit, accountHash)
    if (page.filteredTotal !== undefined && offset > page.filteredTotal) throw new Error('CURSOR_STALE')
    return { ...base, ...(file ? { fileCoverage: { state: 'NOT_OBSERVED' } } : {}), events: page.events.map(event => ({
      eventId: event.eventId, type: event.event, ...(event.turnId && singleOrigin ? { turnId: event.turnId } : {}), observedAt: event.observedAt, tool: event.tool, invocationId: event.invocationId,
      worktreeId: event.worktreeId, generation: event.generation, provenance: 'NATIVE_HOOK_OBSERVED', omission: 'SOURCE_UNAVAILABLE'
    })), ...(page.more ? { nextCursor: store.cursor(scope, offset + limit) } : {}) }
  })
}
