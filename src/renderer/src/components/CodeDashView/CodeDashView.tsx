import React, { useState } from 'react'
import { Check, Copy, Loader2, Play, RotateCcw, Zap } from 'lucide-react'
import { useDashWorkflow } from './hooks/useDashWorkflow'
import './CodeDashView.css'

export interface CodeDashViewProps {
  activeProject?: { path: string; name: string } | null
  repoPath?: string
  projectName?: string
  onSelectProject?: (project: { path: string; name: string } | null) => void
  onStatusMessage?: (text: string, isError?: boolean) => void
}
export const CodeDashView: React.FC<CodeDashViewProps> = (props) => {
  const repoPath = props.repoPath ?? props.activeProject?.path ?? ''
  const workflow = useDashWorkflow(repoPath)
  const { input, setInput, result, busy, execute, reset } = workflow
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')
  const clearCopy = () => {
    setCopied(false)
    setCopyError('')
  }
  const copy = async () => {
    if (!result?.success) return
    try {
      await navigator.clipboard.writeText(result.context)
      setCopied(true)
      setCopyError('')
    } catch {
      setCopyError('Não foi possível copiar o contexto. Tente novamente.')
    }
  }
  return (
    <div className="dash-view-container">
      <header className="dash-view-header">
        <div className="dash-view-title-group">
          <Zap size={22} />
          <h2>Code Dash</h2>
          <span className="dash-version">V2</span>
        </div>
        <p>Uma solicitação. Somente o contexto que você pediu.</p>
      </header>
      {!repoPath ? (
        <div className="dash-empty">Selecione um projeto para usar o Code Dash.</div>
      ) : (
        <>
          {result && (
            <section
              className={`dash-report ${result.success ? '' : 'dash-report-error'}`}
              aria-label="Relatório de resolução"
              role={result.success ? 'status' : 'alert'}
            >
              <strong>
                {result.success ? 'Solicitação resolvida' : 'Solicitação não resolvida'}
              </strong>
              <div className="dash-step-counts">
                {result.report.steps.map((step) => (
                  <span key={step.id}>
                    {step.id}: {step.count}
                  </span>
                ))}
              </div>
              {result.report.error && (
                <p>
                  {result.report.error.code}: {result.report.error.message}
                </p>
              )}
              {!result.success && result.report.tokenCount !== undefined && (
                <span>{result.report.tokenCount.toLocaleString()} tokens solicitados</span>
              )}
            </section>
          )}
          <div className="dash-workspace">
            <section className="dash-pane dash-request-pane" aria-label="Solicitação">
              <div className="dash-pane-heading">
                <h3>Solicitação</h3>
                <span>{props.projectName ?? props.activeProject?.name ?? 'Projeto ativo'}</span>
              </div>
              <p className="dash-hint">
                Cole o JSON gerado pela IA e resolva o pedido em uma execução.
              </p>
              <textarea
                aria-label="Solicitação Code Dash"
                className="dash-textarea"
                spellCheck={false}
                placeholder="Cole aqui sua solicitação code-dash/v2…"
                value={input}
                disabled={busy}
                onChange={(e) => {
                  clearCopy()
                  setInput(e.target.value)
                }}
              />
              <div className="dash-actions-bar">
                <button
                  className="app-pill-btn primary"
                  disabled={busy || !input.trim()}
                  onClick={() => {
                    clearCopy()
                    void execute()
                  }}
                >
                  {busy ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
                  {busy ? 'Resolvendo…' : 'Gerar contexto'}
                </button>
                <button
                  className="app-ghost-btn"
                  disabled={busy}
                  onClick={() => {
                    clearCopy()
                    reset()
                  }}
                >
                  <RotateCcw size={15} />
                  Limpar
                </button>
              </div>
            </section>
            <section className="dash-pane dash-context-pane" aria-label="Contexto">
              <div className="dash-pane-heading">
                <h3>Contexto</h3>
                {result?.success && <span>{result.tokenCount.toLocaleString()} tokens</span>}
              </div>
              {result?.success ? (
                <>
                  <pre className="dash-context-preview" aria-label="Context Packet">
                    {result.context}
                  </pre>
                  <div className="dash-actions-bar">
                    <button className="app-pill-btn primary" onClick={() => void copy()}>
                      {copied ? <Check size={15} /> : <Copy size={15} />}
                      {copied ? 'Contexto copiado' : 'Copiar contexto'}
                    </button>
                  </div>
                </>
              ) : (
                <div className="dash-empty">
                  {busy
                    ? 'Resolvendo o pedido sobre o Code Map…'
                    : 'O contexto solicitado aparecerá aqui.'}
                </div>
              )}
              {copyError && <p role="alert">{copyError}</p>}
            </section>
          </div>

        </>
      )}
    </div>
  )
}
