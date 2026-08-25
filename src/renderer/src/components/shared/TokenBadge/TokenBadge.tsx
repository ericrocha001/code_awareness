/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar a contagem de tokens em formato de badge com ícone temático de raio (TokenBadge).
2. Ocultar automaticamente a renderização quando a contagem de tokens for menor ou igual a zero.
3. Formatar os valores numéricos com separadores de milhar via pt-BR ou formatador customizado.

Mapa de Relacionamentos do Script

1. TokenBadge.css
   - Tipo: Relação de UI
   - Relação: Fornece classes de estilo com fundo fit-content.
   - Criticidade: Alta

2. FileCard.tsx / FileRow.tsx
   - Tipo: Dependência Inversa
   - Relação: Componentes de visualização de arquivos que consomem TokenBadge.
   - Criticidade: Alta

Invariantes do Script

1. Se tokens <= 0 ou valor inválido, retorna null sem gerar nós DOM.
2. O badge encerra seu background estritamente no término do seu conteúdo textual (fit-content).

--- FIM ARQUITETURA DO SCRIPT ---
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
