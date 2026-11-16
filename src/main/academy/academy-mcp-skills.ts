import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { AcademySkillDetail, AcademySkillSummary } from '../../shared/types/academy-types'
import { parseSkillFrontmatter, type SkillFrontmatter } from '../../shared/web-activation/skill-frontmatter'
import type { AcademyService } from './academy-service'

export const MCP_SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills'
export const MCP_SKILLS_PROTOCOL_REVISION = '2026-07-28'
export const MAX_SKILL_RESOURCES = 512
export const MAX_SKILL_TOTAL_BYTES = 16 * 1024 * 1024
const DEFAULT_TTL_MS = 30_000
const DEFAULT_PAGE_SIZE = 100

export class McpProtocolError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
  }
}

export interface McpSkillResource {
  uri: string
  digest: string
  size: number
}

export interface McpSkillEntry {
  uri: string
  frontmatter: SkillFrontmatter
  resources: McpSkillResource[]
}

export interface McpSkillsListResult {
  resultType: 'complete'
  skills: McpSkillEntry[]
  catalogRevision: string
  nextCursor?: string
  ttlMs: number
  cacheScope: 'private'
}

export interface McpSkillGetResult {
  resultType: 'complete'
  skill: McpSkillEntry
  catalogRevision: string
  ttlMs: number
  cacheScope: 'private'
}

export interface McpResourceEntry {
  uri: string
  name: string
  description?: string
  mimeType: string
}

export interface McpResourcesListResult {
  resultType: 'complete'
  resources: McpResourceEntry[]
  nextCursor?: string
  ttlMs: number
  cacheScope: 'private'
}

export interface McpResourceReadResult {
  resultType: 'complete'
  contents: Array<{ uri: string; mimeType: string; text: string }>
  ttlMs: number
  cacheScope: 'private'
}

export interface AcademySkillSessionContext {
  projectId?: string | null
  repoRoot?: string | null
}

type ResolvedDestination =
  | { kind: 'GLOBAL_ONLY' }
  | { kind: 'NO_DESTINATION' }
  | { kind: 'DESTINATION'; destination: { id: string; path: string; enabled: boolean } }

interface ParsedSkillUri {
  scope: 'GLOBAL' | 'PROJECT'
  destinationId: string | null
  skillId: string
  skillName: string
  relativePath: string
}

interface CachedSkillBuild {
  cacheKey: string
  representable: true
  entry: McpSkillEntry
}

function normalizeFsPath(value: string): string {
  const resolved = resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function sha256AndSize(content: string): { digest: string; size: number } {
  const buf = Buffer.from(content, 'utf8')
  return {
    digest: `sha256:${createHash('sha256').update(buf).digest('hex')}`,
    size: buf.byteLength
  }
}

function hasUnsafeEncodedToken(raw: string): boolean {
  return /%(?:2e|2f|5c)/i.test(raw) || /[\u0000-\u001f\u007f\\?#\s]/.test(raw)
}

function decodeSafeSegment(segment: string): string | null {
  if (!segment) return null
  try {
    const decoded = decodeURIComponent(segment)
    if (!decoded || decoded === '.' || decoded === '..' || /[\\/\0]/.test(decoded)) {
      return null
    }
    return decoded
  } catch {
    return null
  }
}

export function parseSkillResourceUri(rawUri: unknown): ParsedSkillUri | null {
  if (typeof rawUri !== 'string' || !rawUri.startsWith('skill://')) return null
  const withoutScheme = rawUri.slice('skill://'.length)
  if (!withoutScheme || hasUnsafeEncodedToken(withoutScheme) || withoutScheme.includes('//')) return null
  const segments = withoutScheme.split('/')
  const scopeSegment = segments[0]
  if (scopeSegment === 'global') {
    if (segments.length < 4) return null
    const skillId = decodeSafeSegment(segments[1])
    const skillName = decodeSafeSegment(segments[2])
    if (!skillId || !skillName) return null
    const fileParts: string[] = []
    for (const part of segments.slice(3)) {
      const decoded = decodeSafeSegment(part)
      if (!decoded) return null
      fileParts.push(decoded)
    }
    return { scope: 'GLOBAL', destinationId: null, skillId, skillName, relativePath: fileParts.join('/') }
  }
  if (scopeSegment === 'project') {
    if (segments.length < 5) return null
    const destinationId = decodeSafeSegment(segments[1])
    const skillId = decodeSafeSegment(segments[2])
    const skillName = decodeSafeSegment(segments[3])
    if (!destinationId || !skillId || !skillName) return null
    const fileParts: string[] = []
    for (const part of segments.slice(4)) {
      const decoded = decodeSafeSegment(part)
      if (!decoded) return null
      fileParts.push(decoded)
    }
    return { scope: 'PROJECT', destinationId, skillId, skillName, relativePath: fileParts.join('/') }
  }
  return null
}

function mimeTypeForPath(relativePath: string): string {
  const lower = relativePath.toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'application/yaml'
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return 'text/typescript'
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'text/javascript'
  if (lower.endsWith('.py')) return 'text/x-python'
  if (lower.endsWith('.sh')) return 'text/x-shellscript'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html'
  if (lower.endsWith('.css')) return 'text/css'
  return 'text/plain'
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url')
}

function decodeCursor(cursor: unknown): number {
  if (cursor === undefined) return 0
  if (typeof cursor !== 'string' || !cursor) throw new McpProtocolError(-32602, 'Invalid cursor')
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset?: unknown }
    if (!parsed || typeof parsed !== 'object' || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0) {
      throw new Error('INVALID_OFFSET')
    }
    return Number(parsed.offset)
  } catch {
    throw new McpProtocolError(-32602, 'Invalid cursor')
  }
}

export class AcademyMcpSkillsProvider {
  private readonly cache = new Map<string, CachedSkillBuild>()

  constructor(
    private readonly academy: AcademyService,
    private readonly defaultContext: AcademySkillSessionContext = {},
    private readonly pageSize = DEFAULT_PAGE_SIZE
  ) {}

  private resolveDestination(context: AcademySkillSessionContext): ResolvedDestination {
    const hasProject = Boolean(context.projectId || context.repoRoot)
    if (!hasProject) return { kind: 'GLOBAL_ONLY' }
    const destinations = this.academy.store.listDestinations()
    let matched = context.projectId ? destinations.find((d) => d.id === context.projectId) : undefined
    if (!matched && context.repoRoot) {
      const targetPath = normalizeFsPath(context.repoRoot)
      matched = destinations.find((d) => normalizeFsPath(d.path) === targetPath)
    }
    if (!matched) return { kind: 'NO_DESTINATION' }
    return {
      kind: 'DESTINATION',
      destination: { id: matched.id, path: matched.path, enabled: matched.enabled }
    }
  }

  private isSummaryEligible(summary: AcademySkillSummary, resolved: ResolvedDestination): boolean {
    if (summary.status !== 'ACTIVE') return false
    if (this.academy.store.isDeleted(summary.id)) return false
    if (!this.academy.store.usesLocalAuthority() && summary.scope === 'GLOBAL' && this.academy.store.getGitAuthority()) {
      const available = this.academy.store.getGitSkillSources().some((s) => s.skillId === summary.id && s.available)
      if (!available) return false
    }
    if (summary.scope === 'GLOBAL') return true
    if (resolved.kind !== 'DESTINATION' || !resolved.destination.enabled) return false
    return summary.projectIds.includes(resolved.destination.id)
  }

  private baseSkillUri(skillId: string, name: string, scope: 'GLOBAL' | 'PROJECT', destinationId: string | null): string {
    if (scope === 'GLOBAL') {
      return `skill://global/${encodeURIComponent(skillId)}/${encodeURIComponent(name)}`
    }
    return `skill://project/${encodeURIComponent(destinationId ?? '')}/${encodeURIComponent(skillId)}/${encodeURIComponent(name)}`
  }

  private resourceUri(baseUri: string, relativePath: string): string {
    const encoded = relativePath.split('/').map((segment) => encodeURIComponent(segment)).join('/')
    return `${baseUri}/${encoded}`
  }

  private buildSkillEntry(detail: AcademySkillDetail, destinationId: string | null): McpSkillEntry {
    const scopeKey = detail.scope === 'PROJECT' ? `project:${destinationId ?? ''}` : 'global'
    const cacheKey = `${detail.id}:${detail.currentVersion}:${detail.current.packageHash}:${scopeKey}`
    const cached = this.cache.get(detail.id)
    if (cached && cached.cacheKey === cacheKey) return cached.entry

    const parsed = parseSkillFrontmatter(detail.current.package.skillMd)
    if (!parsed.ok) {
      throw new McpProtocolError(-32602, `Skill package has invalid frontmatter: ${parsed.message}`)
    }
    const baseUri = this.baseSkillUri(detail.id, parsed.frontmatter.name, detail.scope, destinationId)
    const resources: McpSkillResource[] = []
    const skillMdStats = sha256AndSize(detail.current.package.skillMd)
    resources.push({
      uri: this.resourceUri(baseUri, 'SKILL.md'),
      digest: skillMdStats.digest,
      size: skillMdStats.size
    })
    let totalBytes = skillMdStats.size
    const artifactEntries = Object.entries(detail.current.package.artifacts).sort(([a], [b]) => a.localeCompare(b))
    for (const [relPath, content] of artifactEntries) {
      if (!relPath || relPath.startsWith('/') || relPath.includes('\\') || relPath.split('/').some((seg) => !seg || seg === '.' || seg === '..')) {
        throw new McpProtocolError(-32602, `Skill package contains unsafe resource path: ${relPath}`)
      }
      const stats = sha256AndSize(content)
      totalBytes += stats.size
      resources.push({
        uri: this.resourceUri(baseUri, relPath),
        digest: stats.digest,
        size: stats.size
      })
    }
    if (resources.length > MAX_SKILL_RESOURCES) {
      throw new McpProtocolError(-32602, `Skill exceeds MCP Skills resource limit (${resources.length} > ${MAX_SKILL_RESOURCES})`)
    }
    if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
      throw new McpProtocolError(-32602, `Skill exceeds MCP Skills byte size limit (${totalBytes} > ${MAX_SKILL_TOTAL_BYTES})`)
    }

    const entry: McpSkillEntry = {
      uri: this.resourceUri(baseUri, 'SKILL.md'),
      frontmatter: parsed.frontmatter,
      resources
    }
    this.cache.set(detail.id, { cacheKey, representable: true, entry })
    return entry
  }

  private resolveEligibleDetailByUri(uri: string, context: AcademySkillSessionContext): { parsed: ParsedSkillUri; detail: AcademySkillDetail; entry: McpSkillEntry } {
    const parsed = parseSkillResourceUri(uri)
    if (!parsed) throw new McpProtocolError(-32602, 'Invalid params: malformed skill URI')
    const resolved = this.resolveDestination(context)
    let detail: AcademySkillDetail
    try {
      detail = this.academy.get(parsed.skillId)
    } catch {
      throw new McpProtocolError(-32602, 'Invalid params: unknown or unauthorized skill URI')
    }
    if (!this.isSummaryEligible(detail, resolved)) {
      throw new McpProtocolError(-32602, 'Invalid params: unknown or unauthorized skill URI')
    }
    if (detail.scope !== parsed.scope) {
      throw new McpProtocolError(-32602, 'Invalid params: skill URI scope mismatch')
    }
    const activeDestId = detail.scope === 'PROJECT' && resolved.kind === 'DESTINATION' ? resolved.destination.id : null
    if (detail.scope === 'PROJECT' && parsed.destinationId !== activeDestId) {
      throw new McpProtocolError(-32602, 'Invalid params: skill URI project mismatch')
    }
    const entry = this.buildSkillEntry(detail, activeDestId)
    if (parsed.skillName !== entry.frontmatter.name) {
      throw new McpProtocolError(-32602, 'Invalid params: stale or mismatched skill name in URI')
    }
    return { parsed, detail, entry }
  }

  private collectEligibleEntries(context: AcademySkillSessionContext): {
    resolved: ResolvedDestination
    entries: McpSkillEntry[]
    catalogRevision: string
  } {
    const resolved = this.resolveDestination(context)
    const activeDestId = resolved.kind === 'DESTINATION' ? resolved.destination.id : null
    const summaries = this.academy.list('ACTIVE').filter((summary) => this.isSummaryEligible(summary, resolved))
    const entries: McpSkillEntry[] = []
    for (const summary of summaries) {
      try {
        const detail = this.academy.get(summary.id)
        entries.push(this.buildSkillEntry(detail, detail.scope === 'PROJECT' ? activeDestId : null))
      } catch {
        continue
      }
    }
    entries.sort((a, b) => a.uri.localeCompare(b.uri))
    const scopeToken =
      resolved.kind === 'DESTINATION' ? `DESTINATION:${resolved.destination.id}:${resolved.destination.enabled}` : resolved.kind
    const hasher = createHash('sha256')
    hasher.update(`${scopeToken}\n`)
    for (const entry of entries) {
      const resourceSig = entry.resources.map((r) => `${r.uri}@${r.digest}:${r.size}`).join(',')
      hasher.update(`${entry.uri}|${resourceSig}\n`)
    }
    return {
      resolved,
      entries,
      catalogRevision: `sha256:${hasher.digest('hex')}`
    }
  }

  listSkills(params?: { cursor?: string }, context: AcademySkillSessionContext = this.defaultContext): McpSkillsListResult {
    const offset = decodeCursor(params?.cursor)
    const { entries, catalogRevision } = this.collectEligibleEntries(context)
    const slice = entries.slice(offset, offset + this.pageSize)
    const nextOffset = offset + this.pageSize
    return {
      resultType: 'complete',
      skills: slice,
      catalogRevision,
      ...(nextOffset < entries.length ? { nextCursor: encodeCursor(nextOffset) } : {}),
      ttlMs: DEFAULT_TTL_MS,
      cacheScope: 'private'
    }
  }

  getSkill(params: { uri: string }, context: AcademySkillSessionContext = this.defaultContext): McpSkillGetResult {
    const { parsed, entry } = this.resolveEligibleDetailByUri(params.uri, context)
    if (parsed.relativePath !== 'SKILL.md') {
      throw new McpProtocolError(-32602, 'Invalid params: skills/get URI must address SKILL.md')
    }
    const { catalogRevision } = this.collectEligibleEntries(context)
    return {
      resultType: 'complete',
      skill: entry,
      catalogRevision,
      ttlMs: DEFAULT_TTL_MS,
      cacheScope: 'private'
    }
  }

  readSkillResource(params: { uri: string }, context: AcademySkillSessionContext = this.defaultContext): McpResourceReadResult {
    const { parsed, detail, entry } = this.resolveEligibleDetailByUri(params.uri, context)
    const resource = entry.resources.find((item) => item.uri === params.uri)
    if (!resource) {
      throw new McpProtocolError(-32602, 'Invalid params: resource URI not listed in skill manifest')
    }
    const text = parsed.relativePath === 'SKILL.md'
      ? detail.current.package.skillMd
      : detail.current.package.artifacts[parsed.relativePath]
    if (typeof text !== 'string') {
      throw new McpProtocolError(-32602, 'Invalid params: resource content unavailable')
    }
    if (Buffer.byteLength(text, 'utf8') !== resource.size) {
      throw new McpProtocolError(-32602, 'Invalid params: resource byte length mismatch')
    }
    return {
      resultType: 'complete',
      contents: [
        {
          uri: params.uri,
          mimeType: mimeTypeForPath(parsed.relativePath),
          text
        }
      ],
      ttlMs: DEFAULT_TTL_MS,
      cacheScope: 'private'
    }
  }

  listSkillResources(params?: { cursor?: string }, context: AcademySkillSessionContext = this.defaultContext): McpResourcesListResult {
    const offset = decodeCursor(params?.cursor)
    const resolved = this.resolveDestination(context)
    const activeDestId = resolved.kind === 'DESTINATION' ? resolved.destination.id : null
    const summaries = this.academy.list('ACTIVE').filter((summary) => this.isSummaryEligible(summary, resolved))
    const allResources: McpResourceEntry[] = []
    for (const summary of summaries) {
      try {
        const detail = this.academy.get(summary.id)
        const entry = this.buildSkillEntry(detail, detail.scope === 'PROJECT' ? activeDestId : null)
        for (const res of entry.resources) {
          const parsed = parseSkillResourceUri(res.uri)
          if (!parsed) continue
          const isRoot = parsed.relativePath === 'SKILL.md'
          allResources.push({
            uri: res.uri,
            name: isRoot ? entry.frontmatter.name : parsed.relativePath,
            ...(isRoot ? { description: entry.frontmatter.description } : {}),
            mimeType: mimeTypeForPath(parsed.relativePath)
          })
        }
      } catch {
        continue
      }
    }
    allResources.sort((a, b) => a.uri.localeCompare(b.uri))
    const slice = allResources.slice(offset, offset + this.pageSize)
    const nextOffset = offset + this.pageSize
    return {
      resultType: 'complete',
      resources: slice,
      ...(nextOffset < allResources.length ? { nextCursor: encodeCursor(nextOffset) } : {}),
      ttlMs: DEFAULT_TTL_MS,
      cacheScope: 'private'
    }
  }
}
