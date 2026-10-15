import React from 'react'
import type { StructuralAlert } from '../../../../shared/types/work-orchestration-attention-types'
export function StructuralEvidence({ alert, providerName = alert.provider, consumerName = alert.consumer }: { alert: StructuralAlert; providerName?: string; consumerName?: string }) {
  return <section className="wo-structural-evidence" aria-label="Evidência de interferência estrutural">
    <h3>Possível interferência de contrato</h3>
    <p>{alert.state === 'CURRENT' ? 'Confirmada na última observação' : 'Evidência obsoleta · aguardando nova confirmação'} · {new Date(alert.verifiedAt).toLocaleString('pt-BR')}</p>
    <p>Ligação direta resolvida entre contrato alterado e consumidor modificado. Não comprova bug nem atividade de agente.</p>
    <p>Escopo direto e limitado; observações por lado, sem snapshot global atômico.</p>
    <dl><dt>Contrato / consumidor</dt><dd>{providerName} → {consumerName}</dd><dt>Merge-base comum</dt><dd>{alert.base}</dd></dl>
    <ul className="wo-paths">{alert.evidence.map(e => <li key={`${e.contractPath}:${e.consumerPath}:${e.symbol}`}>
      <strong>{e.symbol}</strong><p>{e.contractPath}:{e.contractLine} → {e.consumerPath}:{e.consumerLine}</p>
      <p>Assinatura anterior: {e.previousSignature}</p><p>Assinatura observada: {e.signature}</p>
    </li>)}</ul>
    <details><summary>Identidades e revisões da confirmação</summary><dl><dt>ID do contrato</dt><dd>{alert.provider}</dd><dt>ID do consumidor</dt><dd>{alert.consumer}</dd><dt>Geração do contrato</dt><dd>{alert.providerGeneration}</dd><dt>Geração do consumidor</dt><dd>{alert.consumerGeneration}</dd><dt>Revisão do contrato</dt><dd>{alert.providerRevision}</dd><dt>Revisão do consumidor</dt><dd>{alert.consumerRevision}</dd></dl></details>
  </section>
}
