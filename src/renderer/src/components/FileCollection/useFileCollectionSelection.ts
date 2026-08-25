/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Gerenciar a seleção de arquivos da coleção via operações unitária (toggleFile), global (toggleMaster) e de limpeza (clearSelection).
2. Fornecer callbacks estáveis via useRef para evitar re-renderizações desnecessárias em componentes filhos memoizados.
3. Derivar métricas de seleção (contagem total e seleção completa).

Mapa de Relacionamentos do Script

1. types.ts
   - Tipo: Contrato / Interface
   - Relação: Importa FileCardFile e FileCollectionSelectionResult.
   - Criticidade: Alta

2. FileCollectionView.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome o hook para coordenar o estado de seleção da coleção.
   - Criticidade: Alta

Invariantes do Script

1. Os callbacks toggleFile, toggleMaster e clearSelection dependem exclusivamente de onSelectionChange, mantendo referências estáveis independente de mutações em selectedFiles ou files.
2. A criação de novos conjuntos de seleção utiliza new Set(ref.current) em vez de spread operator.
3. isAllSelected é false quando a lista de arquivos estiver vazia, mesmo com selectedFiles vazio.
4. O hook contém EXCLUSIVAMENTE lógica de seleção — preparação de dados (tags, tokens) pertence ao useFileCollectionData.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { useCallback, useEffect, useRef } from 'react'
import type { FileCardFile, FileCollectionSelectionResult } from './types'

export interface UseFileCollectionSelectionParams {
  /** Conjunto de caminhos selecionados mantido pelo consumidor. */
  selectedFiles: Set<string>
  /** Callback do consumidor para atualizar a seleção. */
  onSelectionChange: (selected: Set<string>) => void
  /** Lista completa de arquivos visíveis. */
  files: FileCardFile[]
}

export function useFileCollectionSelection({
  selectedFiles,
  onSelectionChange,
  files
}: UseFileCollectionSelectionParams): FileCollectionSelectionResult {
  // Padrão de estabilidade via useRef para desacoplar callbacks das mudanças de estado
  const selectedFilesRef = useRef(selectedFiles)
  const filesRef = useRef(files)

  useEffect(() => {
    selectedFilesRef.current = selectedFiles
  }, [selectedFiles])

  useEffect(() => {
    filesRef.current = files
  }, [files])

  const toggleFile = useCallback(
    (relativePath: string) => {
      const next = new Set(selectedFilesRef.current)
      if (next.has(relativePath)) {
        next.delete(relativePath)
      } else {
        next.add(relativePath)
      }
      onSelectionChange(next)
    },
    [onSelectionChange]
  )

  const toggleMaster = useCallback(() => {
    const currentSelected = selectedFilesRef.current
    const currentFiles = filesRef.current

    if (currentSelected.size === currentFiles.length) {
      onSelectionChange(new Set<string>())
      return
    }

    const next = new Set(currentFiles.map((file) => file.relativePath))
    onSelectionChange(next)
  }, [onSelectionChange])

  const clearSelection = useCallback(() => {
    onSelectionChange(new Set<string>())
  }, [onSelectionChange])

  const isAllSelected = files.length > 0 && selectedFiles.size === files.length
  const selectedCount = selectedFiles.size

  return {
    toggleFile,
    toggleMaster,
    clearSelection,
    isAllSelected,
    selectedCount
  }
}