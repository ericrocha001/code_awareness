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
  invocationId?: string
  tool?: string
  status?: string
  isError?: boolean
  errorKind?: string
  query?: string
  mapView?: 'SEGMENTS' | 'TURNS' | 'ORIGINS' | 'INVOCATIONS' | 'ERRORS' | 'TOOLS' | 'FILES' | 'TIMELINE'
  facet?: 'TURNS' | 'INVOCATIONS' | 'ERRORS' | 'TOOLS' | 'FILES' | 'TIMELINE'
  after?: string
  before?: string
}

export function nativeSessionProjection(store: SessionStore, request: NativeSessionQuery, mode: 'MAP' | 'EVENTS', accountHash?: string) {
  return store.registry.readSnapshot(() => {
    const { nativeSession, expectedRevision, cursor, limit, hookEvents, after, before, file, turnId, invocationId, tool, status, isError, errorKind, query, mapView, facet } = request
    const selectedView = facet || mapView
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
    const scope = { v: 2, mode, repo: store.repositoryId, nativeSession: scopedSelector, revision, accountHash, limit, hookEvents, after, before, file, turnId, invocationId, tool, status, isError, errorKind, mapView: selectedView }
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
      if (selectedView === 'ORIGINS') {
        if (offset > observation.originCount) throw new Error('CURSOR_STALE')
        const page = registry.nativeObservationOrigins(nativeSession, offset, limit, accountHash)
        return { ...base, originCount: observation.originCount,
          origins: page.origins.map(o => ({ ...o, deepen: { tool: 'inspect_agent_session', arguments: { repositoryId: store.repositoryId, nativeSession: { provider: nativeSession.provider, id: nativeSession.id, ...o } } } })),
          ...(page.more ? { nextCursor: store.cursor(scope, offset + limit) } : {}) }
      }
      if (selectedView === 'TURNS') {
        if (!singleOrigin) return { ...base, turnCoverage: 'UNKNOWN', turns: [] }
        const page = registry.nativeObservationTurns(nativeSession, offset, limit, accountHash)
        if (offset > observation.turnCount) throw new Error('CURSOR_STALE')
        return { ...base, turnCoverage: observation.turnCount ? 'PARTIAL' : 'UNKNOWN',
          turns: page.turns.map(turn => ({ ...turn, boundaryEvidence: unitEvidence, coverage: 'PARTIAL' })),
          ...(page.more ? { nextCursor: store.cursor(scope, offset + limit) } : {}) }
      }
      if (selectedView === 'INVOCATIONS') {
        if (!singleOrigin) return { ...base, invocationCoverage: 'UNKNOWN', invocations: [] }
        const page = registry.nativeObservationInvocations(nativeSession, offset, limit, accountHash)
        return { ...base, invocationCoverage: page.invocations.length ? 'PARTIAL' : 'NOT_OBSERVED_FOR_PROVIDER',
          invocations: page.invocations.map(inv => ({
            ...inv,
            boundaryEvidence: 'PROVIDER_INVOCATION_ID_OBSERVED',
            deepen: { tool: 'list_agent_session_events', arguments: { repositoryId: store.repositoryId, nativeSession: scopedSelector, expectedRevision: revision, invocationId: inv.id } }
          })),
          ...(page.more ? { nextCursor: store.cursor(scope, offset + limit) } : {}) }
      }
      if (selectedView === 'TOOLS') {
        if (!singleOrigin) return { ...base, toolCoverage: 'UNKNOWN', tools: [] }
        const page = registry.nativeObservationTools(nativeSession, offset, limit, accountHash)
        return { ...base, toolCoverage: page.tools.length ? 'PARTIAL' : 'NOT_OBSERVED',
          tools: page.tools.map(t => ({
            ...t,
            deepen: { tool: 'list_agent_session_events', arguments: { repositoryId: store.repositoryId, nativeSession: scopedSelector, expectedRevision: revision, tool: t.tool } }
          })),
          ...(page.more ? { nextCursor: store.cursor(scope, offset + limit) } : {}) }
      }
      if (selectedView === 'ERRORS') {
        if (!singleOrigin) return { ...base, errorCoverage: 'UNKNOWN', errors: [] }
        const page = registry.nativeObservationPage(nativeSession, { isError: true, after, before }, offset, limit, accountHash)
        return { ...base, errorCoverage: page.events.length ? 'PARTIAL' : 'NO_ERRORS_OBSERVED',
          errors: page.events.map(ev => ({
            eventId: ev.eventId, type: ev.event, observedAt: ev.observedAt, tool: ev.tool, invocationId: ev.invocationId,
            deepen: { tool: 'list_agent_session_events', arguments: { repositoryId: store.repositoryId, nativeSession: scopedSelector, expectedRevision: revision, eventId: ev.eventId } }
          })),
          ...(page.more ? { nextCursor: store.cursor(scope, offset + limit) } : {}) }
      }
      if (selectedView === 'FILES') {
        return { ...base, fileCoverage: { state: 'NOT_OBSERVED' }, files: [] }
      }
      if (selectedView === 'TIMELINE') {
        return { ...base, timeline: { firstObservedAt: observation.firstObservedAt, lastObservedAt: observation.lastObservedAt, observedEventCount: observation.total } }
      }
      if (cursor) throw new Error('INVALID_ARGUMENT')
      const mapTurns = singleOrigin ? registry.nativeObservationTurns(nativeSession, 0, 5, accountHash).turns : []
      return { ...base, worktrees: observation.origins, omittedWorktrees: Math.max(0, observation.originCount - observation.origins.length), observedEventCount: observation.total,
        turnCoverage: singleOrigin && observation.turnCount ? 'PARTIAL' : 'UNKNOWN', omittedTurns: singleOrigin ? Math.max(0, observation.turnCount - 5) : 0,
        turns: mapTurns.map(turn => ({ ...turn, boundaryEvidence: unitEvidence, coverage: 'PARTIAL' })),
        fileCoverage: { state: 'NOT_OBSERVED' },
        ...(singleOrigin ? {
          turnView: { tool: 'inspect_agent_session', arguments: { repositoryId: store.repositoryId, nativeSession: scopedSelector, expectedRevision: revision, mapView: 'TURNS' } },
          errorView: { tool: 'inspect_agent_session', arguments: { repositoryId: store.repositoryId, nativeSession: scopedSelector, expectedRevision: revision, mapView: 'ERRORS' } },
          toolView: { tool: 'inspect_agent_session', arguments: { repositoryId: store.repositoryId, nativeSession: scopedSelector, expectedRevision: revision, mapView: 'TOOLS' } },
          events: { tool: 'list_agent_session_events', arguments: { repositoryId: store.repositoryId, nativeSession: scopedSelector, expectedRevision: revision } }
        } : {
          originSelection: { tool: 'inspect_agent_session', arguments: { repositoryId: store.repositoryId, nativeSession, expectedRevision: revision, mapView: 'ORIGINS' } }
        }),
        hookEvents: observation.hookEvents,
        context: { tool: 'discover_execution_context', arguments: { repositoryId: store.repositoryId, selector: { type: 'SESSION', provider: nativeSession.provider, id: nativeSession.id } } } }
    }
    if (!nativeSession.worktreeId && !singleOrigin) throw new Error('ORIGIN_UNVERIFIED')
    const page = file ? { events: [], more: false, filteredTotal: 0 } : registry.nativeObservationPage(nativeSession, { hookEvents, turnId, invocationId, tool, status, isError, after, before }, offset, limit, accountHash)
    if (page.filteredTotal !== undefined && offset > page.filteredTotal) throw new Error('CURSOR_STALE')
    return { ...base, ...(file ? { fileCoverage: { state: 'NOT_OBSERVED' } } : {}), events: page.events.map(event => ({
      eventId: event.eventId, type: event.event, ...(event.turnId && singleOrigin ? { turnId: event.turnId } : {}), observedAt: event.observedAt, tool: event.tool, invocationId: event.invocationId,
      worktreeId: event.worktreeId, generation: event.generation, provenance: 'NATIVE_HOOK_OBSERVED', omission: 'SOURCE_UNAVAILABLE'
    })), ...(page.more ? { nextCursor: store.cursor(scope, offset + limit) } : {}) }
  })
}
