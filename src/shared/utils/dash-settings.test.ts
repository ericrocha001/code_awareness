/*
-T ---
*/

import { describe, expect, it } from 'vitest'
import { DEFAULT_DASH_SETTINGS, normalizeDashSettings } from './dash-settings'

describe('DEFAULT_DASH_SETTINGS', () => {
  it('todos os campos são false', () => {
    expect(DEFAULT_DASH_SETTINGS).toEqual({
      removeComments: false,
      removeEmptyLines: false,
      truncateBase64: false
    })
  })
})

describe('normalizeDashSettings', () => {
  it('entrada ausente (undefined) retorna defaults', () => {
    expect(normalizeDashSettings(undefined)).toEqual(DEFAULT_DASH_SETTINGS)
  })

  it('entrada null retorna defaults', () => {
    expect(normalizeDashSettings(null)).toEqual(DEFAULT_DASH_SETTINGS)
  })

  it('entrada array retorna defaults', () => {
    expect(normalizeDashSettings([true, true, true])).toEqual(DEFAULT_DASH_SETTINGS)
  })

  it('entrada string retorna defaults', () => {
    expect(normalizeDashSettings('{"removeComments":true}')).toEqual(DEFAULT_DASH_SETTINGS)
  })

  it('objeto vazio retorna defaults', () => {
    expect(normalizeDashSettings({})).toEqual(DEFAULT_DASH_SETTINGS)
  })

  it('objeto parcial preserva campos ausentes como default', () => {
    const result = normalizeDashSettings({ removeComments: true })
    expect(result).toEqual({
      removeComments: true,
      removeEmptyLines: false,
      truncateBase64: false
    })
  })

  it('objeto completo preserva todos os campos booleanos', () => {
    const input = { removeComments: true, removeEmptyLines: true, truncateBase64: true }
    expect(normalizeDashSettings(input)).toEqual(input)
  })

  it('campos com valor não-booleano assumem o default', () => {
    const result = normalizeDashSettings({
      removeComments: 'yes',
      removeEmptyLines: 1,
      truncateBase64: null
    })
    expect(result).toEqual(DEFAULT_DASH_SETTINGS)
  })

  it('campos extras são descartados', () => {
    const result = normalizeDashSettings({
      removeComments: true,
      unknown: 'extra',
      another: 42
    })
    expect(result).toEqual({
      removeComments: true,
      removeEmptyLines: false,
      truncateBase64: false
    })
    expect(result).not.toHaveProperty('unknown')
  })
})
