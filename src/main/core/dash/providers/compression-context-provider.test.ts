/*
-T ---
*/

import { describe, expect, it, vi } from 'vitest'
import type { DashPlannedItem } from '../../../../shared/types/dash-types'
import type { StructuredCompressionPort } from '../../structured-compression-port'
import { CompressionContextProvider } from './compression-context-provider'

describe('CompressionContextProvider', () => {
  const repoPath = '/test/repo'

  it('deve chamar compressFilesStructured 1 vez com array de 5 arquivos (batch) para 5 itens do mesmo perfil', async () => {
    const mockPort: StructuredCompressionPort = {
      compressFilesStructured: vi.fn().mockResolvedValue({
        results: {
          'src/a.ts': 'compressed a',
          'src/b.ts': 'compressed b',
          'src/c.ts': 'compressed c',
          'src/d.ts': 'compressed d',
          'src/e.ts': 'compressed e'
        },
        errors: [],
        errorReasons: {}
      })
    }

    const provider = new CompressionContextProvider(mockPort)
    const items: DashPlannedItem[] = [
      { index: 0, path: 'src/a.ts', representation: 'compression' },
      { index: 1, path: 'src/b.ts', representation: 'compression' },
      { index: 2, path: 'src/c.ts', representation: 'compression' },
      { index: 3, path: 'src/d.ts', representation: 'compression' },
      { index: 4, path: 'src/e.ts', representation: 'compression' }
    ]

    const result = await provider.provide(items, { repoPath })

    expect(mockPort.compressFilesStructured).toHaveBeenCalledTimes(1)
    expect(mockPort.compressFilesStructured).toHaveBeenCalledWith(
      repoPath,
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
      expect.anything(),
      'plain'
    )
    expect(result.failures).toHaveLength(0)
    expect(result.contents.get(0)).toBe('compressed a')
    expect(result.contents.get(1)).toBe('compressed b')
    expect(result.contents.get(2)).toBe('compressed c')
    expect(result.contents.get(3)).toBe('compressed d')
    expect(result.contents.get(4)).toBe('compressed e')
  })

  it('deve agrupar itens por perfil e fazer chamadas separadas para cada grupo', async () => {
    const mockPort: StructuredCompressionPort = {
      compressFilesStructured: vi
        .fn()
        .mockResolvedValueOnce({
          results: { 'src/a.ts': 'compressed a default' },
          errors: [],
          errorReasons: {}
        })
        .mockResolvedValueOnce({
          results: { 'src/b.ts': 'compressed b custom' },
          errors: [],
          errorReasons: {}
        })
    }

    const provider = new CompressionContextProvider(mockPort)
    const items: DashPlannedItem[] = [
      { index: 0, path: 'src/a.ts', representation: 'compression' },
      {
        index: 1,
        path: 'src/b.ts',
        representation: 'compression',
        profile: JSON.stringify({ removeComments: true })
      }
    ]

    const result = await provider.provide(items, { repoPath })

    expect(mockPort.compressFilesStructured).toHaveBeenCalledTimes(2)
    expect(result.contents.get(0)).toBe('compressed a default')
    expect(result.contents.get(1)).toBe('compressed b custom')
    expect(result.failures).toHaveLength(0)
  })

  it('deve lidar com falhas parciais reportando erros estruturados e preenchendo os sucessos', async () => {
    const mockPort: StructuredCompressionPort = {
      compressFilesStructured: vi.fn().mockResolvedValue({
        results: { 'src/ok.ts': 'compressed ok' },
        errors: ['src/fail.ts'],
        errorReasons: { 'src/fail.ts': 'arquivo inacessível' }
      })
    }

    const provider = new CompressionContextProvider(mockPort)
    const items: DashPlannedItem[] = [
      { index: 0, path: 'src/ok.ts', representation: 'compression' },
      { index: 1, path: 'src/fail.ts', representation: 'compression' }
    ]

    const result = await provider.provide(items, { repoPath })

    expect(result.contents.get(0)).toBe('compressed ok')
    expect(result.contents.has(1)).toBe(false)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toEqual({
      index: 1,
      reason: 'arquivo inacessível'
    })
  })

  it('deve capturar exceção de compressFilesStructured e registrar falhas para todos os itens do grupo', async () => {
    const mockPort: StructuredCompressionPort = {
      compressFilesStructured: vi.fn().mockRejectedValue(new Error('Falha no processo'))
    }

    const provider = new CompressionContextProvider(mockPort)
    const items: DashPlannedItem[] = [
      { index: 0, path: 'src/a.ts', representation: 'compression' },
      { index: 1, path: 'src/b.ts', representation: 'compression' }
    ]

    const result = await provider.provide(items, { repoPath })

    expect(result.contents.size).toBe(0)
    expect(result.failures).toHaveLength(2)
    expect(result.failures[0]).toEqual({ index: 0, reason: 'Falha no processo' })
    expect(result.failures[1]).toEqual({ index: 1, reason: 'Falha no processo' })
  })

  it('deve retornar resultado vazio quando a lista de itens estiver vazia', async () => {
    const mockPort: StructuredCompressionPort = {
      compressFilesStructured: vi.fn()
    }

    const provider = new CompressionContextProvider(mockPort)
    const result = await provider.provide([], { repoPath })

    expect(result.contents.size).toBe(0)
    expect(result.failures).toHaveLength(0)
    expect(mockPort.compressFilesStructured).not.toHaveBeenCalled()
  })

  it('deve lançar erro quando signal já estiver abortado', async () => {
    const mockPort: StructuredCompressionPort = {
      compressFilesStructured: vi.fn()
    }

    const provider = new CompressionContextProvider(mockPort)
    const abortController = new AbortController()
    abortController.abort()

    await expect(
      provider.provide(
        [{ index: 0, path: 'src/a.ts', representation: 'compression' }],
        { repoPath, signal: abortController.signal }
      )
    ).rejects.toThrow(/cancelada pelo usuário/)
  })

  it('merge de settings: campos econômicos do profile são substituídos e profileKey agrupa por profile efetivo', async () => {
    // Ambos os itens têm o mesmo profile base; com settings iguais → 1 única chamada em batch
    const mockPort: StructuredCompressionPort = {
      compressFilesStructured: vi.fn().mockResolvedValue({
        results: { 'src/a.ts': 'c-a', 'src/b.ts': 'c-b' },
        errors: [],
        errorReasons: {}
      })
    }

    const provider = new CompressionContextProvider(mockPort)
    const items: DashPlannedItem[] = [
      { index: 0, path: 'src/a.ts', representation: 'compression' },
      { index: 1, path: 'src/b.ts', representation: 'compression' }
    ]

    const result = await provider.provide(items, {
      repoPath,
      settings: { removeComments: true, removeEmptyLines: false, truncateBase64: false }
    })

    // Uma única chamada porque ambos resultam no mesmo profile efetivo após o merge
    expect(mockPort.compressFilesStructured).toHaveBeenCalledTimes(1)
    const calledProfile = (mockPort.compressFilesStructured as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(calledProfile.removeComments).toBe(true)
    expect(result.contents.get(0)).toBe('c-a')
    expect(result.contents.get(1)).toBe('c-b')
  })

  it('merge de settings: demais campos do profile base são preservados', async () => {
    const mockPort: StructuredCompressionPort = {
      compressFilesStructured: vi.fn().mockResolvedValue({
        results: { 'src/a.ts': 'ok' },
        errors: [],
        errorReasons: {}
      })
    }

    const provider = new CompressionContextProvider(mockPort)
    const baseProfile = {
      removeComments: false,
      removeEmptyLines: false,
      truncateBase64: false,
      showLineNumbers: true,
      parsableStyle: true,
      outputFilePathStyle: 'target-relative',
      includeFileSummary: false,
      includeDirectoryStructure: true,
      includeEmptyDirectories: false,
      includeFullDirectoryStructure: false,
      version: 2
    }
    const items: DashPlannedItem[] = [
      { index: 0, path: 'src/a.ts', representation: 'compression', profile: baseProfile as any }
    ]

    await provider.provide(items, {
      repoPath,
      settings: { removeComments: true, removeEmptyLines: true, truncateBase64: true }
    })

    const calledProfile = (mockPort.compressFilesStructured as ReturnType<typeof vi.fn>).mock.calls[0][2]
    // Campos econômicos sobrescritos
    expect(calledProfile.removeComments).toBe(true)
    expect(calledProfile.removeEmptyLines).toBe(true)
    expect(calledProfile.truncateBase64).toBe(true)
    // Demais campos do profile base preservados
    expect(calledProfile.showLineNumbers).toBe(true)
    expect(calledProfile.parsableStyle).toBe(true)
    expect(calledProfile.version).toBe(2)
  })

  it('sem settings: comportamento atual permanece inalterado', async () => {
    const mockPort: StructuredCompressionPort = {
      compressFilesStructured: vi.fn().mockResolvedValue({
        results: { 'src/a.ts': 'ok' },
        errors: [],
        errorReasons: {}
      })
    }

    const provider = new CompressionContextProvider(mockPort)
    const items: DashPlannedItem[] = [
      { index: 0, path: 'src/a.ts', representation: 'compression' }
    ]

    await provider.provide(items, { repoPath })

    const calledProfile = (mockPort.compressFilesStructured as ReturnType<typeof vi.fn>).mock.calls[0][2]
    // Sem settings, deve usar DEFAULT_PROFILE cujos campos econômicos são false
    expect(calledProfile.removeComments).toBe(false)
    expect(calledProfile.removeEmptyLines).toBe(false)
    expect(calledProfile.truncateBase64).toBe(false)
  })
})
