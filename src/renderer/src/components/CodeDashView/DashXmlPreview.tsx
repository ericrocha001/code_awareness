/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Exibir o XML canônico gerado pelo Code Dash com contagem de linhas/caracteres.
2. Fornecer ações diretas de cópia para a área de transferência e exportação via diálogo nativo saveXml.
3. Gerenciar o feedback visual temporário das ações de cópia e exportação.

Mapa de Relacionamentos do Script

1. DashXmlPreview.css
   - Tipo: Relação de UI
   - Relação: Fornece estilos para o visualizador de código e barra de ferramentas.
   - Criticidade: Alta

2. CodeDashView.tsx
   - Tipo: Dependência Inversa
   - Relação: Componente filho embutido na visualização principal quando no estado 'done'.
   - Criticidade: Alta

Invariantes do Script

1. As ações de cópia e exportação apenas consomem o XML pronto sem disparar nova geração.
2. Feedbacks temporários de interação devem ser limpos automaticamente após o timeout.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useMemo, useState } from 'react'
import { Check, Copy, Download } from 'lucide-react'
import './DashXmlPreview.css'

export interface DashXmlPreviewProps {
  xml: string
  name?: string
}

export const DashXmlPreview: React.FC<DashXmlPreviewProps> = ({ xml, name }) => {
  const [feedback, setFeedback] = useState<{
    text: string
    isError?: boolean
  } | null>(null)

  const lineCount = useMemo(() => xml.split('\n').length, [xml])
  const charCount = useMemo(() => xml.length, [xml])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(xml)
      setFeedback({ text: 'Copiado para a área de transferência!' })
      setTimeout(() => setFeedback(null), 3000)
    } catch {
      setFeedback({ text: 'Falha ao copiar para o clipboard.', isError: true })
      setTimeout(() => setFeedback(null), 3000)
    }
  }

  const handleExport = async () => {
    try {
      const fileName = name?.trim() || 'code-dash-context'
      const response = await window.codeAwareness.saveXml(xml, fileName)
      if (response.success) {
        setFeedback({ text: 'Arquivo XML exportado com sucesso!' })
      } else {
        setFeedback({
          text: response.error || 'Falha ao exportar arquivo XML.',
          isError: true
        })
      }
      setTimeout(() => setFeedback(null), 3000)
    } catch (err) {
      setFeedback({
        text: err instanceof Error ? err.message : 'Falha ao exportar arquivo XML.',
        isError: true
      })
      setTimeout(() => setFeedback(null), 3000)
    }
  }

  return (
    <div className="dash-preview-container">
      <div className="dash-preview-toolbar">
        <span className="dash-preview-meta">
          {lineCount} {lineCount === 1 ? 'linha' : 'linhas'} · {charCount.toLocaleString('pt-BR')} caracteres
        </span>

        <div className="dash-preview-actions">
          {feedback && (
            <span
              className={`dash-action-feedback ${feedback.isError ? 'error' : ''}`}
            >
              {feedback.text}
            </span>
          )}

          <button
            type="button"
            className="dash-action-btn primary"
            onClick={handleCopy}
            title="Copiar XML para a área de transferência"
          >
            {feedback?.text.includes('Copiado') ? (
              <Check size={14} />
            ) : (
              <Copy size={14} />
            )}
            <span>Copiar XML</span>
          </button>

          <button
            type="button"
            className="dash-action-btn"
            onClick={handleExport}
            title="Salvar arquivo XML no disco"
          >
            <Download size={14} />
            <span>Exportar XML</span>
          </button>
        </div>
      </div>

      <pre className="dash-code-block">
        <code>{xml}</code>
      </pre>
    </div>
  )
}
