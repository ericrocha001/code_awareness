// @vitest-environment jsdom
/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar que TagChip renderiza o nome da tag com background e cor de texto fornecidos pela paleta.
2. Garantir que o clique opcional chama o handler quando fornecido.
3. Verificar ausência de borda sólida no chip (estilo preenchido).

Mapa de Relacionamentos do Script

1. TagChip.tsx
   - Tipo: Dependência Direta
   - Relação: Componente sob teste.
   - Criticidade: Alta

2. color-utils.ts
   - Tipo: Dependência Direta
   - Relação: Provê a paleta via resolveTagPalette.
   - Criticidade: Alta

Invariantes do Script

1. O chip sempre renderiza o nome integral da tag sem truncamento.
2. As cores são aplicadas como inline style — não como classe CSS estática.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TagChip } from './TagChip'
import type { Tag } from '../../../../../shared/types'

const mockTag: Tag = { id: 'tag-1', name: 'Frontend', color: '#3b82f6' }

// useTheme usa matchMedia e localStorage; mocks mínimos para jsdom
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    })
  })
})

afterEach(() => {
  cleanup()
})

describe('TagChip', () => {
  it('1. Renderiza o nome da tag', () => {
    const { getByText } = render(<TagChip tag={mockTag} />)
    expect(getByText('Frontend')).toBeTruthy()
  })

  it('2. Aplica backgroundColor e color como inline style (paleta do tema)', () => {
    const { getByText } = render(<TagChip tag={mockTag} />)
    const chip = getByText('Frontend')
    expect(chip.style.backgroundColor).toBeTruthy()
    expect(chip.style.color).toBeTruthy()
  })

  it('3. Não possui borda sólida própria (renderização preenchida)', () => {
    const { getByText } = render(<TagChip tag={mockTag} />)
    const chip = getByText('Frontend')
    // border deve ser vazio (no border) — a class .tag-chip tem border: none
    expect(chip.style.border).toBe('')
  })

  it('4. Sem onClick: não tem role button nem tabIndex', () => {
    const { getByText } = render(<TagChip tag={mockTag} />)
    const chip = getByText('Frontend')
    expect(chip.getAttribute('role')).toBeNull()
    expect(chip.getAttribute('tabindex')).toBeNull()
  })

  it('5. Com onClick: tem role=button e dispara handler ao clicar', () => {
    const handler = vi.fn()
    const { getByRole } = render(<TagChip tag={mockTag} onClick={handler} />)
    const chip = getByRole('button')
    expect(chip.textContent?.trim()).toBe('Frontend')
    fireEvent.click(chip)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
