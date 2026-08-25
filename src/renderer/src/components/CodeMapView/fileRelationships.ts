/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Derivar o grafo de dependências entre arquivos a partir dos relacionamentos `imports`.
2. Expor a união dos arquivos importados e dos que importam um dado arquivo.

Mapa de Relacionamentos do Script

1. CodeMapView.tsx
   - Tipo: Fluxo de Dados
   - Relação: Consome buildFileGraph e getRelatedFileIds para acender os arquivos relacionados na árvore.
   - Criticidade: Alta

2. ../../../../shared/types
   - Tipo: Contrato / Interface
   - Relação: Fornece os tipos CodeMapRelationship, CodeMapElement e CodeMapFile.
   - Criticidade: Alta

Invariantes do Script

1. O módulo é puro: não acessa React, IPC, DOM ou estado global.
2. A saída é determinística para a mesma entrada.
3. Nenhuma função lança exceção — entradas inválidas produzem grafos vazios.
4. A complexidade é O(n) no total de relacionamentos e elementos.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import type { CodeMapElement, CodeMapFile, CodeMapRelationship } from '../../../../shared/types'

export interface FileGraph {
  /** fileId → lista de fileIds que ele importa (deduplicada). */
  imports: Map<string, string[]>
  /** fileId → lista de fileIds que o importam (deduplicada). */
  importedBy: Map<string, string[]>
}

/**
 * Constrói o grafo arquivo↔arquivo a partir dos relacionamentos `imports`.
 *
 * Semântica dos relacionamentos `imports`:
 * - sourceId é o id de um elemento de import (kind === 'import');
 * - targetId já é o fileId do arquivo importado.
 *
 * Arestas inválidas (arquivo inexistente, self-import) são descartadas.
 */
export function buildFileGraph(
  relationships: CodeMapRelationship[],
  elements: CodeMapElement[],
  files: CodeMapFile[]
): FileGraph {
  // Sets internos garantem deduplicação O(1) por inserção — evita O(n²) em grafos densos
  const imports = new Map<string, Set<string>>()
  const importedBy = new Map<string, Set<string>>()

  // Conjunto de fileIds válidos para lookup O(1)
  const fileIds = new Set<string>()
  for (const file of files) {
    fileIds.add(file.id)
  }

  // Mapa elementId → fileId para resolver a origem do import
  const elementFileIds = new Map<string, string>()
  for (const element of elements) {
    elementFileIds.set(element.id, element.fileId)
  }

  const addEdge = (map: Map<string, Set<string>>, from: string, to: string) => {
    let set = map.get(from)
    if (!set) {
      set = new Set()
      map.set(from, set)
    }
    set.add(to)
  }

  for (const rel of relationships) {
    if (rel.type !== 'imports') continue

    const sourceFileId = elementFileIds.get(rel.sourceId)
    const targetFileId = rel.targetId

    // Valida que ambos os lados existem e não é self-import
    if (!sourceFileId || !fileIds.has(sourceFileId) || !fileIds.has(targetFileId)) continue
    if (sourceFileId === targetFileId) continue

    addEdge(imports, sourceFileId, targetFileId)
    addEdge(importedBy, targetFileId, sourceFileId)
  }

  // Converte Sets internos para arrays no retorno (contrato público)
  const toArrays = (map: Map<string, Set<string>>): Map<string, string[]> => {
    const result = new Map<string, string[]>()
    for (const [key, set] of map) {
      result.set(key, Array.from(set))
    }
    return result
  }

  return { imports: toArrays(imports), importedBy: toArrays(importedBy) }
}

/**
 * Retorna a união dos fileIds que o arquivo importa e dos que o importam.
 * Nunca lança — arquivo sem relacionamentos produz um Set vazio.
 */
export function getRelatedFileIds(graph: FileGraph, fileId: string): Set<string> {
  const related = new Set<string>()

  const imported = graph.imports.get(fileId)
  if (imported) {
    for (const id of imported) related.add(id)
  }

  const importers = graph.importedBy.get(fileId)
  if (importers) {
    for (const id of importers) related.add(id)
  }

  return related
}