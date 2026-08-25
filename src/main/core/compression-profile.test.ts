/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar a normalização do CompressionProfile em perfis canônicos determinísticos.
2. Validar o Effective Hash (determinismo, sensibilidade a mudanças de campos efetivos e imunidade a campos sem efeito).
3. Validar a determinação do caminho arquitetural (Compression Core vs Direct Output).
4. Validar os defaults de persistência em DEFAULT_COMPRESSION_SETTINGS.

Mapa de Relacionamentos do Script

1. compression-profile.ts
   - Tipo: Dependência Direta
   - Relação: Testa normalizeCompressionProfile, computeProfileHash, resolveCompressionPath e constantes do módulo.
   - Criticidade: Alta

2. effective-profile.ts
   - Tipo: Dependência Direta
   - Relação: Consome resolveEffectiveProfile para gerar os EffectiveProfiles avaliados por computeProfileHash.
   - Criticidade: Alta

3. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Consome CompressionProfile e OutputFormat para tipar os casos de teste.
   - Criticidade: Alta

Invariantes do Script

1. Nenhum teste depende da CLI real do Repomix, de Git real, de filesystem temporário ou de CompressionService — teste puramente determinístico do domínio do profile.
2. computeProfileHash opera exclusivamente sobre o EffectiveProfile canônico.
3. Mudança em campos sem efeito no caminho ativo nunca altera o Effective Hash.
4. Mudança em campos efetivos no caminho ativo sempre altera o Effective Hash.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PROFILE,
  DEFAULT_OUTPUT_FORMAT,
  DEFAULT_COMPRESSION_SETTINGS,
  normalizeCompressionProfile,
  computeProfileHash,
  resolveCompressionPath
} from './compression-profile'
import { resolveEffectiveProfile } from './effective-profile'
import type { CompressionProfile } from '../../shared/types'

function fullProfile(overrides: Partial<CompressionProfile> = {}): CompressionProfile {
  return { ...DEFAULT_PROFILE, ...overrides }
}

describe('CompressionProfile — Provas de Aceitação', () => {
  // PA-P01 — Normalização produz perfil canônico determinístico
  describe('PA-P01 — Normalização canônica determinística', () => {
    it('perfil completo e válido é normalizado sem alterações', () => {
      const input: CompressionProfile = {
        removeComments: true,
        removeEmptyLines: false,
        truncateBase64: true,
        showLineNumbers: false,
        parsableStyle: true,
        outputFilePathStyle: 'cwd-relative',
        includeFileSummary: true,
        includeDirectoryStructure: true,
        includeEmptyDirectories: true,
        includeFullDirectoryStructure: false,
        version: 1
      }
      expect(normalizeCompressionProfile(input)).toEqual(input)
    })

    it('normalização é determinística (mesma entrada → mesmo resultado)', () => {
      const a = normalizeCompressionProfile({ removeComments: true })
      const b = normalizeCompressionProfile({ removeComments: true })
      expect(a).toEqual(b)
    })
  })

  // PA-P02 — Perfil incompleto é preenchido com defaults
  describe('PA-P02 — Perfil incompleto preenchido com defaults', () => {
    it('objeto vazio produz o perfil padrão', () => {
      expect(normalizeCompressionProfile({})).toEqual(DEFAULT_PROFILE)
    })

    it('campos ausentes assumem o default do perfil padrão', () => {
      const normalized = normalizeCompressionProfile({ removeComments: true })
      expect(normalized.removeComments).toBe(true)
      expect(normalized.removeEmptyLines).toBe(DEFAULT_PROFILE.removeEmptyLines)
      expect(normalized.showLineNumbers).toBe(DEFAULT_PROFILE.showLineNumbers)
      expect(normalized.outputFilePathStyle).toBe('target-relative')
    })
  })

  // PA-P03 — Perfil corrompido é normalizado sem crash
  describe('PA-P03 — Perfil corrompido normalizado sem crash', () => {
    it('valores não-booleanos são coagidos ao default', () => {
      const corrupt = {
        removeComments: 'yes',
        showLineNumbers: 42,
        outputFilePathStyle: 'bogus',
        includeDirectoryStructure: null,
        version: 'x'
      } as unknown
      const normalized = normalizeCompressionProfile(corrupt)
      expect(normalized.removeComments).toBe(DEFAULT_PROFILE.removeComments)
      expect(normalized.showLineNumbers).toBe(DEFAULT_PROFILE.showLineNumbers)
      expect(normalized.outputFilePathStyle).toBe('target-relative')
      expect(normalized.includeDirectoryStructure).toBe(false)
      expect(normalized.version).toBe(DEFAULT_PROFILE.version)
    })

    it('entrada null/undefined/string não lança', () => {
      expect(normalizeCompressionProfile(null)).toEqual(DEFAULT_PROFILE)
      expect(normalizeCompressionProfile(undefined)).toEqual(DEFAULT_PROFILE)
      expect(normalizeCompressionProfile('x')).toEqual(DEFAULT_PROFILE)
    })
  })

  // PA-P04 — Effective Hash determinístico
  describe('PA-P04 — Effective Hash determinístico', () => {
    it('mesmo perfil efetivo → mesmo hash (64 hex)', () => {
      const eff = resolveEffectiveProfile(DEFAULT_PROFILE, 'plain')
      expect(computeProfileHash(eff)).toBe(computeProfileHash(eff))
      expect(computeProfileHash(eff)).toMatch(/^[0-9a-f]{64}$/)
    })

    it('perfil normalizado e perfil equivalente produzem o mesmo hash', () => {
      const normalized = resolveEffectiveProfile({ removeComments: true }, 'plain')
      const manual = resolveEffectiveProfile(fullProfile({ removeComments: true }), 'plain')
      expect(computeProfileHash(normalized)).toBe(computeProfileHash(manual))
    })
  })

  // PA-P05 — Effective Hash reflete apenas campos efetivos do caminho ativo
  describe('PA-P05 — Effective Hash reflete apenas campos efetivos do caminho ativo', () => {
    it('alterar campo efetivo no compression-core (removeComments, removeEmptyLines, truncateBase64) altera o hash', () => {
      const baseEff = resolveEffectiveProfile(DEFAULT_PROFILE, 'plain')
      const changedComments = resolveEffectiveProfile(fullProfile({ removeComments: true }), 'plain')
      const changedEmpty = resolveEffectiveProfile(fullProfile({ removeEmptyLines: true }), 'plain')
      const changedBase64 = resolveEffectiveProfile(fullProfile({ truncateBase64: true }), 'plain')

      expect(computeProfileHash(changedComments)).not.toBe(computeProfileHash(baseEff))
      expect(computeProfileHash(changedEmpty)).not.toBe(computeProfileHash(baseEff))
      expect(computeProfileHash(changedBase64)).not.toBe(computeProfileHash(baseEff))
    })

    it('alterar campo sem efeito no compression-core (showLineNumbers, parsableStyle, etc.) NÃO altera o hash', () => {
      const baseEff = resolveEffectiveProfile(DEFAULT_PROFILE, 'plain')
      const noOpFields: Array<Partial<CompressionProfile>> = [
        { showLineNumbers: false },
        { parsableStyle: true },
        { outputFilePathStyle: 'cwd-relative' },
        { includeFileSummary: true },
        { includeDirectoryStructure: true },
        { includeEmptyDirectories: true },
        { includeFullDirectoryStructure: true },
        { version: 2 }
      ]
      for (const overrides of noOpFields) {
        const eff = resolveEffectiveProfile(fullProfile(overrides), 'plain')
        expect(computeProfileHash(eff)).toBe(computeProfileHash(baseEff))
      }
    })
  })

  // PA-P06 — Determinação do caminho arquitetural
  describe('PA-P06 — Caminho arquitetural (core vs direct-output)', () => {
    it('plain → compression-core', () => {
      expect(resolveCompressionPath('plain')).toBe('compression-core')
    })

    it('markdown, xml e json → direct-output', () => {
      expect(resolveCompressionPath('markdown')).toBe('direct-output')
      expect(resolveCompressionPath('xml')).toBe('direct-output')
      expect(resolveCompressionPath('json')).toBe('direct-output')
    })
  })

  // PA-P07 — Configurações padrão persistidas
  describe('PA-P07 — Configurações padrão persistidas', () => {
    it('DEFAULT_COMPRESSION_SETTINGS usa plain + perfil padrão', () => {
      expect(DEFAULT_COMPRESSION_SETTINGS.outputFormat).toBe(DEFAULT_OUTPUT_FORMAT)
      expect(DEFAULT_COMPRESSION_SETTINGS.profile).toEqual(DEFAULT_PROFILE)
    })
  })
})
