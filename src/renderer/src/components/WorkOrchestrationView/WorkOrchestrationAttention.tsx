import React from 'react'
import { ShieldCheck, Clock3, ScanEye, CalendarClock, CheckCircle2, AlertTriangle } from 'lucide-react'
import type { OrchestrationAttention, StructuralAlert } from '../../../../shared/types/work-orchestration-attention-types'
import type { ObservableWorktree } from '../../../../shared/types/work-orchestration-types'
import { OperationalRecommendation } from './OperationalRecommendation'

export function WorkOrchestrationAttention({ attention, worktrees, onEvidence }: { attention?: OrchestrationAttention | null; worktrees: ObservableWorktree[]; onEvidence: (alert: StructuralAlert) => void }) {
  const coverage = attention?.coverage === 'UNAVAILABLE' ? 'indisponível' : attention?.coverage === 'PENDING' ? 'pendente' : 'parcial'
  const hasAlerts = !!attention?.alerts.length
  return <section className={`wo-attention ${hasAlerts ? 'wo-attention--issue' : ''}`} aria-label="Atenção necessária">
    <div className="wo-attention-overview">
      <span className="wo-attention-emblem">{hasAlerts ? <AlertTriangle size={30} aria-hidden="true" /> : <ShieldCheck size={32} aria-hidden="true" />}</span>
      <div className="wo-attention-primary">
        <h2>{!attention || attention.coverage === 'UNAVAILABLE' ? 'Investigação indisponível' : hasAlerts ? 'Interferências que merecem atenção' : 'Nenhuma interferência confirmada no escopo observado'}</h2>
        <p>{attention ? `Cobertura ${coverage} · ${attention.observed}/${attention.known} worktrees observadas. Ausência de alerta não comprova segurança.` : 'A cobertura de investigação ainda não está disponível. O inventário não comprova ausência de interferências.'}</p>
        {attention && <div className="wo-attention-badges"><span className={`wo-status wo-status--${hasAlerts ? 'pending' : 'local'}`}><CheckCircle2 size={14} aria-hidden="true" />{attention.alerts.length} {hasAlerts ? 'alertas para revisão' : 'alertas confirmados'}</span><span className="wo-status wo-status--pending"><Clock3 size={14} aria-hidden="true" />Cobertura {coverage}</span>{attention.paused && <span className="wo-status">Reconciliação suspensa</span>}</div>}
      </div>
      {attention && <div className="wo-attention-facts"><span><Clock3 size={16} aria-hidden="true" />{attention.pending.length} pendentes</span><span><ScanEye size={16} aria-hidden="true" />{attention.observed} de {attention.known} observadas</span><span><CalendarClock size={16} aria-hidden="true" />{attention.checkedAt ? `Última investigação ${new Date(attention.checkedAt).toLocaleString('pt-BR')}` : 'Investigação ainda não registrada'}</span></div>}
    </div>
    {attention?.alerts.map(alert => <div key={alert.id} className="wo-attention-item"><div><strong>Possível interferência de contrato{alert.state === 'STALE' ? ' · obsoleta' : ''}</strong><OperationalRecommendation recommendation={alert.recommendation} provider={worktrees.find(w => w.worktreeId === alert.provider)?.branch ?? 'worktree do contrato'} consumer={worktrees.find(w => w.worktreeId === alert.consumer)?.branch ?? 'worktree consumidora'} /></div><button onClick={() => onEvidence(alert)}>Ver evidência</button></div>)}
    {attention && <details className="wo-attention-scope"><summary>Escopo e pendências</summary><p>Escopo seletivo TypeScript/JavaScript: declarações exportadas e ligações relativas diretas resolvidas. Reexport, aliases e escopo não observado permanecem incertos. Intervalo mínimo {Math.ceil(attention.cadenceMs / 1000)} s.</p>{!!attention.pending.length && <><p>{attention.pending.length} worktrees com observação ou investigação pendente</p><ul className="wo-paths">{attention.pending.map(p => <li key={p.worktreeId}>{worktrees.find(w => w.worktreeId === p.worktreeId)?.branch ?? p.worktreeId} · {p.reason}</li>)}</ul></>}</details>}
  </section>
}
