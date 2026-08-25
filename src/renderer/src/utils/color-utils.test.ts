// @vitest-environment jsdom
/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar que resolveTagPalette retorna paletas determinísticas e contrastantes por tema.
2. Garantir que entradas inválidas retornam a paleta neutra legível e nunca lançam exceção.
3. Verificar a invariante de delta de luminosidade mínimo entre background e text.

Mapa de Relacionamentos do Script

1. color-utils.ts
   - Tipo: Dependência Direta
   - Relação: Módulo sob teste.
   - Criticidade: Alta

Invariantes do Script

1. Para qualquer entrada válida e tema, a diferença de luminância entre background e text é superior a 0.55.
2. Entradas inválidas nunca lançam exceção — retornam paleta neutra.
3. A função é determinística: mesma entrada → mesma saída.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, it, expect } from 'vitest'
import { resolveTagPalette, getContrastColor } from './color-utils'

// Calcula luminância W3C de um hex
function hexLuminance(hex: string): number {
  const cleaned = hex.replace('#', '')
  const r = parseInt(cleaned.slice(0, 2), 16) / 255
  const g = parseInt(cleaned.slice(2, 4), 16) / 255
  const b = parseInt(cleaned.slice(4, 6), 16) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function luminanceDelta(bg: string, text: string): number {
  return Math.abs(hexLuminance(bg) - hexLuminance(text))
}

const SAMPLE_COLORS = [
  '#3b82f6', // azul médio
  '#10b981', // verde
  '#f59e0b', // âmbar
  '#ef4444', // vermelho
  '#8b5cf6', // violeta
  '#ec4899', // rosa
  '#06b6d4', // ciano
  '#000000', // preto
  '#ffffff', // branco
  '#94a3b8', // cinza pastel
]

describe('resolveTagPalette — paleta por tema', () => {
  it('1. Retorna hex válidos (#rrggbb) para background e text', () => {
    for (const color of SAMPLE_COLORS) {
      for (const theme of ['light', 'dark'] as const) {
        const { background, text } = resolveTagPalette(color, theme)
        expect(background).toMatch(/^#[0-9a-f]{6}$/i)
        expect(text).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
  })

  it('2. Background e text são sempre cores distintas', () => {
    for (const color of SAMPLE_COLORS) {
      for (const theme of ['light', 'dark'] as const) {
        const { background, text } = resolveTagPalette(color, theme)
        expect(background.toLowerCase()).not.toBe(text.toLowerCase())
      }
    }
  })

  it('3. Delta de luminância entre background e text é sempre ≥ 0.55', () => {
    for (const color of SAMPLE_COLORS) {
      for (const theme of ['light', 'dark'] as const) {
        const { background, text } = resolveTagPalette(color, theme)
        const delta = luminanceDelta(background, text)
        expect(delta).toBeGreaterThanOrEqual(0.55)
      }
    }
  })

  it('4. Determinismo: mesma entrada → mesma saída', () => {
    for (const color of SAMPLE_COLORS) {
      for (const theme of ['light', 'dark'] as const) {
        const r1 = resolveTagPalette(color, theme)
        const r2 = resolveTagPalette(color, theme)
        expect(r1.background).toBe(r2.background)
        expect(r1.text).toBe(r2.text)
      }
    }
  })

  it('5. Cor inválida (string vazia) retorna paleta neutra legível sem lançar exceção', () => {
    expect(() => resolveTagPalette('', 'light')).not.toThrow()
    const { background, text } = resolveTagPalette('', 'light')
    expect(background).toMatch(/^#[0-9a-f]{6}$/i)
    expect(text).toMatch(/^#[0-9a-f]{6}$/i)
    const delta = luminanceDelta(background, text)
    expect(delta).toBeGreaterThanOrEqual(0.4)
  })

  it('6. Cor inválida (lixo) retorna paleta neutra legível sem lançar exceção', () => {
    expect(() => resolveTagPalette('not-a-color', 'dark')).not.toThrow()
    const { background, text } = resolveTagPalette('not-a-color', 'dark')
    expect(background).toMatch(/^#[0-9a-f]{6}$/i)
    expect(text).toMatch(/^#[0-9a-f]{6}$/i)
  })
})

describe('getContrastColor — contraste preto/branco', () => {
  it('7. Cor clara retorna #000', () => {
    expect(getContrastColor('#ffffff')).toBe('#000')
    expect(getContrastColor('#f0f0f0')).toBe('#000')
  })

  it('8. Cor escura retorna #fff', () => {
    expect(getContrastColor('#000000')).toBe('#fff')
    expect(getContrastColor('#1a1a2e')).toBe('#fff')
  })

  it('9. Entrada inválida retorna #fff sem lançar exceção', () => {
    expect(() => getContrastColor('')).not.toThrow()
    expect(getContrastColor('')).toBe('#fff')
    expect(getContrastColor('invalid')).toBe('#fff')
  })
})
