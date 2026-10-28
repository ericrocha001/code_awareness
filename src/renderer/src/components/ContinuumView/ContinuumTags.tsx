import React, { useEffect, useRef, useState } from 'react'
import { ArrowRight, Box, Check, FileText, Info, MoreHorizontal, Pencil, Plus, Search, Tag, Tags, X } from 'lucide-react'
import type { ContinuumDetail, ContinuumItem, ContinuumTagTokens } from '../../../../shared/types/continuum-ui-types'
import { quickTag, TAG_DESCRIPTION_MAX_LENGTH, type ContinuumTag, type ContinuumTagMutation } from '../../../../shared/types/continuum-tag-types'
import './ContinuumTagManager.css'


export function ArtifactTagEditor({ repositoryId, artifact, tags, onChanged }: { repositoryId: string; artifact: ContinuumDetail; tags: ContinuumTag[]; onChanged(): void }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [pending, setPending] = useState(false), [error, setError] = useState('')
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null), busy = useRef(false)
  const identity = `${repositoryId}:${artifact.artifactId}:${artifact.revision}`, context = useRef<string | null>(identity)
  context.current = identity
  useEffect(() => () => { context.current = null }, [])
  useEffect(() => { setOpen(false); setError(''); setQuery(''); setPending(false) }, [identity])
  useEffect(() => {
    if (!open) return
    input.current?.focus()
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  const assigned = (slug: string) => Array.isArray(artifact.metadata.tags) && artifact.metadata.tags.includes(slug)
  const mutate = async (operation: ContinuumTagMutation) => {
    if (busy.current) return
    const started = identity
    busy.current = true; setPending(true); setError('')
    try {
      const result = await window.codeAwareness.mutateContinuumTags(operation)
      if (context.current === started && result.repositoryId === repositoryId) onChanged()
    } catch (reason) { if (context.current === started) setError(String(reason)) }
    finally { busy.current = false; if (context.current === started) setPending(false) }
  }
  const select = (slug: string, value: boolean) => mutate({ repositoryId, intent: 'assign', slug, assigned: value, selected: [{ artifactId: artifact.artifactId, expectedRevision: artifact.revision }], confirmed: true })
  const exact = tags.find(tag => tag.name.toLocaleLowerCase() === query.trim().toLocaleLowerCase() || tag.slug === query.trim().toLocaleLowerCase())
  return <div className="continuum-tag-anchor" ref={root} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus() } }}>
    <button ref={trigger} className="continuum-icon-button" title="Tags do Artifact" aria-label="Tags do Artifact" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(value => !value)}><Tag size={16} /><span className="continuum-tag-count">{Array.isArray(artifact.metadata.tags) && artifact.metadata.tags.length || ''}</span></button>
    {open && <div className="continuum-tag-popover" role="dialog" aria-label="Atribuir tags">
      <form onSubmit={event => { event.preventDefault(); if (!query.trim()) return; if (exact) void select(exact.slug, true); else void mutate({ repositoryId, intent: 'quick-create', name: query.trim(), selected: [{ artifactId: artifact.artifactId, expectedRevision: artifact.revision }] }) }}>
        <input ref={input} aria-label="Buscar ou criar tag" placeholder="Buscar ou criar tag…" value={query} disabled={pending} maxLength={80} onChange={event => setQuery(event.target.value)} />
        {query.trim() && !exact && <button type="submit" disabled={pending}>Criar “{query.trim()}” e atribuir ↵</button>}
      </form>
      <div className="continuum-tag-results">{tags.filter(tag => `${tag.name} ${tag.slug}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(tag => <button key={tag.slug} title={tag.description || undefined} disabled={pending} aria-pressed={assigned(tag.slug)} onClick={() => select(tag.slug, !assigned(tag.slug))}><span>{tag.name}</span>{assigned(tag.slug) && <Check size={14} />}</button>)}</div>
      {!tags.length && !query && <p>Digite um nome e pressione Enter.</p>}
      {error && <p role="alert">{error} <button onClick={onChanged}>Atualizar revisão</button></p>}
    </div>}
  </div>
}

type TagManagerProps = {
  onBundle?(slug: string): void
  onTokenTotals?(totals: ContinuumTagTokens[]): void
  repositoryId: string; tags: ContinuumTag[]; onFilter(slug: string): void; onChanged(): void; onClose(): void
}

export function ContinuumTagManager(props: TagManagerProps) {
  return <TagManager key={props.repositoryId} {...props} />
}

function TagManager({ repositoryId, tags, onFilter, onChanged, onClose, onTokenTotals, onBundle }: TagManagerProps) {
  const [catalog, setCatalog] = useState(tags), [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [form, setForm] = useState<{ slug: string | null; name: string; description: string } | null>(null)
  const [name, setName] = useState(''), [description, setDescription] = useState('')
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [totals, setTotals] = useState<ContinuumTagTokens[]>([]), [tokenError, setTokenError] = useState('')
  const [preview, setPreview] = useState<{ slug: string; items: ContinuumItem[]; error?: string } | null>(null)
  const [previewRetry, setPreviewRetry] = useState(0), [confirmDelete, setConfirmDelete] = useState(false)
  const modal = useRef<HTMLDialogElement>(null), busy = useRef(false), alive = useRef(false), nameInput = useRef<HTMLInputElement>(null)
  const wasEditing = useRef(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const sorted = [...catalog].sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug))
  const tag = catalog.find(item => item.slug === selected) ?? sorted[0]
  const slug = tag?.slug
  const dirty = !!form && (name !== form.name || description !== form.description)
  useEffect(() => { setCatalog(tags) }, [tags])
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null
    alive.current = true; modal.current?.showModal(); searchInput.current?.focus()
    return () => { alive.current = false; trigger?.focus() }
  }, [])
  useEffect(() => {
    if (form) nameInput.current?.focus()
    else if (wasEditing.current) modal.current?.querySelector<HTMLButtonElement>('.tag-manager-actions button')?.focus()
    wasEditing.current = !!form
  }, [form])
  useEffect(() => {
    let cancelled = false
    setTotals([]); setTokenError('')
    const load = async () => {
      for (let offset = 0; offset < catalog.length; offset += 20) {
        const result = await window.codeAwareness.getContinuumTagTokens(repositoryId, catalog.slice(offset, offset + 20).map(tag => tag.slug))
        if (cancelled || result.repositoryId !== repositoryId) return
        setTotals(previous => [...previous, ...result.totals])
        onTokenTotals?.(result.totals)
      }
    }
    void load().catch(reason => { if (!cancelled) { setTotals([]); setTokenError(String(reason)) } })
    return () => { cancelled = true }
  }, [repositoryId, catalog])
  useEffect(() => {
    let cancelled = false
    setPreview(null)
    if (slug) void window.codeAwareness.listContinuumArtifacts({ repositoryId, tag: slug }).then(result => {
      if (!cancelled && result.repositoryId === repositoryId) setPreview({ slug, items: result.artifacts.slice(0, 3) })
    }).catch(reason => { if (!cancelled) setPreview({ slug, items: [], error: String(reason) }) })
    return () => { cancelled = true }
  }, [repositoryId, slug, catalog, previewRetry])
  const canLeave = () => {
    if (busy.current) return false
    if (dirty) { setError('Há alterações não salvas. Salve ou cancele a edição antes de continuar.'); return false }
    return true
  }
  const close = () => { if (canLeave()) onClose() }
  const startForm = (editing?: ContinuumTag) => {
    if (!canLeave()) return
    const initial = { slug: editing?.slug ?? null, name: editing?.name ?? '', description: editing?.description ?? '' }
    setForm(initial); setName(initial.name); setDescription(initial.description); setConfirmDelete(false); setError(''); setMessage('')
  }
  const mutate = async (operation: () => ContinuumTagMutation) => {
    if (busy.current) return
    busy.current = true; setPending(true); setError(''); setMessage('')
    try {
      const request = operation()
      const result = await window.codeAwareness.mutateContinuumTags(request)
      if (!alive.current || result.repositoryId !== repositoryId) return
      setCatalog(result.tags)
      setSelected(request.intent === 'create' || request.intent === 'edit' ? request.tag.slug : null)
      setForm(null); setConfirmDelete(false); setMessage(request.intent === 'delete' ? 'Tag excluída.' : 'Tag salva.')
      onChanged()
    } catch (reason) { if (alive.current) setError(String(reason)) }
    finally { busy.current = false; if (alive.current) setPending(false) }
  }
  const tokenText = (slug: string) => {
    const total = totals.find(item => item.slug === slug)
    return total ? `≈ ${total.rawMarkdownTokenCount.toLocaleString()} tokens` : tokenError ? 'Tokens indisponíveis' : 'Calculando tokens…'
  }
  const navigate = (action: (slug: string) => void) => { if (slug && canLeave()) { action(slug); onClose() } }
  return <dialog ref={modal} className="continuum-tag-manager" aria-labelledby="tag-manager-title" onCancel={event => { event.preventDefault(); close() }}>
    <header className="tag-manager-header">
      <span className="tag-manager-icon"><Tags size={32} /></span>
      <div><h2 id="tag-manager-title">Gerenciador de Tags</h2><p>Organize e gerencie as tags do seu Continuum</p></div>
      <button aria-label="Fechar tags" title="Fechar tags" onClick={close} disabled={pending}><X size={20} /></button>
    </header>
    <div className="tag-manager-workspace" aria-busy={pending}>
      <section className="tag-manager-catalog" aria-label="Catálogo de tags">
        <div className="tag-manager-section-heading"><h3>Tags <span>{catalog.length}</span></h3><button className="tag-manager-primary" disabled={pending} onClick={() => startForm()}><Plus size={18} />Nova tag</button></div>
        <label className="tag-manager-search"><Search size={18} /><input ref={searchInput} aria-label="Buscar tags" placeholder="Buscar tags…" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <p className="tag-manager-order">Ordenadas por nome</p>
        <div className="tag-manager-list">
          {sorted.filter(item => `${item.name} ${item.slug}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(item => <button key={item.slug} className="tag-manager-row" aria-pressed={(!form || !!form.slug) && item.slug === slug} disabled={pending} onClick={() => {
            if (!canLeave()) return
            setSelected(item.slug); setForm(null); setConfirmDelete(false); setError(''); setMessage('')
          }}><span className="tag-manager-tag-icon"><Tag size={25} /></span><span><strong>{item.name}</strong><small>{item.count} Artifacts · {tokenText(item.slug)}</small></span></button>)}
          {!sorted.some(item => `${item.name} ${item.slug}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) && <p className="tag-manager-empty">{catalog.length ? 'Nenhuma tag encontrada.' : 'Nenhuma tag ainda. Crie sua primeira tag.'}</p>}
        </div>
      </section>
      <section className="tag-manager-detail" aria-label="Detalhes da tag">
        <div className="tag-manager-section-heading"><h3>{form ? form.slug ? 'Editar tag' : 'Nova tag' : 'Detalhes da tag'}</h3>
          {!form && tag && <div className="tag-manager-actions"><button disabled={pending} onClick={() => startForm(tag)}><Pencil size={17} />Editar</button><button className="tag-manager-bundle" disabled={pending || !onBundle} onClick={() => onBundle && navigate(onBundle)}><Box size={18} />Montar no Context Builder</button>
            <details className="tag-manager-options"><summary aria-label="Mais ações da tag" title="Mais ações"><MoreHorizontal size={20} /></summary><div><button disabled={pending} onClick={() => navigate(onFilter)}>Filtrar Artifacts</button><button className="tag-manager-danger" disabled={pending || tag.count > 0} title={tag.count ? 'Remova as associações antes de excluir' : 'Excluir tag vazia'} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setConfirmDelete(true) }}>Excluir tag vazia</button></div></details>
          </div>}
        </div>
        {error && <p className="tag-manager-feedback" role="alert">{error}</p>}{message && <p className="tag-manager-feedback" role="status">{message}</p>}
        {form ? <form className="tag-manager-form" onSubmit={event => { event.preventDefault(); if (name.trim()) void mutate(() => ({ repositoryId, intent: form.slug ? 'edit' : 'create', tag: { ...(form.slug ? { slug: form.slug, name: name.trim() } : quickTag(name)), description } })) }}>
          <label>Nome da tag<input ref={nameInput} required maxLength={80} value={name} disabled={pending} onChange={event => setName(event.target.value)} /></label>
          <label>Descrição — quando usar esta tag<textarea maxLength={TAG_DESCRIPTION_MAX_LENGTH} value={description} disabled={pending} onChange={event => setDescription(event.target.value)} /></label>
          <small>{description.length}/{TAG_DESCRIPTION_MAX_LENGTH} · Opcional</small>
          <div className="tag-manager-actions"><button type="submit" className="tag-manager-primary" disabled={pending || !name.trim()}>{form.slug ? 'Salvar tag' : 'Criar tag'}</button><button type="button" disabled={pending} onClick={() => { setForm(null); setError('') }}>Cancelar edição</button></div>
        </form> : tag ? <>
          {confirmDelete && <div className="tag-manager-delete" role="group" aria-label="Confirmar exclusão"><p>Excluir a tag vazia “{tag.name}”? Esta ação remove a tag do catálogo.</p><button className="tag-manager-danger" disabled={pending || tag.count > 0} onClick={() => mutate(() => ({ repositoryId, intent: 'delete', slug: tag.slug }))}>Confirmar exclusão</button><button disabled={pending} onClick={() => setConfirmDelete(false)}>Cancelar exclusão</button></div>}
          <div className="tag-manager-summary"><div className="tag-manager-identity"><span className="tag-manager-icon"><Tag size={36} /></span><div><h4>{tag.name}</h4><p>{tag.count} Artifacts · {tokenText(tag.slug)} dos documentos</p></div></div><h5>Descrição</h5><p className="tag-manager-description">{tag.description || 'Sem descrição.'}</p></div>
          <div className="tag-manager-metrics"><div><FileText size={24} /><span><strong>{tag.count}</strong><small>Artifacts</small></span></div><div><Tag size={24} /><span><strong>{tokenText(tag.slug)}</strong><small>Somente documentos</small></span><details><summary aria-label="Sobre a estimativa de tokens"><Info size={16} /></summary><p>Soma do Markdown integral, incluindo YAML. Encoding: {totals.find(item => item.slug === tag.slug)?.tokenizerEncoding ?? 'indisponível'}. O pacote inclui overhead próprio.</p></details></div></div>
          <section className="tag-manager-preview" aria-label="Prévia dos Artifacts"><div className="tag-manager-section-heading"><div><h3>Artifacts desta tag</h3><p>Prévia dos Artifacts · até 3 itens</p></div><button disabled={pending} onClick={() => navigate(onFilter)}>Ver todos ({tag.count})<ArrowRight size={17} /></button></div>
            {!preview || preview.slug !== tag.slug ? <p role="status">Carregando Artifacts…</p> : preview.error ? <p role="alert">Não foi possível carregar a prévia. <button onClick={() => setPreviewRetry(value => value + 1)}>Tentar novamente</button></p> : !preview.items.length ? <p className="tag-manager-empty">Nenhum Artifact nesta tag.</p> : <ul>{preview.items.map(item => <li key={item.artifactId}><FileText size={23} /><div><strong title={item.name}>{item.name}</strong><small>{item.kind} · {new Date(item.updatedAt).toLocaleString()}</small></div>{item.rawMarkdownTokenCount !== undefined && <small>≈ {item.rawMarkdownTokenCount.toLocaleString()} tokens</small>}</li>)}</ul>}
          </section>
        </> : <div className="tag-manager-empty"><Tags size={36} /><p>Crie uma tag para organizar seus Artifacts.</p><button onClick={() => startForm()}>Nova tag</button></div>}
      </section>
    </div>
  </dialog>
}
