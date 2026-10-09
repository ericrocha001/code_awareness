import React, { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  FileJson2,
  Loader2,
  Play,
  RotateCcw,
  Sparkles,
  Zap
} from 'lucide-react'
import { useDashWorkflow } from './hooks/useDashWorkflow'
import { DashCodeSurface } from './DashCodeSurface'
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
  const { input, setInput, result, busy, execute, reset } = useDashWorkflow(repoPath)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')
  const copyGeneration = useRef(0)
  const clearCopy = () => {
    copyGeneration.current++
    setCopied(false)
    setCopyError('')
  }
  useEffect(() => {
    clearCopy()
    return () => {
      copyGeneration.current++
    }
  }, [repoPath])
  const copy = async () => {
    if (!result?.success) return
    const current = ++copyGeneration.current
    setCopied(false)
    setCopyError('')
    try {
      await navigator.clipboard.writeText(result.context)
      if (current === copyGeneration.current) setCopied(true)
    } catch {
      if (current === copyGeneration.current)
        setCopyError('Não foi possível copiar o contexto. Tente novamente.')
    }
  }
  return (
    <div className="dash-view-container">
      <header className="dash-view-header">
        <div className="dash-feature-identity">
          <div className="dash-feature-icon" aria-hidden="true">
            <Zap size={32} />
          </div>
          <div>
            <div className="dash-view-title-group">
              <h2>Code Dash</h2>
              <span className="dash-version">v2</span>
            </div>
            <p>Uma solicitação. Somente o contexto que você pediu.</p>
          </div>
        </div>
        <div className="dash-signal-motif">
          <span className="dash-signal-symbol" aria-hidden="true">
            <Sparkles size={22} />
          </span>
          <div>
            <strong>Pure Signal</strong>
            <span>Apenas o que você pediu. Sem ruído, sem excesso.</span>
          </div>
        </div>
      </header>
      {!repoPath ? (
        <div className="dash-empty dash-no-project">
          Selecione um projeto para usar o Code Dash.
        </div>
      ) : (
        <>
          {(result || busy) && (
            <section
              className={`dash-report ${busy ? 'dash-report-working' : result?.success ? 'dash-report-success' : 'dash-report-error'}`}
              aria-label="Relatório de resolução"
              role={!busy && result && !result.success ? 'alert' : 'status'}
            >
              <div className="dash-report-status">
                {busy ? (
                  <Loader2 size={18} className="animate-spin" aria-hidden="true" />
                ) : result?.success ? (
                  <CheckCircle2 size={18} aria-hidden="true" />
                ) : (
                  <AlertCircle size={18} aria-hidden="true" />
                )}
                <strong>
                  {busy
                    ? 'Resolvendo solicitação…'
                    : result?.success
                      ? 'Solicitação resolvida'
                      : 'Solicitação não resolvida'}
                </strong>
              </div>
              {result && (
                <div className="dash-step-counts">
                  {result.report.steps.map((step) => (
                    <span key={step.id}>
                      {step.id}: {step.count}
                    </span>
                  ))}
                </div>
              )}
              {result?.report.error && (
                <p>
                  {result.report.error.code}: {result.report.error.message}
                </p>
              )}
              {result && !result.success && result.report.tokenCount !== undefined && (
                <span>{result.report.tokenCount.toLocaleString()} tokens solicitados</span>
              )}
            </section>
          )}
          <div className="dash-workspace">
            <section className="dash-pane dash-request-pane" aria-label="Solicitação">
              <div className="dash-pane-heading">
                <h3>
                  <FileJson2 size={20} aria-hidden="true" />
                  Solicitação
                </h3>
                <span
                  className="dash-pane-metadata"
                  title={props.projectName ?? props.activeProject?.name}
                >
                  {props.projectName ?? props.activeProject?.name ?? 'Projeto ativo'}
                </span>
              </div>
              <p className="dash-hint">
                Cole o JSON gerado pela IA e resolva o pedido em uma execução.
              </p>
              <DashCodeSurface
                value={input}
                disabled={busy}
                onChange={(value) => {
                  clearCopy()
                  setInput(value)
                }}
              />
              <div className="dash-actions-bar">
                <button
                  className="app-pill-btn primary dash-primary-action"
                  disabled={busy || !input.trim()}
                  onClick={() => {
                    clearCopy()
                    void execute()
                  }}
                >
                  {busy ? (
                    <Loader2 size={17} className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Play size={17} aria-hidden="true" />
                  )}
                  {busy ? 'Resolvendo…' : 'Gerar contexto'}
                </button>
                <button
                  className="app-ghost-btn dash-secondary-action"
                  disabled={busy}
                  onClick={() => {
                    clearCopy()
                    reset()
                  }}
                >
                  <RotateCcw size={17} aria-hidden="true" />
                  Limpar
                </button>
              </div>
            </section>
            <section className="dash-pane dash-context-pane" aria-label="Contexto">
              <div className="dash-pane-heading">
                <h3>
                  <FileJson2 size={20} aria-hidden="true" />
                  Contexto
                </h3>
                {result?.success && (
                  <span className="dash-pane-metadata">
                    {result.tokenCount.toLocaleString()} tokens
                  </span>
                )}
              </div>
              <p className="dash-hint">
                Somente os registros e campos solicitados, prontos para copiar.
              </p>
              {result?.success ? (
                <>
                  <DashCodeSurface value={result.context} />
                  <div className="dash-actions-bar">
                    <button
                      className={`app-pill-btn primary dash-copy-action ${copied ? 'dash-copy-success' : ''}`}
                      onClick={() => void copy()}
                    >
                      {copied ? (
                        <Check size={17} aria-hidden="true" />
                      ) : (
                        <Copy size={17} aria-hidden="true" />
                      )}
                      {copied ? 'Contexto copiado' : 'Copiar contexto'}
                    </button>
                    <span className="dash-copy-announcement" role="status">
                      {copied ? 'Contexto copiado' : ''}
                    </span>
                  </div>
                </>
              ) : (
                <div className="dash-empty">
                  {busy
                    ? 'Resolvendo o pedido sobre o Code Map…'
                    : 'O contexto solicitado aparecerá aqui.'}
                </div>
              )}
              {copyError && (
                <p className="dash-copy-error" role="alert">
                  {copyError}
                </p>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  )
}
