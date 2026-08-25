// @vitest-environment jsdom
/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar o comportamento de guarda de teclado em fase de captura do componente Popover compartilhado.
2. Comprovar que teclas de navegação originadas fora do balão têm seu comportamento padrão e propagação suprimidos.
3. Comprovar que eventos originados dentro do balão são preservados e chegam aos handlers internos.
4. Garantir a regressão de fechamento via tecla Escape e a limpeza correta de ouvintes ao desmontar/fechar.

Mapa de Relacionamentos do Script

1. Popover.tsx
   - Tipo: Dependência Direta
   - Relação: Componente sob teste.
   - Criticidade: Alta

2. @testing-library/react
   - Tipo: Dependência Direta
   - Relação: Fornece utilitários de renderização e disparo de eventos de DOM.
   - Criticidade: Alta

Invariantes do Script

1. Quando aberto, nenhuma tecla do conjunto gerenciado originada fora do balão propaga ou executa ação padrão.
2. Ao fechar, todos os listeners no document/window são desregistrados.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useRef } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Popover } from './Popover'

const TestWrapper: React.FC<{
  open: boolean
  onClose?: () => void
  children?: React.ReactNode
}> = ({ open, onClose = vi.fn(), children }) => {
  const anchorRef = useRef<HTMLButtonElement>(null)
  return (
    <div>
      <button ref={anchorRef} data-testid="anchor-btn">
        Anchor
      </button>
      <input data-testid="outside-input" placeholder="Outside" />
      <Popover open={open} anchorRef={anchorRef} onClose={onClose}>
        {children || <div data-testid="popover-content">Popover Content</div>}
      </Popover>
    </div>
  )
}

describe('Popover — Guarda de Teclado e Ciclo de Vida', () => {
  afterEach(() => {
    cleanup()
  })

  it('1. Popover aberto + tecla de navegação fora do balão: default suprimido e propagação interrompida', () => {
    const outsideBubbleSpy = vi.fn()
    document.addEventListener('keydown', outsideBubbleSpy)

    render(<TestWrapper open={true} />)

    const outsideInput = screen.getByTestId('outside-input')
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true
    })

    const notCancelled = outsideInput.dispatchEvent(event)

    // O evento deve ser cancelado (defaultPrevented = true) e sua propagação interrompida
    expect(notCancelled).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    expect(outsideBubbleSpy).not.toHaveBeenCalled()

    document.removeEventListener('keydown', outsideBubbleSpy)
  })

  it('2. Popover aberto + tecla de navegação dentro do balão: guarda não interfere', () => {
    const insideHandler = vi.fn((e: React.KeyboardEvent) => {
      // handler interno
    })

    render(
      <TestWrapper open={true}>
        <div data-testid="inside-content" onKeyDown={insideHandler}>
          <input data-testid="inside-input" placeholder="Inside" />
        </div>
      </TestWrapper>
    )

    const insideInput = screen.getByTestId('inside-input')
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true
    })

    const notCancelled = insideInput.dispatchEvent(event)

    // A guarda não interfere em eventos internos
    expect(notCancelled).toBe(true)
    expect(event.defaultPrevented).toBe(false)
    expect(insideHandler).toHaveBeenCalled()
  })

  it('3. Popover fechado + tecla de navegação: nada é suprimido', () => {
    const outsideBubbleSpy = vi.fn()
    document.addEventListener('keydown', outsideBubbleSpy)

    render(<TestWrapper open={false} />)

    const outsideInput = screen.getByTestId('outside-input')
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true
    })

    const notCancelled = outsideInput.dispatchEvent(event)

    expect(notCancelled).toBe(true)
    expect(event.defaultPrevented).toBe(false)
    expect(outsideBubbleSpy).toHaveBeenCalled()

    document.removeEventListener('keydown', outsideBubbleSpy)
  })

  it('4. Tecla Escape fecha o popover', () => {
    const onClose = vi.fn()
    render(<TestWrapper open={true} onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('5. Listeners são removidos após fechar: tecla fora não é suprimida', () => {
    const onClose = vi.fn()
    const { rerender } = render(<TestWrapper open={true} onClose={onClose} />)

    // Fecha o popover
    rerender(<TestWrapper open={false} onClose={onClose} />)

    const outsideInput = screen.getByTestId('outside-input')
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true
    })

    const notCancelled = outsideInput.dispatchEvent(event)
    expect(notCancelled).toBe(true)
    expect(event.defaultPrevented).toBe(false)
  })
})
