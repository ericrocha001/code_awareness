/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar a grade responsiva de FileCards.
2. Gerenciar seleção em massa e calcular total de tokens selecionados.
3. Receber lista de arquivos já filtrada e propagar eventos de seleção.
4. Exibir botão "Limpar" para zerar a seleção com um clique.

Mapa de Relacionamentos do Script

1. FileCard.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza cada item da grade. A propriedade changeType é repassada automaticamente via spread operator em fileWithTokens.
   - Criticidade: Alta

2. ToggleSwitch.tsx
   - Tipo: Dependência Direta
   - Criticidade: Alta

3. lucide-react (X)
   - Tipo: Dependência Direta
   - Relação: Ícone do botão Limpar seleção.
   - Criticidade: Baixa

Invariantes do Script

1. A grade não deve quebrar em larguras pequenas.
2. O total de tokens selecionados deve refletir apenas arquivos marcados.
3. A seleção master deve ser consistente com o estado atual.
4. O botão Limpar seleção só é renderizado quando selectedFiles.size > 0.
5. Limpar seleção propaga onSelectionChange com um Set vazio — não reordena nem altera dados.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useMemo } from 'react'
import { X } from 'lucide-react'
import { Tag } from '../../../../shared/types'
import { FileCard, type FileCardFile } from '../FileCard/FileCard'
import { ToggleSwitch } from '../ToggleSwitch/ToggleSwitch'
import './FileGrid.css'

interface FileGridProps {
  files: FileCardFile[]
  allTags: Tag[]
  fileTagsMap: Record<string, string[]>
  selectedFiles: Set<string>
  onSelectionChange: (selected: Set<string>) => void
  tokenEstimates: Record<string, number>
  formatTokenCount: (count: number) => string

  onHideFile?: (relativePath: string) => void
  onRevealInExplorer?: (relativePath: string) => void
  onCopyPath?: (relativePath: string) => void
  onCopyName?: (name: string) => void
  onOpenTagManager?: () => void
  onTagsChanged?: () => void
  repoPath?: string
}

export const FileGrid: React.FC<FileGridProps> = ({
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
  const allSelected = files.length > 0 && selectedFiles.size === files.length
  const someSelected = selectedFiles.size > 0 && selectedFiles.size < files.length

  const totalSelectedTokens = useMemo(() => {
    let total = 0
    for (const path of selectedFiles) {
      total += tokenEstimates[path] || 0
    }
    return total
  }, [selectedFiles, tokenEstimates])

  const toggleMaster = () => {
    const next = allSelected ? new Set<string>() : new Set(files.map(f => f.relativePath))
    onSelectionChange(next)
  }

  const toggleFile = (relativePath: string) => {
    const next = new Set(selectedFiles)
    next.has(relativePath) ? next.delete(relativePath) : next.add(relativePath)
    onSelectionChange(next)
  }

  const clearSelection = () => onSelectionChange(new Set<string>())

  return (
    <div className="file-grid">
      <div className="file-grid-header">
        <div className="file-grid-header-left">
          <ToggleSwitch
            checked={allSelected}
            indeterminate={someSelected}
            onChange={toggleMaster}
          />
          <span className="file-grid-header-title">Arquivos</span>
        </div>
        <div className="file-grid-header-right">
          <div className={`file-grid-header-right-group${selectedFiles.size > 0 ? '' : ' hidden'}`}>
            <button
              className="app-pill-btn sm"
              onClick={clearSelection}
              title="Limpar seleção"
              aria-label="Limpar seleção"
            >
              <X size={14} strokeWidth={2} />
              Limpar
            </button>
            {totalSelectedTokens > 0 && (
              <span className="file-grid-token-total" title="Total estimado de tokens selecionados">
                ≈ {formatTokenCount(totalSelectedTokens)} tokens
              </span>
            )}
          </div>
          <span className="file-grid-count">{files.length} item(ns)</span>
        </div>
      </div>

      <div className="file-grid-body">
        {files.map(file => {
          // BUGFIX: Injeta a estimativa de tokens (obrigatória aqui) pois o FileCard espera number | undefined
          const fileWithTokens: FileCardFile = {
            ...file,
            tokenEstimate: tokenEstimates[file.relativePath]
          }

          return (
            <FileCard
              key={file.relativePath}
              file={fileWithTokens}
              tags={[]}
              allTags={allTags}
              fileTagIds={fileTagsMap[file.relativePath] || []}
              isSelected={selectedFiles.has(file.relativePath)}
              onToggle={() => toggleFile(file.relativePath)}
              onHideFile={
                onHideFile ? () => onHideFile(file.relativePath) : undefined
              }
              onRevealInExplorer={
                onRevealInExplorer ? () => onRevealInExplorer(file.relativePath) : undefined
              }
              onCopyPath={
                onCopyPath ? () => onCopyPath(file.relativePath) : undefined
              }
              onCopyName={
                onCopyName ? () => onCopyName(file.name) : undefined
              }
              onOpenTagManager={onOpenTagManager}
              onTagsChanged={onTagsChanged}
              repoPath={repoPath}
            />
          )
        })}
        {files.length === 0 && (
          <div className="file-grid-empty">Nenhum arquivo encontrado</div>
        )}
      </div>
    </div>
  )
}