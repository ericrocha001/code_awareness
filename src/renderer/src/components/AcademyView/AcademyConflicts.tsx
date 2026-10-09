import React, { useState } from 'react'
import type { AcademyConflictBatch, AcademyConflictReview, AcademyConflictSummary, AcademyDestination } from '../../../../shared/types/academy-types'

const causes = { MISSING: 'Pacote ausente', INVALID: 'Pacote inválido', HISTORICAL: 'Versão histórica', DIVERGENT: 'Conteúdo divergente' }

export function AcademyConflicts({ conflicts, destinations, onReview, onPreviewBatch }: {
  conflicts: AcademyConflictSummary[]
  destinations: AcademyDestination[]
  onReview: (id: string) => void
  onPreviewBatch: () => void
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  return <div className="academy-conflicts-summary">
    <p>{conflicts.length} ocorrências distintas exigem revisão.</p>
    {Object.entries(causes).map(([cause, label]) => {
      const items = conflicts.filter((conflict) => conflict.cause === cause)
      if (!items.length) return null
      return <div key={cause}>
        <button className="academy-conflict-group" aria-expanded={expanded === cause} onClick={() => setExpanded(expanded === cause ? null : cause)}><span>{label}</span><strong>{items.length}</strong></button>
        {expanded === cause && <ul className="academy-conflict-items">{items.map((conflict) => <li key={conflict.id}>
          <button onClick={() => onReview(conflict.id)}><strong>{conflict.skillName}</strong><small>{destinations.find((destination) => destination.id === conflict.projectId)?.name ?? conflict.origin} · canônica v{conflict.currentVersion}{conflict.historicalVersion !== null ? ` · histórica v${conflict.historicalVersion}` : ''}</small></button>
        </li>)}</ul>}
      </div>
    })}
    <button className="academy-secondary-button" onClick={onPreviewBatch}>Prévia de saneamento seguro</button>
  </div>
}

export function AcademyConflictInspector({ review, batch, busy, onClose, onResolve, onResolveBatch }: {
  review: AcademyConflictReview | null
  batch: AcademyConflictBatch | null
  busy: boolean
  onClose: () => void
  onResolve: (resolution: 'CANONICAL' | 'DIVERGENT') => void
  onResolveBatch: () => void
}) {
  return <div className="academy-overlay" onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
    <section className="academy-drawer academy-conflict-inspector" role="dialog" aria-modal="true" aria-labelledby="academy-conflict-title">
      <header><div><span>Sincronização</span><h2 id="academy-conflict-title">{review ? review.conflict.skillName : 'Prévia de saneamento'}</h2></div><button autoFocus className="academy-icon-button" aria-label="Fechar revisão" onClick={onClose}>×</button></header>
      {review && <>
        <dl><dt>Tipo</dt><dd>{causes[review.cause]}</dd><dt>Destino</dt><dd>{review.conflict.projectionPath ?? review.conflict.origin}</dd><dt>Versão canônica</dt><dd>v{review.currentVersion}</dd><dt>Versão histórica correspondente</dt><dd>{review.historicalVersion !== null ? `v${review.historicalVersion}` : 'Nenhuma'}</dd><dt>Observado em</dt><dd>{new Date(review.conflict.createdAt).toLocaleString()}</dd></dl>
        <p>{review.reason}</p>
        <pre className="academy-conflict-diff" aria-label="Diferenças entre canônica e divergente">{review.diff}</pre>
        <footer><button disabled={busy} className="academy-secondary-button" onClick={() => onResolve('CANONICAL')}>Manter canônica</button><button disabled={busy || !review.conflict.divergentPackage} className="academy-danger-button" onClick={() => onResolve('DIVERGENT')}>Adotar conteúdo divergente como nova versão canônica</button></footer>
      </>}
      {batch && <>
        <p>{batch.entries.length} ocorrências elegíveis · {batch.entries.reduce((sum, entry) => sum + entry.occurrences, 0)} registros acumulados · {batch.excluded} ocorrências excluídas.</p>
        <p>Manter as versões canônicas atuais e reconciliar apenas os destinos certificados. Cada condição será verificada novamente antes da alteração.</p>
        <ul className="academy-batch-entries">{batch.entries.map((entry) => <li key={entry.id}><strong>{entry.skillName}</strong><small>{entry.destination}</small><span>{entry.reason}</span></li>)}</ul>
        <footer><button disabled={busy || !batch.entries.length} className="academy-secondary-button" onClick={onResolveBatch}>Manter canônicas do lote</button></footer>
      </>}
    </section>
  </div>
}
