/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar o gatilho de filtro como Button variant="ghost" com ícone de funil e badge numérico.
2. Renderizar o balão de filtros via Popover (portal) com a pele padronizada am-menu/am-item.
3. Gerenciar abertura/fechamento do balão — o Popover gerencia clique-fora, ESC, scroll e resize.

Mapa de Relacionamentos do Script

1. FilterPopover.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos com prefixo fp- (apenas badge e ativo).
   - Criticidade: Alta

2. Button (shared)
   - Tipo: Dependência Direta
   - Relação: Gatilho do filtro usa Button variant="ghost" com forwardRef.
   - Criticidade: Alta

3. Popover (shared)
   - Tipo: Dependência Direta
   - Relação: Balão do filtro usa Popover com portal, substituindo listeners manuais.
   - Criticidade: Alta

4. ViewToolbar.tsx
   - Tipo: Dependência Inversa
   - Relação: É instanciado pela ViewToolbar como filterSlot.
   - Criticidade: Média

Invariantes do Script

1. Não saber o que são os filtros — apenas gerencia abrir/fechar e renderiza children.
2. O Popover gerencia o fechamento (clique-fora, ESC, scroll, resize) — sem listeners manuais.
3. O closeOnSelect é implementado via onClick no .am-menu.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useState, useRef, useCallback } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { Button } from '../Button/Button'
import { Popover } from '../Popover/Popover'
import './FilterPopover.css'

interface FilterPopoverProps {
  activeCount: number
  children: React.ReactNode
  label?: string
  closeOnSelect?: boolean
}

export const FilterPopover: React.FC<FilterPopoverProps> = ({
  activeCount,
  children,
  label = 'Filtros',
  closeOnSelect = false
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)

  const handleClose = useCallback(() => {
    setIsOpen(false)
  }, [])

  const handleToggle = useCallback(() => {
    setIsOpen(prev => !prev)
  }, [])

  return (
    <>
      <Button
        variant="ghost"
        icon={<SlidersHorizontal size={16} strokeWidth={2} />}
        ref={anchorRef}
        onClick={handleToggle}
        aria-expanded={isOpen}
        aria-haspopup="true"
        aria-label={`${label}${activeCount > 0 ? ` (${activeCount} ativo${activeCount !== 1 ? 's' : ''})` : ''}`}
        className="fp-trigger"
      >
        {label}
        {activeCount > 0 && (
          <span className="fp-badge">{activeCount}</span>
        )}
      </Button>

      <Popover
        open={isOpen}
        anchorRef={anchorRef}
        onClose={handleClose}
        placement="auto-start"
      >
        <div className="am-menu" role="menu" aria-label={label} onClick={closeOnSelect ? handleClose : undefined}>
          {children}
        </div>
      </Popover>
    </>
  )
}