import type { CodeMapElement, CodeMapFile, CodeMapRelationship } from '../../../shared/types'

export function projectFileRelationships(files: CodeMapFile[], elements: CodeMapElement[], relationships: CodeMapRelationship[]) {
  const fileIds = new Set(files.map((file) => file.id))
  const elementFileIds = new Map(elements.map((element) => [element.id, element.fileId]))
  const out = new Map<string, Set<string>>()
  const incoming = new Map<string, Set<string>>()
  for (const relationship of relationships) {
    if (relationship.type !== 'imports' || relationship.targetKind !== 'file') continue
    const source = relationship.sourceKind === 'file' ? relationship.sourceId : elementFileIds.get(relationship.sourceId)
    const target = relationship.targetId
    if (!source || !fileIds.has(source) || !fileIds.has(target) || source === target) continue
    if (!out.has(source)) out.set(source, new Set())
    if (!incoming.has(target)) incoming.set(target, new Set())
    out.get(source)!.add(target)
    incoming.get(target)!.add(source)
  }
  return { out, in: incoming }
}
