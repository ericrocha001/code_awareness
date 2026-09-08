// @vitest-environment jsdom
/*
-T ---
*/

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSourceGeneration } from './useSourceGeneration'
import { DEFAULT_SOURCE_PROFILE } from '../../../../../shared/utils/source-profile'

describe('useSourceGeneration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    window.codeAwareness = {
      generateCodeSourceWithProfile: vi.fn().mockResolvedValue({
        success: true,
        content: '# Code',
        tokenCount: 42,
        generationId: 1
      })
    } as any
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('dispara geração após debounce de 300ms', async () => {
    const { result } = renderHook(() =>
      useSourceGeneration({
        repoPath: 'C:\\repo',
        selectedFiles: ['src/a.ts'],
        format: 'markdown',
        profile: DEFAULT_SOURCE_PROFILE,
        sessionKey: 'test-session'
      })
    )

    expect(result.current.isGenerating).toBe(true)
    expect(window.codeAwareness.generateCodeSourceWithProfile).not.toHaveBeenCalled()

    // Avança 299ms: ainda não disparou
    await act(async () => {
      vi.advanceTimersByTime(299)
    })
    expect(window.codeAwareness.generateCodeSourceWithProfile).not.toHaveBeenCalled()

    // Avança mais 1ms (total 300ms): dispara
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(window.codeAwareness.generateCodeSourceWithProfile).toHaveBeenCalledTimes(1)
    expect(window.codeAwareness.generateCodeSourceWithProfile).toHaveBeenCalledWith(
      'C:\\repo',
      ['src/a.ts'],
      'markdown',
      DEFAULT_SOURCE_PROFILE,
      1,
      'test-session'
    )

    // Após resolver a Promise
    expect(result.current.lastCompletedDocument).toEqual({
      content: '# Code',
      tokenCount: 42,
      generationId: 1
    })
    expect(result.current.isGenerating).toBe(false)
  })

  it('reutiliza lastCompletedDocument sem disparar IPC quando a identidade é idêntica à última completada', async () => {
    const { result, rerender } = renderHook(
      (props) => useSourceGeneration(props),
      {
        initialProps: {
          repoPath: 'C:\\repo',
          selectedFiles: ['src/a.ts'],
          format: 'markdown' as const,
          profile: DEFAULT_SOURCE_PROFILE,
          sessionKey: 'test-session'
        }
      }
    )

    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(window.codeAwareness.generateCodeSourceWithProfile).toHaveBeenCalledTimes(1)

    // Rerender com nova referência de array mas mesmo conteúdo (mesma identidade)
    rerender({
      repoPath: 'C:\\repo',
      selectedFiles: ['src/a.ts'],
      format: 'markdown',
      profile: { ...DEFAULT_SOURCE_PROFILE },
      sessionKey: 'test-session'
    })

    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    // Não deve disparar segunda vez
    expect(window.codeAwareness.generateCodeSourceWithProfile).toHaveBeenCalledTimes(1)
    expect(result.current.lastCompletedDocument?.content).toBe('# Code')
  })

  it('preserva lastCompletedDocument durante a execução de uma nova geração', async () => {
    let resolveSecondCall!: (val: any) => void
    const secondPromise = new Promise((resolve) => {
      resolveSecondCall = resolve
    })

    const generateMock = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        content: 'Primeiro',
        tokenCount: 10,
        generationId: 1
      })
      .mockReturnValueOnce(secondPromise)

    window.codeAwareness.generateCodeSourceWithProfile = generateMock

    const { result, rerender } = renderHook(
      (props) => useSourceGeneration(props),
      {
        initialProps: {
          repoPath: 'C:\\repo',
          selectedFiles: ['src/a.ts'],
          format: 'markdown' as const,
          profile: DEFAULT_SOURCE_PROFILE,
          sessionKey: 'test-session'
        }
      }
    )

    // Completa a primeira geração
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(result.current.lastCompletedDocument?.content).toBe('Primeiro')

    // Dispara nova geração com outro arquivo
    rerender({
      repoPath: 'C:\\repo',
      selectedFiles: ['src/b.ts'],
      format: 'markdown',
      profile: DEFAULT_SOURCE_PROFILE,
      sessionKey: 'test-session'
    })

    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(result.current.isGenerating).toBe(true)
    // O documento anterior continua preservado durante a geração em andamento
    expect(result.current.lastCompletedDocument?.content).toBe('Primeiro')

    // Resolve a segunda geração
    await act(async () => {
      resolveSecondCall({
        success: true,
        content: 'Segundo',
        tokenCount: 20,
        generationId: 2
      })
    })

    expect(result.current.isGenerating).toBe(false)
    expect(result.current.lastCompletedDocument?.content).toBe('Segundo')
  })

  it('descarta resultado quando generationId da resposta for defasado em relação ao generationId atual', async () => {
    let resolveFirst!: (val: any) => void
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve
    })

    const generateMock = vi
      .fn()
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce({
        success: true,
        content: 'Geração 2',
        tokenCount: 50,
        generationId: 2
      })

    window.codeAwareness.generateCodeSourceWithProfile = generateMock

    const { result, rerender } = renderHook(
      (props) => useSourceGeneration(props),
      {
        initialProps: {
          repoPath: 'C:\\repo',
          selectedFiles: ['src/a.ts'],
          format: 'markdown' as const,
          profile: DEFAULT_SOURCE_PROFILE,
          sessionKey: 'test-session'
        }
      }
    )

    // Inicia geração 1
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(result.current.currentGenerationId).toBe(1)

    // Inicia geração 2 antes da 1 responder
    rerender({
      repoPath: 'C:\\repo',
      selectedFiles: ['src/b.ts'],
      format: 'markdown',
      profile: DEFAULT_SOURCE_PROFILE,
      sessionKey: 'test-session'
    })

    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(result.current.currentGenerationId).toBe(2)
    expect(result.current.lastCompletedDocument?.content).toBe('Geração 2')

    // Agora resolve a geração 1 atrasada
    await act(async () => {
      resolveFirst({
        success: true,
        content: 'Geração 1 atrasada',
        tokenCount: 10,
        generationId: 1
      })
    })

    // O documento não deve ser sobrescrito com o resultado obsoleto da geração 1
    expect(result.current.lastCompletedDocument?.content).toBe('Geração 2')
  })

  it('cancela debounce pendente ao desmontar o componente', async () => {
    const { unmount } = renderHook(() =>
      useSourceGeneration({
        repoPath: 'C:\\repo',
        selectedFiles: ['src/a.ts'],
        format: 'markdown',
        profile: DEFAULT_SOURCE_PROFILE,
        sessionKey: 'test-session'
      })
    )

    unmount()

    await act(async () => {
      vi.advanceTimersByTime(300)
    })

    expect(window.codeAwareness.generateCodeSourceWithProfile).not.toHaveBeenCalled()
  })

  it('não dispara geração quando selectedFiles está vazio', async () => {
    const { result } = renderHook(() =>
      useSourceGeneration({
        repoPath: 'C:\\repo',
        selectedFiles: [],
        format: 'markdown',
        profile: DEFAULT_SOURCE_PROFILE,
        sessionKey: 'test-session'
      })
    )

    await act(async () => {
      vi.advanceTimersByTime(300)
    })

    expect(window.codeAwareness.generateCodeSourceWithProfile).not.toHaveBeenCalled()
    expect(result.current.isGenerating).toBe(false)
  })
})
