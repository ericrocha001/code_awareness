import React, { useEffect, useRef, useState } from 'react'
import { Infinity, FileText, X } from 'lucide-react'
import Markdown from 'markdown-to-jsx'
import type { ActiveProject } from '../../../../shared/types/active-project-types'
import type { ContinuumDetail, ContinuumFacet, ContinuumItem, ContinuumScalar } from '../../../../shared/types/continuum-ui-types'
import { SearchBox } from '../shared/SearchBox/SearchBox'
import { ColumnResizer } from '../shared/ColumnResizer/ColumnResizer'
import { useContinuumColumns } from './useContinuumColumns'
import './ContinuumView.css'

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

export function ContinuumView({ activeProject }: { activeProject: ActiveProject | null }) {
  const [repositoryId, setRepositoryId] = useState<string | null>(null)
  const [facets, setFacets] = useState<ContinuumFacet[]>([])
  const [items, setItems] = useState<ContinuumItem[]>([])
  const [query, setQuery] = useState('')
  const [metadata, setMetadata] = useState<Record<string, ContinuumScalar>>({})
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
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const listGeneration = useRef(0)
  const path = activeProject?.path ?? null
  const currentPath = useRef(path)
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
        setPublicationMessage(`Artifact publicado: ${receipt.artifactId}. A busca e os filtros ativos podem ocultá-lo na timeline.`)
      }
    } catch (reason) { setPublicationError(String(reason)) }
    finally { publicationBusy.current = false; setPublishing(false) }
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
      const receipt = await window.codeAwareness.publishContinuumArtifact({ repositoryId: context.repositoryId, fileName: file.name, rawMarkdown })
      setPublicationMessage(`Artifact publicado: ${receipt.artifactId}. A busca e os filtros ativos podem ocultá-lo na timeline.`)
    } catch (reason) { setPublicationError(String(reason)) }
    finally { publicationBusy.current = false; setPublishing(false) }
  }

  useEffect(() => {
    setRepositoryId(null); setFacets([]); setItems([]); setMetadata({}); setQuery('')
    setSelectedId(null); setArtifact(null); setCursor(undefined); setError(''); setInspectorOpen(false)
    setLoading(false); setFacetsLoading(false)
    publicationGeneration.current++; setVisualDraft(null); publicationContext.current = null
    listGeneration.current++
  }, [path])

  useEffect(() => window.codeAwareness.onContinuumChanged(() => setRefresh(value => value + 1)), [])

  useEffect(() => {
    let cancelled = false
    if (!path) return
    setFacetsLoading(true)
    window.codeAwareness.getContinuumFacets(path).then(result => {
      if (cancelled) return
      setRepositoryId(result.repositoryId); setFacets(result.facets); setError('')
      setMetadata(previous => {
        const valid = Object.fromEntries(Object.entries(previous).filter(([key, value]) =>
          result.facets.some(facet => facet.key === key && facet.values.some(entry => entry.value === value))))
        return Object.keys(valid).length === Object.keys(previous).length ? previous : valid
      })
      if (!result.repositoryId) { setItems([]); setSelectedId(null); setArtifact(null); setCursor(undefined) }
    }).catch(reason => { if (!cancelled) { setError(String(reason)); setRepositoryId(null); setFacets([]); setItems([]); setArtifact(null) } })
      .finally(() => { if (!cancelled) setFacetsLoading(false) })
    return () => { cancelled = true }
  }, [path, refresh])

  useEffect(() => {
    const generation = ++listGeneration.current
    let cancelled = false
    setItems([]); setCursor(undefined)
    if (!repositoryId) return
    setLoading(true)
    window.codeAwareness.listContinuumArtifacts({ repositoryId, query, metadata }).then(result => {
      if (cancelled || generation !== listGeneration.current) return
      setItems(result.repositoryId === repositoryId ? result.artifacts : [])
      setCursor(result.nextCursor); setError('')
    }).catch(reason => { if (!cancelled) setError(String(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [repositoryId, query, metadata, refresh])

  useEffect(() => {
    let cancelled = false
    setArtifact(null); setDetailError(''); setDetailLoading(false)
    if (!repositoryId || !selectedId) return
    setDetailLoading(true)
    window.codeAwareness.getContinuumArtifact(repositoryId, selectedId).then(result => {
      if (!cancelled) setArtifact(result.repositoryId === repositoryId ? result.artifact : null)
    }).catch(reason => { if (!cancelled) setDetailError(String(reason)) })
      .finally(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [repositoryId, selectedId, refresh])

  const loadMore = async () => {
    if (!repositoryId || !cursor || loading) return
    const generation = listGeneration.current
    setLoading(true)
    try {
      const result = await window.codeAwareness.listContinuumArtifacts({ repositoryId, query, metadata, cursor })
      if (generation !== listGeneration.current || result.repositoryId !== repositoryId) return
      setItems(previous => [...previous, ...result.artifacts.filter(item => !previous.some(old => old.artifactId === item.artifactId))])
      setCursor(result.nextCursor); setError('')
    } catch (reason) { if (generation === listGeneration.current) setError(String(reason)) }
    finally { if (generation === listGeneration.current) setLoading(false) }
  }

  return <div className="continuum-view">
    <header className="continuum-header">
      <div className="continuum-feature-icon"><Infinity size={36} /></div>
      <div className="continuum-feature-title"><h1>CONTINUUM</h1><p>{activeProject?.name ?? 'Contexto durável do repositório'}</p></div>
      <SearchBox value={query} onChange={setQuery} placeholder="Buscar no Continuum…" ariaLabel="Buscar no Continuum" />
      <button className="continuum-publish" disabled={!path || !repositoryId || publishing} onClick={chooseMarkdown}>{publishing ? 'Publicando…' : 'Publicar Markdown'}</button>
      <input ref={fileInput} type="file" accept=".md" hidden aria-label="Arquivo Markdown" onChange={publishMarkdown} />
      <button className="continuum-publish" disabled={!path || !repositoryId || publishing} onClick={chooseVisual}>Publicar WebP</button>
      <input ref={visualInput} type="file" accept=".webp,image/webp" hidden aria-label="Arquivo WebP" onChange={selectVisual} />
    </header>
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
    {publicationMessage && <div className="continuum-publication-feedback" role="status">{publicationMessage}</div>}
    {publicationError && <div className="continuum-publication-feedback" role="alert">{publicationError}</div>}
    {!path ? <div className="continuum-empty"><Infinity size={38} /><h2>Nenhum repositório ativo</h2><p>Abra um repositório para consultar seu Continuum.</p></div> : <>
      {error && <div className="continuum-error" role="alert">{error}<button onClick={() => setRefresh(value => value + 1)}>Tentar novamente</button></div>}
      <div className="continuum-workspace" ref={columns.workspace} style={columns.style}>
        <aside className="continuum-pane continuum-context" aria-label="Context">
          <div className="continuum-pane-heading"><h2>Context</h2><button disabled={!Object.keys(metadata).length} onClick={() => setMetadata({})}>Limpar</button></div>
          <div className="continuum-pane-scroll">
            {facets.map(facet => <details key={facet.key} open><summary title={facet.key}>{facet.key}</summary>
              <div className="continuum-facet-values">{facet.values.map(entry => {
                const selected = metadata[facet.key] === entry.value
                return <button key={JSON.stringify(entry.value)} aria-pressed={selected} title={`${typeof entry.value}: ${String(entry.value)}`}
                  onClick={() => setMetadata(previous => { const next = { ...previous }; if (selected) delete next[facet.key]; else next[facet.key] = entry.value; return next })}>
                  <span>{String(entry.value)}</span><small>{entry.count}</small></button>
              })}</div>
            </details>)}
            {!loading && !facets.length && <p className="continuum-hint">Nenhuma metadata disponível.</p>}
          </div>
        </aside>
        <div className="continuum-resizer continuum-context-resizer"><ColumnResizer onDrag={columns.dragContext} onDragEnd={columns.persist} /></div>
        <section className="continuum-pane continuum-timeline" aria-label="Continuum">
          <div className="continuum-pane-heading"><h2>Continuum</h2><span>{items.length} artifacts{cursor ? '+' : ''}</span></div>
          <div className="continuum-pane-scroll" aria-busy={loading}>
            {loading && <p role="status" className="continuum-hint">Carregando artifacts…</p>}
            {items.map((item, index) => <React.Fragment key={item.artifactId}>
              {(index === 0 || new Date(items[index - 1].updatedAt).toDateString() !== new Date(item.updatedAt).toDateString()) &&
                <div className="continuum-date">{new Date(item.updatedAt).toLocaleDateString(undefined, { dateStyle: 'long' })}</div>}
              <button className={`continuum-item${selectedId === item.artifactId ? ' selected' : ''}`} aria-pressed={selectedId === item.artifactId}
                onClick={() => { setSelectedId(item.artifactId); setInspectorOpen(true) }}>
                <span className="continuum-node" /><FileText size={19} />
                <span className="continuum-item-content"><strong>{item.name}</strong><span className="continuum-badge">{item.kind}</span>
                  {item.description && <span className="continuum-description">{item.description}</span>}<time dateTime={item.updatedAt}>{timestamp(item.updatedAt)}</time></span>
              </button>
            </React.Fragment>)}
            {!loading && !items.length && <div className="continuum-empty"><Infinity size={32} /><h3>{repositoryId ? 'Nenhum artifact encontrado' : 'Continuum indisponível'}</h3><p>{query || Object.keys(metadata).length ? 'Ajuste a busca ou os filtros.' : 'O contexto deste repositório aparecerá aqui.'}</p></div>}
            {cursor && <button className="continuum-load-more" disabled={loading} onClick={loadMore}>Carregar mais</button>}
          </div>
        </section>
        <div className="continuum-resizer continuum-inspector-resizer"><ColumnResizer onDrag={columns.dragInspector} onDragEnd={columns.persist} /></div>
        <aside className={`continuum-pane continuum-inspector${inspectorOpen ? ' open' : ''}`} aria-label="Inspector">
          <div className="continuum-pane-heading"><h2>Inspector</h2><button className="continuum-close" aria-label="Fechar inspector" onClick={() => setInspectorOpen(false)}><X size={17} /></button></div>
          <div className="continuum-pane-scroll" aria-busy={detailLoading}>
            {detailError && <p role="alert">{detailError}</p>}
            {detailLoading ? <p role="status" className="continuum-hint">Carregando artifact…</p> : artifact && repositoryId ? <Inspector artifact={artifact} repositoryId={repositoryId} preview={inspectorOpen} /> :
              <div className="continuum-empty"><FileText size={32} /><h3>Nenhum artifact selecionado</h3><p>Selecione um artifact para ler seu conteúdo e metadata.</p></div>}
          </div>
        </aside>
      </div>
    </>}
  </div>
}
