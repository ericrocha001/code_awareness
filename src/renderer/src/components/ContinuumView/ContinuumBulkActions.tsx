import React, { useEffect, useRef, useState } from 'react'
import type { ContinuumItem, ContinuumSelectedArtifact } from '../../../../shared/types/continuum-ui-types'
import type { ContinuumTag } from '../../../../shared/types/continuum-tag-types'


export function ContinuumBulkActions({ repositoryId, selected, tags, onClear, onChanged, onBusy, onBundle, disabled = false }: {
  disabled?: boolean
  repositoryId: string
  selected: ContinuumItem[]
  tags: ContinuumTag[]
  onBundle?(): void
  onClear(): void
  onChanged(): void
  onBusy(value: boolean): void
}) {
  const [editing, setEditing] = useState(false)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  const identity = JSON.stringify([repositoryId, selected.map(item => [item.artifactId, item.revision])])
  const context = useRef(identity), busy = useRef(false)
  context.current = identity
  useEffect(() => () => { context.current = '' }, [])
  useEffect(() => {
    setError('')
  }, [identity])

  const sources: ContinuumSelectedArtifact[] = selected.map(item => ({
    artifactId: item.artifactId,
    expectedRevision: item.revision!
  }))

  const assign = async () => {
    if (busy.current || disabled || !query.trim()) return
    const started = identity, name = query.trim()
    const tag = tags.find(tag => tag.slug === name || tag.name.toLocaleLowerCase() === name.toLocaleLowerCase())
    busy.current = true; setPending(true); onBusy(true); setError('')
    try {
      const result = await window.codeAwareness.mutateContinuumTags(tag
        ? { repositoryId, intent: 'assign', slug: tag.slug, assigned: true, selected: sources, confirmed: true }
        : { repositoryId, intent: 'quick-create', name, selected: sources })
      if (context.current !== started || result.repositoryId !== repositoryId) return
      onClear(); onChanged(); setEditing(false)
    } catch (reason) { if (context.current === started) setError(String(reason)) }
    finally { busy.current = false; onBusy(false); if (context.current === started) setPending(false) }
  }

  return (
    <div className="continuum-bulk-actions" aria-label="Ações em massa" aria-busy={pending}>
      <span title="Soma do Markdown integral, incluindo YAML, estimada em cl100k_base; sem tokens visuais. O pacote montado inclui overhead próprio.">
        {selected.length} selecionados · {selected.every(item => item.rawMarkdownTokenCount !== undefined) ? `≈ ${selected.reduce((sum, item) => sum + item.rawMarkdownTokenCount!, 0).toLocaleString()} tokens dos documentos` : 'Tokens indisponíveis'}
      </span>
      <div>
        <button disabled={pending || disabled} onClick={() => setEditing(value => !value)}>Adicionar tag</button>
        <button disabled={pending || disabled} onClick={onBundle}>Montar pacote</button>
        <button disabled={pending || disabled} onClick={onClear}>Limpar seleção</button>
      </div>
      {editing && (
        <form onSubmit={event => { event.preventDefault(); void assign() }}>
          <label>Buscar ou criar tag para a seleção<input aria-label="Tag da seleção" maxLength={80} value={query} disabled={pending || disabled} onChange={event => setQuery(event.target.value)} /></label>
          <div aria-label="Tags existentes">{tags.filter(tag => `${tag.name} ${tag.slug}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 20).map(tag => <button type="button" key={tag.slug} disabled={pending || disabled} onClick={() => setQuery(tag.name)}>{tag.name}</button>)}</div>
          <button type="submit" disabled={pending || disabled || !query.trim()}>Confirmar tag em {selected.length} Artifacts</button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
