import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import type { CodeMapElement } from '../../../shared/types'
import type { WorktreeStructureCapture, WorktreeStructureReadPort, WorktreeStructureRequest } from '../../git-operations/git-worktree-capture'
import { createDefaultExtractors } from '../extraction/default-extractors'
import type { StructureExtractionResult } from '../extraction/structure-extraction-port'
import { resolveSymbolReferences, type SymbolReferenceFile } from '../symbol-reference-resolver'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export interface ContractFile {
  path: string
  base: StructureExtractionResult | null
  current: StructureExtractionResult | null
  baseHash: string | null
  currentHash: string | null
  changed: Set<string>
  contracts: Array<{ name: string; kind: string; signature: string; previousSignature: string; line: number }>
  limitations: string[]
}
export interface ContractCapture {
  repositoryId: string
  worktreeId: string
  generation: string
  baseCommit: string | null
  fingerprint: string
  snapshot: WorktreeStructureCapture['snapshot']
  files: ContractFile[]
  bytes: number
  extractions: number
}
export interface DirectContractInterference {
  contractPath: string
  consumerPath: string
  symbol: string
  contractLine: number
  consumerLine: number
  signature: string
  previousSignature: string
  binding: 'RESOLVED_DIRECT'
}
const key = (e: CodeMapElement, elements: CodeMapElement[]): string => {
  const parent = elements.find(p => p.id === e.parentElementId)
  return (parent ? parent.kind + ':' + parent.name + '/' : '') + e.kind + ':' + e.name
}
const directExport = (e: CodeMapElement, elements: CodeMapElement[]) => elements.some(p => p.id === e.parentElementId && p.kind === 'export' && p.parentElementId === null && p.name === e.name)
const publicSignature = (e: CodeMapElement, elements: CodeMapElement[], declarations: StructureExtractionResult['contractDeclarations']) => {
  const declaration = (element: CodeMapElement) => declarations?.find(d => d.elementId === element.id)?.declaration ?? element.declarationSignature ?? ''
  const members = ['interface', 'class'].includes(e.kind) ? elements.filter(p => p.parentElementId === e.id && p.visibility !== 'private' && p.visibility !== 'protected')
    .map(p => `${p.kind}:${p.name}:${declaration(p)}`).sort().join(';') : ''
  return declaration(e) + (members ? ` {${members}}` : '')
}
const changedScope = (file: ContractFile, id: string) => {
  let element = file.current?.elements.find(e => e.id === id)
  const visited = new Set<string>()
  while (element && !visited.has(element.id)) {
    visited.add(element.id)
    if (['function', 'method', 'constructor', 'property', 'variable', 'constant'].includes(element.kind)) return file.changed.has(element.id)
    element = file.current?.elements.find(e => e.id === element!.parentElementId)
  }
  return file.changed.has(id)
}

export class WorktreeContractNavigation {
  private readonly extractors = createDefaultExtractors()
  constructor(private readonly git: WorktreeStructureReadPort) {}

  inspect(request: WorktreeStructureRequest): Promise<ContractCapture> {
    return this.git.captureWorktreeStructure(request, async capture => {
      let bytes = 0, extractions = 0
      const files: ContractFile[] = capture.files.map(file => {
        const limitations: string[] = []
        const extractor = this.extractors.find(e => e.supports(extname(file.path)))
        const extract = (text: typeof file.current, relativePath: string) => {
          if (!text) return null
          bytes += text.bytes
          if (!extractor || !/\.[cm]?[jt]sx?$/.test(relativePath)) { limitations.push('STRUCTURE_UNSUPPORTED'); return null }
          try {
            extractions++
            const result = extractor.extract({ repositoryId: capture.repositoryId, relativePath, extension: extname(relativePath), content: text.content, includeContractDeclarations: true })
            limitations.push(...(result.diagnostics ?? []))
            return result
          } catch { limitations.push('EXTRACTION_FAILED'); return null }
        }
        const base = extract(file.base, file.previousPath ?? file.path), current = extract(file.current, file.path)
        if (file.previousPath || file.renamedTo || file.committedStatus?.startsWith('R')) limitations.push('RENAME_REQUIRES_REFINED_SCOPE')
        if (file.change?.conflicted) limitations.push('CONFLICTED_CONTENT')
        const changed = new Set<string>(), contracts: ContractFile['contracts'] = []
        if (base && current && !limitations.length) {
          const signature = (e: CodeMapElement, result: StructureExtractionResult) => publicSignature(e, result.elements, result.contractDeclarations)
          for (const e of current.elements) {
            const prior = base.elements.filter(p => key(p, base.elements) === key(e, current.elements))
            const matches = current.elements.filter(p => key(p, current.elements) === key(e, current.elements))
            if (prior.length !== 1 || matches.length !== 1) { if (prior.length > 1 || matches.length > 1) limitations.push('AMBIGUOUS_SYMBOL'); continue }
            const old = prior[0]
            const implementation = (element: CodeMapElement, text: string, result: StructureExtractionResult) => result.contractDeclarations?.find(d => d.elementId === element.id)?.implementationHash ?? digest(Buffer.from(text).subarray(element.location.start.byte, element.location.end.byte).toString())
            if (signature(old, base) !== signature(e, current) || implementation(old, file.base!.content, base) !== implementation(e, file.current!.content, current)) changed.add(e.id)
            if (directExport(e, current.elements) && directExport(old, base.elements) && ['function', 'interface', 'typeAlias', 'class'].includes(e.kind) && signature(old, base) && signature(e, current) && signature(old, base) !== signature(e, current))
              contracts.push({ name: e.name, kind: e.kind, signature: signature(e, current), previousSignature: signature(old, base), line: e.location.start.line })
          }
        }
        return { path: file.path, base, current, baseHash: file.base?.hash ?? null, currentHash: file.current?.hash ?? null, changed, contracts, limitations: [...new Set(limitations)] }
      })
      return { repositoryId: capture.repositoryId, worktreeId: capture.worktreeId, generation: capture.generation, baseCommit: capture.baseCommit,
        fingerprint: capture.fingerprint, snapshot: capture.snapshot, files, bytes, extractions }
    })
  }

  confirm(provider: ContractCapture, consumer: ContractCapture): DirectContractInterference[] {
    if (provider.repositoryId !== consumer.repositoryId || !provider.baseCommit || provider.baseCommit !== consumer.baseCommit) throw new Error('STRUCTURE_BASE_MISMATCH')
    const reliable = consumer.files.filter(f => f.current && !f.limitations.length)
    const files: SymbolReferenceFile[] = reliable.map(f => ({ ...f.current!, fileId: f.path, relativePath: f.path,
      importBindings: f.current!.importBindings.filter(b => b.sourceModule.startsWith('./') || b.sourceModule.startsWith('../')) }))
    const resolved = resolveSymbolReferences('', files)
    const result: DirectContractInterference[] = []
    for (const file of provider.files.filter(f => !f.limitations.length)) for (const contract of file.contracts) {
      const target = reliable.find(f => f.path === file.path)
      const exports = target?.current?.elements.filter(e => e.name === contract.name && e.kind === contract.kind && directExport(e, target.current!.elements)) ?? []
      if (exports.length !== 1 || publicSignature(exports[0], target!.current!.elements, target!.current!.contractDeclarations) !== contract.previousSignature) continue
      for (const reference of resolved.filter(r => r.targetElementId === exports[0].id && r.sourceFileId !== file.path)) {
        const source = reliable.find(f => f.path === reference.sourceFileId)
        if (!source || !reference.sourceElementId || !changedScope(source, reference.sourceElementId)) continue
        result.push({ contractPath: file.path, consumerPath: source.path, symbol: contract.name, contractLine: contract.line,
          consumerLine: reference.location.start.line, signature: contract.signature, previousSignature: contract.previousSignature, binding: 'RESOLVED_DIRECT' })
      }
    }
    return result
  }
}
