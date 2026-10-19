import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitBranch, GitMerge, RefreshCw, Settings, Hexagon, X, Tag } from 'lucide-react'
import type { CommitNavigationIntent } from '../../../../shared/types/worktree-integration-evidence-types'
import type { ActiveProjectState } from '../../../../shared/types/active-project-types'
import type { GitOverview } from '../../../../shared/types/git-management-types'
import type { GitAtlasComparison, GitAtlasPage, GitAtlasWindow } from '../../../../shared/types/git-atlas-types'
import { GitInspector, type GitSelection } from './GitInspector'
import { GitActions } from './GitActions'
import { GitAtlasCanvas } from './GitAtlasCanvas'
import './GitManagementView.css'

export function GitManagementView({ state, commitIntent, onIntentConsumed }: { state: ActiveProjectState; commitIntent?: CommitNavigationIntent | null; onIntentConsumed?: (requestId: string) => void }) {
  const [history, setHistory] = useState<GitAtlasPage | null>(null)
  const [selection, setSelection] = useState<GitSelection>(null)
  const [overview, setOverview] = useState<GitOverview | null>(null)
  const [windowDays, setWindowDays] = useState<GitAtlasWindow>(90)
  const [mode, setMode] = useState('Panorama')
  const [base, setBase] = useState('')
  const [focus, setFocus] = useState('')
  const [comparison, setComparison] = useState<GitAtlasComparison | null>(null)
  const [compareError, setCompareError] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [shaInput, setShaInput] = useState('')
  const generation = useRef(0)
  const overviewGeneration = useRef(0)
  const [overviewError, setOverviewError] = useState('')
  const [overviewLoading, setOverviewLoading] = useState(false)
  const paging = useRef<string | null>(null)
  const [notice, setNotice] = useState('')
  const returnFocus = useRef<HTMLElement | null>(null)
  const inspectorFocus = useRef<HTMLElement>(null)
  const context = useMemo(() => ({ projectId: state.project?.id ?? '', revision: state.revision }), [state.project?.id, state.revision])
  const load = useCallback(async (cursor?: string, refresh = false) => {
    if (!state.project) return
    if (cursor && paging.current === cursor) return
    paging.current = cursor ?? null
    const request = ++generation.current
    setLoading(true); setError('')
    try {
      const result = await window.codeAwareness.getGitAtlas({ context, window: windowDays, limit: 100, cursor, ...(refresh ? { refresh: true } : {}) })
      if (generation.current !== request) return
      if (!result.success) { if (cursor && result.code === 'GIT_STATE_CHANGED') { setHistory(null); setNotice('O histórico mudou. A revisão atual está sendo carregada.'); paging.current = null; void load(); return } setError(result.code); return }
      setNotice('')
      setHistory(previous => {
        if (!cursor && previous?.snapshot === result.data.snapshot && previous.queriedAt === result.data.queriedAt) return previous
        return cursor && previous?.snapshot === result.data.snapshot
          ? { ...result.data, nodes: [...new Map([...previous.nodes, ...result.data.nodes].map(node => [node.sha, node])).values()] }
          : result.data
      })
    } catch { if (generation.current === request) setError('Falha ao carregar histórico. Atualize para tentar novamente.') }
    finally { if (generation.current === request) { setLoading(false); paging.current = null } }
  }, [context, state.project?.id, windowDays])
  useEffect(() => {
    setHistory(null); setOverview(null); setNotice(''); setSelection(null); setBase(''); setFocus(''); setComparison(null); setDrawer(false)
  }, [context])
  const readOverview = useCallback(async () => {
    if (!context.projectId) { setOverview(null); setOverviewLoading(false); setOverviewError(''); return }
    const request = ++overviewGeneration.current
    setOverviewLoading(true); setOverviewError('')
    try {
      const result = await window.codeAwareness.getGitManagementOverview(context)
      if (overviewGeneration.current !== request) return
      if (result.success) setOverview(result.data)
      else { setOverview(null); setOverviewError(result.code) }
    } catch { if (overviewGeneration.current === request) { setOverview(null); setOverviewError('Estado Git indisponível') } }
    finally { if (overviewGeneration.current === request) setOverviewLoading(false) }
  }, [context])
  useEffect(() => {
    setHistory(null); void load()
    const focusWindow = () => void load()
    window.addEventListener('focus', focusWindow)
    return () => { generation.current++; paging.current = null; window.removeEventListener('focus', focusWindow) }
  }, [load])
  useEffect(() => {
    void readOverview()
    const focusWindow = () => void readOverview()
    window.addEventListener('focus', focusWindow)
    return () => { overviewGeneration.current++; window.removeEventListener('focus', focusWindow) }
  }, [readOverview])
  useEffect(() => {
    if (!history) return
    setBase(previous => history.refs.some(ref => ref.ref === previous) ? previous : history.primaryRef ?? '')
    setFocus(previous => history.refs.some(ref => ref.ref === previous) || history.nodes.some(node => node.sha === previous) ? previous : '')
    setSelection(previous => {
      if (previous?.kind !== 'BRANCH') return previous
      const ref = history.refs.find(ref => ref.ref === previous.ref.ref)
      return ref ? { kind: 'BRANCH', ref } : null
    })
  }, [history?.snapshot])
  useEffect(() => {
    let current = true
    setComparison(null); setCompareError('')
    if (mode !== 'Panorama' && history && base && focus && base !== focus) {
      window.codeAwareness.compareGitAtlas({ context, snapshot: history.snapshot, left: base, right: focus }).then(result => {
        if (!current) return
        if (result.success) setComparison(result.data)
        else setCompareError(result.code)
      }).catch(() => { if (current) setCompareError('Comparação indisponível') })
    }
    return () => { current = false }
  }, [context, history?.snapshot, base, focus, mode !== 'Panorama'])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && drawer) { setDrawer(false); returnFocus.current?.focus() } }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [drawer])
  const select = (sha: string) => {
    returnFocus.current = document.activeElement as HTMLElement
    setSelection({ kind: 'COMMIT', sha }); setDrawer(true)
    requestAnimationFrame(() => inspectorFocus.current?.focus())
  }
  useEffect(() => {
    if (!commitIntent || commitIntent.projectId !== context.projectId || commitIntent.revision !== context.revision) return
    select(commitIntent.commitSha)
    onIntentConsumed?.(commitIntent.requestId)
  }, [commitIntent?.requestId, context])
  const refresh = async () => { await Promise.all([load(undefined, true), readOverview()]) }
  const refs = history?.refs.filter(ref => ref.kind !== 'HEAD') ?? []
  const selected = selection?.kind === 'COMMIT' ? selection.sha : selection?.ref.sha
  if (!state.project) return <section className="gm-empty"><GitBranch size={32} /><h2>Git Management</h2><p>Abra um repositório para explorar seu histórico.</p></section>
  return <section className="gm-view" aria-label="Git Management">
    <header className="gm-header">
      <span className="gm-feature-icon"><GitBranch size={32} /></span>
      <div><h1>Git Management</h1><p>{state.project.name} <span>/ {history?.branch ?? (history?.head ? 'HEAD detached' : 'sem commits')} · {history?.nodes.length ?? 0} commits {windowDays === 'ALL' ? 'no trecho carregado' : `(últimos ${windowDays} dias)`}</span></p></div>
      <div className="gm-toolbar-actions"><button disabled={loading} onClick={() => void refresh()} aria-label="Atualizar Git"><RefreshCw size={17} />Atualizar</button>
        <button onClick={() => { setSelection(null); setDrawer(true) }}><Settings size={18} />Alterações</button></div>
    </header>
    <div className="gm-toolbar">
      <div className="gm-segmented" role="group" aria-label="Janela temporal">{([7, 15, 30, 60, 90, 'ALL'] as const).map(value => <button key={value} aria-pressed={windowDays === value} onClick={() => setWindowDays(value)}>{value === 'ALL' ? 'Tudo' : `${value}d`}</button>)}</div>
      <div className="gm-segmented" role="group" aria-label="Modo do Atlas">{['Panorama', 'Foco', 'Comparar'].map(value => <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>{value}</button>)}</div>
      <label>{mode === 'Comparar' ? 'Comparar com' : 'Branch em foco'}<select aria-label="Referência em foco" value={focus} onChange={event => { setFocus(event.target.value); const ref = refs.find(ref => ref.ref === event.target.value); if (ref) { setMode(mode === 'Panorama' ? 'Foco' : mode); setSelection({ kind: 'BRANCH', ref }) } }}><option value="">Todas as branches</option>{refs.map(ref => <option key={ref.ref} value={ref.ref}>{ref.name}</option>)}{/^[a-f0-9]{40,64}$/.test(focus) && <option value={focus}>Trajetória · {focus.slice(0, 8)}</option>}</select></label>
      {mode !== 'Panorama' && <label>Base<select aria-label="Referência base" value={base} onChange={event => setBase(event.target.value)}><option value="">Escolha a base</option>{refs.map(ref => <option key={ref.ref} value={ref.ref}>{ref.name}</option>)}</select></label>}
    </div>
    {notice && <div className="gm-atlas-note" role="status">{notice}</div>}
    {error && <div className="gm-error" role="alert">{error === 'NOT_GIT_REPOSITORY' ? 'Este projeto não é um repositório Git.' : error === 'GIT_STATE_CHANGED' ? 'Histórico desatualizado. Atualize para carregar um novo snapshot.' : error}</div>}
    {mode !== 'Panorama' && <div className="gm-comparison" role="status">
      {!base || !focus ? 'Escolha uma base e uma referência para revelar a relação Git.' : base === focus ? 'A base e o alvo apontam para a mesma referência.' : compareError ? `Relação indisponível: ${compareError}` : !comparison ? 'Verificando relação Git…' : !comparison.mergeBases.length ? 'As referências não possuem ancestral comum.' : <>
        <span>{comparison.leftOnly} exclusivos da base · {comparison.rightOnly} exclusivos do alvo</span>
        <span>Base comum: {comparison.mergeBases.map(sha => <button key={sha} onClick={() => select(sha)}>{sha.slice(0, 8)}</button>)}</span>
        {!comparison.exclusive.complete && <span>Destaques parciais; contagens de alcance completas.</span>}
      </>}
    </div>}
    <div className="gm-workspace">
      <div className="gm-history" aria-busy={loading}>
        <div className="gm-pane-heading gm-atlas-heading"><GitBranch size={32} /><div><h2>Git Atlas</h2><p>Histórico do repositório com linhas do tempo por trajetória.</p></div><div className="gm-atlas-legend" title="A cor identifica a trajetória exibida, sem afirmar a branch de origem. Datas reais com espaçamento adaptado para leitura."><span><i />Commit</span><span><GitMerge size={15} />Merge</span><span><Tag size={15} />Tag</span></div>{history?.coverage === 'PARTIAL' && <span>Trecho parcial</span>}</div>
        {history?.detachedCoverage === 'PARTIAL' && <p className="gm-atlas-note" role="status">Alguns HEADs de worktrees não puderam ser verificados.</p>}
        <GitAtlasCanvas key={`${context.projectId}:${context.revision}:${windowDays}`} page={history} windowDays={windowDays} base={base} focus={focus} mode={mode} comparison={comparison} selected={selected} select={select} loading={loading} requestMore={history?.nextCursor && !error ? () => void load(history.nextCursor!) : undefined} focusTrajectory={(ref, sha) => { returnFocus.current = document.activeElement as HTMLElement; setDrawer(true); setFocus(ref); setMode('Foco'); const branch = history?.refs.find(item => item.ref === ref); setSelection(branch ? { kind: 'BRANCH', ref: branch } : { kind: 'COMMIT', sha }) }} />
        {!history?.nodes.length && <p className="gm-placeholder">{loading ? 'Carregando histórico…' : error ? 'Histórico indisponível.' : 'Nenhum commit no período selecionado.'}</p>}
        {history?.nextCursor && <button className="gm-load-more" disabled={loading || !!error} onClick={() => void load(history.nextCursor!)}>Carregar anteriores</button>}
      </div>
      <aside ref={inspectorFocus} tabIndex={-1} className={`gm-inspector ${drawer ? 'is-open' : ''}`} aria-label="Detalhes Git" aria-busy={overviewLoading}>
        <div className="gm-pane-heading gm-inspector-heading"><Hexagon size={18} /><strong>{selection?.kind === 'COMMIT' ? 'Commit selecionado' : selection?.kind === 'BRANCH' ? 'Branch selecionada' : 'Alterações locais'}</strong><button className="gm-close-details" aria-label="Fechar detalhes" onClick={() => { setDrawer(false); setSelection(null); returnFocus.current?.focus() }}><X size={18} /></button></div>
        <div className="gm-inspector-scroll">
          {overviewError && !overview ? <p role="alert">Estado Git indisponível. <button onClick={() => void readOverview()}>Tentar novamente</button></p> : <GitInspector context={context} overview={overview} selection={selection} />}
          {overview && <div hidden={!!selection}><GitActions context={context} overview={overview} history={history} refresh={refresh} blocked={overviewLoading || !!overviewError} /></div>}
          <details className="gm-sha-lookup"><summary>Inspecionar por SHA</summary><form onSubmit={event => { event.preventDefault(); if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(shaInput.trim())) select(shaInput.trim()) }}><input aria-label="SHA completo" value={shaInput} onChange={event => setShaInput(event.target.value)} placeholder="SHA completo do commit" /><button disabled={!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(shaInput.trim())}>Inspecionar</button></form></details>
        </div>
      </aside>
    </div>
  </section>
}
