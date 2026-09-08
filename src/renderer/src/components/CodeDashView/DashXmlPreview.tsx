import React, { useMemo, useState } from 'react'
import { Check, Copy, Download, RotateCcw } from 'lucide-react'
import { TokenBadge } from '../shared/TokenBadge/TokenBadge'
import './DashXmlPreview.css'

export interface DashXmlPreviewProps {
  xml: string
  name?: string
  tokenCount?: number
  onReset?: () => void
}

function formatTokens(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`
  }
  return String(count)
}

export const DashXmlPreview: React.FC<DashXmlPreviewProps> = ({ xml, name, tokenCount, onReset }) => {
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
          {typeof tokenCount === 'number' && tokenCount > 0 && (
            <>
              <TokenBadge tokens={tokenCount} formatTokenCount={formatTokens} />
              {' · '}
            </>
          )}
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
            className="app-pill-btn primary"
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
            className="app-ghost-btn"
            onClick={handleExport}
            title="Salvar arquivo XML no disco"
          >
            <Download size={14} />
            <span>Exportar XML</span>
          </button>

          {onReset && (
            <button
              type="button"
              className="app-ghost-btn"
              onClick={onReset}
              title="Iniciar nova solicitação"
            >
              <RotateCcw size={14} />
              <span>Nova Solicitação</span>
            </button>
          )}
        </div>
      </div>

      <pre className="dash-code-block">
        <code>{xml}</code>
      </pre>
    </div>
  )
}
