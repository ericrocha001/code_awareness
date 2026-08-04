/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar uma faixa de menu (role="menuitem") com ícone opcional e label.
2. Suportar estado de perigo (danger) com cor vermelha no texto e ícone.
3. Suportar estado desabilitado.

Mapa de Relacionamentos do Script

1. ActionMenuItem.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos com prefixo am-item.
   - Criticidade: Alta

2. ActionMenu.tsx
   - Tipo: Dependência Inversa
   - Relação: Renderizado como filho dentro do balão am-menu.
   - Criticidade: Alta

Invariantes do Script

1. O ícone é opcional — se não fornecido, o span am-item-icon não é renderizado.
2. O onClick é passado diretamente ao button — a ordem de execução é: onClick do item → bubbling até .am-menu (que fecha o menu se closeOnSelect).
3. O ícone usa currentColor via lucide — a cor é controlada pelo CSS do .am-item-icon.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import './ActionMenuItem.css'

interface ActionMenuItemProps {
  icon?: React.ReactNode
  children: React.ReactNode
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
}

export const ActionMenuItem: React.FC<ActionMenuItemProps> = ({
  icon,
  children,
  onClick,
  danger = false,
  disabled = false
}) => {
  return (
    <button
      type="button"
      className={`am-item${danger ? ' am-item--danger' : ''}`}
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
    >
      {icon && <span className="am-item-icon">{icon}</span>}
      <span className="am-item-label">{children}</span>
    </button>
  )
}

ActionMenuItem.displayName = 'ActionMenuItem'