import React, { useEffect, useRef, useState } from 'react'
import { Check, Package, Pencil, Plus, Tag, Trash2, X } from 'lucide-react'
import type { ContinuumDetail } from '../../../../shared/types/continuum-ui-types'
import type { ContinuumTag, ContinuumTagAssignment, ContinuumTagMutation } from '../../../../shared/types/continuum-tag-types'

export function ArtifactTagEditor({ repositoryId, artifact, tags, onChanged }: { repositoryId: string; artifact: ContinuumDetail; tags: ContinuumTag[]; onChanged(): void }) {
  const [pending, setPending] = useState(false), [error, setError] = useState('')
  const alive = useRef(true), busy = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const assign = async (slug: string, assigned: boolean) => {
    if (busy.current) return
    busy.current = true; setPending(true); setError('')
    try {
      const result = await window.codeAwareness.mutateContinuumTags({ repositoryId, intent: 'assign', slug, assigned, selected: [{ artifactId: artifact.artifactId, expectedRevision: artifact.revision }], confirmed: true })
      if (alive.current && result.repositoryId === repositoryId) onChanged()
    } catch (reason) { if (alive.current) setError(String(reason)) }
    finally { busy.current = false; if (alive.current) setPending(false) }
  }
  return <fieldset className="continuum-artifact-tags" disabled={pending}><legend>Tags</legend>
    {tags.length ? tags.map(tag => <label key={tag.slug} title={tag.description}><input type="checkbox" checked={Array.isArray(artifact.metadata.tags) && artifact.metadata.tags.includes(tag.slug)} onChange={event => assign(tag.slug, event.target.checked)} /><span className="continuum-tag-dot" style={{ backgroundColor: tag.color }} />{tag.name}</label>) : <p>Crie tags no gerenciador do Context.</p>}
    {error && <p role="alert">{error}<button type="button" onClick={onChanged}>Atualizar revisão</button></p>}
  </fieldset>
}

export function ContinuumTagManager({ repositoryId, tags, selected, onFilter, onBundle, onChanged, onClose }: {
  repositoryId: string; tags: ContinuumTag[]; selected: ContinuumTagAssignment[]; onFilter(slug: string): void; onBundle?(slug: string): void; onChanged(): void; onClose(): void
}) {
  const [slug, setSlug] = useState(''), [name, setName] = useState(''), [color, setColor] = useState('#7852ee'), [description, setDescription] = useState('')
  const [editing, setEditing] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [batch, setBatch] = useState<{ slug: string; assigned: boolean } | null>(null)
  const alive = useRef(true), busy = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const mutate = async (operation: ContinuumTagMutation) => {
    if (busy.current) return
    busy.current = true; setPending(true); setError(''); setMessage('')
    try {
      const result = await window.codeAwareness.mutateContinuumTags(operation)
      if (alive.current && result.repositoryId === repositoryId) { onChanged(); setBatch(null); setMessage('Tags atualizadas.'); return true }
    } catch (reason) { if (alive.current) setError(String(reason)) }
    finally { busy.current = false; if (alive.current) setPending(false) }
    return false
  }
  return <section className="continuum-tag-manager" role="dialog" aria-label="Tags do Continuum">
    <header><h2>Tags do Continuum</h2><button className="continuum-icon-button" aria-label="Fechar tags" title="Fechar tags" onClick={onClose}><X size={16} /></button></header>
    <p>As tags pertencem a este repositório. A marcação altera somente o YAML dos Artifacts selecionados.</p>
    <div className="continuum-tag-list">{tags.map(tag => <div key={tag.slug}>
      <button title={tag.description} onClick={() => onFilter(tag.slug)}><span className="continuum-tag-dot" style={{ backgroundColor: tag.color }} />{tag.name} <small>{tag.count}</small></button>
      <code>{tag.slug}</code>
      {onBundle && <button className="continuum-icon-button" aria-label={`Gerar Bundle ${tag.slug}`} title="Gerar Context Bundle" onClick={() => onBundle(tag.slug)}><Package size={15} /></button>}
      <button className="continuum-icon-button" aria-label={`Editar tag ${tag.slug}`} title="Editar tag" disabled={pending} onClick={() => { setSlug(tag.slug); setName(tag.name); setColor(tag.color); setDescription(tag.description); setEditing(true) }}><Pencil size={15} /></button>
      <button className="continuum-icon-button" aria-label={`Excluir tag ${tag.slug}`} title={tag.count ? 'Remova as associações antes de excluir' : 'Excluir tag vazia'} disabled={pending || tag.count > 0} onClick={() => mutate({ repositoryId, intent: 'delete', slug: tag.slug })}><Trash2 size={15} /></button>
      {selected.length > 0 && <><button className="continuum-icon-button" aria-label={`Aplicar ${tag.slug} à seleção`} title="Aplicar à seleção" disabled={pending} onClick={() => setBatch({ slug: tag.slug, assigned: true })}><Plus size={15} /></button><button className="continuum-icon-button" aria-label={`Remover ${tag.slug} da seleção`} title="Remover da seleção" disabled={pending} onClick={() => setBatch({ slug: tag.slug, assigned: false })}><X size={15} /></button></>}
    </div>)}</div>
    {batch && <div className="continuum-tag-confirmation"><p>{batch.assigned ? 'Aplicar' : 'Remover'} a tag {batch.slug} em {selected.length} Artifacts explicitamente selecionados?</p><ul>{selected.map(item => <li key={item.artifactId}>{item.artifactId} · revisão {item.expectedRevision}</li>)}</ul><button disabled={pending} onClick={() => mutate({ repositoryId, intent: 'assign', ...batch, selected, confirmed: true })}>Confirmar marcação</button><button disabled={pending} onClick={() => setBatch(null)}>Cancelar</button></div>}
    <form onSubmit={async event => {
      event.preventDefault()
      if (await mutate({ repositoryId, intent: editing ? 'edit' : 'create', tag: { slug, name, color, description } })) { setSlug(''); setName(''); setDescription(''); setEditing(false) }
    }}>
      <h3>{editing ? 'Editar tag' : 'Criar tag'}</h3>
      <label>Slug<input aria-label="Slug da tag" required maxLength={64} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={slug} disabled={editing || pending} onChange={event => setSlug(event.target.value)} /></label>
      <label>Nome<input aria-label="Nome da tag" required maxLength={80} value={name} disabled={pending} onChange={event => setName(event.target.value)} /></label>
      <label>Cor<input aria-label="Cor da tag" type="color" value={color} disabled={pending} onChange={event => setColor(event.target.value)} /></label>
      <label>Objetivo<textarea aria-label="Objetivo da tag" maxLength={500} value={description} disabled={pending} onChange={event => setDescription(event.target.value)} /></label>
      <button className="continuum-icon-button" type="submit" aria-label={editing ? 'Salvar tag' : 'Criar tag'} title={editing ? 'Salvar tag' : 'Criar tag'} disabled={pending}>{editing ? <Check size={16} /> : <Tag size={16} />}</button>
      {editing && <button type="button" onClick={() => { setEditing(false); setSlug(''); setName(''); setDescription('') }}>Cancelar edição</button>}
    </form>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </section>
}
