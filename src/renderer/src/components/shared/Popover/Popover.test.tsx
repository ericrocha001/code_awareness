// @vitest-environment jsdom
/*
-T ---
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
