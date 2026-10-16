import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitBranch, RefreshCw, Settings, Hexagon, X, Info, Search } from 'lucide-react'
import type { ActiveProjectState } from '../../../../shared/types/active-project-types'
import type { GitOverview } from '../../../../shared/types/git-management-types'
import type { GitAtlasComparison, GitAtlasPage, GitAtlasWindow } from '../../../../shared/types/git-atlas-types'
import { GitInspector, type GitSelection } from './GitInspector'
import { GitActions } from './GitActions'
import { GitAtlasCanvas } from './GitAtlasCanvas'
import './GitManagementView.css'

export function GitManagementView({ state }: { state: ActiveProjectState }) {
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
  const [panel, setPanel] = useState<'selection' | 'operations' | 'lookup'>('selection')
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
    if (mode === 'Comparar' && history && base && focus && base !== focus) {
      window.codeAwareness.compareGitAtlas({ context, snapshot: history.snapshot, left: base, right: focus }).then(result => {
        if (!current) return
        if (result.success) setComparison(result.data)
        else setCompareError(result.code)
      }).catch(() => { if (current) setCompareError('Comparação indisponível') })
    }
    return () => { current = false }
  }, [context, history?.snapshot, base, focus, mode === 'Comparar'])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && drawer) close() }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [drawer])
  const select = (sha: string) => {
    if (!inspectorFocus.current?.contains(document.activeElement)) returnFocus.current = document.activeElement as HTMLElement
    setSelection({ kind: 'COMMIT', sha }); setPanel('selection'); setDrawer(true)
    requestAnimationFrame(() => inspectorFocus.current?.focus())
  }
  const close = () => { setDrawer(false); setSelection(null); setMode('Panorama'); setFocus(''); requestAnimationFrame(() => { if (returnFocus.current?.isConnected && !returnFocus.current.closest('.gm-inspector')) returnFocus.current.focus(); else document.querySelector<HTMLElement>('.gm-atlas-scroll')?.focus() }) }
  useEffect(() => { if (drawer && panel === 'selection' && !selection) close() }, [drawer, panel, selection])
  const openPanel = (value: 'operations' | 'lookup') => { returnFocus.current = value === 'lookup' ? document.querySelector<HTMLElement>('.gm-secondary-menu summary') : document.activeElement as HTMLElement; setPanel(value); setDrawer(true); if (value === 'operations') void readOverview(); requestAnimationFrame(() => inspectorFocus.current?.focus()) }
  const refresh = async (explicit = false) => { await Promise.all([load(undefined, explicit), readOverview()]) }
  const refs = history?.refs.filter(ref => ref.kind !== 'HEAD') ?? []
  const selected = selection?.kind === 'COMMIT' ? selection.sha : selection?.ref.sha
  if (!state.project) return <section className="gm-empty"><GitBranch size={32} /><h2>Git Management</h2><p>Abra um repositório para explorar seu histórico.</p></section>
  return <section className="gm-view" aria-label="Git Management">
    <header className="gm-header">
      <span className="gm-feature-icon"><GitBranch size={32} /></span>
      <div><h1>Git Management</h1><p>{state.project.name} <span>/ {history?.branch ?? (history?.head ? 'HEAD detached' : 'Git')}</span></p></div>
    </header>
    <div className="gm-toolbar">
      <div className="gm-segmented" role="group" aria-label="Janela temporal">{([30, 60, 90, 'ALL'] as const).map(value => <button key={value} aria-pressed={windowDays === value} onClick={() => setWindowDays(value)}>{value === 'ALL' ? 'Tudo' : `${value}d`}</button>)}</div>
      <div className="gm-toolbar-actions"><button disabled={loading} onClick={() => void refresh(true)} aria-label="Atualizar Git"><RefreshCw size={17} />Atualizar</button>
        <button aria-label="Operações Git" onClick={() => openPanel('operations')}><Settings size={18} />{overview?.changes.length ? `Alterações (${overview.changes.length})` : 'Operações Git'}</button>
        <details className="gm-secondary-menu"><summary aria-label="Mais opções do Atlas"><Search size={17} /></summary><button onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); openPanel('lookup') }}>Inspecionar por SHA</button></details>
      </div>
    </div>
    {mode === 'Comparar' && <div className="gm-comparison" role="group" aria-label="Comparação Git"><label>Alvo<select aria-label="Referência em foco" value={focus} onChange={event => { setFocus(event.target.value); const ref = refs.find(ref => ref.ref === event.target.value); if (ref) setSelection({ kind: 'BRANCH', ref }) }}>{refs.map(ref => <option key={ref.ref} value={ref.ref}>{ref.name}</option>)}</select></label><span>com</span><select aria-label="Referência base" value={base} onChange={event => setBase(event.target.value)}><option value="">Escolha a base</option>{refs.filter(ref => ref.ref !== focus).map(ref => <option key={ref.ref} value={ref.ref}>{ref.name}</option>)}</select><button onClick={close}>Limpar seleção</button>
      <span role="status">{!base || !focus ? 'Escolha a base para comparar.' : compareError ? `Relação indisponível: ${compareError}` : !comparison ? 'Verificando relação Git…' : !comparison.mergeBases.length ? 'As referências não possuem ancestral comum.' : <>{comparison.leftOnly} exclusivos da base · {comparison.rightOnly} exclusivos do alvo · Base comum: {comparison.mergeBases.map(sha => <button key={sha} onClick={() => select(sha)}>{sha.slice(0, 8)}</button>)}{!comparison.exclusive.complete && ' · Destaques parciais'}</>}</span>
    </div>}
    {notice && <div className="gm-comparison" role="status">{notice}</div>}
    {error && <div className="gm-error" role="alert">{error === 'NOT_GIT_REPOSITORY' ? 'Este projeto não é um repositório Git.' : error}<button disabled={loading} onClick={() => void load(history?.nextCursor ?? undefined)}>Tentar novamente</button></div>}
    <div className={`gm-workspace ${drawer ? 'has-inspector' : ''}`}>
      <div className="gm-history" aria-busy={loading}>
        <div className="gm-pane-heading gm-atlas-heading"><GitBranch size={28} /><h2>Git Atlas</h2><div className="gm-atlas-context">{history?.coverage === 'PARTIAL' && <span role="status">{loading ? 'Carregando trecho…' : 'Cobertura parcial'}</span>}<details className="gm-atlas-help"><summary aria-label="Sobre o Git Atlas"><Info size={16} /></summary><p>Cor identifica a trajetória exibida; conexões representam pais Git reais. Merges têm dois ou mais pais. Tags pertencem ao commit. Cada coluna representa um período diário da janela selecionada. Role para explorar; dados anteriores são carregados por demanda.</p></details></div></div>
        {history?.detachedCoverage === 'PARTIAL' && <p className="gm-atlas-note" role="status">Alguns HEADs de worktrees não puderam ser verificados.</p>}
        <GitAtlasCanvas key={`${context.projectId}:${context.revision}:${windowDays}`} page={history} windowDays={windowDays} base={base} focus={focus} mode={mode} comparison={comparison} selected={selected} select={select} loading={loading} requestMore={history?.nextCursor && !error ? () => void load(history.nextCursor!) : undefined} focusTrajectory={(ref, sha) => { returnFocus.current = document.activeElement as HTMLElement; setPanel('selection'); setDrawer(true); setFocus(ref); setMode('Foco'); const branch = history?.refs.find(item => item.ref === ref); setSelection(branch ? { kind: 'BRANCH', ref: branch } : { kind: 'COMMIT', sha }); requestAnimationFrame(() => inspectorFocus.current?.focus()) }} />
        {!history?.nodes.length && <p className="gm-placeholder">{loading ? 'Carregando histórico…' : error ? 'Histórico indisponível.' : history?.coverage === 'PARTIAL' ? 'Trecho ainda não carregado.' : 'Nenhum commit no período selecionado.'}</p>}
      </div>
      {drawer && <aside ref={inspectorFocus} tabIndex={-1} className="gm-inspector is-open" aria-label="Detalhes Git" aria-busy={panel === 'operations' && overviewLoading}>
        <div className="gm-pane-heading gm-inspector-heading"><Hexagon size={18} /><strong>{panel === 'lookup' ? 'Inspecionar commit' : panel === 'operations' ? 'Operações Git' : selection?.kind === 'BRANCH' ? 'Branch selecionada' : 'Commit selecionado'}</strong><button className="gm-close-details" aria-label="Fechar detalhes" onClick={close}><X size={18} /></button></div>
        <div className="gm-inspector-scroll">
          {panel === 'lookup' ? <form className="gm-sha-lookup" onSubmit={event => { event.preventDefault(); if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(shaInput.trim())) select(shaInput.trim()) }}><label>SHA completo<input aria-label="SHA completo" value={shaInput} onChange={event => setShaInput(event.target.value)} placeholder="SHA completo do commit" /></label><button disabled={!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(shaInput.trim())}>Inspecionar</button></form> : <>
            {panel === 'operations' && overviewError ? <p role="alert">{overviewError}<button onClick={() => void readOverview()}>Tentar ler alterações</button></p> : <GitInspector context={context} overview={overview} selection={panel === 'selection' ? selection : null} onCompare={selection?.kind === 'BRANCH' ? () => setMode('Comparar') : undefined} />}
            {panel === 'operations' && overview && <GitActions context={context} overview={overview} history={history} refresh={() => refresh()} blocked={loading || overviewLoading || !!error || !!overviewError} />}
          </>}
        </div>
      </aside>}
    </div>
  </section>
}
