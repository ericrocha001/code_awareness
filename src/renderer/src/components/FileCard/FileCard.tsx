/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar os metadados do arquivo em card compacto com nome, caminho e tokens.
2. Exibir badges coloridas das tags associadas e ToggleSwitch de seleção.
3. Fornecer ações contextuais (Ocultar/Ignorar, Revelar, Copiar) via menu de ações.
4. Exibir Quick Tag Popover para atribuir/remover tags do arquivo com persistência.
5. Exibir ícone Devicon representativo do tipo/extensão do arquivo ao lado do nome.
6. Exibir badge de tipo de alteração (M/A/D) com cor distinta por tipo quando changeType for fornecido.
7. Filtrar a lista de tags por nome dentro do popover, com estado vazio de busca e autofocus no input.

Mapa de Relacionamentos do Script

1. FileGrid.tsx
   - Tipo: Dependência Direta
   - Relação: Usa FileCard para compor a grade.
   - Criticidade: Alta

2. ToggleSwitch.tsx
   - Tipo: Dependência Direta
   - Relação: Componente reutilizado para seleção.
   - Criticidade: Alta

3. shared/types.ts (Tag)
   - Tipo: Contrato / Interface
   - Relação: Tipos de entrada para arquivo e tags.
   - Criticidade: Alta

4. Popover.tsx
   - Tipo: Dependência Direta
   - Relação: Posiciona e gerencia ciclo de vida do menu de ações e popover de tags.
   - Criticidade: Alta

Invariantes do Script

1. O caminho relativo nunca deve ser truncado sem ellipsis.
2. A cor da tag deve sempre ser aplicada de forma legível.
3. O estado de seleção deve refletir exatamente a prop recebida.
4. O menu de ações e o popover de tags são posicionados pelo Popover compartilhado (portal + espaço livre).
5. Este componente NÃO deve fazer chamadas IPC diretamente; tags são recebidas via props.
6. A associação arquivo ↔ tag é persistida via IPC no handleToggleTag, mas o estado é gerenciado pelo pai via fileTagIds prop e evento tags-changed.
7. O badge de tipo de alteração só deve ser renderizado quando changeType não for undefined nem 'tracked'.
8. A busca no popover de tags é local (estado interno), não persiste, zera ao fechar o popover e não interfere no marcar/desmarcar tags.

--- FIM ARQUITETURA DO SCRIPT ---
*/
import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { MoreVertical, EyeOff, FolderOpen, Copy, Plus, Check, Search } from 'lucide-react'
import { getFileIconClass } from '../../utils/file-icon-mapper'
import { Tag } from '../../../../shared/types'
import { ToggleSwitch } from '../ToggleSwitch/ToggleSwitch'
import { Popover } from '../shared/Popover/Popover'
import './FileCard.css'

export interface FileCardFile {
  relativePath: string
  name: string
  tokenEstimate?: number
  changeType?: 'modified' | 'added' | 'deleted' | 'tracked'
}

interface FileCardProps {
  file: FileCardFile
  tags: Tag[]
  allTags: Tag[]
  fileTagIds: string[]
  isSelected: boolean
  onToggle: () => void
  onHideFile?: () => void
  onRevealInExplorer?: () => void
  onCopyPath?: () => void
  onCopyName?: () => void
  onOpenTagManager?: () => void
  onTagsChanged?: () => void
  repoPath?: string
}

function usePopoverToggle(): {
  isOpen: boolean
  toggle: () => void
  close: () => void
} {
  const [isOpen, setIsOpen] = useState(false)
  const toggle = useCallback(() => setIsOpen(prev => !prev), [])
  const close = useCallback(() => setIsOpen(false), [])
  return { isOpen, toggle, close }
}

export const FileCard: React.FC<FileCardProps> = ({
  file,
  tags,
  allTags,
  fileTagIds,
  isSelected,
  onToggle,
  onHideFile,
  onRevealInExplorer,
  onCopyPath,
  onCopyName,
  onOpenTagManager,
  onTagsChanged,
  repoPath
}) => {
  const actionsPopover = usePopoverToggle()
  const tagPopover = usePopoverToggle()
  const [tagSearchQuery, setTagSearchQuery] = useState('')
  const actionsBtnRef = useRef<HTMLButtonElement>(null)
  const tagBtnRef = useRef<HTMLButtonElement>(null)
  const tagsContainerRef = useRef<HTMLDivElement>(null)
  const directory = file.relativePath.includes('/')
    ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/') + 1)
    : ''
  const iconClass = getFileIconClass(file.name)

  // Alterna associação de tag via IPC, depois notifica o pai para recarregar
  const handleToggleTag = async (tagId: string) => {
    if (!repoPath) return
    const isActive = fileTagIds.includes(tagId)
    try {
      if (isActive) {
        await window.codeAwareness.removeFileTag(repoPath, file.relativePath, tagId)
      } else {
        await window.codeAwareness.setFileTag(repoPath, file.relativePath, tagId)
      }
      // INVARIANT: Dispara evento global para notificar todos os componentes sobre mudança de tags
      window.dispatchEvent(new CustomEvent('tags-changed'))
    } catch (err) {
      console.error('Erro ao alternar tag:', err)
    }
  }

  // Proteção contra undefined em allTags
  const safeAllTags = allTags || []
  // Tags que o arquivo possui (baseado na associação real via prop do pai)
  const fileTags = safeAllTags.filter(t => fileTagIds.includes(t.id))

  // Lista filtrada por nome (ignora maiúsculas); termo só de espaços não filtra nada
  const filteredTags = useMemo(() => {
    const q = tagSearchQuery.trim().toLowerCase()
    if (!q) return safeAllTags
    return safeAllTags.filter(t => t.name.toLowerCase().includes(q))
  }, [safeAllTags, tagSearchQuery])

  // Zera a busca ao fechar o popover (clique fora, ESC ou "Criar nova tag")
  useEffect(() => {
    if (!tagPopover.isOpen) setTagSearchQuery('')
  }, [tagPopover.isOpen])

  return (
    <div className={`file-card ${isSelected ? 'selected' : ''}`}>
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
          <div className="file-card-token-badge">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
            {file.tokenEstimate.toLocaleString('pt-BR')} tokens
          </div>
        )}
      </div>

      <div className="file-card-footer">
        <div className="file-card-tags" ref={tagsContainerRef}>
          {fileTags.map(tag => (
            <button
              key={tag.id}
              className="file-card-tag"
              style={{
                backgroundColor: `color-mix(in srgb, ${tag.color} 12%, transparent)`,
                borderColor: tag.color,
              }}
              onClick={tagPopover.toggle}
            >
              {tag.name}
            </button>
          ))}
          <button
            ref={tagBtnRef}
            className="file-card-add-tag-btn"
            onClick={tagPopover.toggle}
            title="Adicionar tag"
            aria-label="Adicionar tag"
          >
            <Plus size={12} strokeWidth={2} />
          </button>

          <Popover
            open={tagPopover.isOpen}
            anchorRef={tagsContainerRef}
            onClose={tagPopover.close}
            placement="auto-start"
          >
            <div className="file-card-tag-popover">
              <div className="fcp-search">
                <Search size={14} className="fcp-search-icon" />
                <input
                  className="fcp-search-input"
                  value={tagSearchQuery}
                  onChange={(e) => setTagSearchQuery(e.target.value)}
                  placeholder="Buscar tag..."
                  aria-label="Buscar tag"
                  autoFocus
                />
              </div>
              <div className="file-card-tag-popover-list">
                {safeAllTags.length === 0 && (
                  <div className="file-card-tag-popover-empty">Nenhuma tag criada</div>
                )}
                {filteredTags.length === 0 && tagSearchQuery.trim() && (
                  <div className="file-card-tag-popover-empty">Nenhuma tag encontrada</div>
                )}
                {filteredTags.map(tag => {
                  const isActive = fileTagIds.includes(tag.id)
                  return (
                    <button
                      key={tag.id}
                      className={`file-card-tag-popover-item ${isActive ? 'active' : ''}`}
                      onClick={() => handleToggleTag(tag.id)}
                      style={isActive ? { backgroundColor: `color-mix(in srgb, ${tag.color} 15%, transparent)` } : {}}
                    >
                      <span
                        className="file-card-tag-popover-dot"
                        style={{ backgroundColor: tag.color }}
                      />
                      <span className="file-card-tag-popover-name">{tag.name}</span>
                      {isActive && <Check size={14} strokeWidth={2} className="file-card-tag-popover-check" />}
                    </button>
                  )
                })}
              </div>
              <div className="file-card-tag-popover-footer">
                <button
                  className="file-card-tag-popover-create"
                  onClick={() => {
                    tagPopover.close()
                    onOpenTagManager?.()
                  }}
                >
                  <Plus size={12} strokeWidth={2} /> Criar nova tag
                </button>
              </div>
            </div>
          </Popover>
        </div>

        <div className="file-card-actions-right">
          <ToggleSwitch checked={isSelected} onChange={onToggle} />

          <button
            ref={actionsBtnRef}
            className="file-card-actions-btn"
            onClick={actionsPopover.toggle}
            title="Ações do arquivo"
            aria-label="Ações do arquivo"
            aria-haspopup="true"
            aria-expanded={actionsPopover.isOpen}
          >
            <MoreVertical size={16} strokeWidth={2} />
          </button>

          <Popover
            open={actionsPopover.isOpen}
            anchorRef={actionsBtnRef}
            onClose={actionsPopover.close}
            placement="auto-end"
          >
            <div className="file-card-actions-menu" role="menu" aria-label="Opções do arquivo">
              {onHideFile && (
                <button onClick={() => { onHideFile(); actionsPopover.close() }} role="menuitem">
                  <EyeOff size={14} strokeWidth={2} /> Ocultar
                </button>
              )}
              {onRevealInExplorer && (
                <button onClick={() => { onRevealInExplorer(); actionsPopover.close() }} role="menuitem">
                  <FolderOpen size={14} strokeWidth={2} /> Revelar no Sistema
                </button>
              )}
              {onCopyPath && (
                <button onClick={() => { onCopyPath(); actionsPopover.close() }} role="menuitem">
                  <Copy size={14} strokeWidth={2} /> Copiar Caminho
                </button>
              )}
              {onCopyName && (
                <button onClick={() => { onCopyName(); actionsPopover.close() }} role="menuitem">
                  <Copy size={14} strokeWidth={2} /> Copiar Nome
                </button>
              )}
            </div>
          </Popover>
        </div>
      </div>
    </div>
  )
}