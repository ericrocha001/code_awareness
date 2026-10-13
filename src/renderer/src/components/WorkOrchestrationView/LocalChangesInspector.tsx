import React, { useEffect, useRef, useState } from 'react'
import { reasonLabel } from './work-orchestration-labels'
import { presentLocalChange } from './local-change-presentation'
import type { LocalChangesPage, ObservableWorktree, OrchestrationData, OrchestrationRequest, OrchestrationResult } from '../../../../shared/types/work-orchestration-types'

type Query = (extra: Pick<OrchestrationRequest, 'changes'>) => Promise<OrchestrationResult<OrchestrationData>>
export function LocalChangesInspector({ tree, query, revalidate, stale }: { tree: ObservableWorktree; query: Query; revalidate: () => void; stale: () => void }) {
  const [page, setPage] = useState<LocalChangesPage | null>(null)
  const [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
  const sequence = useRef(0)
  const read = async (cursor?: string) => {
    const ticket = ++sequence.current
    if (!tree.snapshotRevision || tree.observation !== 'VERIFIED') { setPage(null); setLoading(false); return }
    setLoading(true); setError(''); setPage(null)
    try {
      const result = await query({ changes: { worktreeId: tree.worktreeId, generation: tree.generation, snapshotRevision: tree.snapshotRevision, cursor } })
      if (ticket !== sequence.current) return
      if (!result.success) throw new Error(result.code)
      if (!('changes' in result.data) || result.data.generation !== tree.generation || result.data.snapshotRevision !== tree.snapshotRevision) throw new Error('WORKTREE_STALE')
      setPage(result.data)
    } catch (failure) { if (ticket === sequence.current) { const reason = failure instanceof Error ? failure.message : 'Leitura indisponível'; setError(reason); if (reason !== 'INVALID_ARGUMENT') stale() } }
    finally { if (ticket === sequence.current) setLoading(false) }
  }
  useEffect(() => { setCursors([undefined]); void read(); return () => { sequence.current++ } }, [tree.worktreeId, tree.generation, tree.snapshotRevision, tree.observation])
  return <section aria-label="Arquivos alterados"><h3>Arquivos alterados</h3>
    {loading && <p role="status">Lendo arquivos alterados…</p>}
    {error && <p role="alert" className="wo-warning">Obsoleto ou indisponível · {reasonLabel(error)}</p>}
    {page && <><p>{page.totalCount} {page.totalCount === 1 ? 'arquivo' : 'arquivos'} · página {cursors.length}</p>
      {!page.totalCount && <p>Nenhuma alteração local nesta observação.</p>}
      <ul className="wo-paths wo-local-changes">{page.changes.map(change => {
        const presentation = presentLocalChange(change)
        return <li key={change.path} className={change.conflicted ? 'wo-local-conflict' : undefined}>
          <strong>{change.path}</strong><div className="wo-change-classification">{presentation.classification}</div>
          {change.previousPath && <div>Origem: {change.previousPath}</div>}
          <div className="wo-change-description">{presentation.description}</div>
          <details className="wo-change-evidence"><summary>Estado Git original</summary>
            <div>Staged: {change.stagedState ?? '—'} · Unstaged: {change.unstagedState ?? '—'}</div>
            <div>Não rastreado: {change.untracked ? 'sim' : 'não'} · Em conflito: {change.conflicted ? 'sim' : 'não'}</div>
          </details>
        </li>
      })}</ul>
      {cursors.length > 1 && <button disabled={loading} onClick={() => { const previous = cursors.slice(0, -1); setCursors(previous); void read(previous[previous.length - 1]) }}>Página anterior</button>}
      {page.nextCursor && <button disabled={loading} onClick={() => { setCursors([...cursors, page.nextCursor!]); void read(page.nextCursor!) }}>Próxima página</button>}
    </>}
    <button disabled={loading} onClick={revalidate}>Revalidar worktree</button>
    <p className="wo-footnote">Um caminho pode ter alterações staged e unstaged ao mesmo tempo. Os contadores descrevem o estado local do Git, não a atividade de agentes.</p>
  </section>
}
