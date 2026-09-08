// @vitest-environment jsdom
/*
-T ---
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
