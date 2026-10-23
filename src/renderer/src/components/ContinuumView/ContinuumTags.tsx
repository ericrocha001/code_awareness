import React, { useEffect, useRef, useState } from 'react'
import { Check, MoreHorizontal, Tag, X } from 'lucide-react'
import type { ContinuumDetail } from '../../../../shared/types/continuum-ui-types'
import type { ContinuumTag, ContinuumTagMutation } from '../../../../shared/types/continuum-tag-types'
import type { ContinuumBundleQuick } from '../../../../shared/types/continuum-bundle-types'

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
      <div className="continuum-tag-results">{tags.filter(tag => `${tag.name} ${tag.slug}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(tag => <button key={tag.slug} disabled={pending} aria-pressed={assigned(tag.slug)} onClick={() => select(tag.slug, !assigned(tag.slug))}><span>{tag.name}</span>{assigned(tag.slug) && <Check size={14} />}</button>)}</div>
      {!tags.length && !query && <p>Digite um nome e pressione Enter.</p>}
      {error && <p role="alert">{error} <button onClick={onChanged}>Atualizar revisão</button></p>}
    </div>}
  </div>
}

export function ContinuumTagManager({ repositoryId, tags, onFilter, onBundle, onChanged, onClose }: {
  repositoryId: string; tags: ContinuumTag[]; onFilter(slug: string): void; onBundle?(slug: string): void; onChanged(): void; onClose(): void
}) {
  const [name, setName] = useState(''), [editing, setEditing] = useState<string | null>(null)
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
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
    onChanged(); setName(''); setEditing(null); setMessage('Tag salva.')
  })
  const bundle = (slug: string, intent: ContinuumBundleQuick['intent']) => run(async () => {
    const receipt = await window.codeAwareness.quickContinuumBundle({ repositoryId, slug, intent })
    if (context.current !== repositoryId || receipt.repositoryId !== repositoryId) return
    setMessage(`${receipt.outcome === 'copied' ? 'Copiado' : receipt.outcome === 'saved' ? 'Salvo' : 'Cancelado'} · ${receipt.count} Artifacts · ~${receipt.tokenCount} tokens (${receipt.tokenizerEncoding}).${receipt.hasVisuals && intent !== 'zip' ? ' O texto não inclui pixels; salve o ZIP completo.' : ''}`)
  })
  return <dialog ref={modal} className="continuum-tag-manager" aria-label="Tags e pacotes" onCancel={onClose}>
    <header><h2>Tags e pacotes</h2><button className="continuum-icon-button" aria-label="Fechar tags" title="Fechar tags" onClick={onClose}><X size={16} /></button></header>
    <div className="continuum-tag-list">{tags.map(tag => <div key={tag.slug}>
      <button className="continuum-tag-name" title="Ver membros" onClick={() => onFilter(tag.slug)}><span>{tag.name}</span><small>{tag.count}</small></button>
      <button disabled={pending} onClick={() => bundle(tag.slug, 'copy')} aria-label={`Copiar contexto ${tag.name}`}>Copiar contexto</button>
      <details className="continuum-tag-options"><summary aria-label={`Opções ${tag.name}`} title="Opções"><MoreHorizontal size={16} /></summary><div>
        <button disabled={pending} onClick={() => bundle(tag.slug, 'markdown')}>Salvar Markdown</button><button disabled={pending} onClick={() => bundle(tag.slug, 'zip')}>Salvar ZIP</button>
        {onBundle && <button onClick={() => onBundle(tag.slug)}>Revisar pacote…</button>}
        <button disabled={pending} onClick={() => { setEditing(tag.slug); setName(tag.name) }}>Editar tag</button>
        <button aria-label={`Excluir tag ${tag.slug}`} title={tag.count ? 'Remova as associações antes de excluir' : 'Excluir tag vazia'} disabled={pending || tag.count > 0} onClick={() => mutate({ repositoryId, intent: 'delete', slug: tag.slug })}>Excluir tag vazia</button>
      </div></details>
    </div>)}</div>
    <form onSubmit={event => { event.preventDefault(); if (!name.trim()) return; void mutate(editing ? { repositoryId, intent: 'edit', tag: { slug: editing, name } } : { repositoryId, intent: 'quick-create', name }) }}>
      <label>{editing ? 'Editar nome' : 'Nova tag'}<input aria-label="Nome da tag" placeholder="Nome da tag" required maxLength={80} value={name} disabled={pending} onChange={event => setName(event.target.value)} /></label>
      <div><button type="submit" disabled={pending}>{editing ? 'Salvar tag' : 'Criar tag'}</button>{editing && <button type="button" onClick={() => { setEditing(null); setName('') }}>Cancelar edição</button>}</div>
    </form>
    {error && <p role="alert">{error} Tente novamente para gerar uma cópia atualizada.</p>}{message && <p role="status">{message}</p>}
  </dialog>
}
