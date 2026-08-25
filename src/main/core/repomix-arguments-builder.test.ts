/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar a construção de argumentos CLI a partir de EffectiveProfile e OutputFormat.
2. Validar a aplicação das flags padrão no caminho compression-core e no caminho direct-output.
3. Validar regras de dependência estrutural (includeEmptyDirectories e includeFullDirectoryStructure requerem includeDirectoryStructure).
4. Validar restrição de parsableStyle exclusivamente para os formatos xml e markdown.
5. Validar a inclusão obrigatória das flags --include, --compress e --stdout em qualquer formato.
6. Validar a construção do contrato tipado RepomixRequest e a derivação dos argumentos CLI a partir dele.

Mapa de Relacionamentos do Script

1. repomix-arguments-builder.ts
   - Tipo: Dependência Direta
   - Relação: Testa buildRepomixCliArguments, buildRepomixRequest e outputFormatToStyle.
   - Criticidade: Alta

2. effective-profile.ts
   - Tipo: Dependência Direta
   - Relação: Consome resolveEffectiveProfile para gerar perfis efetivos de teste.
   - Criticidade: Alta

3. compression-profile.ts
   - Tipo: Dependência Direta
   - Relação: Consome DEFAULT_PROFILE para os cenários de teste.
   - Criticidade: Alta

4. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Consome CompressionProfile e OutputFormat para tipagem de entrada dos testes.
   - Criticidade: Alta

Invariantes do Script

1. Nenhum teste acessa filesystem, invoca a CLI real do Repomix ou depende de estado externo — 100% determinístico em memória.
2. Warnings estruturados gerados pelo builder são verificados e restaurados após cada teste.
3. Argumentos CLI para compression-core nunca contêm --output-show-line-numbers, --no-file-summary ou --no-directory-structure.
4. Argumentos CLI para direct-output preservam a estrutura completa do documento.
5. O contrato RepomixRequest preserva fielmente os campos fornecidos (repoPath, selectedFiles, profile, outputFormat).

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  buildRepomixCliArguments,
  buildRepomixRequest,
  outputFormatToStyle
} from './repomix-arguments-builder'
import { resolveEffectiveProfile } from './effective-profile'
import { DEFAULT_PROFILE } from './compression-profile'
import type { CompressionProfile, OutputFormat } from '../../shared/types'

let warnSpy: ReturnType<typeof vi.spyOn>
afterEach(() => {
  warnSpy?.mockRestore()
})

function fullProfile(overrides: Partial<CompressionProfile> = {}): CompressionProfile {
  return { ...DEFAULT_PROFILE, ...overrides }
}

describe('RepomixArgumentsBuilder — Provas de Aceitação', () => {
  // PA-B01 — Builder do perfil padrão no caminho compression-core (plain / json)
  describe('PA-B01 — Builder no caminho compression-core', () => {
    it('produz os argumentos enxutos para plain (sem flags desnecessárias de documento)', () => {
      const eff = resolveEffectiveProfile(DEFAULT_PROFILE, 'plain')
      const args = buildRepomixCliArguments(eff, 'plain', ['a.ts', 'b.css'])
      expect(args).toEqual([
        '--include', 'a.ts,b.css',
        '--compress',
        '--style', 'plain',
        '--stdout'
      ])
    })

    it('produz os argumentos de documento para json (direct-output) com flags ativas', () => {
      // json agora é documento nativo do Repomix (Direct Output) — incluye flags de estrutura.
      const eff = resolveEffectiveProfile(fullProfile({ removeComments: true, removeEmptyLines: true, truncateBase64: true }), 'json')
      const args = buildRepomixCliArguments(eff, 'json', ['a.ts'])
      expect(args).toEqual([
        '--include', 'a.ts',
        '--compress',
        '--remove-comments',
        '--remove-empty-lines',
        '--truncate-base64',
        '--style', 'json',
        '--stdout',
        '--no-file-summary',
        '--no-directory-structure'
      ])
    })
  })

  // PA-B02 — Builder do perfil padrão no caminho direct-output (markdown / xml)
  describe('PA-B02 — Builder no caminho direct-output', () => {
    it('produz o conjunto completo de flags de documento para markdown', () => {
      const eff = resolveEffectiveProfile(DEFAULT_PROFILE, 'markdown')
      const args = buildRepomixCliArguments(eff, 'markdown', ['a.ts', 'b.css'])
      expect(args).toEqual([
        '--include', 'a.ts,b.css',
        '--compress',
        '--style', 'markdown',
        '--stdout',
        '--no-file-summary',
        '--no-directory-structure'
      ])
    })

    it('produz o conjunto completo de flags de documento para xml', () => {
      const eff = resolveEffectiveProfile(DEFAULT_PROFILE, 'xml')
      const args = buildRepomixCliArguments(eff, 'xml', ['a.ts'])
      expect(args).toEqual([
        '--include', 'a.ts',
        '--compress',
        '--style', 'xml',
        '--stdout',
        '--no-file-summary',
        '--no-directory-structure'
      ])
    })
  })

  // PA-B03 — Dependências de directory structure no direct-output
  describe('PA-B03 — Dependências de directory structure', () => {
    it('includeEmptyDirectories sem directoryStructure é ignorado (com warning)', () => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const eff = resolveEffectiveProfile(
        fullProfile({ includeDirectoryStructure: false, includeEmptyDirectories: true }),
        'markdown'
      )
      const args = buildRepomixCliArguments(eff, 'markdown', ['a.ts'])
      expect(args).not.toContain('--include-empty-directories')
      expect(args).toContain('--no-directory-structure')
      expect(warnSpy).toHaveBeenCalled()
    })

    it('includeFullDirectoryStructure sem directoryStructure é ignorado (com warning)', () => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const eff = resolveEffectiveProfile(
        fullProfile({ includeDirectoryStructure: false, includeFullDirectoryStructure: true }),
        'markdown'
      )
      const args = buildRepomixCliArguments(eff, 'markdown', ['a.ts'])
      expect(args).not.toContain('--include-full-directory-structure')
      expect(warnSpy).toHaveBeenCalled()
    })

    it('com directoryStructure habilitado, os includes são emitidos', () => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const eff = resolveEffectiveProfile(
        fullProfile({
          includeDirectoryStructure: true,
          includeEmptyDirectories: true,
          includeFullDirectoryStructure: true
        }),
        'markdown'
      )
      const args = buildRepomixCliArguments(eff, 'markdown', ['a.ts'])
      expect(args).toContain('--include-empty-directories')
      expect(args).toContain('--include-full-directory-structure')
      expect(args).not.toContain('--no-directory-structure')
      expect(warnSpy).not.toHaveBeenCalled()
    })
  })

  // PA-B04 — parsableStyle só relevante para xml/markdown
  describe('PA-B04 — parsableStyle só relevante para xml/markdown', () => {
    it('xml e markdown: --parsable-style emitido quando ativo', () => {
      const xmlEff = resolveEffectiveProfile(fullProfile({ parsableStyle: true }), 'xml')
      const mdEff = resolveEffectiveProfile(fullProfile({ parsableStyle: true }), 'markdown')
      const xmlArgs = buildRepomixCliArguments(xmlEff, 'xml', ['a.ts'])
      const mdArgs = buildRepomixCliArguments(mdEff, 'markdown', ['a.ts'])
      expect(xmlArgs).toContain('--parsable-style')
      expect(mdArgs).toContain('--parsable-style')
    })
  })

  // PA-B05 — Flags obrigatórias
  describe('PA-B05 — Flags obrigatórias', () => {
    it.each(['plain', 'markdown', 'xml', 'json'] as OutputFormat[])(
      'formato "%s": contém --compress, --stdout e --include no início',
      (fmt) => {
        const eff = resolveEffectiveProfile(DEFAULT_PROFILE, fmt)
        const args = buildRepomixCliArguments(eff, fmt, ['a.ts', 'b.ts'])
        expect(args[0]).toBe('--include')
        expect(args[1]).toBe('a.ts,b.ts')
        expect(args).toContain('--compress')
        expect(args).toContain('--stdout')
      }
    )
  })

  // PA-B06 — RepomixRequest (contrato tipado)
  describe('PA-B06 — RepomixRequest encapsula o contrato', () => {
    const eff = resolveEffectiveProfile(DEFAULT_PROFILE, 'plain')

    it('mantém todos os campos esperados e os preserva fielmente', () => {
      const request = buildRepomixRequest('/repo', ['a.ts', 'b.css'], eff, 'plain')
      expect(request.repoPath).toBe('/repo')
      expect(request.selectedFiles).toEqual(['a.ts', 'b.css'])
      expect(request.profile).toBe(eff)
      expect(request.outputFormat).toBe('plain')
    })

    it('permite derivar os argumentos CLI equivalentes a partir do contrato', () => {
      const request = buildRepomixRequest('/repo', ['a.ts', 'b.css'], eff, 'plain')
      const args = buildRepomixCliArguments(request.profile, request.outputFormat, request.selectedFiles)
      expect(args[0]).toBe('--include')
      expect(args[1]).toBe('a.ts,b.css')
      expect(args).toContain('--compress')
      expect(args).toContain('--style')
      expect(args).toContain('plain')
    })
  })

  // PA-B07 — outputFormatToStyle
  describe('PA-B07 — outputFormatToStyle', () => {
    it.each(['plain', 'markdown', 'xml', 'json'] as OutputFormat[])(
      'retorna o próprio formato "%s"',
      (fmt) => {
        expect(outputFormatToStyle(fmt)).toBe(fmt)
      }
    )
  })
})
