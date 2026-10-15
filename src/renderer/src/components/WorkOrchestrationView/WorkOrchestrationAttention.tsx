import React from 'react'
import { ShieldCheck } from 'lucide-react'
import type { OrchestrationAttention, StructuralAlert } from '../../../../shared/types/work-orchestration-attention-types'
import type { ObservableWorktree } from '../../../../shared/types/work-orchestration-types'
import { OperationalRecommendation } from './OperationalRecommendation'

export function WorkOrchestrationAttention({ attention, worktrees, onEvidence }: { attention?: OrchestrationAttention | null; worktrees: ObservableWorktree[]; onEvidence: (alert: StructuralAlert) => void }) {
  return <>
      {attention && <section className={`wo-attention ${attention.alerts.length ? 'wo-attention--issue' : ''}`} aria-label="Atenção necessária"><div className="wo-attention-heading"><ShieldCheck size={24} aria-hidden="true" /><h2>{attention.alerts.length ? 'Interferências que merecem atenção' : 'Nenhuma interferência confirmada no escopo observado'}</h2></div>
        <p>Cobertura {attention.coverage === 'UNAVAILABLE' ? 'indisponível' : attention.coverage === 'PENDING' ? 'pendente' : 'parcial'} · {attention.observed}/{attention.known} worktrees observadas{attention.paused ? ' · reconciliação suspensa' : ` · intervalo mínimo ${Math.ceil(attention.cadenceMs / 1000)} s`}. Ausência de alerta não comprova segurança.</p>
        <details><summary>Escopo e limites da investigação</summary><p>Escopo seletivo TypeScript/JavaScript: declarações exportadas e ligações relativas diretas resolvidas. Reexport, aliases e escopo não observado permanecem incertos.</p></details>
        {attention.alerts.map(alert => <div key={alert.id} className="wo-attention-item"><div><strong>Possível interferência de contrato{alert.state === 'STALE' ? ' · obsoleta' : ''}</strong><OperationalRecommendation recommendation={alert.recommendation} provider={worktrees.find(w => w.worktreeId === alert.provider)?.branch ?? 'worktree do contrato'} consumer={worktrees.find(w => w.worktreeId === alert.consumer)?.branch ?? 'worktree consumidora'} /></div><button onClick={() => onEvidence(alert)}>Ver evidência</button></div>)}
        {!!attention.pending.length && <details><summary>{attention.pending.length} worktrees com observação ou investigação pendente</summary><ul className="wo-paths">{attention.pending.map(p => <li key={p.worktreeId}>{worktrees.find(w => w.worktreeId === p.worktreeId)?.branch ?? p.worktreeId} · {p.reason}</li>)}</ul></details>}
      </section>}
      {!attention && <section className="wo-attention" aria-label="Atenção necessária"><h2>Investigação indisponível</h2><p>A cobertura de investigação ainda não está disponível. O inventário não comprova ausência de interferências.</p></section>}
  </>
}
