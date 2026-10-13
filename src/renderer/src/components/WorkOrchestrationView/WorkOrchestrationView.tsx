import React, { useCallback, useEffect, useRef, useState } from 'react'
import { GitBranch, RefreshCw, X } from 'lucide-react'
import type { ActiveProjectState } from '../../../../shared/types/active-project-types'
import type { ObservableWorktree, OrchestrationOverview, WorktreePair } from '../../../../shared/types/work-orchestration-types'
import './WorkOrchestrationView.css'

const label = (w: ObservableWorktree) => w.branch ?? (w.head ? 'Detached HEAD' : 'No HEAD')
const pairLabel = { PATH_OVERLAP: 'Path overlap', NO_PATH_OVERLAP: 'No path overlap verified', INDETERMINATE: 'Indeterminate', STALE: 'Stale observation' }
export function WorkOrchestrationView({ state, navigateGit }: { state: ActiveProjectState; navigateGit: () => void }) {
  const [overview, setOverview] = useState<OrchestrationOverview | null>(null)
  const [selected, setSelected] = useState<ObservableWorktree | WorktreePair | null>(null)
  const [filter, setFilter] = useState('')
  const [leftId, setLeftId] = useState(''), [rightId, setRightId] = useState('')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const generation = useRef(0), inspector = useRef<HTMLElement>(null), returnFocus = useRef<HTMLElement | null>(null)
  const projectId = state.project?.id
  const revision = state.revision
  const refresh = useCallback(async () => {
    const request = ++generation.current
    setSelected(null); setOverview(null); setLeftId(''); setRightId(''); setError('')
    if (!projectId) { setBusy(false); return }
    setBusy(true)
    try {
      const result = await window.codeAwareness.getWorkOrchestration({ context: { projectId, revision } })
      if (generation.current !== request) return
      if (result.success && 'worktrees' in result.data) setOverview(result.data)
      else setError(result.success ? 'Unexpected response' : result.code)
    } catch { if (generation.current === request) setError('Read unavailable. Refresh to try again.') }
    finally { if (generation.current === request) setBusy(false) }
  }, [projectId, revision])
  useEffect(() => { setFilter(''); void refresh(); return () => { generation.current++ } }, [refresh])
  useEffect(() => { if (selected) inspector.current?.focus() }, [selected])
  const select = (value: ObservableWorktree | WorktreePair) => {
    returnFocus.current = document.activeElement as HTMLElement
    setSelected(value)
  }
  const close = () => { setSelected(null); returnFocus.current?.focus() }
  const compare = async (left: string, right: string, cursor?: string) => {
    if (!projectId) return
    const request = ++generation.current
    if (!cursor) { returnFocus.current = document.activeElement as HTMLElement; setSelected(null) }
    setBusy(true); setError('')
    try {
      const result = await window.codeAwareness.getWorkOrchestration({ context: { projectId, revision }, pair: { leftId: left, rightId: right, cursor } })
      if (generation.current !== request) return
      if (result.success && 'category' in result.data) {
        const pair = result.data
        setSelected(previous => cursor && previous && 'category' in previous && previous.revision === pair.revision
          ? { ...pair, paths: [...previous.paths, ...pair.paths] } : pair)
      } else { setSelected(null); setError(result.success ? 'Unexpected response' : result.code) }
    } catch { if (generation.current === request) { setSelected(null); setError('Pair read unavailable. Refresh to try again.') } }
    finally { if (generation.current === request) setBusy(false) }
  }
  const worktrees = overview?.worktrees.filter(w => `${label(w)} ${w.path}`.toLowerCase().includes(filter.toLowerCase())) ?? []
  const pair = selected && 'category' in selected ? selected : null
  const tree = selected && 'worktreeId' in selected ? selected : null
  return <section className="wo-view" aria-label="Work Orchestration">
    <header className="wo-header"><div><h1><GitBranch size={20} /> Work Orchestration</h1><p>{state.project?.name ?? 'No active project'} · Worktree panorama</p></div>
      <button onClick={() => void refresh()} disabled={busy || !projectId}><RefreshCw size={15} /> Refresh</button></header>
    {!projectId ? <p className="wo-empty">Select a project to discover its worktrees.</p> : <>
      <div className="wo-toolbar"><input aria-label="Filter worktrees" placeholder="Filter branch or path" value={filter} onChange={e => setFilter(e.target.value)} />
        <button onClick={navigateGit}>Open Git Management</button></div>
      {busy && <p className="wo-notice" role="status">Reading worktrees…</p>}
      {error && <p className="wo-notice wo-warning" role="alert">{error}</p>}
      {overview?.coverage === 'PARTIAL' && <p className="wo-notice wo-warning">Partial coverage · {overview.reason === 'PAIR_BUDGET_EXCEEDED' ? 'Automatic comparison is limited to 12 eligible worktrees. Select two worktrees to compare.' : 'Some observations are unavailable or stale. Refresh to revalidate.'}</p>}
      <div className="wo-workspace"><main className="wo-content">
        <div className="wo-section-heading"><h2>Worktrees</h2><span>{overview?.worktrees.length ?? '—'} discovered</span></div>
        {overview && !overview.worktrees.length && <p className="wo-empty">No registered worktrees.</p>}
        {overview && !!overview.worktrees.length && !worktrees.length && <p className="wo-empty">No matching worktrees.</p>}
        <div className="wo-trees">{worktrees.map(w => <button className={`wo-tree ${w.reason || w.conflictCount || w.snapshot?.operation ? 'wo-exception' : ''}`} key={w.worktreeId} onClick={() => select(w)} aria-pressed={tree?.worktreeId === w.worktreeId}>
          <span className="wo-tree-title">{label(w)} {w.reference && <span className="wo-badge">Main · reference</span>}</span>
          <span className="wo-path" title={w.path}>{w.path}</span>
          <span className="wo-state">{w.reason ? `Unavailable · ${w.reason}` : w.conflictCount ? `${w.conflictCount} conflicted` : w.snapshot?.operation ? w.snapshot.operation : w.stagedCount + w.unstagedCount + w.untrackedCount ? `${w.stagedCount} staged · ${w.unstagedCount} unstaged · ${w.untrackedCount} untracked` : 'Locally clean'}</span>
        </button>)}</div>
        <div className="wo-section-heading"><h2>Path relationships</h2><span>Secondary worktrees</span></div>
        {overview && overview.coverage === 'COMPLETE' && !overview.pairs.length && <p className="wo-empty">No secondary pairs to compare.</p>}
        <div className="wo-pairs">{overview?.pairs.map(p => <button key={`${p.left.worktreeId}:${p.right.worktreeId}`} className={`wo-pair ${p.category === 'PATH_OVERLAP' ? 'wo-exception' : ''}`} onClick={() => select(p)}>
          <span>{label(p.left)} ↔ {label(p.right)}</span><strong>{pairLabel[p.category]}{p.category === 'PATH_OVERLAP' ? ` · ${p.totalPaths} paths` : ''}</strong>
        </button>)}</div>
        {overview && overview.worktrees.length > 1 && <div className="wo-compare"><label>Compare a pair<select aria-label="First worktree" value={leftId} onChange={e => setLeftId(e.target.value)}><option value="">First worktree</option>{overview.worktrees.map(w => <option key={w.worktreeId} value={w.worktreeId}>{label(w)} · {w.path}</option>)}</select></label>
          <select aria-label="Second worktree" value={rightId} onChange={e => setRightId(e.target.value)}><option value="">Second worktree</option>{overview.worktrees.map(w => <option key={w.worktreeId} value={w.worktreeId}>{label(w)} · {w.path}</option>)}</select>
          <button disabled={busy || !leftId || !rightId || leftId === rightId} onClick={() => void compare(leftId, rightId)}>Compare</button></div>}
        <p className="wo-footnote">Same paths indicate overlapping changes, not merge conflicts or a recommended merge order. Main checkout is a reference.</p>
      </main>
      {selected && <aside className="wo-inspector" ref={inspector} tabIndex={-1} aria-label="Worktree inspector" onKeyDown={e => {
        if (e.key === 'Escape') close()
        if (e.key === 'Tab' && e.currentTarget.parentElement!.clientWidth <= 1000) {
          const controls = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), summary, [tabindex="0"]')]
          const first = controls[0], last = controls[controls.length - 1]
          if (e.shiftKey && (document.activeElement === first || document.activeElement === e.currentTarget)) { e.preventDefault(); last?.focus() }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
        }
      }}>
        <div className="wo-section-heading"><h2>{pair ? 'Pair evidence' : 'Worktree detail'}</h2><button aria-label="Close inspector" onClick={close}><X size={16} /></button></div>
        {tree && <><h3>{label(tree)}</h3><dl><dt>Identity</dt><dd>{overview?.repositoryId} / {tree.worktreeId}</dd><dt>Generation</dt><dd>{tree.generation}</dd><dt>Path</dt><dd>{tree.path}</dd><dt>HEAD</dt><dd>{tree.head ?? 'Unavailable'}</dd><dt>Local changes</dt><dd>{tree.stagedCount} staged · {tree.unstagedCount} unstaged · {tree.untrackedCount} untracked · {tree.conflictCount} conflicted</dd><dt>Observation</dt><dd>{tree.reason ?? 'Verified at refresh'}</dd></dl><button onClick={navigateGit}>Inspect in Git Management</button></>}
        {pair && <><h3>{pairLabel[pair.category]}</h3><p>{pair.reason ?? `${pair.totalPaths} common ${pair.totalPaths === 1 ? 'path' : 'paths'} verified`}</p>
          <dl><dt>Pair merge-base</dt><dd title={pair.base ?? undefined}>{pair.base ?? 'Unavailable'}</dd><dt>Left</dt><dd>{label(pair.left)}</dd><dt>Right</dt><dd>{label(pair.right)}</dd></dl>
          <ul className="wo-paths" aria-label="Common paths">{pair.paths.map(path => <li key={path}>{path}</li>)}</ul>
          {pair.nextCursor && <button disabled={busy} onClick={() => void compare(pair.left.worktreeId, pair.right.worktreeId, pair.nextCursor!)}>More paths ({pair.paths.length}/{pair.totalPaths})</button>}
          <details><summary>Observation identities and revisions</summary><dl><dt>Repository</dt><dd>{pair.repositoryId}</dd>{[pair.left, pair.right].map((w, i) => <React.Fragment key={w.worktreeId}><dt>{i ? 'Right' : 'Left'} · {label(w)}</dt><dd>{w.path}<br />Worktree ID: {w.worktreeId}<br />HEAD: {w.snapshot?.head ?? 'Unavailable'}<br />Generation: {w.generation}<br />Index: {w.snapshot?.indexRevision ?? 'Unavailable'}<br />Worktree: {w.snapshot?.worktreeRevision ?? 'Unavailable'}</dd></React.Fragment>)}</dl></details>
          <p className="wo-footnote">Local revision uses Git status and file metadata. Observations are revalidated; no global atomic snapshot is claimed.</p></>}
      </aside>}
      </div>
    </>}
  </section>
}
