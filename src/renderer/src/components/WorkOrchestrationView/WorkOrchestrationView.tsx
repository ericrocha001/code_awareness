import React, { useCallback, useEffect, useRef, useState } from 'react'
import { GitBranch, RefreshCw, X } from 'lucide-react'
import type { ActiveProjectState } from '../../../../shared/types/active-project-types'
import type { ObservableWorktree, OrchestrationData, OrchestrationOverview, OrchestrationRequest, OrchestrationResult, WorktreePair } from '../../../../shared/types/work-orchestration-types'
import './WorkOrchestrationView.css'

const label = (w: ObservableWorktree) => w.branch ?? (w.head ? 'Detached HEAD' : 'No HEAD')
const pairLabel = { PATH_OVERLAP: 'Path overlap', NO_PATH_OVERLAP: 'No path overlap verified', INDETERMINATE: 'Indeterminate', STALE: 'Stale observation' }
export function orderWorktrees(worktrees: ObservableWorktree[]): ObservableWorktree[] {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
  return [...worktrees].sort((a, b) => Number(b.reference) - Number(a.reference) || compare(a.branch ?? a.path, b.branch ?? b.path) || compare(a.path, b.path) || compare(a.worktreeId, b.worktreeId))
}
type Selection = ObservableWorktree | WorktreePair | null
export function WorkOrchestrationView({ state }: { state: ActiveProjectState }) {
  const [overview, setOverview] = useState<OrchestrationOverview | null>(null)
  const repository = useRef<string | null>(null)
  const [selected, setSelected] = useState<Selection>(null), selection = useRef<Selection>(null)
  const [filter, setFilter] = useState(''), [compareWith, setCompareWith] = useState('')
  const [error, setError] = useState(''), [refreshing, setRefreshing] = useState(false), [reading, setReading] = useState(false)
  const [unvalidated, setUnvalidated] = useState(false)
  const epoch = useRef(0), intent = useRef(0), inspector = useRef<HTMLElement>(null), returnFocus = useRef<HTMLElement | null>(null)
  const alive = useRef(true), boundContext = useRef(`${state.project?.id}:${state.revision}`)
  const pending = useRef(new Map<string, Promise<OrchestrationResult<OrchestrationData>>>())
  const refreshPending = useRef<Promise<void> | null>(null)
  const projectId = state.project?.id, revision = state.revision
  const choose = (value: Selection) => { selection.current = value; setSelected(value) }
  const query = useCallback((extra: Pick<OrchestrationRequest, 'worktree' | 'pair'> = {}) => {
    const request = { context: { projectId: projectId!, revision }, ...extra }, key = JSON.stringify(request)
    const existing = pending.current.get(key)
    if (existing) return existing
    const promise = window.codeAwareness.getWorkOrchestration(request).finally(() => pending.current.delete(key))
    pending.current.set(key, promise)
    return promise
  }, [projectId, revision])
  const applyObservation = (data: OrchestrationData, append = false) => {
    if (data.repositoryId !== repository.current) throw new Error('REPOSITORY_CONTEXT_CHANGED')
    if ('worktree' in data) {
      const tree = data.worktree
      choose(tree)
      setOverview(previous => previous && { ...previous, worktrees: previous.worktrees.map(w => w.worktreeId === tree.worktreeId && w.generation === tree.generation ? tree : w) })
    } else if ('category' in data) {
      const old = selection.current
      choose(append && old && 'category' in old && old.revision === data.revision ? { ...data, paths: [...old.paths, ...data.paths] } : data)
      setOverview(previous => previous && { ...previous, worktrees: previous.worktrees.map(w => [data.left, data.right].find(side => side.worktreeId === w.worktreeId && side.generation === w.generation) ?? w),
        pairs: [...previous.pairs.filter(p => p.left.worktreeId !== data.left.worktreeId || p.right.worktreeId !== data.right.worktreeId), data], relationsCoverage: data.category === 'STALE' ? 'STALE' : 'PARTIAL' })
    } else throw new Error('Unexpected response')
  }
  const refresh = useCallback(() => {
    if (refreshPending.current || !projectId) return refreshPending.current
    const request = ++epoch.current, refreshIntent = ++intent.current, old = selection.current
    setReading(false); setRefreshing(true); setError('')
    const run = async () => {
      try {
        const result = await query()
        if (!alive.current || epoch.current !== request) return
        if (!result.success || !('worktrees' in result.data)) throw new Error(result.success ? 'Unexpected response' : result.code)
        const inventory = result.data
        if (repository.current && repository.current !== inventory.repositoryId) choose(null)
        repository.current = inventory.repositoryId; setOverview(inventory); setUnvalidated(false)
        setCompareWith(previous => inventory.worktrees.some(w => w.worktreeId === previous) ? previous : '')
        if (old && intent.current === refreshIntent) {
          const sides = 'category' in old ? [old.left, old.right] : [old]
          if (!sides.every(side => inventory.worktrees.some(w => w.worktreeId === side.worktreeId && w.generation === side.generation))) {
            choose(null); setCompareWith(''); setError('The selected worktree was removed or replaced.'); return
          }
          choose('category' in old ? { ...old, category: 'STALE', reason: 'REVALIDATING' } : inventory.worktrees.find(w => w.worktreeId === old.worktreeId)!)
          const observed = await query('category' in old ? { pair: { leftId: old.left.worktreeId, rightId: old.right.worktreeId } } : { worktree: { worktreeId: old.worktreeId } })
          if (!alive.current || epoch.current !== request || intent.current !== refreshIntent) return
          if (!observed.success) throw new Error(observed.code)
          applyObservation(observed.data)
        }
      } catch (failure) {
        if (alive.current && epoch.current === request) {
          setError(failure instanceof Error ? failure.message : 'Read unavailable'); setUnvalidated(true)
          setOverview(previous => previous && { ...previous, relationsCoverage: previous.pairs.length ? 'STALE' : 'NOT_EVALUATED',
            pairs: previous.pairs.map(pair => ({ ...pair, category: 'STALE', reason: 'REVALIDATION_FAILED', nextCursor: null })) })
          const previous = selection.current
          if (previous && 'category' in previous) choose({ ...previous, category: 'STALE', reason: 'REVALIDATION_FAILED', nextCursor: null })
        }
      } finally { if (alive.current && epoch.current === request) setRefreshing(false) }
    }
    const promise = run().finally(() => { if (refreshPending.current === promise) refreshPending.current = null })
    refreshPending.current = promise
    return promise
  }, [projectId, query])
  useEffect(() => {
    alive.current = true
    const context = `${projectId}:${revision}`
    if (boundContext.current !== context) {
      boundContext.current = context; epoch.current++; intent.current++; refreshPending.current = null
      repository.current = null; setOverview(null); choose(null); setFilter(''); setCompareWith(''); setUnvalidated(false)
    }
    void refresh()
    return () => { alive.current = false }
  }, [refresh])
  const focusKey = selected && ('category' in selected ? `${selected.left.worktreeId}:${selected.right.worktreeId}` : selected.worktreeId)
  useEffect(() => { if (selected) inspector.current?.focus() }, [focusKey])
  const close = () => { intent.current++; choose(null); setReading(false); setCompareWith(''); returnFocus.current?.focus() }
  const inspect = async (extra: Pick<OrchestrationRequest, 'worktree' | 'pair'>, tree?: ObservableWorktree) => {
    const request = ++intent.current, currentEpoch = epoch.current
    if (tree) { returnFocus.current = document.activeElement as HTMLElement; choose(tree); setCompareWith('') }
    setReading(true); setError('')
    try {
      const result = await query(extra)
      if (!alive.current || intent.current !== request || epoch.current !== currentEpoch) return
      if (!result.success) throw new Error(result.code)
      if (tree && (!('worktree' in result.data) || result.data.worktree.generation !== tree.generation)) throw new Error('WORKTREE_STALE')
      applyObservation(result.data, !!extra.pair?.cursor)
    } catch (failure) {
      if (alive.current && intent.current === request && epoch.current === currentEpoch) {
        const previous = selection.current, reason = failure instanceof Error ? failure.message : 'Read unavailable'
        if (previous && 'category' in previous) applyObservation({ ...previous, category: 'STALE', reason, nextCursor: null })
        else if (previous) applyObservation({ repositoryId: repository.current!, observedAt: new Date().toISOString(), worktree: { ...previous, observation: 'UNAVAILABLE', snapshot: null, reason } })
        setError(reason)
      }
    } finally { if (alive.current && intent.current === request && epoch.current === currentEpoch) setReading(false) }
  }
  const ordered = orderWorktrees(overview?.worktrees ?? [])
  const worktrees = ordered.filter(w => `${label(w)} ${w.path}`.toLowerCase().includes(filter.toLowerCase()))
  const signals = overview?.pairs.filter(p => p.category !== 'NO_PATH_OVERLAP') ?? []
  const pair = selected && 'category' in selected ? selected : null, tree = selected && 'worktreeId' in selected ? selected : null
  return <section className="wo-view" aria-label="Work Orchestration">
    <header className="wo-header"><div><h1><GitBranch size={20} /> Work Orchestration</h1><p>{state.project?.name ?? 'No active project'} · Worktree panorama</p></div><button onClick={() => void refresh()} disabled={refreshing || !projectId}><RefreshCw size={15} /> Refresh</button></header>
    {!projectId ? <p className="wo-empty">Select a project to discover its worktrees.</p> : <>
      <div className="wo-toolbar"><input aria-label="Filter worktrees" placeholder="Filter branch or path" value={filter} onChange={e => setFilter(e.target.value)} />{overview && <span>Inventory complete · {overview.worktrees.length} discovered</span>}</div>
      <p className="wo-notice wo-freshness" role="status">{refreshing ? overview ? 'Updating inventory · displaying the previous observation' : 'Discovering worktrees…' : overview ? `Last inventory observation · ${new Date(overview.observedAt).toLocaleString()}${unvalidated ? ' · Not revalidated' : ''}` : 'Inventory not available'}</p>
      {error && <p className="wo-notice wo-warning" role="alert">{error}</p>}
      {overview && <p className="wo-notice wo-relations">{overview.relationsCoverage === 'NOT_EVALUATED' ? 'Relationships not evaluated · Select a worktree to compare.' : overview.relationsCoverage === 'STALE' ? 'Relationships stale · Compare again to revalidate.' : 'Relationships partially evaluated · Only selected pairs have been compared.'}</p>}
      <div className="wo-workspace"><main className="wo-content">
        <div className="wo-section-heading"><h2>Worktrees</h2></div>
        {overview && !overview.worktrees.length && <p className="wo-empty">No registered worktrees.</p>}
        {overview && !!overview.worktrees.length && !worktrees.length && <p className="wo-empty">No matching worktrees.</p>}
        <div className="wo-trees">{worktrees.map(w => <button disabled={refreshing} className={`wo-tree ${w.reason || w.conflictCount || w.snapshot?.operation ? 'wo-exception' : ''}`} key={w.worktreeId} onClick={() => void inspect({ worktree: { worktreeId: w.worktreeId } }, w)} aria-pressed={tree?.worktreeId === w.worktreeId}>
          <span className="wo-tree-title">{label(w)} {w.reference && <span className="wo-badge">Main · reference</span>}</span><span className="wo-path" title={w.path}>{w.path}</span>
          <span className="wo-state">{w.observation === 'NOT_OBSERVED' ? w.reason ?? 'Status not observed' : w.reason ? `Unavailable · ${w.reason}` : w.conflictCount ? `${w.conflictCount} conflicted` : w.snapshot?.operation ?? (w.stagedCount || w.unstagedCount || w.untrackedCount ? `${w.stagedCount} staged · ${w.unstagedCount} unstaged · ${w.untrackedCount} untracked` : 'Locally clean · last observation')}</span>
        </button>)}</div>
        {!!signals.length && <><div className="wo-section-heading"><h2>Path signals</h2></div><div className="wo-pairs">{signals.map(p => <button disabled={refreshing} key={`${p.left.worktreeId}:${p.right.worktreeId}`} className="wo-pair wo-exception" onClick={() => { returnFocus.current = document.activeElement as HTMLElement; choose(p) }}><span>{label(p.left)} ↔ {label(p.right)}</span><strong>{pairLabel[p.category]}{p.category === 'PATH_OVERLAP' ? ` · ${p.totalPaths} paths` : ''}</strong></button>)}</div></>}
      </main>
      {selected && <aside className="wo-inspector" ref={inspector} tabIndex={-1} aria-label="Worktree inspector" onKeyDown={e => {
        if (e.key === 'Escape') close()
        if (e.key === 'Tab' && e.currentTarget.parentElement!.clientWidth <= 1000) {
          const controls = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), summary')], first = controls[0], last = controls[controls.length - 1]
          if (e.shiftKey && (document.activeElement === first || document.activeElement === e.currentTarget)) { e.preventDefault(); last?.focus() }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
        }
      }}><div className="wo-section-heading"><h2>{pair ? 'Pair evidence' : 'Worktree detail'}</h2><button aria-label="Close inspector" onClick={close}><X size={16} /></button></div>
        {reading && <p role="status">Reading selected work…</p>}{unvalidated && <p className="wo-warning">Previous observation · not revalidated</p>}
        {tree && <><h3>{label(tree)}</h3><p>{tree.reason ?? (tree.observation === 'NOT_OBSERVED' ? 'Status not observed' : 'Last status observation')}</p><dl><dt>Path</dt><dd>{tree.path}</dd><dt>HEAD</dt><dd>{tree.head ?? 'Unavailable'}</dd><dt>Local changes</dt><dd>{tree.observation === 'VERIFIED' ? `${tree.stagedCount} staged · ${tree.unstagedCount} unstaged · ${tree.untrackedCount} untracked · ${tree.conflictCount} conflicted` : 'Not verified'}</dd></dl>
          <div className="wo-context-compare"><label>Compare with…<select aria-label="Compare with worktree" value={compareWith} onChange={e => setCompareWith(e.target.value)}><option value="">Choose another worktree</option>{ordered.filter(w => w.worktreeId !== tree.worktreeId).map(w => <option key={w.worktreeId} value={w.worktreeId}>{label(w)} · {w.path}</option>)}</select></label><button disabled={reading || refreshing || !compareWith} onClick={() => void inspect({ pair: { leftId: tree.worktreeId, rightId: compareWith } })}>Compare</button></div>
          <details><summary>Worktree identity</summary><dl><dt>Repository / worktree</dt><dd>{overview?.repositoryId} / {tree.worktreeId}</dd><dt>Generation</dt><dd>{tree.generation}</dd></dl></details></>}
        {pair && <><h3>{pairLabel[pair.category]}</h3><p>{pair.reason ?? `${pair.totalPaths} common ${pair.totalPaths === 1 ? 'path' : 'paths'} verified`}</p><dl><dt>Pair merge-base</dt><dd>{pair.base ?? 'Unavailable'}</dd><dt>Left</dt><dd>{label(pair.left)}</dd><dt>Right</dt><dd>{label(pair.right)}</dd></dl><ul className="wo-paths" aria-label="Common paths">{pair.paths.map(path => <li key={path}>{path}</li>)}</ul>
          {pair.nextCursor && <button disabled={reading || refreshing} onClick={() => void inspect({ pair: { leftId: pair.left.worktreeId, rightId: pair.right.worktreeId, cursor: pair.nextCursor! } })}>More paths ({pair.paths.length}/{pair.totalPaths})</button>}
          <button disabled={reading || refreshing} onClick={() => void inspect({ pair: { leftId: pair.left.worktreeId, rightId: pair.right.worktreeId } })}>Revalidate pair</button><details><summary>Observation identities and revisions</summary><dl><dt>Repository</dt><dd>{pair.repositoryId}</dd>{[pair.left, pair.right].map((w, i) => <React.Fragment key={w.worktreeId}><dt>{i ? 'Right' : 'Left'}</dt><dd>{w.path}<br />Worktree ID: {w.worktreeId}<br />HEAD: {w.snapshot?.head ?? 'Unavailable'}<br />Generation: {w.generation}<br />Index: {w.snapshot?.indexRevision ?? 'Unavailable'}<br />Worktree: {w.snapshot?.worktreeRevision ?? 'Unavailable'}</dd></React.Fragment>)}</dl></details><p className="wo-footnote">Same paths indicate overlapping changes, not merge conflicts or merge order. Local revision uses status and file metadata; no global atomic snapshot.</p></>}
      </aside>}
      </div></>}
  </section>
}
