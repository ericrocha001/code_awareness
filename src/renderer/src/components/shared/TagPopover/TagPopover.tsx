/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar o balão de edição de tags via Popover compartilhado (com ou sem gatilho "+" nativo em modo controlado).
2. Gerenciar busca local de tags por nome, zerada sempre que o balão fecha.
3. Oferecer navegação por teclado (↑/↓ movem o destaque visual, Enter alterna a tag destacada).
4. Persistir a associação arquivo ↔ tag via IPC e sincronizar via evento global e callback.

Mapa de Relacionamentos do Script

1. TagPopover.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos com prefixo tp-.
   - Criticidade: Alta

2. Popover.tsx (shared)
   - Tipo: Dependência Direta
   - Relação: Posiciona o balão via portal e gerencia clique-fora, ESC, scroll e resize.
   - Criticidade: Alta

3. ActivePopover.tsx (FileCollection)
   - Tipo: Dependência Inversa
   - Relação: Consome o TagPopover em modo controlado sob demanda.
   - Criticidade: Alta

4. TagManagerModal.tsx
   - Tipo: Fluxo de Dados
   - Relação: É aberto via onOpenTagManager ao clicar em "Criar nova tag".
   - Criticidade: Média

Invariantes do Script

1. A alternância de tag sempre persiste via IPC (setFileTag/removeFileTag) e dispara o evento global tags-changed.
2. O destaque por teclado é puramente visual — a seleção real é o conjunto activeTagIds recebido do pai.
3. A busca é local, não persiste e zera ao fechar o balão.
4. Quando anchorRef é fornecido externamente (modo controlado), o gatilho '+' interno não é renderizado.
5. Nenhum hook é condicional — todos ficam no topo, incondicionais.
6. O balão permanece aberto ao alternar tags para permitir multi-seleção.

--- FIM ARQUITETURA DO SCRIPT ---
*/
import React, { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from 'react'
import { Plus, Check, Search } from 'lucide-react'
import { Tag } from '../../../../../shared/types'
import { Popover } from '../Popover/Popover'
import './TagPopover.css'

export interface TagPopoverProps {
  repoPath?: string
  relativePath: string
  allTags: Tag[]
  activeTagIds: string[]
  onTagsChanged?: () => void
  onOpenTagManager?: () => void
  /** Modo controlado: ref da âncora externa */
  anchorRef?: React.RefObject<HTMLElement | null>
  /** Modo controlado: callback de fechamento */
  onClose?: () => void
  /** Modo controlado: estado explícito de abertura (padrão true se anchorRef fornecido) */
  open?: boolean
}

export const TagPopover: React.FC<TagPopoverProps> = ({
  repoPath,
  relativePath,
  allTags,
  activeTagIds,
  onTagsChanged,
  onOpenTagManager,
  anchorRef,
  onClose,
  open
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const isControlled = anchorRef !== undefined
  const effectiveIsOpen = isControlled ? (open ?? true) : isOpen
  const effectiveAnchorRef = isControlled ? anchorRef : triggerRef

  const handleEffectiveClose = useCallback(() => {
    if (isControlled) {
      onClose?.()
    } else {
      setIsOpen(false)
    }
  }, [isControlled, onClose])

  const handleToggle = useCallback(() => setIsOpen(prev => !prev), [])

  const safeAllTags = allTags || []

  // Filtro local por nome (ignora maiúsculas); termo só de espaços não filtra nada
  const filteredTags = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return safeAllTags
    return safeAllTags.filter(t => t.name.toLowerCase().includes(q))
  }, [safeAllTags, searchQuery])

  // Ao abrir, foca a busca e reseta o destaque; ao fechar, zera a busca (invariante).
  // useLayoutEffect roda antes do paint para o input já estar visível ao receber o foco.
  useLayoutEffect(() => {
    if (effectiveIsOpen) {
      setHighlightedIndex(0)
      inputRef.current?.focus()
    } else {
      setSearchQuery('')
    }
  }, [effectiveIsOpen])

  // Sempre que a filtragem muda, limpa o array de refs (evitando referências a elementos
  // já desmontados) e reseta o destaque para o primeiro item visível
  useEffect(() => {
    itemRefs.current = []
    setHighlightedIndex(0)
  }, [filteredTags])

  // Torna o item destacado visível sem roubar o foco do input de busca;
  // preventScroll evita rolar a janela inteira em janelas pequenas.
  useEffect(() => {
    const el = itemRefs.current[highlightedIndex]
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', preventScroll: true })
    }
  }, [highlightedIndex, filteredTags, effectiveIsOpen])

  // Persiste a associação via IPC e notifica todos os consumidores (sincronização entre abas)
  const handleToggleTag = async (tagId: string) => {
    if (!repoPath) return
    const isActive = activeTagIds.includes(tagId)
    try {
      if (isActive) {
        await window.codeAwareness.removeFileTag(repoPath, relativePath, tagId)
      } else {
        await window.codeAwareness.setFileTag(repoPath, relativePath, tagId)
      }
      // INVARIANT: Dispara evento global e chama o callback do pai para recarregar tags
      window.dispatchEvent(new CustomEvent('tags-changed'))
      onTagsChanged?.()
    } catch (err) {
      console.error('Erro ao alternar tag:', err)
    }
  }

  const handleBalloonKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement
    const isButton = Boolean(target.closest('button'))
    const count = filteredTags.length

    if (e.key === 'ArrowDown') {
      // Setas sempre movem o destaque e suprimem o default, mesmo com foco em botão interno
      e.preventDefault()
      if (count === 0) return
      setHighlightedIndex((prev) => (prev + 1) % count)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (count === 0) return
      setHighlightedIndex((prev) => (prev - 1 + count) % count)
    } else if (e.key === 'Enter') {
      // Enter: se o foco estiver em um botão, o clique nativo do botão prevalece para não duplicar
      if (isButton) return
      e.preventDefault()
      const tag = filteredTags[highlightedIndex]
      if (tag) handleToggleTag(tag.id)
    }
  }

  return (
    <>
      {!isControlled && (
        <button
          ref={triggerRef}
          className="tp-trigger"
          onClick={handleToggle}
          title="Adicionar tag"
          aria-label="Adicionar tag"
          aria-haspopup="true"
          aria-expanded={effectiveIsOpen}
        >
          <Plus size={12} strokeWidth={2} />
        </button>
      )}

      <Popover
        open={effectiveIsOpen}
        anchorRef={effectiveAnchorRef}
        onClose={handleEffectiveClose}
        placement="auto-start"
      >
        <div className="tp-popover" onKeyDown={handleBalloonKeyDown}>
          <div className="tp-search">
            <Search size={14} className="tp-search-icon" />
            <input
              ref={inputRef}
              className="tp-search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar tag..."
              aria-label="Buscar tag"
            />
          </div>
          <div className="tp-popover-list">
            {safeAllTags.length === 0 && (
              <div className="tp-popover-empty">Nenhuma tag criada</div>
            )}
            {filteredTags.length === 0 && searchQuery.trim() && (
              <div className="tp-popover-empty">Nenhuma tag encontrada</div>
            )}
            {filteredTags.map((tag, index) => {
              const isActive = activeTagIds.includes(tag.id)
              const isHighlighted = index === highlightedIndex
              return (
                <button
                  key={tag.id}
                  ref={(el) => { itemRefs.current[index] = el }}
                  className={`tp-item${isActive ? ' active' : ''}${isHighlighted ? ' highlighted' : ''}`}
                  onClick={() => handleToggleTag(tag.id)}
                  style={isActive ? { backgroundColor: `color-mix(in srgb, ${tag.color} 15%, transparent)` } : {}}
                >
                  <span
                    className="tp-dot"
                    style={{ backgroundColor: tag.color }}
                  />
                  <span className="tp-name">{tag.name}</span>
                  {isActive && <Check size={14} strokeWidth={2} className="tp-check" />}
                </button>
              )
            })}
          </div>
          <div className="tp-footer">
            <button
              className="tp-create"
              onClick={() => {
                handleEffectiveClose()
                onOpenTagManager?.()
              }}
            >
              <Plus size={12} strokeWidth={2} /> Criar nova tag
            </button>
          </div>
        </div>
      </Popover>
    </>
  )
}