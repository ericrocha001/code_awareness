/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar um grupo de arquivos de mesmo nível de importância arquitetural (critical, high, medium, low).
2. Fornecer comportamento colapsável/expansível para o cabeçalho do grupo.
3. Renderizar os cards de arquivo utilizando as classes apropriadas para cada aba (cdf ou cs).
4. Exibir badge de tipo (M/A/D) quando fornecido via changeTypeMap (exclusivo do CodeDiffView).

Mapa de Relacionamentos do Script

1. CodeCompressionView.tsx
   - Tipo: Relação de UI
   - Relação: Renderiza este componente para cada um dos 4 níveis de importância.
   - Criticidade: Alta

2. CodeSourceView.tsx
   - Tipo: Relação de UI
   - Relação: Renderiza este componente para cada um dos 4 níveis de importância.
   - Criticidade: Alta

3. CodeDiffView.tsx
   - Tipo: Relação de UI
   - Relação: Renderiza este componente passando changeTypeMap para exibir badges M/A/D.
   - Criticidade: Alta

4. ToggleSwitch.tsx
   - Tipo: Dependência Direta
   - Relação: Consome ToggleSwitch para alternar a seleção do arquivo.
   - Criticidade: Média

5. ActionsDropdown.tsx
   - Tipo: Dependência Direta
   - Relação: Consome ActionsDropdown para fornecer ações contextuais.
   - Criticidade: Média

Invariantes do Script

1. O cabeçalho deve estar sempre no topo do grupo e exibir a contagem de arquivos atualizada.
2. Cada grupo inicia expandido por padrão.
3. A prop changeTypeMap é sempre opcional — CodeCompression e CodeSource não a utilizam.
4. A badge de tipo (M/A/D) deve aparecer somente quando changeTypeMap for fornecido.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useState } from 'react'
import { DiffFileStatus, ImportanceLevel, ImportanceSource } from '../../../../shared/types'
import { ImportanceBadge } from '../ImportanceBadge/ImportanceBadge'
import { ToggleSwitch } from '../ToggleSwitch/ToggleSwitch'
import { ActionsDropdown } from '../ActionsDropdown/ActionsDropdown'
import './ImportanceGroup.css'

interface ImportanceGroupProps {
  level: ImportanceLevel
  files: DiffFileStatus[]
  emoji: string
  label: string
  classPrefix: 'cdf' | 'cs'
  selectedFiles: Set<string>
  importanceMap: Record<string, ImportanceLevel>
  importanceSource: Record<string, ImportanceSource>
  tokenEstimates: Record<string, number>
  formatTokenCount: (count: number) => string
  toggleFileSelection: (relativePath: string) => void
  handleImportanceChange: (relativePath: string, newLevel: ImportanceLevel) => void
  onHideFile: (relativePath: string) => void
  onHideExtension: (extension: string) => void
  onCopyPath: (relativePath: string) => void
  onCopyName: (name: string) => void
  onRevealInExplorer: (relativePath: string) => void

  // Props opcionais do CodeDiffView: badges de tipo e cópia unitária
  changeTypeMap?: Record<string, 'modified' | 'added' | 'deleted' | 'tracked'>
  onFileClick?: (relativePath: string) => void
  selectedFile?: string | null
  onCopySingleFileDiff?: (relativePath: string, e: React.MouseEvent) => void
  copiedFile?: string | null
}

// Extrai o diretório pai de um caminho relativo (ex: "src/foo/bar.ts" -> "src/foo/")
const getDirectoryPath = (relativePath: string): string => {
  const parts = relativePath.split(/[/\\]/)
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join('/') + '/'
}

export const ImportanceGroup: React.FC<ImportanceGroupProps> = ({
  level,
  files,
  emoji,
  label,
  classPrefix,
  selectedFiles,
  importanceMap,
  importanceSource,
  tokenEstimates,
  formatTokenCount,
  toggleFileSelection,
  handleImportanceChange,
  onHideFile,
  onHideExtension,
  onCopyPath,
  onCopyName,
  onRevealInExplorer,
  changeTypeMap,
  onFileClick,
  selectedFile,
  onCopySingleFileDiff,
  copiedFile
}) => {
  const [isExpanded, setIsExpanded] = useState(true)

  // Não renderiza nada se o grupo estiver vazio
  if (files.length === 0) return null

  const toggleExpand = () => {
    if (label) {
      setIsExpanded((prev) => !prev)
    }
  }

  // Se não há label, o estado de expansão deve ser sempre true
  const expanded = label ? isExpanded : true

  return (
    <div className={`importance-group group-${level}`}>
      {/* Cabeçalho do Grupo — clicável para colapsar/expandir, exibido apenas se label for fornecido */}
      {label && (
        <div className="importance-group-header" onClick={toggleExpand}>
          <span className={`importance-group-arrow ${expanded ? 'expanded' : ''}`}>▶</span>
          <span className="importance-group-title">
            {emoji} {label}
          </span>
          <span className="importance-group-count">({files.length})</span>
        </div>
      )}

      {/* Lista de Arquivos — renderizada apenas quando expandido */}
      {expanded && (
        <ul className={`${classPrefix}-file-list`}>
          {files.map((file) => (
            <li
              key={file.relativePath}
              className={`${classPrefix}-file-card${selectedFile === file.relativePath ? ' selected' : ''}`}
            >
              {/* Toggle Switch para seleção do arquivo */}
              <div className="file-toggle-wrapper">
                <ToggleSwitch
                  checked={selectedFiles.has(file.relativePath)}
                  onChange={() => toggleFileSelection(file.relativePath)}
                />
              </div>

              {/* Badge de Importância Arquitetural */}
              <ImportanceBadge
                level={importanceMap[file.relativePath] || 'low'}
                source={importanceSource[file.relativePath] || 'heuristic'}
                onChange={(newLevel) => handleImportanceChange(file.relativePath, newLevel)}
              />

              {/* Conteúdo do Card: nome (linha 1) + diretório + tokens (linha 2) */}
              <div
                className={`${classPrefix}-file-card-content`}
                onClick={() => onFileClick
                  ? onFileClick(file.relativePath)
                  : toggleFileSelection(file.relativePath)
                }
              >
                <div className={`${classPrefix}-file-name-row`}>
                  {/* Badge de tipo (M/A/D) — apenas no CodeDiffView */}
                  {changeTypeMap && (
                    <span className={`${classPrefix}-type-badge ${changeTypeMap[file.relativePath]}`}>
                      {changeTypeMap[file.relativePath] === 'modified' ? 'M' :
                       changeTypeMap[file.relativePath] === 'added' ? 'A' :
                       changeTypeMap[file.relativePath] === 'deleted' ? 'D' : 'T'}
                    </span>
                  )}
                  <span className={`${classPrefix}-file-name`} title={file.relativePath}>
                    {file.name}
                  </span>
                </div>
                <div className={`${classPrefix}-file-meta-row`}>
                  <span className={`${classPrefix}-file-path`} title={file.relativePath}>
                    {getDirectoryPath(file.relativePath)}
                  </span>
                  {tokenEstimates[file.relativePath] > 0 && (
                    <span className={`${classPrefix}-token-estimate`} title="Estimativa de tokens">
                      ≈ {formatTokenCount(tokenEstimates[file.relativePath])}
                    </span>
                  )}
                </div>
              </div>

              {/* Menu de Ações em Dropdown */}
              <ActionsDropdown
                relativePath={file.relativePath}
                onHideFile={onHideFile}
                onHideExtension={onHideExtension}
                onCopyPath={onCopyPath}
                onCopyName={onCopyName}
                onRevealInExplorer={onRevealInExplorer}
                onCopySingleFileDiff={onCopySingleFileDiff}
                copiedFile={copiedFile}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
