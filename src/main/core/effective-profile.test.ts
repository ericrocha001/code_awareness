/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar a pipeline de resolução semântica que transforma o Stored Profile em Effective Profile.
2. Validar a eliminação de campos sem efeito no caminho compression-core (showLineNumbers, parsableStyle, flags de sumário e árvore).
3. Validar a eliminação universal de outputFilePathStyle em todos os caminhos arquiteturais.
4. Validar a preservação de todos os campos relevantes a nível de documento no caminho direct-output.
5. Garantir o determinismo estrito da resolução semântica.

Mapa de Relacionamentos do Script

1. effective-profile.ts
   - Tipo: Dependência Direta
   - Relação: Testa a função resolveEffectiveProfile e a estrutura do tipo EffectiveProfile.
   - Criticidade: Alta

2. compression-profile.ts
   - Tipo: Dependência Direta
   - Relação: Consome DEFAULT_PROFILE para os cenários de teste.
   - Criticidade: Alta

3. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Consome CompressionProfile e OutputFormat para tipagem de entrada dos testes.
   - Criticidade: Alta

Invariantes do Script

1. Nenhum teste acessa filesystem, Git real ou invoca processos externos — testes 100% determinísticos em memória.
2. No caminho compression-core, apenas removeComments, removeEmptyLines e truncateBase64 existem no objeto resultante.
3. outputFilePathStyle nunca está presente no EffectiveProfile retornado.
4. Mesma entrada sempre produz o mesmo EffectiveProfile (imutabilidade e determinismo).

--- FIM ARQUITETURA DO SCRIPT ---
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
