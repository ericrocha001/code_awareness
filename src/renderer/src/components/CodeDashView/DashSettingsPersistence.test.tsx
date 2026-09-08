// @vitest-environment jsdom
/*
-T ---
*/

import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeDashView } from './CodeDashView'
import { DashXmlPreview } from './DashXmlPreview'

describe('CodeDashView — Provas de Aceitação Sprint 2', () => {
  let codeAwareness: Record<string, ReturnType<typeof vi.fn>>

  beforeEach(() => {
    vi.useFakeTimers()
    codeAwareness = {
      loadSettings: vi.fn().mockResolvedValue({
        dashSettings: {
          removeComments: false,
          removeEmptyLines: false,
          truncateBase64: false
        }
      }),
      saveSettings: vi.fn().mockResolvedValue({ success: true }),
      dashParseAndResolve: vi.fn(),
      dashGenerate: vi.fn(),
      dashOneClickXml: vi.fn(),
      saveXml: vi.fn().mockResolvedValue({ success: true })
    }
    ;(window as any).codeAwareness = codeAwareness
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  // Prova de Aceitação 1 — Persistência e carregamento inicial
  it('PA-1: carrega configurações persistidas no mount e salva com debounce de 300ms ao alterar toggles', async () => {
    codeAwareness.loadSettings.mockResolvedValue({
      dashSettings: {
        removeComments: true,
        removeEmptyLines: false,
        truncateBase64: true
      }
    })

    render(<CodeDashView repoPath="/test/repo" projectName="test-proj" />)

    // Aguarda o effect de mount resolver
    await act(async () => {
      await Promise.resolve()
    })

    const switches = screen.getAllByRole('switch')
    expect(switches[0].getAttribute('aria-checked')).toBe('true') // removeComments
    expect(switches[1].getAttribute('aria-checked')).toBe('false') // removeEmptyLines
    expect(switches[2].getAttribute('aria-checked')).toBe('true') // truncateBase64

    // Altera o toggle removeEmptyLines
    fireEvent.click(switches[1])

    // Antes dos 300ms, saveSettings ainda não deve ter sido chamado
    expect(codeAwareness.saveSettings).not.toHaveBeenCalled()

    // Avança 300ms no timer
    await act(async () => {
      vi.advanceTimersByTime(300)
    })

    expect(codeAwareness.saveSettings).toHaveBeenCalledTimes(1)
    expect(codeAwareness.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        dashSettings: {
          removeComments: true,
          removeEmptyLines: true,
          truncateBase64: true
        }
      })
    )
  })

  // Prova de Aceitação 2 — Efeito no One-Click XML
  it('PA-2: One-Click XML recebe as configurações globais ativas via persistedSettings', async () => {
    codeAwareness.loadSettings.mockResolvedValue({
      dashSettings: {
        removeComments: true,
        removeEmptyLines: true,
        truncateBase64: false
      }
    })
    codeAwareness.dashOneClickXml.mockResolvedValue({
      success: true,
      xml: '<repomix>clean content</repomix>',
      tokenCount: 150
    })

    render(<CodeDashView repoPath="/test/repo" projectName="test-proj" />)

    await act(async () => {
      await Promise.resolve()
    })

    fireEvent.click(screen.getByText('XML Rápido'))
    fireEvent.click(screen.getByText('Gerar XML do Repositório'))

    await act(async () => {
      await Promise.resolve()
    })

    expect(codeAwareness.dashOneClickXml).toHaveBeenCalledWith('/test/repo', {
      persistedSettings: {
        removeComments: true,
        removeEmptyLines: true,
        truncateBase64: false
      }
    })
  })

  // Prova de Aceitação 3 — Efeito na geração seletiva
  it('PA-3: geração seletiva passa as configurações ativas para dashGenerate', async () => {
    codeAwareness.loadSettings.mockResolvedValue({
      dashSettings: {
        removeComments: true,
        removeEmptyLines: false,
        truncateBase64: true
      }
    })

    codeAwareness.dashParseAndResolve.mockResolvedValue({
      success: true,
      data: {
        valid: true,
        request: {
          protocol: 'code-dash/v1',
          output: { format: 'xml' },
          items: [{ path: 'a.ts', representation: 'source' }]
        },
        failures: []
      }
    })

    codeAwareness.dashGenerate.mockResolvedValue({
      success: true,
      data: {
        success: true,
        xml: '<code-dash-context />',
        tokenCount: 250
      }
    })

    render(<CodeDashView repoPath="/test/repo" projectName="test-proj" />)

    await act(async () => {
      await Promise.resolve()
    })

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '{"protocol":"code-dash/v1"}' }
    })

    fireEvent.click(screen.getByText('Analisar Solicitação'))

    await act(async () => {
      await Promise.resolve()
    })

    fireEvent.click(screen.getByText('Gerar Contexto'))

    await act(async () => {
      await Promise.resolve()
    })

    expect(codeAwareness.dashGenerate).toHaveBeenCalledWith(
      '{"protocol":"code-dash/v1"}',
      '/test/repo',
      {
        removeComments: true,
        removeEmptyLines: false,
        truncateBase64: true
      }
    )
  })

  // Prova de Aceitação 4 — Exibição de tokenCount no preview (TokenBadge)
  it('PA-4: DashXmlPreview exibe contador de tokens formatado quando tokenCount > 0', () => {
    const xml = '<code-dash-context>line1\nline2</code-dash-context>'

    // Com tokenCount abaixo de 1000
    const { rerender } = render(<DashXmlPreview xml={xml} tokenCount={450} />)
    expect(screen.getByText('450')).toBeTruthy()
    expect(screen.getByText('tokens')).toBeTruthy()

    // Com tokenCount >= 1000 (formatação com 'k')
    rerender(<DashXmlPreview xml={xml} tokenCount={2500} />)
    expect(screen.getByText('2.5k')).toBeTruthy()

    // Sem tokenCount
    rerender(<DashXmlPreview xml={xml} />)
    expect(screen.queryByText('tokens')).toBeNull()
  })
})
