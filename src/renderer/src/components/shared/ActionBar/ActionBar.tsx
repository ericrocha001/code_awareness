/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar a Camada 2: faixa horizontal com encaixes esquerdo e direito.
2. Organizar os slots left e right com space-between, sem renderizar botões próprios.

Mapa de Relacionamentos do Script

1. ActionBar.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos com prefixo ab-.
   - Criticidade: Alta

Invariantes do Script

1. Não renderizar botões próprios — apenas organizar os encaixes.
2. O encaixe esquerdo pode ficar vazio (renderiza null).

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import './ActionBar.css'

interface ActionBarProps {
  left?: React.ReactNode
  right: React.ReactNode
  className?: string
}

export const ActionBar: React.FC<ActionBarProps> = ({
  left,
  right,
  className = ''
}) => {
  return (
    <div className={`ab-root${className ? ` ${className}` : ''}`}>
      <div className="ab-left">
        {left}
      </div>
      <div className="ab-right">
        {right}
      </div>
    </div>
  )
}