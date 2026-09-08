// @vitest-environment jsdom
/*
-T ---
*/
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeDashView } from './CodeDashView'
const REQUEST = JSON.stringify({
  protocol: 'code-dash/v1',
  output: { format: 'xml' },
  items: [{ path: 'a.ts', representation: 'source' }]
})
const REPORT = {
  valid: true,
  request: {
    protocol: 'code-dash/v1',
    output: { format: 'xml' },
    items: [{ path: 'a.ts', representation: 'source' }]
  },
  failures: []
}

const XML_Q = '<code-dash-context>quick-result</code-dash-context>'
const XML_S = '<code-dash-context>selective-result</code-dash-context>'
describe('CodeDashView - contrato de modos (MC-1..MC-6)', () => {
  let codeAwareness: Record<string, ReturnType<typeof vi.fn>>

  const renderView = () =>
    render(<CodeDashView repoPath="C:\\repo" projectName="proj" />)

  const resolveSelective = async () => {
    codeAwareness.dashParseAndResolve.mockResolvedValue({ success: true, data: REPORT })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: REQUEST } })
    fireEvent.click(screen.getByRole('button', { name: /Analisar/ }))
    await waitFor(() => screen.getByRole('button', { name: /Gerar Contexto/ }))
  }

  const generateSelective = async (xml: string) => {
    codeAwareness.dashGenerate.mockResolvedValue({
      success: true,
      data: { success: true, xml }
    })
    fireEvent.click(screen.getByRole('button', { name: /Gerar Contexto/ }))
    await waitFor(() => screen.getByText('Exportar XML'))
  }

  const runQuickDone = async (xml: string) => {
    codeAwareness.dashOneClickXml.mockResolvedValue({ success: true, xml })
    fireEvent.click(screen.getAllByRole('tab')[1])
    fireEvent.click(screen.getByRole('button', { name: /Gerar XML/ }))
    await waitFor(() => screen.getByText('Exportar XML'))
  }

  beforeEach(() => {
    codeAwareness = {
      loadSettings: vi.fn().mockResolvedValue({}),
      saveSettings: vi.fn().mockResolvedValue({ success: true }),
      dashParseAndResolve: vi.fn(),
      dashGenerate: vi.fn(),
      dashOneClickXml: vi.fn(),
      saveXml: vi.fn().mockResolvedValue({ success: true })
    }
    ;(window as any).codeAwareness = codeAwareness
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })
it('MC-1: completar (Rapido), ir ao Seletivo e voltar mantem o preview One-Click', async () => {
    renderView()
    await runQuickDone(XML_Q)
    expect(screen.getByText(/quick-result/)).toBeTruthy()

    fireEvent.click(screen.getAllByRole('tab')[0])
    expect(screen.queryByText(/quick-result/)).toBeNull()

    fireEvent.click(screen.getAllByRole('tab')[1])
    expect(screen.getByText(/quick-result/)).toBeTruthy()
    expect(screen.getAllByText('Exportar XML').length).toBeGreaterThan(0)
  })

  it('MC-2: resolver e gerar (Seletivo), ir ao Rapido e voltar mantem summary e preview seletivo', async () => {
    renderView()
    await resolveSelective()
    await generateSelective(XML_S)
    expect(screen.getByText(/Resumo/)).toBeTruthy()
    expect(screen.getByText(/selective-result/)).toBeTruthy()

    fireEvent.click(screen.getAllByRole('tab')[1])
    expect(screen.queryByText(/Resumo/)).toBeNull()

    fireEvent.click(screen.getAllByRole('tab')[0])
    expect(screen.getByText(/Resumo/)).toBeTruthy()
    expect(screen.getByText(/selective-result/)).toBeTruthy()
  })

  it('MC-3: Limpar (Seletivo) e Nova Geracao (Rapido) sao isolados', async () => {
    // sub-caso A: Limpar nao afeta o resultado do Rapido
    renderView()
    await resolveSelective()
    codeAwareness.dashOneClickXml.mockResolvedValue({ success: true, xml: XML_Q })
    fireEvent.click(screen.getAllByRole('tab')[1])
    fireEvent.click(screen.getByRole('button', { name: /Gerar XML/ }))
    await waitFor(() => screen.getByText(/quick-result/))

    fireEvent.click(screen.getAllByRole('tab')[0])
    await waitFor(() => screen.getByRole('button', { name: /Limpar/ }))
    fireEvent.click(screen.getByRole('button', { name: /Limpar/ }))
    await waitFor(() => screen.getByRole('button', { name: /Analisar/ }))

    fireEvent.click(screen.getAllByRole('tab')[1])
    expect(screen.getByText(/quick-result/)).toBeTruthy()
    cleanup()

    // sub-caso B: Nova Geracao nao afeta o resultado do Seletivo
    renderView()
    await resolveSelective()
    await generateSelective(XML_S)
    codeAwareness.dashOneClickXml.mockResolvedValue({ success: true, xml: XML_Q })
    fireEvent.click(screen.getAllByRole('tab')[1])
    fireEvent.click(screen.getByRole('button', { name: /Gerar XML/ }))
    await waitFor(() => screen.getByText(/quick-result/))
    fireEvent.click(screen.getByRole('button', { name: /Nova Ger/ }))
    await waitFor(() => screen.getByRole('button', { name: /Gerar XML/ }))

    fireEvent.click(screen.getAllByRole('tab')[0])
    expect(screen.getByText(/selective-result/)).toBeTruthy()
  })
it('MC-4: alternar modos nunca salva settings; remontagem volta a Seletivo', async () => {
    renderView()
    fireEvent.click(screen.getAllByRole('tab')[1])
    fireEvent.click(screen.getAllByRole('tab')[0])
    fireEvent.click(screen.getAllByRole('tab')[1])
    expect(codeAwareness.saveSettings).not.toHaveBeenCalled()

    cleanup()
    renderView()
    const tabs = screen.getAllByRole('tab')
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    expect(tabs[1].getAttribute('aria-selected')).toBe('false')
  })

  it('MC-5: durante geracao ativa (qualquer modo) os tres switches ficam disabled', async () => {
    renderView()
    codeAwareness.dashParseAndResolve.mockResolvedValue({ success: true, data: REPORT })
    codeAwareness.dashGenerate.mockImplementation(() => new Promise(() => {}))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: REQUEST } })
    fireEvent.click(screen.getByRole('button', { name: /Analisar/ }))
    await waitFor(() => screen.getByRole('button', { name: /Gerar Contexto/ }))
    fireEvent.click(screen.getByRole('button', { name: /Gerar Contexto/ }))
    await waitFor(() => {
      const switches = screen.getAllByRole('switch')
      expect(switches.every((s) => s.getAttribute('aria-disabled') === 'true')).toBe(true)
    })

    cleanup()
    renderView()
    codeAwareness.dashOneClickXml.mockImplementation(() => new Promise(() => {}))
    fireEvent.click(screen.getAllByRole('tab')[1])
    fireEvent.click(screen.getByRole('button', { name: /Gerar XML/ }))
    await waitFor(() => {
      const switches = screen.getAllByRole('switch')
      expect(switches.every((s) => s.getAttribute('aria-disabled') === 'true')).toBe(true)
    })
  })

  it('MC-6: clicar no texto de um toggle alterna o switch e persiste com debounce', async () => {
    vi.useFakeTimers()
    renderView()
    await act(async () => {
      await Promise.resolve()
    })

    fireEvent.click(screen.getByText(/coment/))
    expect(screen.getAllByRole('switch')[0].getAttribute('aria-checked')).toBe('true')
    expect(codeAwareness.saveSettings).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(codeAwareness.saveSettings).toHaveBeenCalledTimes(1)
    expect(codeAwareness.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        dashSettings: expect.objectContaining({ removeComments: true })
      })
    )
  })

  it('MC-7a: seletivo idle exibe exatamente uma primária ("Analisar Solicitação")', () => {
    const { container } = renderView()
    expect(container.querySelectorAll('.app-pill-btn.primary').length).toBe(1)
  })

  it('MC-7b: seletivo resolved exibe exatamente uma primária ("Gerar Contexto")', async () => {
    codeAwareness.dashParseAndResolve.mockResolvedValue({ success: true, data: REPORT })
    const { container } = renderView()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: REQUEST } })
    fireEvent.click(screen.getByRole('button', { name: /Analisar/ }))
    await waitFor(() => screen.getByRole('button', { name: /Gerar Contexto/ }))
    expect(container.querySelectorAll('.app-pill-btn.primary').length).toBe(1)
  })

  it('MC-7c: seletivo done exibe exatamente uma primária ("Copiar XML")', async () => {
    codeAwareness.dashParseAndResolve.mockResolvedValue({ success: true, data: REPORT })
    codeAwareness.dashGenerate.mockResolvedValue({
      success: true,
      data: { success: true, xml: XML_S }
    })
    const { container } = renderView()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: REQUEST } })
    fireEvent.click(screen.getByRole('button', { name: /Analisar/ }))
    await waitFor(() => screen.getByRole('button', { name: /Gerar Contexto/ }))
    fireEvent.click(screen.getByRole('button', { name: /Gerar Contexto/ }))
    await waitFor(() => screen.getByText('Exportar XML'))
    expect(container.querySelectorAll('.app-pill-btn.primary').length).toBe(1)
  })

  it('MC-7d: rápido idle exibe exatamente uma primária ("Gerar XML do Repositório")', async () => {
    codeAwareness.dashOneClickXml.mockResolvedValue({ success: true, xml: XML_Q })
    const { container } = renderView()
    fireEvent.click(screen.getAllByRole('tab')[1])
    await waitFor(() => screen.getByRole('button', { name: /Gerar XML/ }))
    expect(container.querySelectorAll('.app-pill-btn.primary').length).toBe(1)
  })

  it('MC-7e: rápido done exibe exatamente uma primária ("Copiar XML")', async () => {
    codeAwareness.dashOneClickXml.mockResolvedValue({ success: true, xml: XML_Q })
    const { container } = renderView()
    fireEvent.click(screen.getAllByRole('tab')[1])
    await waitFor(() => screen.getByRole('button', { name: /Gerar XML/ }))
    fireEvent.click(screen.getByRole('button', { name: /Gerar XML/ }))
    await waitFor(() => screen.getByText('Exportar XML'))
    expect(container.querySelectorAll('.app-pill-btn.primary').length).toBe(1)
  })
})