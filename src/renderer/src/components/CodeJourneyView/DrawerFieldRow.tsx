/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar uma linha de ficha com rótulo à esquerda e valor à direita.
2. Suportar ícone opcional à esquerda do rótulo.
3. Aplicar destaque cromático opcional ao valor via prop accent.

Mapa de Relacionamentos do Script

1. ImplementationHeader.tsx
   - Tipo: Dependência Inversa
   - Relação: Compõe múltiplas DrawerFieldRow dentro da ficha de identidade.
   - Criticidade: Alta

2. DrawerFieldRow.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos definidos neste arquivo.
   - Criticidade: Alta

Invariantes do Script

1. Componente puramente apresentacional — sem estado, sem IPC, sem lógica de negócio.
2. A divisória inferior é responsabilidade do container que empilha as linhas, não desta linha.
3. O valor (ReactNode) nunca é truncado internamente — o pai controla o overflow.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import './DrawerFieldRow.css'

interface DrawerFieldRowProps {
  icon?: React.ReactNode
  label: string
  value: React.ReactNode
  accent?: boolean
}

/**
 * Linha de ficha: ícone + rótulo cinza à esquerda, valor à direita.
 * Usada para montar fichas de metadados (Status, Criado em, etc.).
 */
export const DrawerFieldRow: React.FC<DrawerFieldRowProps> = ({ icon, label, value, accent }) => {
  return (
    <div className="df-row">
      <span className="df-label">
        {icon && <span className="df-icon">{icon}</span>}
        {label}
      </span>
      <span className={`df-value${accent ? ' df-value--accent' : ''}`}>
        {value}
      </span>
    </div>
  )
}

DrawerFieldRow.displayName = 'DrawerFieldRow'
