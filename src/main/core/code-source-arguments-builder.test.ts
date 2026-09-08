/*
-T ---
*/

import { describe, it, expect, vi } from 'vitest'
import { buildSourceCliArguments } from './code-source-arguments-builder'
import {
  DEFAULT_SOURCE_PROFILE,
  DEFAULT_SOURCE_OUTPUT_FORMAT,
  normalizeSourceProfile,
  normalizeSourceOutputFormat
} from '../../shared/utils/source-profile'
import type { SourceProfile } from '../../shared/types'

function profile(overrides: Partial<SourceProfile> = {}): SourceProfile {
  return { ...DEFAULT_SOURCE_PROFILE, ...overrides }
}

const FILES = ['src/a.ts', 'src/b.ts']

describe('CodeSourceArgumentsBuilder — Provas de Aceitação', () => {
  describe('Perfil padrão com Markdown', () => {
    it('emite transporte inline, estilo Markdown, stdout e resumo negativo', () => {
      const args = buildSourceCliArguments(DEFAULT_SOURCE_PROFILE, 'markdown', FILES)
      expect(args).toEqual(['--include', 'src/a.ts,src/b.ts', '--style', 'markdown', '--stdout', '--no-file-summary'])
    })

    it('não emite limpeza, apresentação nem estrutura (defaults desativados)', () => {
      const args = buildSourceCliArguments(DEFAULT_SOURCE_PROFILE, 'markdown', FILES)
      for (const flag of [
        '--remove-comments',
        '--remove-empty-lines',
        '--truncate-base64',
        '--output-show-line-numbers',
        '--parsable-style',
        '--no-directory-structure',
        '--include-empty-directories',
        '--include-full-directory-structure'
      ]) {
        expect(args).not.toContain(flag)
      }
    })
  })

  describe('Invariante central — ausência de compressão estrutural', () => {
    it('nenhuma combinação de perfil emite --compress', () => {
      const keys: (keyof SourceProfile)[] = [
        'removeComments',
        'removeEmptyLines',
        'truncateBase64',
        'showLineNumbers',
        'parsableStyle',
        'includeFileSummary',
        'includeDirectoryStructure',
        'includeEmptyDirectories',
        'includeFullDirectoryStructure'
      ]
      for (const key of keys) {
        for (const value of [true, false]) {
          const args = buildSourceCliArguments(profile({ [key]: value }), 'markdown', FILES)
          expect(args).not.toContain('--compress')
        }
      }
    })
  })

  describe('Flags de limpeza e apresentação', () => {
    it('flags de limpeza habilitadas emitem as flags correspondentes', () => {
      const args = buildSourceCliArguments(
        profile({ removeComments: true, removeEmptyLines: true, truncateBase64: true }),
        'markdown',
        FILES
      )
      expect(args).toContain('--remove-comments')
      expect(args).toContain('--remove-empty-lines')
      expect(args).toContain('--truncate-base64')
    })

    it('flags de apresentação habilitadas emitem as flags correspondentes', () => {
      const args = buildSourceCliArguments(profile({ showLineNumbers: true, parsableStyle: true }), 'markdown', FILES)
      expect(args).toContain('--output-show-line-numbers')
      expect(args).toContain('--parsable-style')
    })
  })

  describe('Resumo de arquivo', () => {
    it('resumo desativado emite --no-file-summary; ativado não emite', () => {
      expect(buildSourceCliArguments(profile(), 'markdown', FILES)).toContain('--no-file-summary')
      const args = buildSourceCliArguments(profile({ includeFileSummary: true }), 'markdown', FILES)
      expect(args).not.toContain('--no-file-summary')
    })
  })

  describe('Estrutura de diretórios', () => {
    it('estrutura desativada emite --no-directory-structure', () => {
      const args = buildSourceCliArguments(profile({ includeDirectoryStructure: false }), 'markdown', FILES)
      expect(args).toContain('--no-directory-structure')
    })

    it('estrutura desativada com dependentes habilitados emite aviso e omite flags dependentes', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const args = buildSourceCliArguments(
          profile({
            includeDirectoryStructure: false,
            includeEmptyDirectories: true,
            includeFullDirectoryStructure: true
          }),
          'markdown',
          FILES
        )
        expect(args).toContain('--no-directory-structure')
        expect(args).not.toContain('--include-empty-directories')
        expect(args).not.toContain('--include-full-directory-structure')
        expect(warnSpy).toHaveBeenCalledTimes(1)
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('estrutura ativada com diretórios vazios ou estrutura completa emite flags correspondentes', () => {
      const emptyDirs = buildSourceCliArguments(profile({ includeEmptyDirectories: true }), 'markdown', FILES)
      expect(emptyDirs).toContain('--include-empty-directories')
      expect(emptyDirs).not.toContain('--no-directory-structure')

      const full = buildSourceCliArguments(profile({ includeFullDirectoryStructure: true }), 'markdown', FILES)
      expect(full).toContain('--include-full-directory-structure')
      expect(full).not.toContain('--no-directory-structure')
    })
  })

  describe('Transporte da lista de arquivos', () => {
    it('inline-include emite --include com arquivos separados por vírgula', () => {
      const args = buildSourceCliArguments(DEFAULT_SOURCE_PROFILE, 'markdown', FILES, 'inline-include')
      expect(args.slice(0, 2)).toEqual(['--include', 'src/a.ts,src/b.ts'])
    })

    it('config-file emite --config com caminho e omite --include', () => {
      const args = buildSourceCliArguments(DEFAULT_SOURCE_PROFILE, 'markdown', FILES, 'config-file', 'C:\\tmp\\cfg.json')
      expect(args.slice(0, 2)).toEqual(['--config', 'C:\\tmp\\cfg.json'])
      expect(args).not.toContain('--include')
    })

    it('config-file sem caminho lança erro', () => {
      expect(() => buildSourceCliArguments(DEFAULT_SOURCE_PROFILE, 'markdown', FILES, 'config-file')).toThrow(
        /configPath/
      )
    })

    it('lista de arquivos vazia no transporte inline lança erro', () => {
      expect(() => buildSourceCliArguments(DEFAULT_SOURCE_PROFILE, 'markdown', [])).toThrow(/arquivos selecionados/)
    })
  })

  describe('Formato de saída', () => {
    it('XML emite --style xml', () => {
      const args = buildSourceCliArguments(DEFAULT_SOURCE_PROFILE, 'xml', FILES)
      expect(args[args.indexOf('--style') + 1]).toBe('xml')
    })

    it('formato inválido em runtime lança erro', () => {
      // Cast deliberado: simula dado persistido corrompido escapando da tipagem.
      const invalid = 'json' as unknown as 'markdown'
      expect(() => buildSourceCliArguments(DEFAULT_SOURCE_PROFILE, invalid, FILES)).toThrow(/não suportado/)
    })
  })

  describe('Ordem determinística dos argumentos', () => {
    it('segue a ordem contratual: transporte → limpeza → apresentação → estilo → stdout → resumo → estrutura', () => {
      const args = buildSourceCliArguments(
        profile({
          removeComments: true,
          removeEmptyLines: true,
          truncateBase64: true,
          showLineNumbers: true,
          parsableStyle: true,
          includeFileSummary: true,
          includeEmptyDirectories: true,
          includeFullDirectoryStructure: true
        }),
        'xml',
        FILES
      )
      expect(args).toEqual([
        '--include',
        'src/a.ts,src/b.ts',
        '--remove-comments',
        '--remove-empty-lines',
        '--truncate-base64',
        '--output-show-line-numbers',
        '--parsable-style',
        '--style',
        'xml',
        '--stdout',
        '--include-empty-directories',
        '--include-full-directory-structure'
      ])
    })
  })
})

describe('source-profile — Normalização Defensiva', () => {
  it('entrada ausente produz o perfil padrão', () => {
    expect(normalizeSourceProfile(undefined)).toEqual(DEFAULT_SOURCE_PROFILE)
    expect(normalizeSourceProfile(null)).toEqual(DEFAULT_SOURCE_PROFILE)
    expect(normalizeSourceProfile(42)).toEqual(DEFAULT_SOURCE_PROFILE)
  })

  it.each([undefined, null, 'sim', 1])('campo booleano inválido (%s) assume o default', (bad) => {
    const result = normalizeSourceProfile({ removeComments: bad, showLineNumbers: true, version: 1 })
    expect(result.removeComments).toBe(false)
    expect(result.showLineNumbers).toBe(true)
  })

  it('campos desconhecidos são ignorados (inclusive campos do Code Compression)', () => {
    const result = normalizeSourceProfile({ ...DEFAULT_SOURCE_PROFILE, outputFilePathStyle: 'cwd-relative', foo: 1 })
    expect(result).toEqual(DEFAULT_SOURCE_PROFILE)
    expect(result).not.toHaveProperty('outputFilePathStyle')
  })

  it('versão finita positiva é preservada; caso contrário usa a padrão', () => {
    expect(normalizeSourceProfile({ version: 7 }).version).toBe(7)
    expect(normalizeSourceProfile({ version: 0 }).version).toBe(DEFAULT_SOURCE_PROFILE.version)
    expect(normalizeSourceProfile({ version: -1 }).version).toBe(DEFAULT_SOURCE_PROFILE.version)
    expect(normalizeSourceProfile({ version: Number.NaN }).version).toBe(DEFAULT_SOURCE_PROFILE.version)
    expect(normalizeSourceProfile({ version: Infinity }).version).toBe(DEFAULT_SOURCE_PROFILE.version)
  })

  it('formato desconhecido normaliza para Markdown; XML válido permanece XML; default é Markdown', () => {
    expect(normalizeSourceOutputFormat(undefined)).toBe('markdown')
    expect(normalizeSourceOutputFormat('plain')).toBe('markdown')
    expect(normalizeSourceOutputFormat('JSON')).toBe('markdown')
    expect(normalizeSourceOutputFormat('xml')).toBe('xml')
    expect(DEFAULT_SOURCE_OUTPUT_FORMAT).toBe('markdown')
  })
})
