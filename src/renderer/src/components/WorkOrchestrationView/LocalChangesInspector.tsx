import React, { useEffect, useRef, useState } from 'react'
import { reasonLabel } from './work-orchestration-labels'
import type { LocalChangesPage, ObservableWorktree, OrchestrationData, OrchestrationRequest, OrchestrationResult } from '../../../../shared/types/work-orchestration-types'

type Query = (extra: Pick<OrchestrationRequest, 'changes'>) => Promise<OrchestrationResult<OrchestrationData>>
export function LocalChangesInspector({ tree, query, revalidate, stale }: { tree: ObservableWorktree; query: Query; revalidate: () => void; stale: () => void }) {
  const [page, setPage] = useState<LocalChangesPage | null>(null), [prefix, setPrefix] = useState('')
  const [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
  const sequence = useRef(0)
  const read = async (cursor?: string) => {
    const ticket = ++sequence.current
    if (!tree.snapshotRevision || tree.observation !== 'VERIFIED') { setPage(null); setLoading(false); return }
    setLoading(true); setError(''); setPage(null)
    try {
      const result = await query({ changes: { worktreeId: tree.worktreeId, generation: tree.generation, snapshotRevision: tree.snapshotRevision, cursor, pathPrefix: prefix || undefined } })
      if (ticket !== sequence.current) return
      if (!result.success) throw new Error(result.code)
      if (!('changes' in result.data) || result.data.generation !== tree.generation || result.data.snapshotRevision !== tree.snapshotRevision) throw new Error('WORKTREE_STALE')
      setPage(result.data)
    } catch (failure) { if (ticket === sequence.current) { const reason = failure instanceof Error ? failure.message : 'Leitura indisponível'; setError(reason); if (reason !== 'INVALID_ARGUMENT') stale() } }
    finally { if (ticket === sequence.current) setLoading(false) }
  }
  useEffect(() => { setCursors([undefined]); void read(); return () => { sequence.current++ } }, [tree.worktreeId, tree.generation, tree.snapshotRevision, tree.observation])
  return <section aria-label="Caminhos com alterações locais"><h3>Caminhos com alterações locais</h3>
    <form className="wo-local-filter" onSubmit={event => { event.preventDefault(); setCursors([undefined]); void read() }}>
      <input aria-label="Filtrar prefixo dos caminhos locais" placeholder="Arquivo exato ou prefixo de diretório" value={prefix} onChange={event => setPrefix(event.target.value)} />
      <button disabled={loading || tree.observation !== 'VERIFIED'}>Filtrar</button>
    </form>
    {loading && <p role="status">Lendo caminhos locais…</p>}
    {error && <p role="alert" className="wo-warning">{error === 'INVALID_ARGUMENT' ? 'Use um arquivo exato ou prefixo de diretório do repositório, sem curingas.' : `Obsoleto ou indisponível · ${reasonLabel(error)}`}</p>}
    {page && <><p>{page.totalCount} {page.totalCount === 1 ? 'caminho encontrado' : 'caminhos encontrados'} · página {cursors.length}</p><ul className="wo-paths">{page.changes.map(change => <li key={change.path}>
      <strong>{change.path}</strong>{change.previousPath && <div>Origem: {change.previousPath}</div>}
      <div>{change.conflicted ? 'Em conflito · ' : change.untracked ? 'Não rastreado · ' : ''}Staged: {change.stagedState ?? '—'} · Unstaged: {change.unstagedState ?? '—'}</div>
    </li>)}</ul>
      {cursors.length > 1 && <button disabled={loading} onClick={() => { const previous = cursors.slice(0, -1); setCursors(previous); void read(previous[previous.length - 1]) }}>Página anterior</button>}
      {page.nextCursor && <button disabled={loading} onClick={() => { setCursors([...cursors, page.nextCursor!]); void read(page.nextCursor!) }}>Próxima página</button>}
    </>}
    <button disabled={loading} onClick={revalidate}>Revalidar worktree</button>
    <p className="wo-footnote">Um caminho pode ter alterações staged e unstaged ao mesmo tempo. Os contadores descrevem o estado local do Git, não a atividade de agentes.</p>
  </section>
}
