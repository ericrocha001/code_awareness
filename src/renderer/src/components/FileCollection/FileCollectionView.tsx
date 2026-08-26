/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Atuar como orquestrador público da coleção de arquivos (FileCollectionView).
2. Coordenar os hooks de dados (useFileCollectionData), seleção (useFileCollectionSelection) e interação ativa (useFileCollectionInteraction).
3. Renderizar exclusivamente a FileView, única visualização canônica da coleção.
4. Hospedar a renderização centralizada sob demanda do ActivePopover com suporte a auto-fechamento.
5. Consolidar as interações da row (toggle/tag/action) em um único callback onRowAction repassado ao FileView.

Mapa de Relacionamentos do Script

1. types.ts
   - Tipo: Contrato / Interface
   - Relação: Importa FileCardFile.
   - Criticidade: Alta

2. useFileCollectionData.ts
   - Tipo: Dependência Direta
   - Relação: Prepara tagsByFile e tokenEstimateMap consumidos aqui.
   - Criticidade: Alta

3. useFileCollectionSelection.ts
   - Tipo: Dependência Direta
   - Relação: Hook de gerenciamento de seleção de arquivos.
   - Criticidade: Alta

4. useFileCollectionInteraction.ts
   - Tipo: Dependência Direta
   - Relação: Hook de controle da interação contextual ativa (TagPopover / ActionMenu).
   - Criticidade: Alta

5. FileView.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza a visualização em lista compacta (view única).
   - Criticidade: Alta

6. ActivePopover.tsx
   - Tipo: Dependência Direta
   - Relação: Componente sob demanda posicionado via portal.
   - Criticidade: Alta

Invariantes do Script

1. Renderiza apenas FileView — não existe switcher de modo nem renderização condicional (a arquitetura de grid/dense foi eliminada).
2. totalSelectedTokens é derivado localmente via tokenEstimateMap do useFileCollectionData — o selection hook não contém lógica de dados.
3. Se o arquivo ativo for removido da lista de arquivos visíveis, a interação é encerrada automaticamente.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useEffect, useCallback, useMemo } from 'react'
import { X } from 'lucide-react'
import { Tag } from '../../../../shared/types'
import { ToggleSwitch } from '../ToggleSwitch/ToggleSwitch'
import { useFileCollectionSelection } from './useFileCollectionSelection'
import { useFileCollectionData } from './useFileCollectionData'
import { useFileCollectionInteraction } from './useFileCollectionInteraction'
import { useTheme } from '../../hooks/useTheme'
import type { RowActionType } from './types'
import { FileView } from './FileView'
import { ActivePopover } from './ActivePopover'
import type { FileCardFile } from './types'
import './FileCollectionView.css'

export interface FileCollectionViewProps {
  files: FileCardFile[]
  allTags: Tag[]
  fileTagsMap: Record<string, string[]>
  selectedFiles: Set<string>
  onSelectionChange: (selected: Set<string>) => void
  tokenEstimates?: Record<string, number>
  formatTokenCount: (count: number) => string
  onHideFile?: (relativePath: string) => void
  onRevealInExplorer?: (relativePath: string) => void
  onCopyPath?: (relativePath: string) => void
  onCopyName?: (name: string) => void
  onOpenTagManager?: () => void
  onTagsChanged?: () => void
  repoPath?: string
}

export const FileCollectionViewInner: React.FC<FileCollectionViewProps> = ({
  files,
  allTags,
  fileTagsMap,
  selectedFiles,
  onSelectionChange,
  tokenEstimates,
  formatTokenCount,
  onHideFile,
  onRevealInExplorer,
  onCopyPath,
  onCopyName,
  onOpenTagManager,
  onTagsChanged,
  repoPath
}) => {
  // Tema efetivo para resolução da paleta de tags no useFileCollectionData.
  const { effectiveTheme } = useTheme()

  // ─── Enriquecimento de tokens se fornecido via mapa ────────────────────
  // Os consumidores já entregam files com tokenEstimate aplicado; o override
  // aqui é idempotente e mantém compatibilidade com chamadas que não enriquecem.
  const filesWithTokens = useMemo(() => {
    if (!tokenEstimates || Object.keys(tokenEstimates).length === 0) {
      return files
    }
    return files.map((file) => ({
      ...file,
      tokenEstimate: tokenEstimates[file.relativePath] ?? file.tokenEstimate
    }))
  }, [files, tokenEstimates])

  // ─── Preparação de dados (tags pré-resolvidas, tokens por arquivo) ──────
  const { tagsByFile, tokenEstimateMap } = useFileCollectionData({
    files: filesWithTokens,
    allTags,
    fileTagsMap,
    effectiveTheme
  })

  // ─── Hooks de seleção e interação ──────────────────────────────────────
  const {
    toggleFile,
    toggleMaster,
    clearSelection,
    isAllSelected,
    selectedCount
  } = useFileCollectionSelection({
    selectedFiles,
    onSelectionChange,
    files: filesWithTokens
  })

  const {
    activeInteraction,
    openTagPopover,
    openActionMenu,
    closeInteraction
  } = useFileCollectionInteraction()

  // ─── Métrica derivada localmente (movida do selection hook na Sprint 6) ─
  const totalSelectedTokens = useMemo(() => {
    let total = 0
    for (const path of selectedFiles) {
      total += tokenEstimateMap.get(path) ?? 0
    }
    return total
  }, [selectedFiles, tokenEstimateMap])

  // ─── Callback consolidado de interações da row (Sprint 6) ──────────────
  const handleRowAction = useCallback(
    (type: RowActionType, relativePath: string, anchor?: HTMLElement) => {
      if (type === 'toggle') {
        toggleFile(relativePath)
      } else if (type === 'tagInteraction') {
        openTagPopover(relativePath, anchor)
      } else if (type === 'actionInteraction') {
        openActionMenu(relativePath, anchor)
      }
    },
    [toggleFile, openTagPopover, openActionMenu]
  )

  // ─── Auto-fechamento quando item ativo sai da lista ─────────────────────
  useEffect(() => {
    if (!activeInteraction) return
    const itemExists = files.some((f) => f.relativePath === activeInteraction.relativePath)
    if (!itemExists) {
      closeInteraction()
    }
  }, [activeInteraction, files, closeInteraction])

  // ─── isSelected derivado para as views ─────────────────────────────────
  const isSelected = useCallback(
    (relativePath: string) => selectedFiles.has(relativePath),
    [selectedFiles]
  )

  // ─── Handler de TagPopover sincronizado ────────────────────────────────
  // Sprint 6.2 (PA-R01): apenas sincroniza dados — NÃO fecha a interação.
  // O contrato do TagPopover (invariante 6) exige o balão aberto para
  // multi-seleção; fechamento legítimo é só clique-fora/ESC/item removido.
  const handleTagsChanged = useCallback(() => {
    onTagsChanged?.()
  }, [onTagsChanged])

  return (
    <div className="fcv-container">
      {/* Header com master toggle e contagem */}
      <div className="fcv-header">
        <div className="fcv-header-left">
          <ToggleSwitch
            checked={isAllSelected}
            onChange={toggleMaster}
            indeterminate={selectedCount > 0 && !isAllSelected}
          />
          <span className="fcv-count">
            {selectedCount > 0
              ? `${selectedCount} de ${files.length} selecionados · ${formatTokenCount(totalSelectedTokens)} tokens`
              : `${files.length} arquivos`}
          </span>
          {selectedCount > 0 && (
            <button className="fcv-clear-btn" onClick={clearSelection}>
              <X size={14} /> Limpar
            </button>
          )}
        </div>
      </div>

      {/* Conteúdo: FileView (view única desde a Sprint 2.3) */}
      <div className="fcv-body">
        <FileView
          files={filesWithTokens}
          tagsByFile={tagsByFile}
          isSelected={isSelected}
          onRowAction={handleRowAction}
          repoPath={repoPath}
        />
      </div>

      {/* ActivePopover no nível do orquestrador */}
      <ActivePopover
        activeInteraction={activeInteraction}
        onClose={closeInteraction}
        allTags={allTags}
        fileTagsMap={fileTagsMap}
        onTagsChanged={handleTagsChanged}
        onOpenTagManager={onOpenTagManager}
        repoPath={repoPath}
        onHideFile={onHideFile}
        onRevealInExplorer={onRevealInExplorer}
        onCopyPath={onCopyPath}
        onCopyName={onCopyName}
      />
    </div>
  )
}

export const FileCollectionView = React.memo(FileCollectionViewInner)
