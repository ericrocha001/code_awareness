/*
-T ---
*/

import { describe, expect, it, vi } from 'vitest'
import type { DashPlannedItem } from '../../../../shared/types/dash-types'
import type { CodeSourceService } from '../../code-source-service'
import { SourceContextProvider } from './source-context-provider'

describe('SourceContextProvider', () => {
  const repoPath = '/test/repo'

  it('deve chamar o serviço 1 vez para 1 item e retornar o conteúdo no mapa', async () => {
    const mockService = {
      generateWithProfile: vi.fn().mockResolvedValue({
        success: true,
        content: '<file path="src/main.ts">const x = 1;</file>'
      })
    } as unknown as CodeSourceService

    const provider = new SourceContextProvider(mockService)
    const items: DashPlannedItem[] = [
      { index: 0, path: 'src/main.ts', representation: 'source' }
    ]

    const result = await provider.provide(items, { repoPath })

    expect(mockService.generateWithProfile).toHaveBeenCalledTimes(1)
    expect(mockService.generateWithProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath,
        selectedFiles: ['src/main.ts'],
        format: 'xml'
      })
    )
    expect(result.failures).toHaveLength(0)
    expect(result.contents.get(0)).toBe('<file path="src/main.ts">const x = 1;</file>')
  })

  it('deve chamar o serviço sequencialmente 3 vezes para 3 itens preservando os índices', async () => {
    const mockService = {
      generateWithProfile: vi
        .fn()
        .mockResolvedValueOnce({ success: true, content: 'content 0' })
        .mockResolvedValueOnce({ success: true, content: 'content 2' })
        .mockResolvedValueOnce({ success: true, content: 'content 5' })
    } as unknown as CodeSourceService

    const provider = new SourceContextProvider(mockService)
    const items: DashPlannedItem[] = [
      { index: 0, path: 'src/a.ts', representation: 'source' },
      { index: 2, path: 'src/b.ts', representation: 'source' },
      { index: 5, path: 'src/c.ts', representation: 'source' }
    ]

    const result = await provider.provide(items, { repoPath })

    expect(mockService.generateWithProfile).toHaveBeenCalledTimes(3)
    expect(result.contents.get(0)).toBe('content 0')
    expect(result.contents.get(2)).toBe('content 2')
    expect(result.contents.get(5)).toBe('content 5')
    expect(result.failures).toHaveLength(0)
  })

  it('deve registrar falha quando o serviço falhar em 1 item e continuar os demais', async () => {
    const mockService = {
      generateWithProfile: vi
        .fn()
        .mockResolvedValueOnce({ success: true, content: 'content 0' })
        .mockResolvedValueOnce({ success: false, error: 'Erro de leitura em b.ts' })
        .mockResolvedValueOnce({ success: true, content: 'content 2' })
    } as unknown as CodeSourceService

    const provider = new SourceContextProvider(mockService)
    const items: DashPlannedItem[] = [
      { index: 0, path: 'src/a.ts', representation: 'source' },
      { index: 1, path: 'src/b.ts', representation: 'source' },
      { index: 2, path: 'src/c.ts', representation: 'source' }
    ]

    const result = await provider.provide(items, { repoPath })

    expect(mockService.generateWithProfile).toHaveBeenCalledTimes(3)
    expect(result.contents.get(0)).toBe('content 0')
    expect(result.contents.has(1)).toBe(false)
    expect(result.contents.get(2)).toBe('content 2')

    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toEqual({
      index: 1,
      reason: 'Erro de leitura em b.ts'
    })
  })

  it('deve repassar profile customizado quando especificado no item', async () => {
    const mockService = {
      generateWithProfile: vi.fn().mockResolvedValue({
        success: true,
        content: 'custom content'
      })
    } as unknown as CodeSourceService

    const provider = new SourceContextProvider(mockService)
    const customProfile: any = { removeComments: false, version: 1 }
    const items: DashPlannedItem[] = [
      {
        index: 0,
        path: 'src/custom.ts',
        representation: 'source',
        profile: customProfile
      }
    ]

    await provider.provide(items, { repoPath })

    expect(mockService.generateWithProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: customProfile
      })
    )
  })

  it('deve interromper execução quando o AbortSignal estiver cancelado', async () => {
    const controller = new AbortController()
    controller.abort()

    const mockService = {
      generateWithProfile: vi.fn()
    } as unknown as CodeSourceService

    const provider = new SourceContextProvider(mockService)
    const items: DashPlannedItem[] = [
      { index: 0, path: 'src/a.ts', representation: 'source' }
    ]

    await expect(
      provider.provide(items, { repoPath, signal: controller.signal })
    ).rejects.toThrow(/cancelada/)

    expect(mockService.generateWithProfile).not.toHaveBeenCalled()
  })

  it('merge de settings: campos econômicos do profile base são substituídos pelos do settings global', async () => {
    const mockService = {
      generateWithProfile: vi.fn().mockResolvedValue({ success: true, content: 'ok' })
    } as unknown as CodeSourceService

    const provider = new SourceContextProvider(mockService)
    const baseProfile: any = {
      removeComments: false,
      removeEmptyLines: false,
      truncateBase64: false,
      showLineNumbers: true,
      parsableStyle: false,
      version: 1
    }
    const items: DashPlannedItem[] = [
      { index: 0, path: 'src/a.ts', representation: 'source', profile: baseProfile }
    ]

    await provider.provide(items, {
      repoPath,
      settings: { removeComments: true, removeEmptyLines: true, truncateBase64: true }
    })

    const calledProfile = (mockService.generateWithProfile as ReturnType<typeof vi.fn>).mock.calls[0][0].profile
    // Campos econômicos sobrescritos pelo settings
    expect(calledProfile.removeComments).toBe(true)
    expect(calledProfile.removeEmptyLines).toBe(true)
    expect(calledProfile.truncateBase64).toBe(true)
    // Demais campos do profile base preservados
    expect(calledProfile.showLineNumbers).toBe(true)
    expect(calledProfile.version).toBe(1)
  })

  it('sem settings: profile base é repassado sem alteração', async () => {
    const mockService = {
      generateWithProfile: vi.fn().mockResolvedValue({ success: true, content: 'ok' })
    } as unknown as CodeSourceService

    const provider = new SourceContextProvider(mockService)
    const baseProfile: any = {
      removeComments: true,
      removeEmptyLines: false,
      truncateBase64: false,
      showLineNumbers: false,
      parsableStyle: false,
      version: 1
    }
    const items: DashPlannedItem[] = [
      { index: 0, path: 'src/a.ts', representation: 'source', profile: baseProfile }
    ]

    await provider.provide(items, { repoPath })

    const calledProfile = (mockService.generateWithProfile as ReturnType<typeof vi.fn>).mock.calls[0][0].profile
    expect(calledProfile).toEqual(baseProfile)
  })
})
