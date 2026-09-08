/*
-T ---
*/

import React from 'react'
import './TokenBadge.css'

export interface TokenBadgeProps {
  tokens: number
  formatTokenCount?: (count: number) => string
}

const defaultFormat = (count: number) => count.toLocaleString('pt-BR')

export const TokenBadge: React.FC<TokenBadgeProps> = ({
  tokens,
  formatTokenCount = defaultFormat
}) => {
  if (!tokens || tokens <= 0) return null

  return (
    <span className="token-badge">
      <svg className="token-badge-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
      <span className="token-badge-count">{formatTokenCount(tokens)}</span>
      <span className="token-badge-label">tokens</span>
    </span>
  )
}
