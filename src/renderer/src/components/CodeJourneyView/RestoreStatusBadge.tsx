/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar um selo compacto de status de checkpoint (restaurado, revertido ou ativo).
2. Exibir o status com data/hora formatada em português.
3. Ser autocontido e removível — apagar o arquivo e seus imports remove o selo de toda a interface.

Mapa de Relacionamentos do Script

1. RestoreStatusBadge.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos definidos no arquivo CSS correspondente.
   - Criticidade: Alta

2. ../../../../shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Fornece o tipo CheckpointStatus.
   - Criticidade: Alta

Invariantes do Script

1. Componente puramente apresentacional — sem lógica de negócio, sem estado, sem IPC.
2. Renderiza para os três status; a decisão de exibir ou não cabe ao pai.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import { CheckpointStatus } from '../../../../shared/types'
import { formatDate } from './checkpointUtils'
import './RestoreStatusBadge.css'

interface RestoreStatusBadgeProps {
  status: CheckpointStatus
  statusAt: string
}

/**
 * Mapeia status para rótulo em português.
 */
function getStatusLabel(status: CheckpointStatus): string {
  switch (status) {
    case 'restored': return 'Restaurado'
    case 'reverted': return 'Revertido'
    case 'active': return 'Implementado'
  }
}

/**
 * Selo compacto de status de checkpoint.
 * Exibe o nome do status e a data/hora em que o status foi definido.
 */
export const RestoreStatusBadge: React.FC<RestoreStatusBadgeProps> = ({ status, statusAt }) => {
  const label = getStatusLabel(status)
  const date = formatDate(statusAt)

  return (
    <span className={`rsb-badge rsb-${status}`} title={`${label} em ${date}`}>
      {label} em {date}
    </span>
  )
}

RestoreStatusBadge.displayName = 'RestoreStatusBadge'