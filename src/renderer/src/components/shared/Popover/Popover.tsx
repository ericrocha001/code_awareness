/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar conteúdo flutuante via portal no document.body, fora do fluxo DOM do container pai.
2. Posicionar o balão dinamicamente a partir da âncora, escolhendo lado vertical (acima/abaixo) conforme o espaço livre na janela.
3. Gerenciar o ciclo de vida de fechamento: clique fora (excluindo âncora e balão), tecla ESC, rolagem externa ao popover e redimensionamento da janela.
4. Aplicar clamp nas quatro bordas da janela para garantir que o balão nunca ultrapasse a área visível.

Mapa de Relacionamentos do Script

1. Popover.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos com prefixo pop-.
   - Criticidade: Alta

2. createPortal (react-dom)
   - Tipo: Dependência Direta
   - Relação: Renderiza o conteúdo no document.body.
   - Criticidade: Alta

Invariantes do Script

1. Nunca renderiza no DOM normal — a saída é sempre via portal para document.body.
2. Quando open é false, retorna null e não registra ouvintes de evento.
3. Todo ouvinte de evento registrado (mousedown, keydown, scroll, resize) é removido na limpeza do efeito.
4. O posicionamento nunca deixa o balão sair da janela: clamp com margem mínima de 8px nas quatro bordas.
5. O componente não conhece o conteúdo do children — apenas posiciona o que recebe.
6. Clique na âncora não dispara onClose.
7. Clique dentro do balão não dispara onClose.
8. A medição de geometria usa useLayoutEffect (síncrono, antes da pintura) para evitar flash visual.
9. Todos os hooks ficam no topo, incondicionais — o return null é apenas no JSX.
10. A posição é calculada uma única vez por abertura; conteúdo de tamanho variável enquanto aberto não é reposicionado automaticamente.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import './Popover.css'

export type PopoverPlacement =
  | 'top-start'
  | 'top-end'
  | 'bottom-start'
  | 'bottom-end'
  | 'auto-start'
  | 'auto-end'

interface PopoverProps {
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  children: React.ReactNode
  placement?: PopoverPlacement
  offset?: number
}

const MARGIN = 8

type Coords = { top: number; left: number } | null

export const Popover: React.FC<PopoverProps> = ({
  open,
  anchorRef,
  onClose,
  children,
  placement = 'auto-start',
  offset = 8
}) => {
  const popoverRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [coords, setCoords] = useState<Coords>(null)
  const [measured, setMeasured] = useState(false)

  // --- Medição de geometria (síncrona, antes da pintura) ---
  useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      setMeasured(false)
      setCoords(null)
      return
    }

    const anchor = anchorRef.current
    const popoverEl = popoverRef.current
    if (!popoverEl) return

    const anchorRect = anchor.getBoundingClientRect()
    const popoverRect = popoverEl.getBoundingClientRect()

    const windowWidth = window.innerWidth
    const windowHeight = window.innerHeight

    // Determinar lado vertical
    const spaceBelow = windowHeight - anchorRect.bottom
    const spaceAbove = anchorRect.top

    let vertical: 'top' | 'bottom'
    if (placement.startsWith('auto')) {
      vertical = spaceBelow >= spaceAbove ? 'bottom' : 'top'
    } else {
      vertical = placement.startsWith('top') ? 'top' : 'bottom'
    }

    // Alinhamento horizontal
    const alignEnd = placement.endsWith('end')
    const baloonW = popoverRect.width
    const baloonH = popoverRect.height

    let left: number
    if (alignEnd) {
      left = anchorRect.right - baloonW
    } else {
      left = anchorRect.left
    }

    let top: number
    if (vertical === 'bottom') {
      top = anchorRect.bottom + offset
    } else {
      top = anchorRect.top - offset - baloonH
    }

    // Clamp nas quatro bordas
    left = Math.max(MARGIN, Math.min(left, windowWidth - baloonW - MARGIN))
    top = Math.max(MARGIN, Math.min(top, windowHeight - baloonH - MARGIN))

    setCoords({ top, left })
    setMeasured(true)
  }, [open, placement, offset, anchorRef])

  // --- Ouvintes de fechamento ---
  useEffect(() => {
    if (!open) return

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      const inBaloon = popoverRef.current?.contains(target)
      const inAnchor = anchorRef.current?.contains(target)

      if (!inBaloon && !inAnchor) {
        onCloseRef.current()
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current()
      }
    }

    const handleScroll = (e: Event) => {
      // Ignorar scrolls originados dentro do próprio popover (ex.: lista rolável de tags)
      const target = e.target as Node
      if (popoverRef.current?.contains(target)) return
      onCloseRef.current()
    }

    const handleResize = () => {
      onCloseRef.current()
    }

    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('scroll', handleScroll, { capture: true })
    window.addEventListener('resize', handleResize)

    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('scroll', handleScroll, { capture: true })
      window.removeEventListener('resize', handleResize)
    }
  }, [open, anchorRef])

  // Sem hooks condicionais — apenas retorno condicional
  if (!open) return null

  return createPortal(
    <div
      ref={popoverRef}
      className={`pop-root${!measured ? ' pop-hidden' : ''}`}
      style={
        coords
          ? { top: coords.top, left: coords.left }
          : undefined
      }
    >
      {children}
    </div>,
    document.body
  )
}