// @vitest-environment jsdom
/*
-T ---
*/

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSourceSettings } from './useSourceSettings'
import { DEFAULT_SOURCE_PROFILE } from '../../../../../shared/utils/source-profile'

describe('useSourceSettings', () => {
  let savedSettings: any = null

  beforeEach(() => {
    vi.useFakeTimers()
    savedSettings = {
      sourceSettings: {
        outputFormat: 'xml',
        profile: { ...DEFAULT_SOURCE_PROFILE, removeComments: true }
      }
    }

    window.codeAwareness = {
      loadSettings: vi.fn().mockImplementation(async () => ({ ...savedSettings })),
      saveSettings: vi.fn().mockImplementation(async (s) => {
        savedSettings = s
        return { success: true }
      })
    } as any
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('hidrata configurações ao abrir (isOpen: true)', async () => {
    const { result } = renderHook(() => useSourceSettings({ isOpen: true }))

    expect(result.current.ready).toBe(false)

    // Aguarda resolução da promise de loadSettings
    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.ready).toBe(true)
    expect(result.current.outputFormat).toBe('xml')
    expect(result.current.profile.removeComments).toBe(true)
    expect(window.codeAwareness.loadSettings).toHaveBeenCalledTimes(1)
  })

  it('não dispara saveSettings durante a hidratação inicial (skipSave)', async () => {
    renderHook(() => useSourceSettings({ isOpen: true }))

    await act(async () => {
      await Promise.resolve()
    })

    // Avança o tempo do debounce de save (500ms)
    await act(async () => {
      vi.advanceTimersByTime(600)
    })

    // Nenhuma gravação deve ter ocorrido
    expect(window.codeAwareness.saveSettings).not.toHaveBeenCalled()
  })

  it('persiste configurações após 500ms de inatividade (autosave)', async () => {
    const { result } = renderHook(() => useSourceSettings({ isOpen: true }))

    await act(async () => {
      await Promise.resolve()
    })

    // Altera formato
    act(() => {
      result.current.setOutputFormat('markdown')
    })

    // Antes de 500ms, ainda não salvou
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(window.codeAwareness.saveSettings).not.toHaveBeenCalled()

    // Completa os 500ms
    await act(async () => {
      vi.advanceTimersByTime(100)
      await Promise.resolve()
    })

    expect(window.codeAwareness.saveSettings).toHaveBeenCalledTimes(1)
    expect(savedSettings.sourceSettings.outputFormat).toBe('markdown')
  })

  it('executa flush imediatamente ao fechar o modal (isOpen: false)', async () => {
    const { result, rerender } = renderHook(
      (props) => useSourceSettings(props),
      { initialProps: { isOpen: true } }
    )

    await act(async () => {
      await Promise.resolve()
    })

    // Altera perfil
    act(() => {
      result.current.setProfile({ ...DEFAULT_SOURCE_PROFILE, truncateBase64: true })
    })

    // Fecha o modal antes dos 500ms
    rerender({ isOpen: false })

    await act(async () => {
      await Promise.resolve()
    })

    // Flush deve ter persistido imediatamente
    expect(window.codeAwareness.saveSettings).toHaveBeenCalledTimes(1)
    expect(savedSettings.sourceSettings.profile.truncateBase64).toBe(true)
  })

  it('limpa timer de debounce ao desmontar', async () => {
    const { result, unmount } = renderHook(() => useSourceSettings({ isOpen: true }))

    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      result.current.setOutputFormat('xml')
    })

    unmount()

    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
    })

    // Não deve disparar após desmontar
    expect(window.codeAwareness.saveSettings).not.toHaveBeenCalled()
  })
})
