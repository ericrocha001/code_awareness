/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar um menu suspenso autocontido com gatilho em estilo pílula e balão via Popover (portal, imune a corte).
2. Gerenciar estado interno de abertura/fechamento (useState) — sem prop open externa.
3. Impedir que o ESC feche o drawer pai registrando listener na fase de captura com stopImmediatePropagation.

Mapa de Relacionamentos do Script

1. Popover.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza o balão do menu via portal em document.body.
   - Criticidade: Alta

2. ChevronDown (lucide-react)
   - Tipo: Dependência Direta
   - Relação: Ícone de seta que gira 180° quando o menu está aberto.
   - Criticidade: Baixa

3. ActionMenu.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos com prefixo am-.
   - Criticidade: Alta

4. ActionMenuItem.tsx, ActionMenuSeparator.tsx
   - Tipo: Dependência Inversa
   - Relação: Filhos renderizados dentro do balão am-menu.
   - Criticidade: Alta

Invariantes do Script

1. O componente é autocontido — estado open é interno, sem prop externa.
2. O ESC registrado na fase de captura (addEventListener com true) executa stopImmediatePropagation, impedindo que o drawer pai também feche.
3. closeOnSelect (default true) fecha o menu ao clicar em qualquer filho via onClick no .am-menu.
4. Clicar no gatilho com o menu aberto alterna o estado — não causa "pisca" de fechar-e-reabrir (o Popover não fecha ao clicar na âncora).
5. Abrir um menu irmão fecha este de graça — o Popover fecha ao clicar fora (e a âncora do irmão está "fora").
6. Nenhum hook é condicional — apenas o retorno JSX é condicional.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useState, useRef, useEffect } from 'react'
import { Popover, type PopoverPlacement } from '../Popover/Popover'
import { Button } from '../Button/Button'
import './ActionMenu.css'

interface ActionMenuProps {
  icon: React.ReactNode
  label: React.ReactNode
  children: React.ReactNode
  disabled?: boolean
  placement?: PopoverPlacement
  closeOnSelect?: boolean
  className?: string
}

export const ActionMenu: React.FC<ActionMenuProps> = ({
  icon,
  label,
  children,
  disabled = false,
  placement = 'auto-start',
  closeOnSelect = true,
  className = ''
}) => {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const handleToggle = () => {
    if (!disabled) setOpen(prev => !prev)
  }

  // ESC em captura: impede que o ESC feche o drawer junto com o menu
  useEffect(() => {
    if (!open) return
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        setOpen(false)
      }
    }
    document.addEventListener('keydown', handleEsc, true)
    return () => document.removeEventListener('keydown', handleEsc, true)
  }, [open])

  return (
    <>
      <Button
        ref={buttonRef}
        variant="pill"
        icon={icon}
        chevron
        open={open}
        onClick={handleToggle}
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        className={className}
      >
        {label}
      </Button>

      <Popover
        open={open}
        anchorRef={buttonRef}
        onClose={() => setOpen(false)}
        placement={placement}
      >
        <div className="am-menu" role="menu" onClick={closeOnSelect ? () => setOpen(false) : undefined}>
          {children}
        </div>
      </Popover>
    </>
  )
}

ActionMenu.displayName = 'ActionMenu'