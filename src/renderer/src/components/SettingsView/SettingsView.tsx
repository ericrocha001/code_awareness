import React, { useEffect, useRef, useState } from 'react'
import { MessageSquare, ShieldCheck } from 'lucide-react'
import type { ChatGptIntegrationState, ChatGptIntegrationStatus } from '../../../../shared/types/chatgpt-integration-types'
import { DiagnosticModal } from '../SystemHealth/DiagnosticModal'
import './SettingsView.css'

const presentation: Record<ChatGptIntegrationStatus, { title: string; description: string }> = {
  DISABLED: { title: 'O acesso remoto está desativado', description: 'Ative o acesso remoto para disponibilizar o projeto ativo ao ChatGPT.' },
  SETUP_REQUIRED: { title: 'Configuração necessária', description: 'Esta instalação não está pronta para acesso remoto.' },
  WAITING_FOR_PROJECT: { title: 'Aguardando um projeto', description: 'Abra ou ative um projeto para disponibilizá-lo ao ChatGPT.' },
  CONNECTING: { title: 'Conectando…', description: 'O Code Awareness está preparando o acesso ao projeto ativo.' },
  READY: { title: 'Pronto para o ChatGPT', description: 'Uma chamada real do CodeScope completou pelo acesso remoto.' },
  OFFLINE: { title: 'Temporariamente offline', description: 'O Code Awareness se reconectará automaticamente.' },
  NEEDS_ATTENTION: { title: 'Requer atenção', description: 'O acesso remoto requer atenção. Abra o Diagnóstico para detalhes.' }
}

function codeScopeLabel(status: ChatGptIntegrationState['codeScopeStatus']): string {
  switch (status) {
    case 'OPERATIONAL': return 'OPERACIONAL'
    case 'DEGRADED': return 'DEGRADADO'
    case 'UNAVAILABLE': return 'INDISPONÍVEL'
    default: return 'DESCONHECIDO'
  }
}

export function SettingsView() {
  const [state, setState] = useState<ChatGptIntegrationState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [showDiagnostic, setShowDiagnostic] = useState(false)
  const mounted = useRef(false)
  const receive = (next: ChatGptIntegrationState) => {
    if (mounted.current) setState((previous) => !previous || next.revision >= previous.revision ? next : previous)
  }
  useEffect(() => {
    mounted.current = true
    const unsubscribe = window.codeAwareness.onChatGptIntegrationChanged(receive)
    window.codeAwareness.getChatGptIntegrationState().then(receive).catch(() => {
      if (mounted.current) setError('Status da integração indisponível. Reabra as Configurações para tentar novamente.')
    })
    return () => { mounted.current = false; unsubscribe() }
  }, [])

  async function toggle() {
    if (!state || pending) return
    setPending(true); setError(null)
    try {
      const result = await (state.remoteAccessEnabled ? window.codeAwareness.disconnect() : window.codeAwareness.connect())
      if (!result.success && mounted.current) setError('Não foi possível atualizar o acesso remoto. Consulte o Diagnóstico para detalhes.')
      receive(await window.codeAwareness.getChatGptIntegrationState())
    } catch { if (mounted.current) setError('Não foi possível atualizar o acesso remoto. Consulte o Diagnóstico para detalhes.') }
    finally { if (mounted.current) setPending(false) }
  }

  const development = state?.lastError === 'DEVELOPMENT_TRANSPORT'
  const copy = state ? presentation[state.status] : null
  return <>
    <section className="settings-view" aria-labelledby="settings-title">
      <header className="settings-heading"><h1 id="settings-title">Configurações</h1><p>Configure o Code Awareness</p></header>
      <div className="settings-content">
        <h2>Integrações</h2>
        <article className="chatgpt-card" aria-labelledby="chatgpt-title">
          <header className="chatgpt-header"><span className="chatgpt-icon"><MessageSquare size={23} aria-hidden="true" /></span><div><h3 id="chatgpt-title">ChatGPT</h3><p>Permita que o ChatGPT acesse o projeto ativo através do Code Awareness.</p></div></header>
          {state && copy ? <>
            <div className={`chatgpt-status status-${state.status.toLowerCase()}`} role="status" aria-live="polite">
              <strong>{development ? 'Transporte de desenvolvimento ativo' : copy.title}</strong>
              <p>{development ? 'Esta instalação está usando um transporte de desenvolvimento em vez da conexão oficial do ChatGPT.' : copy.description}</p>
            </div>
            <div className="integration-project"><span>Projeto atual</span><strong>{state.activeProject?.name ?? 'Nenhum projeto ativo'}</strong></div>
            <div className="integration-access"><div><strong>Acesso remoto</strong><span>{state.remoteAccessEnabled ? 'Ativado' : 'Desativado'}</span></div><button type="button" className="integration-action" disabled={pending} onClick={toggle}>{pending ? 'Atualizando…' : state.remoteAccessEnabled ? 'Desativar acesso remoto' : 'Ativar acesso remoto'}</button></div>
            <p className="integration-help"><ShieldCheck size={16} aria-hidden="true" />Desativar o acesso remoto não remove a integração.</p>
            <div className="integration-codescope">
              <div className="codescope-summary">
                <span className="codescope-label">CodeScope</span>
                <span className={`codescope-status codescope-${state.codeScopeStatus.toLowerCase()}`}>{codeScopeLabel(state.codeScopeStatus)}</span>
                {state.lastSuccessfulAt && (
                  <span className="codescope-proof">Última prova funcional {new Date(state.lastSuccessfulAt).toLocaleTimeString()}</span>
                )}
                {state.lastFailedToolCall && state.codeScopeStatus !== 'OPERATIONAL' && (
                  <span className="codescope-failure">Última falha {state.lastFailedToolCall}</span>
                )}
              </div>
              <button type="button" className="integration-action" onClick={() => setShowDiagnostic(true)}>Diagnóstico CodeScope</button>
            </div>
            <details className="integration-diagnostics"><summary>Diagnóstico</summary><dl>
              <dt>Acesso remoto</dt><dd>{state.remoteAccessEnabled ? 'Ativado' : 'Desativado'}</dd>
              <dt>Transporte</dt><dd>{state.transport === 'relay' ? 'Relay' : 'Ngrok (desenvolvimento)'}</dd>
              <dt>Conexão</dt><dd>{state.connectionStatus}</dd>
              <dt>MCP</dt><dd>{state.mcpStatus}</dd>
              <dt>CodeScope</dt><dd>{state.codeScopeStatus}</dd>
              <dt>Projeto ativo</dt><dd>{state.activeProject?.name ?? 'Nenhum projeto ativo'}</dd>
              <dt>Instalação</dt><dd>{state.installationConfigured ? 'Configurada' : 'Configuração necessária'}</dd>
              <dt>Última operação funcional</dt><dd>{state.lastSuccessfulToolCall ? `${state.lastSuccessfulToolCall} — ${state.lastSuccessfulAt}` : '—'}</dd>
              <dt>Última falha funcional</dt><dd>{state.lastFailedToolCall ? `${state.lastFailedToolCall} — ${state.lastFailureStage}${state.lastStageLatencyMs !== null && state.lastStageLatencyMs !== undefined ? ` (${state.lastStageLatencyMs}ms${state.lastDeadlineRemainingMs !== null && state.lastDeadlineRemainingMs !== undefined ? `, ${state.lastDeadlineRemainingMs}ms restante` : ''})` : ''}` : '—'}</dd>
              <dt>Último erro</dt><dd>{state.lastError ?? '—'}</dd>
            </dl></details>
          </> : !error && <p role="status">Carregando integração…</p>}
          {error && <p className="integration-error" role="alert">{error}</p>}
        </article>
      </div>
    </section>
    {showDiagnostic && <DiagnosticModal onClose={() => setShowDiagnostic(false)} />}
  </>
}
