import { closeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertProfilePath } from '../local-mcp-clients/safe-config-file'
import { openAntigravitySourceHandle, readAntigravityAppGrantStatus } from './native-antigravity-app-source'
import { openCodexSourceHandle, readCodexGrantStatus } from './native-codex-source'
import { boundedFile, nativeDigest } from './native-hooks'
import { literalSnapshotRevision, verifyNativeLiteralContext } from './native-session-query'
import {
  NATIVE_ANTIGRAVITY_NORMALIZER,
  NATIVE_CODEX_NORMALIZER,
  nativeReferenceKey,
  type NativeCrossSessionHit
} from './native-session-references'
import { digest } from './privacy'
import { registrySelector } from './registry-reconciliation'
import type { SessionStore } from './store'
import type { LiveSessionTarget } from './target'

const NATIVE_SOURCE_TYPES = new Set(['INPUT', 'AGENT_UPDATE', 'TOOL_CALL', 'TOOL_RESULT', 'ERROR'])
const MAX_REVALIDATION_BATCHES = 4

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
  hookEvents?: string[]
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

export interface EvidenceSourceCoverage {
  state: string
  reason?: string
}

export interface EvidenceSearchEnvelope {
  repositoryId: string
  searchRevision: string
  scope: Record<string, unknown>
  coverage: {
    nativeHook: EvidenceSourceCoverage
    nativeSource: EvidenceSourceCoverage
    entire: EvidenceSourceCoverage
    fileCoverage?: EvidenceSourceCoverage
    operationCoverage?: EvidenceSourceCoverage
  }
  hits: EvidenceHit[]
  nextCursor?: string
}

export interface EvidenceSearchOptions {
  accountHash?: string
  budget?: number
  selectedTarget?: { worktreeId: string; generation: string }
  liveTargets?: LiveSessionTarget[]
  root?: string
  assertCurrent?: () => void
}

interface SortKey {
  hasTs: boolean
  tsMs: number
  source: string
  sessionId: string
  eventId: string
}

interface StreamCandidate {
  sortKey: SortKey
  startOffset: number
  hit: EvidenceHit
}

function compareSortKey(a: SortKey, b: SortKey): number {
  if (a.hasTs !== b.hasTs) return a.hasTs ? -1 : 1
  if (a.hasTs && a.tsMs !== b.tsMs) return a.tsMs - b.tsMs
  if (a.source !== b.source) return a.source < b.source ? -1 : 1
  if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1
  if (a.eventId !== b.eventId) return a.eventId < b.eventId ? -1 : 1
  return 0
}

function makeSortKey(source: EvidenceHit['source'], sessionId: string, eventId: string, timestamp?: string, timestampMs?: number): SortKey {
  const ms = timestampMs !== undefined ? timestampMs : timestamp ? Date.parse(timestamp) : NaN
  const hasTs = Number.isFinite(ms)
  return { hasTs, tsMs: hasTs ? ms : 0, source, sessionId, eventId }
}

function fitsEnvelope(data: object, budget: number): boolean {
  return Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(data) }] })) + 512 <= budget
}

function readProviderConfigDigest(storePath: string): string {
  const dir = dirname(storePath)
  const configPath = join(dir, 'session-context.provider.json')
  try {
    assertProfilePath(configPath, dir)
    return digest(boundedFile(configPath, 65536))
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 'ABSENT'
    return 'INVALID'
  }
}

function resolveWorktreeRoot(
  worktreeId: string,
  generation: string,
  liveTargets: LiveSessionTarget[],
  selectedTarget?: { worktreeId: string; generation: string },
  root?: string
): string | undefined {
  const live = liveTargets.find(t => t.worktreeId === worktreeId && t.generation === generation)
  if (live) return live.root
  if (root && selectedTarget?.worktreeId === worktreeId && selectedTarget?.generation === generation) return root
  return undefined
}

export function executeSearchEvidence(
  store: SessionStore,
  query: EvidenceSearchQuery,
  optionsOrAccountHash?: EvidenceSearchOptions | string,
  legacyBudget?: number
): EvidenceSearchEnvelope {
  const opts: EvidenceSearchOptions = typeof optionsOrAccountHash === 'string'
    ? { accountHash: optionsOrAccountHash, budget: legacyBudget }
    : (optionsOrAccountHash ?? {})
  const accountHash = opts.accountHash
  const budget = opts.budget ?? 24576
  const liveTargets = opts.liveTargets ?? []
  const assertCurrent = opts.assertCurrent ?? (() => {})

  if (query.repositoryId && query.repositoryId !== store.repositoryId) {
    throw new Error('INVALID_ARGUMENT')
  }

  const effectiveWorktree = query.worktreeId && query.generation
    ? { worktreeId: query.worktreeId, generation: query.generation }
    : query.nativeSession?.worktreeId && query.nativeSession?.generation
      ? { worktreeId: query.nativeSession.worktreeId, generation: query.nativeSession.generation }
      : undefined

  // Reconcile current grants & purge revoked/disabled indexes on writable stores before searching.
  const codexGrant = readCodexGrantStatus(store.path, store.repositoryId)
  const agGrant = readAntigravityAppGrantStatus(store.path, store.repositoryId)

  if (!store.references.native.isReadOnly) {
    if (!codexGrant.configured || !codexGrant.ok) {
      store.references.native.purgeProvider(store.repositoryId, 'codex')
    } else if (!codexGrant.allowLexicalIndex && store.references.native.hasFtsEntriesForProvider(store.repositoryId, 'codex')) {
      store.references.native.purgeProviderFts(store.repositoryId, 'codex')
      for (const s of store.references.native.listReadySources(store.repositoryId, { providers: ['codex'] })) {
        store.references.native.invalidate(s.nativeKey)
      }
    }
    if (!agGrant.configured || !agGrant.ok) {
      store.references.native.purgeProvider(store.repositoryId, 'antigravity')
    } else {
      if (!agGrant.grant.allowLexicalIndex && store.references.native.hasFtsEntriesForProvider(store.repositoryId, 'antigravity')) {
        store.references.native.purgeProviderFts(store.repositoryId, 'antigravity')
        for (const s of store.references.native.listReadySources(store.repositoryId, { providers: ['antigravity'] })) {
          store.references.native.invalidate(s.nativeKey)
        }
      }
      if (agGrant.grant.sessionHash !== undefined || agGrant.grant.sessionHashes !== undefined) {
        const allowedSet = agGrant.grant.sessionHashes
          ? new Set(agGrant.grant.sessionHashes)
          : undefined
        for (const s of store.references.native.listReadySources(store.repositoryId, { providers: ['antigravity'] })) {
          const hash = nativeDigest(JSON.stringify([store.repositoryId, 'antigravity', s.sourceSessionId]))
          const allowed = (agGrant.grant.sessionHash === undefined || agGrant.grant.sessionHash === hash) &&
            (!allowedSet || allowedSet.has(hash))
          if (!allowed) store.references.native.invalidate(s.nativeKey)
        }
      }
    }
  }

  const configDigest = readProviderConfigDigest(store.path)
  const searchRevision = digest(JSON.stringify([
    store.catalogRevision(),
    store.registry.nativeSessionsRevision(effectiveWorktree ?? {}),
    store.references.native.indexRevision(store.repositoryId),
    configDigest
  ]))

  const scopeKey = {
    repo: store.repositoryId,
    accountHash: accountHash ?? null,
    searchRevision,
    worktreeId: effectiveWorktree?.worktreeId ?? null,
    generation: effectiveWorktree?.generation ?? null,
    sessionId: query.sessionId ?? null,
    nativeSession: query.nativeSession ?? null,
    sourceSessionId: query.sourceSessionId ?? null,
    artifactId: query.artifactId ?? null,
    executionId: query.executionId ?? null,
    commitSha: query.commitSha ?? null,
    pullRequest: query.pullRequest ?? null,
    agent: query.agent ?? null,
    source: query.source ?? 'ALL',
    types: query.types ?? null,
    hookEvents: query.hookEvents ?? null,
    tool: query.tool ?? null,
    status: query.status ?? null,
    isError: query.isError ?? null,
    errorKind: query.errorKind ?? null,
    turnId: query.turnId ?? null,
    invocationId: query.invocationId ?? null,
    file: query.file ?? null,
    operation: query.operation ?? null,
    after: query.after ?? null,
    before: query.before ?? null,
    query: query.query ?? null,
    mode: query.mode ?? 'ALL_TERMS',
    limit: query.limit
  }

  const cursorState = store.readCursorPayload<{ ns?: unknown; nh?: unknown; imp?: unknown }>(query.cursor, scopeKey)
  let nsOffset = 0
  let nhOffset = 0
  let impOffset = 0
  if (cursorState) {
    if (!Number.isSafeInteger(cursorState.ns) || (cursorState.ns as number) < 0 ||
        !Number.isSafeInteger(cursorState.nh) || (cursorState.nh as number) < 0 ||
        !Number.isSafeInteger(cursorState.imp) || (cursorState.imp as number) < 0) {
      throw new Error('CURSOR_STALE')
    }
    nsOffset = cursorState.ns as number
    nhOffset = cursorState.nh as number
    impOffset = cursorState.imp as number
  }

  const scope: Record<string, unknown> = {
    ...(effectiveWorktree ? { worktreeId: effectiveWorktree.worktreeId, generation: effectiveWorktree.generation } : {}),
    ...(query.sessionId ? { sessionId: query.sessionId } : {}),
    ...(query.nativeSession ? { nativeSession: query.nativeSession } : {}),
    ...(query.sourceSessionId ? { sourceSessionId: query.sourceSessionId } : {}),
    ...(query.artifactId ? { artifactId: query.artifactId } : {}),
    ...(query.executionId ? { executionId: query.executionId } : {}),
    ...(query.commitSha ? { commitSha: query.commitSha } : {}),
    ...(query.pullRequest ? { pullRequest: query.pullRequest } : {}),
    ...(query.agent ? { agent: query.agent } : {}),
    ...(query.source && query.source !== 'ALL' ? { source: query.source } : {}),
    ...(query.types ? { types: query.types } : {}),
    ...(query.hookEvents ? { hookEvents: query.hookEvents } : {}),
    ...(query.tool ? { tool: query.tool } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.isError !== undefined ? { isError: query.isError } : {}),
    ...(query.errorKind ? { errorKind: query.errorKind } : {}),
    ...(query.turnId ? { turnId: query.turnId } : {}),
    ...(query.invocationId ? { invocationId: query.invocationId } : {}),
    ...(query.file ? { file: query.file } : {}),
    ...(query.operation ? { operation: query.operation } : {}),
    ...(query.after ? { after: query.after } : {}),
    ...(query.before ? { before: query.before } : {}),
    ...(query.query ? { query: query.query, mode: query.mode ?? 'ALL_TERMS' } : {})
  }

  const nativeSourceUnsupportedReason =
    (query.source === 'NATIVE_HOOK' || query.source === 'IMPORTED') ? 'EXCLUDED_BY_SOURCE_SCOPE' :
    query.sessionId ? 'IMPORTED_SESSION_SCOPE_ONLY' :
    query.hookEvents?.length ? 'HOOK_EVENTS_NOT_INDEXED' :
    query.invocationId ? 'INVOCATION_ID_NOT_INDEXED' :
    query.file ? 'FILE_FILTER_NOT_INDEXED_FOR_SOURCE' :
    query.operation ? 'OPERATION_NOT_INDEXED_FOR_SOURCE' :
    (query.types?.length && !query.types.some(t => NATIVE_SOURCE_TYPES.has(t))) ? 'UNSUPPORTED_EVENT_TYPE_FILTER' :
    undefined

  const nativeHookUnsupportedReason =
    (query.source === 'NATIVE_SOURCE' || query.source === 'IMPORTED') ? 'EXCLUDED_BY_SOURCE_SCOPE' :
    (query.sessionId || query.sourceSessionId) ? 'EXCLUDED_BY_SESSION_SCOPE' :
    query.query ? 'LEXICAL_QUERY_NOT_SUPPORTED_FOR_NATIVE_HOOK' :
    query.types?.length ? 'NORMALIZED_TYPE_NOT_OBSERVED_IN_HOOKS' :
    (query.status || query.isError !== undefined || query.errorKind) ? 'ERROR_STATUS_NOT_OBSERVED_IN_HOOKS' :
    query.file ? 'FILE_FILTER_NOT_INDEXED_FOR_SOURCE' :
    query.operation ? 'OPERATION_NOT_INDEXED_FOR_SOURCE' :
    undefined

  const importedUnsupportedReason =
    (query.source === 'NATIVE_HOOK' || query.source === 'NATIVE_SOURCE') ? 'EXCLUDED_BY_SOURCE_SCOPE' :
    (query.nativeSession || query.sourceSessionId) ? 'EXCLUDED_BY_SESSION_SCOPE' :
    query.query ? 'LEXICAL_QUERY_NOT_SUPPORTED_FOR_IMPORTED' :
    query.hookEvents?.length ? 'HOOK_EVENTS_NOT_INDEXED' :
    (query.status || query.errorKind) ? 'STATUS_OR_ERROR_KIND_NOT_INDEXED_FOR_IMPORTED' :
    query.turnId ? 'TURN_ID_NOT_INDEXED_FOR_IMPORTED' :
    query.invocationId ? 'INVOCATION_ID_NOT_INDEXED' :
    query.operation ? 'OPERATION_NOT_INDEXED_FOR_SOURCE' :
    undefined

  // Determine authorized providers for NATIVE_SOURCE
  const requestedProvider = query.nativeSession
    ? (query.nativeSession.provider === 'codex-native' ? 'codex' : 'antigravity')
    : query.agent === 'codex'
      ? 'codex'
      : query.agent === 'antigravity'
        ? 'antigravity'
        : undefined
  const allowedProviders: Array<'codex' | 'antigravity'> = []
  let lexicalOptInMissing = false
  let lexicalMixedOptIn = false
  if (!query.agent || query.agent === 'codex' || query.agent === 'antigravity') {
    const codexOk = codexGrant.configured && codexGrant.ok
    const agOk = agGrant.configured && agGrant.ok
    if (!requestedProvider || requestedProvider === 'codex') {
      if (codexOk) {
        if (!query.query || codexGrant.allowLexicalIndex) allowedProviders.push('codex')
        else lexicalOptInMissing = true
      }
    }
    if (!requestedProvider || requestedProvider === 'antigravity') {
      if (agOk) {
        if (!query.query || agGrant.grant.allowLexicalIndex) allowedProviders.push('antigravity')
        else lexicalOptInMissing = true
      }
    }
    if (query.query && allowedProviders.length > 0 && lexicalOptInMissing) lexicalMixedOptIn = true
  }

  // Relation resolution
  const hasRelation = !!(query.artifactId || query.executionId || query.commitSha || query.pullRequest)
  const relFilter = {
    artifactId: query.artifactId,
    executionId: query.executionId,
    commitSha: query.commitSha,
    pullRequest: query.pullRequest,
    worktreeId: effectiveWorktree?.worktreeId,
    generation: effectiveWorktree?.generation,
    agent: query.agent
  }

  let scopedHookSessionIds: string[] | undefined = query.nativeSession ? [query.nativeSession.id] : undefined
  let scopedNativeKeys: string[] | undefined
  let scopedImportedIds: string[] | undefined = query.sessionId ? [query.sessionId] : undefined
  let relationReasons: string[] = []

  if (hasRelation) {
    const nativeRel = store.registry.queryNativeSessions(relFilter, accountHash)
    relationReasons = nativeRel.reasons
    const relHashByProvider = new Map<'codex' | 'antigravity', Set<string>>()
    const relHookIds: string[] = []
    for (const r of nativeRel.rows) {
      if (query.nativeSession && (r.provider !== query.nativeSession.provider || r.providerSessionId !== query.nativeSession.id)) continue
      relHookIds.push(r.providerSessionId)
      const p = r.provider === 'codex-native' ? 'codex' : r.provider === 'antigravity-native' ? 'antigravity' : undefined
      if (p) {
        let set = relHashByProvider.get(p)
        if (!set) { set = new Set(); relHashByProvider.set(p, set) }
        set.add(r.providerSessionId)
      }
    }
    scopedHookSessionIds = relHookIds

    const matchingKeys: string[] = []
    if (allowedProviders.length && relHashByProvider.size > 0) {
      const readySources = store.references.native.listReadySources(store.repositoryId, {
        worktreeId: effectiveWorktree?.worktreeId,
        generation: effectiveWorktree?.generation,
        providers: allowedProviders,
        sourceSessionId: query.sourceSessionId
      }, 0, 500)
      for (const s of readySources) {
        const hash = nativeDigest(JSON.stringify([store.repositoryId, s.provider, s.sourceSessionId]))
        if (relHashByProvider.get(s.provider)?.has(hash)) {
          matchingKeys.push(s.nativeKey)
        }
      }
    }
    scopedNativeKeys = matchingKeys

    const importedIdSet = new Set<string>()
    for (const row of store.sessions(relFilter, 0, 201, accountHash)) {
      if (!query.sessionId || row.id === query.sessionId) importedIdSet.add(row.id)
    }
    const selector = registrySelector(query)
    if (selector) {
      const linked = store.registry.linkedSessions(selector, relFilter, accountHash)
      for (const r of linked.rows) {
        if (r.sessionId && (!query.sessionId || r.sessionId === query.sessionId)) importedIdSet.add(r.sessionId)
      }
    }
    scopedImportedIds = [...importedIdSet]
  } else if (query.nativeSession) {
    const p = query.nativeSession.provider === 'codex-native' ? 'codex' : 'antigravity'
    if (query.sourceSessionId && effectiveWorktree) {
      if (nativeDigest(JSON.stringify([store.repositoryId, p, query.sourceSessionId])) !== query.nativeSession.id) {
        scopedNativeKeys = []
      } else {
        scopedNativeKeys = [nativeReferenceKey(p, store.repositoryId, effectiveWorktree.worktreeId, effectiveWorktree.generation, query.sourceSessionId)]
      }
    } else if (allowedProviders.includes(p)) {
      const readySources = store.references.native.listReadySources(store.repositoryId, {
        worktreeId: effectiveWorktree?.worktreeId,
        generation: effectiveWorktree?.generation,
        providers: [p],
        sourceSessionId: query.sourceSessionId
      }, 0, 500)
      scopedNativeKeys = readySources
        .filter(s => nativeDigest(JSON.stringify([store.repositoryId, s.provider, s.sourceSessionId])) === query.nativeSession!.id)
        .map(s => s.nativeKey)
    } else {
      scopedNativeKeys = []
    }
  }

  // Revalidate and stream NATIVE_SOURCE candidates
  const sourceValidationCache = new Map<string, { valid: true; expectedRevision: number; nativeSession: { provider: 'codex-native' | 'antigravity-native'; id: string; worktreeId: string; generation: string } } | { valid: false }>()
  let nativeSourceRejected = false
  let nativeSourcePartialReason: string | undefined
  let nsStreamMore = false

  const revalidateNativeSource = (hit: NativeCrossSessionHit) => {
    const cached = sourceValidationCache.get(hit.nativeKey)
    if (cached) return cached

    const providerKey = hit.provider === 'codex' ? ('codex-native' as const) : ('antigravity-native' as const)
    const nativeHash = nativeDigest(JSON.stringify([store.repositoryId, hit.provider, hit.sourceSessionId]))
    const nativeSession = { provider: providerKey, id: nativeHash, worktreeId: hit.worktreeId, generation: hit.generation }

    if (hit.provider === 'antigravity' && agGrant.configured && agGrant.ok) {
      if ((agGrant.grant.sessionHash !== undefined && agGrant.grant.sessionHash !== nativeHash) ||
          (agGrant.grant.sessionHashes !== undefined && !agGrant.grant.sessionHashes.includes(nativeHash))) {
        if (!store.references.native.isReadOnly) store.references.native.invalidate(hit.nativeKey)
        nativeSourceRejected = true
        sourceValidationCache.set(hit.nativeKey, { valid: false })
        return { valid: false as const }
      }
    }

    const worktreeRoot = resolveWorktreeRoot(hit.worktreeId, hit.generation, liveTargets, opts.selectedTarget, opts.root)
    if (!worktreeRoot) {
      nativeSourceRejected = true
      nativeSourcePartialReason ??= 'ORIGIN_UNVERIFIED'
      sourceValidationCache.set(hit.nativeKey, { valid: false })
      return { valid: false as const }
    }

    const normalizer = hit.provider === 'codex' ? NATIVE_CODEX_NORMALIZER : NATIVE_ANTIGRAVITY_NORMALIZER
    let fd: number | undefined
    try {
      assertCurrent()
      const ctx = verifyNativeLiteralContext(store, nativeSession, { worktreeId: hit.worktreeId, generation: hit.generation }, accountHash)
      if (ctx.app && ctx.locators.length > 1) throw new Error('IDENTITY_MISMATCH')
      const handle = hit.provider === 'codex'
        ? openCodexSourceHandle({
            storePath: store.path,
            repositoryId: store.repositoryId,
            worktreeRoot,
            nativeHash,
            sourceSessionId: hit.sourceSessionId,
            assertCurrent
          })
        : openAntigravitySourceHandle({
            storePath: store.path,
            repositoryId: store.repositoryId,
            nativeHash,
            sourceSessionId: hit.sourceSessionId,
            ...(ctx.locators.length === 1 ? { locatorDigest: ctx.locators[0] } : {}),
            worktreeRoot,
            registryVerifiedOrigin: ctx.registryVerifiedOrigin,
            assertCurrent
          })
      fd = handle.fd
      const summary = store.references.native.getSummary(hit.nativeKey)
      const exact = !!(
        summary &&
        summary.revision === hit.revision &&
        summary.locatorHash === handle.locatorHash &&
        summary.normalizer === normalizer &&
        summary.fileIdentity === handle.identity &&
        summary.sourceBytes === handle.sizeBytes &&
        (!query.query || handle.allowLexicalIndex === true)
      )
      closeSync(fd)
      fd = undefined
      handle.verifyAfterClose?.()
      assertCurrent()
      if (!exact || !summary) {
        if (!store.references.native.isReadOnly) store.references.native.invalidate(hit.nativeKey)
        nativeSourceRejected = true
        sourceValidationCache.set(hit.nativeKey, { valid: false })
        return { valid: false as const }
      }
      const expectedRevision = literalSnapshotRevision(ctx.baseRevision, normalizer, summary.revision, handle.liveFingerprint)
      const ok = { valid: true as const, expectedRevision, nativeSession }
      sourceValidationCache.set(hit.nativeKey, ok)
      return ok
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd) } catch {} }
      const code = error instanceof Error ? error.message : 'SOURCE_UNAVAILABLE'
      if (!store.references.native.isReadOnly && [
        'SOURCE_NOT_FOUND', 'SOURCE_UNAVAILABLE', 'SOURCE_NOT_AUTHORIZED', 'PROFILE_UNAVAILABLE',
        'IDENTITY_MISMATCH', 'ORIGIN_UNVERIFIED', 'SOURCE_IDENTITY_CONFLICT', 'SOURCE_PATH_ESCAPE',
        'SOURCE_STALE', 'SOURCE_REVISION_CHANGED', 'SESSION_UNAVAILABLE'
      ].includes(code)) {
        store.references.native.invalidate(hit.nativeKey)
      }
      nativeSourceRejected = true
      sourceValidationCache.set(hit.nativeKey, { valid: false })
      return { valid: false as const }
    }
  }

  const nsItems: StreamCandidate[] = []
  let nsScanEndOffset = nsOffset
  const nsEligible = !nativeSourceUnsupportedReason && allowedProviders.length > 0 && (!query.query || store.references.native.ftsAvailable)
  if (nsEligible) {
    let scanOffset = nsOffset
    const batchLimit = Math.max(query.limit + 1, 16)
    for (let batchIdx = 0; batchIdx < MAX_REVALIDATION_BATCHES && nsItems.length < query.limit + 1; batchIdx++) {
      const res = store.references.native.searchCrossSessionEvents({
        repositoryId: store.repositoryId,
        worktreeId: effectiveWorktree?.worktreeId,
        generation: effectiveWorktree?.generation,
        nativeKeys: scopedNativeKeys,
        providers: allowedProviders,
        sourceSessionId: query.sourceSessionId,
        types: query.types?.filter(t => NATIVE_SOURCE_TYPES.has(t)),
        tool: query.tool,
        status: query.status,
        isError: query.isError,
        errorKind: query.errorKind,
        turnId: query.turnId,
        after: query.after,
        before: query.before,
        query: query.query,
        mode: query.mode ?? 'ALL_TERMS',
        offset: scanOffset,
        limit: batchLimit
      })
      let batchConsumed = 0
      for (let i = 0; i < res.hits.length; i++) {
        batchConsumed = i + 1
        const hit = res.hits[i]!
        const validation = revalidateNativeSource(hit)
        if (!validation.valid) {
          continue
        }
        nsItems.push({
          sortKey: makeSortKey('NATIVE_SOURCE', hit.sourceSessionId, hit.eventId, hit.timestamp, hit.timestampMs),
          startOffset: scanOffset + i,
          hit: {
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
                nativeSession: validation.nativeSession,
                sourceSessionId: hit.sourceSessionId,
                expectedRevision: validation.expectedRevision,
                eventId: hit.eventId,
                ...(query.query ? { query: query.query, mode: query.mode ?? 'ALL_TERMS' } : {})
              }
            }
          }
        })
        if (nsItems.length >= query.limit + 1) break
      }
      nsScanEndOffset = scanOffset + batchConsumed
      scanOffset = nsScanEndOffset
      if (!res.more && batchConsumed === res.hits.length) {
        nsStreamMore = false
        break
      }
      nsStreamMore = true
    }
  }

  // Stream NATIVE_HOOK candidates
  const nhItems: StreamCandidate[] = []
  let nhStreamMore = false
  let nhScanEndOffset = nhOffset
  if (!nativeHookUnsupportedReason) {
    const hookResult = store.registry.searchHookObservations({
      repositoryId: store.repositoryId,
      worktreeId: effectiveWorktree?.worktreeId,
      generation: effectiveWorktree?.generation,
      provider: query.nativeSession?.provider,
      agent: query.agent,
      sessionIds: scopedHookSessionIds,
      hookEvents: query.hookEvents,
      tool: query.tool,
      invocationId: query.invocationId,
      turnId: query.turnId,
      after: query.after,
      before: query.before,
      offset: nhOffset,
      limit: query.limit + 1
    }, accountHash)
    nhStreamMore = hookResult.more
    nhScanEndOffset = nhOffset + hookResult.examined
    const hookRevCache = new Map<string, number>()
    for (const { event: ev, nextOffset } of hookResult.events) {
      const providerShort = ev.source === 'CODEX_NATIVE_HOOK' ? 'codex' : 'antigravity'
      const providerKey = providerShort === 'codex' ? ('codex-native' as const) : ('antigravity-native' as const)
      const revKey = `${providerKey}:${ev.sessionId}:${ev.worktreeId}:${ev.generation}`
      let hookRevision = hookRevCache.get(revKey)
      if (hookRevision === undefined) {
        const selector = { provider: providerKey, id: ev.sessionId, worktreeId: ev.worktreeId, generation: ev.generation }
        const obs = store.registry.nativeObservationScope(selector, accountHash)
        hookRevision = parseInt(digest(JSON.stringify([selector, obs.revision])).slice(0, 13), 16) || 1
        hookRevCache.set(revKey, hookRevision)
      }
      nhItems.push({
        sortKey: makeSortKey('NATIVE_HOOK', ev.sessionId, ev.eventId, ev.observedAt),
        startOffset: nextOffset - 1,
        hit: {
          sessionId: ev.sessionId,
          source: 'NATIVE_HOOK',
          origin: {
            provider: providerShort,
            worktreeId: ev.worktreeId,
            generation: ev.generation
          },
          eventId: ev.eventId,
          type: ev.event,
          timestamp: ev.observedAt,
          ...(ev.tool ? { tool: ev.tool } : {}),
          ...(ev.turnId ? { turnId: ev.turnId } : {}),
          ...(ev.invocationId ? { invocationId: ev.invocationId } : {}),
          deepen: {
            tool: 'list_agent_session_events',
            arguments: {
              repositoryId: store.repositoryId,
              nativeSession: {
                provider: providerKey,
                id: ev.sessionId,
                worktreeId: ev.worktreeId,
                generation: ev.generation
              },
              expectedRevision: hookRevision,
              eventId: ev.eventId
            }
          }
        }
      })
    }
  }

  // Stream IMPORTED candidates
  const impItems: StreamCandidate[] = []
  let impStreamMore = false
  let impScanEndOffset = impOffset
  if (!importedUnsupportedReason) {
    const impResult = store.searchImportedEvents({
      sessionId: query.sessionId,
      sessionIds: scopedImportedIds,
      worktreeId: effectiveWorktree?.worktreeId,
      generation: effectiveWorktree?.generation,
      agent: query.agent,
      types: query.types,
      tool: query.tool,
      isError: query.isError,
      file: query.file,
      after: query.after,
      before: query.before
    }, impOffset, query.limit + 1, accountHash)
    impStreamMore = impResult.more
    impScanEndOffset = impOffset + impResult.examined
    for (const ev of impResult.events) {
      impItems.push({
        sortKey: makeSortKey('IMPORTED', ev.sessionId, ev.eventId, ev.timestamp, ev.timestampMs),
        startOffset: ev.nextOffset - 1,
        hit: {
          sessionId: ev.sessionId,
          source: 'IMPORTED',
          origin: {
            provider: ev.provider
          },
          eventId: ev.eventId,
          type: ev.type,
          ...(ev.timestamp ? { timestamp: ev.timestamp } : {}),
          ...(ev.tool ? { tool: ev.tool } : {}),
          deepen: {
            tool: 'read_agent_session_event',
            arguments: {
              repositoryId: store.repositoryId,
              sessionId: ev.sessionId,
              eventId: ev.eventId,
              expectedRevision: ev.sessionRevision
            }
          }
        }
      })
    }
  }

  // Compute factual per-source coverage
  const nativeHookCoverage = (): EvidenceSourceCoverage => {
    if (nativeHookUnsupportedReason) {
      return {
        state: nativeHookUnsupportedReason === 'EXCLUDED_BY_SOURCE_SCOPE' || nativeHookUnsupportedReason === 'EXCLUDED_BY_SESSION_SCOPE'
          ? 'NOT_QUERIED'
          : nativeHookUnsupportedReason === 'LEXICAL_QUERY_NOT_SUPPORTED_FOR_NATIVE_HOOK'
            ? 'NOT_INDEXED_FOR_SOURCE'
            : 'NOT_OBSERVED',
        reason: nativeHookUnsupportedReason
      }
    }
    const status = store.registry.source('NATIVE_HOOK')?.status
    if (!status) return { state: 'UNOBSERVED' }
    if (relationReasons.length) return { state: 'PARTIAL', reason: relationReasons[0] }
    return { state: status }
  }

  const nativeSourceCoverage = (): EvidenceSourceCoverage => {
    if (nativeSourceUnsupportedReason) {
      return {
        state: nativeSourceUnsupportedReason === 'EXCLUDED_BY_SOURCE_SCOPE' || nativeSourceUnsupportedReason === 'IMPORTED_SESSION_SCOPE_ONLY'
          ? 'NOT_QUERIED'
          : 'NOT_OBSERVED',
        reason: nativeSourceUnsupportedReason
      }
    }
    if (query.query && !store.references.native.ftsAvailable) {
      return { state: 'UNAVAILABLE', reason: 'LEXICAL_INDEX_UNAVAILABLE' }
    }
    if (query.query && allowedProviders.length === 0) {
      return { state: 'NOT_INDEXED', reason: lexicalOptInMissing ? 'LEXICAL_INDEX_OPT_IN_REQUIRED' : 'NO_GRANTED_NATIVE_SOURCE' }
    }
    if (allowedProviders.length === 0) {
      const configuredAny = codexGrant.configured || agGrant.configured
      return { state: configuredAny ? 'UNAVAILABLE' : 'NON_INDEXED', reason: configuredAny ? 'NATIVE_SOURCE_GRANT_UNAVAILABLE' : 'NO_GRANTED_NATIVE_SOURCE' }
    }
    if (nativeSourceRejected) {
      return { state: 'PARTIAL', reason: nativeSourcePartialReason ?? 'STALE_OR_REVOKED_SOURCES_FILTERED' }
    }
    const readyCount = store.references.native.listReadySources(store.repositoryId, {
      worktreeId: effectiveWorktree?.worktreeId,
      generation: effectiveWorktree?.generation,
      providers: allowedProviders,
      sourceSessionId: query.sourceSessionId
    }, 0, 1).length
    if (readyCount === 0) {
      if (store.references.native.hasPendingCheckpoints(store.repositoryId, effectiveWorktree?.worktreeId, effectiveWorktree?.generation)) {
        return { state: 'INDEXING_PENDING' }
      }
      return { state: 'NON_INDEXED' }
    }
    if (lexicalMixedOptIn) return { state: 'PARTIAL', reason: 'LEXICAL_OPT_IN_PARTIAL' }
    if (query.types?.some(t => !NATIVE_SOURCE_TYPES.has(t))) return { state: 'PARTIAL', reason: 'UNSUPPORTED_EVENT_TYPE_FILTER' }
    if (relationReasons.length) return { state: 'PARTIAL', reason: relationReasons[0] }
    return { state: 'READY' }
  }

  const entireCoverage = (): EvidenceSourceCoverage => {
    if (importedUnsupportedReason) {
      return {
        state: importedUnsupportedReason === 'EXCLUDED_BY_SOURCE_SCOPE' || importedUnsupportedReason === 'EXCLUDED_BY_SESSION_SCOPE'
          ? 'NOT_QUERIED'
          : importedUnsupportedReason === 'LEXICAL_QUERY_NOT_SUPPORTED_FOR_IMPORTED'
            ? 'NOT_INDEXED_FOR_SOURCE'
            : 'NOT_OBSERVED',
        reason: importedUnsupportedReason
      }
    }
    const stats = store.importedSearchCoverage({
      sessionId: query.sessionId,
      sessionIds: scopedImportedIds,
      worktreeId: effectiveWorktree?.worktreeId,
      generation: effectiveWorktree?.generation,
      agent: query.agent
    }, accountHash)
    if (stats.totalSessions === 0) return { state: 'NON_INDEXED' }
    if (stats.referencedSessions === 0) return { state: 'METADATA_ONLY', reason: 'TRANSCRIPT_NOT_IMPORTED' }
    if (stats.metadataOnlySessions > 0 || stats.partialSessions > 0) return { state: 'PARTIAL' }
    return { state: 'READY' }
  }

  const coverage: EvidenceSearchEnvelope['coverage'] = {
    nativeHook: nativeHookCoverage(),
    nativeSource: nativeSourceCoverage(),
    entire: entireCoverage(),
    ...(query.file ? {
      fileCoverage: !importedUnsupportedReason && store.importedSearchCoverage({
        sessionId: query.sessionId,
        sessionIds: scopedImportedIds,
        worktreeId: effectiveWorktree?.worktreeId,
        generation: effectiveWorktree?.generation,
        agent: query.agent
      }, accountHash).fileObserved > 0
        ? { state: 'INDEXED_REFERENCES_ONLY' }
        : { state: 'NOT_OBSERVED', reason: 'FILE_FILTER_NOT_INDEXED_FOR_SOURCE' }
    } : {}),
    ...(query.operation ? { operationCoverage: { state: 'NOT_OBSERVED', reason: 'OPERATION_NOT_INDEXED_FOR_SOURCE' } } : {})
  }

  // Merge-sort streams by position with byte-budget enforcement
  let nsIdx = 0
  let nhIdx = 0
  let impIdx = 0
  const selectedHits: EvidenceHit[] = []
  let budgetStopped = false

  while (selectedHits.length < query.limit) {
    const candidates: Array<{ stream: 'ns' | 'nh' | 'imp'; item: StreamCandidate }> = []
    if (nsIdx < nsItems.length) candidates.push({ stream: 'ns', item: nsItems[nsIdx]! })
    if (nhIdx < nhItems.length) candidates.push({ stream: 'nh', item: nhItems[nhIdx]! })
    if (impIdx < impItems.length) candidates.push({ stream: 'imp', item: impItems[impIdx]! })
    if (!candidates.length) break

    candidates.sort((a, b) => compareSortKey(a.item.sortKey, b.item.sortKey))
    const chosen = candidates[0]!
    const probeEnvelope: EvidenceSearchEnvelope = {
      repositoryId: store.repositoryId,
      searchRevision,
      scope,
      coverage,
      hits: [...selectedHits, chosen.item.hit],
      nextCursor: 'probe-cursor-placeholder'
    }
    if (!fitsEnvelope(probeEnvelope, budget)) {
      if (selectedHits.length === 0) throw new Error('RESPONSE_LIMIT_REACHED')
      budgetStopped = true
      break
    }

    selectedHits.push(chosen.item.hit)
    if (chosen.stream === 'ns') nsIdx++
    else if (chosen.stream === 'nh') nhIdx++
    else impIdx++
  }

  const nextNs = nsIdx < nsItems.length ? nsItems[nsIdx]!.startOffset : nsScanEndOffset
  const nextNh = nhIdx < nhItems.length ? nhItems[nhIdx]!.startOffset : nhScanEndOffset
  const nextImp = impIdx < impItems.length ? impItems[impIdx]!.startOffset : impScanEndOffset

  const hasMore = budgetStopped ||
    nsIdx < nsItems.length || nsStreamMore ||
    nhIdx < nhItems.length || nhStreamMore ||
    impIdx < impItems.length || impStreamMore

  const nextCursor = hasMore
    ? store.cursorPayload(scopeKey, { ns: nextNs, nh: nextNh, imp: nextImp })
    : undefined

  return {
    repositoryId: store.repositoryId,
    searchRevision,
    scope,
    coverage,
    hits: selectedHits,
    ...(nextCursor ? { nextCursor } : {})
  }
}
