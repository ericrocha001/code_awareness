// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { computeTagOverflow, ChipGeometry } from './tag-overflow'

describe('computeTagOverflow', () => {
  it('todos os chips dentro do container ⇒ todos visíveis', () => {
    const chips: ChipGeometry[] = [
      { start: 0, end: 18 },
      { start: 22, end: 40 }
    ]
    expect(computeTagOverflow(chips, 100)).toEqual({ visibleCount: 2, hiddenCount: 0 })
  })

  it('overflow parcial ⇒ conta visíveis e ocultas corretamente', () => {
    const chips: ChipGeometry[] = [
      { start: 0, end: 18 },
      { start: 22, end: 40 },
      { start: 44, end: 62 }
    ]
    expect(computeTagOverflow(chips, 40)).toEqual({ visibleCount: 2, hiddenCount: 1 })
  })

  it('nenhum chip cabe ⇒ todas ocultas', () => {
    const chips: ChipGeometry[] = [
      { start: 50, end: 68 },
      { start: 72, end: 90 }
    ]
    expect(computeTagOverflow(chips, 40)).toEqual({ visibleCount: 0, hiddenCount: 2 })
  })

  it('lista vazia ⇒ zeros', () => {
    expect(computeTagOverflow([], 100)).toEqual({ visibleCount: 0, hiddenCount: 0 })
  })

  it('chip exatamente no limite (com tolerância de 1) conta como visível', () => {
    const chips: ChipGeometry[] = [{ start: 0, end: 40 }]
    expect(computeTagOverflow(chips, 40).hiddenCount).toBe(0)
    expect(computeTagOverflow([{ start: 0, end: 41 }], 40).hiddenCount).toBe(0)
    expect(computeTagOverflow([{ start: 0, end: 42 }], 40).hiddenCount).toBe(1)
  })

  it('container sem geometria (tamanho <= 0) ⇒ zero ocultas (determinismo em jsdom)', () => {
    const chips: ChipGeometry[] = [
      { start: 0, end: 18 },
      { start: 22, end: 40 }
    ]
    expect(computeTagOverflow(chips, 0)).toEqual({ visibleCount: 2, hiddenCount: 0 })
    expect(computeTagOverflow(chips, -10)).toEqual({ visibleCount: 2, hiddenCount: 0 })
  })
})
