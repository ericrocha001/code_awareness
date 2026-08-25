// @vitest-environment jsdom
/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar a coalescência por requestAnimationFrame do callback onDrag no ColumnResizer.
2. Validar o flush explícito do delta acumulado no drag end.
3. Validar o cancelamento do rAF pendente no unmount.

Mapa de Relacionamentos do Script

1. ColumnResizer.tsx
   - Tipo: Dependência Direta
   - Relação: Componente sob teste.
   - Criticidade: Alta

2. @testing-library/react
   - Tipo: Dependência Direta
   - Relação: Fornece render, fireEvent e cleanup para asserções de DOM.
   - Criticidade: Alta

Invariantes do Script

1. Os mocks de requestAnimationFrame e cancelAnimationFrame são restaurados após cada teste.
2. A coalescência por rAF é transparente ao consumidor — a interface onDrag(deltaPx) não muda.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { ColumnResizer } from './ColumnResizer'

describe('ColumnResizer — coalescência por rAF (Sprint 9)', () => {
  let rafCallbacks: Array<FrameRequestCallback> = []
  let rafIdCounter = 1

  const installManualRaf = (): void => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      const id = rafIdCounter++
      rafCallbacks.push(cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (_id: number): void => {
      // Limpa todos os callbacks pendentes — suficiente para os testes 1–3 e 5
      rafCallbacks = []
    })
  }

  const flushRaf = (): void => {
    const pending = [...rafCallbacks]
    rafCallbacks = []
    pending.forEach((cb) => cb(0))
  }

  beforeEach(() => {
    rafCallbacks = []
    rafIdCounter = 1
    installManualRaf()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    rafCallbacks = []
  })

  it('1. Múltiplos mousemove no mesmo frame: onDrag é chamado apenas uma vez por frame', () => {
    const onDrag = vi.fn()
    const { container } = render(<ColumnResizer onDrag={onDrag} />)

    const handle = container.querySelector('.crs-root') as HTMLElement
    fireEvent.mouseDown(handle, { button: 0, clientX: 100 })

    // Três mousemove antes do flush do rAF: devem ser acumulados
    fireEvent.mouseMove(document, { clientX: 110 }) // delta: +10
    fireEvent.mouseMove(document, { clientX: 125 }) // delta: +15
    fireEvent.mouseMove(document, { clientX: 140 }) // delta: +15

    // rAF ainda pendente — onDrag não deve ter sido chamado
    expect(onDrag).not.toHaveBeenCalled()

    // Flush: onDrag chamado uma vez com delta total acumulado (40px)
    flushRaf()
    expect(onDrag).toHaveBeenCalledTimes(1)
    expect(onDrag).toHaveBeenCalledWith(40)
  })

  it('2. Flush no drag end: delta acumulado é aplicado via onDrag antes de onDragEnd', () => {
    const onDrag = vi.fn()
    const onDragEnd = vi.fn()
    const { container } = render(<ColumnResizer onDrag={onDrag} onDragEnd={onDragEnd} />)

    const handle = container.querySelector('.crs-root') as HTMLElement
    fireEvent.mouseDown(handle, { button: 0, clientX: 100 })

    // Mousemove acumula delta sem flush do rAF
    fireEvent.mouseMove(document, { clientX: 115 }) // delta: +15
    fireEvent.mouseMove(document, { clientX: 130 }) // delta: +15

    expect(onDrag).not.toHaveBeenCalled()
    expect(onDragEnd).not.toHaveBeenCalled()

    // Mouseup: flush do delta acumulado (30px) antes de chamar onDragEnd
    fireEvent.mouseUp(document)

    expect(onDrag).toHaveBeenCalledTimes(1)
    expect(onDrag).toHaveBeenCalledWith(30)
    expect(onDragEnd).toHaveBeenCalledTimes(1)

    // Ordem garantida: onDrag antes de onDragEnd
    const onDragCallOrder = onDrag.mock.invocationCallOrder[0]
    const onDragEndCallOrder = onDragEnd.mock.invocationCallOrder[0]
    expect(onDragCallOrder).toBeLessThan(onDragEndCallOrder)
  })

  it('3. Drag end sem delta acumulado: onDragEnd é chamado sem onDrag extra', () => {
    const onDrag = vi.fn()
    const onDragEnd = vi.fn()
    const { container } = render(<ColumnResizer onDrag={onDrag} onDragEnd={onDragEnd} />)

    const handle = container.querySelector('.crs-root') as HTMLElement
    fireEvent.mouseDown(handle, { button: 0, clientX: 100 })

    fireEvent.mouseMove(document, { clientX: 120 }) // delta: +20
    flushRaf() // aplica delta via onDrag, zera pendingDelta
    expect(onDrag).toHaveBeenCalledTimes(1)
    expect(onDrag).toHaveBeenCalledWith(20)

    // Mouseup: sem delta pendente → onDragEnd sem onDrag extra
    fireEvent.mouseUp(document)
    expect(onDrag).toHaveBeenCalledTimes(1) // sem chamada adicional
    expect(onDragEnd).toHaveBeenCalledTimes(1)
  })

  it('4. Cleanup no unmount: rAF pendente é cancelado', () => {
    // Spy específico para este teste — substitui o cancelAnimationFrame do beforeEach
    const cancelAnimationFrameSpy = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameSpy)

    const onDrag = vi.fn()
    const { container, unmount } = render(<ColumnResizer onDrag={onDrag} />)

    const handle = container.querySelector('.crs-root') as HTMLElement
    fireEvent.mouseDown(handle, { button: 0, clientX: 100 })

    // Mousemove agenda rAF mas não faz flush
    fireEvent.mouseMove(document, { clientX: 110 })
    expect(onDrag).not.toHaveBeenCalled()
    expect(rafCallbacks.length).toBeGreaterThan(0)

    // Unmount deve cancelar o rAF pendente via cleanup do effect
    unmount()
    expect(cancelAnimationFrameSpy).toHaveBeenCalled()
  })

  it('5. Segundo mousemove no mesmo frame não agenda novo rAF', () => {
    const onDrag = vi.fn()
    const { container } = render(<ColumnResizer onDrag={onDrag} />)

    const handle = container.querySelector('.crs-root') as HTMLElement
    fireEvent.mouseDown(handle, { button: 0, clientX: 100 })

    // Primeiro mousemove: agenda rAF
    fireEvent.mouseMove(document, { clientX: 110 })
    expect(rafCallbacks.length).toBe(1)

    // Segundo mousemove no mesmo frame: NÃO deve agendar novo rAF
    fireEvent.mouseMove(document, { clientX: 120 })
    expect(rafCallbacks.length).toBe(1) // ainda apenas 1 rAF pendente

    // Flush: onDrag chamado uma vez com delta total (20px)
    flushRaf()
    expect(onDrag).toHaveBeenCalledTimes(1)
    expect(onDrag).toHaveBeenCalledWith(20)
  })
})
