import React, { useCallback, useEffect, useRef, useState } from 'react'
import { GitBranch, RefreshCw, X } from 'lucide-react'
import type { ActiveProjectState } from '../../../../shared/types/active-project-types'
import type { ObservableWorktree, OrchestrationData, OrchestrationOverview, OrchestrationRequest, OrchestrationResult, WorktreePair } from '../../../../shared/types/work-orchestration-types'
import './WorkOrchestrationView.css'
import { LocalChangesInspector } from './LocalChangesInspector'
import { WorktreeDocumentContext } from './WorktreeDocumentContext'
import { categoryLabel, reasonLabel } from './work-orchestration-labels'
import type { LocalChangeCategory } from '../../../../shared/types/local-change-types'
import type { OrchestrationAttention, StructuralAlert } from '../../../../shared/types/work-orchestration-attention-types'
import { StructuralEvidence } from './StructuralEvidence'
import { OperationalRecommendation } from './OperationalRecommendation'

const label = (w: ObservableWorktree) => w.branch ?? (w.head ? 'Detached HEAD' : 'Sem HEAD')
const pairLabel = { PATH_OVERLAP: 'Sobreposição de caminhos', NO_PATH_OVERLAP: 'Nenhuma sobreposição de caminhos verificada', INDETERMINATE: 'Indeterminado', STALE: 'Observação obsoleta' }
const phaseLabel = { NOT_OBSERVED: 'Não observado', LAST_KNOWN: 'Último estado conhecido', REVALIDATING: 'Revalidando', VERIFIED: 'Observação verificada', UNAVAILABLE: 'Indisponível', STALE: 'Observação obsoleta' }
const createdTime = (w: ObservableWorktree) => w.creation?.quality === 'ESTIMATED' && w.creation.source && w.creation.at && Number.isFinite(Date.parse(w.creation.at)) ? Date.parse(w.creation.at) : 0
const dateGroup = (w: ObservableWorktree) => w.reference ? 'Referência principal' : createdTime(w) ? `Criação estimada · ${new Date(createdTime(w)).toLocaleDateString('pt-BR')}` : 'Data indisponível'
export function orderWorktrees(worktrees: ObservableWorktree[]): ObservableWorktree[] {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
  return [...worktrees].sort((a, b) => Number(b.reference) - Number(a.reference) || createdTime(b) - createdTime(a) || compare(a.path, b.path) || compare(a.worktreeId, b.worktreeId))
}
type Selection = ObservableWorktree | WorktreePair | null
export function WorkOrchestrationView({ state, active = true, attention }: { state: ActiveProjectState; active?: boolean; attention?: OrchestrationAttention | null }) {
  const [overview, setOverview] = useState<OrchestrationOverview | null>(null)
  const repository = useRef<string | null>(null)
  const [selected, setSelected] = useState<Selection>(null), selection = useRef<Selection>(null)
  const [filter, setFilter] = useState(''), [compareWith, setCompareWith] = useState('')
  const [error, setError] = useState(''), [refreshing, setRefreshing] = useState(false), [reading, setReading] = useState(false)
  const [selectedAlert, setSelectedAlert] = useState<string | null>(null)
  const [revealedWorktree, setRevealedWorktree] = useState<string | null>(null)
  const [unvalidated, setUnvalidated] = useState(false)
  const epoch = useRef(0), intent = useRef(0), inspector = useRef<HTMLElement>(null), returnFocus = useRef<HTMLElement | null>(null)
  const alive = useRef(true), boundContext = useRef(`${state.project?.id}:${state.revision}`)
  const pending = useRef(new Map<string, Promise<OrchestrationResult<OrchestrationData>>>())
  const refreshPending = useRef<Promise<void> | null>(null)
  const projectId = state.project?.id, revision = state.revision
  const content = useRef<HTMLElement>(null), activeNow = useRef(active)
  const automaticReads = useRef(0), attempted = useRef(new Set<string>())
  const resumeVisible = useRef<() => void>(() => {})
  activeNow.current = active
  const choose = (value: Selection) => { selection.current = value; setSelected(value) }
  const query = useCallback((extra: Pick<OrchestrationRequest, 'worktree' | 'pair' | 'changes' | 'documents'> = {}) => {
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
    } else throw new Error('Resposta inesperada')
  }
  const refresh = useCallback(() => {
    if (refreshPending.current || !projectId) return refreshPending.current
    const request = ++epoch.current, refreshIntent = ++intent.current, old = selection.current
    attempted.current.clear()
    setReading(false); setRefreshing(true); setError('')
    const run = async () => {
      try {
        const result = await query()
        if (!alive.current || epoch.current !== request) return
        if (!result.success || !('worktrees' in result.data)) throw new Error(result.success ? 'Resposta inesperada' : result.code)
        const inventory = result.data
        if (repository.current && repository.current !== inventory.repositoryId) choose(null)
        repository.current = inventory.repositoryId; setOverview(inventory); setUnvalidated(false)
        setCompareWith(previous => inventory.worktrees.some(w => w.worktreeId === previous) ? previous : '')
        if (old && intent.current === refreshIntent) {
          const sides = 'category' in old ? [old.left, old.right] : [old]
          if (!sides.every(side => inventory.worktrees.some(w => w.worktreeId === side.worktreeId && w.generation === side.generation))) {
            choose(null); setCompareWith(''); setError('A worktree selecionada foi removida ou substituída.'); return
          }
          choose('category' in old ? { ...old, category: 'STALE', reason: 'REVALIDATING' } : inventory.worktrees.find(w => w.worktreeId === old.worktreeId)!)
          const observed = await query('category' in old ? { pair: { leftId: old.left.worktreeId, rightId: old.right.worktreeId } } : { worktree: { worktreeId: old.worktreeId } })
          if (!alive.current || epoch.current !== request || intent.current !== refreshIntent) return
          if (!observed.success) throw new Error(observed.code)
          applyObservation(observed.data)
        }
      } catch (failure) {
        if (alive.current && epoch.current === request) {
          setError(failure instanceof Error ? failure.message : 'Leitura indisponível'); setUnvalidated(true)
          setOverview(previous => previous && { ...previous, relationsCoverage: previous.pairs.length ? 'STALE' : 'NOT_EVALUATED',
            worktrees: previous.worktrees.map(tree => tree.snapshot ? { ...tree, observation: 'STALE' } : tree),
            pairs: previous.pairs.map(pair => ({ ...pair, category: 'STALE', reason: 'REVALIDATION_FAILED', nextCursor: null })) })
          const previous = selection.current
          if (previous && 'category' in previous) choose({ ...previous, category: 'STALE', reason: 'REVALIDATION_FAILED', nextCursor: null })
          else if (previous) choose({ ...previous, observation: 'STALE', reason: 'REVALIDATION_FAILED' })
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
  useEffect(() => {
    if (!active) {
      setOverview(previous => previous && { ...previous, worktrees: previous.worktrees.map(tree => tree.observation === 'VERIFIED' ? { ...tree, observation: 'LAST_KNOWN' } : tree) })
      const old = selection.current
      if (old && 'worktreeId' in old && old.observation === 'VERIFIED') choose({ ...old, observation: 'LAST_KNOWN' })
    }
  }, [active])
  useEffect(() => {
    if (!active || refreshing || reading || !overview || typeof IntersectionObserver === 'undefined') return
    let stopped = false
    const queue = new Set<string>(), currentEpoch = epoch.current
    const pump = () => {
      while (!stopped && activeNow.current && automaticReads.current < 2 && queue.size) {
        const id = queue.values().next().value!
        queue.delete(id)
        const candidate = overview.worktrees.find(tree => tree.worktreeId === id && tree.observation === 'NOT_OBSERVED')
        if (!candidate || attempted.current.has(id)) continue
        attempted.current.add(id); automaticReads.current++
        setOverview(previous => previous && { ...previous, worktrees: previous.worktrees.map(tree => tree.worktreeId === id ? { ...tree, observation: 'REVALIDATING' } : tree) })
        void query({ worktree: { worktreeId: id } }).then(result => {
          if (!alive.current || epoch.current !== currentEpoch) return
          if (!result.success || !('worktree' in result.data) || result.data.repositoryId !== repository.current || result.data.worktree.generation !== candidate.generation) {
            setOverview(previous => previous && { ...previous, worktrees: previous.worktrees.map(tree => tree.worktreeId === id ? { ...tree, observation: 'UNAVAILABLE', reason: result.success ? 'WORKTREE_STALE' : result.code } : tree) })
            return
          }
          const observed = result.data.worktree
          setOverview(previous => previous && { ...previous, worktrees: previous.worktrees.map(tree => tree.worktreeId === id && tree.generation === observed.generation ? { ...observed, observation: activeNow.current ? observed.observation : 'LAST_KNOWN' } : tree) })
        }).catch(() => {
          if (alive.current && epoch.current === currentEpoch) setOverview(previous => previous && { ...previous, worktrees: previous.worktrees.map(tree => tree.worktreeId === id ? { ...tree, observation: 'UNAVAILABLE', reason: 'GIT_READ_UNAVAILABLE' } : tree) })
        }).finally(() => { automaticReads.current--; resumeVisible.current() })
      }
    }
    resumeVisible.current = pump
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.worktreeId!
        if (entry.isIntersecting) queue.add(id); else queue.delete(id)
      }
      pump()
    }, { root: content.current })
    content.current?.querySelectorAll('[data-worktree-id]').forEach(element => observer.observe(element))
    return () => { stopped = true; observer.disconnect(); if (resumeVisible.current === pump) resumeVisible.current = () => {} }
  }, [active, refreshing, reading, overview?.revision, filter, query])
  const focusKey = selected && ('category' in selected ? `${selected.left.worktreeId}:${selected.right.worktreeId}` : selected.worktreeId)
  useEffect(() => { if (selected) inspector.current?.focus() }, [focusKey])
  const close = () => { intent.current++; choose(null); setRevealedWorktree(null); setReading(false); setCompareWith(''); returnFocus.current?.focus() }
  const inspect = async (extra: Pick<OrchestrationRequest, 'worktree' | 'pair'>, tree?: ObservableWorktree) => {
    const request = ++intent.current, currentEpoch = epoch.current
    if (tree) { const row = document.activeElement?.closest<HTMLElement>('.wo-tree'); if (row) returnFocus.current = row; choose({ ...tree, observation: 'REVALIDATING' }); setCompareWith('') }
    setReading(true); setError('')
    try {
      const result = await query(extra)
      if (!alive.current || intent.current !== request || epoch.current !== currentEpoch) return
      if (!result.success) throw new Error(result.code)
      if (tree && (!('worktree' in result.data) || result.data.worktree.generation !== tree.generation)) throw new Error('WORKTREE_STALE')
      applyObservation(result.data, !!extra.pair?.cursor)
    } catch (failure) {
      if (alive.current && intent.current === request && epoch.current === currentEpoch) {
        const previous = selection.current, reason = failure instanceof Error ? failure.message : 'Leitura indisponível'
        if (previous && 'category' in previous) applyObservation({ ...previous, category: 'STALE', reason, nextCursor: null })
        else if (previous) applyObservation({ repositoryId: repository.current!, observedAt: new Date().toISOString(), worktree: { ...previous, observation: 'UNAVAILABLE', snapshot: null, reason } })
        setError(reason)
      }
    } finally { if (alive.current && intent.current === request && epoch.current === currentEpoch) setReading(false) }
  }
  const ordered = orderWorktrees(overview?.worktrees ?? [])
  const matchesFilter = (w: ObservableWorktree) => `${label(w)} ${w.path}`.toLowerCase().includes(filter.toLowerCase())
  const worktrees = ordered.filter(w => matchesFilter(w) || w.worktreeId === revealedWorktree)
  const signals = overview?.pairs.filter(p => p.category !== 'NO_PATH_OVERLAP') ?? []
  const structuralAlert = attention?.alerts.find(a => a.id === selectedAlert)
  const showEvidence = (alert: StructuralAlert) => {
    const worktree = overview?.worktrees.find(w => w.worktreeId === alert.consumer && w.generation === alert.consumerGeneration)
    if (!worktree) { setError('WORKTREE_NOT_DISCOVERED'); return }
    const outsideFilter = !matchesFilter(worktree)
    setRevealedWorktree(worktree.worktreeId); setSelectedAlert(alert.id); choose(worktree)
    requestAnimationFrame(() => { const row = content.current?.querySelector<HTMLElement>(`[data-worktree-id="${worktree.worktreeId}"]`); row?.scrollIntoView?.({ block: 'nearest' }); returnFocus.current = outsideFilter ? document.querySelector<HTMLInputElement>('[aria-label="Filtrar worktrees"]') : row ?? null })
  }
  const pair = selected && 'category' in selected ? selected : null, tree = selected && 'worktreeId' in selected ? selected : null
  return <section className="wo-view" aria-label="Work Orchestration">
    <header className="wo-header"><div><h1><GitBranch size={20} /> Work Orchestration</h1><p>{state.project?.name ?? 'Nenhum projeto ativo'} · Panorama de worktrees</p></div><button onClick={() => void refresh()} disabled={refreshing || !projectId}><RefreshCw size={15} /> Atualizar</button></header>
    {!projectId ? <p className="wo-empty">Selecione um projeto para descobrir suas worktrees.</p> : <>
      <div className="wo-toolbar"><input aria-label="Filtrar worktrees" placeholder="Filtrar por branch ou caminho" value={filter} onChange={e => { setRevealedWorktree(null); setFilter(e.target.value) }} />{overview && <span>Inventário completo · {overview.worktrees.length} {overview.worktrees.length === 1 ? 'descoberta' : 'descobertas'}</span>}</div>
      {revealedWorktree && filter && <p className="wo-notice">Worktree do alerta incluída na Timeline · filtro preservado.</p>}
      <p className="wo-notice wo-freshness" role="status">{refreshing ? overview ? 'Atualizando inventário · exibindo a observação anterior' : 'Descobrindo worktrees…' : overview ? `Última observação do inventário · ${new Date(overview.observedAt).toLocaleString('pt-BR')}${unvalidated ? ' · Não revalidado' : ''}` : 'Inventário indisponível'}</p>
      {error && <p className="wo-notice wo-warning" role="alert">{reasonLabel(error)}</p>}
      {overview && <p className="wo-notice wo-relations">{overview.relationsCoverage === 'NOT_EVALUATED' ? 'Relações não avaliadas · Selecione uma worktree para comparar.' : overview.relationsCoverage === 'STALE' ? 'Relações obsoletas · Compare novamente para revalidar.' : 'Relações parcialmente avaliadas · Somente os pares selecionados foram comparados.'}</p>}
      {attention && <section className="wo-attention" aria-label="Atenção necessária"><h2>Atenção necessária</h2>
        <p>Cobertura {attention.coverage === 'UNAVAILABLE' ? 'indisponível' : attention.coverage === 'PENDING' ? 'pendente' : 'parcial'} · {attention.observed}/{attention.known} worktrees observadas{attention.paused ? ' · reconciliação suspensa' : ` · intervalo mínimo ${Math.ceil(attention.cadenceMs / 1000)} s`}. Ausência de alerta não comprova segurança.</p>
        <p>Escopo seletivo TypeScript/JavaScript: declarações exportadas e ligações relativas diretas resolvidas. Reexport, aliases e escopo não observado permanecem incertos.</p>
        {attention.alerts.map(alert => <div key={alert.id} className="wo-attention-item"><div><strong>Possível interferência de contrato{alert.state === 'STALE' ? ' · obsoleta' : ''}</strong><OperationalRecommendation recommendation={alert.recommendation} provider={overview?.worktrees.find(w => w.worktreeId === alert.provider)?.branch ?? 'worktree do contrato'} consumer={overview?.worktrees.find(w => w.worktreeId === alert.consumer)?.branch ?? 'worktree consumidora'} /></div><button onClick={() => showEvidence(alert)}>Ver evidência</button></div>)}
        {!attention.alerts.length && <p>Nenhum alerta confirmado nesta cobertura.</p>}
        {!!attention.pending.length && <details><summary>{attention.pending.length} worktrees com observação ou investigação pendente</summary><ul className="wo-paths">{attention.pending.map(p => <li key={p.worktreeId}>{overview?.worktrees.find(w => w.worktreeId === p.worktreeId)?.branch ?? p.worktreeId} · {p.reason}</li>)}</ul></details>}
      </section>}
      <div className="wo-workspace"><main className="wo-content" ref={content}>
        <div className="wo-section-heading"><h2>Worktrees</h2></div>
        <p className="wo-timeline-notice">Timeline por criação estimada · principal como referência · datas desconhecidas ao final. Alterações Git não reordenam as worktrees.</p>
        {overview && !overview.worktrees.length && <p className="wo-empty">Nenhuma worktree registrada.</p>}
        {overview && !!overview.worktrees.length && !worktrees.length && <p className="wo-empty">Nenhuma worktree encontrada.</p>}
        <div className="wo-trees">{worktrees.map((w, i) => <React.Fragment key={w.worktreeId}>{(i === 0 || dateGroup(w) !== dateGroup(worktrees[i - 1])) && <h3 className="wo-date-group">{dateGroup(w)}</h3>}<button data-worktree-id={w.worktreeId} disabled={refreshing} className={`wo-tree ${w.reason || w.conflictCount || w.snapshot?.operation ? 'wo-exception' : ''}`} onClick={() => void inspect({ worktree: { worktreeId: w.worktreeId } }, w)} aria-pressed={tree?.worktreeId === w.worktreeId}>
          <span className="wo-tree-title">{label(w)} {w.reference && <span className="wo-badge">Principal · referência</span>}</span><span className="wo-path" title={w.path}>{w.path}</span>
          <span className="wo-created">{w.reference ? 'Checkout principal · referência' : createdTime(w) ? `Criação estimada: ${new Date(createdTime(w)).toLocaleString('pt-BR')}` : 'Data indisponível'}</span>
          <span className="wo-state">{w.observation === 'NOT_OBSERVED' ? w.reason ? reasonLabel(w.reason) : 'Estado não observado' : w.observation === 'REVALIDATING' ? 'Revalidando…' : w.reason ? `${phaseLabel[w.observation]} · ${reasonLabel(w.reason)}` : `${phaseLabel[w.observation]} · ${w.localChanges ? w.localChanges.total ? `${w.localChanges.total} ${w.localChanges.total === 1 ? 'caminho local' : 'caminhos locais'} · ${Object.entries(w.localChanges.categories).filter(([, count]) => count).map(([category, count]) => `${count} ${categoryLabel(category as LocalChangeCategory, count)}`).join(' · ')}` : 'Sem alterações locais' : `${w.stagedCount} staged · ${w.unstagedCount} unstaged · ${w.untrackedCount} não rastreados`}`}</span>
        </button></React.Fragment>)}</div>
        {!!signals.length && <><div className="wo-section-heading"><h2>Sinais de caminhos</h2></div><div className="wo-pairs">{signals.map(p => <button disabled={refreshing} key={`${p.left.worktreeId}:${p.right.worktreeId}`} className="wo-pair wo-exception" onClick={() => { returnFocus.current = document.activeElement as HTMLElement; choose(p) }}><span>{label(p.left)} ↔ {label(p.right)}</span><strong>{pairLabel[p.category]}{p.category === 'PATH_OVERLAP' ? ` · ${p.totalPaths} ${p.totalPaths === 1 ? 'caminho' : 'caminhos'}` : ''}</strong></button>)}</div></>}
      </main>
      {selected && <aside className="wo-inspector" ref={inspector} tabIndex={-1} aria-label="Inspetor de worktree" onKeyDown={e => {
        if (e.key === 'Escape') close()
        if (e.key === 'Tab' && e.currentTarget.parentElement!.clientWidth <= 1000) {
          const controls = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary')], first = controls[0], last = controls[controls.length - 1]
          if (e.shiftKey && (document.activeElement === first || document.activeElement === e.currentTarget)) { e.preventDefault(); last?.focus() }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
        }
      }}><div className="wo-section-heading"><h2>{pair ? 'Evidências do par' : 'Detalhes da worktree'}</h2><button aria-label="Fechar inspetor" onClick={close}><X size={16} /></button></div>
        {reading && <p role="status">Lendo a worktree selecionada…</p>}{unvalidated && <p className="wo-warning">Observação anterior · não revalidada</p>}
        {structuralAlert && tree?.worktreeId === structuralAlert.consumer && <StructuralEvidence alert={structuralAlert} providerName={label(overview?.worktrees.find(w => w.worktreeId === structuralAlert.provider) ?? tree)} consumerName={label(tree)} />}
        {tree && <><h3>{label(tree)}</h3><p>{tree.reason ? reasonLabel(tree.reason) : (tree.observation === 'NOT_OBSERVED' ? 'Estado não observado' : 'Última observação do estado')}</p><dl><dt>Caminho</dt><dd>{tree.path}</dd><dt>HEAD</dt><dd>{tree.head ?? 'Indisponível'}</dd><dt>Alterações locais</dt><dd>{tree.observation === 'VERIFIED' ? `${tree.stagedCount} staged · ${tree.unstagedCount} unstaged · ${tree.untrackedCount} não rastreados · ${tree.conflictCount} em conflito` : 'Não verificado'}</dd></dl>
          <div className="wo-context-compare"><label>Comparar com…<select aria-label="Comparar com outra worktree" value={compareWith} onChange={e => setCompareWith(e.target.value)}><option value="">Escolha outra worktree</option>{ordered.filter(w => w.worktreeId !== tree.worktreeId).map(w => <option key={w.worktreeId} value={w.worktreeId}>{label(w)} · {w.path}</option>)}</select></label><button disabled={reading || refreshing || !compareWith} onClick={() => void inspect({ pair: { leftId: tree.worktreeId, rightId: compareWith } })}>Comparar</button></div>
          <details><summary>Identidade da worktree</summary><dl><dt>Repositório / worktree</dt><dd>{overview?.repositoryId} / {tree.worktreeId}</dd><dt>Geração</dt><dd>{tree.generation}</dd></dl></details></>}
        {tree && <WorktreeDocumentContext key={`documents:${tree.worktreeId}:${tree.generation}`} tree={tree} query={query} />}
        {tree && <><p>{tree.observedAt ? `Observado em ${new Date(tree.observedAt).toLocaleString('pt-BR')} · ${phaseLabel[tree.observation]}` : phaseLabel[tree.observation]}</p>{tree.localChanges && <p>{tree.localChanges.total} {tree.localChanges.total === 1 ? 'caminho local único' : 'caminhos locais únicos'}</p>}<LocalChangesInspector key={`${tree.worktreeId}:${tree.generation}`} tree={tree} query={query} revalidate={() => void inspect({ worktree: { worktreeId: tree.worktreeId } }, tree)} stale={() => { choose({ ...tree, observation: 'STALE' }); setOverview(previous => previous && { ...previous, worktrees: previous.worktrees.map(worktree => worktree.worktreeId === tree.worktreeId ? { ...worktree, observation: 'STALE' } : worktree) }) }} /></>}
        {pair && <><h3>{pairLabel[pair.category]}</h3><p>{pair.reason ? reasonLabel(pair.reason) : `${pair.totalPaths} ${pair.totalPaths === 1 ? 'caminho em comum verificado' : 'caminhos em comum verificados'}`}</p><dl><dt>Merge-base do par</dt><dd>{pair.base ?? 'Indisponível'}</dd><dt>Esquerda</dt><dd>{label(pair.left)}</dd><dt>Direita</dt><dd>{label(pair.right)}</dd></dl><ul className="wo-paths" aria-label="Caminhos em comum">{pair.paths.map(path => <li key={path}>{path}</li>)}</ul>
          {pair.nextCursor && <button disabled={reading || refreshing} onClick={() => void inspect({ pair: { leftId: pair.left.worktreeId, rightId: pair.right.worktreeId, cursor: pair.nextCursor! } })}>Mais caminhos ({pair.paths.length}/{pair.totalPaths})</button>}
          <button disabled={reading || refreshing} onClick={() => void inspect({ pair: { leftId: pair.left.worktreeId, rightId: pair.right.worktreeId } })}>Revalidar par</button><details><summary>Identidades e revisões da observação</summary><dl><dt>Repositório</dt><dd>{pair.repositoryId}</dd>{[pair.left, pair.right].map((w, i) => <React.Fragment key={w.worktreeId}><dt>{i ? 'Direita' : 'Esquerda'}</dt><dd>{w.path}<br />ID da worktree: {w.worktreeId}<br />HEAD: {w.snapshot?.head ?? 'Indisponível'}<br />Geração: {w.generation}<br />Índice: {w.snapshot?.indexRevision ?? 'Indisponível'}<br />Worktree: {w.snapshot?.worktreeRevision ?? 'Indisponível'}</dd></React.Fragment>)}</dl></details><p className="wo-footnote">Caminhos em comum indicam sobreposição de alterações, não conflitos de merge nem ordem de integração. A revisão local usa o estado Git e os metadados dos arquivos; não há snapshot atômico global.</p></>}
      </aside>}
      </div></>}
  </section>
}
