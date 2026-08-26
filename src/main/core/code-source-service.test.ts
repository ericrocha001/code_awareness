/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar o contrato do novo fluxo de geração seletiva com perfil do CodeSourceService.
2. Validar a normalização defensiva de perfil e formato antes da delegação.
3. Validar o retorno estruturado e o cálculo de tokens sobre a saída final.
4. Garantir a ausência de escrita automática de artefato no fluxo novo.

Mapa de Relacionamentos do Script

1. code-source-service.ts
   - Tipo: Dependência Direta
   - Relação: Testa generateWithProfile com adaptador falsificado injetado.
   - Criticidade: Alta

2. shared/utils/source-profile.ts
   - Tipo: Dependência Direta
   - Relação: Usa DEFAULT_SOURCE_PROFILE como referência de defaults.
   - Criticidade: Média

Invariantes do Script

1. Nenhum teste executa Repomix real, acessa filesystem real, Electron ou IPC.
2. Nenhuma escrita em arquivo ocorre durante o fluxo novo (fs.writeFile espionado).
3. Erros do adapter nunca propagam — o serviço sempre retorna objeto estruturado.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { promises as fs } from 'fs'
import { CodeSourceService } from './code-source-service'
import type { RepomixOutputAdapter } from './repomix-output-adapter'
import { DEFAULT_SOURCE_PROFILE } from '../../shared/utils/source-profile'
import type { SourceProfile, SourceOutputFormat } from '../../shared/types'

/** Adaptador falsificado com comportamento configurável por teste. */
function makeFakeAdapter(overrides: Partial<RepomixOutputAdapter> = {}): RepomixOutputAdapter {
  const base = {
    generateSelectiveSource: vi.fn(async (): Promise<string> => 'conteúdo gerado'),
    generateSelectiveMarkdown: vi.fn(),
    generateFullRepositoryMarkdown: vi.fn()
  }
  return Object.assign(base, overrides) as unknown as RepomixOutputAdapter
}

const INPUT = {
  repoPath: 'C:\\repos\\demo',
  selectedFiles: ['src/a.ts', 'src/b.ts']
}

describe('CodeSourceService.generateWithProfile', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('Geração bem-sucedida', () => {
    it('retorna success true, conteúdo exato do adapter e tokenCount sobre a saída final', async () => {
      const content = 'a'.repeat(400)
      const adapter = makeFakeAdapter({ generateSelectiveSource: vi.fn(async () => content) })
      const service = new CodeSourceService(adapter)

      const result = await service.generateWithProfile({ ...INPUT })

      expect(result.success).toBe(true)
      expect(result.content).toBe(content)
      expect(result.tokenCount).toBe(Math.ceil(content.length / 4))
      expect(result.error).toBeUndefined()
    })

    it('calcula tokenCount pelo tamanho do CONTEÚDO, não dos arquivos de entrada', async () => {
      // Entrada longa, saída curta: o count deve refletir a saída.
      const adapter = makeFakeAdapter({ generateSelectiveSource: vi.fn(async () => 'ok!') })
      const service = new CodeSourceService(adapter)

      const result = await service.generateWithProfile({
        ...INPUT,
        selectedFiles: ['x'.repeat(10000) + '.ts']
      })

      expect(result.tokenCount).toBe(Math.ceil('ok!'.length / 4))
    })
  })

  describe('Normalização defensiva', () => {
    it('perfil ausente usa defaults na delegação', async () => {
      const adapter = makeFakeAdapter()
      const service = new CodeSourceService(adapter)

      const result = await service.generateWithProfile({ ...INPUT })

      expect(result.success).toBe(true)
      expect(adapter.generateSelectiveSource).toHaveBeenCalledWith(
        INPUT.repoPath,
        INPUT.selectedFiles,
        'markdown',
        DEFAULT_SOURCE_PROFILE
      )
    })

    it('perfil com campos inválidos normaliza sem lançar', async () => {
      const adapter = makeFakeAdapter()
      const service = new CodeSourceService(adapter)

      const result = await service.generateWithProfile({
        ...INPUT,
        profile: { removeComments: 'sim', showLineNumbers: 1, version: -5 } as unknown as SourceProfile
      })

      expect(result.success).toBe(true)
      const [, , , profile] = (adapter.generateSelectiveSource as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        string[],
        SourceOutputFormat,
        SourceProfile
      ]
      expect(profile).toEqual(DEFAULT_SOURCE_PROFILE)
    })

    it('formato ausente ou inválido é delegado como Markdown; XML válido permanece XML', async () => {
      const adapter = makeFakeAdapter()
      const service = new CodeSourceService(adapter)

      await service.generateWithProfile({ ...INPUT })
      await service.generateWithProfile({ ...INPUT, format: 'json' })
      await service.generateWithProfile({ ...INPUT, format: 'xml' })

      const calls = (adapter.generateSelectiveSource as ReturnType<typeof vi.fn>).mock
        .calls as unknown as Array<[string, string[], SourceOutputFormat, SourceProfile]>
      expect(calls[0][2]).toBe('markdown')
      expect(calls[1][2]).toBe('markdown')
      expect(calls[2][2]).toBe('xml')
    })

    it('perfil parcial preserva campos válidos e normaliza os inválidos', async () => {
      const adapter = makeFakeAdapter()
      const service = new CodeSourceService(adapter)

      await service.generateWithProfile({
        ...INPUT,
        profile: { removeComments: true, parsableStyle: 'x' } as unknown as SourceProfile
      })

      const expected = { ...DEFAULT_SOURCE_PROFILE, removeComments: true }
      expect(adapter.generateSelectiveSource).toHaveBeenCalledWith(
        INPUT.repoPath,
        INPUT.selectedFiles,
        'markdown',
        expected
      )
    })
  })

  describe('Validação de entrada', () => {
    it('repoPath vazio retorna success false com erro e não delega', async () => {
      const adapter = makeFakeAdapter()
      const service = new CodeSourceService(adapter)

      const result = await service.generateWithProfile({ ...INPUT, repoPath: '' })

      expect(result.success).toBe(false)
      expect(result.error).toBeTruthy()
      expect(adapter.generateSelectiveSource).not.toHaveBeenCalled()
    })

    it('selectedFiles vazio retorna success false com erro e não delega', async () => {
      const adapter = makeFakeAdapter()
      const service = new CodeSourceService(adapter)

      const result = await service.generateWithProfile({ ...INPUT, selectedFiles: [] })

      expect(result.success).toBe(false)
      expect(result.error).toBeTruthy()
      expect(adapter.generateSelectiveSource).not.toHaveBeenCalled()
    })

    it('selectedFiles não array retorna success false com erro e não delega', async () => {
      const adapter = makeFakeAdapter()
      const service = new CodeSourceService(adapter)

      const result = await service.generateWithProfile({
        ...INPUT,
        selectedFiles: 'src/a.ts' as unknown as string[]
      })

      expect(result.success).toBe(false)
      expect(result.error).toBeTruthy()
      expect(adapter.generateSelectiveSource).not.toHaveBeenCalled()
    })
  })

  describe('Tratamento de erro do adapter', () => {
    it('adapter lançando exceção resulta em success false com mensagem — sem propagar', async () => {
      const adapter = makeFakeAdapter({
        generateSelectiveSource: vi.fn(async () => {
          throw new Error('Repomix explodiu')
        })
      })
      const service = new CodeSourceService(adapter)

      const result = await service.generateWithProfile({ ...INPUT })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Repomix explodiu')
      expect(result.content).toBeUndefined()
    })
  })

  describe('Ausência de escrita automática', () => {
    it('o fluxo novo não chama fs.writeFile nem cria diretórios', async () => {
      const writeFileSpy = vi.spyOn(fs, 'writeFile').mockImplementation(async () => undefined as never)
      const mkdirSpy = vi.spyOn(fs, 'mkdir').mockImplementation(async () => undefined as never)
      const accessSpy = vi.spyOn(fs, 'access').mockImplementation(async () => undefined as never)
      const adapter = makeFakeAdapter()
      const service = new CodeSourceService(adapter)

      const result = await service.generateWithProfile({ ...INPUT })

      expect(result.success).toBe(true)
      expect(writeFileSpy).not.toHaveBeenCalled()
      expect(mkdirSpy).not.toHaveBeenCalled()
      expect(accessSpy).not.toHaveBeenCalled()
    })
  })

  describe('Delegação correta', () => {
    it('delega exatamente uma vez com repoPath, arquivos, formato e perfil normalizados', async () => {
      const adapter = makeFakeAdapter()
      const service = new CodeSourceService(adapter)

      await service.generateWithProfile({
        ...INPUT,
        profile: { removeComments: true, parsableStyle: 'x' } as unknown as SourceProfile,
        format: 'xml'
      })

      expect(adapter.generateSelectiveSource).toHaveBeenCalledTimes(1)
      const [repoPath, files, format, profile] = (adapter.generateSelectiveSource as ReturnType<typeof vi.fn>).mock
        .calls[0] as unknown as [string, string[], SourceOutputFormat, SourceProfile]
      expect(repoPath).toBe(INPUT.repoPath)
      expect(files).toEqual(INPUT.selectedFiles)
      expect(format).toBe('xml')
      expect(profile.removeComments).toBe(true)
      // Campo inválido foi normalizado ao default, não repassado cru.
      expect(profile.parsableStyle).toBe(DEFAULT_SOURCE_PROFILE.parsableStyle)
    })
  })
})

