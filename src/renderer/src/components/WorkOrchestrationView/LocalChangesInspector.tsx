import React, { useEffect, useRef, useState } from 'react'
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
    } catch (failure) { if (ticket === sequence.current) { const reason = failure instanceof Error ? failure.message : 'Read unavailable'; setError(reason); if (reason !== 'INVALID_ARGUMENT') stale() } }
    finally { if (ticket === sequence.current) setLoading(false) }
  }
  useEffect(() => { setCursors([undefined]); void read(); return () => { sequence.current++ } }, [tree.worktreeId, tree.generation, tree.snapshotRevision, tree.observation])
  return <section aria-label="Local change paths"><h3>Local change paths</h3>
    <form className="wo-local-filter" onSubmit={event => { event.preventDefault(); setCursors([undefined]); void read() }}>
      <input aria-label="Filter local path prefix" placeholder="Exact file or directory prefix" value={prefix} onChange={event => setPrefix(event.target.value)} />
      <button disabled={loading || tree.observation !== 'VERIFIED'}>Filter</button>
    </form>
    {loading && <p role="status">Reading local paths…</p>}
    {error && <p role="alert" className="wo-warning">{error === 'INVALID_ARGUMENT' ? 'Use an exact repository file or directory prefix, without wildcards.' : `Stale or unavailable · ${error}. Revalidate this worktree.`}</p>}
    {page && <><p>{page.totalCount} matching paths · page {cursors.length}</p><ul className="wo-paths">{page.changes.map(change => <li key={change.path}>
      <strong>{change.path}</strong>{change.previousPath && <div>From: {change.previousPath}</div>}
      <div>{change.conflicted ? 'Conflicted · ' : change.untracked ? 'Untracked · ' : ''}Staged: {change.stagedState ?? '—'} · Unstaged: {change.unstagedState ?? '—'}</div>
    </li>)}</ul>
      {cursors.length > 1 && <button disabled={loading} onClick={() => { const previous = cursors.slice(0, -1); setCursors(previous); void read(previous[previous.length - 1]) }}>Previous page</button>}
      {page.nextCursor && <button disabled={loading} onClick={() => { setCursors([...cursors, page.nextCursor!]); void read(page.nextCursor!) }}>Next page</button>}
    </>}
    <button disabled={loading} onClick={revalidate}>Revalidate worktree</button>
    <p className="wo-footnote">A path can have both staged and unstaged changes. Counts describe local Git state, not agent activity.</p>
  </section>
}
