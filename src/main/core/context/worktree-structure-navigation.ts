import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import type { CodeMapElement } from '../../../shared/types'
import type { CapturedText, WorktreeStructureCapture, WorktreeStructureReadPort, WorktreeStructureRequest } from '../../git-operations/git-worktree-capture'
import { GitOperationsError } from '../../git-operations/git-operations-service'
import { createDefaultExtractors } from '../extraction/default-extractors'
import { extractTextDocument } from '../extraction/text-document-extractor'
import type { StructureExtractionResult } from '../extraction/structure-extraction-port'

export interface StructuralReferencePort {
  inspectStructuralReference(repoPath: string, relativePath: string, hash: string): 'MATCH' | 'INCOMPATIBLE' | 'UNAVAILABLE'
  getStructuralImporterCandidates?(repoPath: string, relativePath: string, hash: string, selectedHashes: Map<string, string>): { paths: string[]; truncated: boolean }
}
interface ElementFact {
  key: string
  kind: string
  name: string
  signature: string
  implementation: string
  line: number
  endLine: number
}
interface Extraction {
  coverage: string
  limitations: string[]
  elements: ElementFact[]
  relations: Array<{ key: string; kind: string; source?: string; target: string; resolution: 'RESOLVED_LOCAL' | 'MODULE_DECLARATION' }>
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const compact = (value: string) => value.length > 200 ? value.slice(0, 199) + '…' : value

export class WorktreeStructureNavigation {
  private readonly extractors = createDefaultExtractors()
  constructor(private readonly git: WorktreeStructureReadPort, private readonly reference: StructuralReferencePort, private readonly repoPath: string) {}

  inspect(request: WorktreeStructureRequest) {
    return this.git.captureWorktreeStructure(request, async capture => this.project(capture, request.cursor))
  }

  private extract(repositoryId: string, path: string, text: CapturedText | null): Extraction {
    if (!text) return { coverage: 'ABSENT', limitations: [], elements: [], relations: [] }
    const extension = extname(path).toLowerCase()
    const extractor = this.extractors.find(port => port.supports(extension))
    const input = { repositoryId, relativePath: path, extension, content: text.content }
    let result: StructureExtractionResult
    let coverage = extractor ? 'STRUCTURAL' : 'TEXT_DOCUMENT'
    const limitations: string[] = []
    try { result = extractor ? extractor.extract(input) : extractTextDocument(input) }
    catch { result = extractTextDocument(input); coverage = 'TEXT_DOCUMENT'; limitations.push('EXTRACTION_FAILED') }
    if (result.elements.length && result.elements.every(e => e.kind === 'document')) coverage = 'TEXT_DOCUMENT'
    if (coverage === 'TEXT_DOCUMENT') limitations.push('STRUCTURE_UNAVAILABLE')
    limitations.push(...(result.diagnostics ?? []))
    if (result.diagnostics?.includes('PARSE_INCOMPLETE')) coverage = 'PARTIAL_STRUCTURE'
    const byId = new Map(result.elements.map(e => [e.id, e]))
    const keys = new Map<string, string>()
    const keyOf = (element: CodeMapElement, seen = new Set<string>()): string => {
      if (seen.has(element.id)) return 'AMBIGUOUS_ANCESTRY'
      seen.add(element.id)
      const parent = element.parentElementId ? byId.get(element.parentElementId) : undefined
      return (parent ? keyOf(parent, seen) + '/' : '') + element.kind + ':' + element.name
    }
    const bytes = Buffer.from(text.content, 'utf8')
    const elements = result.elements.map(element => {
      const key = keyOf(element); keys.set(element.id, key)
      return { key, kind: element.kind, name: compact(element.name), signature: element.declarationSignature ?? '',
        implementation: hash(bytes.subarray(element.location.start.byte, element.location.end.byte).toString('utf8').trim()),
        line: element.location.start.line, endLine: element.location.end.line }
    })
    const relations: Extraction['relations'] = result.importBindings.map(binding => {
      const target = `${binding.sourceModule}:${binding.importedName} as ${binding.localName}`
      return { key: 'imports:' + target, kind: 'imports', target: compact(target), resolution: 'MODULE_DECLARATION' }
    })
    const keyCounts = new Map<string, number>()
    for (const key of keys.values()) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1)
    for (const relationship of result.relationships) {
      if (relationship.type === 'contains') continue
      const source = keys.get(relationship.sourceId)
      const target = keys.get(relationship.targetId)
      if (source && target && keyCounts.get(source) === 1 && keyCounts.get(target) === 1) relations.push({ key: `${relationship.type}:${source}:${target}`, kind: relationship.type, source: compact(source), target: compact(target), resolution: 'RESOLVED_LOCAL' })
      else limitations.push('RELATION_TARGET_UNVERIFIED')
    }
    if (result.symbolReferences.length) limitations.push('SYMBOL_USAGE_RESOLUTION_NOT_COMPLETE')
    return { coverage, limitations: [...new Set(limitations)], elements, relations }
  }

  private project(capture: WorktreeStructureCapture, cursor?: string) {
    const entries: Array<Record<string, unknown>> = []
    const currentHashes = new Map(capture.files.filter(f => f.current).map(f => [f.path, f.current!.hash]))
    const baseHashes = new Map(capture.files.filter(f => f.base).map(f => [f.previousPath ?? f.path, f.base!.hash]))
    const files = capture.files.map(file => {
      const before = this.extract(capture.repositoryId, file.previousPath ?? file.path, file.base)
      const after = this.extract(capture.repositoryId, file.path, file.current)
      const limitations = [...new Set([...before.limitations, ...after.limitations])]
      if (!file.base && !file.current) limitations.push('PATH_ABSENT')
      if (file.change?.conflicted) limitations.push('CONFLICTED_CONTENT')
      if (file.change?.renamed && !file.previousPath) limitations.push('RENAME_UNVERIFIED')
      if (file.previousPath) limitations.push('GIT_RENAME_MATCH_ONLY')
      if (file.committedStatus === 'A') limitations.push('ADDED_OR_RENAME_FROM_OUTSIDE_SELECTION')
      if (file.base && !file.current && !file.renamedTo) limitations.push('REMOVED_OR_RENAME_TO_OUTSIDE_SELECTION')
      const group = (elements: ElementFact[]) => {
        const groups = new Map<string, ElementFact[]>()
        for (const element of elements) {
          const matches = groups.get(element.key) ?? []
          matches.push(element); groups.set(element.key, matches)
        }
        return groups
      }
      const old = group(file.renamedTo ? [] : before.elements); const current = group(after.elements)
      if (capture.baseCommit && (!file.renamedTo || file.current)) for (const key of new Set([...old.keys(), ...current.keys()])) {
        const a = old.get(key) ?? []; const b = current.get(key) ?? []
        if (a.length > 1 || b.length > 1) {
          limitations.push('AMBIGUOUS_ELEMENT_MATCH')
          entries.push({ path: file.path, element: compact(key), change: 'UNCERTAIN', reason: 'HOMONYMS', baseCount: a.length, currentCount: b.length })
          continue
        }
        const left = a[0]; const right = b[0]; const element = right ?? left
        if (left && right && left.signature === right.signature && left.implementation === right.implementation) continue
        entries.push({ path: file.path, kind: element.kind, name: element.name, ancestry: compact(key),
          change: !left ? 'ADDED' : !right ? 'REMOVED' : left.signature !== right.signature ? 'SIGNATURE' : 'IMPLEMENTATION',
          ...(element.signature ? { signature: compact(element.signature) } : {}),
          reference: { revision: right ? 'CURRENT' : 'BASE', path: right ? file.path : file.previousPath ?? file.path, line: element.line, endLine: element.endLine, hash: right ? file.current!.hash : file.base!.hash } })
      }
      const oldRelations = new Map((file.renamedTo ? [] : before.relations).map(r => [r.key, r])); const newRelations = new Map(after.relations.map(r => [r.key, r]))
      if (capture.baseCommit && (!file.renamedTo || file.current)) for (const key of new Set([...oldRelations.keys(), ...newRelations.keys()])) {
        if (oldRelations.has(key) && newRelations.has(key)) continue
        const relation = newRelations.get(key) ?? oldRelations.get(key)!
        entries.push({ path: file.path, relation: { kind: relation.kind, source: relation.source, target: relation.target, resolution: relation.resolution }, change: newRelations.has(key) ? 'ADDED' : 'REMOVED' })
      }
      return { path: file.path, previousPath: file.previousPath, renamedTo: file.renamedTo, committedStatus: file.committedStatus, dirty: file.change ?? null,
        baseHash: file.base?.hash ?? null, currentHash: file.current?.hash ?? null,
        coverage: { base: before.coverage, current: after.coverage },
        importerCandidates: {
          base: file.base ? this.reference.getStructuralImporterCandidates?.(this.repoPath, file.previousPath ?? file.path, file.base.hash, baseHashes) ?? { paths: [], truncated: false } : { paths: [], truncated: false },
          current: file.current ? this.reference.getStructuralImporterCandidates?.(this.repoPath, file.path, file.current.hash, currentHashes) ?? { paths: [], truncated: false } : { paths: [], truncated: false }
        },
        canonicalReference: { base: file.base ? this.reference.inspectStructuralReference(this.repoPath, file.previousPath ?? file.path, file.base.hash) : 'UNAVAILABLE', current: file.current ? this.reference.inspectStructuralReference(this.repoPath, file.path, file.current.hash) : 'UNAVAILABLE' },
        limitations: [...new Set(limitations)] }
    })
    const revision = hash(JSON.stringify([capture.fingerprint, files, entries]))
    let offset = 0
    if (cursor) {
      const match = /^([a-f0-9]{64}):(\d+)$/.exec(cursor)
      if (!match) throw new GitOperationsError('INVALID_ARGUMENT')
      if (match[1] !== revision) throw new GitOperationsError('GIT_STATE_CHANGED')
      offset = Number(match[2])
      if (!Number.isSafeInteger(offset) || offset > entries.length) throw new GitOperationsError('INVALID_ARGUMENT')
    }
    const envelope = { repositoryId: capture.repositoryId, worktreeId: capture.worktreeId, generation: capture.generation, fingerprint: capture.fingerprint, revision,
      canonicalHead: capture.canonicalHead, baseCommit: capture.baseCommit, baseSelection: capture.baseSelection, head: capture.snapshot.head,
      indexRevision: capture.snapshot.indexRevision, worktreeRevision: capture.snapshot.worktreeRevision,
      state: { ...capture.state, operation: capture.snapshot.operation },
      comparison: capture.baseCommit ? 'AVAILABLE' : 'UNAVAILABLE', files,
      confidence: ['EXECUTION_AUTHORSHIP_UNPROVEN', 'DIRECT_RELATIONS_ONLY', 'DEPENDENTS_OUTSIDE_SELECTED_PATHS_UNVERIFIED', 'EPHEMERAL_EXTRACTION'],
      recovery: capture.baseCommit ? 'Use read_worktree_file or get_worktree_diff for selected details.' : 'Provide an exact baseCommit from this repository after creating a comparable commit.',
      totalEntries: entries.length, limits: { paths: 10, fileBytes: 1048576, inputBytes: 4194304, outputBytes: 24000 } }
    const page: typeof entries = []
    let end = offset
    while (end < entries.length) {
      const candidate = [...page, entries[end]]
      if (Buffer.byteLength(JSON.stringify({ ...envelope, entries: candidate, nextCursor: `${revision}:${end + 1}` })) > 24000) break
      page.push(entries[end++])
    }
    const result = { ...envelope, entries: page, truncated: end < entries.length, nextCursor: end < entries.length ? `${revision}:${end}` : null }
    if (Buffer.byteLength(JSON.stringify(result)) > 24000 || end === offset && end < entries.length) throw new GitOperationsError('WORKTREE_STRUCTURE_OUTPUT_LIMIT')
    return result
  }
}
