/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar as invariantes arquiteturais do subsistema Code Source em testes de regressão protegidos.
2. Garantir que o Code Source nunca emite a flag --compress em nenhuma combinação de opções.
3. Garantir a existência de um único caminho público de geração no serviço e no adapter.
4. Garantir que as configurações de Source e Compression permanecem estritamente isoladas em AppSettings.
5. Validar a propagação de AbortSignal, descarte de cancelamento e integridade do transporte.

Mapa de Relacionamentos do Script

1. code-source-service.ts
   - Tipo: Dependência Direta
   - Relação: Valida métodos públicos e contrato de generateWithProfile.
   - Criticidade: Alta

2. repomix-output-adapter.ts
   - Tipo: Dependência Direta
   - Relação: Valida métodos públicos do adapter.
   - Criticidade: Alta

3. code-source-arguments-builder.ts
   - Tipo: Dependência Direta
   - Relação: Valida que buildSourceCliArguments nunca emite --compress.
   - Criticidade: Alta

4. source-include-transport-resolver.ts
   - Tipo: Dependência Direta
   - Relação: Valida a decisão entre inline-include e config-file.
   - Criticidade: Alta

5. generation-errors.ts
   - Tipo: Dependência Direta
   - Relação: Valida que GenerationCancelledError é relançado.
   - Criticidade: Alta

Invariantes do Script

1. O Code Source nunca deve emitir a flag --compress sob qualquer configuração.
2. CodeSourceService não deve expor nenhum método de geração além de generateWithProfile.
3. RepomixOutputAdapter não deve expor nenhum método de geração além de generateSelectiveSource.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, it, expect, vi } from 'vitest'
import { CodeSourceService } from './code-source-service'
import { RepomixOutputAdapter } from './repomix-output-adapter'
import { buildSourceCliArguments } from './code-source-arguments-builder'
import { SourceIncludeTransportResolver } from './source-include-transport-resolver'
import { GenerationCancelledError } from './generation-errors'
import { DEFAULT_SOURCE_PROFILE, normalizeSourceProfile } from '../../shared/utils/source-profile'
import type { AppSettings, SourceOutputFormat, SourceProfile } from '../../shared/types'

describe('Code Source — Testes de Regressão Arquitetural', () => {
  describe('Invariante I-1: O Code Source NUNCA emite a flag --compress', () => {
    it('buildSourceCliArguments não inclui --compress em nenhuma combinação de opções', () => {
      const formats: SourceOutputFormat[] = ['markdown', 'xml']
      const transports = ['inline-include', 'config-file'] as const
      const files = ['src/a.ts', 'src/b.ts']

      for (const format of formats) {
        for (const transport of transports) {
          const configPath = transport === 'config-file' ? 'C:\\temp\\cfg.json' : undefined

          // Testa com perfil default
          const defaultArgs = buildSourceCliArguments(
            DEFAULT_SOURCE_PROFILE,
            format,
            files,
            transport,
            configPath
          )
          expect(defaultArgs).not.toContain('--compress')

          // Testa com todas as flags do perfil ativadas
          const allTrueProfile: SourceProfile = {
            removeComments: true,
            removeEmptyLines: true,
            truncateBase64: true,
            showLineNumbers: true,
            parsableStyle: true,
            includeFileSummary: true,
            includeDirectoryStructure: true,
            includeEmptyDirectories: true,
            includeFullDirectoryStructure: true,
            version: 1
          }
          const allTrueArgs = buildSourceCliArguments(
            allTrueProfile,
            format,
            files,
            transport,
            configPath
          )
          expect(allTrueArgs).not.toContain('--compress')

          // Testa com todas as flags do perfil desativadas
          const allFalseProfile: SourceProfile = {
            removeComments: false,
            removeEmptyLines: false,
            truncateBase64: false,
            showLineNumbers: false,
            parsableStyle: false,
            includeFileSummary: false,
            includeDirectoryStructure: false,
            includeEmptyDirectories: false,
            includeFullDirectoryStructure: false,
            version: 1
          }
          const allFalseArgs = buildSourceCliArguments(
            allFalseProfile,
            format,
            files,
            transport,
            configPath
          )
          expect(allFalseArgs).not.toContain('--compress')
        }
      }
    })

    it('CodeSourceService.generateWithProfile nunca passa --compress ao adapter', async () => {
      let receivedArgs: any[] = []
      const fakeAdapter = {
        generateSelectiveSource: vi.fn(async (_repo, _files, format, profile) => {
          receivedArgs = [format, profile]
          return '# Document Generated'
        })
      } as unknown as RepomixOutputAdapter

      const service = new CodeSourceService(fakeAdapter)
      await service.generateWithProfile({
        repoPath: 'C:\\repo',
        selectedFiles: ['src/a.ts'],
        format: 'markdown',
        profile: DEFAULT_SOURCE_PROFILE
      })

      expect(fakeAdapter.generateSelectiveSource).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(receivedArgs)).not.toContain('--compress')
    })
  })

  describe('Invariante I-4: Único caminho de geração no serviço e adapter', () => {
    it('CodeSourceService expõe apenas generateWithProfile como método de geração', () => {
      const service = new CodeSourceService()
      const proto = Object.getPrototypeOf(service)
      const methods = Object.getOwnPropertyNames(proto).filter(
        (prop) => typeof (service as any)[prop] === 'function' && prop !== 'constructor'
      )

      expect(methods).toContain('generateWithProfile')
      expect(methods).not.toContain('generateCodeSource')
      expect(methods).not.toContain('generateSelectiveMarkdown')
      expect(methods).not.toContain('generateFullRepositoryMarkdown')
    })

    it('RepomixOutputAdapter expõe apenas generateSelectiveSource e checkInstallation', () => {
      const adapter = new RepomixOutputAdapter()
      const proto = Object.getPrototypeOf(adapter)
      const methods = Object.getOwnPropertyNames(proto).filter(
        (prop) => typeof (adapter as any)[prop] === 'function' && prop !== 'constructor'
      )

      expect(methods).toContain('generateSelectiveSource')
      expect(methods).not.toContain('generateSelectiveMarkdown')
      expect(methods).not.toContain('generateFullRepositoryMarkdown')
      expect(methods).not.toContain('generateCodeSource')
    })
  })

  describe('Invariante I-5: Persistência isolada entre sourceSettings e compressionSettings', () => {
    it('sourceSettings e compressionSettings coexistem como chaves independentes em AppSettings', () => {
      const settings: AppSettings = {
        rootFolders: [],
        individualProjects: [],
        hiddenProjects: [],
        ignoredDiffFiles: {},
        tags: {},
        fileTags: {},
        projectPreferences: {},
        compressionSettings: {
          profile: {
            removeComments: true,
            removeEmptyLines: true,
            truncateBase64: true,
            showLineNumbers: true,
            parsableStyle: true,
            outputFilePathStyle: 'target-relative',
            includeFileSummary: true,
            includeDirectoryStructure: true,
            includeEmptyDirectories: true,
            includeFullDirectoryStructure: true,
            version: 1
          },
          outputFormat: 'markdown'
        },
        sourceSettings: {
          profile: DEFAULT_SOURCE_PROFILE,
          outputFormat: 'markdown'
        }
      }

      // Modificação e normalização de sourceSettings não altera compressionSettings
      const modifiedSourceProfile = normalizeSourceProfile({
        ...settings.sourceSettings!.profile,
        removeComments: false
      })

      const updatedSettings: AppSettings = {
        ...settings,
        sourceSettings: {
          ...settings.sourceSettings!,
          profile: modifiedSourceProfile
        }
      }

      expect(updatedSettings.sourceSettings?.profile.removeComments).toBe(false)
      expect(updatedSettings.compressionSettings?.profile.removeComments).toBe(true)
    })
  })

  describe('Regressão de Retorno e TokenCount', () => {
    it('generateWithProfile retorna o conteúdo integral e o cálculo de tokens sobre a saída', async () => {
      const content = 'Linha 1\nLinha 2\nLinha 3\n'
      const fakeAdapter = {
        generateSelectiveSource: vi.fn(async () => content)
      } as unknown as RepomixOutputAdapter

      const service = new CodeSourceService(fakeAdapter)
      const result = await service.generateWithProfile({
        repoPath: 'C:\\repo',
        selectedFiles: ['src/a.ts']
      })

      expect(result.success).toBe(true)
      expect(result.content).toBe(content)
      expect(result.tokenCount).toBe(Math.ceil(content.length / 4))
    })
  })

  describe('Regressão de Cancelamento via AbortSignal', () => {
    it('generateWithProfile propaga AbortSignal e relança GenerationCancelledError', async () => {
      const controller = new AbortController()
      const fakeAdapter = {
        generateSelectiveSource: vi.fn(async () => {
          throw new GenerationCancelledError('Geração abortada')
        })
      } as unknown as RepomixOutputAdapter

      const service = new CodeSourceService(fakeAdapter)

      await expect(
        service.generateWithProfile({
          repoPath: 'C:\\repo',
          selectedFiles: ['src/a.ts'],
          signal: controller.signal
        })
      ).rejects.toBeInstanceOf(GenerationCancelledError)

      expect(fakeAdapter.generateSelectiveSource).toHaveBeenCalledWith(
        'C:\\repo',
        ['src/a.ts'],
        'markdown',
        DEFAULT_SOURCE_PROFILE,
        controller.signal
      )
    })
  })

  describe('Regressão de Transporte (SourceIncludeTransportResolver)', () => {
    it('decide inline-include para poucos arquivos e config-file para muitos arquivos', () => {
      const resolver = new SourceIncludeTransportResolver()

      expect(resolver.decide(['src/a.ts'])).toBe('inline-include')

      const manyFiles = Array.from({ length: 400 }, (_, i) => `src/modules/module-${i}/file-${i}.ts`)
      expect(resolver.decide(manyFiles)).toBe('config-file')
    })
  })
})
