import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { safeFile, sanitize, utf8Prefix } from './privacy'
import { sourceTimestamp } from './source-time'
import type { LiveSessionTarget } from './target'

const selection = { worktreeId: z.string().regex(/^[a-f0-9]{64}$/), generation: z.string().regex(/^[a-f0-9]{64}$/) }
const providerSessionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
export const LIVE_SESSION_SCHEMAS = {
  discover_entire_sessions: z.object({ worktreeId: selection.worktreeId.optional(), generation: selection.generation.optional(),
    state: z.enum(['ACTIVE', 'ENDED', 'UNKNOWN']).optional(), after: z.string().datetime({ offset: true }).optional(),
    before: z.string().datetime({ offset: true }).optional(), limit: z.number().int().min(1).max(20).default(20) }).strict()
    .refine(q => !!q.worktreeId === !!q.generation),
  inspect_entire_session: z.object({ ...selection, providerSessionId, includeFiles: z.boolean().default(false), fileLimit: z.number().int().min(1).max(20).default(10) }).strict(),
  get_entire_session_usage: z.object({ ...selection, providerSessionId }).strict()
}
export type LiveSessionToolName = keyof typeof LIVE_SESSION_SCHEMAS
export type LiveSessionQuery = z.infer<(typeof LIVE_SESSION_SCHEMAS)[LiveSessionToolName]>
export const isLiveSessionTool = (name: string): name is LiveSessionToolName => Object.hasOwn(LIVE_SESSION_SCHEMAS, name)
export const parseLiveSessionQuery = (name: LiveSessionToolName, args: unknown) => LIVE_SESSION_SCHEMAS[name].parse(args ?? {})

type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
  return value as RecordValue
}
function label(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 200 || /[\\/]/.test(value) && /(?:^[A-Za-z]:|^\/)/.test(value)) return undefined
  return utf8Prefix(sanitize(value), 160)
}
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
function metadata(value: RecordValue) {
  return { providerSessionId: providerSessionId.parse(value.session_id), agent: label(value.agent), model: label(value.model),
    state: value.status === 'active' || value.status === 'ACTIVE' ? 'ACTIVE' : value.status === 'ended' || value.status === 'ENDED' ? 'ENDED' : 'UNKNOWN',
    branch: label(value.branch), startedAt: sourceTimestamp(value.started_at), endedAt: sourceTimestamp(value.ended_at), lastActive: sourceTimestamp(value.last_active) }
}
async function targetFor(value: RecordValue, targets: LiveSessionTarget[]): Promise<LiveSessionTarget | undefined> {
  if (typeof value.worktree_path !== 'string' || !isAbsolute(value.worktree_path)) return undefined
  let root: string
  try { root = await realpath(value.worktree_path) } catch { return undefined }
  return targets.find(target => target.root === root)
}
export async function projectLiveSessions(name: LiveSessionToolName, raw: unknown, q: LiveSessionQuery, targets: LiveSessionTarget[], assertActive: () => void): Promise<object> {
  const base = { source: 'ENTIRE_LIVE', transcriptImported: false, associationCoverage: 'UNAVAILABLE' }
  if (name === 'discover_entire_sessions') {
    if (!Array.isArray(raw)) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
    const query = q as z.infer<typeof LIVE_SESSION_SCHEMAS.discover_entire_sessions>
    const sessions: object[] = []
    let omitted = 0, matched = 0
    for (const entry of raw.slice(0, 500)) {
      assertActive()
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { omitted++; continue }
      const value = record(entry)
      if (!providerSessionId.safeParse(value.session_id).success || !label(value.agent)) { omitted++; continue }
      const target = await targetFor(value, targets)
      assertActive()
      if (!target) { omitted++; continue }
      if (query.worktreeId && (target.worktreeId !== query.worktreeId || target.generation !== query.generation)) continue
      const projected = metadata(value)
      if (query.state && projected.state !== query.state) continue
      if (query.after && (!projected.startedAt || Date.parse(projected.startedAt) < Date.parse(query.after))) continue
      if (query.before && (!projected.startedAt || Date.parse(projected.startedAt) > Date.parse(query.before))) continue
      matched++
      if (sessions.length < query.limit) sessions.push({ ...projected, worktreeId: target.worktreeId, generation: target.generation })
    }
    const limited = raw.length > 500 || matched > sessions.length
    return { ...base, sessions, coverage: limited || omitted ? 'PARTIAL' : 'COMPLETE', matched, omitted,
      ...(limited ? { limitReason: 'SESSION_LIMIT', complete: false } : {}), ...(omitted ? { omissionReason: 'SOURCE_UNAVAILABLE_OR_OUT_OF_SCOPE' } : {}) }
  }
  const value = record(raw)
  const query = q as z.infer<typeof LIVE_SESSION_SCHEMAS.inspect_entire_session>
  const target = targets.find(t => t.worktreeId === query.worktreeId && t.generation === query.generation)
  if (!target || value.session_id !== query.providerSessionId || await targetFor(value, targets) !== target) throw new Error('SOURCE_IDENTITY_CONFLICT')
  assertActive()
  const { branch: _branch, ...selectedMetadata } = metadata(value)
  const detail = { source: 'ENTIRE_LIVE', ...selectedMetadata, associationCoverage: 'UNAVAILABLE', checkpointCoverage: 'UNAVAILABLE' }
  if (name === 'inspect_entire_session') {
    const files = Array.isArray(value.files_touched) ? value.files_touched : undefined
    const projectedFiles = query.includeFiles && files ? files.map(file => typeof file === 'string' ? safeFile(file) : null).filter((file): file is string => file !== null) : undefined
    return { ...detail, coverage: count(value.turns) === undefined || count(value.pending_turns) === undefined ? 'PARTIAL' : 'COMPLETE', turns: count(value.turns), pendingTurns: count(value.pending_turns),
      ...(query.includeFiles ? { files: projectedFiles?.slice(0, query.fileLimit), fileCount: files?.length,
        filesCoverage: !files ? 'UNAVAILABLE' : projectedFiles!.length !== files.length || files.length > query.fileLimit ? 'PARTIAL' : 'COMPLETE' } : {}) }
  }
  throw new Error('INVALID_ARGUMENT')
}

export function projectLiveUsage(raw: unknown, providerId: string): object {
  const value = record(raw)
  if (value.session_id !== providerId) throw new Error('SOURCE_IDENTITY_CONFLICT')
  const tokens = value.tokens === undefined ? undefined : record(value.tokens)
  const metrics = tokens ? { input: count(tokens.input), output: count(tokens.output), cacheRead: count(tokens.cache_read), cacheWrite: count(tokens.cache_write), total: count(tokens.total), apiCalls: count(tokens.api_calls) } : undefined
  const complete = metrics && Object.values(metrics).every(v => v !== undefined)
  const signals: object[] = []
  if (metrics?.total && metrics.cacheRead !== undefined && metrics.input !== undefined && metrics.cacheRead + metrics.input <= metrics.total) {
    const ratio = (metrics.cacheRead + metrics.input) / metrics.total
    if (ratio >= 0.9) signals.push({ code: 'HIGH_CONTEXT_INPUT_SHARE', classification: 'HEURISTIC', ratio, threshold: 0.9 })
  }
  return { dataSource: 'ENTIRE_REPORTED', coverage: complete ? 'COMPLETE' : tokens ? 'PARTIAL' : 'UNAVAILABLE',
    ...(!tokens ? { code: 'TOKEN_USAGE_UNAVAILABLE' } : {}), metrics, signals, billingCoverage: 'UNAVAILABLE' }
}
