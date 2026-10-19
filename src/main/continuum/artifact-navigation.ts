import { createHmac } from 'node:crypto'
import type { ArtifactStore } from './artifact-store'
import type { Artifact } from './continuum-types'
import { extractBlocks, literalRange, STRUCTURE_VERSION, type StructureQuery, type SectionQuery, type StructurePage, type SectionPage } from './artifact-structure'

export function navigationQuery(input: unknown, read: false): StructureQuery
export function navigationQuery(input: unknown, read: true): SectionQuery
export function navigationQuery(input: unknown, read: boolean): StructureQuery | SectionQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_ARGUMENT')
  const q = input as Record<string, unknown>
  const allowed = read ? ['artifactId', 'sectionId', 'expectedRevision', 'includeDescendants', 'blockId', 'cursor'] : ['artifactId', 'sectionId', 'includeBlocks', 'limit', 'cursor']
  if (Object.keys(q).some(k => !allowed.includes(k))) throw new Error('INVALID_ARGUMENT')
  for (const key of ['artifactId', ...(read ? ['sectionId'] : [])]) if (typeof q[key] !== 'string' || !(q[key] as string).trim()) throw new Error('INVALID_ARGUMENT')
  for (const key of ['sectionId', 'blockId', 'cursor']) if (q[key] !== undefined && (typeof q[key] !== 'string' || !(q[key] as string).trim() || (q[key] as string).length > 4096)) throw new Error('INVALID_ARGUMENT')
  for (const key of ['includeBlocks', 'includeDescendants']) if (q[key] !== undefined && typeof q[key] !== 'boolean') throw new Error('INVALID_ARGUMENT')
  if (read && (!Number.isSafeInteger(q.expectedRevision) || Number(q.expectedRevision) < 1)) throw new Error('INVALID_ARGUMENT')
  if (!read && q.limit !== undefined && (!Number.isSafeInteger(q.limit) || Number(q.limit) < 1 || Number(q.limit) > 100)) throw new Error('INVALID_ARGUMENT')
  if (!read && q.includeBlocks === true && !q.sectionId) throw new Error('INVALID_ARGUMENT: sectionId required for blocks')
  return q as unknown as StructureQuery | SectionQuery
}

export class ArtifactNavigation {
  private readonly key: string
  constructor(private readonly store: ArtifactStore) { this.key = store.structureKey() }
  private sign(value: string) { return createHmac('sha256', this.key).update(value).digest('base64url') }
  private identity(a: Artifact) { return [this.store.repositoryId, a.artifactId, a.revision, a.contentHash, STRUCTURE_VERSION] }
  private selector(a: Artifact, type: string, index: number) { return this.sign(JSON.stringify([...this.identity(a), type, index])) }
  private cursor(scope: string, offset: number) {
    const data = Buffer.from(JSON.stringify({ scope, offset })).toString('base64url')
    return data + '.' + this.sign(data)
  }
  private resume(cursor: string | undefined, scope: string, min: number, max: number) {
    if (!cursor) return min
    try {
      const [data, signature, extra] = cursor.split('.')
      if (extra || signature !== this.sign(data)) throw new Error()
      const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'))
      if (parsed.scope !== scope || !Number.isSafeInteger(parsed.offset) || parsed.offset <= min || parsed.offset >= max) throw new Error()
      return parsed.offset as number
    } catch { throw new Error('STRUCTURE_STALE: invalid cursor or scope') }
  }
  private artifact(id: string) {
    const a = this.store.get(id)
    if (!a) throw new Error('ARTIFACT_NOT_FOUND')
    return a
  }
  inspect(input: StructureQuery): StructurePage {
    const q = navigationQuery(input, false), a = this.artifact(q.artifactId), outline = this.store.outline(a)
    const sectionIndex = q.sectionId ? outline.findIndex((_, i) => this.selector(a, 'section', i) === q.sectionId) : -1
    if (q.sectionId && sectionIndex < 0) throw new Error('STRUCTURE_STALE: invalid section selector')
    const limit = q.limit ?? 50
    const scope = JSON.stringify([...this.identity(a), 'inspect', q.sectionId ?? null, q.includeBlocks ?? false, limit])
    const entries = q.includeBlocks ? extractBlocks(a.rawMarkdown, outline[sectionIndex]).map((block, i) => ({ ...block, blockId: this.selector(a, q.sectionId!, i) }))
      : outline.map((s, i) => ({ start: s.start, end: s.end, startLine: s.startLine, endLine: s.endLine, title: s.title, level: s.level, hasChildren: s.hasChildren, sectionId: this.selector(a, 'section', i), parentSectionId: s.parent === null ? null : this.selector(a, 'section', s.parent) })).filter((_, i) => !q.sectionId || i === sectionIndex)
    const offset = this.resume(q.cursor, scope, 0, entries.length), end = Math.min(offset + limit, entries.length)
    return { artifactId: a.artifactId, revision: a.revision, contentHash: a.contentHash,
      ...(q.includeBlocks ? { blocks: entries.slice(offset, end) as StructurePage['blocks'] } : { sections: entries.slice(offset, end) as StructurePage['sections'] }),
      ...(end < entries.length ? { nextCursor: this.cursor(scope, end) } : {}) }
  }
  read(input: SectionQuery): SectionPage {
    const q = navigationQuery(input, true), a = this.artifact(q.artifactId)
    if (a.revision !== q.expectedRevision) throw new Error('REVISION_CONFLICT')
    const outline = this.store.outline(a), index = outline.findIndex((_, i) => this.selector(a, 'section', i) === q.sectionId)
    if (index < 0) throw new Error('STRUCTURE_STALE: invalid section selector')
    const section = outline[index]
    let start = section.start, end = q.includeDescendants === false ? section.ownEnd : section.end
    if (q.blockId) {
      const blocks = extractBlocks(a.rawMarkdown, section), block = blocks.find((_, i) => this.selector(a, q.sectionId, i) === q.blockId)
      if (!block) throw new Error('STRUCTURE_STALE: invalid block selector')
      start = block.start; end = block.end
    }
    const scope = JSON.stringify([...this.identity(a), 'read', q.sectionId, q.blockId ?? null, q.includeDescendants ?? true])
    const offset = this.resume(q.cursor, scope, start, end)
    let pageEnd = Math.min(offset + 12 * 1024, end)
    // Keep an astral character intact so separately UTF-8 encoded pages concatenate exactly.
    if (pageEnd < end && /[\uD800-\uDBFF]/.test(a.rawMarkdown[pageEnd - 1]) && /[\uDC00-\uDFFF]/.test(a.rawMarkdown[pageEnd])) pageEnd--
    return { artifactId: a.artifactId, sectionId: q.sectionId, ...(q.blockId ? { blockId: q.blockId } : {}), revision: a.revision, contentHash: a.contentHash,
      ...literalRange(a.rawMarkdown, offset, pageEnd), content: a.rawMarkdown.slice(offset, pageEnd),
      ...(pageEnd < end ? { nextCursor: this.cursor(scope, pageEnd) } : {}) }
  }
}
