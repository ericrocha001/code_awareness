/*
-T ---
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