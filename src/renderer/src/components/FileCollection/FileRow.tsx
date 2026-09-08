/*
-T ---
*/

import React from 'react'
import { MoreHorizontal, Plus } from 'lucide-react'
import { getFileIconClass } from '../../utils/file-icon-mapper'
import { ToggleSwitch } from '../ToggleSwitch/ToggleSwitch'
import { TokenBadge } from '../shared/TokenBadge/TokenBadge'
import type { TagRenderData } from './models/FileRowModel'
import type { FileCardFile, RowActionType } from './types'
import '../shared/TagChip/TagChip.css'
import './FileRow.css'

export interface FileRowProps {
  file: FileCardFile
  /** Tags pré-resolvidas com paleta de cores, injetadas pelo FileView. */
  tags: readonly TagRenderData[]
  isSelected: boolean
  /** Quantidade de tags ocultas por overflow. Injetado pelo FileView (Sprint 3: TagOverflowController). */
  hiddenCount: number
  /** Callback consolidado para todas as interações da row. */
  onRowAction: (type: RowActionType, relativePath: string, anchor?: HTMLElement) => void
}

const FileRowInner: React.FC<FileRowProps> = ({
  file,
  tags,
  isSelected,
  hiddenCount,
  onRowAction
}) => {
  const iconClass = getFileIconClass(file.name)

  const tagsTitle = tags.length > 0 ? tags.map((t) => t.name).join(', ') : undefined

  return (
    <div
      className={`fr-row ${isSelected ? 'selected' : ''}`}
      data-relative-path={file.relativePath}
    >
      {/* 1. Toggle */}
      <div className="fr-col-toggle">
        <ToggleSwitch
          checked={isSelected}
          onChange={() => onRowAction('toggle', file.relativePath)}
        />
      </div>

      {/* 2. Identidade: Ícone + Nome + Badge de alteração */}
      <div className="fr-identity">
        <span className="fr-file-icon">
          <i className={`fr-icon ${iconClass} colored`} />
        </span>
        <span className="fr-name" title={file.name}>
          {file.name}
        </span>
        {file.changeType && file.changeType !== 'tracked' && (
          <span className={`fr-change-badge ${file.changeType}`}>
            {file.changeType === 'modified' ? 'M' : file.changeType === 'added' ? 'A' : 'D'}
          </span>
        )}
      </div>

      {/* 3. Caminho relativo */}
      <div className="fr-path" title={file.relativePath}>
        {file.relativePath}
      </div>

      {/* 4. Tags integrais no DOM (contenção visual com clip + fade + "+N") */}
      <div
        className="fr-tags"
        onClick={(e) => onRowAction('tagInteraction', file.relativePath, e.currentTarget)}
        data-testid="file-row-tags"
        title={tagsTitle}
      >
        {tags.map((tag) => (
          <span
            key={tag.id}
            className="tag-chip"
            style={{ backgroundColor: tag.background, color: tag.text }}
          >
            {tag.name}
          </span>
        ))}
        {hiddenCount > 0 && (
          <span className="fr-tags-more" data-testid="fr-tags-more">
            +{hiddenCount}
          </span>
        )}
        {/* Gatilho universal de tags: sempre visível (funciona com zero tags) e
            âncora do popover no próprio botão. stopPropagation evita que a área
            de tags (que também dispara tagInteraction) roube a âncora. */}
        <button
          type="button"
          className="fr-tags-add"
          aria-label="Adicionar tag"
          title="Adicionar tag"
          onClick={(e) => {
            e.stopPropagation()
            onRowAction('tagInteraction', file.relativePath, e.currentTarget)
          }}
        >
          <Plus size={12} strokeWidth={2.5} />
        </button>
      </div>

      {/* 5. Tokens */}
      <div className="fr-tokens">
        <TokenBadge tokens={file.tokenEstimate ?? 0} />
      </div>

      {/* Botão de ações — absoluto no final da row (Sprint 8), fora do fluxo do
          grid; não consome track. .fr-row tem padding-right para não sobrepor
          o conteúdo da última coluna (tokens). */}
      <button
        className="fr-action-btn"
        onClick={(e) => onRowAction('actionInteraction', file.relativePath, e.currentTarget)}
        title="Ações do arquivo"
        aria-label="Ações do arquivo"
      >
        <MoreHorizontal size={16} strokeWidth={2} />
      </button>
    </div>
  )
}

FileRowInner.displayName = 'FileRow'

/**
 * Comparador customizado para React.memo do FileRow.
 *
 * Compara `file` campo a campo (por valor), `tags` por conteúdo (length + id +
 * background por índice), `hiddenCount` e `onRowAction` por referência.
 */
function areFileRowPropsEqual(prev: FileRowProps, next: FileRowProps): boolean {
  // Campos de FileCardFile lidos no JSX
  if (
    prev.file.relativePath !== next.file.relativePath ||
    prev.file.name !== next.file.name ||
    prev.file.changeType !== next.file.changeType ||
    prev.file.tokenEstimate !== next.file.tokenEstimate
  ) {
    return false
  }

  // Tags: comparação por conteúdo — novo array a cada render do FileView quando
  // fileTagsMap ou tagRenderMap mudam; comparação por referência falharia sempre.
  // `background` detecta edição de cor de tag e mudança de tema (light/dark).
  if (prev.tags.length !== next.tags.length) return false
  for (let i = 0; i < prev.tags.length; i++) {
    if (prev.tags[i].id !== next.tags[i].id) return false
    if (prev.tags[i].background !== next.tags[i].background) return false
  }

  if (prev.isSelected !== next.isSelected) return false
  if (prev.hiddenCount !== next.hiddenCount) return false
  if (prev.onRowAction !== next.onRowAction) return false

  return true
}

export const FileRow = React.memo(FileRowInner, areFileRowPropsEqual)
