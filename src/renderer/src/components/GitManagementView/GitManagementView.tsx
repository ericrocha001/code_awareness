import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitBranch, RefreshCw, FileText, Hexagon, X, Database, GitPullRequest, PanelRightClose, PanelRightOpen } from 'lucide-react'
import type { CommitNavigationIntent } from '../../../../shared/types/worktree-integration-evidence-types'
import type { ActiveProjectState } from '../../../../shared/types/active-project-types'
import type { GitDecoration, GitOverview } from '../../../../shared/types/git-management-types'
import type { GitAtlasComparison, GitAtlasPage, GitAtlasScope } from '../../../../shared/types/git-atlas-types'
import type { GitAtlasCoreEvidence, GitAtlasPrEvidence } from '../../../../shared/types/git-atlas-evidence-types'
import type { AtlasCatalogState } from '../../../../shared/types/git-atlas-catalog-types'
import { GitInspector, type GitSelection } from './GitInspector'
import { GitActions } from './GitActions'
import { GitAtlasCanvas } from './GitAtlasCanvas'
import { AtlasCheckout, AtlasPullRequests } from './AtlasContext'
import { AtlasSearch } from './AtlasSearch'
import { atlasMergeDescriptions, classifyAtlasMerges } from './atlas-layout'
import './GitManagementView.css'

export function GitManagementView({ state, commitIntent, onIntentConsumed }: { state: ActiveProjectState; commitIntent?: CommitNavigationIntent | null; onIntentConsumed?: (requestId: string) => void }) {
  const [history, setHistory] = useState<GitAtlasPage | null>(null)
  const [core, setCore] = useState<GitAtlasCoreEvidence | null>(null)
  const [catalog, setCatalog] = useState<AtlasCatalogState | null>(null)
  const catalogRef = useRef<AtlasCatalogState | null>(null)
  const [collectionSession, setCollectionSession] = useState(0)
  const [enrichment, setEnrichment] = useState<GitAtlasPrEvidence | null>(null)
  const [prState, setPrState] = useState<'NOT_REQUESTED' | 'LOADING' | 'READY' | 'UNAVAILABLE'>('NOT_REQUESTED')
  const [selectedPr, setSelectedPr] = useState<number | null>(null)
  const [prRequested, setPrRequested] = useState(true)
  const [selection, setSelection] = useState<GitSelection>(null)
  const [overview, setOverview] = useState<GitOverview | null>(null)
  const [scope, setScope] = useState<GitAtlasScope>({ kind: 'CHECKOUT', anchor: 'AUTO' })
  const [operation, setOperation] = useState<string | null>(null)
  const [mode, setMode] = useState('Panorama')
  const [base, setBase] = useState('')
  const [focus, setFocus] = useState('')
  const [comparison, setComparison] = useState<GitAtlasComparison | null>(null)
  const [compareError, setCompareError] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [drawer, setDrawer] = useState(true)
  const [shaInput, setShaInput] = useState('')
  const generation = useRef(0)
  const overviewGeneration = useRef(0)
  const [overviewError, setOverviewError] = useState('')
  const [overviewLoading, setOverviewLoading] = useState(false)
  const paging = useRef<string | null>(null)
  const loadedPage = useRef<GitAtlasPage | null>(null)
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
      const result = await window.codeAwareness.getGitAtlasCore({ context, window: 'ALL', scope, limit: 100, cursor, ...(refresh ? { refresh: true } : {}) })
      if (generation.current !== request) return
      if (!result.success) { if (cursor && result.code === 'GIT_STATE_CHANGED') { setHistory(null); setCore(null); setEnrichment(null); setNotice('O histórico mudou. A revisão atual está sendo carregada.'); paging.current = null; void load(); return } setError(result.code); return }
      setNotice('')
      const page = result.data.git
      if (cursor && (!loadedPage.current || loadedPage.current.snapshot !== page.snapshot || loadedPage.current.queriedAt !== page.queriedAt || loadedPage.current.anchorAt !== page.anchorAt)) { setError('GIT_STATE_CHANGED'); return }
      loadedPage.current = page
      if (!cursor) { setCore(result.data); setEnrichment(null); setSelectedPr(null) }
      setHistory(previous => {
        if (!cursor && previous?.snapshot === page.snapshot && previous.queriedAt === page.queriedAt) return previous
        const expanding = !cursor && previous?.scope?.kind === 'CHECKOUT' && page.scope?.kind === 'ALL_REFS' && previous.head === page.head &&
          previous.worktreeGeneration === page.worktreeGeneration && previous.topologyRevision === page.topologyRevision &&
          previous.refs.every(ref => page.refs.some(current => current.ref === ref.ref && current.sha === ref.sha))
        if (expanding || cursor && previous?.snapshot === page.snapshot && previous.queriedAt === page.queriedAt && previous.anchorAt === page.anchorAt) {
          const nodes = [...new Map([...(previous?.nodes ?? []), ...page.nodes].map(node => [node.sha, node])).values()]
            .map(node => ({ ...node, decorations: page.refs.filter(ref => ref.sha === node.sha) }))
          const present = new Set(nodes.map(node => node.sha))
          const boundary = [...new Set(nodes.flatMap(node => node.parents).filter(sha => !present.has(sha)))]
          return { ...page, nodes, boundary, pendingParents: boundary }
        }
        return page
      })
    } catch { if (generation.current === request) setError('Falha ao carregar histórico. Atualize para tentar novamente.') }
    finally { if (generation.current === request) { setLoading(false); paging.current = null } }
  }, [context, state.project?.id, scope])
  useEffect(() => {
    setCatalog(null); catalogRef.current = null
    setHistory(null); setCore(null); setEnrichment(null); setPrRequested(true); setSelectedPr(null); setPrState('NOT_REQUESTED'); setOverview(null); setNotice(''); setSelection(null); setBase(''); setFocus(''); setComparison(null); setDrawer(true)
    setScope(previous => previous.kind === 'CHECKOUT' && previous.anchor === 'AUTO' && !previous.baseRef && !previous.focusRef ? previous : { kind: 'CHECKOUT', anchor: 'AUTO' }); setOperation(null)
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
    loadedPage.current = null
    void load()
    return () => { generation.current++; paging.current = null }
  }, [load])
  useEffect(() => {
    if (!core) return
    let current = true, first = 0, second = 0
    const accept = (next: AtlasCatalogState) => {
      if (!current || next.manifest && next.manifest.worktreeGeneration !== core.worktreeGeneration) return
      const previous = catalogRef.current
      catalogRef.current = next; setCatalog(next)
      if (next.manifest) {
        if (scope.kind === 'CHECKOUT') setScope(value => ({ ...value, kind: 'ALL_REFS' }))
        else if (previous?.manifest && previous.manifest.revision !== next.manifest.revision) void load()
      }
    }
    const stop = () => { void window.codeAwareness.stopGitAtlasCollection(context).catch(() => {}) }
    const start = () => {
      if (document.hidden) return
      first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
        void window.codeAwareness.getGitAtlasCatalog({ context, snapshot: core.gitSnapshot }).then(result => {
          if (result.success) accept(result.data)
          else if (current) { catalogRef.current = null; setCatalog({ manifest: null, coverage: 'UNKNOWN', acquired: 0, diagnostic: { state: 'UNAVAILABLE', reason: result.code }, reason: result.code }) }
        }).catch(() => { if (current) setCatalog({ manifest: null, coverage: 'UNKNOWN', acquired: 0, diagnostic: { state: 'UNAVAILABLE', reason: 'CATALOG_UNAVAILABLE' }, reason: 'CATALOG_UNAVAILABLE' }) })
      }) })
    }
    const unsubscribe = window.codeAwareness.onGitAtlasCatalogChanged(change => {
      if (change.context.projectId === context.projectId && change.context.revision === context.revision) accept(change.state)
    })
    const visibility = () => {
      cancelAnimationFrame(first); cancelAnimationFrame(second)
      if (document.hidden) stop()
      else start()
    }
    start(); document.addEventListener('visibilitychange', visibility)
    return () => { current = false; cancelAnimationFrame(first); cancelAnimationFrame(second); unsubscribe(); document.removeEventListener('visibilitychange', visibility); stop() }
  }, [core?.gitSnapshot, context, scope.kind, collectionSession])
  useEffect(() => {
    let resume: ReturnType<typeof setTimeout> | undefined
    const navigate = () => {
      if (!core) return
      if (!resume) void window.codeAwareness.stopGitAtlasCollection(context).catch(() => {})
      if (resume) clearTimeout(resume)
      resume = setTimeout(() => { resume = undefined; setCollectionSession(value => value + 1) }, 600)
    }
    window.addEventListener('wheel', navigate, { passive: true })
    window.addEventListener('pointerdown', navigate, { passive: true })
    return () => { if (resume) clearTimeout(resume); window.removeEventListener('wheel', navigate); window.removeEventListener('pointerdown', navigate) }
  }, [context, !!core])
  useEffect(() => {
    let current = true, pending = false
    const focusWindow = async () => {
      if (!core || pending) return
      pending = true
      try {
        const result = await window.codeAwareness.getGitAtlasCheckoutState(context)
        if (!current || !result.success) return
        setOperation(result.data.operation)
        if (result.data.head !== core.checkout.head || result.data.branch !== core.git.branch || result.data.sourceFingerprint && result.data.sourceFingerprint !== catalogRef.current?.manifest?.sourceFingerprint) {
          catalogRef.current = null; setCatalog(null); void load(); setCollectionSession(value => value + 1)
        } else if (!result.data.operation && catalogRef.current?.reason) setCollectionSession(value => value + 1)
      } finally { pending = false }
    }
    const listener = () => { void focusWindow().catch(() => {}) }
    window.addEventListener('focus', listener)
    return () => { current = false; window.removeEventListener('focus', listener) }
  }, [core, context, load])
  useEffect(() => {
    let current = true
    setEnrichment(null)
    if (!core || !prRequested) { setPrState('NOT_REQUESTED'); return }
    setPrState('LOADING')
    window.codeAwareness.getGitAtlasPrEvidence({ context, window: 'ALL', scope: core.git.scope, limit: 100, snapshot: core.gitSnapshot }).then(result => {
      if (!current) return
      if (result.success && result.data.repositoryId === core.repositoryId && result.data.gitSnapshot === core.gitSnapshot && result.data.worktreeId === core.worktreeId && result.data.worktreeGeneration === core.worktreeGeneration) {
        setEnrichment(result.data); setPrState(result.data.coverage === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'READY')
      } else setPrState('UNAVAILABLE')
    }).catch(() => { if (current) setPrState('UNAVAILABLE') })
    return () => { current = false }
  }, [core, context, prRequested])
  const actionsActive = drawer && !selection && selectedPr === null
  useEffect(() => {
    if (!actionsActive || !core) return
    let second = 0
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => { void readOverview() }) })
    const focusWindow = () => void readOverview()
    window.addEventListener('focus', focusWindow)
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); overviewGeneration.current++; window.removeEventListener('focus', focusWindow) }
  }, [readOverview, actionsActive, !!core])
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
      window.codeAwareness.compareGitAtlas({ context, snapshot: history.snapshot, left: base, right: focus, scope: history.scope }).then(result => {
        if (!current) return
        if (result.success) setComparison(result.data)
        else setCompareError(result.code)
      }).catch(() => { if (current) setCompareError('Comparação indisponível') })
    }
    return () => { current = false }
  }, [context, history?.snapshot, base, focus, mode !== 'Panorama'])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && drawer) { setDrawer(false); setSelection(null); setSelectedPr(null); returnFocus.current?.focus() } }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [drawer])
  const select = (sha: string) => {
    returnFocus.current = document.activeElement as HTMLElement
    setSelectedPr(null); setSelection({ kind: 'COMMIT', sha }); setDrawer(true)
    requestAnimationFrame(() => inspectorFocus.current?.focus())
  }
  const choosePr = (number: number) => {
    returnFocus.current = document.activeElement as HTMLElement
    setSelectedPr(number); setSelection(null); setDrawer(true)
    requestAnimationFrame(() => inspectorFocus.current?.focus())
  }
  useEffect(() => {
    if (!commitIntent || commitIntent.projectId !== context.projectId || commitIntent.revision !== context.revision) return
    select(commitIntent.commitSha)
    onIntentConsumed?.(commitIntent.requestId)
  }, [commitIntent?.requestId, context])
  const chooseBranch = (ref: GitDecoration) => {
    returnFocus.current = document.activeElement as HTMLElement
    setFocus(ref.ref); setSelectedPr(null); setDrawer(true); setMode(mode === 'Panorama' ? 'Foco' : mode); setSelection({ kind: 'BRANCH', ref })
    requestAnimationFrame(() => inspectorFocus.current?.focus())
  }
  const openChanges = () => {
    returnFocus.current = document.activeElement as HTMLElement
    setSelectedPr(null); setSelection(null); setDrawer(true)
    requestAnimationFrame(() => inspectorFocus.current?.focus())
  }
  const refresh = async () => { await Promise.all([load(undefined, true), ...(actionsActive ? [readOverview()] : [])]); setCollectionSession(value => value + 1) }
  const refs = history?.refs.filter(ref => ref.kind !== 'HEAD') ?? []
  const selected = selection?.kind === 'COMMIT' ? selection.sha : selection?.ref.sha
  const mergeContexts = useMemo(() => classifyAtlasMerges(history, base), [history, base])
  const selectedMergeContext = selection?.kind === 'COMMIT' ? mergeContexts.get(selection.sha) : undefined
  const catalogComplete = catalog?.coverage === 'COMPLETE' && catalog.diagnostic.state === 'READY' && !catalog.reason
  const catalogUnavailable = catalog && (catalog.diagnostic.state !== 'READY' || !!catalog.reason)
  if (!state.project) return <section className="gm-empty"><GitBranch size={32} /><h2>Git Management</h2><p>Abra um repositório para explorar seu histórico.</p></section>
  return <section className="gm-view" aria-label="Git Management">
    <header className="gm-header">
      <span className="gm-feature-icon"><GitBranch size={32} /></span>
      <div><h1>Git Management</h1><p>{state.project.name} <span>/ {history?.branch ?? (history?.head ? 'HEAD detached' : 'sem commits')} · {history?.nodes.length ?? 0} commits no trecho carregado</span></p></div>
    </header>
    <div className="gm-toolbar">
      <div className="gm-segmented" role="group" aria-label="Modo do Atlas">{['Panorama', 'Foco', 'Comparar'].map(value => <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>{value}</button>)}</div>
      <label className="gm-branch-control"><GitBranch size={16} aria-hidden="true" /><span className="gm-control-label">{mode === 'Comparar' ? 'Comparar com' : 'Branch em foco'}</span><select aria-label="Referência em foco" value={focus} onChange={event => { setFocus(event.target.value); const ref = refs.find(ref => ref.ref === event.target.value); if (ref) chooseBranch(ref) }}><option value="">Todas as branches</option>{refs.map(ref => <option key={ref.ref} value={ref.ref}>{ref.name}</option>)}{/^[a-f0-9]{40,64}$/.test(focus) && <option value={focus}>Trajetória · {focus.slice(0, 8)}</option>}</select></label>
      <button className="gm-pr-toggle" aria-pressed={prRequested} onClick={() => { setPrRequested(value => !value); setEnrichment(null); setSelectedPr(null) }}><span className="gm-toggle-track" aria-hidden="true"><span /></span>{prRequested ? 'Ocultar PRs' : 'Mostrar PRs'}</button>
      {mode !== 'Panorama' && <label>Base<select aria-label="Referência base" value={base} onChange={event => { setBase(event.target.value); setScope(previous => ({ ...previous, baseRef: event.target.value || undefined })) }}><option value="">Escolha a base</option>{refs.map(ref => <option key={ref.ref} value={ref.ref}>{ref.name}</option>)}</select></label>}
      <AtlasSearch page={history} evidence={enrichment} inspect={select} branch={chooseBranch} pullRequest={choosePr} />
      <button className="gm-refresh" disabled={loading || overviewLoading} onClick={() => void refresh()} aria-label="Atualizar Git" title="Atualizar histórico e alterações locais"><RefreshCw size={17} /></button>
    </div>
    <div className="gm-context-strip" aria-label="Contexto do repositório">
      {core ? <AtlasCheckout core={core} context={context} base={base} inspect={select} /> : <span className="gm-context-placeholder">Lendo checkout local…</span>}
      <div className="gm-context-item"><Database size={20} aria-hidden="true" /><div><strong>Histórico local</strong><span>{history ? `${history.nodes.length} commits no trecho carregado` : 'Aguardando histórico'}</span></div></div>
      {catalog && <div className={`gm-context-item gm-catalog-state ${catalogUnavailable ? 'is-unavailable' : catalogComplete ? 'is-complete' : ''}`} role="status"><span className="gm-status-dot" aria-hidden="true" /><div><strong>{catalogUnavailable ? 'Coleta indisponível' : catalogComplete ? 'Catálogo indexado' : 'Catálogo parcial'}</strong><span title={catalog.manifest ? `Revisão local ${catalog.manifest.revision}` : undefined}>{catalogUnavailable ? 'Timeline local preservada' : catalogComplete ? 'Tips e revisão local verificados' : 'Histórico disponível progressivamente'}</span></div></div>}
    </div>
    {notice && <div className="gm-atlas-note" role="status">{notice}</div>}
    {operation && <div className="gm-atlas-note" role="status">Operação Git em andamento: {operation}. Abra Alterações para consultar as ações disponíveis.</div>}
    {error && <div className="gm-error" role="alert">{error === 'NOT_GIT_REPOSITORY' ? 'Este projeto não é um repositório Git.' : error === 'GIT_STATE_CHANGED' ? 'Histórico desatualizado. Atualize para carregar um novo snapshot.' : error}</div>}
    {mode !== 'Panorama' && <div className="gm-comparison" role="status">
      {!base || !focus ? 'Escolha uma base e uma referência para revelar a relação Git.' : base === focus ? 'A base e o alvo apontam para a mesma referência.' : compareError ? `Relação indisponível: ${compareError}` : !comparison ? 'Verificando relação Git…' : !comparison.mergeBases.length ? 'As referências não possuem ancestral comum.' : <>
        <span>{comparison.leftOnly} exclusivos da base · {comparison.rightOnly} exclusivos do alvo</span>
        <span>Base comum: {comparison.mergeBases.map(sha => <button key={sha} onClick={() => select(sha)}>{sha.slice(0, 8)}</button>)}</span>
        {!comparison.exclusive.complete && <span>Destaques parciais; contagens de alcance completas.</span>}
      </>}
    </div>}
    <div className={`gm-workspace ${drawer ? 'has-inspector' : ''}`}>
      <button className="gm-inspector-tab" aria-label={drawer ? 'Recolher painel de detalhes' : 'Abrir alterações locais'} aria-expanded={drawer} aria-controls="gm-details-panel" onClick={() => drawer ? setDrawer(false) : openChanges()}>{drawer ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}<span>Alterações locais</span>{overview && <b>{overview.changes.length}</b>}</button>
      <div className="gm-history" aria-busy={loading}>
        <div className="gm-pane-heading gm-atlas-heading"><GitBranch size={32} /><div><h2>Git Atlas</h2><p>Histórico e relações do repositório.</p></div><div className="gm-atlas-legend" aria-label="Legenda dos fatos presentes">
          {!!history?.nodes.length && <span><i />Commit</span>}
          {history?.nodes.some(node => node.parents.length > 1) && <span><b>M</b>Merge</span>}
          {core?.checkout.head && <span><i className="gm-head-icon" />Checkout</span>}
          {enrichment?.events.some(event => event.kind !== 'GIT_MERGE_COMMIT') && <span><GitPullRequest size={13} />PR</span>}
        </div>{history?.coverage === 'PARTIAL' && <span>Trecho parcial</span>}</div>
        <div className="gm-pr-controls">
          {prState === 'LOADING' && <span role="status">Carregando PRs…</span>}{prState === 'UNAVAILABLE' && <span role="status">GitHub indisponível; mapa local preservado.</span>}{enrichment?.coverage === 'PARTIAL' && <span>PRs: cobertura parcial</span>}
          {enrichment && <details><summary>PRs do repositório ({enrichment.pullRequests.length}{enrichment.coverage !== 'COMPLETE' ? ', parcial' : ''})</summary><div className="gm-pr-catalog">{enrichment.pullRequests.map(pr => <button key={pr.record.id} onClick={() => choosePr(pr.record.number)}>#{pr.record.number} · {pr.record.title}{enrichment.branches?.orphaned.some(item => item.id === pr.record.id) ? ' · sem vínculo confirmado à origem local' : ''}</button>)}</div></details>}
        </div>
        {history?.referenceCoverage === 'SELECTED' ? <p className="gm-atlas-note" role="status">Contexto do checkout e da base; outras referências e worktrees ainda não consultadas.</p> : history?.detachedCoverage === 'PARTIAL' && <p className="gm-atlas-note" role="status">Alguns HEADs de worktrees não puderam ser verificados.</p>}
        {history && !history.nextCursor && !loading && <p className="gm-atlas-note">Fim do histórico do escopo consultado.</p>}
        <GitAtlasCanvas key={`${context.projectId}:${context.revision}`} page={history} core={core} enrichment={enrichment} choosePr={choosePr} base={base} focus={focus} mode={mode} comparison={comparison} selected={selected} select={select} loading={loading} requestMore={history?.nextCursor && !error ? () => void load(history.nextCursor!) : undefined} focusTrajectory={(ref, sha) => { returnFocus.current = document.activeElement as HTMLElement; setSelectedPr(null); setDrawer(true); setFocus(ref); setMode('Foco'); const branch = history?.refs.find(item => item.ref === ref); setSelection(branch ? { kind: 'BRANCH', ref: branch } : { kind: 'COMMIT', sha }) }} />
        {!history?.nodes.length && <p className="gm-placeholder">{loading ? 'Carregando histórico…' : error ? 'Histórico indisponível.' : 'Nenhum commit no escopo consultado.'}</p>}
      </div>
      <aside id="gm-details-panel" ref={inspectorFocus} tabIndex={-1} className={`gm-inspector ${drawer ? 'is-open' : ''}`} aria-label="Detalhes Git" aria-busy={overviewLoading}>
        <div className="gm-pane-heading gm-inspector-heading">{actionsActive ? <FileText size={25} /> : <Hexagon size={22} />}<strong>{selectedPr !== null ? `PR #${selectedPr}` : selection?.kind === 'COMMIT' ? 'Commit selecionado' : selection?.kind === 'BRANCH' ? 'Branch selecionada' : 'Alterações locais'}</strong>{actionsActive && overview && <span className="gm-inspector-count">{overview.changes.length}</span>}<button className="gm-close-details" aria-label="Fechar detalhes" onClick={() => { setDrawer(false); setSelectedPr(null); setSelection(null); returnFocus.current?.focus() }}><X size={18} /></button></div>
        <div className="gm-inspector-scroll">
          {selectedPr === null && selectedMergeContext && <p className="gm-comparison-note" role="status">{atlasMergeDescriptions[selectedMergeContext]}</p>}
          {selectedPr === null && (overviewError && !overview ? <p role="alert">Estado Git indisponível. <button onClick={() => void readOverview()}>Tentar novamente</button></p> : !selection && !core ? <p className="gm-comparison-note">Os detalhes locais ficam disponíveis após a leitura inicial do histórico.</p> : <GitInspector context={context} overview={overview} selection={selection} />)}
          {(selection || selectedPr !== null) && <AtlasPullRequests evidence={enrichment} selection={selection} selectedPr={selectedPr} choose={choosePr} />}
          {actionsActive && !overview && overviewLoading && <p role="status">Consultando alterações locais…</p>}
          {!actionsActive && <button className="gm-back-to-changes" onClick={openChanges}><FileText size={15} />Alterações locais</button>}
          {actionsActive && overview && <details className="gm-local-actions"><summary>Preparar, registrar e sincronizar</summary><GitActions context={context} overview={overview} history={history} refresh={refresh} blocked={overviewLoading || !!overviewError} /></details>}
          <details className="gm-sha-lookup"><summary>Inspecionar por SHA</summary><form onSubmit={event => { event.preventDefault(); if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(shaInput.trim())) select(shaInput.trim()) }}><input aria-label="SHA completo" value={shaInput} onChange={event => setShaInput(event.target.value)} placeholder="SHA completo do commit" /><button disabled={!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(shaInput.trim())}>Inspecionar</button></form></details>
        </div>
      </aside>
    </div>
  </section>
}
