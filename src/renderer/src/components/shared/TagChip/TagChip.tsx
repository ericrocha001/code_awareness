/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar um chip de tag compartilhado (TagChip) com fundo preenchido e cor de texto com contraste garantido.
2. Resolver dinamicamente a paleta de cores adequada para o tema ativo (claro ou escuro).
3. Suportar evento de clique opcional tornando o chip acessível com papel de botão.

Mapa de Relacionamentos do Script

1. TagChip.css
   - Tipo: Relação de UI
   - Relação: Fornece classes de estilo e tamanho universal do chip.
   - Criticidade: Alta

2. ../../../hooks/useTheme.ts
   - Tipo: Dependência Direta
   - Relação: Fornece o tema ativo resolvido (effectiveTheme).
   - Criticidade: Alta

3. ../../../utils/color-utils.ts
   - Tipo: Dependência Direta
   - Relação: Fornece a função resolveTagPalette para cálculo da paleta contrastante.
   - Criticidade: Alta

4. ../../../../../shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Fornece a interface de dados Tag.
   - Criticidade: Alta

Invariantes do Script

1. O chip sempre renderiza o nome integral da tag sem truncamento (preservação da Invariante D9).
2. As cores de fundo e texto são sempre calculadas pela função pura resolveTagPalette para o tema ativo.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import { useTheme } from '../../../hooks/useTheme'
import { resolveTagPalette } from '../../../utils/color-utils'
import type { Tag } from '../../../../../shared/types'
import './TagChip.css'

export interface TagChipProps {
  tag: Tag
  onClick?: () => void
}

export const TagChip: React.FC<TagChipProps> = ({ tag, onClick }) => {
  const { effectiveTheme, theme } = useTheme()
  const currentTheme = (effectiveTheme || (theme === 'light' ? 'light' : 'dark')) as 'light' | 'dark'
  const palette = resolveTagPalette(tag.color, currentTheme)

  return (
    <span
      className="tag-chip"
      style={{
        backgroundColor: palette.background,
        color: palette.text
      }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {tag.name}
    </span>
  )
}
