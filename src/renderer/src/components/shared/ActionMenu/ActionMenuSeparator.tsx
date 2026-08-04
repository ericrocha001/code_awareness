/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar um separador visual (div) com altura 1px, cor da borda, margem vertical generosa e largura total.

Mapa de Relacionamentos do Script

1. ActionMenuSeparator.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos com prefixo am-separator.
   - Criticidade: Alta

2. ActionMenu.tsx
   - Tipo: Dependência Inversa
   - Relação: Renderizado como filho dentro do balão am-menu.
   - Criticidade: Baixa

Invariantes do Script

1. O separador é um div simples — sem props.
2. A margem vertical é ≥ 8px (respiro generoso).
3. A largura é 100% (full-bleed) para combinar com as faixas.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import './ActionMenuSeparator.css'

export const ActionMenuSeparator: React.FC = () => {
  return <div className="am-separator" role="separator" />
}

ActionMenuSeparator.displayName = 'ActionMenuSeparator'