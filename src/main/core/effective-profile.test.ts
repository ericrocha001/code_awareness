/*
-T ---
*/

import { describe, it, expect } from 'vitest'
import { resolveEffectiveProfile } from './effective-profile'
import { DEFAULT_PROFILE } from './compression-profile'
import type { CompressionProfile, OutputFormat } from '../../shared/types'

function fullProfile(overrides: Partial<CompressionProfile> = {}): CompressionProfile {
  return { ...DEFAULT_PROFILE, ...overrides }
}

describe('EffectiveProfile — Provas de Aceitação', () => {
  describe('Pipeline de Resolução Semântica — Compression Core (plain / json)', () => {
    it.each(['plain'] as OutputFormat[])(
      'formato "%s" produz path "compression-core" com apenas os 3 campos efetivos',
      (format) => {
        const effective = resolveEffectiveProfile(DEFAULT_PROFILE, format)
        expect(effective).toEqual({
          path: 'compression-core',
          removeComments: false,
          removeEmptyLines: false,
          truncateBase64: false
        })
      }
    )

    it('elimina showLineNumbers, parsableStyle e campos de estrutura no compression-core', () => {
      const stored = fullProfile({
        showLineNumbers: false,
        parsableStyle: true,
        includeFileSummary: true,
        includeDirectoryStructure: true,
        includeEmptyDirectories: true,
        includeFullDirectoryStructure: true,
        removeComments: true,
        removeEmptyLines: true,
        truncateBase64: true
      })

      const effective = resolveEffectiveProfile(stored, 'plain')
      expect(effective).toEqual({
        path: 'compression-core',
        removeComments: true,
        removeEmptyLines: true,
        truncateBase64: true
      })
      expect('showLineNumbers' in effective).toBe(false)
      expect('parsableStyle' in effective).toBe(false)
      expect('includeFileSummary' in effective).toBe(false)
      expect('includeDirectoryStructure' in effective).toBe(false)
      expect('includeEmptyDirectories' in effective).toBe(false)
      expect('includeFullDirectoryStructure' in effective).toBe(false)
    })
  })

  describe('Pipeline de Resolução Semântica — Direct Output (markdown / xml / json)', () => {
    it.each(['markdown', 'xml', 'json'] as OutputFormat[])(
      'formato "%s" produz path "direct-output" preservando todos os campos de documento',
      (format) => {
        const effective = resolveEffectiveProfile(DEFAULT_PROFILE, format)
        expect(effective).toEqual({
          path: 'direct-output',
          includeDirectoryStructure: false,
          includeEmptyDirectories: false,
          includeFileSummary: false,
          includeFullDirectoryStructure: false,
          parsableStyle: false,
          removeComments: false,
          removeEmptyLines: false,
          showLineNumbers: true,
          truncateBase64: false
        })
      }
    )

    it('preserva valores customizados no caminho direct-output', () => {
      const stored = fullProfile({
        removeComments: true,
        removeEmptyLines: true,
        truncateBase64: true,
        showLineNumbers: false,
        parsableStyle: true,
        includeFileSummary: true,
        includeDirectoryStructure: true,
        includeEmptyDirectories: true,
        includeFullDirectoryStructure: true
      })

      const effective = resolveEffectiveProfile(stored, 'markdown')
      expect(effective).toEqual({
        path: 'direct-output',
        includeDirectoryStructure: true,
        includeEmptyDirectories: true,
        includeFileSummary: true,
        includeFullDirectoryStructure: true,
        parsableStyle: true,
        removeComments: true,
        removeEmptyLines: true,
        showLineNumbers: false,
        truncateBase64: true
      })
    })
  })

  describe('Eliminação universal de outputFilePathStyle', () => {
    it.each(['plain', 'json', 'markdown', 'xml'] as OutputFormat[])(
      'formato "%s" nunca inclui outputFilePathStyle no EffectiveProfile',
      (format) => {
        const stored = fullProfile({ outputFilePathStyle: 'cwd-relative' })
        const effective = resolveEffectiveProfile(stored, format)
        expect('outputFilePathStyle' in effective).toBe(false)
      }
    )
  })

  describe('Determinismo e tolerância a entradas inválidas', () => {
    it('mesma entrada produz resultado idêntico', () => {
      const a = resolveEffectiveProfile({ removeComments: true }, 'plain')
      const b = resolveEffectiveProfile({ removeComments: true }, 'plain')
      expect(a).toEqual(b)
    })

    it('entrada null/undefined/objeto vazio produz EffectiveProfile padrão seguro', () => {
      const effNull = resolveEffectiveProfile(null, 'plain')
      const effUndef = resolveEffectiveProfile(undefined, 'plain')
      const effEmpty = resolveEffectiveProfile({}, 'plain')
      const expected = resolveEffectiveProfile(DEFAULT_PROFILE, 'plain')

      expect(effNull).toEqual(expected)
      expect(effUndef).toEqual(expected)
      expect(effEmpty).toEqual(expected)
    })

    it('OutputFormat desconhecido em runtime cai para plain (sem lançar)', () => {
      const eff = resolveEffectiveProfile(DEFAULT_PROFILE, 'bogus' as unknown as OutputFormat)
      expect(eff).toEqual({
        path: 'compression-core',
        removeComments: false,
        removeEmptyLines: false,
        truncateBase64: false
      })
    })
  })
})
