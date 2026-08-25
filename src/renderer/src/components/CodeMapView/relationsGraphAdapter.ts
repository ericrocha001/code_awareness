/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Traduzir o FileGraph + arquivo selecionado no formato de elementos da Cytoscape.
2. Calcular o grau de cada nó (número de conexões) para dimensionar o círculo.
3. Deduplicar nós e arestas, descartando ids que não existem no conjunto de arquivos.

Mapa de Relacionamentos do Script

1. fileRelationships.ts
   - Tipo: Fluxo de Dados
   - Relação: Consome FileGraph com imports/importedBy já derivados.
   - Criticidade: Alta

2. RelationsGraph.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome buildCytoscapeElements para alimentar a instância Cytoscape.
   - Criticidade: Alta

3. ../../../../shared/types
   - Tipo: Contrato / Interface
   - Relação: Fornece o tipo CodeMapFile.
   - Criticidade: Alta

Invariantes do Script

1. O módulo é puro — nunca importa React, Cytoscape, IPC ou DOM.
2. A saída é determinística para a mesma entrada.
3. Nenhuma função lança exceção — entradas inválidas produzem elementos vazios.
4. Arestas apontam na direção do import (importador → importado).
5. O nó central é sempre o arquivo selecionado.
6. Nós e arestas são deduplicados por id.

--- FIM ARQUITETURA DO SCRIPT ---
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