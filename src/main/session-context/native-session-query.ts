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
  after?: string
  before?: string
}

export function nativeSessionProjection(store: SessionStore, request: NativeSessionQuery, mode: 'MAP' | 'EVENTS', accountHash?: string) {
  return store.registry.readSnapshot(() => {
    const { nativeSession, expectedRevision, cursor, limit, hookEvents, after, before } = request
    const { events, bounded } = store.registry.nativeSessionObservations(nativeSession, accountHash)
    if (nativeSession.worktreeId && !events.length) throw new Error('ORIGIN_UNVERIFIED')
    const roots = [...new Map(events.map(event => [event.worktreeId + ':' + event.generation,
      { worktreeId: event.worktreeId, generation: event.generation }])).values()]
    const revision = parseInt(digest(JSON.stringify([nativeSession, bounded, events.map(event => [event.eventId, event.digest])])).slice(0, 13), 16) || 1
    if (expectedRevision !== undefined && expectedRevision !== revision) throw new Error('REVISION_CONFLICT')
    const scope = { mode, repo: store.repositoryId, nativeSession, revision, accountHash, limit, hookEvents, after, before }
    const offset = store.offset(cursor, scope)
    const base = {
      repositoryId: store.repositoryId, nativeSession, revision, source: 'NATIVE_HOOK', transcriptImported: false,
      identityEvidence: 'NATIVE_HASH_OBSERVED', contentAvailability: 'SOURCE_UNAVAILABLE',
      causalEvidence: 'NOT_INFERRED', coverage: 'PARTIAL', sourceCoverage: bounded ? 'OBSERVATION_LIMIT_REACHED' : 'OBSERVED_EVENTS_ONLY',
      origin: roots.length === 1 && !bounded ? 'OBSERVED_WORKTREE' : 'ORIGIN_UNVERIFIED',
      untrusted: true, claimsVerified: false
    }
    if (mode === 'MAP') {
      if (cursor) throw new Error('INVALID_ARGUMENT')
      return { ...base, worktrees: roots.slice(0, 12), omittedWorktrees: Math.max(0, roots.length - 12), observedEventCount: events.length,
        hookEvents: Object.entries(events.reduce<Partial<Record<NativeHookEvent, number>>>((counts, event) => {
          counts[event.event] = (counts[event.event] ?? 0) + 1
          return counts
        }, {})).map(([type, count]) => ({ type, count })),
        events: { tool: 'list_agent_session_events', arguments: { nativeSession, expectedRevision: revision } },
        context: { tool: 'discover_execution_context', arguments: { selector: { type: 'SESSION', provider: nativeSession.provider, id: nativeSession.id } } } }
    }
    if (!nativeSession.worktreeId && (roots.length > 1 || bounded)) throw new Error('ORIGIN_UNVERIFIED')
    const selected = events.filter(event => (!hookEvents || hookEvents.includes(event.event)) &&
      (!after || Date.parse(event.observedAt) >= Date.parse(after)) && (!before || Date.parse(event.observedAt) <= Date.parse(before)))
    if (offset > selected.length) throw new Error('CURSOR_STALE')
    return { ...base, events: selected.slice(offset, offset + limit).map(event => ({
      eventId: event.eventId, type: event.event, observedAt: event.observedAt, tool: event.tool, invocationId: event.invocationId,
      worktreeId: event.worktreeId, generation: event.generation, provenance: 'NATIVE_HOOK_OBSERVED', omission: 'SOURCE_UNAVAILABLE'
    })), ...(selected.length > offset + limit ? { nextCursor: store.cursor(scope, offset + limit) } : {}) }
  })
}
