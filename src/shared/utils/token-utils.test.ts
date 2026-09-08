/*
-T ---
*/

import { describe, expect, it } from 'vitest'
import { estimateTokenCount } from './token-utils'

describe('estimateTokenCount', () => {
  it('retorna valor numérico positivo para texto não vazio', () => {
    const result = estimateTokenCount('Hello world')
    expect(typeof result).toBe('number')
    expect(result).toBeGreaterThan(0)
  })

  it('retorna 0 para string vazia', () => {
    expect(estimateTokenCount('')).toBe(0)
  })

  it('retorna 0 para não-string', () => {
    expect(estimateTokenCount(null as unknown as string)).toBe(0)
    expect(estimateTokenCount(undefined as unknown as string)).toBe(0)
    expect(estimateTokenCount(123 as unknown as string)).toBe(0)
  })

  it('aplica heurística de 4 caracteres por token', () => {
    // 8 caracteres → Math.ceil(8 / 4) = 2
    expect(estimateTokenCount('12345678')).toBe(2)
    // 9 caracteres → Math.ceil(9 / 4) = 3
    expect(estimateTokenCount('123456789')).toBe(3)
  })

  it('resultado é proporcional ao tamanho do texto', () => {
    const short = estimateTokenCount('abc')
    const long = estimateTokenCount('abc'.repeat(100))
    expect(long).toBeGreaterThan(short)
  })

  it('resultado é inteiro não negativo', () => {
    const result = estimateTokenCount('test')
    expect(Number.isInteger(result)).toBe(true)
    expect(result).toBeGreaterThanOrEqual(0)
  })
})
