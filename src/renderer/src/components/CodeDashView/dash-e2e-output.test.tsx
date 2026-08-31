// @vitest-environment jsdom
/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Provar E2E os contratos de saída do Code Dash (E2E-17 a E2E-19): Copy, Export e ausência de regeneração.
2. Exercitar CodeDashView real com window.codeAwareness mockado e contadores de invocação IPC.

Mapa de Relacionamentos do Script

1. CodeDashView.tsx
   - Tipo: Dependência Direta
   - Relação: Componente renderizado no fluxo completo até o estado done.
   - Criticidade: Alta

2. hooks/useDashWorkflow.ts
   - Tipo: Dependência Direta
   - Relação: Máquina de estados real da UI consumida pela view.
   - Criticidade: Alta

3. dash-e2e-helpers.ts
   - Tipo: Dependência Direta
   - Relação: Consome builder de requisição e utilidades de XML.
   - Criticidade: Média

Invariantes do Script

1. Copy e Export consomem apenas o XML já presente no estado — dashGenerate nunca é chamado por elas.
2. window.codeAwareness é mockado por teste e reinicializado no beforeEach.
3. O clipboard é espiado via Object.defineProperty sem dependência de implementação nativa.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeDashView } from './CodeDashView'
import { buildDashInput } from '../../../../main/core/dash/dash-e2e-helpers'

const REQUEST = buildDashInput([
  { path: 'a.ts', representation: 'source' },
  { path: 'b.ts', representation: 'compression' }
])
const GENERATED_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n<code-dash-context version="code-dash/v1" generated-at="T">\n  <items>\n  </items>\n</code-dash-context>'

describe('Suite C — Output e Integração', () => {
  let dashGenerate: ReturnType<typeof vi.fn>
  let dashParseAndResolve: ReturnType<typeof vi.fn>
  let saveXml: ReturnType<typeof vi.fn>
  let writeText: ReturnType<typeof vi.fn>

  const renderToDone = async () => {
    render(<CodeDashView repoPath="C:\\repo" projectName="proj" />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: REQUEST } })
    fireEvent.click(screen.getByText('Analisar Solicitação'))
    await waitFor(() => expect(screen.getByText('Gerar Contexto')).toBeTruthy())
    fireEvent.click(screen.getByText('Gerar Contexto'))
    await waitFor(() => expect(screen.getByText('Exportar XML')).toBeTruthy())
  }

  afterEach(cleanup)

  beforeEach(() => {
    dashParseAndResolve = vi.fn().mockResolvedValue({
      success: true,
      data: {
        valid: true,
        request: {
          protocol: 'code-dash/v1',
          output: { format: 'xml' },
          items: [
            { path: 'a.ts', representation: 'source' },
            { path: 'b.ts', representation: 'compression' }
          ]
        },
        failures: []
      }
    })
    dashGenerate = vi.fn().mockResolvedValue({
      success: true,
      data: { success: true, xml: GENERATED_XML }
    })
    saveXml = vi.fn().mockResolvedValue({ success: true })
    writeText = vi.fn().mockResolvedValue(undefined)

    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    })
    ;(window as any).codeAwareness = {
      dashParseAndResolve,
      dashGenerate,
      saveXml,
      dashOneClickXml: vi.fn()
    }
  })

  // E2E-17
  it('E2E-17: Copy coloca exatamente o XML gerado no clipboard sem regenerar', async () => {
    await renderToDone()
    expect(dashGenerate).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('Copiar XML'))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))

    expect(writeText).toHaveBeenCalledWith(GENERATED_XML)
    // Nenhum IPC de geração durante o Copy.
    expect(dashGenerate).toHaveBeenCalledTimes(1)
  })

  // E2E-18
  it('E2E-18: Export usa saveXml com o XML e o nome corretos sem regenerar', async () => {
    await renderToDone()
    expect(dashGenerate).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('Exportar XML'))
    await waitFor(() => expect(saveXml).toHaveBeenCalledTimes(1))

    expect(saveXml).toHaveBeenCalledWith(GENERATED_XML, 'proj')
    expect(dashGenerate).toHaveBeenCalledTimes(1)
  })

  // E2E-19
  it('E2E-19: Copy seguido de Export não dispara nenhuma nova geração', async () => {
    await renderToDone()
    expect(dashGenerate).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('Copiar XML'))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByText('Exportar XML'))
    await waitFor(() => expect(saveXml).toHaveBeenCalledTimes(1))

    // Ainda 1 única geração para todo o fluxo.
    expect(dashGenerate).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(GENERATED_XML)
    expect(saveXml).toHaveBeenCalledWith(GENERATED_XML, 'proj')
  })
})
