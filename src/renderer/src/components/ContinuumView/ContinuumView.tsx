import { ContinuumBundleComposer } from './ContinuumBundleComposer'
import type { ContinuumTag } from '../../../../shared/types/continuum-tag-types'
import { ArtifactTagEditor, ContinuumTagManager } from './ContinuumTags'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Download, FilterX, Tags, Infinity, FileText, Image as ImageIcon, X } from 'lucide-react'
import Markdown from 'markdown-to-jsx'
import type { ActiveProject } from '../../../../shared/types/active-project-types'
import type { ContinuumDetail, ContinuumFacet, ContinuumItem, ContinuumScalar, ContinuumPeriod, ContinuumExportRequest } from '../../../../shared/types/continuum-ui-types'
import { SearchBox } from '../shared/SearchBox/SearchBox'
import { ColumnResizer } from '../shared/ColumnResizer/ColumnResizer'
import { useContinuumColumns } from './useContinuumColumns'
import { VisualThumbnail, thumbnailQueue } from './VisualThumbnail'
import { ContextFilters } from './ContextFilters'
import { useContinuumSelection } from './useContinuumSelection'
import { ContinuumBulkActions } from './ContinuumBulkActions'
import type { ContinuumSelectedArtifact } from '../../../../shared/types/continuum-ui-types'
import './ContinuumView.css'
const ContinuumGraph = React.lazy(() => import('./ContinuumGraph').then(module => ({ default: module.ContinuumGraph })))

function timestamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}

function VisualPreview({ repositoryId, artifactId }: { repositoryId: string; artifactId: string }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false, objectUrl = ''
    setUrl(''); setError('')
    window.codeAwareness.getContinuumVisual(repositoryId, artifactId).then(result => {
      if (cancelled || result.repositoryId !== repositoryId || result.artifactId !== artifactId) return
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(result.data).buffer], { type: result.mimeType }))
      setUrl(objectUrl)
    }).catch(reason => { if (!cancelled) setError(String(reason)) })
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [repositoryId, artifactId])
  return error ? <p role="alert">{error}</p> : url ? <img className="continuum-visual-preview" src={url} alt="Referência visual canônica" onError={() => setError('Não foi possível renderizar a referência visual.')} /> : <p role="status">Carregando referência visual…</p>
}

function ExportActions({ repositoryId, artifactId }: { repositoryId: string; artifactId: string }) {
  const busy = useRef(false)
  const mounted = useRef(true)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const execute = async (intent: ContinuumExportRequest['intent']) => {
    if (busy.current) return
    busy.current = true; setPending(true); setMessage(''); setError('')
    try {
      const result = await window.codeAwareness.exportContinuumArtifact({ repositoryId, artifactId, intent })
      if (!mounted.current) return
      if (result.repositoryId !== repositoryId || result.artifactId !== artifactId) throw new Error('EXPORT_CONTEXT_CHANGED')
      setMessage(result.outcome === 'cancelled' ? 'Salvamento cancelado.' : result.outcome === 'saved' ? 'Artifact salvo.' : 'Copiado para a área de transferência.')
    } catch (reason) { if (mounted.current) setError(String(reason)) }
    finally { busy.current = false; if (mounted.current) setPending(false) }
  }
  return <>
    <div className="continuum-export-actions" aria-busy={pending}>
      <button className="continuum-icon-button" aria-label="Copiar" title="Copiar" disabled={pending} onClick={() => execute('copy')}><Copy size={16} aria-hidden="true" /></button>
      <button className="continuum-icon-button" aria-label="Salvar como…" title="Salvar como…" disabled={pending} onClick={() => execute('save')}><Download size={16} aria-hidden="true" /></button>
    </div>
    {message && <p className="continuum-export-feedback" role="status">{message}</p>}
    {error && <p className="continuum-export-feedback" role="alert">{error}</p>}
  </>
}

function Inspector({ artifact, repositoryId, preview }: { artifact: ContinuumDetail; repositoryId: string; preview: boolean }) {
  return <>
    <div className="continuum-detail-heading"><FileText size={24} /><h3>{String(artifact.metadata.name)}</h3></div>
    <p className="continuum-identity">{artifact.artifactId}</p>
    {preview && artifact.metadata.kind === 'VISUAL_REFERENCE' && <VisualPreview key={`${repositoryId}:${artifact.artifactId}`} repositoryId={repositoryId} artifactId={artifact.artifactId} />}
    <dl className="continuum-metadata">
      {Object.entries(artifact.metadata).filter(([key]) => key !== 'name').map(([key, value]) =>
        <div key={key}><dt>{key}</dt><dd>{typeof value === 'object' ? <pre>{JSON.stringify(value, null, 2)}</pre> : String(value)}</dd></div>)}
      <div><dt>Revisão</dt><dd>{artifact.revision}</dd></div>
      <div><dt>Criado em</dt><dd>{timestamp(artifact.createdAt)}</dd></div>
      <div><dt>Atualizado em</dt><dd>{timestamp(artifact.updatedAt)}</dd></div>
    </dl>
    <div className="continuum-markdown"><Markdown options={{ disableParsingRawHTML: true }}>{artifact.body}</Markdown></div>
  </>
}

export function ContinuumView({ activeProject, artifactIntent }: { activeProject: ActiveProject | null; artifactIntent?: { repositoryId: string; artifactId: string } | null }) {
  const path = activeProject?.path ?? null
  const root = useRef<HTMLDivElement>(null)
  const [bundleSlug, setBundleSlug] = useState<string | null>(null)
  const [bundleSelection, setBundleSelection] = useState<{ selected: ContinuumSelectedArtifact[]; intent: 'copy' | 'zip' } | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [tags, setTags] = useState<ContinuumTag[]>([])
  const [tag, setTag] = useState<string | undefined>()
  const [tagManager, setTagManager] = useState(false)
  const [tagTokens, setTagTokens] = useState<Record<string, number>>({})

  const [markdownDraft, setMarkdownDraft] = useState<{ repositoryId: string; fileName: string; rawMarkdown: string } | null>(null)
  const [view, setView] = useState<'timeline' | 'graph'>('timeline')
  const [repositoryId, setRepositoryId] = useState<string | null>(null)
  const [facets, setFacets] = useState<ContinuumFacet[]>([])
  const [items, setItems] = useState<ContinuumItem[]>([])
  const [query, setQuery] = useState('')
  const [metadata, setMetadata] = useState<Record<string, ContinuumScalar>>({})
  const [periods, setPeriods] = useState<Record<string, ContinuumPeriod>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [artifact, setArtifact] = useState<ContinuumDetail | null>(null)
  const [cursor, setCursor] = useState<string | undefined>()
  const [listLoading, setLoading] = useState(false)
  const [facetsLoading, setFacetsLoading] = useState(false)

  const loading = listLoading || facetsLoading
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const bulkRequest = useMemo(() => repositoryId ? { repositoryId, query, metadata, periods, ...(tag ? { tag } : {}) } : null, [repositoryId, query, metadata, periods, tag])
  const bulk = useContinuumSelection(bulkRequest, `${path}:${refresh}`)
  const bulkContext = JSON.stringify([bulkRequest, path, refresh]), bulkContextRef = useRef(bulkContext)
  bulkContextRef.current = bulkContext
  useEffect(() => { setBundleSelection(null); setBulkBusy(false) }, [bulkContext])
  const bulkPending = bulkBusy || bulk.pending
  useEffect(() => { root.current?.querySelectorAll<HTMLElement>('.continuum-header, .continuum-context, .continuum-inspector, .continuum-view-switch').forEach(element => { element.inert = bulkPending }) }, [bulkPending])
  useEffect(() => setTagTokens({}), [repositoryId, refresh])
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const listGeneration = useRef(0)
  const listReadyGeneration = useRef<number | null>(null)
  const paginationKey = `${bulkContext}:${view}`
  const pagination = useRef({ key: paginationKey, inFlight: false, cursors: new Set<string>() })
  if (pagination.current.key !== paginationKey) pagination.current = { key: paginationKey, inFlight: false, cursors: new Set<string>() }
  const [pageState, setPageState] = useState<{ scope: object; pending: boolean; error: string } | null>(null)
  const currentPage = pageState?.scope === pagination.current ? pageState : null
  const currentPath = useRef(path)
  const boundPath = useRef<string | null>(null)
  currentPath.current = path
  const fileInput = useRef<HTMLInputElement>(null)
  const visualInput = useRef<HTMLInputElement>(null)
  const publicationGeneration = useRef(0)
  const [visualDraft, setVisualDraft] = useState<{ file: File; repositoryId: string; path: string; generation: number } | null>(null)
  const [visualName, setVisualName] = useState('')
  const [visualDescription, setVisualDescription] = useState('')
  const [visualContext, setVisualContext] = useState('')
  const [visualRelation, setVisualRelation] = useState('')
  const publicationContext = useRef<{ repositoryId: string; path: string } | null>(null)
  const publicationBusy = useRef(false)
  const [publishing, setPublishing] = useState(false)
  const [publicationMessage, setPublicationMessage] = useState('')
  const [publicationError, setPublicationError] = useState('')
  const [publishedVisualId, setPublishedVisualId] = useState<string | null>(null)
  const [revealId, setRevealId] = useState<string | null>(null)
  const timelineScroll = useRef<HTMLDivElement>(null)
  const pageSentinel = useRef<HTMLDivElement>(null)
  const enqueueThumbnail = useMemo(() => thumbnailQueue(), [])
  const columns = useContinuumColumns(path)

  const chooseMarkdown = () => {
    if (!repositoryId || !path || publicationBusy.current) return
    publicationContext.current = { repositoryId, path }
    fileInput.current?.click()
  }
  const chooseVisual = () => {
    if (!repositoryId || !path || publicationBusy.current) return
    publicationContext.current = { repositoryId, path }
    visualInput.current?.click()
  }
  const selectVisual = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0], context = publicationContext.current
    event.target.value = ''
    if (!file || !context || context.path !== currentPath.current) return
    setPublicationError(''); setPublicationMessage('')
    if (!/\.webp$/i.test(file.name) || file.size > 4 * 1024 * 1024) { setPublicationError('Selecione um WebP lossless de até 4 MiB.'); return }
    setVisualName(file.name.replace(/\.webp$/i, '')); setVisualDescription(''); setVisualContext(''); setVisualRelation('')
    setVisualDraft({ file, ...context, generation: publicationGeneration.current })
  }
  const publishVisual = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!visualDraft || publicationBusy.current) return
    publicationBusy.current = true; setPublishing(true); setPublicationError(''); setPublicationMessage('')
    try {
      const data = new Uint8Array(await visualDraft.file.arrayBuffer())
      if (visualDraft.generation !== publicationGeneration.current || visualDraft.path !== currentPath.current || visualDraft.repositoryId !== repositoryId) throw new Error('O repositório ativo mudou. Selecione o arquivo novamente.')
      const receipt = await window.codeAwareness.publishContinuumVisual({ repositoryId: visualDraft.repositoryId, name: visualName, description: visualDescription, context: visualContext, data,
        relations: visualRelation ? [{ artifactId: visualRelation, kind: 'related-to' }] : [] })
      if (visualDraft.generation === publicationGeneration.current && visualDraft.path === currentPath.current) {
        setVisualDraft(null); setSelectedId(receipt.artifactId); setInspectorOpen(true)
        setPublishedVisualId(receipt.artifactId); setRevealId(receipt.artifactId); setRefresh(value => value + 1)
        setPublicationMessage(`Artifact publicado: ${receipt.artifactId}.`)
      }
    } catch (reason) { setPublicationError(String(reason)) }
    finally { publicationBusy.current = false; setPublishing(false) }
  }

  const confirmMarkdownTags = async () => {
    if (!markdownDraft || publishing || markdownDraft.repositoryId !== repositoryId) return
    setPublishing(true); setPublicationError('')
    try {
      await window.codeAwareness.publishContinuumArtifact({ ...markdownDraft, confirmedTags: true })
      if (currentPath.current === path) { setMarkdownDraft(null); setPublicationMessage('Artifact publicado com tags confirmadas.'); setRefresh(value => value + 1) }
    } catch (reason) { setPublicationError(String(reason)) }
    finally { setPublishing(false) }
  }
  const publishMarkdown = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || publicationBusy.current) return
    const context = publicationContext.current
    publicationBusy.current = true
    setPublishing(true); setPublicationMessage(''); setPublicationError('')
    try {
      if (!/\.md$/i.test(file.name)) throw new Error('Selecione um arquivo .md.')
      let rawMarkdown: string
      try {
        rawMarkdown = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer())
      } catch { throw new Error('Não foi possível ler o arquivo como UTF-8 válido.') }
      if (!context || context.path !== currentPath.current) throw new Error('O repositório ativo mudou. Selecione o arquivo novamente.')
      let receipt
      try { receipt = await window.codeAwareness.publishContinuumArtifact({ repositoryId: context.repositoryId, fileName: file.name, rawMarkdown }) }
      catch (reason) {
        if (String(reason).includes('TAGS_CONFIRMATION_REQUIRED') && currentPath.current === path) { setMarkdownDraft({ repositoryId: context.repositoryId, fileName: file.name, rawMarkdown }); setPublicationMessage(String(reason)); return }
        throw reason
      }
      setPublicationMessage(`Artifact publicado: ${receipt.artifactId}. A busca e os filtros ativos podem ocultá-lo na timeline.`)
    } catch (reason) { setPublicationError(String(reason)) }
    finally { publicationBusy.current = false; setPublishing(false) }
  }

  useEffect(() => {
    setRepositoryId(null); setFacets([]); setItems([]); setMetadata({}); setPeriods({}); setTag(undefined); setQuery('')
    setSelectedId(null); setArtifact(null); setCursor(undefined); setError(''); setInspectorOpen(false)
    setLoading(false); setFacetsLoading(false)
    publicationGeneration.current++; setVisualDraft(null); publicationContext.current = null
    setPublishedVisualId(null); setRevealId(null); setPublicationMessage(''); setPublicationError('')
    listGeneration.current++
  }, [path])

  useEffect(() => {
    if (repositoryId && artifactIntent?.repositoryId === repositoryId) { setSelectedId(artifactIntent.artifactId); setInspectorOpen(true) }
  }, [repositoryId, artifactIntent])

  useEffect(() => {
    let cancelled = false
    if (repositoryId && window.codeAwareness.getContinuumTags) window.codeAwareness.getContinuumTags(repositoryId).then(result => {
      if (!cancelled && currentPath.current === path && result.repositoryId === repositoryId) {
        setTags(result.tags); setTag(previous => previous && !result.tags.some(tag => tag.slug === previous) ? undefined : previous)
      }
    }).catch(reason => { if (!cancelled) setError(String(reason)) })
    return () => { cancelled = true }
  }, [repositoryId, refresh])

  useEffect(() => window.codeAwareness.onContinuumChanged(() => setRefresh(value => value + 1)), [])

  useEffect(() => {
    let cancelled = false
    if (!path) return
    setFacetsLoading(true)
    window.codeAwareness.getContinuumFacets(path).then(result => {
      if (cancelled || currentPath.current !== path) return
      boundPath.current = path
      setRepositoryId(result.repositoryId); setFacets(result.facets); setError('')
      setMetadata(previous => {
        const valid = Object.fromEntries(Object.entries(previous).filter(([key, value]) =>
          result.facets.some(facet => facet.key === key && facet.values.some(entry => entry.value === value))))
        return Object.keys(valid).length === Object.keys(previous).length ? previous : valid
      })
      setPeriods(previous => {
        const valid = Object.fromEntries(Object.entries(previous).filter(([key, period]) => result.facets.some(facet =>
          facet.key === key && facet.years?.some(year => year.year === period.year &&
            (period.month === undefined || year.months.some(month => month.month === period.month))))))
        return Object.keys(valid).length === Object.keys(previous).length ? previous : valid
      })
      if (!result.repositoryId) { setItems([]); setSelectedId(null); setArtifact(null); setCursor(undefined) }
    }).catch(reason => { if (!cancelled) { setError(String(reason)); setRepositoryId(null); setFacets([]); setItems([]); setArtifact(null) } })
      .finally(() => { if (!cancelled) setFacetsLoading(false) })
    return () => { cancelled = true }
  }, [path, refresh])

  useEffect(() => {
    const generation = ++listGeneration.current
    listReadyGeneration.current = null
    let cancelled = false
    setItems([]); setCursor(undefined)
    if (!repositoryId) return
    setLoading(true)
    window.codeAwareness.listContinuumArtifacts({ repositoryId, query, metadata, ...(tag ? { tag } : {}), ...(Object.keys(periods).length ? { periods } : {}) }).then(result => {
      if (cancelled || currentPath.current !== path || generation !== listGeneration.current) return
      listReadyGeneration.current = result.repositoryId === repositoryId ? generation : null
      setItems(result.repositoryId === repositoryId ? result.artifacts : [])
      setCursor(result.nextCursor); setError('')
    }).catch(reason => { if (!cancelled) setError(String(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; listReadyGeneration.current = null; listGeneration.current++ }
  }, [repositoryId, query, metadata, periods, tag, refresh])

  useEffect(() => {
    let cancelled = false
    setArtifact(null); setDetailError(''); setDetailLoading(false)
    if (!repositoryId || !selectedId) return
    setDetailLoading(true)
    window.codeAwareness.getContinuumArtifact(repositoryId, selectedId).then(result => {
      if (!cancelled && currentPath.current === path) setArtifact(result.repositoryId === repositoryId ? result.artifact : null)
    }).catch(reason => { if (!cancelled) setDetailError(String(reason)) })
      .finally(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [repositoryId, selectedId, refresh])

  const choosePeriod = (key: string, period: ContinuumPeriod) => {
    setMetadata(previous => { const next = { ...previous }; delete next[key]; return next })
    setPeriods(previous => {
      const next = { ...previous }
      if (previous[key]?.year === period.year && previous[key]?.month === period.month) delete next[key]
      else next[key] = period
      return next
    })
  }

  const loadMore = async (retry = false) => {
    const scope = pagination.current
    if (!repositoryId || !cursor || loading || bulkPending || view !== 'timeline' || scope.inFlight ||
      listReadyGeneration.current !== listGeneration.current || (currentPage?.error && !retry)) return
    const generation = listGeneration.current
    scope.inFlight = true; scope.cursors.add(cursor)
    setPageState({ scope, pending: true, error: '' })
    try {
      const result = await window.codeAwareness.listContinuumArtifacts({ repositoryId, query, metadata, ...(tag ? { tag } : {}), ...(Object.keys(periods).length ? { periods } : {}), cursor })
      if (scope !== pagination.current || generation !== listGeneration.current) return
      if (result.repositoryId !== repositoryId) throw new Error('O contexto do repositório mudou; atualize a Timeline.')
      const ids = new Set(items.map(item => item.artifactId))
      const added = result.artifacts.filter(item => { if (ids.has(item.artifactId)) return false; ids.add(item.artifactId); return true })
      if ((result.nextCursor && (scope.cursors.has(result.nextCursor) || !added.length)) || (result.artifacts.length && !added.length)) throw new Error('A paginação não avançou. Tente novamente para obter a próxima página.')
      setItems(previous => [...previous, ...added])
      setCursor(result.nextCursor)
    } catch (reason) {
      if (scope === pagination.current && generation === listGeneration.current) setPageState({ scope, pending: false, error: String(reason) })
    } finally {
      scope.inFlight = false
      if (scope === pagination.current && generation === listGeneration.current) setPageState(previous => previous?.scope === scope ? { ...previous, pending: false } : previous)
    }
  }

  useEffect(() => {
    if (view !== 'timeline' || !repositoryId || !cursor || loading || bulkPending || currentPage?.pending || currentPage?.error ||
      listReadyGeneration.current !== listGeneration.current || !timelineScroll.current || !pageSentinel.current) return
    const scope = pagination.current
    let observing = true
    const observer = new IntersectionObserver(entries => {
      if (observing && scope === pagination.current && entries.some(entry => entry.isIntersecting)) void loadMore()
    }, { root: timelineScroll.current, rootMargin: '240px 0px', threshold: 0 })
    observer.observe(pageSentinel.current)
    return () => { observing = false; observer.disconnect() }
  }, [paginationKey, repositoryId, cursor, loading, bulkPending, currentPage?.pending, currentPage?.error, items])

  useEffect(() => {
    if (!revealId || loading) return
    const row = Array.from(timelineScroll.current?.querySelectorAll<HTMLButtonElement>('[data-artifact-id]') ?? []).find(element => element.dataset.artifactId === revealId)
    if (row) { row.scrollIntoView({ block: 'nearest' }); setRevealId(null) }
  }, [revealId, items, loading])

  return <div className="continuum-view" ref={root}>
    <header className="continuum-header">
      <div className="continuum-feature-icon"><Infinity size={36} /></div>
      <div className="continuum-feature-title"><h1>CONTINUUM</h1><p>{activeProject?.name ?? 'Contexto durável do repositório'}</p></div>
      <button className="continuum-publish" disabled={!repositoryId} onClick={() => setTagManager(true)}><Tags size={16} /> Tags e pacotes</button>
      <SearchBox value={query} onChange={setQuery} placeholder="Buscar no Continuum…" ariaLabel="Buscar no Continuum" />
      <button className="continuum-publish" disabled={!path || !repositoryId || publishing} onClick={chooseMarkdown}>{publishing ? 'Publicando…' : 'Publicar Markdown'}</button>
      <input ref={fileInput} type="file" accept=".md" hidden aria-label="Arquivo Markdown" onChange={publishMarkdown} />
      <button className="continuum-publish" disabled={!path || !repositoryId || publishing} onClick={chooseVisual}>Publicar WebP</button>
      <input ref={visualInput} type="file" accept=".webp,image/webp" hidden aria-label="Arquivo WebP" onChange={selectVisual} />
    </header>
    {markdownDraft && <div className="continuum-tag-confirmation"><p>Publicar {markdownDraft.fileName} com as tags canônicas declaradas no YAML?</p><button disabled={publishing} onClick={confirmMarkdownTags}>Confirmar tags do Markdown</button><button disabled={publishing} onClick={() => setMarkdownDraft(null)}>Cancelar</button></div>}
    {bundleSlug && repositoryId && <ContinuumBundleComposer key={`${repositoryId}:${bundleSlug}`} repositoryId={repositoryId} slug={bundleSlug} onClose={() => setBundleSlug(null)} />}
    {bundleSelection && repositoryId && <ContinuumBundleComposer key={`${bulkContext}:selection`} repositoryId={repositoryId} source={{ kind: 'selection', selected: bundleSelection.selected }} preferredIntent={bundleSelection.intent} onClose={() => setBundleSelection(null)} />}
    {tagManager && repositoryId && <ContinuumTagManager key={repositoryId} repositoryId={repositoryId} tags={tags} onTokenTotals={totals => setTagTokens(previous => ({ ...previous, ...Object.fromEntries(totals.map(total => [total.slug, total.rawMarkdownTokenCount])) }))} onBundle={slug => { setBundleSlug(slug); setTagManager(false) }} onFilter={slug => { setTag(slug); setTagManager(false) }} onChanged={() => { setRefresh(value => value + 1) }} onClose={() => setTagManager(false)} />}
    {visualDraft && <form className="continuum-visual-publication" onSubmit={publishVisual}>
      <strong>{visualDraft.file.name}</strong>
      <label>Nome<input required value={visualName} onChange={event => setVisualName(event.target.value)} disabled={publishing} /></label>
      <label>Descrição<input required value={visualDescription} onChange={event => setVisualDescription(event.target.value)} disabled={publishing} /></label>
      <label>Contexto<textarea required value={visualContext} onChange={event => setVisualContext(event.target.value)} disabled={publishing} /></label>
      <label>Relacionar a um Artifact<select value={visualRelation} onChange={event => setVisualRelation(event.target.value)} disabled={publishing}>
        <option value="">Sem relação</option>{items.map(item => <option key={item.artifactId} value={item.artifactId}>{item.name}</option>)}
      </select></label>
      <div><button type="submit" disabled={publishing}>{publishing ? 'Publicando…' : 'Publicar referência'}</button><button type="button" disabled={publishing} onClick={() => setVisualDraft(null)}>Cancelar</button></div>
    </form>}
    {publicationMessage && <div className="continuum-publication-feedback" role="status">{publicationMessage}
      {publishedVisualId && !loading && !items.some(item => item.artifactId === publishedVisualId) && <>
        <span> A busca ou os filtros podem ocultar a referência.</span>
        <button onClick={() => { setQuery(''); setMetadata({}); setPeriods({}); setRevealId(publishedVisualId); setRefresh(value => value + 1) }}>Exibir na timeline</button>
      </>}
    </div>}
    {publicationError && <div className="continuum-publication-feedback" role="alert">{publicationError}</div>}
    {!path ? <div className="continuum-empty"><Infinity size={38} /><h2>Nenhum repositório ativo</h2><p>Abra um repositório para consultar seu Continuum.</p></div> : <>
      {error && <div className="continuum-error" role="alert">{error}<button onClick={() => setRefresh(value => value + 1)}>Tentar novamente</button></div>}
      <div className="continuum-workspace" ref={columns.workspace} style={columns.style}>
        <aside className="continuum-pane continuum-context" aria-label="Context">
          <div className="continuum-pane-heading"><h2>Context</h2><button className="continuum-icon-button" aria-label="Limpar" title="Limpar" disabled={!Object.keys(metadata).length && !Object.keys(periods).length && !tag} onClick={() => { setMetadata({}); setPeriods({}); setTag(undefined) }}><FilterX size={16} aria-hidden="true" /></button></div>
          <div className="continuum-pane-scroll">
            {repositoryId && boundPath.current === path && <ContextFilters tagTokens={tagTokens} key={`${path}:${repositoryId}`} repositoryId={repositoryId} facets={[...facets, ...(tags.length ? [{ key: 'tags', values: tags.map(tag => ({ value: tag.slug, count: tag.count })) }] : [])]} metadata={{ ...metadata, ...(tag ? { tags: tag } : {}) }} periods={periods}
              choosePeriod={choosePeriod}
              chooseValue={(key, value) => { if (key === 'tags') { setTag(previous => previous === value ? undefined : String(value)); return }; setPeriods(previous => { const next = { ...previous }; delete next[key]; return next }); setMetadata(previous => { const next = { ...previous }; if (previous[key] === value) delete next[key]; else next[key] = value; return next }) }}
              remove={key => { if (key === 'tags') { setTag(undefined); return }; setMetadata(previous => { const next = { ...previous }; delete next[key]; return next }); setPeriods(previous => { const next = { ...previous }; delete next[key]; return next }) }} />}
            {!loading && !facets.length && <p className="continuum-hint">Nenhuma metadata disponível.</p>}
          </div>
        </aside>
        <div className="continuum-resizer continuum-context-resizer"><ColumnResizer onDrag={columns.dragContext} onDragEnd={columns.persist} /></div>
        <section className="continuum-pane continuum-timeline" aria-label="Continuum">
          <div className="continuum-pane-heading"><h2>Continuum</h2><div className="continuum-view-switch" role="tablist" aria-label="Visualização do Continuum">
            {(['timeline', 'graph'] as const).map(mode => <button key={mode} role="tab" tabIndex={view === mode ? 0 : -1} aria-selected={view === mode} onClick={() => setView(mode)} onKeyDown={event => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              event.preventDefault(); setView(mode === 'timeline' ? 'graph' : 'timeline')
              const buttons = event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('button')
              buttons[mode === 'timeline' ? 1 : 0].focus()
            }}>{mode === 'timeline' ? 'Timeline' : 'Graph'}</button>)}
          </div></div>
          {view === 'graph' && repositoryId && boundPath.current === path && <React.Suspense fallback={<p role="status">Carregando Graph…</p>}><ContinuumGraph key={`${path}:${repositoryId}`} repositoryId={repositoryId} query={query} tag={tag} metadata={metadata} periods={periods} refresh={refresh} selectedId={selectedId} onSelect={id => { setSelectedId(id); setInspectorOpen(true) }} /></React.Suspense>}
          {view === 'timeline' && repositoryId && <>
            <div className="continuum-selection-controls"><button disabled={bulkPending || loading} onClick={() => bulk.replace([...new Map([...bulk.selected, ...items].map(item => [item.artifactId, item])).values()])}>Selecionar carregados</button><button disabled={bulkPending || loading} onClick={() => void bulk.all()}>Selecionar todos os resultados do filtro</button></div>
            {bulk.error && <p role="alert" className="continuum-hint">{bulk.error}</p>}
            {bulk.pending && <p role="status">Resolvendo seleção…</p>}
            {bulk.selected.length > 0 && <ContinuumBulkActions disabled={bulk.pending} key={bulkContext} repositoryId={repositoryId} selected={bulk.selected} tags={tags} onClear={bulk.clear} onChanged={() => setRefresh(value => value + 1)} onBusy={value => { if (bulkContextRef.current === bulkContext) setBulkBusy(value) }} onBundle={(selected, intent) => setBundleSelection({ selected, intent })} />}
          </>}
          <div className="continuum-pane-scroll" hidden={view !== 'timeline'} aria-busy={loading} ref={timelineScroll}>
            {loading && <p role="status" className="continuum-hint">Carregando artifacts…</p>}
            {items.map((item, index) => <React.Fragment key={`${repositoryId}:${item.artifactId}`}>
              {(index === 0 || new Date(items[index - 1].updatedAt).toDateString() !== new Date(item.updatedAt).toDateString()) &&
                <div className="continuum-date">{new Date(item.updatedAt).toLocaleDateString(undefined, { dateStyle: 'long' })}</div>}
              <div className="continuum-selectable-row"><input type="checkbox" aria-label={`Selecionar ${item.name}`} disabled={bulkPending} checked={bulk.selected.some(source => source.artifactId === item.artifactId)} onChange={() => bulk.toggle(item)} />
              <button data-artifact-id={item.artifactId} className={`continuum-item${selectedId === item.artifactId ? ' selected' : ''}`} aria-pressed={selectedId === item.artifactId}
                onClick={() => { setSelectedId(item.artifactId); setInspectorOpen(true) }}>
                <span className="continuum-node" />{item.kind === 'VISUAL_REFERENCE' && repositoryId
                  ? <VisualThumbnail repositoryId={repositoryId} artifactId={item.artifactId} root={timelineScroll} enqueue={enqueueThumbnail} /> : <FileText size={19} />}
                <span className="continuum-item-content"><strong>{item.name}</strong><span className="continuum-badge">{item.kind === 'VISUAL_REFERENCE' ? <><ImageIcon size={13} aria-hidden="true" /> Referência visual</> : item.kind}</span>
                  {item.description && <span className="continuum-description">{item.description}</span>}<time dateTime={item.updatedAt}>{timestamp(item.updatedAt)}</time>
                  <small title="Estimativa cl100k_base do Markdown literal integral, incluindo YAML. Referências visuais contam apenas texto, sem pixels.">{item.rawMarkdownTokenCount === undefined ? 'Tokens indisponíveis' : `≈ ${item.rawMarkdownTokenCount.toLocaleString()} tokens${item.kind === 'VISUAL_REFERENCE' ? ' de texto' : ''}`}</small></span>
              </button></div>
            </React.Fragment>)}
            {!loading && !items.length && <div className="continuum-empty"><Infinity size={32} /><h3>{repositoryId ? 'Nenhum artifact encontrado' : 'Continuum indisponível'}</h3><p>{query || Object.keys(metadata).length || Object.keys(periods).length ? 'Ajuste a busca ou os filtros.' : 'O contexto deste repositório aparecerá aqui.'}</p></div>}
            {currentPage?.pending && <p className="continuum-pagination-status" role="status">Carregando mais…</p>}
            {currentPage?.error && <div className="continuum-pagination-status" role="alert">{currentPage.error}<button disabled={bulkPending} onClick={() => void loadMore(true)}>Tentar novamente</button></div>}
            {cursor && <div ref={pageSentinel} className="continuum-page-sentinel" aria-hidden="true" />}
          </div>
        </section>
        <div className="continuum-resizer continuum-inspector-resizer"><ColumnResizer onDrag={columns.dragInspector} onDragEnd={columns.persist} /></div>
        <aside className={`continuum-pane continuum-inspector${inspectorOpen ? ' open' : ''}`} aria-label="Inspector">
          <div className="continuum-pane-heading"><h2>Inspector</h2>{artifact && artifact.artifactId === selectedId && repositoryId && !detailLoading && boundPath.current === path && <div className="continuum-inspector-actions"><ArtifactTagEditor key={`tags:${repositoryId}:${artifact.artifactId}:${artifact.revision}`} repositoryId={repositoryId} artifact={artifact} tags={tags} onChanged={() => setRefresh(value => value + 1)} /><ExportActions key={`export:${repositoryId}:${artifact.artifactId}:${artifact.revision}`} repositoryId={repositoryId} artifactId={artifact.artifactId} /></div>}<button className="continuum-close" aria-label="Fechar inspector" onClick={() => setInspectorOpen(false)}><X size={17} /></button></div>
          <div className="continuum-pane-scroll" aria-busy={detailLoading}>
            {detailError && <p role="alert">{detailError}</p>}
            {detailLoading ? <p role="status" className="continuum-hint">Carregando artifact…</p> : artifact && artifact.artifactId === selectedId && repositoryId && boundPath.current === path ? <Inspector artifact={artifact} repositoryId={repositoryId} preview={inspectorOpen} /> :
              <div className="continuum-empty"><FileText size={32} /><h3>Nenhum artifact selecionado</h3><p>Selecione um artifact para ler seu conteúdo e metadata.</p></div>}
          </div>
        </aside>
      </div>
    </>}
  </div>
}
