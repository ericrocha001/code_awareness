// @vitest-environment jsdom
/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Provar E2E a máquina de estados e integração da UI do Code Dash (UI-01 a UI-10).
2. Renderizar CodeDashView real com window.codeAwareness mockado e validar transições, One-Click XML, Copy, Export e erros.

Mapa de Relacionamentos do Script

1. CodeDashView.tsx
   - Tipo: Dependência Direta
   - Relação: Componente raiz renderizado em todos os cenários.
   - Criticidade: Alta

2. hooks/useDashWorkflow.ts
   - Tipo: Dependência Direta
   - Relação: Máquina de estados real (idle/parsing/resolved/generating/done/error).
   - Criticidade: Alta

3. DashXmlPreview.tsx
   - Tipo: Dependência Direta
   - Relação: Preview e ações Copy/Export validadas nos cenários UI-02, UI-09 e UI-10.
   - Criticidade: Alta

Invariantes do Script

1. window.codeAwareness é reconstruído com vi.fn() no beforeEach de cada teste.
2. Nenhuma chamada IPC automática ocorre em idle — apenas ações do usuário disparam IPC.
3. Erros de Copy/Export nunca derrubam o XML já exibido.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeDashView } from './CodeDashView'

const REQUEST = JSON.stringify({
  protocol: 'code-dash/v1',
  output: { format: 'xml' },
  items: [
    { path: 'a.ts', representation: 'source' },
    { path: 'b.ts', representation: 'compression' }
  ]
})

const REPORT_8_OF_10 = {
  valid: true,
  request: {
    protocol: 'code-dash/v1',
    output: { format: 'xml' },
    items: Array.from({ length: 8 }, (_, i) => ({
      path: `f${i}.ts`,
      representation: 'source'
    }))
  },
  failures: [
    { index: 8, path: 'g1.ts', reason: 'not_found' },
    { index: 9, path: 'g2.ts', reason: 'not_found' }
  ]
}

const XML_OK = '<?xml version="1.0"?><code-dash-context version="code-dash/v1"></code-dash-context>'

describe('Suite UI — Estado e Integração', () => {
  let codeAwareness: Record<string, ReturnType<typeof vi.fn>>

  const typeRequest = (text: string) => {
    fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
  }

  const resolveSuccessfully = async (report = {
    valid: true,
    request: {
      protocol: 'code-dash/v1',
      output: { format: 'xml' },
      items: [{ path: 'a.ts', representation: 'source' }]
    },
    failures: []
  }) => {
    codeAwareness.dashParseAndResolve.mockResolvedValue({ success: true, data: report })
    render(<CodeDashView repoPath={'C:\\repo'} projectName="proj" />)
    typeRequest(REQUEST)
    fireEvent.click(screen.getByText('Analisar Solicitação'))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Gerar Contexto/ })).toBeTruthy()
    )
  }

  const reachDone = async () => {
    await resolveSuccessfully()
    codeAwareness.dashGenerate.mockResolvedValue({
      success: true,
      data: { success: true, xml: XML_OK }
    })
    fireEvent.click(screen.getByText('Gerar Contexto'))
    await waitFor(() => expect(screen.getByText('Exportar XML')).toBeTruthy())
  }

  afterEach(cleanup)

  beforeEach(() => {
    codeAwareness = {
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

  // UI-01
  it('UI-01: transição idle → parsing → resolved com loading e summary', async () => {
    let resolveIpc: (v: unknown) => void = () => {}
    codeAwareness.dashParseAndResolve.mockReturnValue(
      new Promise((res) => {
        resolveIpc = res
      })
    )
    render(<CodeDashView repoPath={'C:\\repo'} projectName="proj" />)
    typeRequest(REQUEST)
    fireEvent.click(screen.getByText('Analisar Solicitação'))

    // Estado parsing: botão de loading visível, "Analisar Solicitação" sumiu.
    expect(screen.getByText('Analisando solicitação...')).toBeTruthy()
    expect(screen.queryByText('Analisar Solicitação')).toBeNull()

    resolveIpc({ success: true, data: {
      valid: true,
      request: {
        protocol: 'code-dash/v1',
        output: { format: 'xml' },
        items: [{ path: 'a.ts', representation: 'source' }]
      },
      failures: []
    } })
    await waitFor(() => expect(screen.getByText('Gerar Contexto')).toBeTruthy())
  })

  // UI-02
  it('UI-02: transição resolved → generating → done com preview XML', async () => {
    await resolveSuccessfully()
    codeAwareness.dashGenerate.mockReturnValue(
      new Promise((res) => setTimeout(() => res({ success: true, data: { success: true, xml: XML_OK } }), 30))
    )
    fireEvent.click(screen.getByText('Gerar Contexto'))

    // Estado generating: loading visível.
    expect(screen.getByText('Gerando contexto...')).toBeTruthy()

    await waitFor(() => expect(screen.getByText('Exportar XML')).toBeTruthy())
    // Preview com o XML.
    expect(screen.getByText(/code-dash-context/)).toBeTruthy()
    expect(screen.getByText('Copiar XML')).toBeTruthy()
  })

  // UI-03
  it('UI-03: erro no parse exibe mensagem e botão Tentar Novamente', async () => {
    codeAwareness.dashParseAndResolve.mockResolvedValue({
      success: false,
      error: 'JSON inválido'
    })
    render(<CodeDashView repoPath={'C:\\repo'} projectName="proj" />)
    typeRequest('not json')
    fireEvent.click(screen.getByText('Analisar Solicitação'))

    await waitFor(() => expect(screen.getByText('Erro na Solicitação')).toBeTruthy())
    expect(screen.getByText('JSON inválido')).toBeTruthy()
    expect(screen.getByText('Tentar Novamente')).toBeTruthy()
  })

  // UI-04
  it('UI-04: generate direto no estado idle é ignorado e não chama IPC', async () => {
    render(<CodeDashView repoPath={'C:\\repo'} projectName="proj" />)
    // Estado idle: nenhum botão de geração do workflow existe.
    expect(screen.queryByText('Gerar Contexto')).toBeNull()
    expect(codeAwareness.dashGenerate).not.toHaveBeenCalled()
  })

  // UI-05
  it('UI-05: reset limpa tudo e volta ao idle', async () => {
    await reachDone()
    expect(screen.getByText('Exportar XML')).toBeTruthy()

    fireEvent.click(screen.getByText('Nova Solicitação'))
    await waitFor(() => expect(screen.getByText('Analisar Solicitação')).toBeTruthy())
    // Sem preview, sem summary, textarea vazio.
    expect(screen.queryByText('Exportar XML')).toBeNull()
    expect(screen.queryByText('Copiar XML')).toBeNull()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
  })

  // UI-06
  it('UI-06: botão Generate reflete parcialidade (8/10 itens)', async () => {
    await resolveSuccessfully(REPORT_8_OF_10)
    expect(screen.getByText('Gerar Contexto Resolvido (8/10 itens)')).toBeTruthy()
  })

  // UI-07
  it('UI-07: Quick Action One-Click XML gera preview com Copy/Export', async () => {
    codeAwareness.dashOneClickXml.mockResolvedValue({
      success: true,
      xml: XML_OK,
      metadata: { fileCount: 3 }
    })
    render(<CodeDashView repoPath={'C:\\repo'} projectName="proj" />)

    fireEvent.click(screen.getByText('Gerar XML do Repositório'))
    await waitFor(() => expect(screen.getAllByText('Exportar XML').length).toBeGreaterThan(0))
    expect(codeAwareness.dashOneClickXml).toHaveBeenCalledTimes(1)
    expect(screen.getAllByText('Copiar XML').length).toBeGreaterThan(0)
  })

  // UI-08
  it('UI-08: toggles do One-Click XML são transmitidos corretamente ao IPC', async () => {
    codeAwareness.dashOneClickXml.mockResolvedValue({ success: true, xml: XML_OK })
    render(<CodeDashView repoPath={'C:\\repo'} projectName="proj" />)

    const labels = screen.getAllByRole('checkbox')
    // [removeComments, removeEmptyLines, truncateBase64]
    fireEvent.click(labels[0])
    fireEvent.click(labels[2])
    fireEvent.click(screen.getByText('Gerar XML do Repositório'))

    await waitFor(() => expect(codeAwareness.dashOneClickXml).toHaveBeenCalled())
    expect(codeAwareness.dashOneClickXml).toHaveBeenCalledWith('C:\\repo', {
      removeComments: true,
      removeEmptyLines: false,
      truncateBase64: true
    })
  })

  // UI-09
  it('UI-09: Copy exibe feedback temporário "Copiado"', async () => {
    await reachDone()
    fireEvent.click(screen.getByText('Copiar XML'))
    await waitFor(() =>
      expect(screen.getByText('Copiado para a área de transferência!')).toBeTruthy()
    )
    // Feedback é temporário: desaparece após ~3s (tolerância de 1s).
    await waitFor(
      () => expect(screen.queryByText('Copiado para a área de transferência!')).toBeNull(),
      { timeout: 5000 }
    )
  }, 10000)

  // UI-10
  it('UI-10: erro no Export exibe mensagem e preserva o preview', async () => {
    await reachDone()
    codeAwareness.saveXml.mockResolvedValue({
      success: false,
      error: 'Permissão negada no disco'
    })

    fireEvent.click(screen.getByText('Exportar XML'))
    await waitFor(() => expect(screen.getByText('Permissão negada no disco')).toBeTruthy())

    // O XML permanece disponível — estado não foi perdido.
    expect(screen.getByText('Exportar XML')).toBeTruthy()
    expect(screen.getByText(/code-dash-context/)).toBeTruthy()
  })
})

