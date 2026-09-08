/*
-T ---
*/

import type { CodeMapFile } from '../../../../shared/types'
import type { FileGraph } from './fileRelationships'

export interface CytoscapeNodeData {
  id: string
  label: string
  degree: number
  isCentral: boolean
}

export interface CytoscapeEdgeData {
  id: string
  source: string
  target: string
}

export interface CytoscapeElements {
  nodes: Array<{ data: CytoscapeNodeData }>
  edges: Array<{ data: CytoscapeEdgeData }>
}

/** Extrai o nome do arquivo a partir do caminho relativo. */
function getFileName(relativePath: string): string {
  return relativePath.split('/').pop() ?? relativePath
}

/**
 * Constrói os elementos Cytoscape (nós + arestas) para o grafo de relacionamentos.
 * Módulo puro — pode ser testado isoladamente sem React ou Cytoscape.
 */
export function buildCytoscapeElements(
  file: CodeMapFile,
  fileGraph: FileGraph,
  files: CodeMapFile[]
): CytoscapeElements {
  const filesById = new Map<string, CodeMapFile>()
  for (const f of files) {
    filesById.set(f.id, f)
  }

  // Conjunto de fileIds envolvidos (central + imports + importedBy)
  const involvedIds = new Set<string>([file.id])
  const importIds = fileGraph.imports.get(file.id) ?? []
  const importedByIds = fileGraph.importedBy.get(file.id) ?? []

  for (const id of importIds) {
    if (filesById.has(id)) involvedIds.add(id)
  }
  for (const id of importedByIds) {
    if (filesById.has(id)) involvedIds.add(id)
  }

  // Grau de cada nó = nº de conexões (imports + importedBy combinados)
  const degreeById = new Map<string, number>()

  const countDegree = (id: string, delta: number) => {
    degreeById.set(id, (degreeById.get(id) ?? 0) + delta)
  }

  // Aresta importador → importado (direção do import)
  const edgeSet = new Set<string>()
  const edges: Array<{ data: CytoscapeEdgeData }> = []

  const addEdge = (source: string, target: string) => {
    const edgeId = `${source}|${target}`
    if (edgeSet.has(edgeId)) return
    if (!filesById.has(source) || !filesById.has(target)) return
    edgeSet.add(edgeId)
    edges.push({ data: { id: edgeId, source, target } })
    countDegree(source, 1)
    countDegree(target, 1)
  }

  // Imports: o central importa X — aresta central → X
  for (const impId of importIds) {
    addEdge(file.id, impId)
  }

  // ImportedBy: Y importa o central — aresta Y → central
  for (const importerId of importedByIds) {
    addEdge(importerId, file.id)
  }

  // Nós deduplicados (Set já garante unicidade)
  const nodes: Array<{ data: CytoscapeNodeData }> = []
  for (const id of involvedIds) {
    const f = filesById.get(id)
    if (!f) continue
    nodes.push({
      data: {
        id,
        label: getFileName(f.relativePath),
        degree: degreeById.get(id) ?? 0,
        isCentral: id === file.id
      }
    })
  }

  return { nodes, edges }
}