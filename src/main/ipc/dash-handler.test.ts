/*
-T ---
*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashService } from '../core/dash/dash-service'
import type { OneClickXmlService } from '../core/one-click-xml-service'
import { registerDashHandlers } from './dash-handler'

const registeredHandlers = new Map<string, Function>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      registeredHandlers.set(channel, handler)
    })
  }
}))

describe('registerDashHandlers', () => {
  let mockDashService: DashService
  let mockOneClickXmlService: OneClickXmlService

  beforeEach(() => {
    registeredHandlers.clear()
    mockDashService = {
      parseAndResolve: vi.fn(),
      execute: vi.fn()
    } as unknown as DashService

    mockOneClickXmlService = {
      generateOneClickXml: vi.fn()
    } as unknown as OneClickXmlService

    registerDashHandlers(mockDashService, mockOneClickXmlService)
  })

  it('deve registrar os três canais IPC do Code Dash', () => {
    expect(registeredHandlers.has('dash:parse-and-resolve')).toBe(true)
    expect(registeredHandlers.has('dash:generate')).toBe(true)
    expect(registeredHandlers.has('dash:one-click-xml')).toBe(true)
  })

  describe('dash:parse-and-resolve', () => {
    const handler = () => registeredHandlers.get('dash:parse-and-resolve')!

    it('deve retornar erro se repoPath ou input forem inválidos', async () => {
      const res1 = await handler()({}, '', 'repo/path')
      expect(res1.success).toBe(false)
      expect(res1.error).toMatch(/input é obrigatório/)

      const res2 = await handler()({}, 'input text', '')
      expect(res2.success).toBe(false)
      expect(res2.error).toMatch(/repoPath é obrigatório/)
    })

    it('deve delegar para parseAndResolve e retornar o resultado', async () => {
      const fakeResult = {
        success: true,
        data: { valid: true, request: null, failures: [] }
      }
      vi.mocked(mockDashService.parseAndResolve).mockReturnValue(fakeResult as any)

      const res = await handler()({}, 'input text', '/test/repo')
      expect(mockDashService.parseAndResolve).toHaveBeenCalledWith(
        'input text',
        '/test/repo'
      )
      expect(res).toEqual(fakeResult)
    })
  })

  describe('dash:generate', () => {
    const handler = () => registeredHandlers.get('dash:generate')!

    it('deve retornar erro se repoPath ou input forem inválidos', async () => {
      const res1 = await handler()({}, '', 'repo/path')
      expect(res1.success).toBe(false)
      expect(res1.error).toMatch(/input é obrigatório/)

      const res2 = await handler()({}, 'input text', '')
      expect(res2.success).toBe(false)
      expect(res2.error).toMatch(/repoPath é obrigatório/)
    })

    it('deve delegar para execute e retornar sucesso com data', async () => {
      const fakeExecutionResult = {
        success: true,
        xml: '<code-dash-context />',
        metadata: { requested: 1, resolved: 1, generated: 1, failed: 0 }
      }
      vi.mocked(mockDashService.execute).mockResolvedValue(fakeExecutionResult as any)

      const res = await handler()({}, 'valid input', '/test/repo')
      expect(mockDashService.execute).toHaveBeenCalledWith(
        'valid input',
        '/test/repo',
        {
          repoPath: '/test/repo',
          settings: undefined
        }
      )
      expect(res).toEqual({
        success: true,
        data: fakeExecutionResult
      })
    })

    it('deve repassar settings para dashService.execute quando fornecidas', async () => {
      const fakeExecutionResult = {
        success: true,
        xml: '<code-dash-context />',
        tokenCount: 123,
        metadata: { requested: 1, resolved: 1, generated: 1, failed: 0 }
      }
      vi.mocked(mockDashService.execute).mockResolvedValue(fakeExecutionResult as any)

      const settings = {
        removeComments: true,
        removeEmptyLines: true,
        truncateBase64: true
      }

      const res = await handler()({}, 'valid input', '/test/repo', settings)
      expect(mockDashService.execute).toHaveBeenCalledWith(
        'valid input',
        '/test/repo',
        {
          repoPath: '/test/repo',
          settings
        }
      )
      expect(res).toEqual({
        success: true,
        data: fakeExecutionResult
      })
    })

    it('deve retornar erro estruturado quando execute falhar', async () => {
      vi.mocked(mockDashService.execute).mockResolvedValue({
        success: false,
        error: 'Erro de validação'
      } as any)

      const res = await handler()({}, 'invalid input', '/test/repo')
      expect(res).toEqual({
        success: false,
        error: 'Erro de validação'
      })
    })

    it('deve capturar exceções não tratadas', async () => {
      vi.mocked(mockDashService.execute).mockRejectedValue(new Error('Crash no serviço'))

      const res = await handler()({}, 'crash input', '/test/repo')
      expect(res).toEqual({
        success: false,
        error: 'Crash no serviço'
      })
    })
  })

  describe('dash:one-click-xml', () => {
    const handler = () => registeredHandlers.get('dash:one-click-xml')!

    it('deve retornar erro se repoPath for inválido', async () => {
      const res = await handler()({}, '')
      expect(res.success).toBe(false)
      expect(res.error).toMatch(/repoPath é obrigatório/)
    })

    it('deve delegar para generateOneClickXml e retornar resultado de sucesso', async () => {
      const fakeResult = {
        success: true,
        xml: '<repomix><file path="a.ts">content</file></repomix>',
        timings: { listFilesMs: 10, generateMs: 200, totalMs: 210 },
        metadata: { fileCount: 42 }
      }
      vi.mocked(mockOneClickXmlService.generateOneClickXml).mockResolvedValue(fakeResult as any)

      const res = await handler()({}, '/test/repo', { removeComments: true })
      expect(mockOneClickXmlService.generateOneClickXml).toHaveBeenCalledWith('/test/repo', {
        removeComments: true,
        removeEmptyLines: undefined,
        truncateBase64: undefined
      })
      expect(res).toEqual(fakeResult)
    })

    it('deve usar persistedSettings quando opções inline não forem fornecidas', async () => {
      const fakeResult = { success: true, xml: '<xml/>' }
      vi.mocked(mockOneClickXmlService.generateOneClickXml).mockResolvedValue(fakeResult as any)

      const persistedSettings = {
        removeComments: true,
        removeEmptyLines: false,
        truncateBase64: true
      }

      await handler()({}, '/test/repo', { persistedSettings })

      expect(mockOneClickXmlService.generateOneClickXml).toHaveBeenCalledWith('/test/repo', {
        removeComments: true,
        removeEmptyLines: false,
        truncateBase64: true
      })
    })

    it('deve priorizar opções inline explícitas sobre persistedSettings', async () => {
      const fakeResult = { success: true, xml: '<xml/>' }
      vi.mocked(mockOneClickXmlService.generateOneClickXml).mockResolvedValue(fakeResult as any)

      const persistedSettings = {
        removeComments: true,
        removeEmptyLines: true,
        truncateBase64: true
      }

      await handler()({}, '/test/repo', {
        removeComments: false,
        persistedSettings
      })

      expect(mockOneClickXmlService.generateOneClickXml).toHaveBeenCalledWith('/test/repo', {
        removeComments: false,
        removeEmptyLines: true,
        truncateBase64: true
      })
    })

    it('deve retornar erro quando generateOneClickXml falhar', async () => {
      vi.mocked(mockOneClickXmlService.generateOneClickXml).mockResolvedValue({
        success: false,
        error: 'Falha ao listar arquivos'
      } as any)

      const res = await handler()({}, '/test/repo')
      expect(res).toEqual({
        success: false,
        error: 'Falha ao listar arquivos'
      })
    })

    it('deve capturar exceções não tratadas no one-click-xml', async () => {
      vi.mocked(mockOneClickXmlService.generateOneClickXml).mockRejectedValue(
        new Error('Crash no repomix')
      )

      const res = await handler()({}, '/test/repo')
      expect(res).toEqual({
        success: false,
        error: 'Crash no repomix'
      })
    })
  })
})
