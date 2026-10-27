import React, { useEffect, useRef, useState } from 'react'
import { Check, MoreHorizontal, Tag, X } from 'lucide-react'
import type { ContinuumDetail, ContinuumTagTokens } from '../../../../shared/types/continuum-ui-types'
import { TAG_DESCRIPTION_MAX_LENGTH, type ContinuumTag, type ContinuumTagMutation } from '../../../../shared/types/continuum-tag-types'


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

export function ContinuumTagManager({ repositoryId, tags, onFilter, onChanged, onClose, onTokenTotals, onBundle }: {
  onBundle?(slug: string): void
  onTokenTotals?(totals: ContinuumTagTokens[]): void
  repositoryId: string; tags: ContinuumTag[]; onFilter(slug: string): void; onChanged(): void; onClose(): void
}) {
  const [name, setName] = useState(''), [description, setDescription] = useState(''), [editing, setEditing] = useState<string | null>(null)
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [totals, setTotals] = useState<ContinuumTagTokens[]>([]), [tokenError, setTokenError] = useState('')
  useEffect(() => {
    let cancelled = false
    setTotals([]); setTokenError('')
    const load = async () => {
      for (let offset = 0; offset < tags.length; offset += 20) {
        const result = await window.codeAwareness.getContinuumTagTokens(repositoryId, tags.slice(offset, offset + 20).map(tag => tag.slug))
        if (cancelled || result.repositoryId !== repositoryId) return
        setTotals(previous => [...previous, ...result.totals])
        onTokenTotals?.(result.totals)
      }
    }
    void load().catch(reason => { if (!cancelled) { setTotals([]); setTokenError(String(reason)) } })
    return () => { cancelled = true }
  }, [repositoryId, tags])
  const modal = useRef<HTMLDialogElement>(null), busy = useRef(false), context = useRef<string | null>(repositoryId)
  context.current = repositoryId
  useEffect(() => { modal.current?.showModal(); return () => { context.current = null } }, [])
  const run = async (action: () => Promise<void>) => {
    if (busy.current) return
    const started = repositoryId
    busy.current = true; setPending(true); setError(''); setMessage('')
    try { await action() } catch (reason) { if (context.current === started) setError(String(reason)) }
    finally { busy.current = false; if (context.current === started) setPending(false) }
  }
  const mutate = (operation: ContinuumTagMutation) => run(async () => {
    const result = await window.codeAwareness.mutateContinuumTags(operation)
    if (context.current !== repositoryId || result.repositoryId !== repositoryId) return
    onChanged(); setName(''); setDescription(''); setEditing(null); setMessage('Tag salva.')
  })
  return <dialog ref={modal} className="continuum-tag-manager" aria-label="Tags e pacotes" onCancel={onClose}>
    <header><h2>Tags e pacotes</h2><button className="continuum-icon-button" aria-label="Fechar tags" title="Fechar tags" onClick={onClose}><X size={16} /></button></header>
    <div className="continuum-tag-list">{tags.map(tag => <div key={tag.slug}>
      <button className="continuum-tag-name" title={`${tag.description || 'Ver membros'} · Soma do Markdown integral, incluindo YAML; estimativa cl100k_base. O pacote inclui overhead próprio.`} onClick={() => onFilter(tag.slug)}><span>{tag.name}</span><small>{tag.count} Artifacts · {totals.find(total => total.slug === tag.slug) ? `≈ ${totals.find(total => total.slug === tag.slug)!.rawMarkdownTokenCount.toLocaleString()} tokens dos documentos` : tokenError ? 'Tokens indisponíveis' : 'Calculando tokens…'}</small></button>
      <button disabled={pending} onClick={() => onBundle?.(tag.slug)}>Montar pacote</button>
      <details className="continuum-tag-options"><summary aria-label={`Opções ${tag.name}`} title="Opções"><MoreHorizontal size={16} /></summary><div>
        
        <button disabled={pending} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setEditing(tag.slug); setName(tag.name); setDescription(tag.description) }}>Editar tag</button>
        <button aria-label={`Excluir tag ${tag.slug}`} title={tag.count ? 'Remova as associações antes de excluir' : 'Excluir tag vazia'} disabled={pending || tag.count > 0} onClick={() => mutate({ repositoryId, intent: 'delete', slug: tag.slug })}>Excluir tag vazia</button>
      </div></details>
    </div>)}</div>
    <form onSubmit={event => { event.preventDefault(); if (!name.trim()) return; void mutate(editing ? { repositoryId, intent: 'edit', tag: { slug: editing, name, description } } : { repositoryId, intent: 'quick-create', name }) }}>
      <label>{editing ? 'Editar nome' : 'Nova tag'}<input aria-label="Nome da tag" placeholder="Nome da tag" required maxLength={80} value={name} disabled={pending} onChange={event => setName(event.target.value)} /></label>
      {editing && <label className="continuum-tag-description">Descrição — quando usar esta tag<textarea aria-label="Descrição — quando usar esta tag" placeholder="Ex.: decisões aprovadas sobre a arquitetura; exclui propostas em discussão." maxLength={TAG_DESCRIPTION_MAX_LENGTH} value={description} disabled={pending} onChange={event => setDescription(event.target.value)} /></label>}
      <div><button type="submit" disabled={pending}>{editing ? 'Salvar tag' : 'Criar tag'}</button>{editing && <button type="button" onClick={() => { setEditing(null); setName(''); setDescription('') }}>Cancelar edição</button>}</div>
    </form>
    {tokenError && <p role="alert">{tokenError}</p>}
    {error && <p role="alert">{error} Tente novamente para gerar uma cópia atualizada.</p>}{message && <p role="status">{message}</p>}
  </dialog>
}
