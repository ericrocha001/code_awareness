/*
-T ---
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