// @vitest-environment jsdom
/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar que TokenBadge renderiza a contagem formatada quando há tokens positivos.
2. Garantir que TokenBadge não renderiza nenhum nó DOM quando tokens <= 0.
3. Verificar que o container possui a classe .token-badge com comportamento fit-content.

Mapa de Relacionamentos do Script

1. TokenBadge.tsx
   - Tipo: Dependência Direta
   - Relação: Componente sob teste.
   - Criticidade: Alta

Invariantes do Script

1. tokens <= 0 deve retornar null (sem nós DOM).
2. formatTokenCount customizado é utilizado quando fornecido.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TokenBadge } from './TokenBadge'

describe('TokenBadge', () => {
  it('1. Renderiza contagem formatada quando tokens > 0', () => {
    render(<TokenBadge tokens={1500} />)
    // Formato pt-BR: 1.500
    expect(screen.getByText('1.500')).toBeTruthy()
    expect(screen.getByText('tokens')).toBeTruthy()
  })

  it('2. Não renderiza nenhum elemento quando tokens = 0', () => {
    const { container } = render(<TokenBadge tokens={0} />)
    expect(container.firstChild).toBeNull()
  })

  it('3. Não renderiza nenhum elemento quando tokens < 0', () => {
    const { container } = render(<TokenBadge tokens={-10} />)
    expect(container.firstChild).toBeNull()
  })

  it('4. Usa formatTokenCount customizado quando fornecido', () => {
    const customFormat = vi.fn(() => '~1.5K')
    render(<TokenBadge tokens={1500} formatTokenCount={customFormat} />)
    expect(customFormat).toHaveBeenCalledWith(1500)
    expect(screen.getByText('~1.5K')).toBeTruthy()
  })

  it('5. Container possui a classe token-badge (fit-content via CSS)', () => {
    render(<TokenBadge tokens={500} />)
    const badge = screen.getByText('500').closest('.token-badge')
    expect(badge).toBeTruthy()
  })
})
