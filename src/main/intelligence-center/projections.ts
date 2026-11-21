import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { IArtifactReader } from '../continuum/continuum-types'
import type { AcademyService } from '../academy/academy-service'
import type { ValidationLedger } from '../validation-ledger/validation-ledger'
import type { McpToolResult } from '../mcp/mcp-types'
import { assertValidSessionRepositoryId, type SessionContextPort, type SessionToolName } from '../session-context/mcp'
import { EVIDENCE_EVALUATION_CATALOG_VERSION, getEvidenceEvaluationContractById } from './catalog'

export const SUPPORTED_PROJECTION_QUESTION_IDS = Object.freeze([
  'Q05',
  'Q19',
  'Q06',
  'Q23',
  'Q09',
  'Q16',
  'Q20',
  'Q21',
  'Q26'
] as const)

export type SupportedProjectionQuestionId = (typeof SUPPORTED_PROJECTION_QUESTION_IDS)[number]

const SUPPORTED_SET = new Set<string>(SUPPORTED_PROJECTION_QUESTION_IDS)
const RESPONSE_BUDGET_BYTES = 20_480
const MAX_EVENTS_PER_PAGE = 15
const MAX_WINDOW_PAGES = 2

const hex64 = z.string().regex(/^[a-f0-9]{64}$/)
const uuid = z.string().uuid()
const shortId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)

const nativeSessionSchema = z.object({
  provider: z.enum(['codex-native', 'antigravity-native']),
  id: hex64,
  worktreeId: hex64.optional(),
  generation: hex64.optional()
}).strict().refine(v => !!v.worktreeId === !!v.generation)

const entireSessionSchema = z.object({
  providerSessionId: shortId,
  worktreeId: hex64,
  generation: hex64
}).strict()

const relationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ARTIFACT'), id: z.string().regex(/^artifact-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/), revision: z.number().int().positive().optional() }).strict(),
  z.object({ type: z.literal('EXECUTION'), id: shortId }).strict(),
  z.object({ type: z.literal('COMMIT'), id: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  z.object({ type: z.literal('PR'), id: z.string().regex(/^[1-9][0-9]{0,9}$/) }).strict(),
  z.object({ type: z.literal('CHECKPOINT'), id: z.string().regex(/^(?:[a-f0-9]{10,40}|[0-9A-HJKMNP-TV-Z]{26})$/) }).strict(),
  z.object({ type: z.literal('PROOF'), id: z.string().regex(/^proof-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/) }).strict()
])

export const intelligenceTargetSchema = z.object({
  sessionId: uuid.optional(),
  nativeSession: nativeSessionSchema.optional(),
  sourceSessionId: uuid.optional(),
  entireSession: entireSessionSchema.optional(),
  relation: relationSchema.optional()
}).strict()

export const inspectIntelligenceEvidenceSchema = z.object({
  questionId: z.string().min(1).max(16),
  target: intelligenceTargetSchema,
  repositoryId: z.string().min(1).max(160).optional(),
  expectedCatalogVersion: z.number().int().min(1).optional(),
  expectedRevision: z.number().int().min(1).optional(),
  includeEntireUsage: z.boolean().default(false),
  limit: z.number().int().min(1).max(15).default(10),
  cursor: z.string().max(512).optional()
}).strict()

export type InspectIntelligenceEvidenceInput = z.infer<typeof inspectIntelligenceEvidenceSchema>
export type IntelligenceTarget = z.infer<typeof intelligenceTargetSchema>

export interface EvidenceProjectionPorts {
  repositoryId: string | null
  sessionContext: SessionContextPort
  artifactReader?: IArtifactReader
  validationLedger?: Pick<ValidationLedger, 'listProofs'>
  academy?: Pick<AcademyService, 'history'>
  allowArtifactMetadata: boolean
  assertSourceAuthorized: (worktreeId?: string) => void
  assertCurrent: () => void
}

export class ProjectionError extends Error {
  constructor(
    public readonly code: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(code)
  }
}

interface ParsedPortPayload {
  ok: boolean
  data: Record<string, unknown>
}

interface ResolvedSessionRef {
  kind: 'IMPORTED' | 'NATIVE'
  sessionId?: string
  nativeSession?: z.infer<typeof nativeSessionSchema>
  sourceSessionId?: string
  worktreeId?: string
  generation?: string
  witness?: unknown
}

interface GraphSummary {
  revision: string
  coverage: Record<string, unknown>
  sourceCoverage: unknown[]
  linkedArtifacts: Array<{ artifactId: string; kind?: string; status?: string; revision?: number; title?: string }>
  linkedProofIds: string[]
  edgesCount: number
}

function digestHex(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function parsePortResult(result: McpToolResult): ParsedPortPayload {
  const first = result.content.find(c => c.type === 'text')
  if (!first || first.type !== 'text') return { ok: !result.isError, data: {} }
  try {
    const parsed = JSON.parse(first.text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: !result.isError, data: parsed as Record<string, unknown> }
    }
  } catch {}
  return { ok: !result.isError, data: { message: first.text } }
}

async function callSessionPort(
  ports: EvidenceProjectionPorts,
  name: SessionToolName,
  args: unknown,
  allowArtifactMetadata = false
): Promise<ParsedPortPayload> {
  ports.assertCurrent()
  const result = await ports.sessionContext.call(name, args, allowArtifactMetadata)
  ports.assertCurrent()
  return parsePortResult(result)
}

function validateTarget(input: InspectIntelligenceEvidenceInput): {
  mode: 'SESSION' | 'NATIVE' | 'ENTIRE' | 'RELATION'
} {
  const t = input.target
  const kinds = [
    Boolean(t.sessionId),
    Boolean(t.nativeSession),
    Boolean(t.entireSession),
    Boolean(t.relation)
  ].filter(Boolean).length

  if (t.sourceSessionId && !t.nativeSession) {
    throw new ProjectionError('INVALID_ARGUMENT', {
      message: 'sourceSessionId requires nativeSession.'
    })
  }
  if (kinds !== 1) {
    throw new ProjectionError('CONFLICTING_TARGET', {
      message: 'Provide exactly one target selector: sessionId, nativeSession, entireSession, or relation.'
    })
  }
  if (t.sourceSessionId && (!t.nativeSession?.worktreeId || !t.nativeSession?.generation)) {
    throw new ProjectionError('ORIGIN_UNVERIFIED', {
      message: 'sourceSessionId requires paired nativeSession.worktreeId and nativeSession.generation.'
    })
  }
  if (t.entireSession && input.questionId !== 'Q26') {
    throw new ProjectionError('UNSUPPORTED_TARGET_FOR_QUESTION', {
      questionId: input.questionId,
      message: 'entireSession targets live Entire metadata only (supported for Q26); use sessionId, nativeSession, or relation.'
    })
  }
  if (input.includeEntireUsage && input.questionId !== 'Q26') {
    throw new ProjectionError('INVALID_ARGUMENT', {
      message: 'includeEntireUsage is only supported for Q26.'
    })
  }
  return {
    mode: t.sessionId ? 'SESSION' : t.nativeSession ? 'NATIVE' : t.entireSession ? 'ENTIRE' : 'RELATION'
  }
}

interface CursorPayload {
  v: 1
  scopeDigest: string
  revision: number
  offset: number
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeCursor(token: string, expectedScopeDigest: string, currentRevision: number): number {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
  } catch {
    throw new ProjectionError('INVALID_CURSOR')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProjectionError('INVALID_CURSOR')
  }
  const c = parsed as Partial<CursorPayload>
  if (c.v !== 1 || typeof c.scopeDigest !== 'string' || !Number.isSafeInteger(c.offset) || (c.offset ?? -1) < 0 || !Number.isSafeInteger(c.revision)) {
    throw new ProjectionError('INVALID_CURSOR')
  }
  if (c.scopeDigest !== expectedScopeDigest) {
    throw new ProjectionError('CURSOR_SCOPE_MISMATCH')
  }
  if (c.revision !== currentRevision) {
    throw new ProjectionError('REVISION_CONFLICT', { cursorRevision: c.revision, currentRevision })
  }
  return c.offset!
}

function paginateItems<T>(
  items: T[],
  offset: number,
  limit: number,
  scopeDigest: string,
  revision: number,
  buildEnvelope: (slice: T[], pagination: { totalInWindow: number; returned: number; offset: number; nextCursor?: string; partial: boolean }) => Record<string, unknown>
): Record<string, unknown> {
  if (offset > items.length) {
    throw new ProjectionError('CURSOR_STALE')
  }
  let count = Math.min(limit, Math.max(0, items.length - offset))
  for (;;) {
    const slice = items.slice(offset, offset + count)
    const hasMore = offset + slice.length < items.length
    const nextCursor = hasMore ? encodeCursor({ v: 1, scopeDigest, revision, offset: offset + slice.length }) : undefined
    const envelope = buildEnvelope(slice, {
      totalInWindow: items.length,
      returned: slice.length,
      offset,
      ...(nextCursor ? { nextCursor } : {}),
      partial: hasMore
    })
    if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') <= RESPONSE_BUDGET_BYTES || count <= 1) {
      return envelope
    }
    count = Math.max(1, Math.floor(count / 2))
  }
}

async function resolveRelationTarget(
  ports: EvidenceProjectionPorts,
  relation: z.infer<typeof relationSchema>
): Promise<{
  status: 'RESOLVED' | 'UNRESOLVED' | 'AMBIGUOUS'
  session?: ResolvedSessionRef
  candidates: Array<Record<string, unknown>>
  graph: GraphSummary
  gaps: string[]
}> {
  const ctxRes = await callSessionPort(
    ports,
    'discover_execution_context',
    { selector: relation, mode: 'RELATION_DETAIL', view: 'GRAPH', depth: 2, limit: 24 },
    ports.allowArtifactMetadata
  )

  if (!ctxRes.ok) {
    const code = typeof ctxRes.data.code === 'string' ? ctxRes.data.code : 'EXECUTION_CONTEXT_UNAVAILABLE'
    return {
      status: 'UNRESOLVED',
      candidates: [],
      graph: {
        revision: 'unavailable',
        coverage: { state: 'UNAVAILABLE', reason: code },
        sourceCoverage: [],
        linkedArtifacts: [],
        linkedProofIds: [],
        edgesCount: 0
      },
      gaps: [code]
    }
  }

  const nodes = Array.isArray(ctxRes.data.nodes) ? (ctxRes.data.nodes as Array<Record<string, unknown>>) : []
  const edges = Array.isArray(ctxRes.data.edges) ? (ctxRes.data.edges as Array<Record<string, unknown>>) : []
  const coverage = (ctxRes.data.coverage as Record<string, unknown> | undefined) ?? { state: 'UNKNOWN' }
  const sourceCoverage = Array.isArray(ctxRes.data.sourceCoverage) ? ctxRes.data.sourceCoverage : []
  const graphRevision = typeof ctxRes.data.revision === 'string' ? ctxRes.data.revision : digestHex([nodes, edges])

  const linkedArtifacts = nodes
    .filter(n => n.type === 'ARTIFACT' && typeof n.id === 'string')
    .map(n => ({
      artifactId: String(n.id),
      ...(typeof n.artifactKind === 'string' ? { kind: n.artifactKind } : {}),
      ...(typeof n.status === 'string' ? { status: n.status } : {}),
      ...(typeof n.revision === 'number' ? { revision: n.revision } : {}),
      ...(typeof n.title === 'string' ? { title: n.title } : {})
    }))

  const linkedProofIds = nodes
    .filter(n => n.type === 'PROOF' && typeof n.id === 'string')
    .map(n => String(n.id))

  const graph: GraphSummary = {
    revision: graphRevision,
    coverage,
    sourceCoverage,
    linkedArtifacts,
    linkedProofIds,
    edgesCount: edges.length
  }

  // Also query list_agent_sessions when relation supports it to collect canonical selectors/worktree refs
  const listFilter: Record<string, unknown> = { view: 'FOCAL', limit: 6 }
  if (relation.type === 'ARTIFACT') listFilter.artifactId = relation.id
  else if (relation.type === 'EXECUTION') listFilter.executionId = relation.id
  else if (relation.type === 'COMMIT') listFilter.commitSha = relation.id
  else if (relation.type === 'PR') listFilter.pullRequest = Number(relation.id)

  const candidatesByKey = new Map<string, { ref: ResolvedSessionRef; summary: Record<string, unknown> }>()

  if (['ARTIFACT', 'EXECUTION', 'COMMIT', 'PR'].includes(relation.type)) {
    const listRes = await callSessionPort(ports, 'list_agent_sessions', listFilter)
    if (listRes.ok && Array.isArray(listRes.data.sessions)) {
      for (const s of listRes.data.sessions as Array<Record<string, unknown>>) {
        const worktrees = Array.isArray(s.worktrees) ? (s.worktrees as Array<{ worktreeId?: string; generation?: string }>) : []
        const wt = worktrees.length === 1 && worktrees[0]?.worktreeId && worktrees[0]?.generation
          ? { worktreeId: worktrees[0].worktreeId, generation: worktrees[0].generation }
          : undefined
        if (typeof s.sessionId === 'string') {
          const key = `IMPORTED:${s.sessionId}`
          candidatesByKey.set(key, {
            ref: { kind: 'IMPORTED', sessionId: s.sessionId, ...(wt ?? {}), witness: s.witness },
            summary: {
              selector: { sessionId: s.sessionId },
              provider: s.provider ?? 'entire',
              ...(s.witness ? { witness: s.witness } : {}),
              ...(s.reason ? { reason: s.reason } : {})
            }
          })
        } else if ((s.provider === 'codex-native' || s.provider === 'antigravity-native') && typeof s.providerSessionId === 'string') {
          const nativeSelector = {
            provider: s.provider as 'codex-native' | 'antigravity-native',
            id: s.providerSessionId,
            ...(wt ?? {})
          }
          const sourceSid = typeof s.sourceSessionId === 'string' && ports.allowArtifactMetadata ? s.sourceSessionId : undefined
          const key = `NATIVE:${s.provider}:${s.providerSessionId}`
          candidatesByKey.set(key, {
            ref: {
              kind: 'NATIVE',
              nativeSession: nativeSelector,
              ...(sourceSid && wt ? { sourceSessionId: sourceSid } : {}),
              ...(wt ?? {}),
              witness: s.witness
            },
            summary: {
              selector: {
                nativeSession: nativeSelector,
                ...(sourceSid && wt ? { sourceSessionId: sourceSid } : {})
              },
              provider: s.provider,
              ...(s.witness ? { witness: s.witness } : {}),
              ...(s.captureCoverage ? { captureCoverage: s.captureCoverage } : {})
            }
          })
        }
      }
    }
  }

  for (const node of nodes) {
    if (node.type !== 'SESSION') continue
    const deepenArgs = (node.deepen as { arguments?: Record<string, unknown> } | undefined)?.arguments
    if (deepenArgs && typeof deepenArgs.sessionId === 'string') {
      const key = `IMPORTED:${deepenArgs.sessionId}`
      if (!candidatesByKey.has(key)) {
        candidatesByKey.set(key, {
          ref: { kind: 'IMPORTED', sessionId: deepenArgs.sessionId },
          summary: { selector: { sessionId: deepenArgs.sessionId }, provider: node.provider ?? 'entire' }
        })
      }
    } else if ((node.provider === 'codex-native' || node.provider === 'antigravity-native') && typeof node.id === 'string' && /^[a-f0-9]{64}$/.test(node.id)) {
      const key = `NATIVE:${node.provider}:${node.id}`
      if (!candidatesByKey.has(key)) {
        const nativeSelector = { provider: node.provider as 'codex-native' | 'antigravity-native', id: node.id }
        candidatesByKey.set(key, {
          ref: { kind: 'NATIVE', nativeSession: nativeSelector },
          summary: { selector: { nativeSession: nativeSelector }, provider: node.provider }
        })
      }
    }
  }

  const candidates = [...candidatesByKey.values()]
  if (candidates.length === 0) {
    const discoveryReason = (ctxRes.data.discovery as { reason?: string } | undefined)?.reason ?? 'NO_VERIFIED_SESSION_FOR_RELATION'
    return { status: 'UNRESOLVED', candidates: [], graph, gaps: [discoveryReason] }
  }
  if (candidates.length > 1) {
    return {
      status: 'AMBIGUOUS',
      candidates: candidates.map(c => c.summary),
      graph,
      gaps: ['MULTIPLE_CANDIDATE_SESSIONS']
    }
  }
  return {
    status: 'RESOLVED',
    session: candidates[0]!.ref,
    candidates: [candidates[0]!.summary],
    graph,
    gaps: []
  }
}

interface LoadedSessionWindow {
  sessionRef: ResolvedSessionRef
  sessionRevision: number
  sourceKind: 'NATIVE_SOURCE' | 'NATIVE_HOOK' | 'IMPORTED' | 'UNAVAILABLE'
  provider: string
  contentAvailability: string
  captureCoverage?: string
  sessionData: Record<string, unknown>
  events: Array<Record<string, unknown>>
  hasMoreSourceEvents: boolean
  windowOffset: number
  gaps: string[]
}

async function loadSessionWindow(
  ports: EvidenceProjectionPorts,
  sessionRef: ResolvedSessionRef
): Promise<LoadedSessionWindow> {
  const gaps: string[] = []
  const inspectArgs: Record<string, unknown> = sessionRef.kind === 'IMPORTED'
    ? { sessionId: sessionRef.sessionId, view: 'FOCAL', limit: 10 }
    : {
        nativeSession: sessionRef.nativeSession,
        ...(sessionRef.sourceSessionId ? { sourceSessionId: sessionRef.sourceSessionId } : {}),
        view: 'FOCAL',
        limit: 10
      }

  const inspectRes = await callSessionPort(ports, 'inspect_agent_session', inspectArgs)
  if (!inspectRes.ok) {
    const code = typeof inspectRes.data.code === 'string' ? inspectRes.data.code : 'SESSION_UNAVAILABLE'
    throw new ProjectionError(code, inspectRes.data)
  }

  const sessionRevision = typeof inspectRes.data.revision === 'number' && Number.isSafeInteger(inspectRes.data.revision)
    ? inspectRes.data.revision
    : 1
  const rawSource = typeof inspectRes.data.source === 'string' ? inspectRes.data.source : (sessionRef.kind === 'IMPORTED' ? 'IMPORTED' : 'NATIVE_HOOK')
  const contentAvailability = typeof inspectRes.data.contentAvailability === 'string'
    ? inspectRes.data.contentAvailability
    : rawSource === 'IMPORTED' || sessionRef.kind === 'IMPORTED' ? 'AVAILABLE' : 'SOURCE_UNAVAILABLE'
  const sourceAvailable = contentAvailability === 'AVAILABLE' || contentAvailability === 'READY'
  const sourceKind: LoadedSessionWindow['sourceKind'] =
    rawSource === 'IMPORTED' || sessionRef.kind === 'IMPORTED'
      ? 'IMPORTED'
      : (rawSource === 'NATIVE_SOURCE' || rawSource === 'CODEX_LOCAL_TRANSCRIPT_V1' || rawSource === 'ANTIGRAVITY_APP_LOCAL_TRANSCRIPT_V1' || (sessionRef.sourceSessionId && sourceAvailable))
        ? 'NATIVE_SOURCE'
        : 'NATIVE_HOOK'
  const provider = typeof inspectRes.data.provider === 'string'
    ? inspectRes.data.provider
    : sessionRef.nativeSession?.provider ?? 'entire'

  if (typeof inspectRes.data.sourceDiagnostic === 'string') {
    gaps.push(inspectRes.data.sourceDiagnostic)
  } else if (sourceKind === 'NATIVE_HOOK') {
    gaps.push(sessionRef.sourceSessionId ? 'SOURCE_UNAVAILABLE' : 'SOURCE_SESSION_ID_NOT_PROVIDED')
  }

  // Query bounded event window using literal revision returned by inspect_agent_session
  const baseEventArgs: Record<string, unknown> = sessionRef.kind === 'IMPORTED'
    ? { sessionId: sessionRef.sessionId, expectedRevision: sessionRevision, limit: MAX_EVENTS_PER_PAGE }
    : {
        nativeSession: sessionRef.nativeSession,
        ...(sessionRef.sourceSessionId && sourceAvailable ? { sourceSessionId: sessionRef.sourceSessionId } : {}),
        expectedRevision: sessionRevision,
        limit: MAX_EVENTS_PER_PAGE
      }

  const events: Array<Record<string, unknown>> = []
  let nextCursor: string | undefined
  let hasMoreSourceEvents = false

  for (let pageIdx = 0; pageIdx < MAX_WINDOW_PAGES; pageIdx++) {
    const evRes = await callSessionPort(ports, 'list_agent_session_events', {
      ...baseEventArgs,
      ...(nextCursor ? { cursor: nextCursor } : {})
    })
    if (!evRes.ok) {
      const code = typeof evRes.data.code === 'string' ? evRes.data.code : 'EVENTS_UNAVAILABLE'
      gaps.push(code)
      break
    }
    const batch = Array.isArray(evRes.data.events) ? (evRes.data.events as Array<Record<string, unknown>>) : []
    events.push(...batch)
    nextCursor = typeof evRes.data.nextCursor === 'string' ? evRes.data.nextCursor : undefined
    if (!nextCursor) break
    if (pageIdx === MAX_WINDOW_PAGES - 1) hasMoreSourceEvents = true
  }

  return {
    sessionRef,
    sessionRevision,
    sourceKind,
    provider,
    contentAvailability,
    captureCoverage: typeof inspectRes.data.captureCoverage === 'string' ? inspectRes.data.captureCoverage : undefined,
    sessionData: inspectRes.data,
    events,
    hasMoreSourceEvents,
    windowOffset: 0,
    gaps: [...new Set(gaps)]
  }
}

function makeDeepen(window: LoadedSessionWindow, event: Record<string, unknown>): Record<string, unknown> {
  if (event.deepen && typeof event.deepen === 'object') {
    return event.deepen as Record<string, unknown>
  }
  const eventId = typeof event.eventId === 'string' ? event.eventId : undefined
  if (window.sourceKind === 'NATIVE_HOOK' && window.sessionRef.nativeSession && eventId) {
    return {
      tool: 'list_agent_session_events',
      arguments: {
        nativeSession: window.sessionRef.nativeSession,
        expectedRevision: window.sessionRevision,
        eventId
      }
    }
  }
  if (window.sourceKind === 'NATIVE_SOURCE' && window.sessionRef.nativeSession && window.sessionRef.sourceSessionId && eventId) {
    return {
      tool: 'read_agent_session_event',
      arguments: {
        nativeSession: window.sessionRef.nativeSession,
        sourceSessionId: window.sessionRef.sourceSessionId,
        expectedRevision: window.sessionRevision,
        eventId
      }
    }
  }
  if (window.sessionRef.sessionId && eventId) {
    return {
      tool: 'read_agent_session_event',
      arguments: {
        sessionId: window.sessionRef.sessionId,
        expectedRevision: window.sessionRevision,
        eventId
      }
    }
  }
  return {
    tool: 'inspect_agent_session',
    arguments: window.sessionRef.sessionId
      ? { sessionId: window.sessionRef.sessionId, expectedRevision: window.sessionRevision }
      : { nativeSession: window.sessionRef.nativeSession }
  }
}

function isFailureEvent(ev: Record<string, unknown>): boolean {
  return (
    ev.type === 'ERROR' ||
    ev.status === 'FAILURE' ||
    ev.status === 'REFUSAL' ||
    ev.status === 'DANGLING' ||
    ev.success === false
  )
}

async function fetchLinkedProofs(
  ports: EvidenceProjectionPorts,
  graph?: GraphSummary
): Promise<Array<Record<string, unknown>>> {
  if (!ports.validationLedger || !graph?.linkedArtifacts.length) return []
  const seen = new Set<string>()
  const proofs: Array<Record<string, unknown>> = []
  for (const art of graph.linkedArtifacts.slice(0, 3)) {
    try {
      const list = await ports.validationLedger.listProofs({ requirementId: art.artifactId, limit: 5 })
      for (const p of list) {
        if (seen.has(p.proofId)) continue
        seen.add(p.proofId)
        proofs.push({
          proofId: p.proofId,
          kind: p.kind,
          status: p.status,
          freshness: p.freshness,
          evidenceFor: p.evidenceFor,
          scope: p.scope.slice(0, 4)
        })
      }
    } catch {}
  }
  return proofs
}

function buildSessionItems(
  window: LoadedSessionWindow,
  graph: GraphSummary | undefined,
  proofs: Array<Record<string, unknown>>
) {
  const items: Array<Record<string, unknown>> = []
  const events = window.events

  if (window.sourceKind === 'NATIVE_HOOK') {
    const byInvocation = new Map<string, Array<Record<string, unknown>>>()
    const ungrouped: Array<Record<string, unknown>> = []
    for (const ev of events) {
      if (typeof ev.invocationId === 'string' && ev.invocationId) {
        const list = byInvocation.get(ev.invocationId) ?? []
        list.push(ev)
        byInvocation.set(ev.invocationId, list)
      } else {
        ungrouped.push(ev)
      }
    }
    for (const [invocationId, group] of byInvocation) {
      const hasAntigravityInvocation = group.some(g => g.type === 'PreInvocation' || g.type === 'PostInvocation')
      items.push({
        class: 'OBSERVADO',
        groupingBasis: 'NATIVE_HOOK_INVOCATION_ID',
        invocationId,
        tool: group.find(g => g.tool)?.tool ?? null,
        outcomeState: 'UNKNOWN_FROM_HOOK_ONLY',
        ...(hasAntigravityInvocation ? { semanticNote: 'Antigravity invocationNum/PreInvocation-PostInvocation is not equivalent to turn or model call.' } : {}),
        events: group.map(g => ({
          eventId: g.eventId,
          type: g.type,
          observedAt: g.observedAt,
          deepen: makeDeepen(window, g)
        }))
      })
    }
    for (const ev of ungrouped) {
      items.push({
        class: 'OBSERVADO',
        groupingBasis: 'UNGROUPED_HOOK_EVENT',
        eventId: ev.eventId,
        type: ev.type,
        tool: ev.tool ?? null,
        outcomeState: 'UNKNOWN_FROM_HOOK_ONLY',
        deepen: makeDeepen(window, ev)
      })
    }
  } else {
    // NATIVE_SOURCE or IMPORTED
    const pairedCallIndices = new Set<number>()
    const callForResultIndex = new Map<number, Record<string, unknown>>()
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!
      if ((ev.type === 'ERROR' || ev.type === 'TOOL_RESULT') && ev.pairing === 'PAIRED') {
        for (let j = i - 1; j >= 0; j--) {
          if (pairedCallIndices.has(j)) continue
          const prev = events[j]!
          if (prev.type === 'TOOL_CALL' && prev.pairing === 'PAIRED' && prev.tool === ev.tool && prev.turnId === ev.turnId) {
            pairedCallIndices.add(j)
            callForResultIndex.set(i, prev)
            break
          }
        }
      }
    }

    for (let i = 0; i < events.length; i++) {
      if (pairedCallIndices.has(i)) continue
      const ev = events[i]!
      if (!isFailureEvent(ev)) continue

      const pairedCall = callForResultIndex.get(i)

      // Check for subsequent recovery candidates for the exact same tool (strictly non-causal)
      const recoveryCandidates: Array<Record<string, unknown>> = []
      if (typeof ev.tool === 'string') {
        for (let k = i + 1; k < events.length; k++) {
          const later = events[k]!
          if (later.tool === ev.tool && (later.status === 'SUCCESS' || later.success === true) && later.type !== 'TOOL_CALL') {
            recoveryCandidates.push({
              class: 'DERIVADO',
              provesResolution: false,
              note: 'Subsequent SUCCESS for same tool does not prove same-property resolution without literal verification.',
              eventId: later.eventId,
              ordinal: later.ordinal,
              status: later.status ?? 'SUCCESS',
              deepen: makeDeepen(window, later)
            })
            break
          }
        }
      }

      items.push({
        class: 'OBSERVADO',
        groupingBasis: pairedCall ? 'QUALIFIED_NATIVE_PAIRING' : 'UNPAIRED_OR_SINGLE_EVENT',
        eventId: ev.eventId,
        ordinal: ev.ordinal,
        type: ev.type,
        tool: ev.tool ?? null,
        turnId: ev.turnId ?? null,
        status: ev.status ?? (ev.success === false ? 'FAILURE' : 'UNKNOWN'),
        ...(ev.errorKind ? { errorKind: ev.errorKind } : {}),
        pairing: ev.pairing ?? null,
        deepen: makeDeepen(window, ev),
        ...(pairedCall ? {
          pairedAttempt: {
            eventId: pairedCall.eventId,
            ordinal: pairedCall.ordinal,
            type: pairedCall.type,
            status: pairedCall.status,
            deepen: makeDeepen(window, pairedCall)
          }
        } : {}),
        ...(recoveryCandidates.length ? { recoveryCandidates } : {})
      })
    }
  }

  const firstFailure = items.find(item => item.status === 'FAILURE' || item.status === 'REFUSAL' || item.status === 'DANGLING' || item.type === 'ERROR') ?? null
  const contextConsultations = events
    .filter(ev => ev.type === 'TOOL_CALL' && typeof ev.tool === 'string' && /read|search|inspect|list|get/i.test(String(ev.tool)))
    .slice(0, 5)
    .map(ev => ({
      class: 'OBSERVADO',
      eventId: ev.eventId,
      ordinal: ev.ordinal,
      tool: ev.tool,
      status: ev.status ?? 'UNKNOWN',
      deepen: makeDeepen(window, ev)
    }))

  return {
    items,
    summary: {
      firstObservedFailureInWindow: firstFailure,
      windowScope: {
        examinedEvents: events.length,
        hasMoreSourceEvents: window.hasMoreSourceEvents,
        isAbsoluteSessionFirst: !window.hasMoreSourceEvents && window.windowOffset === 0
      },
      contextConsultations: window.sourceKind === 'NATIVE_HOOK' ? [] : contextConsultations,
      contextConsultationsCoverage: window.sourceKind === 'NATIVE_HOOK' ? 'UNAVAILABLE' : 'WINDOW_TOOL_CALLS_ONLY',
      ...(graph?.linkedArtifacts.length ? { linkedArtifacts: graph.linkedArtifacts } : {}),
      ...(proofs.length ? { linkedProofs: proofs } : {})
    }
  }
}

function buildHarnessProjection(
  window: LoadedSessionWindow,
  graph: GraphSummary | undefined,
  proofs: Array<Record<string, unknown>>
) {
  const firstFailure = window.events.find(isFailureEvent)
  const pairedAttempt = firstFailure && firstFailure.pairing === 'PAIRED'
    ? [...window.events].reverse().find(ev =>
        ev.type === 'TOOL_CALL' &&
        ev.pairing === 'PAIRED' &&
        ev.tool === firstFailure.tool &&
        ev.turnId === firstFailure.turnId &&
        (typeof ev.ordinal !== 'number' || typeof firstFailure.ordinal !== 'number' || ev.ordinal < firstFailure.ordinal)
      )
    : undefined

  const boundaryKind = !firstFailure
    ? 'NO_FAILURE_OBSERVED_IN_WINDOW'
    : firstFailure.status === 'REFUSAL' || firstFailure.errorKind === 'TURN_ABORTED'
      ? 'POLICY_REFUSAL'
      : firstFailure.status === 'DANGLING'
        ? 'DANGLING_CALL'
        : 'OPERATIONAL_OR_TOOL_FAILURE'

  const priorCalls = firstFailure
    ? window.events
        .filter(ev => ev.type === 'TOOL_CALL' && (typeof ev.ordinal !== 'number' || typeof firstFailure.ordinal !== 'number' || ev.ordinal < firstFailure.ordinal))
        .slice(-3)
        .map(ev => ({ eventId: ev.eventId, tool: ev.tool ?? null, status: ev.status ?? null, deepen: makeDeepen(window, ev) }))
    : []

  const components = {
    toolAndContract: {
      status: firstFailure ? 'OBSERVED' : window.events.length ? 'PARTIAL' : 'UNAVAILABLE',
      facts: [
        ...(firstFailure ? [{
          class: 'OBSERVADO',
          boundaryKind,
          eventId: firstFailure.eventId,
          type: firstFailure.type,
          status: firstFailure.status ?? null,
          errorKind: firstFailure.errorKind ?? null,
          tool: firstFailure.tool ?? null,
          pairing: firstFailure.pairing ?? null,
          deepen: makeDeepen(window, firstFailure),
          ...(pairedAttempt ? { pairedAttempt: { eventId: pairedAttempt.eventId, status: pairedAttempt.status, deepen: makeDeepen(window, pairedAttempt) } } : {})
        }] : []),
        ...(graph?.linkedArtifacts.length ? [{ class: 'DECLARADO', linkedArtifacts: graph.linkedArtifacts }] : [])
      ],
      gaps: firstFailure ? [] : ['NO_STRUCTURED_ERROR_OBSERVED_IN_WINDOW']
    },
    stateAndOrigin: {
      status: 'OBSERVED',
      facts: [{
        class: 'OBSERVADO',
        provider: window.provider,
        source: window.sourceKind,
        contentAvailability: window.contentAvailability,
        ...(window.captureCoverage ? { captureCoverage: window.captureCoverage } : {}),
        origin: window.sessionData.origin ?? null,
        worktreeId: window.sessionRef.worktreeId ?? window.sessionRef.nativeSession?.worktreeId ?? null,
        generation: window.sessionRef.generation ?? window.sessionRef.nativeSession?.generation ?? null
      }],
      gaps: window.gaps
    },
    authorityAndPolicy: {
      status: proofs.length || firstFailure?.status === 'REFUSAL' ? 'PARTIAL' : 'UNAVAILABLE',
      facts: [
        ...(firstFailure?.status === 'REFUSAL' ? [{ class: 'OBSERVADO', policyRefusalObserved: true, eventId: firstFailure.eventId }] : []),
        ...proofs.map(p => ({ class: 'OBSERVADO', ...p }))
      ],
      gaps: proofs.length ? [] : ['NO_LINKED_VALIDATION_PROOF_OBSERVED']
    },
    contextDelivered: {
      status: priorCalls.length ? 'PARTIAL' : 'UNAVAILABLE',
      facts: priorCalls.map(c => ({ class: 'OBSERVADO', ...c })),
      gaps: ['FULL_MODEL_REQUEST_ENVELOPE_UNAVAILABLE']
    },
    modelAndEffort: {
      status: 'UNAVAILABLE',
      facts: [],
      gaps: ['PER_CALL_MODEL_AND_EFFORT_UNAVAILABLE']
    },
    skillsLinked: {
      status: 'UNAVAILABLE',
      facts: [],
      gaps: ['TYPED_SKILL_EVENTS_UNAVAILABLE']
    }
  }

  return {
    classification: null,
    classificationNote: 'Projection surfaces discriminative boundary facts only; investigator applies Q06/Q23 without binary attribution on missing metadata.',
    components
  }
}

function buildContextProjection(window: LoadedSessionWindow) {
  const operations: Array<Record<string, unknown>> = []
  const byVerifiedDigest = new Map<string, { tool: string; callDigest: string; resultDigest: string; refs: Array<Record<string, unknown>> }>()
  const byCandidateKey = new Map<string, { candidateBasis: string; key: string; refs: Array<Record<string, unknown>> }>()

  const events = window.events
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!
    const deepen = makeDeepen(window, ev)

    if (window.sourceKind === 'NATIVE_HOOK') {
      const catKey = `HOOK:${ev.type}:${ev.tool ?? 'UNKNOWN'}`
      const bucket = byCandidateKey.get(catKey) ?? {
        candidateBasis: 'CANDIDATE_TOOL_CATEGORY_ONLY',
        key: String(ev.tool ?? ev.type),
        refs: []
      }
      bucket.refs.push({ eventId: ev.eventId, observedAt: ev.observedAt, deepen })
      byCandidateKey.set(catKey, bucket)
      operations.push({
        class: 'OBSERVADO',
        eventId: ev.eventId,
        type: ev.type,
        tool: ev.tool ?? null,
        resourceIdentity: null,
        resourceRevision: null,
        omission: ev.omission ?? 'SOURCE_UNAVAILABLE',
        contentAvailability: window.contentAvailability,
        deepen
      })
      continue
    }

    if (window.sourceKind === 'IMPORTED') {
      const files = Array.isArray(ev.files) ? (ev.files as string[]) : []
      operations.push({
        class: 'OBSERVADO',
        eventId: ev.eventId,
        ordinal: ev.ordinal,
        type: ev.type,
        tool: ev.tool ?? null,
        files,
        resourceRevision: null,
        snapshotRevision: window.sessionRevision,
        omission: ev.omission ?? null,
        bytes: ev.bytes ?? null,
        contentAvailability: window.contentAvailability,
        deepen
      })
      for (const file of files) {
        const key = `FILE:${file}`
        const bucket = byCandidateKey.get(key) ?? {
          candidateBasis: 'CANDIDATE_PATH_ONLY_NO_FILE_REVISION',
          key: file,
          refs: []
        }
        bucket.refs.push({ eventId: ev.eventId, ordinal: ev.ordinal, tool: ev.tool ?? null, deepen })
        byCandidateKey.set(key, bucket)
      }
      continue
    }

    // NATIVE_SOURCE
    if (ev.type === 'TOOL_CALL') {
      // Find paired result in window if present
      let pairedResult: Record<string, unknown> | undefined
      if (ev.pairing === 'PAIRED') {
        for (let j = i + 1; j < events.length; j++) {
          const next = events[j]!
          if ((next.type === 'TOOL_RESULT' || next.type === 'ERROR') && next.pairing === 'PAIRED' && next.tool === ev.tool && next.turnId === ev.turnId) {
            pairedResult = next
            break
          }
        }
      }
      operations.push({
        class: 'OBSERVADO',
        eventId: ev.eventId,
        ordinal: ev.ordinal,
        type: ev.type,
        tool: ev.tool ?? null,
        callPayloadDigest: ev.payloadDigest ?? null,
        resultPayloadDigest: pairedResult?.payloadDigest ?? null,
        snapshotRevision: window.sessionRevision,
        bytes: ev.bytes ?? null,
        sanitized: Boolean(ev.sanitized),
        contentAvailability: window.contentAvailability,
        deepen,
        ...(pairedResult ? { resultDeepen: makeDeepen(window, pairedResult) } : {})
      })

      if (typeof ev.tool === 'string' && typeof ev.payloadDigest === 'string' && pairedResult && typeof pairedResult.payloadDigest === 'string') {
        const verifiedKey = `${ev.tool}\0${ev.payloadDigest}\0${pairedResult.payloadDigest}`
        const group = byVerifiedDigest.get(verifiedKey) ?? {
          tool: ev.tool,
          callDigest: ev.payloadDigest,
          resultDigest: pairedResult.payloadDigest,
          refs: []
        }
        group.refs.push({
          callEventId: ev.eventId,
          resultEventId: pairedResult.eventId,
          ordinal: ev.ordinal,
          deepen,
          resultDeepen: makeDeepen(window, pairedResult)
        })
        byVerifiedDigest.set(verifiedKey, group)
      } else if (typeof ev.tool === 'string') {
        const candKey = `TOOL:${ev.tool}`
        const bucket = byCandidateKey.get(candKey) ?? {
          candidateBasis: 'CANDIDATE_TOOL_OR_CALL_ONLY',
          key: ev.tool,
          refs: []
        }
        bucket.refs.push({
          eventId: ev.eventId,
          ordinal: ev.ordinal,
          callPayloadDigest: ev.payloadDigest ?? null,
          deepen
        })
        byCandidateKey.set(candKey, bucket)
      }
    }
  }

  const provenRepetitions = [...byVerifiedDigest.values()]
    .filter(g => g.refs.length > 1)
    .map(g => ({
      class: 'DERIVADO',
      isProvenReread: true,
      equivalenceProof: 'VERIFIED_CALL_AND_RESULT_DIGEST',
      tool: g.tool,
      callPayloadDigest: g.callDigest,
      resultPayloadDigest: g.resultDigest,
      count: g.refs.length,
      refs: g.refs
    }))

  const repetitionCandidates = [...byCandidateKey.values()]
    .filter(g => g.refs.length > 1)
    .map(g => ({
      class: 'DERIVADO',
      isProvenReread: false,
      equivalenceProof: g.candidateBasis,
      target: g.key,
      count: g.refs.length,
      refs: g.refs,
      note: 'Candidate only: identical resource revision/content equivalence is not established across occurrences.'
    }))

  return {
    operations,
    provenRepetitions,
    repetitionCandidates,
    snapshotNote: 'snapshotRevision reflects session index revision, not current file revision on disk; index presence does not prove model consumption.'
  }
}

async function buildAcademyProjection(
  ports: EvidenceProjectionPorts,
  input: InspectIntelligenceEvidenceInput,
  graph?: GraphSummary
) {
  const declaredSkills: Array<Record<string, unknown>> = []
  const historicalVersions: Array<Record<string, unknown>> = []
  const gaps = new Set<string>(['USE_NOT_OBSERVED', 'TYPED_SKILL_EVENTS_UNAVAILABLE', 'CONTEXT_DELIVERY_ENVELOPE_UNAVAILABLE'])

  const candidateArtifactIds = new Set<string>()
  if (input.target.relation?.type === 'ARTIFACT') candidateArtifactIds.add(input.target.relation.id)
  if (graph) {
    for (const a of graph.linkedArtifacts) candidateArtifactIds.add(a.artifactId)
  }

  if (ports.artifactReader && ports.allowArtifactMetadata) {
    for (const artifactId of [...candidateArtifactIds].slice(0, 4)) {
      const artifact = ports.artifactReader.get(artifactId)
      if (!artifact) continue
      const meta = artifact.metadata as Record<string, unknown>
      const rawSkills = Array.isArray(meta.skillsUsed)
        ? meta.skillsUsed
        : Array.isArray(meta.skills)
          ? meta.skills
          : undefined
      if (rawSkills) {
        for (const entry of rawSkills) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
          const obj = entry as Record<string, unknown>
          if (typeof obj.skillId !== 'string' || !obj.skillId) continue
          const version = typeof obj.version === 'number' && Number.isSafeInteger(obj.version) && obj.version >= 1 ? obj.version : undefined
          declaredSkills.push({
            class: 'DECLARADO',
            sourceArtifactId: artifact.artifactId,
            sourceRevision: artifact.revision,
            skillId: obj.skillId,
            ...(version !== undefined ? { version } : {}),
            ...(typeof obj.nature === 'string' ? { nature: obj.nature } : {})
          })
          if (version !== undefined && ports.academy) {
            try {
              const hist = ports.academy.history(obj.skillId, { version })
              if (!Array.isArray(hist)) {
                historicalVersions.push({
                  class: 'OBSERVADO',
                  authority: 'ACADEMY_HISTORY',
                  skillId: obj.skillId,
                  version,
                  ...(typeof hist.packageHash === 'string' ? { packageHash: hist.packageHash } : {}),
                  ...(typeof hist.origin === 'string' ? { origin: hist.origin } : {}),
                  ...(typeof hist.createdAt === 'string' ? { createdAt: hist.createdAt } : {})
                })
              }
            } catch {
              gaps.add(`ACADEMY_VERSION_UNAVAILABLE:${obj.skillId}@${version}`)
            }
          }
        }
      }
    }
  } else if (candidateArtifactIds.size > 0 && !ports.allowArtifactMetadata) {
    gaps.add('ARTIFACT_METADATA_NOT_AUTHORIZED')
  }

  return {
    supportState: 'PARTIAL_PENDING_METADATA',
    dependencyRef: 'artifact-fafc5616-794d-4e71-9c9f-238e4750f00d',
    skillEvents: [],
    declaredSkills,
    historicalVersions,
    gaps: [...gaps],
    note: 'Current Academy catalog is never treated as proof of past availability or usage; declarations are labeled DECLARADO and require typed SkillEvents to establish OBSERVADO usage.'
  }
}

async function buildModelProjection(
  ports: EvidenceProjectionPorts,
  input: InspectIntelligenceEvidenceInput,
  resolvedSession?: ResolvedSessionRef
) {
  if (resolvedSession?.sessionId && !input.target.entireSession) {
    const inspected = await callSessionPort(ports, 'inspect_agent_session', {
      sessionId: resolvedSession.sessionId,
      view: 'FOCAL'
    })
    const mi = inspected.ok && inspected.data.modelIntelligence && typeof inspected.data.modelIntelligence === 'object'
      ? (inspected.data.modelIntelligence as Record<string, unknown>)
      : undefined
    const qualifiedFacts = Array.isArray(mi?.qualifiedFacts)
      ? (mi.qualifiedFacts as Array<Record<string, unknown>>).filter(f => f && typeof f === 'object')
      : []
    const models = Array.isArray(mi?.models) ? mi.models.filter((m): m is string => typeof m === 'string') : []
    const efforts = Array.isArray(mi?.efforts) ? mi.efforts.filter((e): e is string => typeof e === 'string') : []
    const providers = Array.isArray(mi?.providers) ? mi.providers.filter((p): p is string => typeof p === 'string') : []
    const clients = Array.isArray(mi?.clients) ? mi.clients.filter((c): c is string => typeof c === 'string') : []
    const primaryUsage = mi?.primaryUsage && typeof mi.primaryUsage === 'object'
      ? (mi.primaryUsage as Record<string, unknown>)
      : undefined
    const unavailableReasons = Array.isArray(mi?.unavailableReasons)
      ? mi.unavailableReasons.filter((r): r is string => typeof r === 'string')
      : []

    const reportedCallFacts = qualifiedFacts.filter(
      f => f.scope === 'call' && (f.observability === 'reported' || f.observability === 'observed') && typeof f.model === 'string'
    )
    const reportedNonCallFacts = qualifiedFacts.filter(
      f => f.scope !== 'call' && (f.observability === 'reported' || f.observability === 'observed') && typeof f.model === 'string'
    )
    const requestedFacts = qualifiedFacts.filter(
      f => f.observability === 'requested' && (typeof f.model === 'string' || typeof f.effort === 'string')
    )
    const reportedEfforts = [...new Set(
      qualifiedFacts
        .filter(f => (f.observability === 'reported' || f.observability === 'observed') && typeof f.effort === 'string')
        .map(f => f.effort as string)
    )]
    const distinctReportedCallModels = [...new Set(reportedCallFacts.map(f => f.model as string))]

    if (mi && (qualifiedFacts.length > 0 || models.length > 0 || (primaryUsage && primaryUsage.scope !== 'unavailable'))) {
      const localGaps = new Set<string>(unavailableReasons)
      if (reportedCallFacts.length === 0) localGaps.add('PER_CALL_MODEL_INDETERMINADO')
      if (reportedCallFacts.length === 0 && reportedNonCallFacts.length === 0 && requestedFacts.length > 0) {
        localGaps.add('EFFECTIVE_MODEL_INDETERMINADO')
      }
      if (reportedEfforts.length === 0) {
        localGaps.add(efforts.length > 0 ? 'EFFORT_REQUESTED_ONLY_UNOBSERVED' : 'EFFORT_UNAVAILABLE')
      }
      if (!primaryUsage || primaryUsage.scope === 'unavailable') localGaps.add('TOKEN_USAGE_UNAVAILABLE')
      if (mi.coverageStatus === 'PARTIAL') localGaps.add('USAGE_COVERAGE_PARTIAL')

      const supportState = reportedCallFacts.length > 0 && reportedEfforts.length > 0 && mi.coverageStatus === 'COMPLETE'
        ? 'SUPPORTED'
        : reportedCallFacts.length > 0
          ? 'PARTIAL'
          : reportedNonCallFacts.length > 0
            ? 'SESSION_LEVEL_ONLY'
            : requestedFacts.length > 0
              ? 'PARTIAL'
              : 'PARTIAL_PENDING_METADATA'

      const primaryReportedFact = reportedCallFacts[0] ?? reportedNonCallFacts[0]
      const reportedModelsAll = [...new Set([...reportedCallFacts, ...reportedNonCallFacts].map(f => f.model as string))]

      return {
        supportState,
        dependencyRefs: ['artifact-fafc5616-794d-4e71-9c9f-238e4750f00d'],
        persistedModelIntelligence: mi,
        sessionLevelModel: primaryReportedFact
          ? {
              class: 'OBSERVADO',
              observability: String(primaryReportedFact.observability ?? 'reported').toUpperCase(),
              granularity: reportedCallFacts.length > 0 ? 'CALL_REPORTED' : 'SESSION_LEVEL',
              model: primaryReportedFact.model as string,
              models: reportedModelsAll,
              ...(reportedEfforts.length ? { efforts: reportedEfforts } : {}),
              provider: (primaryReportedFact.provider as string | undefined) ?? providers[0] ?? 'entire',
              ...(clients[0] ? { client: clients[0] } : {})
            }
          : null,
        ...(requestedFacts.length > 0
          ? {
              requestedChoices: requestedFacts.map(f => ({
                class: 'SOLICITADO',
                observability: 'REQUESTED',
                scope: f.scope,
                scopeId: f.scopeId,
                ordinal: f.ordinal,
                sourceSurface: f.sourceSurface,
                sourceVersion: f.sourceVersion,
                ...(typeof f.model === 'string' ? { model: f.model } : {}),
                ...(typeof f.effort === 'string' ? { effort: f.effort } : {})
              }))
            }
          : {}),
        perCallModels: reportedCallFacts.length > 0
          ? reportedCallFacts.map(f => ({
              class: 'OBSERVADO',
              observability: String(f.observability).toUpperCase(),
              scope: f.scope,
              scopeId: f.scopeId,
              ordinal: f.ordinal,
              sourceSurface: f.sourceSurface,
              sourceVersion: f.sourceVersion,
              model: f.model as string,
              ...(typeof f.effort === 'string' ? { effort: f.effort } : {}),
              ...(typeof f.provider === 'string' ? { provider: f.provider } : {})
            }))
          : null,
        effectivePerCallState: reportedCallFacts.length > 0 ? 'REPORTED' : 'INDETERMINADO',
        modelSwitchReported: distinctReportedCallModels.length > 1,
        reportedUsage: primaryUsage && primaryUsage.scope !== 'unavailable'
          ? {
              class: 'OBSERVADO',
              dataSource: 'SESSION_STORE_PERSISTED',
              granularity: primaryUsage.scope,
              coverage: mi.coverageStatus ?? 'PARTIAL',
              billingCoverage: 'UNAVAILABLE',
              metrics: primaryUsage,
              ...(Array.isArray(mi.checkpointUsage) && mi.checkpointUsage.length ? { checkpointUsage: mi.checkpointUsage } : {}),
              ...(Array.isArray(mi.subagentUsage) && mi.subagentUsage.length ? { subagentUsage: mi.subagentUsage } : {})
            }
          : null,
        gaps: [...localGaps]
      }
    }
  }

  const gaps = new Set<string>(['PER_CALL_MODEL_UNAVAILABLE', 'EFFORT_UNAVAILABLE'])
  let entireTarget = input.target.entireSession

  if (!entireTarget) {
    const wt = resolvedSession?.worktreeId ?? resolvedSession?.nativeSession?.worktreeId
    const gen = resolvedSession?.generation ?? resolvedSession?.nativeSession?.generation
    if (wt && gen) {
      const discover = await callSessionPort(ports, 'discover_entire_sessions', { worktreeId: wt, generation: gen, limit: 5 })
      if (discover.ok && Array.isArray(discover.data.sessions)) {
        const list = discover.data.sessions as Array<Record<string, unknown>>
        if (list.length === 1 && typeof list[0]?.providerSessionId === 'string') {
          entireTarget = { providerSessionId: list[0].providerSessionId, worktreeId: wt, generation: gen }
        } else if (list.length > 1) {
          gaps.add('MULTIPLE_ENTIRE_LIVE_SESSIONS_IN_WORKTREE')
        }
      } else if (!discover.ok && typeof discover.data.code === 'string') {
        gaps.add(discover.data.code)
      }
    }
  }

  if (!entireTarget) {
    gaps.add('ENTIRE_LIVE_SESSION_NOT_LINKED_OR_UNAVAILABLE')
    return {
      supportState: 'PARTIAL_PENDING_METADATA',
      dependencyRefs: [
        'artifact-fafc5616-794d-4e71-9c9f-238e4750f00d',
        'artifact-12983e4a-29fd-4f76-9f64-73fc0ea14518'
      ],
      sessionLevelModel: null,
      perCallModels: null,
      reportedUsage: null,
      gaps: [...gaps]
    }
  }

  const liveInspect = await callSessionPort(ports, 'inspect_entire_session', entireTarget)
  if (!liveInspect.ok) {
    const code = typeof liveInspect.data.code === 'string' ? liveInspect.data.code : 'PROVIDER_UNAVAILABLE'
    gaps.add(code)
    return {
      supportState: 'PARTIAL_PENDING_METADATA',
      dependencyRefs: ['artifact-fafc5616-794d-4e71-9c9f-238e4750f00d'],
      sessionLevelModel: null,
      perCallModels: null,
      reportedUsage: null,
      gaps: [...gaps]
    }
  }

  const model = typeof liveInspect.data.model === 'string' ? liveInspect.data.model : null
  if (!model) gaps.add('SESSION_MODEL_NOT_REPORTED')

  let reportedUsage: Record<string, unknown> | null = null
  if (input.includeEntireUsage) {
    const usageRes = await callSessionPort(ports, 'get_entire_session_usage', entireTarget)
    if (usageRes.ok) {
      reportedUsage = {
        class: 'OBSERVADO',
        dataSource: usageRes.data.dataSource ?? 'ENTIRE_REPORTED',
        granularity: 'AGGREGATE_SESSION',
        coverage: usageRes.data.coverage ?? 'PARTIAL',
        billingCoverage: usageRes.data.billingCoverage ?? 'UNAVAILABLE',
        ...(usageRes.data.metrics ? { metrics: usageRes.data.metrics } : {}),
        ...(usageRes.data.signals ? { signals: usageRes.data.signals } : {})
      }
    } else {
      gaps.add(typeof usageRes.data.code === 'string' ? usageRes.data.code : 'TOKEN_USAGE_UNAVAILABLE')
    }
  }

  return {
    supportState: model ? 'SESSION_LEVEL_ONLY' : 'PARTIAL_PENDING_METADATA',
    dependencyRefs: ['artifact-fafc5616-794d-4e71-9c9f-238e4750f00d'],
    entireSession: entireTarget,
    sessionLevelModel: model
      ? {
          class: 'OBSERVADO',
          granularity: 'SESSION_LEVEL',
          model,
          provider: 'entire',
          caveat: 'Session-level model does not prove per-call model, absence of fallback/switch, or effective vs declared identity.'
        }
      : null,
    perCallModels: null,
    ...(input.includeEntireUsage
      ? { reportedUsage }
      : {
          usageAcquisition: {
            optedIn: false,
            available: true,
            tool: 'get_entire_session_usage',
            note: 'Pass includeEntireUsage: true to read aggregate ENTIRE_REPORTED usage for this target.'
          }
        }),
    gaps: [...gaps]
  }
}

export async function inspectIntelligenceEvidence(
  rawInput: unknown,
  ports: EvidenceProjectionPorts
): Promise<Record<string, unknown>> {
  const parsed = inspectIntelligenceEvidenceSchema.safeParse(rawInput ?? {})
  if (!parsed.success) {
    throw new ProjectionError('INVALID_ARGUMENT', { message: 'Invalid Intelligence evidence inspection arguments.' })
  }
  const input = parsed.data

  if (input.expectedCatalogVersion !== undefined && input.expectedCatalogVersion !== EVIDENCE_EVALUATION_CATALOG_VERSION) {
    throw new ProjectionError('CATALOG_VERSION_CONFLICT', {
      expectedCatalogVersion: input.expectedCatalogVersion,
      currentCatalogVersion: EVIDENCE_EVALUATION_CATALOG_VERSION
    })
  }

  const contract = getEvidenceEvaluationContractById(input.questionId)
  if (!contract) {
    throw new ProjectionError('CONTRACT_NOT_FOUND', { questionId: input.questionId })
  }
  if (!SUPPORTED_SET.has(input.questionId)) {
    throw new ProjectionError('PROJECTION_UNSUPPORTED', {
      questionId: input.questionId,
      supportedQuestionIds: SUPPORTED_PROJECTION_QUESTION_IDS,
      guidance: 'Retrieve contract criteria via get_evidence_evaluation_contract and query the underlying channels directly.'
    })
  }

  if (input.repositoryId !== undefined) {
    try {
      assertValidSessionRepositoryId(input.repositoryId)
    } catch {
      throw new ProjectionError('INVALID_ARGUMENT', { message: 'Invalid repositoryId.' })
    }
    if (!ports.repositoryId || input.repositoryId !== ports.repositoryId) {
      throw new ProjectionError('REPOSITORY_NOT_AUTHORIZED', { requestedRepositoryId: input.repositoryId })
    }
  }

  const { mode } = validateTarget(input)

  if (mode === 'NATIVE' && input.target.sourceSessionId) {
    ports.assertSourceAuthorized(input.target.nativeSession?.worktreeId)
  }

  const scopeDigest = digestHex({
    repositoryId: ports.repositoryId,
    questionId: input.questionId,
    target: input.target,
    limit: input.limit,
    includeEntireUsage: input.includeEntireUsage
  })

  // Resolve relation if relation target was provided
  let graphSummary: GraphSummary | undefined
  let resolvedSession: ResolvedSessionRef | undefined

  if (mode === 'RELATION') {
    const resolved = await resolveRelationTarget(ports, input.target.relation!)
    graphSummary = resolved.graph

    // Academy Q20/Q21 or Model Q26 on a relation can still report relation-level findings even when session resolution is unresolved/ambiguous,
    // except if relation resolution is ambiguous we must surface candidates without picking one.
    if (resolved.status !== 'RESOLVED' && !['Q20', 'Q21'].includes(input.questionId)) {
      const stateRevision = parseInt(digestHex(graphSummary.revision).slice(0, 12), 16) || 1
      if (input.expectedRevision !== undefined && input.expectedRevision !== stateRevision) {
        throw new ProjectionError('REVISION_CONFLICT', { expectedRevision: input.expectedRevision, currentRevision: stateRevision })
      }
      if (input.cursor) {
        decodeCursor(input.cursor, scopeDigest, stateRevision)
      }
      return {
        catalogVersion: EVIDENCE_EVALUATION_CATALOG_VERSION,
        questionId: input.questionId,
        revision: stateRevision,
        scope: {
          repositoryId: ports.repositoryId,
          target: input.target
        },
        resolution: resolved.status,
        candidates: resolved.candidates,
        coverage: {
          graph: resolved.graph.coverage,
          sourceCoverage: resolved.graph.sourceCoverage
        },
        gaps: resolved.gaps,
        ...(resolved.status === 'AMBIGUOUS'
          ? { nextAcquisition: 'Reinvoke inspect_intelligence_evidence with one selected session target from candidates.' }
          : { nextAcquisition: 'Verify capture/provenance or run explicit refresh_agent_sessions if authorized.' })
      }
    }
    resolvedSession = resolved.session
  } else if (mode === 'SESSION') {
    resolvedSession = { kind: 'IMPORTED', sessionId: input.target.sessionId }
  } else if (mode === 'NATIVE') {
    resolvedSession = {
      kind: 'NATIVE',
      nativeSession: input.target.nativeSession,
      sourceSessionId: input.target.sourceSessionId,
      worktreeId: input.target.nativeSession?.worktreeId,
      generation: input.target.nativeSession?.generation
    }
  }

  if (mode === 'RELATION' && resolvedSession?.kind === 'NATIVE' && !resolvedSession.sourceSessionId && resolvedSession.worktreeId && resolvedSession.generation && ports.allowArtifactMetadata) {
    try {
      ports.assertSourceAuthorized(resolvedSession.worktreeId)
      const agent = resolvedSession.nativeSession?.provider === 'codex-native' ? 'codex' : 'antigravity'
      const grantedList = await callSessionPort(ports, 'list_agent_sessions', {
        worktreeId: resolvedSession.worktreeId,
        generation: resolvedSession.generation,
        agent,
        view: 'FOCAL',
        limit: 10
      })
      if (grantedList.ok && Array.isArray(grantedList.data.sessions)) {
        const match = (grantedList.data.sessions as Array<Record<string, unknown>>).find(
          s => s.provider === resolvedSession!.nativeSession?.provider &&
            s.providerSessionId === resolvedSession!.nativeSession?.id &&
            typeof s.sourceSessionId === 'string'
        )
        if (match && typeof match.sourceSessionId === 'string') {
          resolvedSession = { ...resolvedSession, sourceSessionId: match.sourceSessionId }
        }
      }
    } catch {}
  }

  if (resolvedSession?.sourceSessionId) {
    try {
      ports.assertSourceAuthorized(resolvedSession.worktreeId)
    } catch {
      resolvedSession = { ...resolvedSession, sourceSessionId: undefined }
    }
  }

  // Q26 (Model Intelligence)
  if (input.questionId === 'Q26') {
    if (resolvedSession?.kind === 'IMPORTED' && resolvedSession.sessionId && !resolvedSession.worktreeId) {
      const inspectRes = await callSessionPort(ports, 'inspect_agent_session', { sessionId: resolvedSession.sessionId, view: 'FOCAL', limit: 1 })
      if (inspectRes.ok && Array.isArray(inspectRes.data.worktrees)) {
        const wts = inspectRes.data.worktrees as Array<{ worktreeId?: string; generation?: string }>
        if (wts.length === 1 && wts[0]?.worktreeId && wts[0]?.generation) {
          resolvedSession = { ...resolvedSession, worktreeId: wts[0].worktreeId, generation: wts[0].generation }
        }
      }
    }
    const modelProjection = await buildModelProjection(ports, input, resolvedSession)
    const entireSessionRef = 'entireSession' in modelProjection ? modelProjection.entireSession : null
    const stateRevision = parseInt(digestHex([graphSummary?.revision ?? null, entireSessionRef, modelProjection.sessionLevelModel?.model ?? null]).slice(0, 12), 16) || 1
    if (input.expectedRevision !== undefined && input.expectedRevision !== stateRevision) {
      throw new ProjectionError('REVISION_CONFLICT', { expectedRevision: input.expectedRevision, currentRevision: stateRevision })
    }
    if (input.cursor) decodeCursor(input.cursor, scopeDigest, stateRevision)
    return {
      catalogVersion: EVIDENCE_EVALUATION_CATALOG_VERSION,
      questionId: 'Q26',
      specialization: 'MODEL',
      revision: stateRevision,
      scope: { repositoryId: ports.repositoryId, target: input.target },
      coverage: {
        model: modelProjection.supportState,
        perCall: modelProjection.perCallModels ? 'SUPPORTED' : 'INDETERMINADO',
        ...(graphSummary ? { graph: graphSummary.coverage } : {})
      },
      evidence: modelProjection,
      gaps: modelProjection.gaps
    }
  }

  // Q20 / Q21 (Academy Intelligence)
  if (input.questionId === 'Q20' || input.questionId === 'Q21') {
    const academyProjection = await buildAcademyProjection(ports, input, graphSummary)
    const stateRevision = parseInt(digestHex([graphSummary?.revision ?? null, academyProjection.declaredSkills]).slice(0, 12), 16) || 1
    if (input.expectedRevision !== undefined && input.expectedRevision !== stateRevision) {
      throw new ProjectionError('REVISION_CONFLICT', { expectedRevision: input.expectedRevision, currentRevision: stateRevision })
    }
    if (input.cursor) decodeCursor(input.cursor, scopeDigest, stateRevision)
    return {
      catalogVersion: EVIDENCE_EVALUATION_CATALOG_VERSION,
      questionId: input.questionId,
      specialization: 'ACADEMY',
      revision: stateRevision,
      scope: { repositoryId: ports.repositoryId, target: input.target },
      coverage: {
        academy: academyProjection.supportState,
        skillEvents: 'UNAVAILABLE',
        ...(graphSummary ? { graph: graphSummary.coverage } : {})
      },
      evidence: academyProjection,
      gaps: academyProjection.gaps
    }
  }

  // Event-backed projections (Session Q05/Q19, Harness Q06/Q23, Context Q09/Q16)
  const window = await loadSessionWindow(ports, resolvedSession!)
  if (mode === 'NATIVE' && input.target.sourceSessionId) {
    ports.assertSourceAuthorized(input.target.nativeSession?.worktreeId)
  }

  const stateRevision = parseInt(digestHex([window.sessionRevision, graphSummary?.revision ?? null]).slice(0, 12), 16) || 1
  if (input.expectedRevision !== undefined && input.expectedRevision !== stateRevision) {
    throw new ProjectionError('REVISION_CONFLICT', { expectedRevision: input.expectedRevision, currentRevision: stateRevision })
  }

  const offset = input.cursor ? decodeCursor(input.cursor, scopeDigest, stateRevision) : 0

  if (input.questionId === 'Q05' || input.questionId === 'Q19') {
    const proofs = await fetchLinkedProofs(ports, graphSummary)
    const sessionProj = buildSessionItems(window, graphSummary, proofs)
    return paginateItems(
      sessionProj.items,
      offset,
      input.limit,
      scopeDigest,
      stateRevision,
      (slice, pagination) => ({
        catalogVersion: EVIDENCE_EVALUATION_CATALOG_VERSION,
        questionId: input.questionId,
        specialization: 'SESSION',
        revision: stateRevision,
        sessionRevision: window.sessionRevision,
        scope: {
          repositoryId: ports.repositoryId,
          target: input.target,
          source: window.sourceKind,
          provider: window.provider
        },
        coverage: {
          source: window.sourceKind,
          contentAvailability: window.contentAvailability,
          ...(window.captureCoverage ? { captureCoverage: window.captureCoverage } : {}),
          window: sessionProj.summary.windowScope,
          ...(graphSummary ? { graph: graphSummary.coverage } : {})
        },
        summary: sessionProj.summary,
        items: slice,
        pagination,
        gaps: window.gaps
      })
    )
  }

  if (input.questionId === 'Q06' || input.questionId === 'Q23') {
    const proofs = await fetchLinkedProofs(ports, graphSummary)
    const harnessProj = buildHarnessProjection(window, graphSummary, proofs)
    if (offset > 0) throw new ProjectionError('CURSOR_STALE')
    return {
      catalogVersion: EVIDENCE_EVALUATION_CATALOG_VERSION,
      questionId: input.questionId,
      specialization: 'HARNESS',
      revision: stateRevision,
      sessionRevision: window.sessionRevision,
      scope: {
        repositoryId: ports.repositoryId,
        target: input.target,
        source: window.sourceKind,
        provider: window.provider
      },
      coverage: {
        source: window.sourceKind,
        contentAvailability: window.contentAvailability,
        ...(window.captureCoverage ? { captureCoverage: window.captureCoverage } : {}),
        ...(graphSummary ? { graph: graphSummary.coverage } : {})
      },
      evidence: harnessProj,
      gaps: window.gaps
    }
  }

  // Q09 / Q16 (Context Intelligence)
  const ctxProj = buildContextProjection(window)
  const listForQuestion = input.questionId === 'Q16'
    ? [...ctxProj.provenRepetitions, ...ctxProj.repetitionCandidates]
    : ctxProj.operations

  return paginateItems(
    listForQuestion,
    offset,
    input.limit,
    scopeDigest,
    stateRevision,
    (slice, pagination) => ({
      catalogVersion: EVIDENCE_EVALUATION_CATALOG_VERSION,
      questionId: input.questionId,
      specialization: 'CONTEXT',
      revision: stateRevision,
      sessionRevision: window.sessionRevision,
      scope: {
        repositoryId: ports.repositoryId,
        target: input.target,
        source: window.sourceKind,
        provider: window.provider
      },
      coverage: {
        source: window.sourceKind,
        contentAvailability: window.contentAvailability,
        ...(window.captureCoverage ? { captureCoverage: window.captureCoverage } : {}),
        window: {
          examinedEvents: window.events.length,
          hasMoreSourceEvents: window.hasMoreSourceEvents
        }
      },
      snapshotNote: ctxProj.snapshotNote,
      ...(input.questionId === 'Q16'
        ? {
            provenRepetitionCount: ctxProj.provenRepetitions.length,
            candidateCount: ctxProj.repetitionCandidates.length,
            repetitions: slice
          }
        : {
            operations: slice
          }),
      pagination,
      gaps: [
        ...window.gaps,
        'TRUNCATION_AND_MODEL_CONSUMPTION_NOT_PROVEN_BY_INDEX_CALL'
      ]
    })
  )
}
