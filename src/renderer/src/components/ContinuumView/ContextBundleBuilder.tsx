import React, { useEffect, useRef, useState } from 'react'
import { X, Package, ArrowUp, ArrowDown } from 'lucide-react'
import { consolidateBundle, type BundleComponent, type BundleComponentSource, type BundleComposition, type BuilderPreview, type BuilderReceipt, type BundleCompressionProfile, type BundleResult } from '../../../../shared/types/continuum-builder-types'
import type { ContinuumFacet, ContinuumItem, ContinuumScalar, ContinuumPeriod } from '../../../../shared/types/continuum-ui-types'
import type { ContinuumTag } from '../../../../shared/types/continuum-tag-types'
import { ContextFilters } from './ContextFilters'
import './ContextBundleBuilder.css'

export function ContextBundleBuilder({ repositoryId, facets, tags, initial, onClose }: {
  repositoryId: string; facets: ContinuumFacet[]; tags: ContinuumTag[]; initial?: BundleComponentSource; onClose(): void
}) {
  const modal = useRef<HTMLDialogElement>(null), alive = useRef(true), busy = useRef(false), generation = useRef(0)
  const [composition, setComposition] = useState<BundleComposition>({ repositoryId, components: [], excluded: [], order: [] })
  const [tab, setTab] = useState<'build' | 'recent'>('build'), [recent, setRecent] = useState<BundleResult[]>([]), [name, setName] = useState('')
  const [entry, setEntry] = useState<'artifacts' | 'properties' | 'tags'>('artifacts')
  const [query, setQuery] = useState(''), [memberQuery, setMemberQuery] = useState('')
  const catalogQuery = useRef(query)
  catalogQuery.current = query
  const [items, setItems] = useState<ContinuumItem[]>([]), [cursor, setCursor] = useState<string>(), [loading, setLoading] = useState(false)
  const [metadata, setMetadata] = useState<Record<string, ContinuumScalar>>({}), [periods, setPeriods] = useState<Record<string, ContinuumPeriod>>({})
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [profile, setProfile] = useState<BundleCompressionProfile>('off')
  const [preview, setPreview] = useState<BuilderPreview | null>(null), [intent, setIntent] = useState<'copy' | 'markdown' | 'zip'>('copy')
  const [delta, setDelta] = useState<{ old: BundleComponent; next: BundleComponent } | null>(null)
  const [detail, setDetail] = useState<string>('')
  let members: ContinuumItem[] = [], conflict = ''
  try { members = consolidateBundle(composition) } catch (reason) { conflict = String(reason) }
  const change = (value: BundleComposition) => { generation.current++; setComposition(value); setPreview(null); setMessage(''); setDetail('') }
  const run = async (action: (current: () => boolean) => Promise<void>) => {
    if (busy.current) return
    const started = generation.current
    busy.current = true; setPending(true); setError(''); setMessage('')
    const current = () => alive.current && started === generation.current
    try { await action(current) } catch (reason) { if (current()) setError(String(reason)) }
    finally { busy.current = false; if (alive.current) setPending(false) }
  }
  const add = (source: BundleComponentSource) => run(async current => {
    const result = await window.codeAwareness.continuumBuilder({ repositoryId, action: 'resolve', source }) as BundleComponent
    if (current()) change({ ...composition, components: [...composition.components, result] })
  })
  useEffect(() => {
    alive.current = true; modal.current?.showModal()
    const previous = document.activeElement as HTMLElement | null
    if (initial) void add(initial)
    return () => { alive.current = false; generation.current++; void window.codeAwareness.continuumBuilder({ repositoryId, action: 'cancel' }).catch(() => {}); previous?.focus() }
  }, [])
  useEffect(() => {
    let cancelled = false
    setLoading(true); setItems([]); setCursor(undefined)
    window.codeAwareness.listContinuumArtifacts({ repositoryId, query }).then(result => {
      if (!cancelled && result.repositoryId === repositoryId) { setItems(result.artifacts); setCursor(result.nextCursor) }
    }).catch(reason => { if (!cancelled) setError(String(reason)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [repositoryId, query])
  const loadMore = () => run(async current => {
    const result = await window.codeAwareness.listContinuumArtifacts({ repositoryId, query, cursor })
    if (current() && catalogQuery.current === query && result.repositoryId === repositoryId) { setItems(prior => [...new Map([...prior, ...result.artifacts].map(item => [item.artifactId, item])).values()]); setCursor(result.nextCursor) }
  })
  const refresh = (component: BundleComponent) => run(async current => {
    const next = await window.codeAwareness.continuumBuilder({ repositoryId, action: 'resolve', source: component.source, refresh: true }) as BundleComponent
    if (current()) setDelta({ old: component, next })
  })
  const move = (id: string, direction: number) => {
    const order = members.map(item => item.artifactId), index = order.indexOf(id), target = index + direction
    if (target < 0 || target >= order.length) return
    ;[order[index], order[target]] = [order[target], order[index]]
    change({ ...composition, order })
  }
  const inspect = (id: string) => run(async current => {
    const result = await window.codeAwareness.getContinuumArtifact(repositoryId, id)
    if (current() && result.repositoryId === repositoryId && result.artifact) setDetail(`${result.artifact.artifactId} · revisão ${result.artifact.revision}\n${JSON.stringify(result.artifact.metadata, null, 2)}\n\n${result.artifact.body}`)
  })
  const execute = (action: 'preview' | 'export') => run(async current => {
    const result = await window.codeAwareness.continuumBuilder(action === 'preview' ? { repositoryId, action, composition, profile, intent } : { repositoryId, action, composition, profile, intent, name })
    if (!current()) return
    if (action === 'preview') setPreview(result as BuilderPreview)
    else { const receipt = result as BuilderReceipt; setMessage((receipt.outcome === 'copied' ? 'Contexto copiado.' : receipt.outcome === 'saved' ? 'Pacote salvo.' : 'Salvamento cancelado.') + (receipt.compression && receipt.compression.profile !== 'off' ? ' ' + receipt.compression.reason + ' · economia ' + receipt.compression.savedTokens + ' tokens (' + receipt.compression.savedPercent.toFixed(1) + '%).' : '') + (receipt.retentionMessage ? ' ' + receipt.retentionMessage : '')) }
  })
  const showRecent = () => run(async current => {
    const results = await window.codeAwareness.continuumBuilder({ repositoryId, action: 'recent' }) as BundleResult[]
    if (current()) { setRecent(results); setTab('recent') }
  })
  const reuse = (id: string) => run(async current => {
    const receipt = await window.codeAwareness.continuumBuilder({ repositoryId, action: 'reuse', id }) as BuilderReceipt
    if (current()) setMessage(receipt.outcome === 'cancelled' ? 'Reutilização cancelada.' : 'Resultado histórico de ' + receipt.historicalAt + ' reutilizado com os mesmos bytes. Sem verificação de vigência.')
  })
  const restore = (id: string, mode: 'members' | 'recipe') => run(async current => {
    const next = await window.codeAwareness.continuumBuilder({ repositoryId, action: 'restore', id, mode }) as BundleComposition
    if (current()) { change(next); setTab('build'); setMessage('Nova composição preparada. Revise os membros antes de gerar outro resultado; o histórico anterior foi preservado.') }
  })
  const cancel = () => { generation.current++; void window.codeAwareness.continuumBuilder({ repositoryId, action: 'cancel' }).catch(() => {}); onClose() }
  const documentTokens = members.reduce((sum, member) => sum + (member.rawMarkdownTokenCount ?? 0), 0)
  return <dialog ref={modal} className="continuum-builder" aria-label="Context Bundle Builder" onCancel={event => { event.preventDefault(); cancel() }}>
    <header><div className="continuum-builder-title"><Package size={24} /><div><h2>Context Bundle Builder</h2><p>Componha e revise suas fontes de contexto</p></div></div><button aria-label="Fechar construtor" onClick={cancel}><X size={18} /></button></header>
    <nav aria-label="Pacotes"><button aria-current={tab === 'build' ? 'page' : undefined} onClick={() => setTab('build')}>Montar pacote</button><button disabled={pending} aria-current={tab === 'recent' ? 'page' : undefined} onClick={() => void showRecent()}>Recentes (15)</button></nav>
    {tab === 'recent' && <section className="continuum-builder-recent" aria-label="Resultados históricos"><p>Resultados históricos do repositório. Reutilizar preserva os bytes originais, sem verificar vigência. Atualizar prepara uma nova composição para revisão.</p>{!recent.length && <p>Nenhum resultado retido.</p>}{recent.map(result => <article key={result.id}><div><strong>{result.name || new Date(result.generatedAt).toLocaleString()}</strong><small>{result.generatedAt} · {result.count} Artifacts · ≈ {result.tokenCount} tokens · {result.format} · {result.compression?.profile ?? 'off'} · {result.bytes.toLocaleString()} bytes</small></div><button disabled={pending} onClick={() => void reuse(result.id)}>Reutilizar</button><details><summary>Atualizar</summary><button disabled={pending} onClick={() => void restore(result.id, 'members')}>Mesmos membros, revisões atuais</button><button disabled={pending} onClick={() => void restore(result.id, 'recipe')}>Reexecutar tags e propriedades</button></details></article>)}</section>}
    {tab === 'build' && <div className="continuum-builder-workspace" aria-busy={pending}>
      <section className="continuum-builder-inputs" aria-label="Adicionar fontes">
        <nav aria-label="Fontes">{(['artifacts', 'properties', 'tags'] as const).map(value => <button key={value} aria-pressed={entry === value} onClick={() => setEntry(value)}>{value === 'artifacts' ? 'Artifacts' : value === 'properties' ? 'Propriedades' : 'Tags'}</button>)}</nav>
        {entry === 'artifacts' && <><input aria-label="Buscar fontes" placeholder="Buscar Artifacts…" value={query} onChange={event => setQuery(event.target.value)} /><div className="continuum-builder-catalog">{items.map(item => <div key={item.artifactId}><button disabled={pending} onClick={() => void add({ kind: 'artifact', selected: [{ artifactId: item.artifactId, expectedRevision: item.revision! }] })}>{item.name}<small>{item.kind} · {item.status ?? 'sem status'} · r{item.revision}</small></button></div>)}{loading && <p role="status">Carregando…</p>}{cursor && <button disabled={pending} onClick={() => void loadMore()}>Carregar mais</button>}</div></>}
        {entry === 'properties' && <><p className="continuum-builder-hint">Propriedades deste grupo combinam com E. Grupos adicionados combinam com OU.</p><ContextFilters repositoryId={repositoryId} facets={facets} metadata={metadata} periods={periods} chooseValue={(key, value) => { setMetadata(prior => ({ ...prior, [key]: value })); setPeriods(prior => { const next = { ...prior }; delete next[key]; return next }) }} choosePeriod={(key, value) => { setPeriods(prior => ({ ...prior, [key]: value })); setMetadata(prior => { const next = { ...prior }; delete next[key]; return next }) }} remove={key => { setMetadata(prior => { const next = { ...prior }; delete next[key]; return next }); setPeriods(prior => { const next = { ...prior }; delete next[key]; return next }) }} /><button disabled={pending} onClick={() => void add({ kind: 'query', filter: { metadata, periods } })}>Adicionar grupo por propriedades</button></>}
        {entry === 'tags' && <div className="continuum-builder-catalog">{tags.map(tag => <button key={tag.slug} disabled={pending} title={tag.description} onClick={() => void add({ kind: 'query', filter: { tag: tag.slug } })}>{tag.name}<small>{tag.count} Artifacts</small></button>)}</div>}
      </section>
      <section className="continuum-builder-members" aria-label="Composição">
        <div className="continuum-builder-components">{composition.components.map((component, index) => <div key={component.id}><span title={component.source.kind === 'query' ? JSON.stringify(component.source.filter) : component.members.map(item => item.name).join(', ')}>{component.source.kind === 'artifact' ? 'Artifact' : component.source.filter.tag ? `Tag: ${component.source.filter.tag}` : 'Propriedades'} · {component.members.length}</span><button disabled={pending} aria-label={`Atualizar grupo ${index + 1}`} onClick={() => void refresh(component)}>Atualizar</button><button disabled={pending} aria-label={`Remover grupo ${index + 1}`} onClick={() => change({ ...composition, components: composition.components.filter(item => item.id !== component.id) })}><X size={13} /></button></div>)}</div>
        {delta && <div role="status">{delta.next.members.filter(item => !delta.old.members.some(old => old.artifactId === item.artifactId)).length} novos · {delta.old.members.filter(item => !delta.next.members.some(next => next.artifactId === item.artifactId)).length} removidos · {delta.next.members.filter(item => delta.old.members.some(old => old.artifactId === item.artifactId && old.revision !== item.revision)).length} revisões alteradas<button onClick={() => { change({ ...composition, components: composition.components.map(item => item.id === delta.old.id ? delta.next : item) }); setDelta(null) }}>Aplicar atualização</button><button onClick={() => setDelta(null)}>Manter snapshot</button></div>}
        <div className="continuum-builder-summary"><strong>{members.length} Artifacts únicos</strong><span>≈ {documentTokens.toLocaleString()} tokens dos documentos</span></div>
        <input aria-label="Buscar membros" placeholder="Buscar na composição…" value={memberQuery} onChange={event => setMemberQuery(event.target.value)} />
        <ol>{members.filter(item => `${item.name} ${item.artifactId}`.toLocaleLowerCase().includes(memberQuery.toLocaleLowerCase())).map(item => <li key={item.artifactId}><button className="continuum-builder-member" disabled={pending} onClick={() => void inspect(item.artifactId)}>{item.name}<small>{item.kind} · {item.status ?? 'sem status'} · r{item.revision} · ≈ {item.rawMarkdownTokenCount} tokens</small></button><button disabled={pending || members.findIndex(member => member.artifactId === item.artifactId) === 0} aria-label={`Subir ${item.name}`} onClick={() => move(item.artifactId, -1)}><ArrowUp size={14} /></button><button disabled={pending || members.findIndex(member => member.artifactId === item.artifactId) === members.length - 1} aria-label={`Descer ${item.name}`} onClick={() => move(item.artifactId, 1)}><ArrowDown size={14} /></button><button disabled={pending} aria-label={`Retirar ${item.name}`} onClick={() => change({ ...composition, excluded: [...composition.excluded, item.artifactId] })}><X size={14} /></button></li>)}</ol>
        {!members.length && <p className="continuum-builder-empty">Adicione Artifacts, propriedades ou tags para montar seu pacote.</p>}
        {composition.excluded.length > 0 && <details><summary>{composition.excluded.length} excluídos manualmente</summary>{composition.excluded.map(id => <button key={id} disabled={pending} onClick={() => change({ ...composition, excluded: composition.excluded.filter(value => value !== id) })}>Reintroduzir {composition.components.flatMap(item => item.members).find(item => item.artifactId === id)?.name ?? id}</button>)}</details>}
        {detail && <details open><summary>Inspeção da fonte</summary><pre>{detail}</pre></details>}
      </section>
    </div>}
    <footer><div className="continuum-builder-output" hidden={tab !== 'build'}><label>Nome<input aria-label="Nome do pacote" maxLength={120} value={name} disabled={pending} placeholder="Opcional" onChange={event => setName(event.target.value)} /></label><label>Formato<select aria-label="Formato do pacote" value={intent} disabled={pending} onChange={event => { setIntent(event.target.value as typeof intent); setPreview(null) }}><option value="copy">Copiar</option><option value="markdown">Markdown</option><option value="zip">ZIP com mídias</option></select></label><label>Compressão<select aria-label="Compressão PAKT" value={profile} disabled={pending} onChange={event => { setProfile(event.target.value as BundleCompressionProfile); setPreview(null) }}><option value="off">Desativada</option><option value="light">Leve · L1</option><option value="balanced">Equilibrada · L1–L2</option><option value="strong">Forte · L1–L3</option></select></label><span>Estimativa cl100k_base; sem orçamento de tokens. Texto não inclui pixels.</span><button disabled={pending || !members.length || !!conflict} onClick={() => void execute('preview')}>Gerar prévia</button><button className="continuum-builder-primary" disabled={pending || !members.length || !!conflict} onClick={() => void execute('export')}>{intent === 'copy' ? 'Copiar contexto' : 'Salvar pacote'}</button></div>
      {tab === 'build' && preview && <details open><summary>≈ {(preview.compression?.originalTokens ?? preview.tokenCount).toLocaleString()} tokens no contexto montado · overhead ≈ {(preview.compression?.originalTokens ?? preview.tokenCount) - preview.documentTokens} · saída {preview.markdownBytes.toLocaleString()} bytes</summary>{preview.compression && <p role="status">{preview.compression.reason} · saída ≈ {preview.compression.outputTokens} tokens · economia {preview.compression.savedTokens} ({preview.compression.savedPercent.toFixed(1)}%)</p>}<pre aria-label="Prévia do pacote">{preview.markdown}</pre></details>}
      {(error || conflict) && <p role="alert">{error || conflict}</p>}{message && <p role="status">{message}</p>}
    </footer>
  </dialog>
}
