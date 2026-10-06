import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, ArrowRight, ArrowUpRight, Blocks, CheckCircle2, CircleHelp, Clock3, Code2, FileDown, Folder, GitBranch, GraduationCap, Infinity, Layers3, Loader2, Power, Radio, Server, ShieldCheck, Timer, TriangleAlert, Users, Zap, type LucideIcon } from 'lucide-react'
import type { ChannelAvailability, ChannelState } from '../../../../shared/types/channel-state-types'
import type { ChannelActivityCounters } from '../../../../shared/types/channel-types'
import { DiagnosticModal } from '../SystemHealth/DiagnosticModal'
import './ChannelView.css'

const availabilityCopy: Record<ChannelAvailability, { title: string; description: string }> = {
  DISABLED: { title: 'Acesso remoto desativado', description: 'Ative o acesso remoto para disponibilizar o projeto ativo ao ChatGPT.' },
  SETUP_REQUIRED: { title: 'Configuração necessária', description: 'Esta instalação precisa ser configurada para o acesso remoto.' },
  WAITING_FOR_PROJECT: { title: 'Aguardando um projeto', description: 'Abra ou ative um projeto para disponibilizá-lo pelo Channel.' },
  CONNECTING: { title: 'Conectando…', description: 'O Channel está preparando o acesso ao projeto ativo.' },
  READY: { title: 'Pronto para acesso remoto', description: 'O transporte e o MCP estão disponíveis para o projeto ativo.' },
  OFFLINE: { title: 'Temporariamente offline', description: 'O Channel se reconectará automaticamente.' },
  ERROR: { title: 'A conexão requer atenção', description: 'Consulte o estado abaixo e o diagnóstico para investigar.' }
}
const connectionCopy: Record<string, string> = { CONNECTED: 'Conectado', CONNECTING: 'Conectando', DISCONNECTED: 'Desconectado', STOPPED: 'Parado', STARTING: 'Iniciando', STOPPING: 'Parando', RUNNING: 'Em execução', ERROR: 'Requer atenção' }
const healthCopy = { UNKNOWN: 'Aguardando prova funcional', OPERATIONAL: 'Operacional', DEGRADED: 'Requer atenção' }
const average = (counters: ChannelActivityCounters) => counters.latency.completedRequests ? counters.latency.totalDurationMs / counters.latency.completedRequests : null
const duration = (value: number | null) => value === null ? '—' : `${Math.round(value).toLocaleString('pt-BR')} ms`
const date = (value: string | null) => value ? new Date(value).toLocaleString('pt-BR') : '—'
type Tone = 'healthy' | 'neutral' | 'warning' | 'working' | 'issue'
const healthTone = { UNKNOWN: 'neutral', OPERATIONAL: 'healthy', DEGRADED: 'warning' } as const
const availabilityTone: Record<ChannelAvailability, Tone> = { READY: 'healthy', DISABLED: 'neutral', SETUP_REQUIRED: 'warning', WAITING_FOR_PROJECT: 'neutral', CONNECTING: 'working', OFFLINE: 'warning', ERROR: 'issue' }
const capabilityIcons: Record<string, LucideIcon> = { 'Code Navigation': Code2, 'Git Operations': GitBranch, Academy: GraduationCap, Validation: ShieldCheck, Continuum: Infinity, 'Repository File Ingress': FileDown, 'System Health': Activity, 'Runtime Identity/Restart': Radio, 'Diagnostic Source Access': Code2 }
const connectionTone = (value: string): Tone => ['CONNECTED', 'RUNNING'].includes(value) ? 'healthy' : value === 'ERROR' ? 'issue' : ['CONNECTING', 'STARTING', 'STOPPING'].includes(value) ? 'working' : 'neutral'

function StatusBadge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const Icon = tone === 'healthy' ? CheckCircle2 : tone === 'issue' || tone === 'warning' ? TriangleAlert : tone === 'working' ? Radio : CircleHelp
  return <span className={`channel-badge channel-tone-${tone}`}><Icon size={14} aria-hidden="true" />{children}</span>
}

function PathStep({ icon: Icon, label, value, detail, tone }: { icon: LucideIcon; label: string; value: string; detail?: string; tone: Tone }) {
  return <div className={`channel-path-step channel-tone-${tone}`}>
    <span className="channel-path-icon"><Icon size={23} aria-hidden="true" /></span>
    <div className="channel-path-copy"><dt>{label}</dt><dd title={value}>{value}</dd>{detail && <small>{detail}</small>}</div>
    <ArrowRight className="channel-path-arrow" size={16} aria-hidden="true" />
  </div>
}

export function ChannelView() {
  const [state, setState] = useState<ChannelState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [showDiagnostic, setShowDiagnostic] = useState(false)
  const mounted = useRef(false)
  const updating = useRef(false)
  const closeDiagnostic = useCallback(() => setShowDiagnostic(false), [])
  const receive = (next: ChannelState) => {
    if (mounted.current) setState(previous => !previous || next.revision > previous.revision ? next : previous)
  }
  useEffect(() => {
    mounted.current = true
    const unsubscribe = window.codeAwareness.onChannelChanged(receive)
    window.codeAwareness.getChannelState().then(receive).catch(() => {
      if (mounted.current) setError('Estado do Channel indisponível. Reabra o Channel para tentar novamente.')
    })
    return () => { mounted.current = false; unsubscribe() }
  }, [])

  async function toggle() {
    if (!state || updating.current) return
    updating.current = true
    setPending(true); setError(null)
    try {
      const result = await (state.remoteAccessEnabled ? window.codeAwareness.disconnect() : window.codeAwareness.connect())
      if (!result.success && mounted.current) setError('Não foi possível atualizar o acesso remoto. Consulte o diagnóstico.')
      receive(await window.codeAwareness.getChannelState())
    } catch { if (mounted.current) setError('Não foi possível atualizar o acesso remoto. Consulte o diagnóstico.') }
    finally { updating.current = false; if (mounted.current) setPending(false) }
  }

  const health = state?.functionalHealth
  const activity = state?.activity
  const capabilities = activity ? Object.entries(activity.byCapability) : []
  const copy = state ? availabilityCopy[state.availability] : null
  const readyTitle = state?.availability === 'READY' && health?.status === 'DEGRADED' ? 'Disponível · operação requer atenção' : copy?.title
  const mainTone = state?.availability === 'READY' && health ? healthTone[health.status] : state ? availabilityTone[state.availability] : 'neutral'
  return <>
    <section className="channel-view" aria-labelledby="channel-title">
      <header className="channel-heading">
        <div className="channel-identity"><span className="channel-feature-icon"><Radio size={30} aria-hidden="true" /></span><div><h1 id="channel-title">Code Awareness Channel</h1><p>Acesso remoto, capacidades e saúde da execução atual.</p></div></div>
        <div className="channel-header-controls">
          <div className="channel-project"><Folder size={19} aria-hidden="true" /><div><span className="channel-label">Projeto ativo</span><strong title={state?.activeProject?.name}>{state?.activeProject?.name ?? 'Nenhum projeto ativo'}</strong></div></div>
          <button type="button" className="channel-action" disabled={!state || pending} aria-busy={pending} onClick={toggle}>{pending ? <Loader2 className="channel-spinner" size={16} aria-hidden="true" /> : <Power size={16} aria-hidden="true" />}{pending ? 'Atualizando…' : state?.remoteAccessEnabled ? 'Desativar acesso remoto' : 'Ativar acesso remoto'}</button>
        </div>
        {state && copy && <div className="channel-status" aria-label="Disponibilidade" role="status" aria-live="polite"><StatusBadge tone={mainTone}>{readyTitle}</StatusBadge><p>{copy.description}</p>{state.availability === 'READY' && health && <span className="channel-header-health">{healthCopy[health.status]}</span>}</div>}
      </header>
      {error && <p className="channel-error" role="alert">{error}</p>}
      {!state && !error && <p className="channel-loading" role="status"><Loader2 className="channel-spinner" size={18} aria-hidden="true" />Carregando Channel…</p>}
      {state && activity && health && copy && <div className="channel-content">
        <section className="channel-panel" aria-labelledby="channel-path-title">
          <div className="channel-section-heading"><h2 id="channel-path-title"><Radio size={19} aria-hidden="true" />Caminho operacional</h2><span>Controle local do acesso</span></div>
          <dl className="channel-path">
            <PathStep icon={ShieldCheck} label="Acesso remoto · ChatGPT" value={!state.installationConfigured ? 'Configuração necessária' : state.remoteAccessEnabled ? 'Ativado' : 'Desativado'} detail={!state.installationConfigured ? 'Instalação requer atenção' : undefined} tone={!state.installationConfigured ? 'warning' : state.remoteAccessEnabled ? 'healthy' : 'neutral'} />
            <PathStep icon={Server} label={state.transport === 'relay' ? 'Relay' : 'Transporte de desenvolvimento'} value={connectionCopy[state.connectionStatus] ?? 'Indisponível'} tone={connectionTone(state.connectionStatus)} />
            <PathStep icon={Blocks} label="MCP" value={connectionCopy[state.mcpStatus] ?? 'Indisponível'} tone={connectionTone(state.mcpStatus)} />
            <PathStep icon={Folder} label="Projeto atendido" value={state.activeProject?.name ?? 'Aguardando projeto'} tone={state.activeProject ? 'healthy' : 'neutral'} />
          </dl>
        </section>
        <section className="channel-panel" aria-labelledby="channel-activity-title">
          <div className="channel-section-heading"><h2 id="channel-activity-title"><Activity size={19} aria-hidden="true" />Atividade do Channel</h2><span className="channel-execution"><Clock3 size={13} aria-hidden="true" />Nesta execução</span></div>
          <dl className="channel-metrics">
            {[
              { label: 'Chamadas ativas', value: activity.activeRequests, icon: Zap }, { label: 'Pico simultâneo', value: activity.peakConcurrentRequests, icon: Users }, { label: 'Total de chamadas', value: activity.totalRequests, icon: Layers3 },
              { label: 'Falhas', value: activity.failedRequests, icon: TriangleAlert, tone: activity.failedRequests ? 'issue' : 'neutral' }, { label: 'Timeouts', value: activity.timedOutRequests, icon: Timer, tone: activity.timedOutRequests ? 'warning' : 'neutral' }, { label: 'Latência média', value: duration(average(activity)), icon: Clock3 }, { label: 'Latência máxima', value: duration(activity.latency.maxDurationMs), icon: Timer }
            ].map(({ label, value, icon: Icon, tone }) => <div key={label} className={tone ? `channel-metric-${tone}` : undefined}><dt><Icon size={15} aria-hidden="true" />{label}</dt><dd>{typeof value === 'number' ? value.toLocaleString('pt-BR') : value}</dd></div>)}
          </dl>
          <p className="channel-note">Contadores acumulados neste runtime, incluindo chamadas locais e remotas. Trocar de projeto preserva a atividade.</p>
        </section>
        <div className="channel-workspace">
        <section className="channel-panel channel-capabilities" aria-labelledby="channel-capabilities-title">
          <div className="channel-section-heading"><h2 id="channel-capabilities-title"><Layers3 size={19} aria-hidden="true" />Atividade por capacidade</h2><span>Capacidades observadas</span></div>
          {capabilities.length ? <div className="channel-table-scroll" tabIndex={0} role="region" aria-label="Tabela de atividade por capacidade"><table className="channel-table"><thead><tr><th scope="col">Capacidade</th><th scope="col">Ativas</th><th scope="col">Total</th><th scope="col">Sucesso</th><th scope="col">Falhas</th><th scope="col">Timeouts</th><th scope="col">Latência média</th></tr></thead><tbody>{capabilities.map(([name, counters]) => {
            const Icon = capabilityIcons[name] ?? Blocks
            return <tr key={name}><th scope="row"><span className="channel-capability-name" title={name}><Icon size={16} aria-hidden="true" /><span>{name}</span></span></th><td>{counters.activeRequests.toLocaleString('pt-BR')}</td><td>{counters.totalRequests.toLocaleString('pt-BR')}</td><td>{counters.succeededRequests.toLocaleString('pt-BR')}</td><td className={counters.failedRequests ? 'channel-value-issue' : undefined}>{counters.failedRequests.toLocaleString('pt-BR')}</td><td className={counters.timedOutRequests ? 'channel-value-warning' : undefined}>{counters.timedOutRequests.toLocaleString('pt-BR')}</td><td>{duration(average(counters))}</td></tr>
          })}</tbody></table></div> : <div className="channel-empty"><span><Layers3 size={24} aria-hidden="true" /></span><strong>Nenhuma capacidade observada nesta execução.</strong><p>As chamadas ao Channel aparecerão aqui.</p></div>}
        </section>
        <section className="channel-panel channel-health" aria-labelledby="channel-health-title">
          <div className="channel-section-heading"><h2 id="channel-health-title"><Activity size={19} aria-hidden="true" />System Health — Code Navigation</h2></div>
          <p className="channel-panel-description">Saúde funcional observada na navegação de código.</p>
          <div className="channel-health-summary"><StatusBadge tone={healthTone[health.status]}>{healthCopy[health.status]}</StatusBadge><span>Saúde funcional observada</span></div>
          <dl className="channel-health-details">
            <div><dt>Última operação funcional</dt><dd>{health.lastSuccessfulToolCall ?? 'Nenhuma prova nesta execução'}</dd><small>{date(health.lastSuccessfulAt)}</small></div>
            <div><dt>Última falha funcional</dt><dd>{health.lastFailedToolCall ?? 'Nenhuma falha observada'}</dd><small>{date(health.lastFailedAt)}</small></div>
            <div><dt>Duração da última etapa</dt><dd>{duration(health.lastStageLatencyMs)}</dd></div>
          </dl>
          {(state.lastError || health.lastError) && <p className="channel-error">{state.lastError ?? health.lastError}</p>}
          <div className="channel-diagnostic"><p>Consulte a prova funcional e as fronteiras da navegação de código.</p><button type="button" className="channel-action" onClick={() => setShowDiagnostic(true)}>Abrir diagnóstico<ArrowUpRight size={15} aria-hidden="true" /></button></div>
        </section>
        </div>
      </div>}
    </section>
    {showDiagnostic && <DiagnosticModal onClose={closeDiagnostic} />}
  </>
}
