import React, { useState } from 'react'
import {
  AlertCircle,
  Loader2,
  Play,
  RotateCcw,
  Sparkles,
  Zap
} from 'lucide-react'
import { CodeDashModeSwitcher } from './CodeDashModeSwitcher'
import type { DashMode } from './CodeDashModeSwitcher'
import { DashResolutionSummary } from './DashResolutionSummary'
import { DashXmlPreview } from './DashXmlPreview'
import { useDashSettings } from './hooks/useDashSettings'
import { useDashWorkflow } from './hooks/useDashWorkflow'
import { ToggleSwitch } from '../ToggleSwitch/ToggleSwitch'
import { RepoDiscoveryPanel } from './RepoDiscoveryPanel'
import './CodeDashView.css'

export interface CodeDashViewProps {
  activeProject?: { path: string; name: string } | null
  repoPath?: string
  projectName?: string
  onSelectProject?: (project: { path: string; name: string } | null) => void
  onStatusMessage?: (text: string, isError?: boolean) => void
}

type OneClickState = 'idle' | 'generating' | 'done' | 'error'

export const CodeDashView: React.FC<CodeDashViewProps> = (props) => {
  const repoPath = props.repoPath ?? props.activeProject?.path ?? ''
  const projectName =
    props.projectName ?? props.activeProject?.name ?? 'Repository'

  const {
    state,
    input,
    setInput,
    resolutionReport,
    xml,
    tokenCount,
    error,
    pasteAndResolve,
    generate,
    reset
  } = useDashWorkflow(repoPath)

  // Settings compartilhadas entre os modos e modo ativo da workspace (estado efêmero).
  const { settings, updateSettings } = useDashSettings()
  const [mode, setMode] = useState<DashMode>('selective')

  // Estado local do One-Click XML (independente do workflow principal)
  const [ocState, setOcState] = useState<OneClickState>('idle')
  const [ocXml, setOcXml] = useState<string | null>(null)
  const [ocTokenCount, setOcTokenCount] = useState<number | null>(null)
  const [ocError, setOcError] = useState<string | null>(null)

  const handleOneClickGenerate = async () => {
    if (!repoPath) return
    setOcState('generating')
    setOcXml(null)
    setOcTokenCount(null)
    setOcError(null)
    try {
      const result = await window.codeAwareness.dashOneClickXml(repoPath, {
        persistedSettings: settings
      })
      if (result.success && result.xml) {
        setOcXml(result.xml)
        setOcTokenCount(result.tokenCount ?? null)
        setOcState('done')
      } else {
        setOcError(result.error ?? 'Falha desconhecida na geração One-Click.')
        setOcState('error')
      }
    } catch (err) {
      setOcError(err instanceof Error ? err.message : 'Erro inesperado.')
      setOcState('error')
    }
  }

  const handleOneClickReset = () => {
    setOcState('idle')
    setOcXml(null)
    setOcTokenCount(null)
    setOcError(null)
  }

  if (!repoPath) {
    return (
      <div className="dash-view-container">
        <div className="dash-view-header">
          <div className="dash-view-title-group">
            <Zap className="dash-view-icon" size={24} />
            <h2 className="dash-view-title">Code Dash</h2>
          </div>
          <p className="dash-view-subtitle">
            Geração ultra-rápida de contexto seletivo e comprimido.
          </p>
        </div>
        <div className="dash-no-project-msg">
          Selecione um projeto na tela inicial para usar o Code Dash.
        </div>
      </div>
    )
  }

  const totalResolved = resolutionReport?.request?.items.length ?? 0
  const totalFailures = resolutionReport?.failures.length ?? 0
  const totalRequested = totalResolved + totalFailures

  const generateBtnLabel =
    totalFailures === 0
      ? 'Gerar Contexto'
      : `Gerar Contexto Resolvido (${totalResolved}/${totalRequested} itens)`

  return (
    <div className="dash-view-container">
      <div className="dash-view-header">
        <div className="dash-view-title-group">
          <Zap className="dash-view-icon" size={24} />
          <h2 className="dash-view-title">Code Dash</h2>
        </div>
        <p className="dash-view-subtitle">
          Cole uma solicitação de contexto gerada pela IA para analisar, resolver e gerar o XML canônico.
        </p>
      </div>

      <RepoDiscoveryPanel repoPath={repoPath} projectName={projectName} />

      {/* OptimizationBar compartilhada entre os modos */}
      <div className="dash-optimization-bar">
        <span className="dash-opt-title">Configurações de Economia de Tokens</span>
        <div className="dash-opt-toggles">
          <label className="dash-opt-toggle">
            <ToggleSwitch
              checked={settings.removeComments}
              onChange={(v) => updateSettings({ removeComments: v })}
              disabled={state === 'generating' || ocState === 'generating'}
            />
            <span onClick={() => { if (state !== 'generating' && ocState !== 'generating') { updateSettings({ removeComments: !settings.removeComments }) } }}>Remover comentários</span>
          </label>
          <label className="dash-opt-toggle">
            <ToggleSwitch
              checked={settings.removeEmptyLines}
              onChange={(v) => updateSettings({ removeEmptyLines: v })}
              disabled={state === 'generating' || ocState === 'generating'}
            />
            <span onClick={() => { if (state !== 'generating' && ocState !== 'generating') { updateSettings({ removeEmptyLines: !settings.removeEmptyLines }) } }}>Remover linhas vazias</span>
          </label>
          <label className="dash-opt-toggle">
            <ToggleSwitch
              checked={settings.truncateBase64}
              onChange={(v) => updateSettings({ truncateBase64: v })}
              disabled={state === 'generating' || ocState === 'generating'}
            />
            <span onClick={() => { if (state !== 'generating' && ocState !== 'generating') { updateSettings({ truncateBase64: !settings.truncateBase64 }) } }}>Truncar Base64</span>
          </label>
        </div>
      </div>

      {/* Seletor de modo de workflow */}
      <CodeDashModeSwitcher mode={mode} onModeChange={setMode} />

      {/* Workspace: painel do modo ativo (estados oc* / workflow permanecem no topo) */}
      <div className="dash-workspace">
        {mode === 'selective' ? (
          <div className="dash-panel">
            {state === 'error' && error && (
              <div className="dash-error-banner">
                <AlertCircle size={18} />
                <div className="dash-error-content">
                  <span className="dash-error-title">Erro na Solicitação</span>
                  <span className="dash-error-msg">{error}</span>
                </div>
              </div>
            )}

      {/* Área de Entrada (visível em idle, parsing, error, e em modo leitura/colapsado em resolved) */}
      {state !== 'done' && (
        <div className="dash-input-section">
          <textarea
            className="dash-textarea"
            placeholder="Cole aqui a solicitação Code Dash (JSON puro ou dentro de blocos ```json)..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={state === 'parsing' || state === 'generating'}
          />

          <div className="dash-actions-bar">
            {state === 'idle' && (
              <button
                type="button"
                className="app-pill-btn primary"
                onClick={pasteAndResolve}
                disabled={!input.trim()}
              >
                <Sparkles size={14} />
                <span>Analisar Solicitação</span>
              </button>
            )}

            {state === 'parsing' && (
              <button type="button" className="app-pill-btn primary" disabled>
                <Loader2 size={14} className="animate-spin" />
                <span>Analisando solicitação...</span>
              </button>
            )}

            {state === 'resolved' && (
              <>
                <button
                  type="button"
                  className="app-pill-btn primary"
                  onClick={() => generate(settings)}
                  disabled={totalResolved === 0}
                >
                  <Play size={14} />
                  <span>{generateBtnLabel}</span>
                </button>
                <button
                  type="button"
                  className="app-ghost-btn"
                  onClick={reset}
                >
                  <RotateCcw size={14} />
                  <span>Limpar</span>
                </button>
              </>
            )}

            {state === 'generating' && (
              <button type="button" className="app-pill-btn primary" disabled>
                <Loader2 size={14} className="animate-spin" />
                <span>Gerando contexto...</span>
              </button>
            )}

            {state === 'error' && (
              <button
                type="button"
                className="app-ghost-btn"
                onClick={reset}
              >
                <RotateCcw size={14} />
                <span>Tentar Novamente</span>
              </button>
            )}
          </div>
        </div>
      )}

      {(state === 'resolved' || state === 'generating' || state === 'done') &&
        resolutionReport && <DashResolutionSummary report={resolutionReport} />}

      {state === 'done' && xml && (
        <DashXmlPreview
          xml={xml}
          name={resolutionReport?.request?.output.name || projectName}
          tokenCount={tokenCount ?? undefined}
          onReset={reset}
        />
      )}
        </div>
        ) : (
          <div className="dash-panel">
            <div className="dash-actions-bar">
              {ocState === 'idle' && (
                <button
                  type="button"
                  className="app-pill-btn primary"
                  onClick={handleOneClickGenerate}
                >
                  <Zap size={14} />
                  <span>Gerar XML do Repositório</span>
                </button>
              )}

              {ocState === 'generating' && (
                <button type="button" className="app-pill-btn primary" disabled>
                  <Loader2 size={14} className="animate-spin" />
                  <span>Gerando XML...</span>
                </button>
              )}

              {(ocState === 'done' || ocState === 'error') && (
                <button
                  type="button"
                  className="app-ghost-btn"
                  onClick={handleOneClickReset}
                >
                  <RotateCcw size={14} />
                  <span>Nova Geração</span>
                </button>
              )}
            </div>

            {ocState === 'error' && ocError && (
              <div className="dash-error-banner">
                <AlertCircle size={16} />
                <span>{ocError}</span>
              </div>
            )}

            {ocState === 'done' && ocXml && (
              <DashXmlPreview
                xml={ocXml}
                name={projectName}
                tokenCount={ocTokenCount ?? undefined}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
