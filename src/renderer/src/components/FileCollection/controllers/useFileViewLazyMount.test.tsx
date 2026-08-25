// @vitest-environment jsdom
/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar a lógica do hook useFileViewLazyMount em isolamento (estado inicial, reset por totalCount, disparo do IntersectionObserver).
2. Validar invariantes de contagem: mountedCount nunca excede totalCount e lotes acumulam corretamente.
3. Validar o cleanup do IntersectionObserver no unmount.

Mapa de Relacionamentos do Script

1. controllers/useFileViewLazyMount.ts
   - Tipo: Dependência Direta
   - Relação: Hook sob teste.
   - Criticidade: Alta

2. @testing-library/react
   - Tipo: Dependência Direta
   - Relação: Fornece render, act e cleanup; um componente Harness monta o sentinel no DOM para exercitar o hook em ambiente jsdom.
   - Criticidade: Alta

Invariantes do Script

1. IntersectionObserver é mockado (jsdom não o implementa) por uma classe controlável que permite simular isIntersecting.
2. mudanças de mountedCount e disparos do observer sempre ocorrem dentro de act() para refletir atualizações de estado síncronas.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { useFileViewLazyMount, type UseFileViewLazyMountResult } from './useFileViewLazyMount'

const INITIAL_BATCH = 80
const BATCH_SIZE = 80

// ── Mock de IntersectionObserver ──────────────────────────────────────────────

class MockIntersectionObserver {
  static instance: MockIntersectionObserver | null = null
  static count = 0
  callback: IntersectionObserverCallback
  observed: Element[] = []
  constructor(cb: IntersectionObserverCallback) {
    this.callback = cb
    MockIntersectionObserver.instance = this
    MockIntersectionObserver.count++
  }
  observe(el: Element): void {
    this.observed.push(el)
  }
  unobserve(): void {
    /* no-op — cleanup usa disconnect abaixo */
  }
  disconnect(): void {
    this.observed = []
  }
  /** Dispara manualmente o callback do observer. */
  trigger(isIntersecting = true): void {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    )
  }
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
  MockIntersectionObserver.instance = null
  MockIntersectionObserver.count = 0
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// ── Harness ──────────────────────────────────────────────────────────────────
// Monta o sentinel no DOM (como o FileView faz) para que o hook observe um
// elemento real — jsdom não mede viewport, mas o observer aqui é mockado.

let harnessResult: UseFileViewLazyMountResult | null = null

function Harness({ totalCount }: { totalCount: number }) {
  const result = useFileViewLazyMount({ totalCount })
  harnessResult = result
  return (
    <div>
      <span data-testid="mounted">{result.mountedCount}</span>
      <span data-testid="hasmore">{String(result.hasMore)}</span>
      <div data-testid="sentinel" ref={result.sentinelRef} />
    </div>
  )
}

const mountedOf = (): number =>
  Number(harnessResult!.mountedCount)

describe('useFileViewLazyMount', () => {
  it('monta INITIAL_BATCH rows quando totalCount > INITIAL_BATCH', () => {
    render(<Harness totalCount={200} />)
    expect(mountedOf()).toBe(INITIAL_BATCH)
  })

  it('monta totalCount rows quando totalCount < INITIAL_BATCH', () => {
    render(<Harness totalCount={20} />)
    expect(mountedOf()).toBe(20)
  })

  it('hasMore é true quando mountedCount < totalCount', () => {
    render(<Harness totalCount={200} />)
    expect(harnessResult!.hasMore).toBe(true)
  })

  it('hasMore é false quando mountedCount === totalCount', () => {
    render(<Harness totalCount={60} />)
    expect(harnessResult!.hasMore).toBe(false)
  })

  it('sentinelRef aponta para o elemento sentinel no DOM', () => {
    const { getByTestId } = render(<Harness totalCount={200} />)
    expect(harnessResult!.sentinelRef.current).toBe(getByTestId('sentinel'))
  })

  it('reseta mountedCount quando totalCount diminui', () => {
    const { rerender } = render(<Harness totalCount={200} />)
    expect(mountedOf()).toBe(INITIAL_BATCH)

    rerender(<Harness totalCount={30} />)
    expect(mountedOf()).toBe(30)
    expect(harnessResult!.hasMore).toBe(false)
  })

  it('reseta mountedCount quando totalCount aumenta (novo projeto)', () => {
    const { rerender } = render(<Harness totalCount={5} />)
    expect(mountedOf()).toBe(5)

    rerender(<Harness totalCount={500} />)
    expect(mountedOf()).toBe(INITIAL_BATCH)
  })

  it('disparo do IntersectionObserver incrementa mountedCount em BATCH_SIZE', () => {
    render(<Harness totalCount={200} />)
    expect(mountedOf()).toBe(INITIAL_BATCH)

    act(() => {
      MockIntersectionObserver.instance?.trigger()
    })

    expect(mountedOf()).toBe(INITIAL_BATCH + BATCH_SIZE)
  })

  it('múltiplos disparos consecutivos acumulam lotes corretamente', () => {
    render(<Harness totalCount={500} />)
    expect(mountedOf()).toBe(INITIAL_BATCH)

    act(() => {
      MockIntersectionObserver.instance?.trigger()
      MockIntersectionObserver.instance?.trigger()
    })

    expect(mountedOf()).toBe(INITIAL_BATCH + BATCH_SIZE * 2)
  })

  it('mountedCount nunca excede totalCount', () => {
    render(<Harness totalCount={140} />)
    expect(mountedOf()).toBe(INITIAL_BATCH)
    expect(harnessResult!.hasMore).toBe(true)

    act(() => {
      MockIntersectionObserver.instance?.trigger()
    })
    // 80 + 80 = 160 → capado em 140
    expect(mountedOf()).toBe(140)
    expect(harnessResult!.hasMore).toBe(false)
  })

  it('cleanup do IntersectionObserver no unmount', () => {
    const { unmount } = render(<Harness totalCount={300} />)
    const instance = MockIntersectionObserver.instance
    expect(instance?.observed).toHaveLength(1)

    unmount()

    expect(instance?.observed).toHaveLength(0)
  })

  it('não recria o IntersectionObserver quando totalCount muda sem alterar hasMore (Sprint 5)', () => {
    const { rerender } = render(<Harness totalCount={200} />)
    expect(harnessResult!.hasMore).toBe(true)
    expect(MockIntersectionObserver.count).toBe(1)

    // totalCount muda de 200 → 500: mountedCount reseta para 80, hasMore segue true.
    // handleLoadMore é estável (deps vazias), então o observer não é recriado.
    rerender(<Harness totalCount={500} />)
    expect(harnessResult!.hasMore).toBe(true)
    expect(MockIntersectionObserver.count).toBe(1)
  })

  it('desconecta o IntersectionObserver quando hasMore muda de true para false (Sprint 5)', () => {
    render(<Harness totalCount={100} />)
    expect(MockIntersectionObserver.count).toBe(1)
    const obs = MockIntersectionObserver.instance!
    expect(obs.observed).toHaveLength(1)

    act(() => {
      obs.trigger() // mountedCount 80 → 100, hasMore passa a false
    })

    expect(harnessResult!.hasMore).toBe(false)
    // cleanup do efeito roda (deps hasMore mudou) e desconecta o observer;
    // como hasMore é false, o efeito retorna cedo e não cria nova instância.
    expect(obs.observed).toHaveLength(0)
    expect(MockIntersectionObserver.count).toBe(1)
  })

  it('cria o IntersectionObserver quando hasMore passa de false para true (Sprint 5)', () => {
    const { rerender } = render(<Harness totalCount={60} />)
    expect(harnessResult!.hasMore).toBe(false)
    expect(MockIntersectionObserver.count).toBe(0)

    // totalCount 60 → 500: mountedCount reseta para 80, hasMore passa a true.
    rerender(<Harness totalCount={500} />)
    expect(harnessResult!.hasMore).toBe(true)
    expect(MockIntersectionObserver.count).toBe(1)
  })
})