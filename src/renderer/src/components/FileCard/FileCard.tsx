/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar os metadados do arquivo em card com nome, caminho, tokens e ícone representativo.
2. Renderizar chips de tags e badge de tipo de alteração (M/A/D) quando aplicável.
3. Medir por contenção o overflow vertical de tags (teto de 2 linhas) e sinalizar o excesso com contador "+N" sobre a região clipada, mantendo consultabilidade via tooltip (title) com a lista integral.
4. Delegar interações contextuais (abertura de TagPopover e ActionMenu) para o pai via callbacks onTagInteraction e onActionInteraction.
5. Otimizar re-renderizações através de React.memo com comparador estrito customizado.

Mapa de Relacionamentos do Script

1. ../FileCollection/types.ts
   - Tipo: Contrato / Interface
   - Relação: Importa e reexporta FileCardFile como fonte única de tipos.
   - Criticidade: Alta

2. ../../utils/tag-overflow.ts
   - Tipo: Dependência Direta
   - Relação: Helper puro que converte geometrias medidas em contagem de tags ocultas.
   - Criticidade: Alta

3. ../../CodeJourneyView/ChangesSection.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome FileCard na seção de mudanças do Code Journey (único consumidor desde a eliminação do FileGridView na Sprint 2.3).
   - Criticidade: Alta

4. ../ToggleSwitch/ToggleSwitch.tsx
   - Tipo: Dependência Direta
   - Relação: Componente de controle de seleção.
   - Criticidade: Alta

5. ../../../../shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Interface de Tag.
   - Criticidade: Alta

Invariantes do Script

1. Não instancia nem renderiza Popover, TagPopover ou ActionMenu no DOM interno do card.
2. Suporta tanto a API legada (tags: Tag[]) quanto a nova API (fileTagIds: string[] + allTags: Tag[]).
3. React.memo realiza comparação campo a campo das props relevantes, prevenindo re-renderizações quando os valores não mudam.
4. hiddenTagCount é estado de APRESENTAÇÃO (não de negócio): não altera o contrato de props do memo e só assume valor > 0 após medição geométrica válida; ambiente sem medição (jsdom/primeiro paint) produz zero ocultas — nunca um "+N" falso.
5. A medição de overflow é local ao item montado (nunca movida para o orquestrador); o "+N" é absoluto e pointer-events: none, portanto o setState pós-medida não altera geometria (sem loop de ResizeObserver).

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useMemo, useRef, useState, useLayoutEffect } from 'react'
import { MoreHorizontal, Plus } from 'lucide-react'
import { getFileIconClass } from '../../utils/file-icon-mapper'
import { computeTagOverflow } from '../../utils/tag-overflow'
import { Tag } from '../../../../shared/types'
import { ToggleSwitch } from '../ToggleSwitch/ToggleSwitch'
import { TagChip } from '../shared/TagChip/TagChip'
import { TokenBadge } from '../shared/TokenBadge/TokenBadge'
import type { FileCardFile } from '../FileCollection/types'
import './FileCard.css'

export type { FileCardFile } from '../FileCollection/types'

export interface FileCardProps {
  file: FileCardFile
  allTags: Tag[]
  /** Nova API (Sprint 6 em diante): IDs de tags + lookup. */
  fileTagIds?: string[]
  /** API legada (FileGrid atual): tags já resolvidas. */
  tags?: Tag[]
  isSelected: boolean
  onToggle: () => void
  onTagInteraction?: (element: HTMLElement) => void
  onActionInteraction?: (element: HTMLElement) => void
  onHideFile?: () => void
  onRevealInExplorer?: () => void
  onCopyPath?: () => void
  onCopyName?: () => void
  onOpenTagManager?: () => void
  onTagsChanged?: () => void
  repoPath?: string
  /** Gancho opcional para auditoria e testes de ciclo de vida */
  onRender?: () => void
}

const FileCardInner = React.forwardRef<HTMLDivElement, FileCardProps>(
  (
    {
      file,
      tags,
      allTags,
      fileTagIds,
      isSelected,
      onToggle,
      onTagInteraction,
      onActionInteraction,
      onRender
    },
    ref
  ) => {
    onRender?.()

    const directory = file.relativePath.includes('/')
      ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/') + 1)
      : ''
    const iconClass = getFileIconClass(file.name)

    const resolvedTags = useMemo(() => {
      if (tags && tags.length > 0) return tags
      if (fileTagIds && fileTagIds.length > 0) {
        const safeAllTags = allTags || []
        const tagMap = new Map(safeAllTags.map((t) => [t.id, t]))
        return fileTagIds.map((id) => tagMap.get(id)).filter((t): t is Tag => !!t)
      }
      if (tags) return tags
      return []
    }, [tags, fileTagIds, allTags])

    // ── Overflow de tags (estado de apresentação; ver invariante 4/5 do header) ──
    const tagsContainerRef = useRef<HTMLDivElement | null>(null)
    const chipRefs = useRef<(HTMLElement | null)[]>([])
    const [hiddenTagCount, setHiddenTagCount] = useState(0)

    useLayoutEffect(() => {
      const measure = (): void => {
        const container = tagsContainerRef.current
        if (!container) return
        const chips = chipRefs.current
        const geoms = chips.map((chip) =>
          chip
            ? { start: chip.offsetTop, end: chip.offsetTop + chip.offsetHeight }
            : { start: 0, end: 0 }
        )
        setHiddenTagCount(computeTagOverflow(geoms, container.clientHeight).hiddenCount)
      }

      measure()

      // Re-medir quando a largura do card mudar (mudança de colunas no grid).
      // Guarda de existência: ambientes sem ResizeObserver ficam só com a medição de montagem.
      const container = tagsContainerRef.current
      if (!container || typeof ResizeObserver === 'undefined') return
      const observer = new ResizeObserver(measure)
      observer.observe(container)
      return () => observer.disconnect()
    }, [resolvedTags])

    const tagsTitle =
      resolvedTags.length > 0 ? resolvedTags.map((t) => t.name).join(', ') : undefined

    return (
      <div ref={ref} className={`file-card ${isSelected ? 'selected' : ''}`}>
        <div className="file-card-main">
          <div className="file-card-top-row">
            <div className="file-card-title">
              <span className="file-card-file-icon">
                <i className={`file-card-icon ${iconClass} colored`} />
              </span>
              {file.name}
            </div>
            {file.changeType && file.changeType !== 'tracked' && (
              <span className={`file-card-change-badge ${file.changeType}`}>
                {file.changeType === 'modified' ? 'M' : file.changeType === 'added' ? 'A' : 'D'}
              </span>
            )}
          </div>
          {directory && <div className="file-card-path">{directory}</div>}
          {typeof file.tokenEstimate === 'number' && file.tokenEstimate > 0 && (
            <TokenBadge tokens={file.tokenEstimate} />
          )}
        </div>

        <div className="file-card-footer">
          <div
            ref={tagsContainerRef}
            className="file-card-tags file-card-tags-clickable"
            onClick={(e) => onTagInteraction?.(e.currentTarget)}
            data-testid="file-card-tags"
            title={tagsTitle}
          >
            {resolvedTags.map((tag, index) => (
              <span
                key={tag.id}
                ref={(el) => {
                  chipRefs.current[index] = el
                }}
              >
                <TagChip tag={tag} />
              </span>
            ))}
            {hiddenTagCount > 0 && (
              <span className="file-card-tags-more" data-testid="file-card-tags-more">
                +{hiddenTagCount}
              </span>
            )}
            {/* Gatilho universal de tags (paridade com FileRow, Sprint 3): absoluto no
                topo direito para não ser clipado pelo max-height da área. stopPropagation
                evita que a área de tags (que abre o TagPopover) roube a âncora. */}
            <button
              type="button"
              className="file-card-tags-add"
              aria-label="Adicionar tag"
              title="Adicionar tag"
              onClick={(e) => {
                e.stopPropagation()
                onTagInteraction?.(e.currentTarget)
              }}
            >
              <Plus size={12} strokeWidth={2.5} />
            </button>
          </div>

          <div className="file-card-actions-right">
            <ToggleSwitch checked={isSelected} onChange={onToggle} />

            <button
              className="file-card-actions-btn"
              onClick={(e) => onActionInteraction?.(e.currentTarget)}
              title="Ações do arquivo"
              aria-label="Ações do arquivo"
            >
              <MoreHorizontal size={16} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>
    )
  }
)

FileCardInner.displayName = 'FileCard'

export const areFileCardPropsEqual = (prev: FileCardProps, next: FileCardProps): boolean => {
  return (
    prev.file.relativePath === next.file.relativePath &&
    prev.file.name === next.file.name &&
    prev.file.tokenEstimate === next.file.tokenEstimate &&
    prev.file.changeType === next.file.changeType &&
    prev.isSelected === next.isSelected &&
    prev.tags === next.tags &&
    prev.fileTagIds === next.fileTagIds &&
    prev.allTags === next.allTags &&
    prev.onToggle === next.onToggle &&
    prev.onTagInteraction === next.onTagInteraction &&
    prev.onActionInteraction === next.onActionInteraction &&
    prev.onHideFile === next.onHideFile &&
    prev.onRevealInExplorer === next.onRevealInExplorer &&
    prev.onCopyPath === next.onCopyPath &&
    prev.onCopyName === next.onCopyName &&
    prev.onOpenTagManager === next.onOpenTagManager &&
    prev.onTagsChanged === next.onTagsChanged &&
    prev.repoPath === next.repoPath &&
    prev.onRender === next.onRender
  )
}

export const FileCard = React.memo(FileCardInner, areFileCardPropsEqual)