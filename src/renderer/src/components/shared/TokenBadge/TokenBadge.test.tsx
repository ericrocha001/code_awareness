// @vitest-environment jsdom
/*
-T ---
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
