/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar faixa de feedback visual com ícone e texto indicando o status do watcher.
2. Exibir diferentes estados: watching, error, not-git, loading.
3. Não renderizar nada quando status é null.

Mapa de Relacionamentos do Script

1. StatusStrip.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos com prefixo ss-.
   - Criticidade: Alta

2. CodeDiffView.tsx
   - Tipo: Dependência Inversa
   - Relação: É instanciado pelo CodeDiffView para exibir status do watcher.
   - Criticidade: Alta

Invariantes do Script

1. O StatusStrip nunca gerencia estado próprio — apenas recebe status e message via props.
2. Quando status é null, retorna null (não renderiza nada).
3. Ícones são textuais (emoji/símbolo) — sem dependência de bibliotecas de ícone.

--- FIM ARQUITETURA DO SCRIPT ---
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