/*
-T ---
*/

import React from 'react'
import './StatusStrip.css'

type StatusType = 'watching' | 'error' | 'not-git' | 'loading' | null

interface StatusStripProps {
  status: StatusType
  message?: string
}

const STATUS_CONFIG: Record<NonNullable<StatusType>, { icon: string; defaultMessage: string; className: string }> = {
  watching: {
    icon: '●',
    defaultMessage: 'Monitorando alterações',
    className: 'ss-watching'
  },
  error: {
    icon: '⚠',
    defaultMessage: 'Erro no monitoramento',
    className: 'ss-error'
  },
  'not-git': {
    icon: 'ℹ',
    defaultMessage: 'Este diretório não é um repositório Git',
    className: 'ss-not-git'
  },
  loading: {
    icon: '◌',
    defaultMessage: 'Carregando arquivos...',
    className: 'ss-loading'
  }
}

export const StatusStrip: React.FC<StatusStripProps> = ({ status, message }) => {
  if (status === null) return null

  const config = STATUS_CONFIG[status]

  return (
    <div className={`ss-root ${config.className}`}>
      <span aria-hidden="true">{config.icon}</span>
      <span>{message ?? config.defaultMessage}</span>
    </div>
  )
}