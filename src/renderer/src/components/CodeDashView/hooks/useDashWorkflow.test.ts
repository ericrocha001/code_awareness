// @vitest-environment jsdom
/*
-T ---
*/

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDashWorkflow } from './useDashWorkflow'

describe('useDashWorkflow', () => {
  const repoPath = '/tmp/test-repo'

  beforeEach(() => {
    window.codeAwareness = {
      dashParseAndResolve: vi.fn(),
      dashGenerate: vi.fn(),
      saveXml: vi.fn()
    } as any
  })

  it('deve inicializar com o estado "idle" e campos limpos', () => {
    const { result } = renderHook(() => useDashWorkflow(repoPath))

    expect(result.current.state).toBe('idle')
    expect(result.current.input).toBe('')
    expect(result.current.resolutionReport).toBeNull()
    expect(result.current.xml).toBeNull()
    expect(result.current.tokenCount).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('deve transicionar para "error" quando pasteAndResolve for chamado com input vazio', async () => {
    const { result } = renderHook(() => useDashWorkflow(repoPath))

    await act(async () => {
      await result.current.pasteAndResolve()
    })

    expect(result.current.state).toBe('error')
    expect(result.current.error).toBe('Cole uma solicitação Code Dash válida.')
    expect(window.codeAwareness.dashParseAndResolve).not.toHaveBeenCalled()
  })

  it('deve transicionar para "resolved" quando pasteAndResolve obtiver sucesso no IPC', async () => {
    const mockReport = {
      valid: true,
      request: {
        protocol: 'code-dash/v1',
        output: { format: 'xml' },
        items: [{ path: 'src/main.ts', representation: 'source' }]
      },
      failures: []
    }

    vi.mocked(window.codeAwareness.dashParseAndResolve).mockResolvedValue({
      success: true,
      data: mockReport
    } as any)

    const { result } = renderHook(() => useDashWorkflow(repoPath))

    act(() => {
      result.current.setInput('{"protocol":"code-dash/v1"}')
    })

    await act(async () => {
      await result.current.pasteAndResolve()
    })

    expect(result.current.state).toBe('resolved')
    expect(result.current.resolutionReport).toEqual(mockReport)
    expect(result.current.error).toBeNull()
  })

  it('deve transicionar para "error" quando pasteAndResolve falhar no IPC', async () => {
    vi.mocked(window.codeAwareness.dashParseAndResolve).mockResolvedValue({
      success: false,
      error: 'JSON inválido'
    } as any)

    const { result } = renderHook(() => useDashWorkflow(repoPath))

    act(() => {
      result.current.setInput('invalid')
    })

    await act(async () => {
      await result.current.pasteAndResolve()
    })

    expect(result.current.state).toBe('error')
    expect(result.current.error).toBe('JSON inválido')
    expect(result.current.resolutionReport).toBeNull()
  })

  it('deve transicionar para "done" quando generate for chamado no estado "resolved", repassar settings e capturar tokenCount', async () => {
    vi.mocked(window.codeAwareness.dashParseAndResolve).mockResolvedValue({
      success: true,
      data: { valid: true, request: { items: [] }, failures: [] }
    } as any)

    vi.mocked(window.codeAwareness.dashGenerate).mockResolvedValue({
      success: true,
      data: {
        success: true,
        xml: '<code-dash-context />',
        tokenCount: 420
      }
    } as any)

    const { result } = renderHook(() => useDashWorkflow(repoPath))

    act(() => {
      result.current.setInput('{}')
    })

    await act(async () => {
      await result.current.pasteAndResolve()
    })

    expect(result.current.state).toBe('resolved')

    const settings = {
      removeComments: true,
      removeEmptyLines: true,
      truncateBase64: true
    }

    await act(async () => {
      await result.current.generate(settings)
    })

    expect(window.codeAwareness.dashGenerate).toHaveBeenCalledWith('{}', repoPath, settings)
    expect(result.current.state).toBe('done')
    expect(result.current.xml).toBe('<code-dash-context />')
    expect(result.current.tokenCount).toBe(420)
    expect(result.current.error).toBeNull()
  })

  it('deve transicionar para "error" quando generate falhar no IPC', async () => {
    vi.mocked(window.codeAwareness.dashParseAndResolve).mockResolvedValue({
      success: true,
      data: { valid: true, request: { items: [] }, failures: [] }
    } as any)

    vi.mocked(window.codeAwareness.dashGenerate).mockResolvedValue({
      success: false,
      error: 'Falha no Repomix'
    } as any)

    const { result } = renderHook(() => useDashWorkflow(repoPath))

    act(() => {
      result.current.setInput('{}')
    })

    await act(async () => {
      await result.current.pasteAndResolve()
    })

    await act(async () => {
      await result.current.generate()
    })

    expect(result.current.state).toBe('error')
    expect(result.current.error).toBe('Falha no Repomix')
    expect(result.current.xml).toBeNull()
    expect(result.current.tokenCount).toBeNull()
  })

  it('deve ignorar generate se chamado fora do estado "resolved"', async () => {
    const { result } = renderHook(() => useDashWorkflow(repoPath))

    await act(async () => {
      await result.current.generate()
    })

    expect(result.current.state).toBe('idle')
    expect(window.codeAwareness.dashGenerate).not.toHaveBeenCalled()
  })

  it('deve resetar o estado para "idle" e limpar todos os dados ao chamar reset', async () => {
    vi.mocked(window.codeAwareness.dashParseAndResolve).mockResolvedValue({
      success: true,
      data: { valid: true, request: { items: [] }, failures: [] }
    } as any)

    vi.mocked(window.codeAwareness.dashGenerate).mockResolvedValue({
      success: true,
      data: {
        success: true,
        xml: '<code-dash-context />',
        tokenCount: 150
      }
    } as any)

    const { result } = renderHook(() => useDashWorkflow(repoPath))

    act(() => {
      result.current.setInput('{"protocol":"code-dash/v1"}')
    })

    await act(async () => {
      await result.current.pasteAndResolve()
    })

    expect(result.current.state).toBe('resolved')

    await act(async () => {
      await result.current.generate()
    })

    expect(result.current.state).toBe('done')
    expect(result.current.tokenCount).toBe(150)

    act(() => {
      result.current.reset()
    })

    expect(result.current.state).toBe('idle')
    expect(result.current.input).toBe('')
    expect(result.current.resolutionReport).toBeNull()
    expect(result.current.xml).toBeNull()
    expect(result.current.tokenCount).toBeNull()
    expect(result.current.error).toBeNull()
  })
})
