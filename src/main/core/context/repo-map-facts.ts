import type { CodeMapElement, CodeMapFile, CodeMapRelationship } from '../../../shared/types'
import type { RepoDiscoveryLayer } from '../../../shared/types/repo-discovery-types'

export interface RepoMapSnapshot {
  projectName?: string
  files: CodeMapFile[]
  elements: CodeMapElement[]
  relationships: CodeMapRelationship[]
}

export interface RepoMapFactFile {
  contextReference: string
  path: string
  sourceTokens: number | null
  outgoingContextReferences: string[]
}

export interface RepoMapFacts {
  layer: RepoDiscoveryLayer
  projectName: string
  files: RepoMapFactFile[]
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en')
}

function endpointFileId(
  endpointId: string,
  endpointKind: 'element' | 'file',
  elementsById: ReadonlyMap<string, CodeMapElement>
): string | null {
  return endpointKind === 'file' ? endpointId : elementsById.get(endpointId)?.fileId ?? null
}

export function buildRepoMapFacts(snapshot: RepoMapSnapshot, layer: RepoDiscoveryLayer): RepoMapFacts {
  const files = [...snapshot.files].sort((left, right) => compareText(left.relativePath, right.relativePath))
  const referencesByFileId = new Map(files.map((file) => [file.id, file.contextReference ?? file.id]))
  const outgoing = new Map<string, Set<string>>()

  if (layer === 2) {
    const elementsById = new Map(snapshot.elements.map((element) => [element.id, element]))
    for (const relationship of snapshot.relationships) {
      if (relationship.type !== 'imports') continue
      const sourceId = endpointFileId(relationship.sourceId, relationship.sourceKind, elementsById)
      const targetId = endpointFileId(relationship.targetId, relationship.targetKind, elementsById)
      const targetReference = targetId ? referencesByFileId.get(targetId) : undefined
      if (!sourceId || !targetReference || sourceId === targetId) continue
      const targets = outgoing.get(sourceId) ?? new Set<string>()
      targets.add(targetReference)
      outgoing.set(sourceId, targets)
    }
  }

  return {
    layer,
    projectName: snapshot.projectName ?? 'unknown',
    files: files.map((file) => ({
      contextReference: referencesByFileId.get(file.id)!,
      path: file.relativePath,
      sourceTokens: file.tokenCount ?? null,
      outgoingContextReferences: [...(outgoing.get(file.id) ?? [])].sort(compareText)
    }))
  }
}
